export const DEFAULT_PAGE = 'dashboard';

const PAGE_PATHS: Record<string, string> = {
  dashboard: '/dashboard',
  'agent-workbench': '/agent-workbench',
  ingestion: '/ingestion',
  'rfq-management': '/rfq-management',
  inventory: '/inventory',
  sourcing: '/sourcing',
  quotations: '/quotations',
  orders: '/orders',
  customers: '/customers',
  suppliers: '/suppliers',
  'supplier-quotes': '/supplier-quotes',
  reports: '/reports',
  settings: '/settings',
  'technical-kit': '/technical-kit',
  'supplier-portal': '/supplier-portal',
  'exchange-vmi': '/exchange-vmi',
  'pricing-bi': '/pricing-bi',
  'order-tracking': '/order-tracking',
};

const pathToPage = new Map<string, string>(
  Object.entries(PAGE_PATHS).map(([pageId, pathname]) => [pathname, pageId])
);

function normalizePathname(pathname: string): string {
  const trimmedPath = pathname.replace(/\/+$/, '');
  return trimmedPath === '' ? '/' : trimmedPath;
}

export function normalizePageId(pageId: string): string {
  return PAGE_PATHS[pageId] ? pageId : DEFAULT_PAGE;
}

export function getPathnameForPage(pageId: string): string {
  return PAGE_PATHS[normalizePageId(pageId)];
}

export function resolvePageFromPathname(pathname: string): string {
  const normalizedPath = normalizePathname(pathname);

  if (normalizedPath === '/') {
    return DEFAULT_PAGE;
  }

  return pathToPage.get(normalizedPath) ?? DEFAULT_PAGE;
}

export function isKnownPagePath(pathname: string): boolean {
  const normalizedPath = normalizePathname(pathname);
  return normalizedPath === '/' || pathToPage.has(normalizedPath);
}