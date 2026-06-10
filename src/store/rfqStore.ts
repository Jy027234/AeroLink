import { create } from 'zustand';
import type { RFQ } from '@/types';

interface RFQState {
  rfqs: RFQ[];
  selectedRFQ: RFQ | null;
  setRFQs: (rfqs: RFQ[]) => void;
  addRFQ: (rfq: RFQ) => void;
  updateRFQ: (rfq: RFQ) => void;
  selectRFQ: (rfq: RFQ | null) => void;
  getRFQsByStatus: (status: RFQ['status']) => RFQ[];
}

export const useRFQStore = create<RFQState>((set, get) => ({
  rfqs: [],
  selectedRFQ: null,
  setRFQs: (rfqs) => set({ rfqs }),
  addRFQ: (rfq) => set((state) => ({ rfqs: [rfq, ...state.rfqs] })),
  updateRFQ: (rfq) =>
    set((state) => ({
      rfqs: state.rfqs.map((record) => (record.id === rfq.id ? rfq : record)),
    })),
  selectRFQ: (rfq) => set({ selectedRFQ: rfq }),
  getRFQsByStatus: (status) => get().rfqs.filter((rfq) => rfq.status === status),
}));