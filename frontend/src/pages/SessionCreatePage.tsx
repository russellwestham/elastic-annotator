import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  clearSheetMapping,
  createSession,
  fetchDefaultDatasetRoot,
  fetchLatestSessionForMatch,
  fetchMatches,
  fetchSessions,
  fetchSession,
  fetchSheetMapping,
  upsertSheetMapping,
  uploadDataset,
} from "../api";
import type { MatchSummary, SessionStatus } from "../types";

function formatDateTime(iso: string): string {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) {
    return iso;
  }
  return dt.toLocaleString("ko-KR", { hour12: false });
}

export function SessionCreatePage() {
  const navigate = useNavigate();

  const [annotatorName, setAnnotatorName] = useState("");
  const [datasetRoot, setDatasetRoot] = useState("");
  const [generateVideo, setGenerateVideo] = useState(true);
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [matchId, setMatchId] = useState("");

  const [loadingMatches, setLoadingMatches] = useState(false);
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheetRef, setSheetRef] = useState("");
  const [sheetLoading, setSheetLoading] = useState(false);
  const [sheetSaving, setSheetSaving] = useState(false);
  const [sheetMessage, setSheetMessage] = useState<string | null>(null);
  const [mappedSheetUrl, setMappedSheetUrl] = useState<string | null>(null);
  const [defaultDatasetRoot, setDefaultDatasetRoot] = useState<string>("");
  const [defaultDatasetExists, setDefaultDatasetExists] = useState<boolean>(false);
  const [recentSessions, setRecentSessions] = useState<SessionStatus[]>([]);
  const [loadingRecentSessions, setLoadingRecentSessions] = useState(false);
  const [openingLatest, setOpeningLatest] = useState(false);

  const selectedMatchLabel = useMemo(() => {
    const selected = matches.find((m) => m.match_id === matchId);
    if (!selected) return "";
    if (selected.home_team && selected.away_team) {
      return `${selected.match_id} (${selected.home_team} vs ${selected.away_team})`;
    }
    return selected.match_id;
  }, [matches, matchId]);

  const loadMatches = async (root?: string): Promise<MatchSummary[]> => {
    setLoadingMatches(true);
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
    } finally {
      setLoadingMatches(false);
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
    const timer = window.setInterval(() => {
      void loadRecentSessions();
    }, 10000);
    return () => window.clearInterval(timer);
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
          navigate(`/annotate/${next.session_id}`);
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

  useEffect(() => {
    if (!matchId) {
      setSheetRef("");
      setMappedSheetUrl(null);
      setSheetMessage(null);
      return;
    }

    let mounted = true;
    setSheetLoading(true);
    setSheetMessage(null);
    void fetchSheetMapping(matchId)
      .then((mapping) => {
        if (!mounted) return;
        setMappedSheetUrl(mapping.sheet_url ?? null);
        setSheetRef(mapping.sheet_url ?? mapping.sheet_id ?? "");
      })
      .catch((err) => {
        if (!mounted) return;
        setError((err as Error).message);
      })
      .finally(() => {
        if (!mounted) return;
        setSheetLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [matchId]);

  const handleDatasetUpload = async (file: File) => {
    setError(null);
    try {
      const result = await uploadDataset(file);
      setDatasetRoot(result.dataset_root);
      const found = await loadMatches(result.dataset_root);
      if (found.length === 0) {
        setError(
          "ZIP 업로드는 완료됐지만 경기 목록을 찾지 못했습니다. ZIP 내부에 metadata/event/tracking 폴더가 있는지 확인해 주세요.",
        );
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleCreate = async () => {
    if (!annotatorName.trim()) {
      setError("annotator name is required");
      return;
    }
    if (!matchId) {
      setError("match_id is required");
      return;
    }

    setCreating(true);
    setError(null);

    try {
      const normalizedSheetRef = sheetRef.trim();
      if (normalizedSheetRef) {
        const mapping = await upsertSheetMapping(matchId, normalizedSheetRef);
        setMappedSheetUrl(mapping.sheet_url ?? null);
        setSheetRef(mapping.sheet_url ?? mapping.sheet_id ?? normalizedSheetRef);
        setSheetMessage("Sheet mapping saved");
      }

      const created = await createSession({
        annotator_name: annotatorName.trim(),
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

  const handleOpenLatest = async () => {
    if (!matchId) {
      setError("match_id is required");
      return;
    }
    setOpeningLatest(true);
    setError(null);
    try {
      const latest = await fetchLatestSessionForMatch(matchId);
      if (!latest) {
        setError(`No session found for match_id=${matchId}`);
        return;
      }
      navigate(`/annotate/${latest.session_id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setOpeningLatest(false);
    }
  };

  const handleSaveSheetMapping = async () => {
    if (!matchId) {
      setError("match_id is required");
      return;
    }
    if (!sheetRef.trim()) {
      setError("Google Sheet URL/ID is required");
      return;
    }

    setSheetSaving(true);
    setError(null);
    setSheetMessage(null);
    try {
      const mapping = await upsertSheetMapping(matchId, sheetRef.trim());
      setMappedSheetUrl(mapping.sheet_url ?? null);
      setSheetRef(mapping.sheet_url ?? mapping.sheet_id ?? sheetRef.trim());
      setSheetMessage("Sheet mapping saved");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSheetSaving(false);
    }
  };

  const handleClearSheetMapping = async () => {
    if (!matchId) {
      setError("match_id is required");
      return;
    }
    setSheetSaving(true);
    setError(null);
    setSheetMessage(null);
    try {
      await clearSheetMapping(matchId);
      setMappedSheetUrl(null);
      setSheetRef("");
      setSheetMessage("Sheet mapping cleared");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSheetSaving(false);
    }
  };

  return (
    <div className="page page-create">
      <h1>ELASTIC Annotation - Session Setup</h1>

      <div className="card">
        <label>
          Annotator Name
          <input
            value={annotatorName}
            onChange={(e) => setAnnotatorName(e.target.value)}
            placeholder="예: leekunhee_dyve"
          />
        </label>

        <label>
          Dataset Root (optional)
          <input
            value={datasetRoot}
            onChange={(e) => setDatasetRoot(e.target.value)}
            placeholder="/Users/.../data/sportec"
          />
        </label>
        {defaultDatasetRoot && (
          <p className="muted">
            기본 Sportec 데이터셋: {defaultDatasetRoot} {defaultDatasetExists ? "(available)" : "(not found)"}
          </p>
        )}

        <div className="row">
          <button type="button" onClick={() => void loadMatches(datasetRoot || undefined)} disabled={loadingMatches}>
            {loadingMatches ? "Loading matches..." : "Reload Matches"}
          </button>

          <label className="file-upload">
            Upload Dataset ZIP
            <input
              type="file"
              accept=".zip"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  void handleDatasetUpload(file);
                }
              }}
            />
          </label>
        </div>

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
          Google Sheet (URL or ID)
          <input
            value={sheetRef}
            onChange={(e) => setSheetRef(e.target.value)}
            placeholder="https://docs.google.com/spreadsheets/d/... 또는 sheet_id"
            disabled={sheetLoading}
          />
        </label>
        <div className="row">
          <button type="button" onClick={handleSaveSheetMapping} disabled={sheetSaving || sheetLoading || !matchId}>
            {sheetSaving ? "Saving..." : "Save Sheet Mapping"}
          </button>
          <button type="button" onClick={handleClearSheetMapping} disabled={sheetSaving || sheetLoading || !matchId}>
            Clear Mapping
          </button>
        </div>
        {mappedSheetUrl && (
          <p className="muted">
            Mapped sheet: <a href={mappedSheetUrl} target="_blank" rel="noreferrer">{mappedSheetUrl}</a>
          </p>
        )}
        {sheetMessage && <p className="muted">{sheetMessage}</p>}

        <label className="check-row">
          <input
            type="checkbox"
            checked={generateVideo}
            onChange={(e) => setGenerateVideo(e.target.checked)}
          />
          Generate full animation video now
        </label>

        <div className="row">
          <button type="button" className="primary" onClick={handleCreate} disabled={creating}>
            {creating ? "Creating..." : "Create Session"}
          </button>
          <button type="button" onClick={handleOpenLatest} disabled={openingLatest || !matchId}>
            {openingLatest ? "Opening..." : "Open latest"}
          </button>
          {matchId && (
            <a href={`/m/${encodeURIComponent(matchId)}`} target="_blank" rel="noreferrer">
              Open latest (new tab)
            </a>
          )}
        </div>

        {selectedMatchLabel && <p className="muted">Selected: {selectedMatchLabel}</p>}
      </div>

      {status && (
        <div className="card">
          <h2>Build Status</h2>
          <p>Session ID: {status.session_id}</p>
          <p>Status: {status.status}</p>
          <p>Progress: {status.progress ?? "-"}</p>
          {status.sheet_url && (
            <p>
              Sheet:{" "}
              <a href={status.sheet_url} target="_blank" rel="noreferrer">
                Open sheet
              </a>
            </p>
          )}
          {status.error_message && <pre className="error-box">{status.error_message}</pre>}
        </div>
      )}

      <div className="card">
        <div className="section-header">
          <h2>Recent Sessions</h2>
          <button type="button" onClick={() => void loadRecentSessions()} disabled={loadingRecentSessions}>
            {loadingRecentSessions ? "Refreshing..." : "Refresh"}
          </button>
        </div>
        <div className="table-wrap">
          <table className="event-table">
            <thead>
              <tr>
                <th>Updated</th>
                <th>Match</th>
                <th>Session ID</th>
                <th>Status</th>
                <th>Sheet</th>
                <th>Open</th>
              </tr>
            </thead>
            <tbody>
              {recentSessions.map((session) => (
                <tr key={session.session_id}>
                  <td>{formatDateTime(session.updated_at)}</td>
                  <td>{session.match_id}</td>
                  <td className="event-cell-primary">{session.session_id}</td>
                  <td title={session.progress ?? undefined}>
                    {session.status}
                    {session.progress ? (
                      <div className="event-cell-secondary">{session.progress}</div>
                    ) : null}
                  </td>
                  <td>
                    {session.sheet_url ? (
                      <a href={session.sheet_url} target="_blank" rel="noreferrer">
                        Open sheet
                      </a>
                    ) : (
                      <span className="muted">-</span>
                    )}
                  </td>
                  <td>
                    <a href={`/annotate/${session.session_id}`}>Open session</a>
                  </td>
                </tr>
              ))}
              {recentSessions.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
                    No sessions yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {error && <pre className="error-box">{error}</pre>}
    </div>
  );
}
