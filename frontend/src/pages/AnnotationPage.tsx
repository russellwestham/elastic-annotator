import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Link, useParams } from "react-router-dom";

import {
  addSessionVideo,
  buildArtifactUrl,
  buildSessionCsvExportUrl,
  fetchEvents,
  fetchLatestSessionForMatch,
  fetchSession,
  fetchSpadlTypes,
  resetEvents,
  saveEvents,
} from "../api";
import { EventTable } from "../components/EventTable";
import type { ErrorType, EventRow, SessionStatus, VideoSegment } from "../types";

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
const FRAME_TIME_EPSILON = 1e-6;
const TEAM_PLAYER_ID_PATTERN = /^(home|away)_\d+$/;
const TEAM_PLAYER_ID_DETAIL_PATTERN = /^(home|away)_(\d+)$/;
const WARNING_FRAME_PATTERN = /\bframe_id=(\d+)\b/;

type VideoFrameCallbackMetadata = {
  mediaTime: number;
};

type FrameCallbackVideoElement = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    callback: (now: number, metadata: VideoFrameCallbackMetadata) => void,
  ) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

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

function getSegmentFrameFromTime(seconds: number, fps: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 0;
  }
  return Math.max(0, Math.floor(seconds * fps + FRAME_TIME_EPSILON));
}

function getSegmentTimeForFrame(segmentFrame: number, fps: number): number {
  return Math.max(0, segmentFrame) / fps;
}

function getSeekTimeForSegmentFrame(segmentFrame: number, fps: number, duration: number): number {
  const centeredTime = (Math.max(0, segmentFrame) + 0.5) / fps;
  if (!Number.isFinite(duration) || duration <= 0) {
    return centeredTime;
  }

  const maxTime = Math.max(0, duration - Math.min(0.001, 0.25 / fps));
  return Math.min(centeredTime, maxTime);
}

