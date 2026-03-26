import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { buildSessionOpenUrl, fetchLatestSessionForMatch } from "../api";

export function MatchRedirectPage() {
  const navigate = useNavigate();
  const { matchId = "" } = useParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      if (!matchId.trim()) {
        setError("match_id is required");
        return;
      }
      try {
        const latest = await fetchLatestSessionForMatch(matchId.trim());
        if (cancelled) return;
        if (!latest) {
          setError(`No session found for match_id=${matchId}`);
          return;
        }
        const openUrl = buildSessionOpenUrl(latest);
        if (openUrl.startsWith("/")) {
          navigate(openUrl, { replace: true });
          return;
        }
        window.location.replace(openUrl);
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
          <h2>Opening latest session...</h2>
          <p className="muted">match_id: {matchId}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="card">
        <h2>Cannot open latest session</h2>
        <pre className="error-box">{error}</pre>
        <p>
          <Link to="/">Go to Session Setup</Link>
        </p>
      </div>
    </div>
  );
}
