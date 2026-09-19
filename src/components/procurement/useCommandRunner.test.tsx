import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useCommandRunner } from './useCommandRunner';

describe('procurement uncertain command retries', () => {
  it('reuses the key after a lost response, including when another draft was attempted between retries', async () => {
    const { result } = renderHook(() => useCommandRunner());
    const failed = vi.fn().mockRejectedValue(new Error('Response lost'));
    await act(async () => { await expect(result.current.run('order-a:create:body-a', failed)).rejects.toThrow('Response lost'); });
    const firstKey = failed.mock.calls[0][0];
    await act(async () => { await expect(result.current.run('order-b:create:body-b', failed)).rejects.toThrow('Response lost'); });
    const succeeded = vi.fn().mockResolvedValue({ id: 'purchase-a' });
    await act(async () => { await result.current.run('order-a:create:body-a', succeeded); });
    expect(succeeded).toHaveBeenCalledWith(firstKey);
    expect(failed.mock.calls[1][0]).not.toBe(firstKey);
    await act(async () => { await result.current.run('order-a:create:body-a', succeeded); });
    expect(succeeded.mock.calls[1][0]).not.toBe(firstKey);
  });
  it('blocks a second click while the first request is pending', async () => {
    const { result } = renderHook(() => useCommandRunner());
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    let first!: Promise<void>;
    act(() => { first = result.current.run('same', () => pending); });
    const duplicate = vi.fn();
    await act(async () => { await expect(result.current.run('same', duplicate)).rejects.toThrow(); });
    expect(duplicate).not.toHaveBeenCalled(); expect(result.current.busy).toBe(true);
    await act(async () => { finish(); await first; });
    expect(result.current.busy).toBe(false);
  });
});
