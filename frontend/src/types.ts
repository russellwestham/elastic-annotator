export type ErrorType =
  | "synced_ts"
  | "receive_ts"
  | "player_id"
  | "receiver_id"
  | "spadl_type"
  | "outcome"
  | "false_positive"
  | "missing";

export interface MatchSummary {
  match_id: string;
  home_team?: string | null;
  away_team?: string | null;
}

export interface SheetMapping {
  match_id: string;
  sheet_id?: string | null;
  sheet_url?: string | null;
}

export interface DefaultDatasetRoot {
  dataset_root: string;
  exists: boolean;
}

export interface SessionStatus {
  session_id: string;
  annotator_name: string;
  match_id: string;
  status: "processing" | "ready" | "error";
  dataset_root: string;
  progress?: string | null;
  error_message?: string | null;
  created_at: string;
  updated_at: string;
  event_count: number;
  fps?: number | null;
  video_url?: string | null;
  video_urls?: string[] | null;
  sheet_url?: string | null;
  sheet_tab_name?: string | null;
  sheet_gid?: string | null;
  sheet_tab_url?: string | null;
}

export interface EventRow {
  id: string;
  period_id: number;
  spadl_type: string;
  player_id: string;
  synced_frame_id?: number | null;
  synced_ts?: string | null;
  receiver_id?: string | null;
  receive_frame_id?: number | null;
  receive_ts?: string | null;
  outcome: boolean;
  error_type?: ErrorType | null;
  note: string;
}

export interface EventListResponse {
  session_id: string;
  events: EventRow[];
  validation_warnings: string[];
}
