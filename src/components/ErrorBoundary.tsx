import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

function ErrorFallback({ error, onReload, onRetry }: { error: Error | null; onReload: () => void; onRetry: () => void }) {
  const { t } = useTranslation();

  return (
    <div className="min-h-[400px] flex items-center justify-center p-8">
      <div className="text-center max-w-md">
        <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <AlertTriangle className="w-8 h-8 text-red-500" />
        </div>
        <h2 className="text-xl font-semibold text-gray-900 mb-2">{t('errors.pageError')}</h2>
        <p className="text-gray-500 mb-6 text-sm">
          {error?.message || t('errors.unknownError')}
        </p>
        <div className="flex gap-3 justify-center">
          <Button variant="outline" onClick={onReload}>
            <RefreshCw className="w-4 h-4 mr-2" />
            {t('errors.reloadPage')}
          </Button>
          <Button onClick={onRetry}>
            {t('errors.retry')}
          </Button>
        </div>
      </div>
    </div>
  );
}

class ErrorBoundaryRoot extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary] Uncaught error:', error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return <ErrorFallback error={this.state.error} onReload={() => window.location.reload()} onRetry={this.handleReset} />;
    }

    return this.props.children;
  }
}

export function ErrorBoundary(props: ErrorBoundaryProps) {
  return <ErrorBoundaryRoot {...props} />;
}
