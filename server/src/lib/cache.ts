/**
 * AeroLink 内存缓存层
 * 轻量级 TTL 缓存，用于减少数据库查询压力
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class Cache {
  private store = new Map<string, CacheEntry<unknown>>();
  private pending = new Map<string, Promise<unknown>>();
  private readonly defaultTTL: number;
  private readonly maxSize: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(defaultTTLSeconds = 60, maxSize = 10000) {
    this.defaultTTL = defaultTTLSeconds * 1000;
    this.maxSize = maxSize;
    // 定期清理过期条目（每5分钟）
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  /**
   * 获取缓存值
   */
  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    return entry.value as T;
  }

  /**
   * 设置缓存值
   * @param ttlSeconds 过期时间（秒），默认使用构造时设置的值
   */
  set<T>(key: string, value: T, ttlSeconds?: number): void {
    if (this.store.size >= this.maxSize && !this.store.has(key)) {
      const firstKey = this.store.keys().next().value;
      if (firstKey) {
        this.store.delete(firstKey);
      }
    }
    const ttl = (ttlSeconds ?? this.defaultTTL / 1000) * 1000;
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttl,
    });
  }

  /**
   * 删除指定缓存
   */
  del(key: string): boolean {
    return this.store.delete(key);
  }

  /**
   * 按前缀删除缓存（支持通配符清除）
   */
  delByPrefix(prefix: string): number {
    let count = 0;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * 检查缓存是否存在且未过期
   */
  has(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  /**
   * 获取或设置缓存
   */
  async getOrSet<T>(
    key: string,
    factory: () => Promise<T>,
    ttlSeconds?: number
  ): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) {
      return cached;
    }

    const existing = this.pending.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const promise = factory().then((value) => {
      this.set(key, value, ttlSeconds);
      this.pending.delete(key);
      return value;
    }).catch((err) => {
      this.pending.delete(key);
      throw err;
    });

    this.pending.set(key, promise as Promise<unknown>);
    return promise;
  }

  /**
   * 清空所有缓存
   */
  flush(): void {
    this.store.clear();
    this.pending.clear();
  }

  /**
   * 获取缓存统计
   */
  stats(): { size: number; keys: string[] } {
    return {
      size: this.store.size,
      keys: Array.from(this.store.keys()),
    };
  }

  /**
   * 清理过期条目
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  /**
   * 销毁缓存实例
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.store.clear();
    this.pending.clear();
  }
}

// 导出单例实例
export const cache = new Cache(60);

// 预定义常用缓存 TTL
export const CACHE_TTL = {
  DASHBOARD_STATS: 30,      // 30秒
  DASHBOARD_FUNNEL: 60,     // 1分钟
  DASHBOARD_ACTIVITIES: 15, // 15秒
  SUPPLIER_LIST: 300,       // 5分钟
  SUPPLIER_DETAIL: 300,     // 5分钟
  INVENTORY_LIST: 60,       // 1分钟
  INVENTORY_DETAIL: 120,    // 2分钟
  ORDER_LIST: 60,           // 1分钟
  ORDER_DETAIL: 60,         // 1分钟
  QUOTATION_LIST: 60,       // 1分钟
  QUOTATION_DETAIL: 60,     // 1分钟
  CUSTOMER_LIST: 300,       // 5分钟
  RFQ_LIST: 60,             // 1分钟
} as const;

// 预定义缓存键前缀
export const CACHE_KEY = {
  DASHBOARD_STATS: 'dashboard:stats',
  DASHBOARD_FUNNEL: 'dashboard:funnel',
  DASHBOARD_ACTIVITIES: 'dashboard:activities',
  SUPPLIER_LIST: 'suppliers:list',
  SUPPLIER_DETAIL: (id: string) => `suppliers:${id}`,
  INVENTORY_LIST: 'inventory:list',
  INVENTORY_DETAIL: (id: string) => `inventory:${id}`,
  ORDER_LIST: 'orders:list',
  ORDER_DETAIL: (id: string) => `orders:${id}`,
  QUOTATION_LIST: 'quotations:list',
  QUOTATION_DETAIL: (id: string) => `quotations:${id}`,
  CUSTOMER_LIST: 'customers:list',
  RFQ_LIST: 'rfqs:list',
} as const;
