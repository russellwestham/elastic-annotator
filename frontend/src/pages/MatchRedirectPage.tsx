import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { fetchLatestSessionForMatch, fetchSheetMapping } from "../api";

export function MatchRedirectPage() {
  const { matchId = "" } = useParams();
  const [error, setError] = useState<string | null>(null);
  const [fallbackSessionId, setFallbackSessionId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const normalizedMatchId = matchId.trim();
      if (!normalizedMatchId) {
        setError("match_id is required");
        return;
      }

      try {
        const mapping = await fetchSheetMapping(normalizedMatchId);
        if (cancelled) return;
        const sheetUrl = mapping.sheet_url?.trim();
        if (sheetUrl) {
          window.location.replace(sheetUrl);
          return;
        }

        const latest = await fetchLatestSessionForMatch(normalizedMatchId);
        if (cancelled) return;
        if (latest?.session_id) {
          setFallbackSessionId(latest.session_id);
        }
        setError(`No mapped Google Sheet for match_id=${normalizedMatchId}`);
      } catch (err) {
        if (cancelled) return;
        const latest = await fetchLatestSessionForMatch(normalizedMatchId);
        if (!cancelled && latest?.session_id) {
          setFallbackSessionId(latest.session_id);
        }
        setError((err as Error).message);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [matchId]);

  if (!error) {
    return (
      <div className="page">
        <div className="card">
          <h2>Opening match sheet...</h2>
          <p className="muted">match_id: {matchId}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="card">
        <h2>Cannot open match sheet</h2>
        <pre className="error-box">{error}</pre>
        {fallbackSessionId && (
          <p>
            Latest session:{" "}
            <a href={`/annotate/${fallbackSessionId}`} target="_blank" rel="noreferrer">
              /annotate/{fallbackSessionId}
            </a>
          </p>
        )}
        <p>
          <Link to="/">Go to Session Setup</Link>
        </p>
      </div>
    </div>
  );
}
