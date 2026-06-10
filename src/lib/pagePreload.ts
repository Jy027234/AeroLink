const pageLoaders: Record<string, () => Promise<unknown>> = {
  dashboard: () => import('@/sections/Dashboard'),
  'agent-workbench': () => import('@/sections/AgentWorkbench'),
  ingestion: () => import('@/sections/IngestionHub'),
  'rfq-management': () => import('@/sections/RFQManagement'),
  inventory: () => import('@/sections/Inventory'),
  sourcing: () => import('@/sections/Sourcing'),
  quotations: () => import('@/sections/Quotations'),
  orders: () => import('@/sections/Orders'),
  customers: () => import('@/sections/Customers'),
  suppliers: () => import('@/sections/Suppliers'),
  'supplier-quotes': () => import('@/sections/SupplierQuotes'),
  reports: () => import('@/sections/Reports'),
  settings: () => import('@/sections/Settings'),
  'technical-kit': () => import('@/sections/TechnicalKit'),
  'supplier-portal': () => import('@/sections/SupplierPortal'),
  'exchange-vmi': () => import('@/sections/ExchangeVMI'),
  'pricing-bi': () => import('@/sections/PricingBI'),
  'order-tracking': () => import('@/sections/OrderTracking'),
};

const preloadedPages = new Set<string>();

export function preloadPage(pageId: string): void {
  if (preloadedPages.has(pageId)) {
    return;
  }

  const loader = pageLoaders[pageId];
  if (!loader) {
    return;
  }

  preloadedPages.add(pageId);
  loader().catch(() => {
    // Keep preload failures non-blocking and allow retry on next navigation.
    preloadedPages.delete(pageId);
  });
}

export function preloadPages(pageIds: string[]): void {
  pageIds.forEach((pageId) => preloadPage(pageId));
}
