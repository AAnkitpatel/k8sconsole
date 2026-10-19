import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  error: Error | null;
}

/**
 * Keeps a rendering error in one view from blanking the whole window: shows what failed and lets the user retry.
 * `resetKey` clears the error when it changes (for example when the user navigates to another view).
 */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string; label: string }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[${this.props.label}]`, error, info.componentStack);
  }

  componentDidUpdate(prev: { resetKey?: string }): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const details = `${error.name}: ${error.message}\n${(error.stack ?? '').split('\n').slice(1, 8).join('\n')}`;
    return (
      <div className="empty error-boundary" role="alert" data-testid="error-boundary">
        <h2>Something went wrong in {this.props.label}</h2>
        <p className="muted">The rest of the app still works. Try again, or open another view.</p>
        <pre className="pre">{details}</pre>
        <div className="toolbar">
          <button className="btn btn-primary" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
          <button className="btn" onClick={() => void navigator.clipboard?.writeText(details).catch(() => undefined)}>
            Copy details
          </button>
        </div>
      </div>
    );
  }
}
