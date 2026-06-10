import { create } from 'zustand';
import type { Supplier } from '@/types';

interface SupplierState {
  suppliers: Supplier[];
  selectedSupplier: Supplier | null;
  setSuppliers: (suppliers: Supplier[]) => void;
  selectSupplier: (supplier: Supplier | null) => void;
  getByLevel: (level: Supplier['level']) => Supplier[];
}

export const useSupplierStore = create<SupplierState>((set, get) => ({
  suppliers: [],
  selectedSupplier: null,
  setSuppliers: (suppliers) => set({ suppliers }),
  selectSupplier: (supplier) => set({ selectedSupplier: supplier }),
  getByLevel: (level) => get().suppliers.filter((supplier) => supplier.level === level),
}));