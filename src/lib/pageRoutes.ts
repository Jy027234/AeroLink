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
  'supplier-portal': '/supplier-information',
  'exchange-vmi': '/exchange-vmi',
  'pricing-bi': '/pricing-bi',
  'order-tracking': '/order-tracking',
  certificates: '/certificates',
  'certificate-templates': '/certificate-templates',
  workflows: '/workflows',
  auctions: '/auctions',
  consignments: '/consignments',
  'api-platform': '/api-platform',
  'fmv-platform': '/fmv-platform',
  'blockchain-verification': '/blockchain-verification',
  'audit-logs': '/audit-logs',
};

// Existing bookmarks keep resolving to the internal information-management view.
// New navigation always uses the supplier-information path.
const LEGACY_PAGE_PATHS: Record<string, string> = {
  '/supplier-portal': 'supplier-portal',
};

const pathToPageEntries: Array<[string, string]> = [
  ...Object.entries(PAGE_PATHS).map(([pageId, pathname]) => [pathname, pageId] as [string, string]),
  ...Object.entries(LEGACY_PAGE_PATHS).map(([pathname, pageId]) => [pathname, pageId] as [string, string]),
];

const pathToPage = new Map<string, string>(pathToPageEntries);

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
