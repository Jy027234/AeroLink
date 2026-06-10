import { mockSupplierPortalUsers } from '@/data/mockData';
import type { Supplier } from '@/types';
import type { AgentData, QuoteCandidate, SupplierSummary } from '@/types/agent';

export type SupplierAutomationMode = 'auto' | 'manual' | 'blocked';
export type SupplierManualActionType = 'portal_follow_up' | 'wechat_follow_up' | 'whatsapp_follow_up' | 'phone_follow_up' | 'contact_missing';

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
  return status?.toLowerCase() || 'active';
}

function getNormalizedPhone(phone?: string) {
  return (phone || '').replace(/[\s()-]/g, '');
}

function getManualActionType(supplier: Supplier, automationMode: SupplierAutomationMode): SupplierManualActionType | undefined {
  if (automationMode !== 'manual') {
    return undefined;
  }

  const hasPortalUser = mockSupplierPortalUsers.some((portalUser) => portalUser.supplierId === supplier.id);
  if (hasPortalUser) {
    return 'portal_follow_up';
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
  const isBlocked = status === 'inactive' || status === 'blocked';

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

  const performanceWeight = clamp(supplier.performanceScore ?? 65, 0, 100) * 0.28;
  const leadTimeWeight = typeof supplier.leadTime === 'number'
    ? Math.max(4, 18 - supplier.leadTime / 2)
    : 8;
  const automationBonus = automationMode === 'auto' ? 18 : automationMode === 'manual' ? 10 : 0;
  const statusPenalty = status === 'pending' ? 4 : isBlocked ? 35 : 0;

  const readinessScore = Math.round(
    Math.max(
      0,
      (levelWeight[supplier.level] || levelWeight.C) +
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
  const pool = reachable.length > 0 ? reachable : ranked;
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

export function synthesizeSupplierQuotes(
  profiles: SupplierCapabilityProfile[],
  context: AgentData
): QuoteCandidate[] {
  const quantity = typeof context.parsedData?.quantity === 'number' ? context.parsedData.quantity : 1;
  const urgency = String(context.parsedData?.urgency || '').toLowerCase();
  const urgencyFactor = urgency === 'aog' ? 0.97 : 1;

  return profiles
    .filter((profile) => profile.automationMode !== 'blocked')
    .map((profile, index) => {
      const performance = clamp(profile.supplier.performanceScore ?? 72, 50, 100);
      const basePrice = 980 + index * 55 + (100 - performance) * 2 + (profile.level === 'S' ? -25 : profile.level === 'A' ? 0 : 45);
      const unitPrice = Math.round(basePrice * urgencyFactor);
      const leadTimeDays = Math.max(
        2,
        Math.round((profile.supplier.leadTime ?? (profile.automationMode === 'auto' ? 7 : 10)) + index - (profile.automationMode === 'auto' ? 1 : 0))
      );

      return {
        id: `quote_${profile.id}`,
        supplierId: profile.id,
        unitPrice,
        totalPrice: unitPrice * quantity,
        leadTimeDays,
        supplier: {
          id: profile.id,
          name: profile.name,
          level: profile.level,
          email: profile.email,
          phone: profile.phone,
          status: profile.status,
          performanceScore: profile.performanceScore,
          automationMode: profile.automationMode,
          preferredChannel: profile.preferredChannel,
          manualActionType: profile.manualActionType,
          profileCompleteness: profile.profileCompleteness,
          nextAction: profile.nextAction,
        },
      };
    });
}