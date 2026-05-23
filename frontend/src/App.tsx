import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { AnnotationPage } from "./pages/AnnotationPage";
import { MatchRedirectPage } from "./pages/MatchRedirectPage";
import { SessionCreatePage } from "./pages/SessionCreatePage";
import { ADMIN_BASE_PATH } from "./routePaths";

type ThemeMode = "light" | "dark";

const THEME_STORAGE_KEY = "elastic-annotator-theme";

function getInitialTheme(): ThemeMode {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark") {
    return stored;
  }
  const prefersDark =
    typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-color-scheme: dark)").matches;
  return prefersDark ? "dark" : "light";
}

function App() {
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  };

  return (
    <>
      <button
        type="button"
        className="theme-toggle"
        onClick={toggleTheme}
        aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      >
        {theme === "dark" ? "Light" : "Dark"}
      </button>
      <Routes>
        <Route path="/" element={<SessionCreatePage publicMode />} />
        <Route path="/public" element={<Navigate to="/" replace />} />
        <Route path="/annotate/:sessionId" element={<AnnotationPage publicMode />} />
        <Route path="/public/annotate/:sessionId" element={<AnnotationPage publicMode />} />
        <Route path={ADMIN_BASE_PATH} element={<SessionCreatePage />} />
        <Route path={`${ADMIN_BASE_PATH}/m/:matchId`} element={<MatchRedirectPage basePath={ADMIN_BASE_PATH} />} />
        <Route path={`${ADMIN_BASE_PATH}/annotate/m/:matchId`} element={<AnnotationPage />} />
        <Route path={`${ADMIN_BASE_PATH}/annotate/:sessionId`} element={<AnnotationPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}

export default App;
