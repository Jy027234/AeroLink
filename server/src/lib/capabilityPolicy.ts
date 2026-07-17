export const CAPABILITY_RESOURCES = [
  'dashboard',
  'settings',
  'rfq',
  'quotation',
  'order',
  'inventory',
  'customer',
  'supplier',
  'supplier_quote',
  'certificate',
  'certificate_template',
  'workflow',
  'webhook',
  'api_key',
  'user',
  'email_account',
  'agent',
  'model',
  'outbox',
  'audit_log',
  'report',
  'integration',
  'auction',
  'consignment',
  'fmv',
  'blockchain',
  'session',
] as const;

export const CAPABILITY_ACTIONS = [
  'read',
  'create',
  'update',
  'delete',
  'transition',
  'approve',
  'send',
  'accept',
  'withdraw',
  'manage',
  'reconcile',
  'export',
  'issue',
  'view_cost',
  'run',
] as const;

export type CapabilityResource = typeof CAPABILITY_RESOURCES[number];
export type CapabilityAction = typeof CAPABILITY_ACTIONS[number];
export type CapabilityKey = `${CapabilityResource}.${CapabilityAction}`;
export type CapabilityScope = 'all' | 'department' | 'own' | 'department_or_own';

export interface CapabilityActor {
  id: string;
  role: string;
  department?: string | null;
}

export interface CapabilityResourceContext {
  ownerId?: string | null;
  department?: string | null;
}

export interface CapabilityGrant {
  capability: CapabilityKey;
  scope: CapabilityScope;
}

type NormalizedRole =
  | 'admin'
  | 'gm'
  | 'manager'
  | 'finance'
  | 'sales'
  | 'operator'
  | 'quality_manager'
  | 'viewer';

type RolePolicy = Partial<Record<CapabilityKey, CapabilityScope>> | 'all';

function key(resource: CapabilityResource, action: CapabilityAction): CapabilityKey {
  return `${resource}.${action}`;
}

function keys(
  resource: CapabilityResource,
  actions: readonly CapabilityAction[],
): CapabilityKey[] {
  return actions.map((action) => key(resource, action));
}

function grant(scope: CapabilityScope, capabilities: CapabilityKey[]): RolePolicy {
  return Object.fromEntries(capabilities.map((capability) => [capability, scope])) as RolePolicy;
}

function combine(...policies: RolePolicy[]): RolePolicy {
  return Object.assign({}, ...policies.filter((policy): policy is Exclude<RolePolicy, 'all'> => policy !== 'all'));
}

const allCapabilityKeys = CAPABILITY_RESOURCES.flatMap((resource) =>
  CAPABILITY_ACTIONS.map((action) => key(resource, action)),
);

const baseReadCapabilities = [
  key('dashboard', 'read'),
  key('settings', 'read'),
];

const selfServiceSessionCapabilities = keys('session', ['read', 'manage']);

