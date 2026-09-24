import { StrictMode } from "react";
import type { Root } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { startEventStream } from "./api/events";
import { useApp } from "./store";
import ErrorBoundary from "./ui/ErrorBoundary";
import "./styles.css";

/** The staff app's start-up, exactly as `main.tsx` ran it before the public page split off. */
export function bootStaff(root: Root): void {
  // Live updates follow the session; this is the only place that turns the follower on.
  startEventStream();

  // A reload keeps the HttpOnly refresh cookie but not the in-memory access token.
  // Start the exchange before the first render, so the gate shows "Loading…" rather
  // than flashing the sign-in form at someone who is already signed in.
  void useApp.getState().restore();

  root.render(
    <StrictMode>
      <ErrorBoundary>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ErrorBoundary>
    </StrictMode>
  );
}
