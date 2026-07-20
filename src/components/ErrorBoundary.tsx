import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { reportFrontendError } from '@/lib/monitoring';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorCount: number;
  errorInfo: React.ErrorInfo | null;
}

function ErrorFallback({ error, errorCount, errorInfo, onReload, onRetry }: { error: Error | null; errorCount: number; errorInfo: React.ErrorInfo | null; onReload: () => void; onRetry: () => void }) {
  const { t } = useTranslation();

  return (
    <div className="min-h-[400px] flex items-center justify-center p-8">
      <div className="text-center max-w-md">
        <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <AlertTriangle className="w-8 h-8 text-red-500" />
        </div>
        <h2 className="text-xl font-semibold text-gray-900 mb-2">{t('errors.pageError')}</h2>
        <p className="text-gray-500 mb-2 text-sm">
          {error?.message || t('errors.unknownError')}
        </p>
        <p className="text-xs text-gray-400 mt-2">
          {errorCount > 0 && `重试次数: ${errorCount}/3`}
        </p>
        {import.meta.env.DEV && errorInfo?.componentStack && (
          <pre className="text-xs text-left text-red-400 mt-4 p-2 bg-red-50 rounded overflow-auto max-h-40">
            {errorInfo.componentStack}
          </pre>
        )}
        <div className="flex gap-3 justify-center mt-6">
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
    this.state = { hasError: false, error: null, errorCount: 0, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error, errorCount: 0, errorInfo: null };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    reportFrontendError(error, { source: 'react.error-boundary', componentStack: errorInfo.componentStack });
    this.setState({ errorInfo });
    // 上报到 localStorage
    try {
      const errors = JSON.parse(localStorage.getItem('aerolink_errors') || '[]');
      errors.push({
        message: error.message,
        stack: error.stack,
        componentStack: errorInfo.componentStack,
        timestamp: new Date().toISOString(),
        url: window.location.href,
      });
      // 只保留最近 20 条
      if (errors.length > 20) errors.shift();
      localStorage.setItem('aerolink_errors', JSON.stringify(errors));
    } catch {
      // ignore
    }
  }

  handleReset = () => {
    if (this.state.errorCount >= 3) {
      // 多次错误后强制刷新页面
      window.location.reload();
      return;
    }
    this.setState({ hasError: false, error: null, errorCount: this.state.errorCount + 1 });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return <ErrorFallback error={this.state.error} errorCount={this.state.errorCount} errorInfo={this.state.errorInfo} onReload={() => window.location.reload()} onRetry={this.handleReset} />;
    }

    return this.props.children;
  }
}

export function ErrorBoundary(props: ErrorBoundaryProps) {
  return <ErrorBoundaryRoot {...props} />;
}
