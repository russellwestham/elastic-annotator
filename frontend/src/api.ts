import type {
  DefaultDatasetRoot,
  EventListResponse,
  EventRow,
  MatchSummary,
  SessionStatus,
} from "./types";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }

  return (await response.json()) as T;
}

export async function fetchMatches(datasetRoot?: string): Promise<MatchSummary[]> {
  const qs = datasetRoot ? `?dataset_root=${encodeURIComponent(datasetRoot)}` : "";
  return request<MatchSummary[]>(`/api/matches${qs}`);
}

export async function fetchSpadlTypes(): Promise<string[]> {
  return request<string[]>("/api/meta/spadl-types");
}

export async function fetchDefaultDatasetRoot(): Promise<DefaultDatasetRoot> {
  return request<DefaultDatasetRoot>("/api/meta/default-dataset-root");
}

export async function createSession(payload: {
  annotator_name: string;
  match_id: string;
  dataset_root?: string;
  generate_video: boolean;
}): Promise<SessionStatus> {
  return request<SessionStatus>("/api/sessions", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function fetchSession(sessionId: string): Promise<SessionStatus> {
  return request<SessionStatus>(`/api/sessions/${sessionId}`);
}

export async function fetchSessions(params?: {
  limit?: number;
  status?: "processing" | "ready" | "error";
  matchId?: string;
  sessionMode?: "legacy_elastic" | "upload_csv";
  includeEphemeral?: boolean;
}): Promise<SessionStatus[]> {
  const qs = new URLSearchParams();
  if (params?.limit != null) {
    qs.set("limit", String(params.limit));
  }
  if (params?.status) {
    qs.set("status", params.status);
  }
  if (params?.matchId) {
    qs.set("match_id", params.matchId);
  }
  if (params?.sessionMode) {
    qs.set("session_mode", params.sessionMode);
  }
  if (params?.includeEphemeral) {
    qs.set("include_ephemeral", "true");
  }
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return request<SessionStatus[]>(`/api/sessions${suffix}`);
}

export async function fetchEvents(sessionId: string): Promise<EventListResponse> {
  return request<EventListResponse>(`/api/sessions/${sessionId}/events`);
}

function sessionPriority(session: SessionStatus): number {
  const videoCount = session.video_urls?.length ?? 0;
  if (session.status === "ready" && videoCount > 0) return 0;
  if (session.status === "processing") return 1;
  if (session.status === "ready") return 2;
  return 3;
}

function sessionUpdatedAtValue(session: SessionStatus): number {
  return new Date(session.updated_at).getTime() || 0;
}

export async function fetchLatestSessionForMatch(matchId: string): Promise<SessionStatus | null> {
  const sessions = await fetchSessions({ matchId, limit: 100, sessionMode: "legacy_elastic" });
  if (sessions.length === 0) {
    return null;
  }
  const ranked = [...sessions].sort((a, b) => {
    const p = sessionPriority(a) - sessionPriority(b);
    if (p !== 0) return p;
    return sessionUpdatedAtValue(b) - sessionUpdatedAtValue(a);
  });
  return ranked[0] ?? null;
}

export function buildSessionOpenUrl(session: SessionStatus): string {
  return `/annotate/${encodeURIComponent(session.session_id)}`;
}

export async function saveEvents(sessionId: string, events: EventRow[]): Promise<{
  ok: boolean;
  saved_count: number;
  validation_warnings: string[];
}> {
  return request(`/api/sessions/${sessionId}/events`, {
    method: "PUT",
    body: JSON.stringify({ events }),
  });
}

export async function resetEvents(sessionId: string): Promise<{
  ok: boolean;
  restored_count: number;
  source: "snapshot" | "recomputed";
  validation_warnings: string[];
}> {
  return request(`/api/sessions/${sessionId}/reset-events`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function createUploadSession(payload: {
  videoFile: File;
  csvFile: File;
  persist: boolean;
  sessionName?: string;
}): Promise<SessionStatus> {
  const formData = new FormData();
  formData.append("video_file", payload.videoFile);
  formData.append("csv_file", payload.csvFile);
  formData.append("persist", String(payload.persist));
  const normalizedSessionName = payload.sessionName?.trim() || payload.csvFile.name?.trim();
  if (normalizedSessionName) {
    formData.append("session_name", normalizedSessionName);
  }

  const response = await fetch(`${API_BASE}/api/upload-sessions`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }

  return response.json() as Promise<SessionStatus>;
}

export async function uploadDataset(file: File): Promise<{ dataset_root: string }> {
  const formData = new FormData();
  formData.append("zip_file", file);

  const response = await fetch(`${API_BASE}/api/datasets/upload`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }

  return response.json() as Promise<{ dataset_root: string }>;
}

export function buildArtifactUrl(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }
  return `${API_BASE}${path}`;
}

export function buildSessionCsvExportUrl(
  sessionId: string,
  variant: "current" | "initial" = "current",
): string {
  const qs = variant === "initial" ? "?variant=initial" : "";
  return `${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}/export.csv${qs}`;
}
