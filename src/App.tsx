// App component
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { I18nProvider } from '@/i18n';
import { Layout } from '@/components/Layout';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Toaster } from '@/components/ui/sonner';
import { DataInitializer } from '@/components/DataInitializer';
import { useAuthStore, useCapabilityStore, useUIStore } from '@/store';
import { isKnownPagePath, resolvePageFromPathname } from '@/lib/pageRoutes';
import { getPageCapability, hasCapability } from '@/lib/capabilities';
import { preloadPages } from '@/lib/pagePreload';
import { useTranslation } from '@/i18n';
import { authApi, getAccessToken } from '@/api/client';
import {
  beginPageNavigation,
  completePageNavigation,
  markFirstScreenReady,
} from '@/lib/performanceMetrics';

const Login = lazy(() =>
  import('@/sections/Login').then((module) => ({ default: module.Login }))
);
const Dashboard = lazy(() =>
  import('@/sections/Dashboard').then((module) => ({ default: module.Dashboard }))
);
const AgentWorkbench = lazy(() =>
  import('@/sections/AgentWorkbench').then((module) => ({ default: module.AgentWorkbench }))
);
const IngestionHub = lazy(() =>
  import('@/sections/IngestionHub').then((module) => ({ default: module.IngestionHub }))
);
const RFQManagement = lazy(() =>
  import('@/sections/RFQManagement').then((module) => ({ default: module.RFQManagement }))
);
const InventoryCenter = lazy(() =>
  import('@/sections/Inventory').then((module) => ({ default: module.InventoryCenter }))
);
const Sourcing = lazy(() =>
  import('@/sections/Sourcing').then((module) => ({ default: module.Sourcing }))
);
const Quotations = lazy(() =>
  import('@/sections/Quotations').then((module) => ({ default: module.Quotations }))
);
const Orders = lazy(() =>
  import('@/sections/Orders').then((module) => ({ default: module.Orders }))
);
const Customers = lazy(() =>
  import('@/sections/Customers').then((module) => ({ default: module.Customers }))
);
const Suppliers = lazy(() =>
  import('@/sections/Suppliers').then((module) => ({ default: module.Suppliers }))
);
const SupplierQuotes = lazy(() =>
  import('@/sections/SupplierQuotes').then((module) => ({ default: module.SupplierQuotes }))
);
const Reports = lazy(() =>
  import('@/sections/Reports').then((module) => ({ default: module.Reports }))
);
const SettingsPage = lazy(() =>
  import('@/sections/Settings').then((module) => ({ default: module.SettingsPage }))
);
const TechnicalKit = lazy(() =>
  import('@/sections/TechnicalKit').then((module) => ({ default: module.TechnicalKit }))
);
const SupplierPortal = lazy(() =>
  import('@/sections/SupplierPortal').then((module) => ({ default: module.SupplierPortal }))
);
const ExchangeVMI = lazy(() =>
  import('@/sections/ExchangeVMI').then((module) => ({ default: module.ExchangeVMI }))
);
const PricingBI = lazy(() =>
  import('@/sections/PricingBI').then((module) => ({ default: module.PricingBI }))
);
const OrderTracking = lazy(() =>
  import('@/sections/OrderTracking').then((module) => ({ default: module.OrderTracking }))
);
const Certificates = lazy(() =>
  import('@/sections/Certificates').then((module) => ({ default: module.Certificates }))
);
const CertificateTemplates = lazy(() =>
  import('@/sections/CertificateTemplates').then((module) => ({ default: module.CertificateTemplates }))
);
const Workflows = lazy(() =>
  import('@/sections/Workflows').then((module) => ({ default: module.default }))
);
const AuditLogs = lazy(() =>
  import('@/sections/AuditLogs').then((module) => ({ default: module.default }))
);
const Auctions = lazy(() =>
  import('@/sections/Auctions').then((module) => ({ default: module.Auctions }))
);
const Consignments = lazy(() =>
  import('@/sections/Consignments').then((module) => ({ default: module.Consignments }))
);
const ApiPlatform = lazy(() =>
  import('@/sections/ApiPlatform').then((module) => ({ default: module.ApiPlatform }))
);
const FMVPlatform = lazy(() =>
  import('@/sections/FMVPlatform').then((module) => ({ default: module.FMVPlatform }))
);
const BlockchainVerification = lazy(() =>
  import('@/sections/BlockchainVerification').then((module) => ({ default: module.BlockchainVerification }))
);

