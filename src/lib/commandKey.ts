export function newCommandKey() {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID() : `aerolink-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
