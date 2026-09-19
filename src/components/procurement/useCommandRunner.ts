import { useRef, useState } from 'react';
import { newCommandKey } from '@/lib/commandKey';

/** Keep uncertain requests replayable. Signature includes the target and exact body. */
export function useCommandRunner() {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const keys = useRef(new Map<string, string>());
  async function run<T>(signature: string, operation: (key: string) => Promise<T>): Promise<T> {
    if (running.current) throw new Error('另一项操作正在进行，请稍候');
    const key = keys.current.get(signature) ?? newCommandKey();
    keys.current.set(signature, key);
    running.current = true; setBusy(true);
    try {
      const result = await operation(key);
      keys.current.delete(signature);
      return result;
    } finally { running.current = false; setBusy(false); }
  }
  return { busy, run };
}
