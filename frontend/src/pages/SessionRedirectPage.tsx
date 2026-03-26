import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { fetchSession } from "../api";

export function SessionRedirectPage() {
  const navigate = useNavigate();
  const { sessionId = "" } = useParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const normalizedSessionId = sessionId.trim();
      if (!normalizedSessionId) {
        setError("session_id is required");
        return;
      }

      try {
        const session = await fetchSession(normalizedSessionId);
        if (cancelled) return;
        navigate(`/annotate/m/${encodeURIComponent(session.match_id)}`, { replace: true });
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [navigate, sessionId]);

  if (!error) {
    return (
      <div className="page">
        <div className="card">
          <h2>Redirecting to match view...</h2>
          <p className="muted">session_id: {sessionId}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="card">
        <h2>Cannot open session</h2>
        <pre className="error-box">{error}</pre>
        <p>
          <Link to="/">Go to Session Setup</Link>
        </p>
      </div>
    </div>
  );
}
