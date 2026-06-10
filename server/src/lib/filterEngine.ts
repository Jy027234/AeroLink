/**
 * Phase 2: Advanced Filter Engine
 * 
 * 支持复杂的事件过滤规则，包括:
 * - 多种操作符 (in, not_in, equals, gt, lt, contains, regex 等)
 * - 逻辑组合 (AND, OR, NOT)
 * - 动态规则编译和缓存
 */

export type FilterOperator = 
  | 'in'          // 值在数组中
  | 'not_in'      // 值不在数组中
  | 'equals'      // 完全相等
  | 'not_equals'  // 不相等
  | 'gt'          // 大于
  | 'gte'         // 大于等于
  | 'lt'          // 小于
  | 'lte'         // 小于等于
  | 'contains'    // 字符串包含
  | 'not_contains'// 字符串不包含
  | 'regex'       // 正则匹配
  | 'exists'      // 字段存在
  | 'not_exists'; // 字段不存在

export type FilterLogic = 'AND' | 'OR' | 'NOT';

export interface FilterRule {
  field: string;
  operator: FilterOperator;
  value?: unknown;
}

export interface FilterGroup {
  logic: FilterLogic;
  rules: (FilterRule | FilterGroup)[];
}

export interface FilterConfig {
  logic: FilterLogic;
  rules: (FilterRule | FilterGroup)[];
}

type FilterPayload = Record<string, unknown>;

/**
 * 编译后的过滤函数
 */
type CompiledFilter = (payload: FilterPayload) => boolean;

/**
 * 过滤引擎
 * 
 * 示例使用:
 * ```typescript
 * const engine = new FilterEngine();
 * 
 * // 编译过滤规则
 * const filter: FilterConfig = {
 *   logic: 'AND',
 *   rules: [
 *     { field: 'urgency', operator: 'in', value: ['AOG', 'STOCK'] },
 *     { field: 'quantity', operator: 'gt', value: 100 },
 *     {
 *       logic: 'OR',
 *       rules: [
 *         { field: 'partNumber', operator: 'regex', value: '^SN72.*' },
 *         { field: 'partNumber', operator: 'regex', value: '^SN73.*' }
 *       ]
 *     }
 *   ]
 * };
 * 
 * const compiledFilter = engine.compile(filter);
 * 
 * // 评估 payload
 * const shouldDeliver = compiledFilter({
 *   urgency: 'AOG',
 *   quantity: 150,
 *   partNumber: 'SN72-5001-11-01'
 * }); // true
 * ```
 */
export class FilterEngine {
  private cache: Map<string, CompiledFilter> = new Map();

  /**
   * 编译过滤规则为可执行函数
   */
  compile(config: FilterConfig): CompiledFilter {
    // 生成缓存键
    const cacheKey = JSON.stringify(config);
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    // 编译规则
    const compiled = this.compileGroup(config);

    // 缓存
    this.cache.set(cacheKey, compiled);

    return compiled;
  }

  /**
   * 编译规则组 (支持嵌套)
   */
  private compileGroup(group: FilterGroup): CompiledFilter {
    const rules = group.rules.map(rule =>
      'field' in rule ? this.compileRule(rule) : this.compileGroup(rule)
    );

    switch (group.logic) {
      case 'AND':
        return (payload: FilterPayload) => rules.every(r => r(payload));
      case 'OR':
        return (payload: FilterPayload) => rules.some(r => r(payload));
      case 'NOT':
        return (payload: FilterPayload) => !rules.every(r => r(payload));
      default:
        throw new Error(`Unknown logic: ${group.logic}`);
    }
  }

