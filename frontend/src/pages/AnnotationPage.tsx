import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import {
  buildArtifactUrl,
  fetchEvents,
  fetchLatestSessionForMatch,
  fetchSession,
  fetchSpadlTypes,
  resetEvents,
  saveEvents,
  syncSheet,
} from "../api";
import { EventTable } from "../components/EventTable";
import type { ErrorType, EventRow, SessionStatus } from "../types";

const ERROR_TYPES: Array<"" | ErrorType> = [
  "",
  "synced_ts",
  "receive_ts",
  "player_id",
  "receiver_id",
  "spadl_type",
  "outcome",
  "false_positive",
  "missing",
];
const KEYBOARD_SEEK_SECONDS = 0.2;
const TEAM_PLAYER_ID_PATTERN = /^(home|away)_\d+$/;
const TEAM_PLAYER_ID_DETAIL_PATTERN = /^(home|away)_(\d+)$/;
const WARNING_FRAME_PATTERN = /\bframe_id=(\d+)\b/;

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  const tag = target.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select" || tag === "option") {
    return true;
  }

  return target.closest("input, textarea, select, [contenteditable='true']") !== null;
}

function formatSeconds(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const remain = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${remain.toFixed(2).padStart(5, "0")}`;
}

function parseTimestampToSeconds(value: string | null | undefined): number | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  const parts = text.split(":");
  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    const m = Number(minutes);
    const s = Number(seconds);
    if (!Number.isFinite(m) || !Number.isFinite(s)) return null;
    return m * 60 + s;
  }
  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    const h = Number(hours);
    const m = Number(minutes);
    const s = Number(seconds);
    if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(s)) return null;
    return h * 3600 + m * 60 + s;
  }
  const sec = Number(text);
  return Number.isFinite(sec) ? sec : null;
}

function findEventIndexByFrame(rows: EventRow[], currentFrame: number): number | null {
  const anchors = rows
    .map((row, index) => ({ index, frame: row.synced_frame_id }))
    .filter(
      (entry): entry is { index: number; frame: number } =>
        typeof entry.frame === "number" && Number.isFinite(entry.frame),
    )
    .sort((a, b) => a.frame - b.frame);

  if (anchors.length === 0) {
    return null;
  }

  if (currentFrame <= anchors[0].frame) {
    return anchors[0].index;
  }

  for (let idx = 0; idx < anchors.length - 1; idx += 1) {
    const current = anchors[idx];
    const next = anchors[idx + 1];
    if (!current || !next) continue;
    if (currentFrame >= current.frame && currentFrame < next.frame) {
      return current.index;
    }
  }

  return anchors[anchors.length - 1].index;
}

function findInsertIndexByFrame(rows: EventRow[], currentFrame: number): number {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row) continue;
    if (typeof row.synced_frame_id === "number" && row.synced_frame_id > currentFrame) {
      return index;
    }
  }
  return rows.length;
}

function parseSegmentFrameRange(path: string | null): { start: number; end: number } | null {
  if (!path) return null;
  const match = path.match(/_(\d+)-(\d+)\.mp4(?:$|\?)/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }
  return { start, end };
}

function isSameEventRow(a: EventRow | null, b: EventRow | null): boolean {
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    a.period_id === b.period_id &&
    a.spadl_type === b.spadl_type &&
    a.player_id === b.player_id &&
    (a.synced_frame_id ?? null) === (b.synced_frame_id ?? null) &&
    (a.synced_ts ?? "") === (b.synced_ts ?? "") &&
    (a.receiver_id ?? "") === (b.receiver_id ?? "") &&
    (a.receive_frame_id ?? null) === (b.receive_frame_id ?? null) &&
    (a.receive_ts ?? "") === (b.receive_ts ?? "") &&
    a.outcome === b.outcome &&
    (a.error_type ?? null) === (b.error_type ?? null) &&
    (a.note ?? "") === (b.note ?? "")
  );
}

function isValidEntityId(
  value: string | null | undefined,
  allowEmpty: boolean,
  knownIds: Set<string>,
): boolean {
  const normalized = (value ?? "").trim();
  if (allowEmpty && normalized === "") {
    return true;
  }
  return TEAM_PLAYER_ID_PATTERN.test(normalized) || knownIds.has(normalized);
}

function parseTeamEntityId(value: string): { sideRank: number; playerNumber: number } | null {
  const matched = value.match(TEAM_PLAYER_ID_DETAIL_PATTERN);
  if (!matched) return null;
  const side = matched[1];
  const playerNumber = Number(matched[2]);
  if (!Number.isFinite(playerNumber)) return null;
  return {
    sideRank: side === "home" ? 0 : 1,
    playerNumber,
  };
}

function compareEntityIds(a: string, b: string): number {
  const parsedA = parseTeamEntityId(a);
  const parsedB = parseTeamEntityId(b);

  if (parsedA && parsedB) {
    if (parsedA.sideRank !== parsedB.sideRank) {
      return parsedA.sideRank - parsedB.sideRank;
    }
    if (parsedA.playerNumber !== parsedB.playerNumber) {
      return parsedA.playerNumber - parsedB.playerNumber;
    }
    return a.localeCompare(b);
  }
  if (parsedA && !parsedB) {
    return -1;
  }
  if (!parsedA && parsedB) {
    return 1;
  }
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function frameToEventTimestamp(frameId: number, fps: number, offsetSeconds: number): string {
  const seconds = frameId / fps + offsetSeconds;
  return formatSeconds(seconds);
}

function getAnchorFrame(row: EventRow | null | undefined): number | null {
  if (!row) return null;
  if (typeof row.synced_frame_id === "number") return row.synced_frame_id;
  if (typeof row.receive_frame_id === "number") return row.receive_frame_id;
  return null;
}

function inferPrimaryErrorType(original: EventRow, candidate: EventRow): ErrorType | null {
  // Left-to-right priority in the editor/table:
  // spadl_type > player_id > synced > receiver_id > receive > outcome
  if (original.spadl_type !== candidate.spadl_type) {
    return "spadl_type";
  }
  if (original.player_id !== candidate.player_id) {
    return "player_id";
  }
  if (
    (original.synced_frame_id ?? null) !== (candidate.synced_frame_id ?? null)
    || (original.synced_ts ?? "") !== (candidate.synced_ts ?? "")
  ) {
    return "synced_ts";
  }
  if ((original.receiver_id ?? "") !== (candidate.receiver_id ?? "")) {
    return "receiver_id";
  }
  if (
    (original.receive_frame_id ?? null) !== (candidate.receive_frame_id ?? null)
    || (original.receive_ts ?? "") !== (candidate.receive_ts ?? "")
  ) {
    return "receive_ts";
  }
  if (original.outcome !== candidate.outcome) {
    return "outcome";
  }
  return null;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const left = sorted[mid - 1] ?? sorted[mid] ?? 0;
    const right = sorted[mid] ?? left;
    return (left + right) / 2;
  }
  return sorted[mid] ?? 0;
}

function buildPeriodOffsetMap(rows: EventRow[], fps: number): { byPeriod: Map<number, number>; fallback: number } {
  const grouped = new Map<number, number[]>();
  for (const row of rows) {
    // Exclude rows explicitly marked as timestamp errors or synthetic missing rows
    // when estimating baseline offsets.
    if (row.error_type === "synced_ts" || row.error_type === "missing" || row.id.startsWith("missing_")) {
      continue;
    }
    if (typeof row.synced_frame_id !== "number" || !Number.isFinite(row.synced_frame_id)) continue;
    const tsSeconds = parseTimestampToSeconds(row.synced_ts);
    if (tsSeconds === null) continue;
    const offset = tsSeconds - row.synced_frame_id / fps;
    const bucket = grouped.get(row.period_id);
    if (bucket) {
      bucket.push(offset);
    } else {
      grouped.set(row.period_id, [offset]);
    }
  }

  const byPeriod = new Map<number, number>();
  for (const [periodId, offsets] of grouped.entries()) {
    const sorted = [...offsets].sort((a, b) => a - b);
    const trim = sorted.length >= 10 ? Math.floor(sorted.length * 0.1) : 0;
    const core = trim > 0 ? sorted.slice(trim, sorted.length - trim) : sorted;
    byPeriod.set(periodId, median(core));
  }

  const fallback = byPeriod.size > 0 ? median(Array.from(byPeriod.values())) : 0;
  return { byPeriod, fallback };
}

function normalizeMissingRowsByFrame(rows: EventRow[], fps: number): { rows: EventRow[]; changed: boolean } {
  const { byPeriod, fallback } = buildPeriodOffsetMap(rows, fps);
  const mismatchThresholdSeconds = 2;
  let changed = false;

  const normalized = rows.map((row) => {
    const isMissingRow = row.error_type === "missing" || row.id.startsWith("missing_");
    if (!isMissingRow) {
      return row;
    }

    const offset = byPeriod.get(row.period_id) ?? fallback;
    let next = row;

    if (typeof row.synced_frame_id === "number" && Number.isFinite(row.synced_frame_id)) {
      const expectedSyncedTs = frameToEventTimestamp(row.synced_frame_id, fps, offset);
      const expectedSyncedSec = parseTimestampToSeconds(expectedSyncedTs);
      const currentSyncedSec = parseTimestampToSeconds(row.synced_ts);
      if (
        expectedSyncedSec !== null
        && (currentSyncedSec === null || Math.abs(currentSyncedSec - expectedSyncedSec) > mismatchThresholdSeconds)
      ) {
        next = { ...next, synced_ts: expectedSyncedTs };
      }
    }

    // Keep empty receive_ts as-is, but normalize if a value exists and is clearly inconsistent.
    const receiveTsText = (row.receive_ts ?? "").trim();
    if (
      receiveTsText
      && typeof row.receive_frame_id === "number"
      && Number.isFinite(row.receive_frame_id)
    ) {
      const expectedReceiveTs = frameToEventTimestamp(row.receive_frame_id, fps, offset);
      const expectedReceiveSec = parseTimestampToSeconds(expectedReceiveTs);
      const currentReceiveSec = parseTimestampToSeconds(row.receive_ts);
      if (
        expectedReceiveSec !== null
        && currentReceiveSec !== null
        && Math.abs(currentReceiveSec - expectedReceiveSec) > mismatchThresholdSeconds
      ) {
        next = { ...next, receive_ts: expectedReceiveTs };
      }
    }

    if (next !== row) {
      changed = true;
    }
    return next;
  });

  return { rows: normalized, changed };
}

export function AnnotationPage() {
  const { sessionId: routeSessionId = "", matchId = "" } = useParams();
  const [sessionId, setSessionId] = useState(routeSessionId);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const suppressAutoFollowRef = useRef(false);

  const [session, setSession] = useState<SessionStatus | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(true);

  const [currentTime, setCurrentTime] = useState(0);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveMessage, setSaveMessage] = useState("");
  const [syncingSheet, setSyncingSheet] = useState(false);
  const [resettingSheet, setResettingSheet] = useState(false);

  const [dirty, setDirty] = useState(false);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [selectedVideoIndex, setSelectedVideoIndex] = useState(0);
  const [spadlTypes, setSpadlTypes] = useState<string[]>([]);
  const [pendingSeekFrame, setPendingSeekFrame] = useState<number | null>(null);
  const [draftRow, setDraftRow] = useState<EventRow | null>(null);

  const selectedRow = events[selectedIndex] ?? null;
  const fps = session?.fps ?? 25;
  const hasPendingRowChanges = !!(selectedRow && draftRow && !isSameEventRow(selectedRow, draftRow));
  const isErrorTypeRequired = hasPendingRowChanges && !draftRow?.error_type;
  const selectedAnchorFrame = getAnchorFrame(selectedRow);
  const draftPlayerId = draftRow?.player_id ?? selectedRow?.player_id ?? "";
  const draftReceiverId = draftRow?.receiver_id ?? selectedRow?.receiver_id ?? "";

  const knownEntityIds = useMemo(() => {
    const idSet = new Set<string>();
    for (const row of events) {
      const playerId = row.player_id?.trim();
      const receiverId = row.receiver_id?.trim();
      if (playerId) idSet.add(playerId);
      if (receiverId) idSet.add(receiverId);
    }
    return Array.from(idSet).sort(compareEntityIds);
  }, [events]);

  const knownEntityIdSet = useMemo(() => new Set(knownEntityIds), [knownEntityIds]);
  const isDraftPlayerIdValid = isValidEntityId(draftRow?.player_id, false, knownEntityIdSet);
  const isDraftReceiverIdValid = isValidEntityId(draftRow?.receiver_id, true, knownEntityIdSet);
  const canConfirmRowChanges = !!(
    selectedRow
    && draftRow
    && hasPendingRowChanges
    && draftRow.error_type
    && isDraftPlayerIdValid
    && isDraftReceiverIdValid
  );
  const confirmBlockedReason = !selectedRow || !draftRow
    ? "선택된 row가 없습니다."
    : !hasPendingRowChanges
      ? "수정된 내용이 없습니다."
      : !draftRow.error_type
        ? "error_type을 선택해야 합니다."
        : !isDraftPlayerIdValid
          ? "player_id 형식을 확인하세요."
          : !isDraftReceiverIdValid
            ? "receiver_id 형식을 확인하세요."
            : "";
  const syncedTimingPoints = useMemo(() => {
    const points: Array<{ periodId: number; frameId: number; offset: number }> = [];
    for (const row of events) {
      if (typeof row.synced_frame_id !== "number" || !Number.isFinite(row.synced_frame_id)) continue;
      const tsSeconds = parseTimestampToSeconds(row.synced_ts);
      if (tsSeconds === null) continue;
      points.push({
        periodId: row.period_id,
        frameId: row.synced_frame_id,
        offset: tsSeconds - row.synced_frame_id / fps,
      });
    }
    return points;
  }, [events, fps]);
  const periodTimestampOffsets = useMemo(() => {
    const grouped = new Map<number, number[]>();
    for (const point of syncedTimingPoints) {
      const bucket = grouped.get(point.periodId);
      if (bucket) {
        bucket.push(point.offset);
      } else {
        grouped.set(point.periodId, [point.offset]);
      }
    }

    const offsets = new Map<number, number>();
    for (const [periodId, periodOffsets] of grouped.entries()) {
      const sorted = [...periodOffsets].sort((a, b) => a - b);
      // Trim extremes to avoid one-off outliers (e.g., accidentally edited rows).
      const trim = sorted.length >= 10 ? Math.floor(sorted.length * 0.1) : 0;
      const core = trim > 0 ? sorted.slice(trim, sorted.length - trim) : sorted;
      offsets.set(periodId, median(core));
    }
    return offsets;
  }, [syncedTimingPoints]);
  const defaultTimestampOffset = useMemo(() => {
    if (periodTimestampOffsets.size === 0) {
      return 0;
    }
    return median(Array.from(periodTimestampOffsets.values()));
  }, [periodTimestampOffsets]);

  const videoCandidates = useMemo(() => {
    if (!session) return [] as string[];
    if (session.video_urls && session.video_urls.length > 0) {
      return session.video_urls;
    }
    if (session.video_url) {
      return [session.video_url];
    }
    return [] as string[];
  }, [session]);

  const videoUrl = useMemo(() => {
    if (videoCandidates.length === 0) return null;
    const safeIndex = Math.min(Math.max(selectedVideoIndex, 0), videoCandidates.length - 1);
    return buildArtifactUrl(videoCandidates[safeIndex]);
  }, [selectedVideoIndex, videoCandidates]);

  const segmentRanges = useMemo(() => {
    return videoCandidates.map((path) => parseSegmentFrameRange(path));
  }, [videoCandidates]);

  const segmentStartFrame = useMemo(() => {
    if (segmentRanges.length === 0) return 0;
    const safeIndex = Math.min(Math.max(selectedVideoIndex, 0), segmentRanges.length - 1);
    return segmentRanges[safeIndex]?.start ?? 0;
  }, [selectedVideoIndex, segmentRanges]);

  const currentFrame = segmentStartFrame + Math.round(currentTime * fps);
  const selectedFrameDelta = selectedAnchorFrame === null ? null : selectedAnchorFrame - currentFrame;
  const saveStateLabel = saveState === "saving"
    ? "Saving"
    : saveState === "saved"
      ? "Saved"
      : saveState === "error"
        ? "Error"
        : "Idle";
  const getTimestampOffsetForPeriod = (periodId: number | null | undefined, nearFrame?: number): number => {
    const targetPeriod = typeof periodId === "number" && Number.isFinite(periodId) ? periodId : 1;
    if (typeof nearFrame === "number" && Number.isFinite(nearFrame)) {
      const nearby = syncedTimingPoints
        .filter((point) => point.periodId === targetPeriod && Math.abs(point.frameId - nearFrame) <= 3000)
        .map((point) => point.offset);
      if (nearby.length >= 3) {
        return median(nearby);
      }
    }
    const byPeriod = periodTimestampOffsets.get(targetPeriod);
    if (typeof byPeriod === "number") {
      return byPeriod;
    }
    return defaultTimestampOffset;
  };
  const activePeriodId = draftRow?.period_id ?? selectedRow?.period_id ?? 1;
  const activeTimestampOffset = getTimestampOffsetForPeriod(activePeriodId, currentFrame);
  const absoluteTimestamp = useMemo(
    () => frameToEventTimestamp(currentFrame, fps, activeTimestampOffset),
    [currentFrame, fps, activeTimestampOffset],
  );
  const warningItems = useMemo(
    () =>
      warnings.slice(0, 20).map((text, index) => {
        const match = text.match(WARNING_FRAME_PATTERN);
        if (!match) {
          return { key: `${text}-${index}`, text, frameId: null as number | null, body: text };
        }

        const frameId = Number(match[1]);
        const body = text.replace(WARNING_FRAME_PATTERN, "").replace(/^:\s*/, "").trim();
        return {
          key: `${text}-${index}`,
          text,
          frameId: Number.isFinite(frameId) ? frameId : null,
          body: body || text,
        };
      }),
    [warnings],
  );

  useEffect(() => {
    if (routeSessionId) {
      setSessionId(routeSessionId);
      return;
    }

    const normalizedMatchId = matchId.trim();
    if (!normalizedMatchId) {
      setSessionId("");
      return;
    }

    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const latest = await fetchLatestSessionForMatch(normalizedMatchId);
        if (cancelled) return;
        if (!latest) {
          setSessionId("");
          setSession(null);
          setEvents([]);
          setWarnings([]);
          setInitialLoaded(false);
          setDirty(false);
          setSaveState("error");
          setSaveMessage(`No session found for match_id=${normalizedMatchId}`);
          setLoading(false);
          return;
        }
        setSessionId(latest.session_id);
      } catch (err) {
        if (cancelled) return;
        setSessionId("");
        setSession(null);
        setEvents([]);
        setWarnings([]);
        setInitialLoaded(false);
        setDirty(false);
        setSaveState("error");
        setSaveMessage((err as Error).message);
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [routeSessionId, matchId]);

  useEffect(() => {
    if (videoCandidates.length === 0) {
      setSelectedVideoIndex(0);
      return;
    }
    if (selectedVideoIndex > videoCandidates.length - 1) {
      setSelectedVideoIndex(0);
    }
  }, [selectedVideoIndex, videoCandidates]);

  useEffect(() => {
    setCurrentTime(0);
  }, [selectedVideoIndex]);

  useEffect(() => {
    if (!selectedRow) {
      setDraftRow(null);
      return;
    }
    setDraftRow({ ...selectedRow });
  }, [selectedIndex, selectedRow]);

  useEffect(() => {
    if (pendingSeekFrame === null) {
      return;
    }

    const currentRange = segmentRanges[selectedVideoIndex];
    if (!currentRange) {
      return;
    }
    if (!videoRef.current) {
      return;
    }

    const targetTime = Math.max(0, (pendingSeekFrame - currentRange.start) / fps);
    videoRef.current.currentTime = targetTime;
    setCurrentTime(targetTime);
    setPendingSeekFrame(null);
  }, [pendingSeekFrame, selectedVideoIndex, segmentRanges, fps]);

  const loadAll = async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      const s = await fetchSession(sessionId);
      setSession(s);
      if (s.status === "ready") {
        const eventData = await fetchEvents(sessionId);
        const normalized = normalizeMissingRowsByFrame(eventData.events, s.fps ?? 25);
        setEvents(normalized.rows);
        setWarnings(eventData.validation_warnings);
        setInitialLoaded(true);
        setDirty(normalized.changed);
        if (normalized.changed) {
          setSaveState("saved");
          setSaveMessage("Fixed missing-row timestamps from frame_id");
        }
        try {
          const fetchedTypes = await fetchSpadlTypes();
          const merged = new Set<string>(fetchedTypes);
          for (const row of normalized.rows) {
            if (row.spadl_type) merged.add(row.spadl_type);
          }
          setSpadlTypes(Array.from(merged).sort());
        } catch {
          const fallback = new Set<string>();
          for (const row of normalized.rows) {
            if (row.spadl_type) fallback.add(row.spadl_type);
          }
          setSpadlTypes(Array.from(fallback).sort());
        }
      }
    } catch (err) {
      setSaveState("error");
      setSaveMessage((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !session || session.status !== "processing") {
      return;
    }

    const timer = window.setInterval(async () => {
      const updated = await fetchSession(sessionId);
      setSession(updated);
      if (updated.status !== "processing") {
        window.clearInterval(timer);
        if (updated.status === "ready") {
          const eventData = await fetchEvents(sessionId);
          const normalized = normalizeMissingRowsByFrame(eventData.events, updated.fps ?? 25);
          setEvents(normalized.rows);
          setWarnings(eventData.validation_warnings);
          setInitialLoaded(true);
          setDirty(normalized.changed);
          if (normalized.changed) {
            setSaveState("saved");
            setSaveMessage("Fixed missing-row timestamps from frame_id");
          }
        }
      }
    }, 2000);

    return () => window.clearInterval(timer);
  }, [session, sessionId]);

  useEffect(() => {
    if (!initialLoaded || !dirty || !sessionId) {
      return;
    }

    const timer = window.setTimeout(async () => {
      setSaveState("saving");
      try {
        const result = await saveEvents(sessionId, events);
        setWarnings(result.validation_warnings);
        setSaveState("saved");
        setSaveMessage(`Autosaved ${result.saved_count} rows`);
        setDirty(false);
      } catch (err) {
        setSaveState("error");
        setSaveMessage((err as Error).message);
      }
    }, 700);

    return () => window.clearTimeout(timer);
  }, [dirty, events, initialLoaded, sessionId]);

  useEffect(() => {
    if (events.length === 0) {
      return;
    }
    if (hasPendingRowChanges) {
      return;
    }
    if (suppressAutoFollowRef.current) {
      suppressAutoFollowRef.current = false;
      return;
    }

    const targetIndex = findEventIndexByFrame(events, currentFrame);
    if (targetIndex === null) {
      return;
    }
    // Auto-follow only when frame/events change. Avoid overriding manual row click
    // simply because selectedIndex changed in the same frame.
    setSelectedIndex((prev) => (prev === targetIndex ? prev : targetIndex));
  }, [currentFrame, events, hasPendingRowChanges]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }
      if (isInteractiveTarget(event.target)) {
        return;
      }
      if (!videoRef.current) {
        return;
      }

      if (event.code === "Space") {
        if (event.repeat) return;
        event.preventDefault();
        if (videoRef.current.paused) {
          void videoRef.current.play();
        } else {
          videoRef.current.pause();
        }
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        const step = event.shiftKey ? 1 / fps : KEYBOARD_SEEK_SECONDS;
        const nextTime = Math.max(0, videoRef.current.currentTime - step);
        videoRef.current.currentTime = nextTime;
        setCurrentTime(nextTime);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        const step = event.shiftKey ? 1 / fps : KEYBOARD_SEEK_SECONDS;
        const nextTime = Math.max(0, videoRef.current.currentTime + step);
        videoRef.current.currentTime = nextTime;
        setCurrentTime(nextTime);
      }
    };

    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [fps]);

  const updateDraftRow = (patch: Partial<EventRow>) => {
    setDraftRow((prev) => {
      if (!prev) return prev;
      const merged = { ...prev, ...patch };

      // Respect explicit user selection in error_type dropdown.
      if ("error_type" in patch) {
        return merged;
      }
      if (!selectedRow) {
        return merged;
      }

      const inferred = inferPrimaryErrorType(selectedRow, merged);
      if (!inferred) {
        return merged;
      }
      if (merged.error_type === inferred) {
        return merged;
      }
      return { ...merged, error_type: inferred };
    });
  };

  const confirmRowChanges = () => {
    if (!selectedRow || !draftRow) return;

    if (isSameEventRow(selectedRow, draftRow)) {
      setSaveState("idle");
      setSaveMessage("No row changes to confirm");
      return;
    }

    if (!draftRow.error_type) {
      setSaveState("error");
      setSaveMessage("행을 수정했다면 error_type을 반드시 선택해야 합니다.");
      return;
    }

    if (!isValidEntityId(draftRow.player_id, false, knownEntityIdSet)) {
      setSaveState("error");
      setSaveMessage("player_id는 home/away 형식이거나 기존 항목(예: out_bottom)이어야 합니다.");
      return;
    }

    if (!isValidEntityId(draftRow.receiver_id, true, knownEntityIdSet)) {
      setSaveState("error");
      setSaveMessage("receiver_id는 비우거나 home/away 형식, 또는 기존 항목(예: out_bottom)이어야 합니다.");
      return;
    }

    const nextEvents = [...events];
    nextEvents[selectedIndex] = draftRow;
    setEvents(nextEvents);
    setDirty(true);
    setSaveState("saved");
    setSaveMessage("Row changes confirmed");
  };

  const applyCurrentTo = (field: "synced" | "receive") => {
    if (!draftRow) return;
    const frame = currentFrame;
    const offset = getTimestampOffsetForPeriod(draftRow.period_id, frame);
    const ts = frameToEventTimestamp(frame, fps, offset);
    if (field === "synced") {
      updateDraftRow({ synced_ts: ts, synced_frame_id: frame });
    } else {
      updateDraftRow({ receive_ts: ts, receive_frame_id: frame });
    }
  };

  const updateFrameAndTimestamp = (field: "synced" | "receive", rawValue: string) => {
    const trimmed = rawValue.trim();
    if (trimmed === "") {
      if (field === "synced") {
        updateDraftRow({ synced_frame_id: null, synced_ts: "" });
      } else {
        updateDraftRow({ receive_frame_id: null, receive_ts: "" });
      }
      return;
    }

    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      return;
    }
    const frame = Math.round(parsed);
    const targetPeriodId = draftRow?.period_id ?? selectedRow?.period_id ?? 1;
    const offset = getTimestampOffsetForPeriod(targetPeriodId, frame);
    const ts = frameToEventTimestamp(frame, fps, offset);
    if (field === "synced") {
      updateDraftRow({ synced_frame_id: frame, synced_ts: ts });
    } else {
      updateDraftRow({ receive_frame_id: frame, receive_ts: ts });
    }
  };

  const jump = (delta: number) => {
    if (!videoRef.current) return;
    const nextTime = Math.max(0, videoRef.current.currentTime + delta);
    videoRef.current.currentTime = nextTime;
    setCurrentTime(nextTime);
  };

  const seekToAbsoluteFrame = (absoluteFrame: number) => {
    if (!Number.isFinite(absoluteFrame)) {
      return;
    }

    if (segmentRanges.length === 0) {
      const targetTime = Math.max(0, absoluteFrame / fps);
      if (videoRef.current) {
        videoRef.current.currentTime = targetTime;
      }
      setCurrentTime(targetTime);
      return;
    }

    let targetIndex = segmentRanges.findIndex((range) => {
      if (!range) return false;
      return absoluteFrame >= range.start && absoluteFrame <= range.end;
    });

    if (targetIndex < 0) {
      targetIndex = absoluteFrame < (segmentRanges[0]?.start ?? 0) ? 0 : segmentRanges.length - 1;
    }

    const targetRange = segmentRanges[targetIndex];
    if (!targetRange) return;
    const targetTime = Math.max(0, (absoluteFrame - targetRange.start) / fps);

    if (targetIndex !== selectedVideoIndex) {
      setPendingSeekFrame(absoluteFrame);
      setSelectedVideoIndex(targetIndex);
      return;
    }

    if (videoRef.current) {
      videoRef.current.currentTime = targetTime;
    }
    setCurrentTime(targetTime);
    setPendingSeekFrame(null);
  };

  const jumpToWarningFrame = (frameId: number) => {
    if (hasPendingRowChanges) {
      const discard = window.confirm("현재 row 수정사항이 확정되지 않았습니다. 버리고 이동할까요?");
      if (!discard) {
        return;
      }
    }

    if (videoRef.current && !videoRef.current.paused) {
      videoRef.current.pause();
    }
    suppressAutoFollowRef.current = true;

    const exactIndex = events.findIndex(
      (row) => row.synced_frame_id === frameId || row.receive_frame_id === frameId,
    );
    if (exactIndex >= 0) {
      setSelectedIndex(exactIndex);
    } else {
      const nearestIndex = findEventIndexByFrame(events, frameId);
      if (nearestIndex !== null) {
        setSelectedIndex(nearestIndex);
      }
    }
    seekToAbsoluteFrame(frameId);
  };

  const handleSelectEvent = (index: number) => {
    if (index !== selectedIndex && hasPendingRowChanges) {
      const discard = window.confirm("현재 row 수정사항이 확정되지 않았습니다. 버리고 이동할까요?");
      if (!discard) {
        return;
      }
    }

    if (videoRef.current && !videoRef.current.paused) {
      videoRef.current.pause();
    }
    suppressAutoFollowRef.current = true;
    setSelectedIndex(index);
    const row = events[index];
    if (!row) return;

    const targetFrame = getAnchorFrame(row);

    if (targetFrame === null) {
      return;
    }
    seekToAbsoluteFrame(targetFrame);
  };

  const addMissingRow = () => {
    const basePeriod = selectedRow?.period_id ?? 1;
    const selectedReceiveTs = selectedRow?.receive_ts?.trim() ?? "";
    const selectedReceiveFrame = selectedRow?.receive_frame_id;
    const defaultSyncedFrame = typeof selectedReceiveFrame === "number" ? selectedReceiveFrame : currentFrame;
    const defaultOffset = getTimestampOffsetForPeriod(basePeriod, defaultSyncedFrame);
    const computedSyncedTs = frameToEventTimestamp(defaultSyncedFrame, fps, defaultOffset);
    const selectedReceiveSec = parseTimestampToSeconds(selectedReceiveTs);
    const computedSyncedSec = parseTimestampToSeconds(computedSyncedTs);
    const canReuseSelectedReceiveTs = (
      selectedReceiveSec !== null
      && computedSyncedSec !== null
      && Math.abs(selectedReceiveSec - computedSyncedSec) <= 2
    );
    const defaultSyncedTs = canReuseSelectedReceiveTs ? selectedReceiveTs : computedSyncedTs;
    const defaultPlayerId = (selectedRow?.receiver_id?.trim() || selectedRow?.player_id || "").trim();

    const newRow: EventRow = {
      id: `missing_${Date.now()}`,
      period_id: basePeriod,
      spadl_type: "pass",
      player_id: defaultPlayerId,
      synced_frame_id: defaultSyncedFrame,
      synced_ts: defaultSyncedTs,
      receiver_id: "",
      receive_frame_id: null,
      receive_ts: "",
      outcome: true,
      error_type: "missing",
      note: "",
    };
    const insertIndex =
      selectedRow && selectedIndex >= 0
        ? Math.min(selectedIndex + 1, events.length)
        : findInsertIndexByFrame(events, defaultSyncedFrame);
    const nextEvents = [...events];
    nextEvents.splice(insertIndex, 0, newRow);
    setEvents(nextEvents);
    setSelectedIndex(insertIndex);
    setDirty(true);
  };

  const removeSelectedRow = () => {
    if (!selectedRow) {
      return;
    }

    const confirmed = window.confirm("선택한 이벤트 row를 삭제할까요?");
    if (!confirmed) {
      return;
    }

    const nextEvents = [...events];
    nextEvents.splice(selectedIndex, 1);
    setEvents(nextEvents);
    setSelectedIndex(nextEvents.length === 0 ? 0 : Math.min(selectedIndex, nextEvents.length - 1));
    setDirty(true);
  };

  const handleSyncSheet = async () => {
    if (!sessionId) return;
    if (hasPendingRowChanges) {
      setSaveState("error");
      setSaveMessage("먼저 Confirm Row Changes를 눌러 행 수정사항을 확정하세요.");
      return;
    }
    if (syncingSheet || resettingSheet) return;
    setSyncingSheet(true);
    setSaveState("saving");
    try {
      const result = await syncSheet(sessionId);
      setSaveState("saved");
      setSaveMessage(result.sheet_url ? `Sheet synced: ${result.sheet_url}` : "Sheet sync complete");
      const latest = await fetchSession(sessionId);
      setSession(latest);
    } catch (err) {
      setSaveState("error");
      setSaveMessage((err as Error).message);
    } finally {
      setSyncingSheet(false);
    }
  };

  const handleResetSheet = async () => {
    if (!sessionId) return;

    const confirmed = window.confirm(
      "초기 이벤트 상태로 되돌릴까요?\n현재 수정사항은 사라지며, Event Timeline과 시트가 초기값으로 복원됩니다.",
    );
    if (!confirmed) {
      return;
    }

    if (syncingSheet || resettingSheet) return;
    setResettingSheet(true);
    setSaveState("saving");
    try {
      const result = await resetEvents(sessionId);
      setWarnings(result.validation_warnings);
      setSaveState("saved");
      setSaveMessage(
        result.source === "snapshot"
          ? `Timeline reset to initial snapshot (${result.restored_count} rows)`
          : `Timeline reset by recompute (${result.restored_count} rows)`,
      );
      const latest = await fetchSession(sessionId);
      setSession(latest);
      const eventData = await fetchEvents(sessionId);
      setEvents(eventData.events);
      setWarnings(eventData.validation_warnings);
      setSelectedIndex((prev) => {
        if (eventData.events.length === 0) return 0;
        return Math.min(prev, eventData.events.length - 1);
      });
      setDirty(false);
    } catch (err) {
      setSaveState("error");
      setSaveMessage((err as Error).message);
    } finally {
      setResettingSheet(false);
    }
  };

  if (loading) {
    return <div className="page">Loading session...</div>;
  }

  if (!session) {
    return <div className="page">Session not found.</div>;
  }

  if (session.status === "processing") {
    return (
      <div className="page">
        <h1>Preparing Session</h1>
        <p>Session: {session.session_id}</p>
        <p>Progress: {session.progress ?? "processing"}</p>
        <Link to="/">Back</Link>
      </div>
    );
  }

  if (session.status === "error") {
    return (
      <div className="page">
        <h1>Session Build Failed</h1>
        <pre className="error-box">{session.error_message}</pre>
        <Link to="/">Back</Link>
      </div>
    );
  }

  return (
    <div className="page page-annotate">
      <header className="annot-header">
        <div className="annot-title-group">
          <h1>{session.match_id}</h1>
          <div className="annot-meta">
            <span className="meta-pill">{fps} fps</span>
            <span className="meta-pill">{events.length} rows</span>
            <span className={`status-chip ${saveState}`} aria-live="polite">
              {saveState === "saving" && <span className="spinner" aria-hidden="true" />}
              Save {saveStateLabel}
            </span>
          </div>
        </div>
        <div className="row annot-actions">
          {session.sheet_url && (
            <a className="button-link primary" href={session.sheet_url} target="_blank" rel="noreferrer">
              Open Google Sheet
            </a>
          )}
          <button
            onClick={() => void handleSyncSheet()}
            disabled={syncingSheet || resettingSheet}
          >
            {syncingSheet && <span className="spinner" aria-hidden="true" />}
            {syncingSheet ? "Syncing..." : "Sync Sheet"}
          </button>
          <button
            className="danger"
            onClick={() => void handleResetSheet()}
            disabled={syncingSheet || resettingSheet}
          >
            {resettingSheet && <span className="spinner" aria-hidden="true" />}
            {resettingSheet ? "Resetting..." : "Reset Timeline (Initial)"}
          </button>
          <Link className="button-link" to="/">New Session</Link>
        </div>
      </header>

      <main className="annot-layout">
        <section className="video-panel card">
          {videoUrl ? (
            <>
              {videoCandidates.length > 1 && (
                <label>
                  Video Segment
                  <select
                    value={selectedVideoIndex}
                    onChange={(e) => setSelectedVideoIndex(Number(e.target.value) || 0)}
                  >
                    {videoCandidates.map((url, idx) => (
                      <option key={url} value={idx}>
                        Segment {idx + 1}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className="frame-readout">
                <div className="frame-readout-grid">
                  <div>
                    <div className="frame-readout-label">segment timestamp</div>
                    <div className="frame-readout-main">{formatSeconds(currentTime)}</div>
                  </div>
                  <div>
                    <div className="frame-readout-label">absolute frame</div>
                    <div className="frame-readout-main frame-readout-frame">{currentFrame}</div>
                  </div>
                </div>
                <div className="frame-readout-sub">
                  absolute timestamp {absoluteTimestamp} | segment frame {Math.round(currentTime * fps)}
                </div>
              </div>
              <video
                ref={videoRef}
                src={videoUrl}
                controls
                onTimeUpdate={(e) => setCurrentTime((e.target as HTMLVideoElement).currentTime)}
                onSeeked={(e) => setCurrentTime((e.target as HTMLVideoElement).currentTime)}
                onLoadedMetadata={(e) => {
                  const videoEl = e.target as HTMLVideoElement;
                  if (pendingSeekFrame !== null) {
                    const range = segmentRanges[selectedVideoIndex];
                    if (range) {
                      const targetTime = Math.max(0, (pendingSeekFrame - range.start) / fps);
                      videoEl.currentTime = targetTime;
                      setCurrentTime(targetTime);
                      setPendingSeekFrame(null);
                      return;
                    }
                  }
                  setCurrentTime(videoEl.currentTime || 0);
                }}
              />
              <div className="row controls-row">
                <button onClick={() => jump(-5)}>-5s</button>
                <button
                  onClick={() => {
                    if (!videoRef.current) return;
                    if (videoRef.current.paused) {
                      void videoRef.current.play();
                    } else {
                      videoRef.current.pause();
                    }
                  }}
                >
                  Play / Pause (Space)
                </button>
                <button onClick={() => jump(5)}>+5s</button>
                <button onClick={() => jump(-KEYBOARD_SEEK_SECONDS)}>-0.2s (←)</button>
                <button onClick={() => jump(KEYBOARD_SEEK_SECONDS)}>+0.2s (→)</button>
                <button onClick={() => jump(-1 / fps)}>Prev Frame (Shift+←)</button>
                <button onClick={() => jump(1 / fps)}>Next Frame (Shift+→)</button>
              </div>
              <p className="muted">Tip: ←/→ 는 0.2초 이동, Shift+←/→ 는 1프레임 이동</p>
            </>
          ) : (
            <p>No video generated for this session.</p>
          )}
        </section>

        <section className="editor-panel card">
          <div className="section-header">
            <h2>Event Timeline</h2>
            <div className="section-actions">
              <button onClick={addMissingRow}>Add Missing Row</button>
              <button className="danger" disabled={!selectedRow} onClick={removeSelectedRow}>Remove Row</button>
            </div>
          </div>
          <p className="muted">행을 클릭하면 해당 이벤트 프레임으로 비디오가 이동합니다.</p>
          <div className="timeline-hud">
            <div className="timeline-hud-item">
              <div className="timeline-hud-label">Current frame</div>
              <div className="timeline-hud-value">{currentFrame}</div>
            </div>
            <div className="timeline-hud-item">
              <div className="timeline-hud-label">Selected frame</div>
              <div className="timeline-hud-value">{selectedAnchorFrame ?? "-"}</div>
            </div>
            <div
              className={[
                "timeline-hud-item",
                selectedFrameDelta !== null && Math.abs(selectedFrameDelta) <= 1 ? "hud-delta-match" : "",
                selectedFrameDelta !== null && Math.abs(selectedFrameDelta) > 1 && Math.abs(selectedFrameDelta) <= 6
                  ? "hud-delta-near"
                  : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <div className="timeline-hud-label">Δ (selected - now)</div>
              <div className="timeline-hud-value">
                {selectedFrameDelta === null ? "-" : `${selectedFrameDelta > 0 ? "+" : ""}${selectedFrameDelta}`}
              </div>
            </div>
          </div>
          <EventTable
            rows={events}
            selectedIndex={selectedIndex}
            currentFrame={currentFrame}
            onSelect={handleSelectEvent}
          />

          {selectedRow ? (
            <>
              <h2 className="editor-title">Edit Event #{selectedIndex + 1}</h2>
              <div className="row">
                <button
                  className="primary"
                  onClick={confirmRowChanges}
                  disabled={!canConfirmRowChanges}
                  title={canConfirmRowChanges ? "현재 row 수정사항 확정" : confirmBlockedReason}
                >
                  Confirm Row Changes
                </button>
                {hasPendingRowChanges && <span className="muted">미확정 수정사항 있음</span>}
                {isErrorTypeRequired && <span className="error-text">error_type을 선택해야 Confirm 가능합니다.</span>}
                {!canConfirmRowChanges && (
                  <span className="muted">Confirm 비활성: {confirmBlockedReason}</span>
                )}
              </div>
              <div className="form-grid">
                <label>
                  period_id
                  <input
                    type="number"
                    value={draftRow?.period_id ?? selectedRow.period_id}
                    onChange={(e) => updateDraftRow({ period_id: Number(e.target.value) || 1 })}
                  />
                </label>

                <label>
                  spadl_type
                  <select
                    value={draftRow?.spadl_type ?? selectedRow.spadl_type}
                    onChange={(e) => updateDraftRow({ spadl_type: e.target.value })}
                  >
                    {spadlTypes.length === 0 && (
                      <option value={selectedRow.spadl_type}>{selectedRow.spadl_type}</option>
                    )}
                    {spadlTypes.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                    {!spadlTypes.includes(selectedRow.spadl_type) && selectedRow.spadl_type && (
                      <option value={selectedRow.spadl_type}>{selectedRow.spadl_type}</option>
                    )}
                  </select>
                </label>

                <label>
                  player_id
                  <select
                    className={!isDraftPlayerIdValid ? "input-error" : ""}
                    value={draftPlayerId}
                    onChange={(e) => updateDraftRow({ player_id: e.target.value })}
                  >
                    {draftPlayerId && !knownEntityIdSet.has(draftPlayerId) && (
                      <option value={draftPlayerId}>{draftPlayerId}</option>
                    )}
                    {knownEntityIds.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                  {!isDraftPlayerIdValid && (
                    <p className="error-text id-format-help">player_id는 목록에서 선택하세요.</p>
                  )}
                </label>

                <label>
                  synced_frame_id
                  <div className="inline-field">
                    <input
                      type="number"
                      value={draftRow?.synced_frame_id ?? selectedRow.synced_frame_id ?? ""}
                      onChange={(e) => updateFrameAndTimestamp("synced", e.target.value)}
                    />
                    <button type="button" onClick={() => applyCurrentTo("synced")}>Use Current</button>
                  </div>
                  <p className="muted id-format-help">synced_ts 자동: {draftRow?.synced_ts ?? selectedRow.synced_ts ?? "-"}</p>
                </label>

                <label>
                  receiver_id
                  <select
                    className={!isDraftReceiverIdValid ? "input-error" : ""}
                    value={draftReceiverId}
                    onChange={(e) => updateDraftRow({ receiver_id: e.target.value })}
                  >
                    <option value="">(none)</option>
                    {draftReceiverId && !knownEntityIdSet.has(draftReceiverId) && (
                      <option value={draftReceiverId}>{draftReceiverId}</option>
                    )}
                    {knownEntityIds.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                  {!isDraftReceiverIdValid && (
                    <p className="error-text id-format-help">receiver_id는 목록에서 선택하거나 비워두세요.</p>
                  )}
                </label>

                <label>
                  receive_frame_id
                  <div className="inline-field">
                    <input
                      type="number"
                      value={draftRow?.receive_frame_id ?? selectedRow.receive_frame_id ?? ""}
                      onChange={(e) => updateFrameAndTimestamp("receive", e.target.value)}
                    />
                    <button type="button" onClick={() => applyCurrentTo("receive")}>Use Current</button>
                  </div>
                  <p className="muted id-format-help">receive_ts 자동: {draftRow?.receive_ts ?? selectedRow.receive_ts ?? "-"}</p>
                </label>

                <label>
                  outcome
                  <select
                    value={(draftRow?.outcome ?? selectedRow.outcome) ? "true" : "false"}
                    onChange={(e) => updateDraftRow({ outcome: e.target.value === "true" })}
                  >
                    <option value="true">TRUE</option>
                    <option value="false">FALSE</option>
                  </select>
                </label>

                <label>
                  error_type
                  <select
                    className={isErrorTypeRequired ? "input-error" : ""}
                    aria-invalid={isErrorTypeRequired}
                    value={draftRow?.error_type ?? selectedRow.error_type ?? ""}
                    onChange={(e) => updateDraftRow({ error_type: (e.target.value || null) as ErrorType | null })}
                  >
                    {ERROR_TYPES.map((value) => (
                      <option key={value || "empty"} value={value}>
                        {value || "(none)"}
                      </option>
                    ))}
                  </select>
                  {isErrorTypeRequired && (
                    <p className="error-text id-format-help">행 수정 시 error_type은 필수입니다.</p>
                  )}
                  {!isErrorTypeRequired && hasPendingRowChanges && (
                    <p className="muted id-format-help">변경 컬럼 기준으로 자동 선택됩니다. (동시 변경 시 왼쪽 컬럼 우선)</p>
                  )}
                </label>
              </div>

              <label>
                note
                <textarea
                  value={draftRow?.note ?? selectedRow.note}
                  onChange={(e) => updateDraftRow({ note: e.target.value })}
                  rows={3}
                />
              </label>

              <p className="muted">
                synced_frame_id: {draftRow?.synced_frame_id ?? selectedRow.synced_frame_id ?? "-"} | receive_frame_id: {draftRow?.receive_frame_id ?? selectedRow.receive_frame_id ?? "-"}
              </p>
            </>
          ) : (
            <p>No event row selected.</p>
          )}
        </section>
      </main>

      {warnings.length > 0 && (
        <div className="card">
          <h3>Validation warnings</h3>
          <ul>
            {warningItems.map((item) => {
              if (item.frameId !== null) {
                const frameId = item.frameId;
                return (
                  <li key={item.key} className="warning-item">
                    <button
                      type="button"
                      className="warning-frame-link"
                      onClick={() => jumpToWarningFrame(frameId)}
                    >
                      frame {frameId}
                    </button>
                    <span>{item.body}</span>
                  </li>
                );
              }
              return <li key={item.key} className="warning-item">{item.text}</li>;
            })}
          </ul>
        </div>
      )}

      {saveMessage && (
        <p className={`save-feedback ${saveState === "error" ? "error-text" : "muted"}`}>{saveMessage}</p>
      )}
    </div>
  );
}