const rolePolicies: Record<NormalizedRole, RolePolicy> = {
  admin: 'all',
  gm: 'all',
  manager: combine(
    grant('all', [
      ...baseReadCapabilities,
      ...keys('customer', ['read', 'create', 'update', 'delete']),
      ...keys('supplier', ['read', 'create', 'update', 'delete']),
      ...keys('supplier_quote', ['read', 'create', 'update', 'delete']),
      ...keys('inventory', ['read', 'create', 'update', 'delete', 'manage', 'reconcile', 'export']),
      ...keys('certificate', ['read', 'issue']),
      ...keys('certificate_template', ['manage']),
      ...keys('workflow', ['read', 'manage']),
      ...keys('webhook', ['read', 'manage']),
      ...keys('agent', ['read', 'run', 'manage']),
      ...keys('model', ['read', 'manage']),
      ...keys('report', ['read', 'export']),
      ...keys('integration', ['read', 'manage']),
      ...keys('auction', ['read', 'create', 'update']),
      ...keys('consignment', ['read', 'create', 'update']),
      ...keys('fmv', ['read']),
      ...keys('blockchain', ['read']),
    ]),
    grant('department_or_own', [
      ...keys('rfq', ['read', 'create', 'update', 'transition']),
      ...keys('quotation', ['read', 'create', 'update', 'transition', 'approve', 'send', 'accept', 'withdraw', 'view_cost']),
      ...keys('order', ['read', 'create', 'update', 'transition', 'view_cost']),
    ]),
    grant('own', selfServiceSessionCapabilities),
  ),
  finance: combine(
    grant('all', [
      ...baseReadCapabilities,
      ...keys('quotation', ['read', 'view_cost']),
      ...keys('order', ['read', 'view_cost']),
      ...keys('report', ['read', 'export']),
      ...keys('customer', ['read']),
      ...keys('supplier', ['read']),
      ...keys('fmv', ['read']),
    ]),
    grant('own', selfServiceSessionCapabilities),
  ),
  sales: combine(
    grant('all', [
      ...baseReadCapabilities,
      ...keys('customer', ['read', 'create', 'update']),
      ...keys('supplier', ['read']),
      ...keys('supplier_quote', ['read', 'create', 'update']),
      ...keys('agent', ['read', 'run']),
      ...keys('certificate', ['read']),
    ]),
    grant('own', [
      ...keys('rfq', ['read', 'create', 'update', 'transition']),
      ...keys('quotation', ['read', 'create', 'update', 'transition', 'send', 'accept', 'withdraw']),
      ...keys('order', ['read']),
      ...selfServiceSessionCapabilities,
    ]),
  ),
  operator: combine(
    grant('all', [
      ...baseReadCapabilities,
      ...keys('inventory', ['read']),
      ...keys('order', ['read']),
      ...keys('certificate', ['read']),
    ]),
    grant('own', selfServiceSessionCapabilities),
  ),
  quality_manager: combine(
    grant('all', [
      ...baseReadCapabilities,
      ...keys('inventory', ['read']),
      ...keys('certificate', ['read', 'issue']),
      ...keys('certificate_template', ['manage']),
      ...keys('report', ['read']),
    ]),
    grant('own', selfServiceSessionCapabilities),
  ),
  viewer: combine(
    grant('all', [
      ...baseReadCapabilities,
      ...keys('report', ['read']),
    ]),
    grant('own', selfServiceSessionCapabilities),
  ),
};

export function normalizeRole(role?: string | null): NormalizedRole {
  const normalized = role?.trim().toLowerCase().replace(/[\s-]+/g, '_') ?? '';
  if (normalized === 'administrator') return 'admin';
  if (normalized === 'general_manager' || normalized === 'generalmanager') return 'gm';
  if (normalized === 'qualitymanager') return 'quality_manager';
  if (normalized in rolePolicies) return normalized as NormalizedRole;
  return 'viewer';
}

export function toCapabilityKey(resource: CapabilityResource, action: CapabilityAction): CapabilityKey {
  return key(resource, action);
}

export function getCapabilityScope(
  actor: CapabilityActor,
  capability: CapabilityKey,
): CapabilityScope | null {
  const policy = rolePolicies[normalizeRole(actor.role)];
  if (policy === 'all') return 'all';
  return policy[capability] ?? null;
}

function normalizeDepartment(department?: string | null): string | null {
  const normalized = department?.trim().toLocaleLowerCase();
  return normalized || null;
}

export function isCapabilityAllowed(
  actor: CapabilityActor,
  capability: CapabilityKey,
  resource?: CapabilityResourceContext,
): boolean {
  const scope = getCapabilityScope(actor, capability);
  if (!scope) return false;
  if (!resource || scope === 'all') return true;

  const isOwner = Boolean(resource.ownerId && resource.ownerId === actor.id);
  const actorDepartment = normalizeDepartment(actor.department);
  const resourceDepartment = normalizeDepartment(resource.department);
  const isSameDepartment = Boolean(actorDepartment && resourceDepartment && actorDepartment === resourceDepartment);

  switch (scope) {
    case 'own':
      return isOwner;
    case 'department':
      return isSameDepartment;
    case 'department_or_own':
      return isOwner || isSameDepartment;
    default:
      return false;
  }
}

export function getCapabilitiesForActor(actor: CapabilityActor): CapabilityGrant[] {
  return allCapabilityKeys.flatMap((capability) => {
    const scope = getCapabilityScope(actor, capability);
    return scope ? [{ capability, scope }] : [];
  });
}

export function hasCapability(
  actor: CapabilityActor,
  resource: CapabilityResource,
  action: CapabilityAction,
  context?: CapabilityResourceContext,
): boolean {
  return isCapabilityAllowed(actor, toCapabilityKey(resource, action), context);
}
