import { create } from 'zustand';
import type { Inquiry } from '@/types';

interface InquiryState {
  inquiries: Inquiry[];
  selectedInquiry: Inquiry | null;
  setInquiries: (inquiries: Inquiry[]) => void;
  addInquiry: (inquiry: Inquiry) => void;
  selectInquiry: (inquiry: Inquiry | null) => void;
}

export const useInquiryStore = create<InquiryState>((set) => ({
  inquiries: [],
  selectedInquiry: null,
  setInquiries: (inquiries) => set({ inquiries }),
  addInquiry: (inquiry) =>
    set((state) => ({ inquiries: [inquiry, ...state.inquiries] })),
  selectInquiry: (inquiry) => set({ selectedInquiry: inquiry }),
}));