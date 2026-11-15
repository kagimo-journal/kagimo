import { Component, type ReactNode } from 'react';

/** Last-resort catch so a render or chunk-load error shows a way out instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="loading-screen" role="alert" style={{ flexDirection: 'column', gap: 16, padding: 24, textAlign: 'center' }}>
        <p>Something went wrong loading this page.</p>
        <button type="button" className="btn btn-secondary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
