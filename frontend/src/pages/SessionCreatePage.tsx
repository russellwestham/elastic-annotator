import { useEffect, useState, type DragEvent } from "react";
import { useNavigate } from "react-router-dom";

import {
  buildSessionOpenUrl,
  createSession,
  createUploadSession,
  fetchDefaultDatasetRoot,
  fetchMatches,
  fetchSession,
  fetchSessions,
} from "../api";
import type { MatchSummary, SessionStatus } from "../types";

type CreateMode = "existing" | "upload";

function formatDateTime(iso: string): string {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) {
    return iso;
  }
  return dt.toLocaleString("ko-KR", { hour12: false });
}

function getTrackLabel(session: SessionStatus): string {
  return session.session_mode === "upload_csv" ? "My Uploaded Data" : "Public Dataset";
}

function getPersistLabel(session: SessionStatus): string {
  if (session.session_mode !== "upload_csv") {
    return "-";
  }
  return session.persist ? "Saved" : "Temporary";
}

export function SessionCreatePage() {
  const navigate = useNavigate();

  const [createMode, setCreateMode] = useState<CreateMode>("existing");

  const annotatorName = "kunhee";
  const [datasetRoot, setDatasetRoot] = useState("");
  const [generateVideo] = useState(true);
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [matchId, setMatchId] = useState("");

  const [uploadVideoFile, setUploadVideoFile] = useState<File | null>(null);
  const [uploadCsvFile, setUploadCsvFile] = useState<File | null>(null);
  const [persistUpload, setPersistUpload] = useState(true);
  const [dragTarget, setDragTarget] = useState<"video" | "csv" | null>(null);

  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [defaultDatasetRoot, setDefaultDatasetRoot] = useState<string>("");
  const [defaultDatasetExists, setDefaultDatasetExists] = useState<boolean>(false);
  const [recentSessions, setRecentSessions] = useState<SessionStatus[]>([]);
  const [loadingRecentSessions, setLoadingRecentSessions] = useState(false);
  const [openingLatest, setOpeningLatest] = useState(false);

  const loadMatches = async (root?: string): Promise<MatchSummary[]> => {
    setError(null);
    try {
      const found = await fetchMatches(root);
      setMatches(found);
      if (found.length > 0 && !matchId) {
        setMatchId(found[0].match_id);
      }
      return found;
    } catch (err) {
      setError((err as Error).message);
      return [];
    }
  };

  const loadRecentSessions = async () => {
    setLoadingRecentSessions(true);
    try {
      const sessions = await fetchSessions({ limit: 30 });
      setRecentSessions(sessions);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingRecentSessions(false);
    }
  };

  useEffect(() => {
    void loadMatches();
    void loadRecentSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let mounted = true;
    void fetchDefaultDatasetRoot()
      .then((info) => {
        if (!mounted) return;
        setDefaultDatasetRoot(info.dataset_root);
        setDefaultDatasetExists(info.exists);
        setDatasetRoot((prev) => prev || info.dataset_root);
      })
      .catch(() => {
        // Keep setup page usable even if this hint endpoint fails.
      });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!status || status.status !== "processing") {
      return;
    }

    const timer = window.setInterval(async () => {
      try {
        const next = await fetchSession(status.session_id);
        setStatus(next);
        if (next.status === "ready") {
          window.clearInterval(timer);
          const openUrl = buildSessionOpenUrl(next);
          if (openUrl.startsWith("http://") || openUrl.startsWith("https://")) {
            window.location.assign(openUrl);
          } else {
            navigate(openUrl);
          }
        }
        if (next.status === "error") {
          window.clearInterval(timer);
        }
      } catch (err) {
        setError((err as Error).message);
      }
    }, 2000);

    return () => window.clearInterval(timer);
  }, [navigate, status]);

  const handleCreateExisting = async () => {
    if (!matchId) {
      setError("match_id is required");
      return;
    }

    setCreating(true);
    setError(null);

    try {
      const normalizedAnnotator = annotatorName.trim() || "kunhee";
      const created = await createSession({
        annotator_name: normalizedAnnotator,
        match_id: matchId,
        dataset_root: datasetRoot.trim() || undefined,
        generate_video: generateVideo,
      });
      setStatus(created);
      void loadRecentSessions();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const handleCreateUpload = async () => {
    if (!uploadVideoFile || !uploadCsvFile) {
      setError("Select both a video file and a CSV file.");
      return;
    }

    setCreating(true);
    setError(null);
    try {
      const created = await createUploadSession({
        videoFile: uploadVideoFile,
        csvFile: uploadCsvFile,
        persist: persistUpload,
      });
      setStatus(created);
      await loadRecentSessions();
      navigate(buildSessionOpenUrl(created));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const applyUploadFile = (target: "video" | "csv", file: File | null) => {
    if (!file) {
      return;
    }

    setError(null);
    const filename = file.name.toLowerCase();
    if (target === "video") {
      const validVideo = [".mp4", ".mov", ".m4v", ".webm"].some((ext) => filename.endsWith(ext));
      if (!validVideo) {
        setError("Video file must be mp4, mov, m4v, or webm.");
        return;
      }
      setUploadVideoFile(file);
      return;
    }

    if (!filename.endsWith(".csv")) {
      setError("CSV file must use the .csv extension.");
      return;
    }
    setUploadCsvFile(file);
  };

  const handleUploadDragOver = (target: "video" | "csv") => (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragTarget(target);
  };

  const handleUploadDragLeave = (target: "video" | "csv") => (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }
    if (dragTarget === target) {
      setDragTarget(null);
    }
  };

  const handleUploadDrop = (target: "video" | "csv") => (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragTarget(null);
    applyUploadFile(target, event.dataTransfer.files?.[0] ?? null);
  };

  const handleOpenLatest = async () => {
    if (!matchId) {
      setError("match_id is required");
      return;
    }
    setOpeningLatest(true);
    setError(null);
    try {
      navigate(`/m/${encodeURIComponent(matchId)}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setOpeningLatest(false);
    }
  };

  return (
    <div className="page page-create">
      <section className="card create-toolbar">
        <div className="mode-tabs" role="tablist" aria-label="Session intake mode">
          <button
            type="button"
            id="session-mode-tab-existing"
            role="tab"
            aria-selected={createMode === "existing"}
            aria-controls="session-mode-panel-existing"
            tabIndex={createMode === "existing" ? 0 : -1}
            className={`mode-tab ${createMode === "existing" ? "active" : ""}`}
            onClick={() => setCreateMode("existing")}
          >
            <span className="mode-tab-title">Review Public Dataset</span>
          </button>
          <button
            type="button"
            id="session-mode-tab-upload"
            role="tab"
            aria-selected={createMode === "upload"}
            aria-controls="session-mode-panel-upload"
            tabIndex={createMode === "upload" ? 0 : -1}
            className={`mode-tab ${createMode === "upload" ? "active" : ""}`}
            onClick={() => setCreateMode("upload")}
          >
            <span className="mode-tab-title">Upload & Review My Data</span>
          </button>
        </div>

        {createMode === "existing" ? (
          <div
            id="session-mode-panel-existing"
            role="tabpanel"
            aria-labelledby="session-mode-tab-existing"
            className="create-panel"
          >
            <div className="create-fields two-up">
              <label>
                Match
                <select value={matchId} onChange={(e) => setMatchId(e.target.value)}>
                  {matches.length === 0 && <option value="">No matches found</option>}
                  {matches.map((m) => (
                    <option key={m.match_id} value={m.match_id}>
                      {m.match_id} {m.home_team && m.away_team ? `(${m.home_team} vs ${m.away_team})` : ""}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Dataset Root
                <input
                  value={datasetRoot}
                  onChange={(e) => setDatasetRoot(e.target.value)}
                  placeholder="/Users/.../data/sportec"
                />
              </label>
            </div>

            <div className="create-actions">
              <button type="button" className="primary" onClick={handleOpenLatest} disabled={openingLatest || !matchId}>
                {openingLatest ? "Opening..." : "Open Latest Session"}
              </button>
              <button type="button" onClick={handleCreateExisting} disabled={creating}>
                {creating ? "Creating..." : "Create New Session"}
              </button>
            </div>

            {defaultDatasetRoot && datasetRoot.trim() === defaultDatasetRoot && (
              <p className="muted compact-note">
                {defaultDatasetExists ? "Default dataset available" : "Default dataset unavailable"}
              </p>
            )}
          </div>
        ) : (
          <div
            id="session-mode-panel-upload"
            role="tabpanel"
            aria-labelledby="session-mode-tab-upload"
            className="create-panel"
          >
            <div className="create-fields upload-grid">
              <label
                className={[
                  "upload-card",
                  "upload-card-video",
                  dragTarget === "video" ? "drag-active" : "",
                  uploadVideoFile ? "has-file" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onDragEnter={handleUploadDragOver("video")}
                onDragOver={handleUploadDragOver("video")}
                onDragLeave={handleUploadDragLeave("video")}
                onDrop={handleUploadDrop("video")}
              >
                <span className="upload-card-header">
                  <span className="upload-card-label">Video</span>
                  {uploadVideoFile ? <span className="upload-card-state">Selected</span> : null}
                </span>
                <span className="upload-card-value">
                  {uploadVideoFile?.name ?? "Drop file or click"}
                </span>
                <span className="upload-card-meta">
                  {uploadVideoFile ? "Choose another file" : "MP4, MOV, M4V, WEBM"}
                </span>
                <input
                  type="file"
                  accept=".mp4,.mov,.m4v,.webm,video/*"
                  onChange={(e) => applyUploadFile("video", e.target.files?.[0] ?? null)}
                />
              </label>

              <label
                className={[
                  "upload-card",
                  "upload-card-csv",
                  dragTarget === "csv" ? "drag-active" : "",
                  uploadCsvFile ? "has-file" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onDragEnter={handleUploadDragOver("csv")}
                onDragOver={handleUploadDragOver("csv")}
                onDragLeave={handleUploadDragLeave("csv")}
                onDrop={handleUploadDrop("csv")}
              >
                <span className="upload-card-header">
                  <span className="upload-card-label">CSV</span>
                  {uploadCsvFile ? <span className="upload-card-state">Selected</span> : null}
                </span>
                <span className="upload-card-value">
                  {uploadCsvFile?.name ?? "Drop file or click"}
                </span>
                <span className="upload-card-meta">
                  {uploadCsvFile ? "Choose another file" : "Any .csv file"}
                </span>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) => applyUploadFile("csv", e.target.files?.[0] ?? null)}
                />
              </label>
            </div>

            <div className="create-actions upload-actions">
              <button type="button" className="primary" onClick={handleCreateUpload} disabled={creating}>
                {creating ? "Uploading..." : "Open in Editor"}
              </button>
              <label className="check-row compact-check">
                <input
                  type="checkbox"
                  checked={persistUpload}
                  onChange={(e) => setPersistUpload(e.target.checked)}
                />
                Keep on server
              </label>
            </div>
          </div>
        )}
      </section>

      {createMode === "existing" ? (
        <section className="card recent-panel">
          <div className="section-header">
            <h2>Recent Sessions</h2>
            <button type="button" onClick={() => void loadRecentSessions()} disabled={loadingRecentSessions}>
              {loadingRecentSessions ? "Refreshing..." : "Refresh List"}
            </button>
          </div>
          <div className="table-wrap session-table-wrap">
            <table className="event-table session-table">
              <thead>
                <tr>
                  <th>Updated</th>
                  <th>Track</th>
                  <th>Label</th>
                  <th>Session ID</th>
                  <th>Status</th>
                  <th>Persist</th>
                  <th>Open</th>
                </tr>
              </thead>
              <tbody>
                {recentSessions.map((session) => {
                  const openUrl = `/annotate/${encodeURIComponent(session.session_id)}`;
                  const label = session.session_name?.trim() || session.match_id;
                  return (
                    <tr key={session.session_id}>
                      <td>{formatDateTime(session.updated_at)}</td>
                      <td>{getTrackLabel(session)}</td>
                      <td className="event-cell-primary">{label}</td>
                      <td>{session.session_id}</td>
                      <td title={session.progress ?? undefined}>
                        {session.status}
                        {session.progress ? <div className="event-cell-secondary">{session.progress}</div> : null}
                      </td>
                      <td>{getPersistLabel(session)}</td>
                      <td>
                        <a href={openUrl} target="_blank" rel="noreferrer">
                          Open
                        </a>
                      </td>
                    </tr>
                  );
                })}
                {recentSessions.length === 0 && (
                  <tr>
                    <td colSpan={7} className="muted">
                      Empty
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {error && <pre className="error-box">{error}</pre>}
    </div>
  );
}
