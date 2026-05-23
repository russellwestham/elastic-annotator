import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { fetchLatestSessionForMatch } from "../api";

interface MatchRedirectPageProps {
  basePath?: string;
}

export function MatchRedirectPage({ basePath = "" }: MatchRedirectPageProps) {
  const { matchId = "" } = useParams();
  const [error, setError] = useState<string | null>(null);
  const [hasFallbackSession, setHasFallbackSession] = useState(false);
  const normalizedBasePath = basePath.replace(/\/$/, "");

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const normalizedMatchId = matchId.trim();
      if (!normalizedMatchId) {
        setError("match_id is required");
        return;
      }

      try {
        const latest = await fetchLatestSessionForMatch(normalizedMatchId);
        if (cancelled) return;
        if (latest?.session_id) {
          window.location.replace(`${normalizedBasePath}/annotate/${encodeURIComponent(latest.session_id)}`);
          return;
        }
        setHasFallbackSession(false);
        setError(`No session found for match_id=${normalizedMatchId}`);
      } catch (err) {
        if (cancelled) return;
        const latest = await fetchLatestSessionForMatch(normalizedMatchId);
        if (!cancelled && latest?.session_id) {
          setHasFallbackSession(true);
        }
        setError((err as Error).message);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [matchId, normalizedBasePath]);

  if (!error) {
    return (
      <div className="page">
        <div className="card">
          <h2>Opening latest session...</h2>
          <p className="muted">match_id: {matchId}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="card">
        <h2>Cannot open session</h2>
        <pre className="error-box">{error}</pre>
        {hasFallbackSession && (
          <p>
            Latest session:{" "}
            <a href={`${normalizedBasePath}/annotate/m/${encodeURIComponent(matchId)}`} target="_blank" rel="noreferrer">
              {normalizedBasePath}/annotate/m/{matchId}
            </a>
          </p>
        )}
        <p>
          <Link to={normalizedBasePath || "/"}>Go to Session Setup</Link>
        </p>
      </div>
    </div>
  );
}
