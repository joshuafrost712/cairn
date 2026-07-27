import { Component, type ErrorInfo, type ReactNode } from 'react'
import { c } from '../lib/content/chrome'
import { Copy } from './Copy'

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
            <Copy id="error.title" as="h1" />
            <Copy id="error.body" as="p" className="small" />
            <p className="muted small">{this.state.error.message}</p>
            <div className="row">
              <button className="primary" onClick={() => location.reload()}>{c('error.reload')}</button>
              <button className="ghost" onClick={() => this.setState({ error: null })}>
                {c('error.try-again')}
              </button>
            </div>
          </div>
        </main>
      )
    }
    return this.props.children
  }
}
