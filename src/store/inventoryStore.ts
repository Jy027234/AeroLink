import { create } from 'zustand';
import type { Inventory } from '@/types';

interface InventoryState {
  inventory: Inventory[];
  searchQuery: string;
  selectedItems: Inventory[];
  setInventory: (inventory: Inventory[]) => void;
  setSearchQuery: (query: string) => void;
  toggleSelection: (item: Inventory) => void;
  clearSelection: () => void;
  searchInventory: (partNumber: string) => Inventory[];
  getByType: (type: Inventory['type']) => Inventory[];
}

export const useInventoryStore = create<InventoryState>((set, get) => ({
  inventory: [],
  searchQuery: '',
  selectedItems: [],
  setInventory: (inventory) => set({ inventory }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  toggleSelection: (item) =>
    set((state) => {
      const exists = state.selectedItems.find((selectedItem) => selectedItem.id === item.id);
      if (exists) {
        return {
          selectedItems: state.selectedItems.filter((selectedItem) => selectedItem.id !== item.id),
        };
      }

      return { selectedItems: [...state.selectedItems, item] };
    }),
  clearSelection: () => set({ selectedItems: [] }),
  searchInventory: (partNumber) =>
    get().inventory.filter((item) =>
      item.partNumber.toLowerCase().includes(partNumber.toLowerCase())
    ),
  getByType: (type) => get().inventory.filter((item) => item.type === type),
}));