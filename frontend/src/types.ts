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

export interface DefaultDatasetRoot {
  dataset_root: string;
  exists: boolean;
}

export interface VideoSegment {
  id: string;
  url: string;
  original_filename?: string | null;
  start_frame: number;
  period_start_frame?: number | null;
  video_start_time_seconds?: number | null;
  timing_confirmed: boolean;
  frame_count?: number | null;
  duration_seconds?: number | null;
  fps?: number | null;
  created_at: string;
}

export interface SessionStatus {
  session_id: string;
  annotator_name: string;
  match_id: string;
  session_mode: "legacy_elastic" | "upload_csv";
  persist: boolean;
  session_name?: string | null;
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
  video_start_frame?: number | null;
  original_video_filename?: string | null;
  video_start_frame_source?: string | null;
  video_start_frame_confirmed: boolean;
  video_duration_seconds?: number | null;
  video_frame_count?: number | null;
  video_segments: VideoSegment[];
  event_undo_available: boolean;
  display_name?: string | null;
  public_read_only: boolean;
  public_baseline: boolean;
  public_editable: boolean;
  public_source?: string | null;
  edit_token?: string | null;
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

export interface ImportNoteSummary {
  code: string;
  title: string;
  summary: string;
  count: number;
  sample_rows: number[];
}

export interface QAFlagSummary {
  code: string;
  title: string;
  summary: string;
  count: number;
  sample_frame_ids: number[];
}

export interface EventListResponse {
  session_id: string;
  events: EventRow[];
  validation_warnings: string[];
  import_notes: ImportNoteSummary[];
  qa_flags: QAFlagSummary[];
}