function supportsVideoFrameCallback(videoEl: HTMLVideoElement): videoEl is FrameCallbackVideoElement {
  return typeof (videoEl as FrameCallbackVideoElement).requestVideoFrameCallback === "function";
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

function getSegmentEndFrame(segment: VideoSegment | null | undefined): number | null {
  if (!segment || typeof segment.start_frame !== "number" || typeof segment.frame_count !== "number") {
    return null;
  }
  if (!Number.isFinite(segment.start_frame) || !Number.isFinite(segment.frame_count) || segment.frame_count <= 0) {
    return null;
  }
  return segment.start_frame + segment.frame_count - 1;
}

function buildLegacyVideoSegments(session: SessionStatus | null): VideoSegment[] {
  if (!session) return [];

  const urls = [
    ...(session.video_url ? [session.video_url] : []),
    ...(session.video_urls ?? []),
  ].filter((value, index, array): value is string => !!value && array.indexOf(value) === index);

  return urls.map((url, index) => {
    const match = url.match(/_(\d+)-(\d+)\.[^.]+(?:$|\?)/);
    const startFrame = match ? Number(match[1]) : (index === 0 ? session.video_start_frame ?? 0 : 0);
    const endFrame = match ? Number(match[2]) : null;
    const frameCount = endFrame !== null && Number.isFinite(endFrame) && Number.isFinite(startFrame)
      ? endFrame - startFrame + 1
      : session.video_frame_count ?? null;
    return {
      id: `legacy-${index + 1}`,
      url,
      original_filename: index === 0 ? session.original_video_filename ?? null : null,
      start_frame: Number.isFinite(startFrame) ? startFrame : 0,
      frame_count: frameCount,
      duration_seconds: index === 0 ? session.video_duration_seconds ?? null : null,
      fps: session.fps ?? null,
      created_at: session.updated_at,
    };
  });
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

function inferVideoStartFrame(rows: EventRow[], fps: number): number {
  if (!Number.isFinite(fps) || fps <= 0) return 0;

  const anchors: number[] = [];
  for (const row of rows) {
    if (typeof row.synced_frame_id === "number") {
      const seconds = parseTimestampToSeconds(row.synced_ts);
      if (seconds !== null) {
        anchors.push(row.synced_frame_id - seconds * fps);
      }
    }
    if (typeof row.receive_frame_id === "number") {
      const seconds = parseTimestampToSeconds(row.receive_ts);
      if (seconds !== null) {
        anchors.push(row.receive_frame_id - seconds * fps);
      }
    }
  }

  if (anchors.length === 0) {
    return 0;
  }
  return Math.max(0, Math.round(median(anchors)));
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
  const [pairSelection, setPairSelection] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);

  const [currentSegmentFrame, setCurrentSegmentFrame] = useState(0);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveMessage, setSaveMessage] = useState("");
  const [resettingTimeline, setResettingTimeline] = useState(false);

  const [dirty, setDirty] = useState(false);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [selectedVideoIndex, setSelectedVideoIndex] = useState(0);
  const [spadlTypes, setSpadlTypes] = useState<string[]>([]);
  const [pendingSeekFrame, setPendingSeekFrame] = useState<number | null>(null);
  const [draftRow, setDraftRow] = useState<EventRow | null>(null);
  const [segmentUploadFile, setSegmentUploadFile] = useState<File | null>(null);
  const [segmentUploadStartFrame, setSegmentUploadStartFrame] = useState("");
  const [uploadingSegment, setUploadingSegment] = useState(false);

  const selectedRow = events[selectedIndex] ?? null;
  const fps = session?.fps ?? 25;
  const isUploadSession = session?.session_mode === "upload_csv";
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
    ? "No row selected."
    : !hasPendingRowChanges
      ? "No edits to apply."
      : !draftRow.error_type
        ? "Select an error_type."
        : !isDraftPlayerIdValid
          ? "Check player_id."
          : !isDraftReceiverIdValid
            ? "Check receiver_id."
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

  const videoSegments = useMemo(() => {
    if (!session) return [] as VideoSegment[];
    if (session.video_segments && session.video_segments.length > 0) {
      return session.video_segments;
    }
    return buildLegacyVideoSegments(session);
  }, [session]);
  const activeVideoIndex = useMemo(() => {
    if (videoSegments.length === 0) {
      return 0;
    }
    return Math.min(Math.max(selectedVideoIndex, 0), videoSegments.length - 1);
  }, [selectedVideoIndex, videoSegments]);
  const activeVideoSegment = useMemo(() => {
    return videoSegments[activeVideoIndex] ?? null;
  }, [activeVideoIndex, videoSegments]);
  const activeVideoFps = activeVideoSegment?.fps ?? fps;
  const currentTime = getSegmentTimeForFrame(currentSegmentFrame, activeVideoFps);
  const videoUrl = useMemo(() => {
    if (!activeVideoSegment?.url) return null;
    return buildArtifactUrl(activeVideoSegment.url);
  }, [activeVideoSegment]);
  const segmentOptionLabels = useMemo(() => {
    return videoSegments.map((segment, idx) => {
      const filename = segment.original_filename?.trim() || `Segment ${idx + 1}`;
      const startLabel = segment.start_frame.toLocaleString("en-US");
      const endFrame = getSegmentEndFrame(segment);
      const segmentFps = segment.fps || fps;
      
      if (endFrame === null) {
        return `${filename} | Start ${startLabel}`;
      }
      const endLabel = endFrame.toLocaleString("en-US");
      const startTs = formatSeconds(segment.start_frame / segmentFps);
      const endTs = formatSeconds(endFrame / segmentFps);
      return `${filename} | Frames ${startLabel} - ${endLabel} | Time ${startTs} - ${endTs}`;
    });
  }, [fps, videoSegments]);

  const inferredStartFrame = useMemo(() => {
    if (!isUploadSession) {
      return 0;
    }
    return inferVideoStartFrame(events, fps);
  }, [events, fps, isUploadSession]);

  const uploadStartFrame =
    isUploadSession && typeof session?.video_start_frame === "number"
      ? session.video_start_frame
      : inferredStartFrame;
  const playheadStartFrame = activeVideoSegment?.start_frame ?? uploadStartFrame;

  const currentFrame = playheadStartFrame + currentSegmentFrame;
  const selectedFrameDelta = selectedAnchorFrame === null ? null : selectedAnchorFrame - currentFrame;
  const saveStateLabel = saveState === "saving"
    ? "Saving changes"
    : saveState === "saved"
      ? "All changes saved"
      : saveState === "error"
        ? "Save failed"
        : "Ready";
  const sessionLabel = session?.session_name?.trim() || session?.match_id || "Session";
  const originalCsvExportUrl = sessionId ? buildSessionCsvExportUrl(sessionId, "initial") : "";
  const editedCsvExportUrl = sessionId ? buildSessionCsvExportUrl(sessionId, "current") : "";
  const getTimestampOffsetForPeriod = useCallback((periodId: number | null | undefined, nearFrame?: number): number => {
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
  }, [defaultTimestampOffset, periodTimestampOffsets, syncedTimingPoints]);
  const normalizedPairSelection = useMemo(() => {
    return Array.from(new Set(pairSelection))
      .filter((index) => index >= 0 && index < events.length)
      .sort((a, b) => a - b)
      .slice(0, 2);
  }, [events.length, pairSelection]);
  const pairSourceIndex = normalizedPairSelection.length === 2 ? normalizedPairSelection[0] : null;
  const pairTargetIndex = normalizedPairSelection.length === 2 ? normalizedPairSelection[1] : null;
  const pairSourceRow = pairSourceIndex === null ? null : events[pairSourceIndex] ?? null;
  const pairTargetRow = pairTargetIndex === null ? null : events[pairTargetIndex] ?? null;
  const canAlignPair = !!(
    pairSourceRow
    && pairTargetRow
    && typeof pairTargetRow.synced_frame_id === "number"
    && Number.isFinite(pairTargetRow.synced_frame_id)
    && !hasPendingRowChanges
  );
  const pairAlignTitle = hasPendingRowChanges
    ? "Apply or discard row edits first."
    : normalizedPairSelection.length !== 2
      ? "Hold Command and click two rows."
      : canAlignPair
        ? "Align the earlier row to the later row's synced frame."
        : "The later row needs a synced_frame_id.";
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
    if (videoSegments.length === 0) {
      setSelectedVideoIndex(0);
      return;
    }
    if (selectedVideoIndex > videoSegments.length - 1) {
      setSelectedVideoIndex(0);
    }
  }, [selectedVideoIndex, videoSegments.length]);

  useEffect(() => {
    setCurrentSegmentFrame(0);
  }, [selectedVideoIndex]);

  const syncDisplayedSegmentFrame = useCallback(
    (videoEl: HTMLVideoElement, mediaTime?: number) => {
      const nextFrame = getSegmentFrameFromTime(mediaTime ?? videoEl.currentTime, activeVideoFps);
      setCurrentSegmentFrame(nextFrame);
    },
    [activeVideoFps],
  );

  const seekVideoToSegmentFrame = useCallback(
    (segmentFrame: number, videoEl?: HTMLVideoElement | null) => {
      const targetVideo = videoEl ?? videoRef.current;
      if (!targetVideo) {
        return;
      }
      const targetTime = getSeekTimeForSegmentFrame(segmentFrame, activeVideoFps, targetVideo.duration);
      targetVideo.currentTime = targetTime;
    },
    [activeVideoFps],
  );

  const seekBySegmentFrames = useCallback(
    (deltaFrames: number) => {
      const videoEl = videoRef.current;
      if (!videoEl) {
        return;
      }
      const baseFrame = getSegmentFrameFromTime(videoEl.currentTime, activeVideoFps);
      const nextFrame = Math.max(0, baseFrame + deltaFrames);
      seekVideoToSegmentFrame(nextFrame, videoEl);
    },
    [activeVideoFps, seekVideoToSegmentFrame],
  );

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

    if (!activeVideoSegment) {
      return;
    }
    if (!videoRef.current) {
      return;
    }

    const targetSegmentFrame = pendingSeekFrame - activeVideoSegment.start_frame;
    seekVideoToSegmentFrame(targetSegmentFrame, videoRef.current);
    setPendingSeekFrame(null);
  }, [activeVideoSegment, pendingSeekFrame, seekVideoToSegmentFrame]);

  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl || !supportsVideoFrameCallback(videoEl)) {
      return;
    }

    const requestFrame = videoEl.requestVideoFrameCallback.bind(videoEl);
    const cancelFrame =
      typeof videoEl.cancelVideoFrameCallback === "function"
        ? videoEl.cancelVideoFrameCallback.bind(videoEl)
        : null;
    let callbackId = 0;
    let cancelled = false;

    const handleFrame = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      if (cancelled) {
        return;
      }
      syncDisplayedSegmentFrame(videoEl, metadata.mediaTime);
      callbackId = requestFrame(handleFrame);
    };

    callbackId = requestFrame(handleFrame);
    return () => {
      cancelled = true;
      cancelFrame?.(callbackId);
    };
  }, [selectedVideoIndex, syncDisplayedSegmentFrame, videoUrl]);

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
        setPairSelection([]);
        setWarnings(eventData.validation_warnings);
        setInitialLoaded(true);
        setDirty(normalized.changed);
        if (normalized.changed) {
          setSaveState("saved");
          setSaveMessage("Recovered missing-row timestamps from frame_id");
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
          setPairSelection([]);
          setWarnings(eventData.validation_warnings);
          setInitialLoaded(true);
          setDirty(normalized.changed);
          if (normalized.changed) {
            setSaveState("saved");
            setSaveMessage("Recovered missing-row timestamps from frame_id");
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
        setSaveMessage(`Saved ${result.saved_count} rows`);
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
    setSelectedIndex((prev) => {
      if (prev !== targetIndex) {
        setPairSelection([targetIndex]);
      }
      return prev === targetIndex ? prev : targetIndex;
    });
  }, [currentFrame, events, hasPendingRowChanges]);

  const alignPairToLaterSync = useCallback(() => {
    if (!canAlignPair || pairSourceIndex === null || !pairTargetRow) {
      return;
    }

    const targetFrame = pairTargetRow.synced_frame_id;
    if (typeof targetFrame !== "number") {
      return;
    }
    const targetTimestamp =
      pairTargetRow.synced_ts
      ?? frameToEventTimestamp(
        targetFrame,
        fps,
        getTimestampOffsetForPeriod(pairTargetRow.period_id, targetFrame),
      );

    const nextEvents = [...events];
    const sourceRow = nextEvents[pairSourceIndex];
    if (!sourceRow) {
      return;
    }

    nextEvents[pairSourceIndex] = {
      ...sourceRow,
      synced_frame_id: targetFrame,
      synced_ts: targetTimestamp,
    };
    setEvents(nextEvents);
    setDirty(true);
    setSaveState("saved");
    setSaveMessage(
      `Aligned row #${pairSourceIndex + 1} to row #${(pairTargetIndex ?? pairSourceIndex) + 1}`,
    );
  }, [
    canAlignPair,
    events,
    fps,
    getTimestampOffsetForPeriod,
    pairSourceIndex,
    pairTargetIndex,
    pairTargetRow,
  ]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }
      if (isInteractiveTarget(event.target)) {
        return;
      }
      if (event.key === "Enter" && canAlignPair) {
        event.preventDefault();
        alignPairToLaterSync();
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
        if (event.shiftKey) {
          seekBySegmentFrames(-Math.max(1, Math.round(KEYBOARD_SEEK_SECONDS * activeVideoFps)));
        } else {
          seekBySegmentFrames(-1);
        }
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        if (event.shiftKey) {
          seekBySegmentFrames(Math.max(1, Math.round(KEYBOARD_SEEK_SECONDS * activeVideoFps)));
        } else {
          seekBySegmentFrames(1);
        }
      }
    };

    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [activeVideoFps, alignPairToLaterSync, canAlignPair, seekBySegmentFrames]);

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
      setSaveMessage("Select an error_type before applying changes.");
      return;
    }

    if (!isValidEntityId(draftRow.player_id, false, knownEntityIdSet)) {
      setSaveState("error");
      setSaveMessage("Select a valid player_id.");
      return;
    }

    if (!isValidEntityId(draftRow.receiver_id, true, knownEntityIdSet)) {
      setSaveState("error");
      setSaveMessage("Select a valid receiver_id or leave it blank.");
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
    const direction = delta < 0 ? -1 : 1;
    const frameDelta = Math.max(1, Math.round(Math.abs(delta) * activeVideoFps)) * direction;
    seekBySegmentFrames(frameDelta);
  };

  const handleAddVideoSegment = async () => {
    if (!sessionId) {
      return;
    }
    if (!segmentUploadFile) {
      setSaveState("error");
      setSaveMessage("Select a video file first.");
      return;
    }

    const parsed = Number(segmentUploadStartFrame.trim());
    if (!Number.isFinite(parsed) || parsed < 0) {
      setSaveState("error");
      setSaveMessage("Video start frame must be a non-negative number.");
      return;
    }

    const startFrame = Math.round(parsed);
    setUploadingSegment(true);
    setSaveState("saving");
    setSaveMessage("");
    try {
      const updated = await addSessionVideo({
        sessionId,
        videoFile: segmentUploadFile,
        startFrame,
      });
      setSession(updated);
      let nextIndex = 0;
      for (let index = updated.video_segments.length - 1; index >= 0; index -= 1) {
        const segment = updated.video_segments[index];
        if (
          segment?.start_frame === startFrame
          && (segment.original_filename ?? "").trim() === segmentUploadFile.name.trim()
        ) {
          nextIndex = index;
          break;
        }
      }
      setSelectedVideoIndex(nextIndex);
      setPendingSeekFrame(startFrame);
      setSegmentUploadFile(null);
      setSegmentUploadStartFrame("");
      setSaveState("saved");
      setSaveMessage("Video segment updated");
    } catch (err) {
      setSaveState("error");
      setSaveMessage((err as Error).message);
    } finally {
      setUploadingSegment(false);
    }
  };

  const seekToAbsoluteFrame = (absoluteFrame: number) => {
    if (!Number.isFinite(absoluteFrame)) {
      return;
    }

    if (videoSegments.length <= 1 || !activeVideoSegment) {
      seekVideoToSegmentFrame(absoluteFrame - playheadStartFrame);
      return;
    }

    const rangedSegments = videoSegments
      .map((segment, index) => ({ segment, index, endFrame: getSegmentEndFrame(segment) }))
      .filter(
        (item): item is { segment: VideoSegment; index: number; endFrame: number } =>
          item.endFrame !== null,
      );
    if (rangedSegments.length === 0) {
      return;
    }

    let targetIndex = rangedSegments.find(
      (item) => absoluteFrame >= item.segment.start_frame && absoluteFrame <= item.endFrame,
    )?.index ?? -1;
    if (targetIndex < 0) {
      const first = rangedSegments[0];
      const last = rangedSegments[rangedSegments.length - 1];
      targetIndex = absoluteFrame < first.segment.start_frame ? first.index : last.index;
    }

    const targetSegment = videoSegments[targetIndex];
    if (!targetSegment) return;
    if (targetIndex !== selectedVideoIndex) {
      setPendingSeekFrame(absoluteFrame);
      setSelectedVideoIndex(targetIndex);
      return;
    }

    seekVideoToSegmentFrame(absoluteFrame - targetSegment.start_frame);
    setPendingSeekFrame(null);
  };

  const jumpToWarningFrame = (frameId: number) => {
    if (hasPendingRowChanges) {
      const discard = window.confirm("You have unapplied changes in this row. Discard them and continue?");
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
      setPairSelection([exactIndex]);
    } else {
      const nearestIndex = findEventIndexByFrame(events, frameId);
      if (nearestIndex !== null) {
        setSelectedIndex(nearestIndex);
        setPairSelection([nearestIndex]);
      }
    }
    seekToAbsoluteFrame(frameId);
  };

  const updatePairSelectionOnly = (index: number) => {
    setPairSelection((prev) => {
      const validPrev = prev.filter((item) => item >= 0 && item < events.length);
      if (validPrev.length === 0 || validPrev.length >= 2 || validPrev.includes(index)) {
        return [index];
      }
      return [validPrev[0], index];
    });
  };

  const handleSelectEvent = (index: number, event: MouseEvent<HTMLTableRowElement>) => {
    if (event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      if (hasPendingRowChanges) {
        setSaveState("error");
        setSaveMessage("Apply or discard row edits before pair selection.");
        return;
      }
      suppressAutoFollowRef.current = true;
      updatePairSelectionOnly(index);
      return;
    }

    if (index !== selectedIndex && hasPendingRowChanges) {
      const discard = window.confirm("You have unapplied changes in this row. Discard them and continue?");
      if (!discard) {
        return;
      }
    }

    if (videoRef.current && !videoRef.current.paused) {
      videoRef.current.pause();
    }
    suppressAutoFollowRef.current = true;
    setSelectedIndex(index);
    setPairSelection([index]);
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
    setPairSelection([insertIndex]);
    setDirty(true);
  };

  const removeSelectedRow = () => {
    if (!selectedRow) {
      return;
    }

    const confirmed = window.confirm("Delete this row?");
    if (!confirmed) {
      return;
    }

    const nextEvents = [...events];
    nextEvents.splice(selectedIndex, 1);
    const nextSelectedIndex = nextEvents.length === 0 ? 0 : Math.min(selectedIndex, nextEvents.length - 1);
    setEvents(nextEvents);
    setSelectedIndex(nextSelectedIndex);
    setPairSelection(nextEvents.length === 0 ? [] : [nextSelectedIndex]);
    setDirty(true);
  };

  const handleResetTimeline = async () => {
    if (!sessionId) return;

    const confirmed = window.confirm(
      "Reset all edits to the original CSV?\nThis will discard your current changes.",
    );
    if (!confirmed) {
      return;
    }

    if (resettingTimeline) return;
    setResettingTimeline(true);
    setSaveState("saving");
    try {
      const result = await resetEvents(sessionId);
      setWarnings(result.validation_warnings);
      setSaveState("saved");
      setSaveMessage(
        result.source === "snapshot"
          ? `Restored original CSV (${result.restored_count} rows)`
          : `Restored original events (${result.restored_count} rows)`,
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
      setPairSelection([]);
      setDirty(false);
    } catch (err) {
      setSaveState("error");
      setSaveMessage((err as Error).message);
    } finally {
      setResettingTimeline(false);
    }
  };

  if (loading) {
    return <div className="page">Loading editor...</div>;
  }

  if (!session) {
    return <div className="page">Session not found.</div>;
  }

  if (session.status === "processing") {
    return (
      <div className="page page-create">
        <section className="card status-panel">
          <h1>{sessionLabel}</h1>
          <p className="muted">{session.progress ?? "processing"}</p>
          <Link className="button-link" to="/">Back to Sessions</Link>
        </section>
      </div>
    );
  }

  if (session.status === "error") {
    return (
      <div className="page page-create">
        <section className="card status-panel">
          <h1>{sessionLabel}</h1>
          <pre className="error-box">{session.error_message}</pre>
          <Link className="button-link" to="/">Back to Sessions</Link>
        </section>
      </div>
    );
  }

  return (
    <div className="page page-annotate">
      <header className="annot-header">
        <div className="annot-title-group">
          <h1>{sessionLabel}</h1>
          <div className="annot-meta">
            <span className="meta-pill">{fps} fps</span>
            <span className="meta-pill">{events.length} rows</span>
            <span className="meta-pill">{isUploadSession ? "Uploaded CSV" : "Public Dataset"}</span>
            {isUploadSession && <span className="meta-pill">{session.persist ? "Saved" : "Temporary"}</span>}
            {isUploadSession && <span className="meta-pill">Start frame {playheadStartFrame}</span>}
            <span className={`status-chip ${saveState}`} aria-live="polite">
              {saveState === "saving" && <span className="spinner" aria-hidden="true" />}
              {saveStateLabel}
            </span>
          </div>
        </div>
        <div className="row annot-actions">
          <a className="button-link" href={originalCsvExportUrl}>
            Download Original CSV
          </a>
          <a className="button-link primary" href={editedCsvExportUrl}>
            Download Edited CSV
          </a>
          <button
            className="danger"
            onClick={() => void handleResetTimeline()}
            disabled={resettingTimeline}
          >
            {resettingTimeline && <span className="spinner" aria-hidden="true" />}
            {resettingTimeline ? "Resetting..." : "Reset to Original"}
          </button>
          <Link className="button-link" to="/">Back to Sessions</Link>
        </div>
      </header>

      <main className="annot-layout">
        <section className="video-panel card workspace-card">
          <div className="panel-heading">
            <h2>Video</h2>
          </div>
          {videoUrl ? (
            <>
              {videoSegments.length > 1 && (
                <label>
                  Segment
                  <select
                    value={activeVideoIndex}
                    onChange={(e) => setSelectedVideoIndex(Number(e.target.value) || 0)}
                  >
                    {videoSegments.map((segment, idx) => (
                      <option key={segment.id} value={idx}>
                        {segmentOptionLabels[idx] ?? `Segment ${idx + 1}`}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className="frame-readout">
                <div className="frame-readout-grid">
                  <div>
                    <div className="frame-readout-label">Match Time</div>
                    <div className="frame-readout-main">{absoluteTimestamp}</div>
                  </div>
                  <div>
                    <div className="frame-readout-label">Playhead Frame</div>
                    <div className="frame-readout-main frame-readout-frame">{currentFrame}</div>
                  </div>
                </div>
              </div>
              <video
                ref={videoRef}
                src={videoUrl}
                controls
                onTimeUpdate={(e) => {
                  syncDisplayedSegmentFrame(e.currentTarget);
                }}
                onSeeked={(e) => {
                  const videoEl = e.currentTarget;
                  window.requestAnimationFrame(() => {
                    syncDisplayedSegmentFrame(videoEl);
                  });
                }}
                onLoadedMetadata={(e) => {
                  const videoEl = e.currentTarget;
                  if (pendingSeekFrame !== null) {
                    if (activeVideoSegment) {
                      seekVideoToSegmentFrame(pendingSeekFrame - activeVideoSegment.start_frame, videoEl);
                      setPendingSeekFrame(null);
                      return;
                    }
                  }
                  syncDisplayedSegmentFrame(videoEl);
                }}
              />
              <div className="video-segment-editor">
                <label className="video-segment-upload">
                  <span className="video-segment-upload-label">Replace or add video</span>
                  <input
                    key={segmentUploadFile?.name ?? "video-segment-empty"}
                    type="file"
                    accept=".mp4,.mov,.m4v,.webm,video/*"
                    onChange={(e) => setSegmentUploadFile(e.target.files?.[0] ?? null)}
                    disabled={uploadingSegment}
                  />
                  <span className="video-segment-upload-name">
                    {segmentUploadFile?.name ?? "Choose video file"}
                  </span>
                </label>
                <label className="video-segment-start-field">
                  Start frame
                  <input
                    type="number"
                    min={0}
                    value={segmentUploadStartFrame}
                    onChange={(e) => setSegmentUploadStartFrame(e.target.value)}
                    placeholder="e.g. 25000"
                    disabled={uploadingSegment}
                  />
                </label>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void handleAddVideoSegment()}
                  disabled={uploadingSegment}
                >
                  {uploadingSegment ? "Uploading..." : "Upload Video Segment"}
                </button>
              </div>
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
                  Play / Pause
                </button>
                <button onClick={() => jump(5)}>+5s</button>
                <button onClick={() => seekBySegmentFrames(-1)}>Prev Frame (←)</button>
                <button onClick={() => seekBySegmentFrames(1)}>Next Frame (→)</button>
                <button onClick={() => jump(-KEYBOARD_SEEK_SECONDS)}>-0.2s (Shift+←)</button>
                <button onClick={() => jump(KEYBOARD_SEEK_SECONDS)}>+0.2s (Shift+→)</button>
              </div>
            </>
          ) : (
            <p className="muted">No video available.</p>
          )}
        </section>

        <div className="editor-stack">
          <section className="timeline-panel card workspace-card">
            <div className="section-header">
              <h2>Timeline</h2>
              <div className="section-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={alignPairToLaterSync}
                  disabled={!canAlignPair}
                  title={pairAlignTitle}
                >
                  Align to Later Sync
                </button>
                <button onClick={addMissingRow}>Add Missing Event</button>
                <button className="danger" disabled={!selectedRow} onClick={removeSelectedRow}>Delete Row</button>
              </div>
            </div>
            <div className="timeline-hud">
              <div className="timeline-hud-item">
                <div className="timeline-hud-label">Playhead</div>
                <div className="timeline-hud-value">{currentFrame}</div>
              </div>
              <div className="timeline-hud-item">
                <div className="timeline-hud-label">Selected</div>
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
                <div className="timeline-hud-label">Offset</div>
                <div className="timeline-hud-value">
                  {selectedFrameDelta === null ? "-" : `${selectedFrameDelta > 0 ? "+" : ""}${selectedFrameDelta}`}
                </div>
              </div>
            </div>
            <EventTable
              rows={events}
              selectedIndex={selectedIndex}
              pairSelection={normalizedPairSelection}
              currentFrame={currentFrame}
              onSelect={handleSelectEvent}
            />
          </section>

          <section className="inspector-panel card workspace-card">
            <div className="section-header">
              <h2>{selectedRow ? `Row #${selectedIndex + 1}` : "Inspector"}</h2>
              {selectedRow && (
                <button
                  className="primary"
                  onClick={confirmRowChanges}
                  disabled={!canConfirmRowChanges}
                  title={canConfirmRowChanges ? "Apply changes to this row" : confirmBlockedReason}
                >
                  Apply Changes
                </button>
              )}
            </div>

            {selectedRow ? (
              <>
                <div className="inspector-status">
                  <span className="muted">{hasPendingRowChanges ? "Unsaved changes" : "No changes yet."}</span>
                  {isErrorTypeRequired && <span className="error-text">Select an error_type to apply changes.</span>}
                  {!canConfirmRowChanges && hasPendingRowChanges && !isErrorTypeRequired && (
                    <span className="muted">{confirmBlockedReason}</span>
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
                      <p className="error-text id-format-help">Select a valid player_id.</p>
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
                    <p className="muted id-format-help">synced_ts preview: {draftRow?.synced_ts ?? selectedRow.synced_ts ?? "-"}</p>
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
                      <p className="error-text id-format-help">Select a valid receiver_id or leave it blank.</p>
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
                    <p className="muted id-format-help">receive_ts preview: {draftRow?.receive_ts ?? selectedRow.receive_ts ?? "-"}</p>
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
                      <p className="error-text id-format-help">error_type is required to apply changes.</p>
                    )}
                    {!isErrorTypeRequired && hasPendingRowChanges && (
                      <p className="muted id-format-help">Auto-picked from the changed field. If several fields changed, the leftmost field wins.</p>
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

                <p className="muted inspector-footnote">
                  synced_frame_id: {draftRow?.synced_frame_id ?? selectedRow.synced_frame_id ?? "-"} | receive_frame_id: {draftRow?.receive_frame_id ?? selectedRow.receive_frame_id ?? "-"}
                </p>
              </>
            ) : (
              <p className="muted">Select a row to edit.</p>
            )}
          </section>

          {(warnings.length > 0 || saveMessage) && (
            <section className="review-panel card workspace-card">
              {warnings.length > 0 && (
                <>
                  <h3>Warnings</h3>
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
                              Frame {frameId}
                            </button>
                            <span>{item.body}</span>
                          </li>
                        );
                      }
                      return <li key={item.key} className="warning-item">{item.text}</li>;
                    })}
                  </ul>
                </>
              )}

              {saveMessage && (
                <p className={`save-feedback ${saveState === "error" ? "error-text" : "muted"}`}>{saveMessage}</p>
              )}
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
