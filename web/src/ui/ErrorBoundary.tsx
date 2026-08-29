import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props { children: ReactNode }
interface State { error: Error | null }

/**
 * Without this, any render error unmounts the whole tree and the user gets a blank page
 * with no clue what went wrong. Show the error instead.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled render error:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div style={{ maxWidth: 720, margin: "12vh auto", padding: "0 24px" }}>
        <div className="card">
          <div className="card-h"><h3>Something went wrong on this screen</h3></div>
          <div className="card-b">
            <div className="al c">
              <span className="k">ERROR</span>
              <span>{error.message}</span>
            </div>
            <p className="mini" style={{ marginTop: 12 }}>
              The rest of the application is unaffected. Reload, or go back to your home screen.
            </p>
            <div className="btnrow" style={{ marginTop: 14 }}>
              <button className="btn" type="button" onClick={() => window.location.reload()}>Reload</button>
              <button className="btn gh" type="button"
                onClick={() => { this.setState({ error: null }); window.location.hash = "#/"; }}>
                Back to home
              </button>
            </div>
            {error.stack && (
              <details style={{ marginTop: 14 }}>
                <summary className="mini" style={{ cursor: "pointer" }}>Technical detail</summary>
                <pre className="mini" style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>{error.stack}</pre>
              </details>
            )}
          </div>
        </div>
      </div>
    );
  }
}
