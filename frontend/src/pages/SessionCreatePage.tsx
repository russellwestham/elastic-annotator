import { useEffect, useState, type DragEvent } from "react";
import { useNavigate } from "react-router-dom";

import {
  buildSessionOpenUrl,
  createSession,
  createPublicUploadSession,
  createUploadSession,
  deleteSession,
  fetchDefaultDatasetRoot,
  fetchMatches,
  fetchPublicSessions,
  fetchSession,
  fetchSessions,
  updateSessionMetadata,
} from "../api";
import type { MatchSummary, SessionStatus } from "../types";

type CreateMode = "existing" | "upload";

function formatRelativeTime(iso: string, now: number): string {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) {
    return iso;
  }

  const diffMs = now - dt.getTime();
  const isFuture = diffMs < 0;
  const diffSeconds = Math.max(0, Math.round(Math.abs(diffMs) / 1000));

  let value: number;
  let unit: string;
  if (diffSeconds < 10) {
    return "just now";
  }
  if (diffSeconds < 60) {
    value = diffSeconds;
    unit = "s";
  } else if (diffSeconds < 3600) {
    value = Math.floor(diffSeconds / 60);
    unit = "m";
  } else if (diffSeconds < 86400) {
    value = Math.floor(diffSeconds / 3600);
    unit = "h";
  } else if (diffSeconds < 604800) {
    value = Math.floor(diffSeconds / 86400);
    unit = "d";
  } else if (diffSeconds < 2592000) {
    value = Math.floor(diffSeconds / 604800);
    unit = "w";
  } else if (diffSeconds < 31536000) {
    value = Math.floor(diffSeconds / 2592000);
    unit = "mo";
  } else {
    value = Math.floor(diffSeconds / 31536000);
    unit = "y";
  }

  return isFuture ? `in ${value}${unit}` : `${value}${unit} ago`;
}

function getSessionModeLabel(session: SessionStatus): string {
  return session.session_mode === "upload_csv" ? "Uploaded CSV" : "Public Dataset";
}

function getSessionStatusLabel(status: SessionStatus["status"]): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function getSessionTitle(session: SessionStatus): string {
  return (
    session.display_name?.trim() ||
    session.session_name?.trim() ||
    session.original_video_filename?.trim() ||
    session.match_id?.trim() ||
    session.session_id
  );
}

function buildOpenUrl(session: SessionStatus, publicMode: boolean): string {
  if (!publicMode) {
    return `/admin${buildSessionOpenUrl(session)}`;
  }
  const token = session.edit_token?.trim();
  const qs = token ? `?edit_token=${encodeURIComponent(token)}` : "";
  return `/annotate/${encodeURIComponent(session.session_id)}${qs}`;
}

interface SessionCreatePageProps {
  publicMode?: boolean;
}

