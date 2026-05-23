import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import {
  addPublicSessionVideo,
  addSessionVideo,
  buildArtifactUrl,
  buildPublicSessionCsvExportUrl,
  buildSessionCsvExportUrl,
  deleteSession,
  fetchEvents,
  fetchLatestSessionForMatch,
  fetchPublicEvents,
  fetchPublicSession,
  fetchPublicSpadlTypes,
  fetchSession,
  fetchSpadlTypes,
  resetPublicEvents,
  resetEvents,
  savePublicEvents,
  saveEvents,
  undoPublicEvents,
  undoEvents,
  updateSessionMetadata,
  updatePublicSessionVideoTiming,
  updateSessionVideoTiming,
} from "../api";
import { EventTable } from "../components/EventTable";
import type {
  ErrorType,
  EventRow,
  ImportNoteSummary,
  QAFlagSummary,
  SessionStatus,
  VideoSegment,
} from "../types";

interface AnnotationPageProps {
  publicMode?: boolean;
}

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
const TIMING_MAPPING_FPS = 25;
const TEAM_PLAYER_ID_PATTERN = /^(home|away)_\d+$/;
const TEAM_PLAYER_ID_DETAIL_PATTERN = /^(home|away)_(\d+)$/;

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

function getSeekTimeForSegmentFrame(segmentFrame: number, fps: number, duration: number): number {
  // Use exact frame time so the timestamp perfectly matches frame * (1/fps).
  // We add a tiny epsilon (0.0001) instead of 0.5 to avoid showing the previous frame in some browsers.
  const exactTime = (Math.max(0, segmentFrame) + 0.0001) / fps;
  if (!Number.isFinite(duration) || duration <= 0) {
    return exactTime;
  }

  const maxTime = Math.max(0, duration - Math.min(0.001, 0.25 / fps));
  return Math.min(exactTime, maxTime);
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

function hasConfirmedSegmentTiming(segment: VideoSegment | null | undefined): boolean {
  return !!(
    segment
    && segment.timing_confirmed
    && typeof segment.period_start_frame === "number"
    && Number.isFinite(segment.period_start_frame)
    && typeof segment.video_start_time_seconds === "number"
    && Number.isFinite(segment.video_start_time_seconds)
  );
}

function getSegmentMappingFrameCount(segment: VideoSegment | null | undefined): number | null {
  if (!segment) {
    return null;
  }
  if (typeof segment.duration_seconds === "number" && Number.isFinite(segment.duration_seconds) && segment.duration_seconds > 0) {
    return Math.max(1, Math.round(segment.duration_seconds * TIMING_MAPPING_FPS));
  }
  if (typeof segment.frame_count === "number" && Number.isFinite(segment.frame_count) && segment.frame_count > 0) {
    return Math.round(segment.frame_count);
  }
  return null;
}

function getSegmentEndFrame(segment: VideoSegment | null | undefined): number | null {
  const frameCount = getSegmentMappingFrameCount(segment);
  if (!segment || typeof segment.start_frame !== "number" || frameCount === null) {
    return null;
  }
  if (!Number.isFinite(segment.start_frame)) {
    return null;
  }
  return segment.start_frame + frameCount - 1;
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
      period_start_frame: null,
      video_start_time_seconds: null,
      timing_confirmed: false,
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

function getFrameTimestampFromSegmentTiming(frameId: number, segment: VideoSegment): string {
  if (!hasConfirmedSegmentTiming(segment) || typeof segment.period_start_frame !== "number") {
    return formatSeconds(0);
  }
  const seconds = (frameId - segment.period_start_frame) / TIMING_MAPPING_FPS;
  return formatSeconds(seconds);
}

function getSessionTitle(session: SessionStatus | null | undefined): string {
  return (
    session?.display_name?.trim()
    || session?.session_name?.trim()
    || session?.original_video_filename?.trim()
    || session?.match_id?.trim()
    || session?.session_id
    || "Session"
  );
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

export function AnnotationPage({ publicMode = false }: AnnotationPageProps) {
  const navigate = useNavigate();
  const editToken = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("edit_token")?.trim() || null;
  }, []);
  const { sessionId: routeSessionId = "", matchId = "" } = useParams();
  const [sessionId, setSessionId] = useState(routeSessionId);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const suppressAutoFollowRef = useRef(false);

  const [session, setSession] = useState<SessionStatus | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [initialEvents, setInitialEvents] = useState<EventRow[]>([]);
  const [qaFlags, setQaFlags] = useState<QAFlagSummary[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(true);

  const [currentSegmentFrame, setCurrentSegmentFrame] = useState(0);
  const [currentVideoTime, setCurrentVideoTime] = useState(0);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveMessage, setSaveMessage] = useState("");
  const [resettingTimeline, setResettingTimeline] = useState(false);
  const [undoingTimeline, setUndoingTimeline] = useState(false);

  const [dirty, setDirty] = useState(false);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [selectedVideoIndex, setSelectedVideoIndex] = useState(0);
  const [spadlTypes, setSpadlTypes] = useState<string[]>([]);
  const [pendingSeekFrame, setPendingSeekFrame] = useState<number | null>(null);
  const [draftRow, setDraftRow] = useState<EventRow | null>(null);
  const [segmentUploadFile, setSegmentUploadFile] = useState<File | null>(null);
  const [segmentTimingPeriodStartFrame, setSegmentTimingPeriodStartFrame] = useState("");
  const [segmentTimingVideoStartTime, setSegmentTimingVideoStartTime] = useState("");
  const [uploadingSegment, setUploadingSegment] = useState(false);
  const [savingSegmentTiming, setSavingSegmentTiming] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingTitleValue, setEditingTitleValue] = useState("");
  const [savingTitle, setSavingTitle] = useState(false);
  const [deletingCurrentSession, setDeletingCurrentSession] = useState(false);
  const [sessionActionError, setSessionActionError] = useState<string | null>(null);
  const timingCalibrationRef = useRef<HTMLDivElement | null>(null);

  const scrollToCalibration = useCallback(() => {
    timingCalibrationRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);
  const applyReviewFeedback = useCallback(
    (payload: { import_notes?: ImportNoteSummary[]; qa_flags?: QAFlagSummary[] }) => {
      setQaFlags(payload.qa_flags ?? []);
    },
    [],
  );

  const selectedRow = events[selectedIndex] ?? null;
  const fps = session?.fps ?? 25;
  const isUploadSession = session?.session_mode === "upload_csv";
  const isPublicReadOnly = publicMode && !!session?.public_read_only;
  const isPublicEditable = !publicMode || !!session?.public_editable;
  const hasPendingRowChanges = !!(selectedRow && draftRow && !isSameEventRow(selectedRow, draftRow));
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
  const initialEventById = useMemo(() => new Map(initialEvents.map((row) => [row.id, row])), [initialEvents]);
  const isDraftPlayerIdValid = isValidEntityId(draftRow?.player_id, false, knownEntityIdSet);
  const isDraftReceiverIdValid = isValidEntityId(draftRow?.receiver_id, true, knownEntityIdSet);
  const canConfirmRowChanges = !!(
    isPublicEditable
    && selectedRow
    && draftRow
    && hasPendingRowChanges
    && isDraftPlayerIdValid
    && isDraftReceiverIdValid
  );
  const initialSelectedRow = selectedRow ? initialEventById.get(selectedRow.id) ?? null : null;
  const editableSelectedRow = draftRow ?? selectedRow;
  const canResetSelectedRow = !!(
    isPublicEditable
    && selectedRow
    && (
      initialSelectedRow
        ? editableSelectedRow && !isSameEventRow(editableSelectedRow, initialSelectedRow)
        : true
    )
  );
  const resetSelectedRowTitle = !selectedRow
    ? "No row selected."
    : initialSelectedRow
      ? "Reset this row to the original CSV values."
      : "This row is not in the original CSV. Reset will remove it.";
  const confirmBlockedReason = isPublicReadOnly
    ? "This public session is read-only."
    : !selectedRow || !draftRow
    ? "No row selected."
    : !hasPendingRowChanges
      ? "No edits to apply."
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
  const activeVideoHasTiming = hasConfirmedSegmentTiming(activeVideoSegment);
  const videoUrl = useMemo(() => {
    if (!activeVideoSegment?.url) return null;
    return buildArtifactUrl(activeVideoSegment.url);
  }, [activeVideoSegment]);
  const segmentOptionLabels = useMemo(() => {
    return videoSegments.map((segment, idx) => {
      const filename = segment.original_filename?.trim() || `Segment ${idx + 1}`;
      const endFrame = getSegmentEndFrame(segment);

      if (hasConfirmedSegmentTiming(segment)) {
        return `${filename}`;
      }

      if (endFrame === null) {
        return `${filename}`;
      }
      return `${filename}`;
    });
  }, [videoSegments]);
  const showVideoUploader = isPublicEditable && (isUploadSession || !!videoUrl);


  const playheadStartFrame = activeVideoSegment?.start_frame ?? 0;
  const currentFrame = useMemo(
    () => playheadStartFrame + currentSegmentFrame,
    [currentSegmentFrame, playheadStartFrame],
  );
  const selectedRowHasVideoCoverage = useMemo(() => {
    if (selectedAnchorFrame === null) {
      return true;
    }
    return videoSegments.some((segment) => {
      if (!segment.url || selectedAnchorFrame < segment.start_frame) {
        return false;
      }
      const endFrame = getSegmentEndFrame(segment);
      if (endFrame === null) {
        return true;
      }
      return selectedAnchorFrame <= endFrame;
    });
  }, [selectedAnchorFrame, videoSegments]);
  const selectedFrameDelta = selectedAnchorFrame === null ? null : selectedAnchorFrame - currentFrame;
  const saveStateLabel = saveState === "saving"
    ? "Saving changes"
    : saveState === "saved"
      ? "All changes saved"
      : saveState === "error"
        ? "Save failed"
        : "Ready";
  const sessionLabel = getSessionTitle(session);
  const originalCsvExportUrl = sessionId
    ? publicMode
      ? buildPublicSessionCsvExportUrl(sessionId, "initial", editToken)
      : buildSessionCsvExportUrl(sessionId, "initial")
    : "";
  const editedCsvExportUrl = sessionId
    ? publicMode
      ? buildPublicSessionCsvExportUrl(sessionId, "current", editToken)
      : buildSessionCsvExportUrl(sessionId, "current")
    : "";
  const undoTimelineAvailable = !!session?.event_undo_available;
  const canUndoTimeline = undoTimelineAvailable
    && isPublicEditable
    && !undoingTimeline
    && !resettingTimeline
    && !deletingCurrentSession
    && saveState !== "saving";
  const undoTimelineTitle = !undoTimelineAvailable
    ? "No saved edit to undo yet."
    : dirty || hasPendingRowChanges
      ? "Discard unsaved changes and restore the previous saved event state."
      : "Restore the event state from before the last saved edit.";
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
  const nextEventIndex = selectedIndex + 1 < events.length ? selectedIndex + 1 : null;
  const nextEventRow = nextEventIndex === null ? null : events[nextEventIndex] ?? null;
  const canAlignWithNextEvent = !!(
    isPublicEditable
    && selectedRow
    && nextEventRow
    && typeof nextEventRow.synced_frame_id === "number"
    && Number.isFinite(nextEventRow.synced_frame_id)
  );
  const alignWithNextEventTitle = isPublicReadOnly
    ? "This public session is read-only."
    : !selectedRow
    ? "Select a row first."
    : nextEventIndex === null
      ? "No next event to align with."
      : !nextEventRow || typeof nextEventRow.synced_frame_id !== "number" || !Number.isFinite(nextEventRow.synced_frame_id)
        ? "The next event needs a synced_frame_id."
        : "Align this row to the next event's synced frame.";
  const playbackPeriodId = useMemo(() => {
    const playbackIndex = findEventIndexByFrame(events, currentFrame);
    if (playbackIndex !== null) {
      return events[playbackIndex]?.period_id ?? draftRow?.period_id ?? selectedRow?.period_id ?? 1;
    }
    return draftRow?.period_id ?? selectedRow?.period_id ?? 1;
  }, [currentFrame, draftRow?.period_id, events, selectedRow?.period_id]);
  const playbackTimestampOffset = getTimestampOffsetForPeriod(playbackPeriodId, currentFrame);
  const getEventTimestampForFrame = useCallback((frame: number, periodId: number | null | undefined) => {
    if (activeVideoHasTiming && activeVideoSegment) {
      return getFrameTimestampFromSegmentTiming(frame, activeVideoSegment);
    }
    return frameToEventTimestamp(frame, fps, getTimestampOffsetForPeriod(periodId, frame));
  }, [activeVideoHasTiming, activeVideoSegment, fps, getTimestampOffsetForPeriod]);
  const currentTimestamp = useMemo(
    () => (
      activeVideoHasTiming && activeVideoSegment
        ? formatSeconds((activeVideoSegment.video_start_time_seconds ?? 0) + currentVideoTime)
        : frameToEventTimestamp(currentFrame, fps, playbackTimestampOffset)
    ),
    [activeVideoHasTiming, activeVideoSegment, currentFrame, currentVideoTime, fps, playbackTimestampOffset],
  );
  const parsedSegmentTimingPeriodStartFrame = useMemo(() => {
    const parsed = Number(segmentTimingPeriodStartFrame.trim());
    return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
  }, [segmentTimingPeriodStartFrame]);
  const parsedSegmentTimingVideoStartTime = useMemo(
    () => parseTimestampToSeconds(segmentTimingVideoStartTime),
    [segmentTimingVideoStartTime],
  );
  const pendingDerivedStartFrame = useMemo(() => {
    if (parsedSegmentTimingPeriodStartFrame === null || parsedSegmentTimingVideoStartTime === null) {
      return null;
    }
    return Math.max(
      0,
      Math.round(parsedSegmentTimingPeriodStartFrame + parsedSegmentTimingVideoStartTime * TIMING_MAPPING_FPS),
    );
  }, [parsedSegmentTimingPeriodStartFrame, parsedSegmentTimingVideoStartTime]);
  const hasReviewInsights = qaFlags.length > 0 || !!saveMessage;

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
          setInitialEvents([]);
          applyReviewFeedback({});
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
        setInitialEvents([]);
        applyReviewFeedback({});
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
  }, [applyReviewFeedback, matchId, routeSessionId]);

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
    setCurrentVideoTime(0);
  }, [selectedVideoIndex]);

  useEffect(() => {
    if (!activeVideoSegment) {
      setSegmentTimingPeriodStartFrame("");
      setSegmentTimingVideoStartTime("");
      return;
    }

    setSegmentTimingPeriodStartFrame(
      typeof activeVideoSegment.period_start_frame === "number"
        ? String(activeVideoSegment.period_start_frame)
        : "",
    );
    setSegmentTimingVideoStartTime(
      typeof activeVideoSegment.video_start_time_seconds === "number"
        ? formatSeconds(activeVideoSegment.video_start_time_seconds)
        : "",
    );
  }, [activeVideoSegment]);

  const syncDisplayedSegmentFrame = useCallback(
    (videoEl: HTMLVideoElement, mediaTime?: number) => {
      const nextMediaTime = mediaTime ?? videoEl.currentTime;
      const nextFrame = getSegmentFrameFromTime(nextMediaTime, activeVideoFps);
      setCurrentSegmentFrame(nextFrame);
      setCurrentVideoTime(Math.max(0, nextMediaTime));
    },
    [activeVideoFps],
  );

  const holdVideoAtEnd = useCallback(
    (videoEl: HTMLVideoElement) => {
      videoEl.pause();
      const duration = videoEl.duration;
      if (!Number.isFinite(duration) || duration <= 0) {
        syncDisplayedSegmentFrame(videoEl);
        return;
      }

      const finalSegmentFrame = Math.max(0, Math.round(duration * activeVideoFps) - 1);
      const finalTime = getSeekTimeForSegmentFrame(finalSegmentFrame, activeVideoFps, duration);
      if (Number.isFinite(finalTime) && Math.abs(videoEl.currentTime - finalTime) > 0.001) {
        videoEl.currentTime = finalTime;
      }
      syncDisplayedSegmentFrame(videoEl, finalTime);
    },
    [activeVideoFps, syncDisplayedSegmentFrame],
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
      const s = publicMode
        ? await fetchPublicSession(sessionId, editToken)
        : await fetchSession(sessionId);
      setSession(s);
      if (s.status === "ready") {
        const [eventData, initialEventData] = await Promise.all([
          publicMode ? fetchPublicEvents(sessionId, "current", editToken) : fetchEvents(sessionId),
          publicMode
            ? fetchPublicEvents(sessionId, "initial", editToken).catch(() => null)
            : fetchEvents(sessionId, "initial").catch(() => null),
        ]);
        const normalized = normalizeMissingRowsByFrame(eventData.events, s.fps ?? 25);
        const canPersistRecoveredRows = !publicMode || !!s.public_editable;
        setEvents(normalized.rows);
        setInitialEvents(initialEventData?.events?.length ? initialEventData.events : eventData.events);
        applyReviewFeedback(eventData);
        setInitialLoaded(true);
        setDirty(canPersistRecoveredRows && normalized.changed);
        if (normalized.changed && canPersistRecoveredRows) {
          setSaveState("saved");
          setSaveMessage("Recovered missing-row timestamps from frame_id");
        } else if (publicMode && s.public_read_only) {
          setSaveState("idle");
          setSaveMessage("");
        }
        try {
          const fetchedTypes = publicMode ? await fetchPublicSpadlTypes() : await fetchSpadlTypes();
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
  }, [editToken, publicMode, sessionId]);

  useEffect(() => {
    if (!sessionId || !session || session.status !== "processing") {
      return;
    }

    const timer = window.setInterval(async () => {
      const updated = publicMode ? await fetchPublicSession(sessionId, editToken) : await fetchSession(sessionId);
      setSession(updated);
      if (updated.status !== "processing") {
        window.clearInterval(timer);
        if (updated.status === "ready") {
          const [eventData, initialEventData] = await Promise.all([
            publicMode ? fetchPublicEvents(sessionId, "current", editToken) : fetchEvents(sessionId),
            publicMode
              ? fetchPublicEvents(sessionId, "initial", editToken).catch(() => null)
              : fetchEvents(sessionId, "initial").catch(() => null),
          ]);
          const normalized = normalizeMissingRowsByFrame(eventData.events, updated.fps ?? 25);
          const canPersistRecoveredRows = !publicMode || !!updated.public_editable;
          setEvents(normalized.rows);
          setInitialEvents(initialEventData?.events?.length ? initialEventData.events : eventData.events);
          applyReviewFeedback(eventData);
          setInitialLoaded(true);
          setDirty(canPersistRecoveredRows && normalized.changed);
          if (normalized.changed && canPersistRecoveredRows) {
            setSaveState("saved");
            setSaveMessage("Recovered missing-row timestamps from frame_id");
          }
        }
      }
    }, 2000);

    return () => window.clearInterval(timer);
  }, [applyReviewFeedback, editToken, publicMode, session, sessionId]);

  useEffect(() => {
    if (!initialLoaded || !dirty || !sessionId || isPublicReadOnly) {
      return;
    }

    const timer = window.setTimeout(async () => {
      setSaveState("saving");
      try {
        const result = publicMode
          ? await savePublicEvents(sessionId, events, editToken)
          : await saveEvents(sessionId, events);
        applyReviewFeedback(result);
        setSession((prev) => (
          prev ? { ...prev, event_undo_available: result.event_undo_available } : prev
        ));
        setSaveState("saved");
        setSaveMessage(`Saved ${result.saved_count} rows`);
        setDirty(false);
      } catch (err) {
        setSaveState("error");
        setSaveMessage((err as Error).message);
      }
    }, 700);

    return () => window.clearTimeout(timer);
  }, [applyReviewFeedback, dirty, editToken, events, initialLoaded, isPublicReadOnly, publicMode, sessionId]);

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
      // If the current selection is already at the correct frame, don't jump to another event at the same frame.
      const prevRow = events[prev];
      if (prevRow && getAnchorFrame(prevRow) === currentFrame) {
        return prev;
      }
      return prev === targetIndex ? prev : targetIndex;
    });
  }, [currentFrame, events, hasPendingRowChanges]);

  const alignWithNextEvent = useCallback(() => {
    if (!isPublicEditable) {
      return;
    }
    if (!selectedRow || nextEventIndex === null || !nextEventRow) {
      return;
    }

    const targetFrame = nextEventRow.synced_frame_id;
    if (typeof targetFrame !== "number" || !Number.isFinite(targetFrame)) {
      return;
    }
    const sourceRow = draftRow ?? selectedRow;
    if (!isValidEntityId(sourceRow.player_id, false, knownEntityIdSet)) {
      setSaveState("error");
      setSaveMessage("Select a valid player_id before aligning.");
      return;
    }
    if (!isValidEntityId(sourceRow.receiver_id, true, knownEntityIdSet)) {
      setSaveState("error");
      setSaveMessage("Select a valid receiver_id or leave it blank before aligning.");
      return;
    }

    const targetTimestamp =
      nextEventRow.synced_ts
      ?? getEventTimestampForFrame(targetFrame, nextEventRow.period_id);

    const nextEvents = [...events];
    const currentRow = nextEvents[selectedIndex];
    if (!currentRow) {
      return;
    }

    const alignedRow: EventRow = {
      ...sourceRow,
      synced_frame_id: targetFrame,
      synced_ts: targetTimestamp,
      error_type: "synced_ts",
    };
    if (isSameEventRow(currentRow, alignedRow)) {
      setSaveState("idle");
      setSaveMessage("Current row is already aligned with the next event.");
      return;
    }

    nextEvents[selectedIndex] = alignedRow;
    setEvents(nextEvents);
    setDirty(true);
    setSaveState("saved");
    setSaveMessage(
      `Aligned row #${selectedIndex + 1} with next event (#${nextEventIndex + 1})`,
    );
  }, [
    draftRow,
    events,
    getEventTimestampForFrame,
    isPublicEditable,
    knownEntityIdSet,
    nextEventIndex,
    nextEventRow,
    selectedIndex,
    selectedRow,
  ]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }
      if (isInteractiveTarget(event.target)) {
        return;
      }
      if (event.key === "Enter" && canAlignWithNextEvent) {
        event.preventDefault();
        alignWithNextEvent();
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
  }, [activeVideoFps, alignWithNextEvent, canAlignWithNextEvent, seekBySegmentFrames]);

  const updateDraftRow = (patch: Partial<EventRow>) => {
    if (!isPublicEditable) {
      return;
    }
    setDraftRow((prev) => {
      if (!prev) return prev;
      const merged = { ...prev, ...patch };

      // Respect explicit user selection in error_type dropdown.
      if ("error_type" in patch) {
        return merged;
      }
      if (prev.error_type === "missing" || prev.id.toString().startsWith("missing_")) {
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
    if (!isPublicEditable) return;
    if (!selectedRow || !draftRow) return;

    if (isSameEventRow(selectedRow, draftRow)) {
      setSaveState("idle");
      setSaveMessage("No row changes to confirm");
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

  const resetSelectedRow = () => {
    if (!isPublicEditable) {
      return;
    }
    if (!selectedRow) {
      return;
    }

    if (initialSelectedRow) {
      if (editableSelectedRow && isSameEventRow(editableSelectedRow, initialSelectedRow)) {
        setSaveState("idle");
        setSaveMessage("This row is already back to its original CSV values.");
        return;
      }

      if (hasPendingRowChanges && isSameEventRow(selectedRow, initialSelectedRow)) {
        setDraftRow({ ...initialSelectedRow });
        setSaveState("idle");
        setSaveMessage(`Discarded draft changes for row #${selectedIndex + 1}`);
        return;
      }

      const confirmed = window.confirm(
        hasPendingRowChanges
          ? "Discard current edits and reset this row to the original CSV values?"
          : "Reset this row to the original CSV values?",
      );
      if (!confirmed) {
        return;
      }

      const nextEvents = [...events];
      nextEvents[selectedIndex] = { ...initialSelectedRow };
      setEvents(nextEvents);
      setDirty(true);
      setSaveState("saved");
      setSaveMessage(`Reset row #${selectedIndex + 1} to the original CSV values`);
      return;
    }

    const confirmed = window.confirm(
      hasPendingRowChanges
        ? "Discard current edits and remove this row? It does not exist in the original CSV."
        : "Remove this row? It does not exist in the original CSV.",
    );
    if (!confirmed) {
      return;
    }

    const nextEvents = [...events];
    nextEvents.splice(selectedIndex, 1);
    const nextSelectedIndex = nextEvents.length === 0 ? 0 : Math.min(selectedIndex, nextEvents.length - 1);
    setEvents(nextEvents);
    setSelectedIndex(nextSelectedIndex);
    setDirty(true);
    setSaveState("saved");
    setSaveMessage(`Removed row #${selectedIndex + 1} because it is not in the original CSV`);
  };

  const applyCurrentTo = (field: "synced" | "receive") => {
    if (!isPublicEditable) return;
    if (!draftRow) return;
    const frame = currentFrame;
    const ts = getEventTimestampForFrame(frame, draftRow.period_id);
    if (field === "synced") {
      updateDraftRow({ synced_ts: ts, synced_frame_id: frame });
    } else {
      updateDraftRow({ receive_ts: ts, receive_frame_id: frame });
    }
  };

  const updateFrameAndTimestamp = (field: "synced" | "receive", rawValue: string) => {
    if (!isPublicEditable) return;
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
    const ts = getEventTimestampForFrame(frame, targetPeriodId);
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
    if (!isPublicEditable) {
      return;
    }
    if (!sessionId) {
      return;
    }
    if (!segmentUploadFile) {
      setSaveState("error");
      setSaveMessage("Select a video file first.");
      return;
    }
    setUploadingSegment(true);
    setSaveState("saving");
    setSaveMessage("");
    try {
      const updated = publicMode
        ? await addPublicSessionVideo({
          sessionId,
          videoFile: segmentUploadFile,
          editToken,
        })
        : await addSessionVideo({
          sessionId,
          videoFile: segmentUploadFile,
        });
      setSession(updated);
      let nextIndex = 0;
      for (let index = updated.video_segments.length - 1; index >= 0; index -= 1) {
        const segment = updated.video_segments[index];
        if (
          (segment.original_filename ?? "").trim() === segmentUploadFile.name.trim()
        ) {
          nextIndex = index;
          break;
        }
      }
      setSelectedVideoIndex(nextIndex);
      setSegmentUploadFile(null);
      setSaveState("saved");
      setSaveMessage("Video segment uploaded. Apply timing when you are ready.");
    } catch (err) {
      setSaveState("error");
      setSaveMessage((err as Error).message);
    } finally {
      setUploadingSegment(false);
    }
  };

  const handleApplySegmentTiming = async () => {
    if (!isPublicEditable) {
      return;
    }
    if (!sessionId || !activeVideoSegment) {
      return;
    }

    const parsedPeriodStartFrame = Number(segmentTimingPeriodStartFrame.trim());
    if (!Number.isFinite(parsedPeriodStartFrame) || parsedPeriodStartFrame < 0) {
      setSaveState("error");
      setSaveMessage("Period start frame must be a non-negative number.");
      return;
    }

    const parsedVideoStartTime = parseTimestampToSeconds(segmentTimingVideoStartTime);
    if (parsedVideoStartTime === null || parsedVideoStartTime < 0) {
      setSaveState("error");
      setSaveMessage("Video start time must be seconds, MM:SS(.ff), or HH:MM:SS(.ff).");
      return;
    }

    setSavingSegmentTiming(true);
    setSaveState("saving");
    setSaveMessage("");
    try {
      const updated = publicMode
        ? await updatePublicSessionVideoTiming({
          sessionId,
          segmentId: activeVideoSegment.id,
          periodStartFrame: Math.round(parsedPeriodStartFrame),
          videoStartTimeSeconds: parsedVideoStartTime,
          editToken,
        })
        : await updateSessionVideoTiming({
          sessionId,
          segmentId: activeVideoSegment.id,
          periodStartFrame: Math.round(parsedPeriodStartFrame),
          videoStartTimeSeconds: parsedVideoStartTime,
        });
      setSession(updated);
      const nextSegments = updated.video_segments?.length ? updated.video_segments : buildLegacyVideoSegments(updated);
      const nextIndex = nextSegments.findIndex((segment) => segment.id === activeVideoSegment.id);
      if (nextIndex >= 0) {
        setSelectedVideoIndex(nextIndex);
      }
      setSaveState("saved");
      setSaveMessage("Video timing applied");
    } catch (err) {
      setSaveState("error");
      setSaveMessage((err as Error).message);
    } finally {
      setSavingSegmentTiming(false);
    }
  };

  const beginTitleEdit = () => {
    if (publicMode) {
      return;
    }
    if (!session) {
      return;
    }
    setEditingTitleValue(getSessionTitle(session));
    setEditingTitle(true);
    setSessionActionError(null);
  };

  const cancelTitleEdit = () => {
    setEditingTitle(false);
    setEditingTitleValue("");
    setSessionActionError(null);
  };

  const saveTitleEdit = async () => {
    if (publicMode) {
      return;
    }
    if (!sessionId || !session) {
      return;
    }

    setSavingTitle(true);
    setSessionActionError(null);
    try {
      const updated = await updateSessionMetadata(sessionId, { title: editingTitleValue });
      setSession(updated);
      setEditingTitle(false);
      setEditingTitleValue("");
    } catch (err) {
      setSessionActionError((err as Error).message);
    } finally {
      setSavingTitle(false);
    }
  };

  const handleDeleteCurrentSession = async () => {
    if (publicMode) {
      return;
    }
    if (!sessionId || !session) {
      return;
    }

    const confirmed = window.confirm(
      `Delete session "${sessionLabel}" (${session.session_id})?\n\nThis will permanently remove the entire session.${dirty ? "\n\nUnsaved editor changes will be lost." : ""}`,
    );
    if (!confirmed) {
      return;
    }

    setDeletingCurrentSession(true);
    setSessionActionError(null);
    try {
      await deleteSession(sessionId);
      navigate("/", { replace: true });
    } catch (err) {
      setSessionActionError((err as Error).message);
    } finally {
      setDeletingCurrentSession(false);
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
    const row = events[index];
    if (!row) return;

    const targetFrame = getAnchorFrame(row);

    if (targetFrame === null) {
      return;
    }
    seekToAbsoluteFrame(targetFrame);
  };

  const addMissingRow = () => {
    if (!isPublicEditable) {
      return;
    }
    const basePeriod = selectedRow?.period_id ?? 1;
    const nextRow = selectedIndex >= 0 && selectedIndex + 1 < events.length ? events[selectedIndex + 1] : null;
    const defaultSyncedFrame = currentFrame;
    const defaultSyncedTs = getEventTimestampForFrame(defaultSyncedFrame, basePeriod);

    const defaultPlayerId = (
      nextRow?.player_id?.trim()
      || selectedRow?.receiver_id?.trim()
      || selectedRow?.player_id
      || ""
    ).trim();

    const newRow: EventRow = {
      id: `missing_${Date.now()}`,
      period_id: basePeriod,
      spadl_type: "control",
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
    if (!isPublicEditable) {
      return;
    }
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
    setDirty(true);
  };

  const handleUndoTimeline = async () => {
    if (!isPublicEditable) return;
    if (!sessionId || !canUndoTimeline) return;

    const confirmed = window.confirm(
      dirty || hasPendingRowChanges
        ? "Undo the last saved edit?\n\nThis will discard any unsaved changes currently on screen."
        : "Undo the last saved edit?",
    );
    if (!confirmed) {
      return;
    }

    setUndoingTimeline(true);
    setSaveState("saving");
    try {
      const result = publicMode
        ? await undoPublicEvents(sessionId, editToken)
        : await undoEvents(sessionId);
      applyReviewFeedback(result);
      setSaveMessage(`Undid last saved edit (${result.restored_count} rows)`);
      const latest = publicMode ? await fetchPublicSession(sessionId, editToken) : await fetchSession(sessionId);
      setSession(latest);
      const [eventData, initialEventData] = await Promise.all([
        publicMode ? fetchPublicEvents(sessionId, "current", editToken) : fetchEvents(sessionId),
        publicMode
          ? fetchPublicEvents(sessionId, "initial", editToken).catch(() => null)
          : fetchEvents(sessionId, "initial").catch(() => null),
      ]);
      setEvents(eventData.events);
      setInitialEvents(initialEventData?.events?.length ? initialEventData.events : eventData.events);
      applyReviewFeedback(eventData);
      setSelectedIndex((prev) => {
        if (eventData.events.length === 0) return 0;
        return Math.min(prev, eventData.events.length - 1);
      });
      setDirty(false);
      setSaveState("saved");
    } catch (err) {
      setSaveState("error");
      setSaveMessage((err as Error).message);
    } finally {
      setUndoingTimeline(false);
    }
  };

  const handleResetTimeline = async () => {
    if (!isPublicEditable) return;
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
      const result = publicMode
        ? await resetPublicEvents(sessionId, editToken)
        : await resetEvents(sessionId);
      applyReviewFeedback(result);
      setSaveState("saved");
      setSaveMessage(
        result.source === "snapshot"
          ? `Restored original CSV (${result.restored_count} rows)`
          : `Restored original events (${result.restored_count} rows)`,
      );
      const latest = publicMode ? await fetchPublicSession(sessionId, editToken) : await fetchSession(sessionId);
      setSession(latest);
      const [eventData, initialEventData] = await Promise.all([
        publicMode ? fetchPublicEvents(sessionId, "current", editToken) : fetchEvents(sessionId),
        publicMode
          ? fetchPublicEvents(sessionId, "initial", editToken).catch(() => null)
          : fetchEvents(sessionId, "initial").catch(() => null),
      ]);
      setEvents(eventData.events);
      setInitialEvents(initialEventData?.events?.length ? initialEventData.events : eventData.events);
      applyReviewFeedback(eventData);
      setSelectedIndex((prev) => {
        if (eventData.events.length === 0) return 0;
        return Math.min(prev, eventData.events.length - 1);
      });
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
          <Link className="button-link" to={publicMode ? "/" : "/admin"}>Back to Sessions</Link>
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
          <Link className="button-link" to={publicMode ? "/" : "/admin"}>Back to Sessions</Link>
        </section>
      </div>
    );
  }

  return (
    <div className="page page-annotate">
      <header className="annot-header">
        <div className="annot-title-group">
          {editingTitle ? (
            <div className="annot-title-editor">
              <input
                value={editingTitleValue}
                onChange={(event) => setEditingTitleValue(event.target.value)}
                placeholder={sessionLabel}
                disabled={savingTitle || deletingCurrentSession}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void saveTitleEdit();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    cancelTitleEdit();
                  }
                }}
              />
              <div className="session-title-actions">
                <button
                  type="button"
                  onClick={() => void saveTitleEdit()}
                  disabled={savingTitle || deletingCurrentSession}
                >
                  {savingTitle ? "Saving..." : "Save Title"}
                </button>
                <button
                  type="button"
                  onClick={cancelTitleEdit}
                  disabled={savingTitle || deletingCurrentSession}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="annot-title-display">
              <h1>{sessionLabel}</h1>
              {!publicMode && (
                <button
                  type="button"
                  className="session-title-edit-button"
                  onClick={beginTitleEdit}
                  disabled={savingTitle || deletingCurrentSession}
                >
                  Edit Title
                </button>
              )}
            </div>
          )}
          <div className="annot-meta">
            <span className="meta-pill">{events.length} rows</span>
            <span className="meta-pill">{isUploadSession ? "Uploaded CSV" : "Public Dataset"}</span>
            {isUploadSession && !session.persist && <span className="meta-pill">Temporary</span>}
            {saveState !== "idle" && (
              <span className={`status-chip ${saveState}`} aria-live="polite">
                {saveState === "saving" && <span className="spinner" aria-hidden="true" />}
                {saveStateLabel}
              </span>
            )}
            {publicMode && isPublicReadOnly && <span className="meta-pill">Locked</span>}
            {publicMode && isPublicEditable && <span className="meta-pill">Editable</span>}
          </div>
          {publicMode && isPublicReadOnly && (
            <p className="annot-session-feedback">
              This shared session is locked. You can inspect it and download CSV files.
            </p>
          )}
          {sessionActionError ? <p className="annot-session-feedback">{sessionActionError}</p> : null}
        </div>
        <div className="row annot-actions">
          <div className="annot-action-group annot-action-group-downloads">
            <a className="button-link" href={originalCsvExportUrl}>
              Download Original CSV
            </a>
            <a className="button-link primary" href={editedCsvExportUrl}>
              Download Edited CSV
            </a>
          </div>
          <div className="annot-action-group annot-action-group-manage">
            <Link className="button-link" to={publicMode ? "/" : "/admin"}>Back to Sessions</Link>
            <button
              type="button"
              onClick={() => void handleUndoTimeline()}
              disabled={!canUndoTimeline}
              title={undoTimelineTitle}
            >
              {undoingTimeline && <span className="spinner" aria-hidden="true" />}
              {undoingTimeline ? "Undoing..." : "Undo Last Edit"}
            </button>
            <button
              className="danger"
              onClick={() => void handleResetTimeline()}
              disabled={!isPublicEditable || resettingTimeline || undoingTimeline || deletingCurrentSession}
            >
              {resettingTimeline && <span className="spinner" aria-hidden="true" />}
              {resettingTimeline ? "Resetting..." : "Reset to Original"}
            </button>
            {!publicMode && (
              <button
                type="button"
                className="danger"
                onClick={() => void handleDeleteCurrentSession()}
                disabled={deletingCurrentSession || undoingTimeline || savingTitle || saveState === "saving"}
              >
                {deletingCurrentSession && <span className="spinner" aria-hidden="true" />}
                {deletingCurrentSession ? "Deleting..." : "Delete Session"}
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="annot-layout">
        <div className="video-side-stack">
          <section className="video-panel card workspace-card">
          <div className="panel-heading">
            <div className="panel-title-group">
              <h2>Video</h2>
              {!selectedRowHasVideoCoverage && selectedAnchorFrame !== null && (
                <span className="coverage-badge" title="The selected event frame is not covered by any uploaded video segment.">
                  ⚠️ No video coverage for frame {selectedAnchorFrame}
                </span>
              )}
              {activeVideoSegment && !activeVideoHasTiming && (
                <button
                  type="button"
                  className="calibration-badge pulsate"
                  onClick={scrollToCalibration}
                  title="Click to scroll to timing calibration settings."
                >
                  ⚠️ Timing Calibration Required
                </button>
              )}
            </div>
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
                    <div className="frame-readout-label">Period</div>
                    <div className="frame-readout-main">{playbackPeriodId}</div>
                  </div>
                  <div>
                    <div className="frame-readout-label">Timestamp</div>
                    <div className="frame-readout-main">{currentTimestamp}</div>
                  </div>
                  <div>
                    <div className="frame-readout-label">Frame</div>
                    <div className="frame-readout-main frame-readout-frame">{currentFrame}</div>
                  </div>
                </div>
              </div>
              <div className="video-viewport">
                <video
                  ref={videoRef}
                  src={videoUrl}
                  controls
                  onMouseDown={(e) => {
                    // Prevent video element from keeping focus and using browser default hotkeys
                    const el = e.currentTarget;
                    setTimeout(() => el.blur(), 0);
                  }}
                  onTimeUpdate={(e) => {
                    syncDisplayedSegmentFrame(e.currentTarget);
                  }}
                  onEnded={(e) => {
                    holdVideoAtEnd(e.currentTarget);
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
                {activeVideoSegment && !activeVideoHasTiming && (
                  <div className="video-block-overlay" onClick={scrollToCalibration}>
                    <div className="overlay-content">
                      <span className="overlay-icon">⏱️</span>
                      <h3>Timing Calibration Required</h3>
                      <p>Please calibrate the segment timing below to sync with events.</p>
                      <button type="button" className="secondary">Go to Calibration</button>
                    </div>
                  </div>
                )}
              </div>
              <div className="video-timing-panel" ref={timingCalibrationRef}>
                <div className="video-timing-heading">
                  <div>
                    <h3>Timing Calibration</h3>
                    <p className="muted compact-note">
                      Derive the segment start frame from `period start frame + video start time x 25`.
                    </p>
                  </div>
                  <div className="video-timing-status">
                    <span className={`video-timing-chip${activeVideoHasTiming ? " is-ready" : " is-pending"}`}>
                      {activeVideoHasTiming ? "Timing Ready" : "Needs Timing"}
                    </span>
                    <span className="video-timing-chip">25 fps mapping</span>
                  </div>
                </div>
                <div className="video-timing-layout">
                  <div className="video-timing-fields">
                    <label>
                      Period start frame
                      <input
                        type="number"
                        min={0}
                        value={segmentTimingPeriodStartFrame}
                        onChange={(event) => setSegmentTimingPeriodStartFrame(event.target.value)}
                        placeholder="e.g. 10000"
                        disabled={!isPublicEditable || savingSegmentTiming}
                      />
                    </label>
                    <label>
                      Video start time
                      <input
                        type="text"
                        value={segmentTimingVideoStartTime}
                        onChange={(event) => setSegmentTimingVideoStartTime(event.target.value)}
                        placeholder="e.g. 00:10 or 10"
                        disabled={!isPublicEditable || savingSegmentTiming}
                      />
                    </label>
                    <div className="video-timing-preview">
                      <span className="video-timing-preview-label">Derived start frame</span>
                      <strong>{pendingDerivedStartFrame?.toLocaleString("en-US") ?? "-"}</strong>
                    </div>
                  </div>
                  <div className="video-timing-actions">
                    <button
                      type="button"
                      className="primary"
                      onClick={() => void handleApplySegmentTiming()}
                      disabled={!isPublicEditable || savingSegmentTiming || !activeVideoSegment}
                    >
                      {savingSegmentTiming ? "Applying..." : "Apply Timing"}
                    </button>
                  </div>
                </div>
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
          ) : isUploadSession ? (
            <div className="video-empty-state">
              <span className="panel-kicker">{isPublicReadOnly ? "No Video" : "Video Pending"}</span>
              <h3>{isPublicReadOnly ? "No video available for this public baseline" : "Add the first video segment"}</h3>
              <p className="muted">This session was created from CSV only, so the video panel is still empty.</p>
              {!isPublicReadOnly && (
                <p className="muted compact-note">Upload a segment below to enable frame scrubbing, timing calibration, and video-assisted review.</p>
              )}
            </div>
          ) : (
            <p className="muted">No video available.</p>
          )}
        </section>

        {showVideoUploader && (
          <section className="video-uploader-panel card workspace-card">
            <div className="panel-heading">
              <div className="panel-title-group">
                <h2>Add or Replace Video</h2>
                <span className="meta-pill">{videoSegments.length} segments</span>
              </div>
            </div>
            <div className="video-segment-editor">
              <div className="upload-context">
                <p className="muted compact-note">Select a video file to replace or add as a new segment.</p>
              </div>
              <div className="upload-controls-group">
                <label className={`video-segment-upload${uploadingSegment ? " is-disabled" : ""}`}>
                  <span className="video-segment-upload-control">
                    <span className={`video-segment-upload-button${segmentUploadFile ? " has-file" : ""}`}>
                      {segmentUploadFile ? `📄 ${segmentUploadFile.name}` : "Choose Video File"}
                    </span>
                    <input
                      key={segmentUploadFile?.name ?? "video-segment-empty"}
                  type="file"
                  accept=".mp4,.mov,.m4v,.webm,video/*"
                  onChange={(event) => setSegmentUploadFile(event.target.files?.[0] ?? null)}
                  disabled={!isPublicEditable || uploadingSegment}
                />
                  </span>
                </label>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void handleAddVideoSegment()}
                  disabled={!isPublicEditable || uploadingSegment || !segmentUploadFile}
                >
                  {uploadingSegment ? "Uploading..." : "Upload"}
                </button>
              </div>
            </div>
          </section>
        )}
      </div>

        <div className="editor-stack">
          <section className="timeline-panel card workspace-card">
            <div className="section-header">
              <h2>Timeline</h2>
              <div className="section-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={alignWithNextEvent}
                  disabled={!canAlignWithNextEvent}
                  title={alignWithNextEventTitle}
                >
                  Align with Next Event
                </button>
                <button onClick={addMissingRow} disabled={!isPublicEditable}>Add Missing Event</button>
                <button className="danger" disabled={!isPublicEditable || !selectedRow} onClick={removeSelectedRow}>Delete Row</button>
              </div>
            </div>
            <div className="timeline-hud">
              <div className="timeline-hud-item">
                <div className="timeline-hud-label">Frame</div>
                <div className="timeline-hud-value">{currentFrame}</div>
              </div>
              <div className="timeline-hud-item">
                <div className="timeline-hud-label">Selected Frame</div>
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
              currentFrame={currentFrame}
              selectedRowHasVideoCoverage={selectedRowHasVideoCoverage}
              onSelect={handleSelectEvent}
            />
          </section>

          <section className="inspector-panel card workspace-card">
            <div className="section-header">
              <h2>{selectedRow ? `Row #${selectedIndex + 1}` : "Inspector"}</h2>
              {selectedRow && (
                <div className="section-actions">
                  <button
                    type="button"
                    onClick={resetSelectedRow}
                    disabled={!canResetSelectedRow}
                    title={canResetSelectedRow ? resetSelectedRowTitle : "No row changes to reset."}
                  >
                    Reset Event
                  </button>
                  <button
                    className="primary"
                    onClick={confirmRowChanges}
                    disabled={!canConfirmRowChanges}
                    title={canConfirmRowChanges ? "Apply changes to this row" : confirmBlockedReason}
                  >
                    Apply Changes
                  </button>
                </div>
              )}
            </div>

            {selectedRow ? (
              <>
                <div className="inspector-status">
                  <span className="muted">{hasPendingRowChanges ? "Unsaved changes" : "No changes yet."}</span>
                  {!canConfirmRowChanges && hasPendingRowChanges && (
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
                      disabled={!isPublicEditable}
                    />
                  </label>

                  <label>
                    spadl_type
                    <select
                      value={draftRow?.spadl_type ?? selectedRow.spadl_type}
                      onChange={(e) => updateDraftRow({ spadl_type: e.target.value })}
                      disabled={!isPublicEditable}
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
                      disabled={!isPublicEditable}
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
                        disabled={!isPublicEditable}
                      />
                      <button type="button" onClick={() => applyCurrentTo("synced")} disabled={!isPublicEditable}>Use Current</button>
                    </div>
                    <p className="muted id-format-help">synced_ts preview: {draftRow?.synced_ts ?? selectedRow.synced_ts ?? "-"}</p>
                  </label>

                  <label>
                    receiver_id
                    <select
                      className={!isDraftReceiverIdValid ? "input-error" : ""}
                      value={draftReceiverId}
                      onChange={(e) => updateDraftRow({ receiver_id: e.target.value })}
                      disabled={!isPublicEditable}
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
                        disabled={!isPublicEditable}
                      />
                      <button type="button" onClick={() => applyCurrentTo("receive")} disabled={!isPublicEditable}>Use Current</button>
                    </div>
                    <p className="muted id-format-help">receive_ts preview: {draftRow?.receive_ts ?? selectedRow.receive_ts ?? "-"}</p>
                  </label>

                  <label>
                    outcome
                    <select
                      value={(draftRow?.outcome ?? selectedRow.outcome) ? "true" : "false"}
                      onChange={(e) => updateDraftRow({ outcome: e.target.value === "true" })}
                      disabled={!isPublicEditable}
                    >
                      <option value="true">TRUE</option>
                      <option value="false">FALSE</option>
                    </select>
                  </label>

                  <label>
                    error_type
                    <select
                      value={draftRow ? (draftRow.error_type ?? "") : (selectedRow.error_type ?? "")}
                      onChange={(e) => updateDraftRow({ error_type: (e.target.value || null) as ErrorType | null })}
                      disabled={!isPublicEditable}
                    >
                      {ERROR_TYPES.map((value) => (
                        <option key={value || "empty"} value={value}>
                          {value || "(none)"}
                        </option>
                      ))}
                    </select>
                    {hasPendingRowChanges && (
                      <p className="muted id-format-help">Auto-picked from the changed field. You can keep (none) when no error label is needed.</p>
                    )}
                  </label>
                </div>

                <label>
                  note
                  <textarea
                    value={draftRow?.note ?? selectedRow.note}
                    onChange={(e) => updateDraftRow({ note: e.target.value })}
                    rows={3}
                    disabled={!isPublicEditable}
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

          {hasReviewInsights && (
            <section className="review-panel card workspace-card">
              {qaFlags.length > 0 && (
                <div className="review-block">
                  <div className="review-block-header">
                    <div>
                      <h3>QA Flags</h3>
                      <p className="muted">Focused checks that may need manual review.</p>
                    </div>
                  </div>
                  <div className="review-summary-list">
                    {qaFlags.map((flag) => (
                      <article key={flag.code} className="review-summary-card review-summary-card-qa">
                        <div className="review-summary-head">
                          <h4>{flag.title}</h4>
                          <span className="review-summary-count">{flag.count}</span>
                        </div>
                        <p className="muted review-summary-copy">{flag.summary}</p>
                        {flag.sample_frame_ids.length > 0 && (
                          <div className="review-summary-actions">
                            {flag.sample_frame_ids.map((frameId) => (
                              <button
                                key={`${flag.code}-${frameId}`}
                                type="button"
                                className="review-link-chip"
                                onClick={() => jumpToWarningFrame(frameId)}
                              >
                                Frame {frameId}
                              </button>
                            ))}
                            {flag.count > flag.sample_frame_ids.length && (
                              <span className="review-summary-more muted">
                                +{flag.count - flag.sample_frame_ids.length} more
                              </span>
                            )}
                          </div>
                        )}
                      </article>
                    ))}
                  </div>
                </div>
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
