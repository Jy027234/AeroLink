import { create } from 'zustand';
import type { SupplierFollowUpLog } from '@/types';

interface SupplierFollowUpState {
  logs: SupplierFollowUpLog[];
  setLogs: (logs: SupplierFollowUpLog[]) => void;
  addLogs: (logs: SupplierFollowUpLog[]) => void;
  clearLogs: () => void;
}

export const useSupplierFollowUpStore = create<SupplierFollowUpState>((set) => ({
  logs: [],
  setLogs: (logs) => set({ logs }),
  addLogs: (logs) =>
    set((state) => ({
      logs: [
        ...logs,
        ...state.logs.filter(
          (existingLog) => !logs.some((incomingLog) => incomingLog.id === existingLog.id)
        ),
      ],
    })),
  clearLogs: () => set({ logs: [] }),
}));