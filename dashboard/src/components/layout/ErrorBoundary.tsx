/*
 * A boundary per route. A render error in one page used to unmount
 * the whole tree to a blank screen with the message in the console. The
 * boundary keeps the shell — the sidebar, the header, the palette — and
 * says what happened where the page was, with a way back. It resets when
 * the route changes, so a broken page does not follow the reader around.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';

interface BoundaryProps {
  children: ReactNode;
  /** Changing this resets the boundary — the route path, so navigation clears it. */
  resetKey: string;
  /** Where the reader can go from here. */
  homeLabel?: string;
}

interface BoundaryState {
  error: Error | null;
  resetKey: string;
}

export class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<BoundaryState> {
    return { error };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    // A new route: forget the old page's error.
    if (props.resetKey !== state.resetKey) return { error: null, resetKey: props.resetKey };
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The console keeps the stack; the screen keeps the sentence.
    console.error('[iris] page error', error, info.componentStack);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    if (isChunkLoadError(this.state.error)) {
      /*
       * The page's code did not arrive (#662). Usually the server was
       * upgraded while this tab stayed open, so the chunk this tab asks for
       * no longer exists; a reload fetches the current dashboard. "Try
       * again" cannot help: the failed import is remembered until reload.
       */
      return (
        <div className="iris-error-box" role="alert" data-error-boundary="chunk" style={{ margin: 'var(--space-4)' }}>
          <strong>This page's code could not be loaded.</strong>
          <span>If Iris was upgraded while this tab was open, reloading fetches the new dashboard. Otherwise check that the server is still running.</span>
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
            <button type="button" className="iris-btn iris-btn--danger" onClick={() => window.location.reload()}>
              Reload the dashboard
            </button>
            <Link to="/" style={{ color: 'inherit' }}>
              {this.props.homeLabel ?? 'Back to the dashboard'}
            </Link>
          </div>
        </div>
      );
    }
    return (
      <div className="iris-error-box" role="alert" data-error-boundary="route" style={{ margin: 'var(--space-4)' }}>
        <strong>This page hit an error it could not recover from.</strong>
        <span>{this.state.error.message || String(this.state.error)}</span>
        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
          <button type="button" className="iris-btn iris-btn--danger" onClick={this.reset}>
            Try again
          </button>
          <Link to="/" style={{ color: 'inherit' }}>
            {this.props.homeLabel ?? 'Back to the dashboard'}
          </Link>
        </div>
      </div>
    );
  }
}

/**
 * Did a page's code fail to download? The browsers word it differently:
 * Chromium "Failed to fetch dynamically imported module", Firefox "error
 * loading dynamically imported module", Safari "Importing a module script
 * failed". Vite's preload helper reports a missing CSS or JS dependency as
 * "Unable to preload CSS" / "Failed to fetch".
 */
export function isChunkLoadError(error: Error): boolean {
  return /dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(error.message ?? '');
}

/** The boundary keyed by the current route, so navigating away clears a page's error. */
export function RouteBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  return <ErrorBoundary resetKey={location.pathname}>{children}</ErrorBoundary>;
}
