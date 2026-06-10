import { create } from 'zustand';
import type { DashboardStats } from '@/types';

interface DashboardState {
  stats: DashboardStats | null;
  salesFunnel: { stage: string; count: number; amount: number }[];
  customerAlerts: { customerId: string; customerName: string; daysSinceQuote: number; quoteNumber: string }[];
  inventoryAlerts: { partNumber: string; currentStock: number; safetyStock: number; warehouse: string }[];
  setStats: (stats: DashboardStats) => void;
  setSalesFunnel: (funnel: { stage: string; count: number; amount: number }[]) => void;
  setCustomerAlerts: (alerts: { customerId: string; customerName: string; daysSinceQuote: number; quoteNumber: string }[]) => void;
  setInventoryAlerts: (alerts: { partNumber: string; currentStock: number; safetyStock: number; warehouse: string }[]) => void;
}

export const useDashboardStore = create<DashboardState>((set) => ({
  stats: null,
  salesFunnel: [],
  customerAlerts: [],
  inventoryAlerts: [],
  setStats: (stats) => set({ stats }),
  setSalesFunnel: (salesFunnel) => set({ salesFunnel }),
  setCustomerAlerts: (customerAlerts) => set({ customerAlerts }),
  setInventoryAlerts: (inventoryAlerts) => set({ inventoryAlerts }),
}));