export function SessionCreatePage({ publicMode = false }: SessionCreatePageProps) {
  const navigate = useNavigate();

  const [createMode, setCreateMode] = useState<CreateMode>(publicMode ? "upload" : "existing");

  const annotatorName = "kunhee";
  const [datasetRoot, setDatasetRoot] = useState("");
  const [generateVideo] = useState(true);
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [matchId, setMatchId] = useState("");

  const [uploadCsvFile, setUploadCsvFile] = useState<File | null>(null);
  const [persistUpload, setPersistUpload] = useState(true);
  const [dragTarget, setDragTarget] = useState<"csv" | null>(null);

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
  const [relativeTimeNow, setRelativeTimeNow] = useState(() => Date.now());

  const loadMatches = async (root?: string): Promise<MatchSummary[]> => {
    if (publicMode) {
      return [];
    }
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
      const sessions = publicMode
        ? await fetchPublicSessions({ limit: 100 })
        : await fetchSessions({ limit: 30 });
      setRecentSessions(sessions);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingRecentSessions(false);
    }
  };

  useEffect(() => {
    if (!publicMode) {
      void loadMatches();
    }
    void loadRecentSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (publicMode) {
      return;
    }
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
  }, [publicMode]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setRelativeTimeNow(Date.now());
    }, 10000);

    return () => window.clearInterval(timer);
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
          const openUrl = buildOpenUrl(next, publicMode);
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
  }, [navigate, publicMode, status]);

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
    if (!uploadCsvFile) {
      setError("Select a CSV file first.");
      return;
    }

    setCreating(true);
    setError(null);
    try {
      const created = publicMode
        ? await createPublicUploadSession({ csvFile: uploadCsvFile })
        : await createUploadSession({
          csvFile: uploadCsvFile,
          persist: persistUpload,
        });
      setStatus(created);
      window.location.assign(buildOpenUrl(created, publicMode));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const applyUploadFile = (file: File | null) => {
    if (!file) {
      return;
    }

    setError(null);
    const filename = file.name.toLowerCase();
    if (!filename.endsWith(".csv")) {
      setError("CSV file must use the .csv extension.");
      return;
    }
    setUploadCsvFile(file);
  };

  const handleUploadDragOver = (target: "csv") => (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragTarget(target);
  };

  const handleUploadDragLeave = (target: "csv") => (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }
    if (dragTarget === target) {
      setDragTarget(null);
    }
  };

  const handleUploadDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragTarget(null);
    applyUploadFile(event.dataTransfer.files?.[0] ?? null);
  };

  const handleOpenLatest = async () => {
    if (!matchId) {
      setError("match_id is required");
      return;
    }
    setOpeningLatest(true);
    setError(null);
    try {
      navigate(`/admin/m/${encodeURIComponent(matchId)}`);
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
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeletingSessionId(null);
    }
  };

  return (
    <div className="page page-create">
      <section className="card create-toolbar">
        {publicMode ? (
          <div className="public-page-heading">
            <h1>ELASTIC Annotator</h1>
            <p className="muted panel-copy">
              Shared Sportec match sessions are locked for inspection and CSV download. Upload your own CSV to create an editable session.
            </p>
          </div>
        ) : (
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
              <span className="mode-tab-title">Upload CSV & Review My Data</span>
            </button>
          </div>
        )}

        {!publicMode && createMode === "existing" ? (
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
            id={publicMode ? "public-upload-panel" : "session-mode-panel-upload"}
            role={publicMode ? undefined : "tabpanel"}
            aria-labelledby={publicMode ? undefined : "session-mode-tab-upload"}
            className="create-panel"
          >
            <div className="create-fields upload-grid upload-grid-single">
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
                onDrop={handleUploadDrop}
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
                  onChange={(e) => applyUploadFile(e.target.files?.[0] ?? null)}
                />
              </label>
            </div>
            <p className="muted compact-note">
              {publicMode
                ? "New sessions open with a private edit link. Keep that URL if you want to continue editing later."
                : "Create the session with CSV first. You can upload the video later inside the editor."}
            </p>

            <div className="create-actions upload-actions">
              <button type="button" className="primary" onClick={handleCreateUpload} disabled={creating}>
                {creating ? "Uploading..." : publicMode ? "Create Session" : "Open in Editor"}
              </button>
              {!publicMode && (
                <label className="check-row compact-check">
                  <input
                    type="checkbox"
                    checked={persistUpload}
                    onChange={(e) => setPersistUpload(e.target.checked)}
                  />
                  Keep on server
                </label>
              )}
            </div>
          </div>
        )}
      </section>

      <section className="card recent-panel">
        <div className="section-header recent-session-header">
          <div>
            <h2>{publicMode ? "Annotation Sessions" : "Recent Sessions"}</h2>
            <p className="muted panel-copy">
              {publicMode
                ? "Listed Sportec sessions are read-only. Sessions created from a new CSV are editable from their private link."
                : "Jump back into recent work without rebuilding the same setup."}
            </p>
          </div>
          <button
            type="button"
            className="recent-session-refresh"
            onClick={() => void loadRecentSessions()}
            disabled={loadingRecentSessions}
          >
            {loadingRecentSessions ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        {recentSessions.length > 0 ? (
          <div className="recent-session-list">
            {recentSessions.map((session) => {
              const openUrl = buildOpenUrl(session, publicMode);
              const isEditingTitle = editingTitleSessionId === session.session_id;
              const isSavingTitle = savingTitleSessionId === session.session_id;
              const isDeleting = deletingSessionId === session.session_id;
              const titleLabel = getSessionTitle(session);
              return (
                <article
                  key={session.session_id}
                  className={`recent-session-item${isDeleting ? " is-busy" : ""}`}
                >
                  <div className="recent-session-main">
                    {isEditingTitle ? (
                      <div className="session-title-editor recent-session-title-editor">
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
                      </div>
                    ) : (
                      <h3 className="recent-session-title">{titleLabel}</h3>
                    )}

                    <div className="recent-session-meta">
                      <span className={`recent-session-status recent-session-status-${session.status}`}>
                        {getSessionStatusLabel(session.status)}
                      </span>
                      <span className="recent-session-pill">{getSessionModeLabel(session)}</span>
                      {session.public_baseline && <span className="recent-session-pill">Read-only</span>}
                      {session.public_editable && <span className="recent-session-pill">Editable</span>}
                      <span className="recent-session-pill">{formatRelativeTime(session.updated_at, relativeTimeNow)}</span>
                    </div>

                    <div className="recent-session-supporting">
                      <span>Session ID {session.session_id}</span>
                    </div>
                  </div>

                  <div className="recent-session-actions">
                    {isEditingTitle ? (
                      <>
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
                      </>
                    ) : (
                      <>
                        <a
                          className="button-link primary recent-session-open"
                          href={openUrl}
                          target="_blank"
                          rel="noreferrer"
                          aria-disabled={isDeleting}
                          onClick={(event) => {
                            if (isDeleting) {
                              event.preventDefault();
                            }
                          }}
                        >
                          Open
                        </a>
                        {!publicMode && (
                          <button
                            type="button"
                            className="session-title-edit-button"
                            onClick={() => beginTitleEdit(session)}
                            disabled={isDeleting}
                          >
                            Edit Title
                          </button>
                        )}
                      </>
                    )}

                    {!publicMode && (
                      <button
                        type="button"
                        className="danger session-delete-button"
                        onClick={() => void handleDeleteSession(session)}
                        disabled={isDeleting || isSavingTitle}
                      >
                        {isDeleting ? "Deleting..." : "Delete"}
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="recent-session-empty muted">No recent sessions yet.</div>
        )}
      </section>

      {error && <pre className="error-box">{error}</pre>}
    </div>
  );
}
