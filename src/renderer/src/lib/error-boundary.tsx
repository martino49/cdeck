import { Component, ErrorInfo, ReactNode } from 'react';

interface Props { children: ReactNode }
interface State { hasError: boolean; error: string | null }

export class ErrorBoundary extends Component<Props, State> {
  state = { hasError: false, error: null };
  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error: error.message ?? String(error) };
  }
  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[KeepAlive error boundary]', error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            padding: 24,
            color: '#b91c1c',
            background: '#fef2f2',
            border: '1px solid #fecaca',
            borderRadius: 8,
            fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          }}
        >
          <h2 style={{ margin: '0 0 12px', fontSize: '18px' }}>Something went wrong</h2>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              fontSize: 12,
              lineHeight: 1.5,
              color: '#450a0a',
            }}
          >
            {this.state.error}
          </pre>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              marginTop: 12,
              padding: '6px 12px',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
