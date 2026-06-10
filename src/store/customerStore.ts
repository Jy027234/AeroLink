import { create } from 'zustand';
import type { Customer } from '@/types';

interface CustomerState {
  customers: Customer[];
  selectedCustomer: Customer | null;
  setCustomers: (customers: Customer[]) => void;
  selectCustomer: (customer: Customer | null) => void;
  getActiveCustomers: () => Customer[];
  getAtRiskCustomers: () => Customer[];
}

export const useCustomerStore = create<CustomerState>((set, get) => ({
  customers: [],
  selectedCustomer: null,
  setCustomers: (customers) => set({ customers }),
  selectCustomer: (customer) => set({ selectedCustomer: customer }),
  getActiveCustomers: () =>
    get().customers.filter((customer) => customer.status === 'active'),
  getAtRiskCustomers: () =>
    get().customers.filter((customer) => customer.status === 'at_risk'),
}));