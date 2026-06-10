import { create } from 'zustand';
import type { Quotation } from '@/types';

interface QuotationState {
  quotations: Quotation[];
  selectedQuotation: Quotation | null;
  setQuotations: (quotations: Quotation[]) => void;
  addQuotation: (quotation: Quotation) => void;
  updateQuotation: (quotation: Quotation) => void;
  selectQuotation: (quotation: Quotation | null) => void;
  getPendingApprovals: () => Quotation[];
  getByStatus: (status: Quotation['status']) => Quotation[];
}

export const useQuotationStore = create<QuotationState>((set, get) => ({
  quotations: [],
  selectedQuotation: null,
  setQuotations: (quotations) => set({ quotations }),
  addQuotation: (quotation) =>
    set((state) => ({ quotations: [quotation, ...state.quotations] })),
  updateQuotation: (quotation) =>
    set((state) => ({
      quotations: state.quotations.map((record) =>
        record.id === quotation.id ? quotation : record
      ),
    })),
  selectQuotation: (quotation) => set({ selectedQuotation: quotation }),
  getPendingApprovals: () =>
    get().quotations.filter((quotation) => quotation.status === 'pending_approval'),
  getByStatus: (status) =>
    get().quotations.filter((quotation) => quotation.status === status),
}));