function PageLoadingFallback() {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-[280px] items-center justify-center text-sm text-muted-foreground">
      {t('common.loading')}
    </div>
  );
}

function PageReadyTracker({ pageId, children }: { pageId: string; children: React.ReactNode }) {
  useEffect(() => {
    completePageNavigation(pageId);
    markFirstScreenReady(pageId);
  }, [pageId]);

  return <>{children}</>;
}

function withPageReady(pageId: string, element: React.ReactNode) {
  return <PageReadyTracker pageId={pageId}>{element}</PageReadyTracker>;
}

function App() {
  const { isAuthenticated, user, login: storeLogin, logout } = useAuthStore();
  const { currentPage } = useUIStore();
  const setCurrentPage = useUIStore((state) => state.setCurrentPage);
  const capabilityGrants = useCapabilityStore((state) => state.grants);
  const capabilitiesLoaded = useCapabilityStore((state) => state.loaded);
  const loadCapabilities = useCapabilityStore((state) => state.load);
  const clearCapabilities = useCapabilityStore((state) => state.clear);
  const bootNavigationMarkedRef = useRef(false);
  const [sessionRestoring, setSessionRestoring] = useState(false);

  useEffect(() => {
    const syncPageFromLocation = () => {
      const pathname = window.location.pathname;
      const nextPage = resolvePageFromPathname(pathname);

      if (!isKnownPagePath(pathname)) {
        setCurrentPage(nextPage, { replaceHistory: true });
        return;
      }

      if (useUIStore.getState().currentPage !== nextPage) {
        beginPageNavigation(nextPage, 'programmatic');
        setCurrentPage(nextPage, { syncUrl: false });
      }
    };

    syncPageFromLocation();
    window.addEventListener('popstate', syncPageFromLocation);

    return () => {
      window.removeEventListener('popstate', syncPageFromLocation);
    };
  }, [setCurrentPage]);

  useEffect(() => {
    if (!isAuthenticated || getAccessToken()) {
      setSessionRestoring(false);
      return;
    }

    let cancelled = false;
    setSessionRestoring(true);

    void authApi.refresh()
      .then(() => authApi.getMe())
      .then((user) => {
        if (!cancelled) {
          storeLogin(user);
        }
      })
      .catch(() => {
        if (!cancelled) {
          logout();
        }
      })
      .finally(() => {
        if (!cancelled) {
          setSessionRestoring(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, logout, storeLogin]);

  useEffect(() => {
    if (!isAuthenticated || !user?.id) {
      clearCapabilities();
      return;
    }

    clearCapabilities();
    void loadCapabilities();
  }, [clearCapabilities, isAuthenticated, loadCapabilities, user?.id]);

  useEffect(() => {
    if (!isAuthenticated || !capabilitiesLoaded) {
      return;
    }

    const requiredCapability = getPageCapability(currentPage);
    if (requiredCapability && !hasCapability(capabilityGrants, requiredCapability)) {
      setCurrentPage('dashboard', { replaceHistory: true });
    }
  }, [capabilitiesLoaded, capabilityGrants, currentPage, isAuthenticated, setCurrentPage]);

  useEffect(() => {
    if (!isAuthenticated || bootNavigationMarkedRef.current) {
      return;
    }

    bootNavigationMarkedRef.current = true;
    beginPageNavigation(currentPage, 'boot');
  }, [isAuthenticated, currentPage]);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }

    preloadPages(['dashboard', 'rfq-management', 'orders', 'inventory']);
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }

    const likelyNextPages: Record<string, string[]> = {
      dashboard: ['rfq-management', 'orders', 'inventory'],
      'rfq-management': ['quotations', 'orders'],
      quotations: ['orders', 'customers'],
      orders: ['order-tracking', 'customers'],
      inventory: ['sourcing', 'suppliers'],
      suppliers: ['supplier-quotes', 'sourcing'],
      customers: ['quotations', 'orders'],
    };

    preloadPages(likelyNextPages[currentPage] ?? []);
  }, [isAuthenticated, currentPage]);

  // 渲染当前页面
  const renderPage = () => {
    switch (currentPage) {
      case 'dashboard':
        return withPageReady('dashboard', <Dashboard />);
      case 'agent-workbench':
        return withPageReady('agent-workbench', <AgentWorkbench />);
      case 'ingestion':
        return withPageReady('ingestion', <IngestionHub />);
      case 'rfq-management':
        return withPageReady('rfq-management', <RFQManagement />);
      case 'inventory':
        return withPageReady('inventory', <InventoryCenter />);
      case 'sourcing':
        return withPageReady('sourcing', <Sourcing />);
      case 'quotations':
        return withPageReady('quotations', <Quotations />);
      case 'orders':
        return withPageReady('orders', <Orders />);
      case 'customers':
        return withPageReady('customers', <Customers />);
      case 'suppliers':
        return withPageReady('suppliers', <Suppliers />);
      case 'supplier-quotes':
        return withPageReady('supplier-quotes', <SupplierQuotes />);
      case 'reports':
        return withPageReady('reports', <Reports />);
      case 'settings':
        return withPageReady('settings', <SettingsPage />);
      case 'technical-kit':
        return withPageReady('technical-kit', <TechnicalKit />);
      case 'supplier-portal':
        return withPageReady('supplier-portal', <SupplierPortal />);
      case 'exchange-vmi':
        return withPageReady('exchange-vmi', <ExchangeVMI />);
      case 'pricing-bi':
        return withPageReady('pricing-bi', <PricingBI />);
      case 'order-tracking':
        return withPageReady('order-tracking', <OrderTracking />);
      case 'certificates':
        return withPageReady('certificates', <Certificates />);
      case 'certificate-templates':
        return withPageReady('certificate-templates', <CertificateTemplates />);
      case 'workflows':
        return withPageReady('workflows', <Workflows />);
      case 'auctions':
        return withPageReady('auctions', <Auctions />);
      case 'consignments':
        return withPageReady('consignments', <Consignments />);
      case 'api-platform':
        return withPageReady('api-platform', <ApiPlatform />);
      case 'fmv-platform':
        return withPageReady('fmv-platform', <FMVPlatform />);
      case 'blockchain-verification':
        return withPageReady('blockchain-verification', <BlockchainVerification />);
      case 'audit-logs':
        return withPageReady('audit-logs', <AuditLogs />);
      default:
        return withPageReady('dashboard', <Dashboard />);
    }
  };

  if (isAuthenticated && (sessionRestoring || !getAccessToken())) {
    return (
      <I18nProvider>
        <PageLoadingFallback />
        <Toaster />
      </I18nProvider>
    );
  }

  if (!isAuthenticated) {
    return (
      <I18nProvider>
        <Suspense fallback={<PageLoadingFallback />}>
          <Login />
        </Suspense>
        <Toaster />
      </I18nProvider>
    );
  }

  return (
    <I18nProvider>
      <ErrorBoundary>
        <DataInitializer>
          <Layout>
            <Suspense fallback={<PageLoadingFallback />}>{renderPage()}</Suspense>
            <Toaster />
          </Layout>
        </DataInitializer>
      </ErrorBoundary>
    </I18nProvider>
  );
}

export default App;
