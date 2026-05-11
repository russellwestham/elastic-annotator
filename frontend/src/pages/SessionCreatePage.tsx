import { useEffect, useState, type DragEvent } from "react";
import { useNavigate } from "react-router-dom";

import {
  buildSessionOpenUrl,
  createSession,
  createUploadSession,
  deleteSession,
  fetchDefaultDatasetRoot,
  fetchMatches,
  fetchSession,
  fetchSessions,
  updateSessionMetadata,
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

function formatDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
    return "-";
  }
  const minutes = Math.floor(seconds / 60);
  const remain = Math.round(seconds % 60);
  return `${minutes}:${String(remain).padStart(2, "0")}`;
}

function formatFrame(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  return Math.round(value).toLocaleString("en-US");
}

function getFrameSourceLabel(source: string | null | undefined): string {
  if (source === "filename") return "filename";
  if (source === "duration") return "video length";
  return "fallback";
}

function getPersistLabel(session: SessionStatus): string {
  if (session.session_mode !== "upload_csv") {
    return "-";
  }
  return session.persist ? "Saved" : "Temporary";
}

function getSessionTitle(session: SessionStatus): string {
  return (
    session.session_name?.trim() ||
    session.original_video_filename?.trim() ||
    session.match_id?.trim() ||
    session.session_id
  );
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
  const [uploadStartFrame, setUploadStartFrame] = useState("");
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
  const [editingTitleSessionId, setEditingTitleSessionId] = useState<string | null>(null);
  const [editingTitleValue, setEditingTitleValue] = useState("");
  const [savingTitleSessionId, setSavingTitleSessionId] = useState<string | null>(null);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [pendingAlignmentSession, setPendingAlignmentSession] = useState<SessionStatus | null>(null);
  const [alignmentStartFrame, setAlignmentStartFrame] = useState("");
  const [savingAlignment, setSavingAlignment] = useState(false);

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

    const normalizedStartFrame = uploadStartFrame.trim();
    let requestedStartFrame: number | undefined;
    if (normalizedStartFrame) {
      const parsedStartFrame = Number(normalizedStartFrame);
      if (!Number.isFinite(parsedStartFrame) || parsedStartFrame < 0) {
        setError("Video start frame must be a non-negative number.");
        return;
      }
      requestedStartFrame = Math.round(parsedStartFrame);
    }

    setCreating(true);
    setError(null);
    try {
      const created = await createUploadSession({
        videoFile: uploadVideoFile,
        csvFile: uploadCsvFile,
        persist: persistUpload,
        videoStartFrame: requestedStartFrame,
      });
      setStatus(created);
      await loadRecentSessions();
      if (created.video_start_frame_confirmed || requestedStartFrame !== undefined) {
        navigate(buildSessionOpenUrl(created));
        return;
      }
      setPendingAlignmentSession(created);
      setAlignmentStartFrame(String(created.video_start_frame ?? 0));
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
      setPendingAlignmentSession(null);
      return;
    }

    if (!filename.endsWith(".csv")) {
      setError("CSV file must use the .csv extension.");
      return;
    }
    setUploadCsvFile(file);
    setPendingAlignmentSession(null);
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

  const beginTitleEdit = (session: SessionStatus) => {
    const titleLabel = getSessionTitle(session);
    setEditingTitleSessionId(session.session_id);
    setEditingTitleValue(titleLabel);
    setError(null);
  };

  const cancelTitleEdit = () => {
    setEditingTitleSessionId(null);
    setEditingTitleValue("");
  };

  const saveTitleEdit = async (session: SessionStatus) => {
    const sessionId = session.session_id;
    setSavingTitleSessionId(sessionId);
    setError(null);
    try {
      const updated = await updateSessionMetadata(sessionId, { title: editingTitleValue });
      setRecentSessions((prev) => prev.map((item) => (item.session_id === sessionId ? updated : item)));
      setStatus((prev) => (prev?.session_id === sessionId ? updated : prev));
      cancelTitleEdit();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingTitleSessionId(null);
    }
  };

  const handleDeleteSession = async (session: SessionStatus) => {
    const label = getSessionTitle(session);
    const confirmed = window.confirm(
      `Delete session "${label}" (${session.session_id})?\n\nThis action cannot be undone.`,
    );
    if (!confirmed) {
      return;
    }

    setDeletingSessionId(session.session_id);
    setError(null);
    try {
      await deleteSession(session.session_id);
      setRecentSessions((prev) => prev.filter((item) => item.session_id !== session.session_id));
      setStatus((prev) => (prev?.session_id === session.session_id ? null : prev));
      if (editingTitleSessionId === session.session_id) {
        cancelTitleEdit();
      }
      if (pendingAlignmentSession?.session_id === session.session_id) {
        setPendingAlignmentSession(null);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeletingSessionId(null);
    }
  };

  const handleApplyAlignment = async () => {
    if (!pendingAlignmentSession) {
      return;
    }

    const parsed = Number(alignmentStartFrame);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setError("Video start frame must be a non-negative number.");
      return;
    }

    const videoStartFrame = Math.round(parsed);
    setSavingAlignment(true);
    setError(null);
    try {
      const updated = await updateSessionMetadata(pendingAlignmentSession.session_id, {
        video_start_frame: videoStartFrame,
      });
      setPendingAlignmentSession(null);
      setStatus(updated);
      setRecentSessions((prev) => prev.map((item) => (item.session_id === updated.session_id ? updated : item)));
      navigate(buildSessionOpenUrl(updated));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingAlignment(false);
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
              <label className="upload-start-frame-field">
                Start frame
                <input
                  type="number"
                  min={0}
                  value={uploadStartFrame}
                  onChange={(e) => setUploadStartFrame(e.target.value)}
                  placeholder="Optional"
                />
              </label>
              <label className="check-row compact-check">
                <input
                  type="checkbox"
                  checked={persistUpload}
                  onChange={(e) => setPersistUpload(e.target.checked)}
                />
                Keep on server
              </label>
            </div>

            {pendingAlignmentSession && (
              <div className="alignment-panel">
                <div className="alignment-panel-main">
                  <div>
                    <h3>Frame Alignment</h3>
                    <p className="muted compact-note">
                      Suggested from {getFrameSourceLabel(pendingAlignmentSession.video_start_frame_source)}
                    </p>
                  </div>
                  <label>
                    Video start frame
                    <input
                      type="number"
                      min={0}
                      value={alignmentStartFrame}
                      onChange={(event) => setAlignmentStartFrame(event.target.value)}
                      disabled={savingAlignment}
                    />
                  </label>
                </div>
                <div className="alignment-meta">
                  <span>{pendingAlignmentSession.original_video_filename ?? "uploaded video"}</span>
                  <span>{pendingAlignmentSession.fps ?? 25} fps</span>
                  <span>{formatDuration(pendingAlignmentSession.video_duration_seconds)}</span>
                  <span>{formatFrame(pendingAlignmentSession.video_frame_count)} frames</span>
                </div>
                <div className="create-actions upload-actions">
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void handleApplyAlignment()}
                    disabled={savingAlignment}
                  >
                    {savingAlignment ? "Applying..." : "Apply & Open"}
                  </button>
                  <span className="muted compact-note">CSV frames stay unchanged.</span>
                </div>
              </div>
            )}
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
                  <th>Title</th>
                  <th>Session ID</th>
                  <th>Status</th>
                  <th>Persist</th>
                  <th>Open</th>
                  <th>Delete</th>
                </tr>
              </thead>
              <tbody>
                {recentSessions.map((session) => {
                  const openUrl = `/annotate/${encodeURIComponent(session.session_id)}`;
                  const isEditingTitle = editingTitleSessionId === session.session_id;
                  const isSavingTitle = savingTitleSessionId === session.session_id;
                  const isDeleting = deletingSessionId === session.session_id;
                  const titleLabel = getSessionTitle(session);
                  return (
                    <tr key={session.session_id}>
                      <td>{formatDateTime(session.updated_at)}</td>
                      <td className="session-title-cell">
                        {isEditingTitle ? (
                          <div className="session-title-editor">
                            <input
                              value={editingTitleValue}
                              onChange={(e) => setEditingTitleValue(e.target.value)}
                              placeholder={titleLabel}
                              disabled={isSavingTitle || isDeleting}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  void saveTitleEdit(session);
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
                                onClick={() => void saveTitleEdit(session)}
                                disabled={isSavingTitle || isDeleting}
                              >
                                {isSavingTitle ? "Saving..." : "Save"}
                              </button>
                              <button type="button" onClick={cancelTitleEdit} disabled={isSavingTitle || isDeleting}>
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="session-title-display">
                            <span className="event-cell-primary">{titleLabel}</span>
                            <button
                              type="button"
                              className="session-title-edit-button"
                              onClick={() => beginTitleEdit(session)}
                              disabled={isDeleting}
                            >
                              Edit
                            </button>
                          </div>
                        )}
                      </td>
                      <td>{session.session_id}</td>
                      <td title={session.progress ?? undefined}>
                        {session.status}
                        {session.progress ? <div className="event-cell-secondary">{session.progress}</div> : null}
                      </td>
                      <td>{getPersistLabel(session)}</td>
                      <td>
                        <a href={openUrl} target="_blank" rel="noreferrer" aria-disabled={isDeleting}>
                          Open
                        </a>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="danger session-delete-button"
                          onClick={() => void handleDeleteSession(session)}
                          disabled={isDeleting || session.status === "processing"}
                          title={session.status === "processing" ? "Processing sessions cannot be deleted." : undefined}
                        >
                          {isDeleting ? "Deleting..." : "Delete"}
                        </button>
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
