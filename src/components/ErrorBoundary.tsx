import React from 'react';
import { AlertCircle, RotateCcw } from 'lucide-react';
import { Button } from './ui/Button';

interface State {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      errorMessage: error?.message || 'An unexpected interface error occurred.',
    };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('DocuMind AI ErrorBoundary caught:', error, info);
  }

  handleReset = () => {
    this.setState({ hasError: false, errorMessage: '' });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-surface text-ink flex items-center justify-center p-6">
          <div className="max-w-md w-full rounded-[10px] bg-panel border border-line p-6 space-y-4">
            <div className="flex items-start gap-3">
              <AlertCircle
                className="w-[18px] h-[18px] text-status-error shrink-0 mt-0.5"
                strokeWidth={1.5}
              />
              <div className="space-y-1">
                <h1 className="text-[16px] font-semibold text-ink">
                  Unable to render this view
                </h1>
                <p className="text-[13px] text-ink-secondary leading-relaxed">
                  {this.state.errorMessage}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 pt-1">
              <Button variant="primary" size="sm" onClick={this.handleReset}>
                <RotateCcw className="w-4 h-4" strokeWidth={1.5} />
                Try again
              </Button>
              <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
                Reload page
              </Button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
