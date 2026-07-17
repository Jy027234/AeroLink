export type CapabilityScope = 'all' | 'department' | 'own' | 'department_or_own';

export interface CapabilityGrant {
  capability: string;
  scope: CapabilityScope;
}

export interface CapabilitySnapshot {
  role: string;
  grants: CapabilityGrant[];
}

export const PAGE_CAPABILITIES: Record<string, string> = {
  dashboard: 'dashboard.read',
  'agent-workbench': 'agent.run',
  ingestion: 'rfq.create',
  'rfq-management': 'rfq.read',
  inventory: 'inventory.read',
  sourcing: 'supplier.read',
  quotations: 'quotation.read',
  orders: 'order.read',
  customers: 'customer.read',
  suppliers: 'supplier.read',
  'supplier-quotes': 'supplier_quote.read',
  reports: 'report.read',
  'technical-kit': 'certificate.read',
  'supplier-portal': 'supplier.read',
  'exchange-vmi': 'inventory.read',
  'pricing-bi': 'report.read',
  'order-tracking': 'order.read',
  certificates: 'certificate.read',
  'certificate-templates': 'certificate_template.manage',
  workflows: 'workflow.read',
  auctions: 'auction.read',
  consignments: 'consignment.read',
  'audit-logs': 'audit_log.read',
  'api-platform': 'api_key.manage',
  'fmv-platform': 'fmv.read',
  'blockchain-verification': 'blockchain.read',
  settings: 'settings.read',
};

export function getPageCapability(pageId: string): string | undefined {
  return PAGE_CAPABILITIES[pageId];
}

export function hasCapability(grants: CapabilityGrant[], capability?: string): boolean {
  return !capability || grants.some((grant) => grant.capability === capability);
}
