import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import { useApp } from "./store";
import ErrorBoundary from "./ui/ErrorBoundary";
import "./styles.css";

// A reload keeps the HttpOnly refresh cookie but not the in-memory access token.
// Start the exchange before the first render, so the gate shows "Loading…" rather
// than flashing the sign-in form at someone who is already signed in.
void useApp.getState().restore();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <HashRouter>
        <App />
      </HashRouter>
    </ErrorBoundary>
  </StrictMode>
);
