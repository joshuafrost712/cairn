import { Component, type ErrorInfo, type ReactNode } from 'react'

// A render crash must never lose an evaluator's place silently. This catches it,
// shows a recoverable message, and keeps the on-device data intact (it's in IndexedDB,
// not React state).
interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[cairn] render error', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <main>
          <div className="card">
            <h1>Something went wrong</h1>
            <p className="small">
              The screen hit an error, but your data is saved on this device. Reload to continue; nothing in
              progress is lost.
            </p>
            <p className="muted small">{this.state.error.message}</p>
            <div className="row">
              <button className="primary" onClick={() => location.reload()}>Reload</button>
              <button className="ghost" onClick={() => this.setState({ error: null })}>Try again</button>
            </div>
          </div>
        </main>
      )
    }
    return this.props.children
  }
}
