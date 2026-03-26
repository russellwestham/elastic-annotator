import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { fetchLatestSessionForMatch } from "../api";

export function MatchAnnotateRedirectPage() {
  const navigate = useNavigate();
  const { matchId = "" } = useParams();
  const [error, setError] = useState<string | null>(null);

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
        if (!latest) {
          setError(`No session found for match_id=${normalizedMatchId}`);
          return;
        }
        navigate(`/annotate/${latest.session_id}`, { replace: true });
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [matchId, navigate]);

  if (!error) {
    return (
      <div className="page">
        <div className="card">
          <h2>Opening latest annotation...</h2>
          <p className="muted">match_id: {matchId}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="card">
        <h2>Cannot open annotation</h2>
        <pre className="error-box">{error}</pre>
        <p>
          <Link to="/">Go to Session Setup</Link>
        </p>
      </div>
    </div>
  );
}
