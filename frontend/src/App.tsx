import { Navigate, Route, Routes } from "react-router-dom";

import { AnnotationPage } from "./pages/AnnotationPage";
import { SessionCreatePage } from "./pages/SessionCreatePage";

function App() {
  return (
    <Routes>
      <Route path="/" element={<SessionCreatePage />} />
      <Route path="/annotate/:sessionId" element={<AnnotationPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
