import type { CertificateType, ConditionCode } from '@/types';

export const statusConfig: Record<ConditionCode, { label: string; color: string; bgColor: string }> = {
  NE: { label: 'New', color: 'text-green-600', bgColor: 'bg-green-50' },
  NS: { label: 'New Surplus', color: 'text-emerald-600', bgColor: 'bg-emerald-50' },
  OH: { label: 'Overhaul', color: 'text-blue-600', bgColor: 'bg-blue-50' },
  SV: { label: 'Serviceable', color: 'text-cyan-600', bgColor: 'bg-cyan-50' },
  AR: { label: 'As Removed', color: 'text-yellow-600', bgColor: 'bg-yellow-50' },
  RP: { label: 'Repairable', color: 'text-orange-600', bgColor: 'bg-orange-50' },
  US: { label: 'Unserviceable', color: 'text-red-600', bgColor: 'bg-red-50' },
  FN: { label: 'Factory New', color: 'text-purple-600', bgColor: 'bg-purple-50' },
};

export const certConfig: Record<CertificateType, { label: string; color: string }> = {
  'AAC-038': { label: 'AAC-038', color: 'text-green-600' },
  'FAA-8130-3': { label: 'FAA 8130-3', color: 'text-green-600' },
  'EASA-Form-1': { label: 'EASA Form 1', color: 'text-green-600' },
  COC: { label: 'COC', color: 'text-blue-600' },
  NONE: { label: 'None', color: 'text-red-600' },
};

const defaultStatusConfig = {
  label: 'Unknown',
  color: 'text-gray-600',
  bgColor: 'bg-gray-50',
};

const defaultCertConfig = {
  label: 'Unknown',
  color: 'text-gray-600',
};

/**
 * Production data can contain legacy/forward-compatible values that are not
 * yet represented in the UI maps. Keep those rows renderable instead of
 * letting an unmapped value crash the whole inventory page.
 */
export function getStatusConfig(conditionCode?: string | null) {
  const config = conditionCode ? statusConfig[conditionCode as ConditionCode] : undefined;
  return config ?? { ...defaultStatusConfig, label: conditionCode || defaultStatusConfig.label };
}

export function getCertConfig(certificateType?: string | null) {
  const config = certificateType ? certConfig[certificateType as CertificateType] : undefined;
  return config ?? { ...defaultCertConfig, label: certificateType || defaultCertConfig.label };
}
