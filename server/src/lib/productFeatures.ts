import { AppError } from '../middleware/errorHandler.js';

export const PRODUCT_FEATURE_KEYS = ['pricingBi', 'agentDemo'] as const;

export type ProductFeatureKey = (typeof PRODUCT_FEATURE_KEYS)[number];

export interface ProductFeatureStatus {
  key: ProductFeatureKey;
  enabled: boolean;
  defaultEnabled: boolean;
  environmentVariable: string;
  description: string;
}

type ProductFeatureDefinition = Omit<ProductFeatureStatus, 'enabled'>;

const PRODUCT_FEATURES: Record<ProductFeatureKey, ProductFeatureDefinition> = {
  pricingBi: {
    key: 'pricingBi',
    defaultEnabled: false,
    environmentVariable: 'FEATURE_PRICING_BI',
    description: '内部交易记录驱动的定价分析试验功能；不含外部市场或竞品数据。',
  },
  agentDemo: {
    key: 'agentDemo',
    defaultEnabled: false,
    environmentVariable: 'FEATURE_AGENT_DEMO',
    description: '仅限隔离演示环境的 Agent 样例任务；不得在真实业务环境启用。',
  },
};

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === '') return defaultValue;
  return value.trim().toLowerCase() === 'true';
}

export function getProductFeatureStatus(key: ProductFeatureKey): ProductFeatureStatus {
  const definition = PRODUCT_FEATURES[key];
  return {
    ...definition,
    enabled: parseBoolean(process.env[definition.environmentVariable], definition.defaultEnabled),
  };
}

export function getProductFeatureStatuses(): ProductFeatureStatus[] {
  return PRODUCT_FEATURE_KEYS.map((key) => getProductFeatureStatus(key));
}

export function isProductFeatureEnabled(key: ProductFeatureKey): boolean {
  return getProductFeatureStatus(key).enabled;
}

export function assertProductFeatureEnabled(key: ProductFeatureKey): void {
  const feature = getProductFeatureStatus(key);
  if (!feature.enabled) {
    throw new AppError(
      `功能“${feature.key}”当前未在此环境启用`,
      403,
      'FEATURE_DISABLED'
    );
  }
}
