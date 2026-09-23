import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.js";
import { ErrorBoundary } from "./app/ErrorBoundary.js";
import { installOverlayScrollbars } from "./app/scrollbars.js";

const container = document.getElementById("kiwi-root");
if (container === null) {
  throw new Error("Renderer root element is missing");
}

installOverlayScrollbars();

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
