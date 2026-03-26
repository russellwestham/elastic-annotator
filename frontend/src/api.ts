import type {
  DefaultDatasetRoot,
  EventListResponse,
  EventRow,
  MatchSummary,
  SessionStatus,
  SheetMapping,
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

export async function fetchSheetMapping(matchId: string): Promise<SheetMapping> {
  return request<SheetMapping>(`/api/sheet-mappings/${encodeURIComponent(matchId)}`);
}

export async function upsertSheetMapping(matchId: string, sheetRef: string): Promise<SheetMapping> {
  return request<SheetMapping>(`/api/sheet-mappings/${encodeURIComponent(matchId)}`, {
    method: "PUT",
    body: JSON.stringify({ sheet_ref: sheetRef }),
  });
}

export async function clearSheetMapping(matchId: string): Promise<SheetMapping> {
  return request<SheetMapping>(`/api/sheet-mappings/${encodeURIComponent(matchId)}`, {
    method: "DELETE",
    body: JSON.stringify({}),
  });
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
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return request<SessionStatus[]>(`/api/sessions${suffix}`);
}

export async function fetchEvents(sessionId: string): Promise<EventListResponse> {
  return request<EventListResponse>(`/api/sessions/${sessionId}/events`);
}

export async function saveEvents(sessionId: string, events: EventRow[]): Promise<{
  ok: boolean;
  saved_count: number;
  validation_warnings: string[];
  sheet_synced: boolean;
}> {
  return request(`/api/sessions/${sessionId}/events`, {
    method: "PUT",
    body: JSON.stringify({ events, sync_sheet: true }),
  });
}

export async function syncSheet(sessionId: string): Promise<{ sheet_url: string | null }> {
  return request(`/api/sessions/${sessionId}/sync-sheet`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function resetSheet(sessionId: string): Promise<{ sheet_url: string | null }> {
  return request(`/api/sessions/${sessionId}/reset-sheet`, {
    method: "POST",
    body: JSON.stringify({}),
  });
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
