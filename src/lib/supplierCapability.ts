import type { Supplier } from '@/types';
import type { SupplierSummary } from '@/types/agent';

export type SupplierAutomationMode = 'auto' | 'manual' | 'blocked';
export type SupplierManualActionType = 'recorded_contact_follow_up' | 'wechat_follow_up' | 'whatsapp_follow_up' | 'phone_follow_up' | 'contact_missing';

export interface SupplierCapabilityProfile extends SupplierSummary {
  supplier: Supplier;
  automationMode: SupplierAutomationMode;
  preferredChannel: 'email' | 'phone' | 'manual';
  manualActionType?: SupplierManualActionType;
  availableChannels: Array<'email' | 'phone'>;
  profileCompleteness: number;
  readinessScore: number;
  nextAction: string;
}

const levelWeight: Record<NonNullable<Supplier['level']>, number> = {
  S: 30,
  A: 24,
  B: 14,
  C: 6,
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getNormalizedStatus(status?: string) {
  return status?.toLowerCase() || 'unknown';
}

function getNormalizedPhone(phone?: string) {
  return (phone || '').replace(/[\s()-]/g, '');
}

function getManualActionType(supplier: Supplier, automationMode: SupplierAutomationMode): SupplierManualActionType | undefined {
  if (automationMode !== 'manual') {
    return undefined;
  }

  const normalizedPhone = getNormalizedPhone(supplier.phone);
  if (!normalizedPhone) {
    return 'contact_missing';
  }

  if (normalizedPhone.startsWith('+86') || normalizedPhone.startsWith('86')) {
    return 'wechat_follow_up';
  }

  if (normalizedPhone.startsWith('+')) {
    return 'whatsapp_follow_up';
  }

  return 'phone_follow_up';
}

export function getSupplierCapabilityProfile(supplier: Supplier): SupplierCapabilityProfile {
  const hasEmail = Boolean(supplier.email?.trim());
  const hasPhone = Boolean(supplier.phone?.trim());
  const status = getNormalizedStatus(supplier.status);
  const isBlocked = status === 'inactive' || status === 'blocked' || status === 'unknown';

  let automationMode: SupplierAutomationMode = 'blocked';
  if (!isBlocked && hasEmail) {
    automationMode = 'auto';
  } else if (!isBlocked && hasPhone) {
    automationMode = 'manual';
  }

  const availableChannels: Array<'email' | 'phone'> = [];
  if (hasEmail) availableChannels.push('email');
  if (hasPhone) availableChannels.push('phone');
  const manualActionType = getManualActionType(supplier, automationMode);

  const completenessSignals = [
    Boolean(supplier.contactName?.trim()),
    hasEmail || hasPhone,
    Boolean(supplier.address?.trim()),
    Boolean(supplier.paymentTerms?.trim()),
    typeof supplier.leadTime === 'number',
    typeof supplier.performanceScore === 'number',
  ];

  const profileCompleteness = Math.round(
    (completenessSignals.filter(Boolean).length / completenessSignals.length) * 100
  );

  const performanceWeight = typeof supplier.performanceScore === 'number'
    ? clamp(supplier.performanceScore, 0, 100) * 0.28
    : 0;
  const leadTimeWeight = typeof supplier.leadTime === 'number'
    ? Math.max(4, 18 - supplier.leadTime / 2)
    : 0;
  const automationBonus = automationMode === 'auto' ? 18 : automationMode === 'manual' ? 10 : 0;
  const statusPenalty = status === 'pending' ? 4 : isBlocked ? 35 : 0;
  const recordedLevelWeight = supplier.level ? levelWeight[supplier.level] : 0;

  const readinessScore = Math.round(
    Math.max(
      0,
      recordedLevelWeight +
        performanceWeight +
        leadTimeWeight +
        profileCompleteness * 0.18 +
        automationBonus -
        statusPenalty
    )
  );

  let nextAction = 'complete_profile';
  if (automationMode === 'auto') {
    nextAction = status === 'pending' ? 'activate_and_send' : 'auto_inquiry_ready';
  } else if (automationMode === 'manual') {
    nextAction = manualActionType || 'manual_follow_up';
  } else if (isBlocked) {
    nextAction = 'reactivate_supplier';
  }

  return {
    id: supplier.id,
    name: supplier.name,
    level: supplier.level,
    email: supplier.email,
    phone: supplier.phone,
    status: supplier.status,
    performanceScore: supplier.performanceScore,
    automationMode,
    preferredChannel: hasEmail ? 'email' : hasPhone ? 'phone' : 'manual',
    manualActionType,
    availableChannels,
    profileCompleteness,
    readinessScore,
    nextAction,
    supplier,
  };
}

function compareProfiles(a: SupplierCapabilityProfile, b: SupplierCapabilityProfile) {
  const modeWeight: Record<SupplierAutomationMode, number> = {
    auto: 3,
    manual: 2,
    blocked: 1,
  };

  if (modeWeight[a.automationMode] !== modeWeight[b.automationMode]) {
    return modeWeight[b.automationMode] - modeWeight[a.automationMode];
  }

  if (a.readinessScore !== b.readinessScore) {
    return b.readinessScore - a.readinessScore;
  }

  return (a.supplier.leadTime ?? 999) - (b.supplier.leadTime ?? 999);
}

export function selectSuppliersForSourcing(suppliers: Supplier[], limit = 3): SupplierCapabilityProfile[] {
  const ranked = suppliers.map(getSupplierCapabilityProfile).sort(compareProfiles);
  const reachable = ranked.filter((profile) => profile.automationMode !== 'blocked');
  const pool = reachable;
  if (pool.length === 0) {
    return [];
  }
  const normalizedLimit = Math.max(1, Math.min(limit, pool.length));

  const autoProfiles = pool.filter((profile) => profile.automationMode === 'auto');
  const manualProfiles = pool.filter((profile) => profile.automationMode === 'manual');

  if (manualProfiles.length === 0 || normalizedLimit === 1) {
    return pool.slice(0, normalizedLimit);
  }

  const selected: SupplierCapabilityProfile[] = [];
  const autoTarget = autoProfiles.length > 0 ? Math.min(autoProfiles.length, normalizedLimit - 1) : 0;

  selected.push(...autoProfiles.slice(0, autoTarget));
  selected.push(manualProfiles[0]);

  const remaining = pool.filter((profile) => !selected.some((item) => item.id === profile.id));
  selected.push(...remaining.slice(0, normalizedLimit - selected.length));

  return selected;
}

export function buildInquiryDispatchSummary(profiles: SupplierCapabilityProfile[]) {
  const autoDispatchCount = profiles.filter((profile) => profile.automationMode === 'auto').length;
  const manualFollowUpCount = profiles.filter((profile) => profile.automationMode === 'manual').length;
  const blockedCount = profiles.filter((profile) => profile.automationMode === 'blocked').length;

  return {
    total: profiles.length,
    autoDispatchCount,
    manualFollowUpCount,
    blockedCount,
    suppliersNotified: autoDispatchCount + manualFollowUpCount,
    autoDispatchReady: autoDispatchCount > 0,
  };
}
