import { create } from 'zustand';
import type { Approval } from '@/types';

interface ApprovalState {
  approvals: Approval[];
  pendingCount: number;
  setApprovals: (approvals: Approval[]) => void;
  addApproval: (approval: Approval) => void;
  getPendingByUser: (userId: string) => Approval[];
}

export const useApprovalStore = create<ApprovalState>((set, get) => ({
  approvals: [],
  pendingCount: 0,
  setApprovals: (approvals) =>
    set({
      approvals,
      pendingCount: approvals.filter((approval) => !approval.action).length,
    }),
  addApproval: (approval) =>
    set((state) => ({ approvals: [approval, ...state.approvals] })),
  getPendingByUser: (userId) =>
    get().approvals.filter((approval) => approval.approverId === userId && !approval.action),
}));