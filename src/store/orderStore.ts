import { create } from 'zustand';
import type { Order } from '@/types';

interface OrderState {
  orders: Order[];
  selectedOrder: Order | null;
  setOrders: (orders: Order[]) => void;
  addOrder: (order: Order) => void;
  updateOrder: (order: Order) => void;
  selectOrder: (order: Order | null) => void;
  getByStatus: (status: Order['status']) => Order[];
}

export const useOrderStore = create<OrderState>((set, get) => ({
  orders: [],
  selectedOrder: null,
  setOrders: (orders) => set({ orders }),
  addOrder: (order) => set((state) => ({ orders: [order, ...state.orders] })),
  updateOrder: (order) =>
    set((state) => ({
      orders: state.orders.map((record) => (record.id === order.id ? order : record)),
    })),
  selectOrder: (order) => set({ selectedOrder: order }),
  getByStatus: (status) => get().orders.filter((order) => order.status === status),
}));