  /**
   * 编译单个规则
   */
  private compileRule(rule: FilterRule): CompiledFilter {
    const { field, operator, value } = rule;

    return (payload: FilterPayload) => {
      const fieldValue = this.getNestedValue(payload, field);

      switch (operator) {
        case 'in':
          return Array.isArray(value) && value.includes(fieldValue);

        case 'not_in':
          return !Array.isArray(value) || !value.includes(fieldValue);

        case 'equals':
          return fieldValue === value;

        case 'not_equals':
          return fieldValue !== value;

        case 'gt':
          return typeof fieldValue === 'number' && typeof value === 'number' && fieldValue > value;

        case 'gte':
          return typeof fieldValue === 'number' && typeof value === 'number' && fieldValue >= value;

        case 'lt':
          return typeof fieldValue === 'number' && typeof value === 'number' && fieldValue < value;

        case 'lte':
          return typeof fieldValue === 'number' && typeof value === 'number' && fieldValue <= value;

        case 'contains':
          return typeof fieldValue === 'string' && typeof value === 'string' && fieldValue.includes(value);

        case 'not_contains':
          return typeof fieldValue === 'string' && typeof value === 'string' && !fieldValue.includes(value);

        case 'regex':
          try {
            if (typeof value !== 'string') {
              return false;
            }
            const regex = new RegExp(value);
            return typeof fieldValue === 'string' && regex.test(fieldValue);
          } catch {
            console.warn(`Invalid regex: ${value}`);
            return false;
          }

        case 'exists':
          return fieldValue !== undefined && fieldValue !== null;

        case 'not_exists':
          return fieldValue === undefined || fieldValue === null;

        default:
          throw new Error(`Unknown operator: ${operator}`);
      }
    };
  }

  /**
   * 获取嵌套的对象值 (支持点号路径)
   * 例如: 'user.profile.age' 会访问 payload.user.profile.age
   */
  private getNestedValue(obj: FilterPayload, path: string): unknown {
    const keys = path.split('.');
    let current: unknown = obj;

    for (const key of keys) {
      if (current && typeof current === 'object' && key in current) {
        current = (current as Record<string, unknown>)[key];
      } else {
        return undefined;
      }
    }

    return current;
  }

  /**
   * 评估 payload (便捷方法)
   */
  evaluate(config: FilterConfig, payload: FilterPayload): boolean {
    const filter = this.compile(config);
    return filter(payload);
  }

  /**
   * 清空缓存 (用于测试或内存管理)
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * 获取缓存统计
   */
  getCacheStats(): { size: number; hits: number } {
    return { size: this.cache.size, hits: 0 }; // hits 需要单独追踪
  }
}

export const filterEngine = new FilterEngine();

/**
 * 将 MVP 的简单过滤格式迁移到新格式
 * 
 * 旧格式:
 * { urgency: ['AOG'], status: ['PENDING'] }
 * 
 * 新格式:
 * {
 *   logic: 'AND',
 *   rules: [
 *     { field: 'urgency', operator: 'in', value: ['AOG'] },
 *     { field: 'status', operator: 'in', value: ['PENDING'] }
 *   ]
 * }
 */
export function migrateSimpleFilter(
  oldFilters: Record<string, unknown>
): FilterConfig {
  const rules: FilterRule[] = [];

  for (const [field, value] of Object.entries(oldFilters)) {
    if (Array.isArray(value)) {
      rules.push({
        field,
        operator: 'in',
        value
      });
    } else {
      rules.push({
        field,
        operator: 'equals',
        value
      });
    }
  }

  return {
    logic: 'AND',
    rules
  };
}

/**
 * 验证过滤配置的合法性
 */
export function validateFilterConfig(config: FilterConfig): string[] {
  const errors: string[] = [];

  if (!config.logic || !['AND', 'OR', 'NOT'].includes(config.logic)) {
    errors.push('Invalid logic operator');
  }

  if (!Array.isArray(config.rules)) {
    errors.push('Rules must be an array');
  }

  // 递归验证规则
  config.rules.forEach((rule, index) => {
    if ('field' in rule) {
      if (!rule.field || typeof rule.field !== 'string') {
        errors.push(`Rule ${index}: field must be a non-empty string`);
      }
      if (!rule.operator || typeof rule.operator !== 'string') {
        errors.push(`Rule ${index}: operator is required`);
      }
      // 某些操作符需要有 value
      if (['in', 'not_in', 'equals', 'gt', 'lt', 'contains', 'regex'].includes(rule.operator) &&
          rule.value === undefined) {
        errors.push(`Rule ${index}: operator ${rule.operator} requires a value`);
      }
    } else if ('logic' in rule) {
      // 嵌套规则组
      const nestedErrors = validateFilterConfig(rule as FilterConfig);
      errors.push(...nestedErrors.map(e => `Rule ${index}: ${e}`));
    } else {
      errors.push(`Rule ${index}: must be either a rule or a group`);
    }
  });

  return errors;
}
