import { create } from 'zustand';
import type { Email } from '@/types';

interface EmailState {
  emails: Email[];
  selectedEmail: Email | null;
  filter: 'all' | 'aog' | 'standard' | 'inquiry' | 'spam';
  setEmails: (emails: Email[]) => void;
  selectEmail: (email: Email | null) => void;
  setFilter: (filter: 'all' | 'aog' | 'standard' | 'inquiry' | 'spam') => void;
  markAsRead: (emailId: string) => void;
  classifyEmail: (emailId: string, type: Email['type']) => void;
}

export const useEmailStore = create<EmailState>((set) => ({
  emails: [],
  selectedEmail: null,
  filter: 'all',
  setEmails: (emails) => set({ emails }),
  selectEmail: (email) => set({ selectedEmail: email }),
  setFilter: (filter) => set({ filter }),
  markAsRead: (emailId) =>
    set((state) => ({
      emails: state.emails.map((email) =>
        email.id === emailId ? { ...email, isRead: true } : email
      ),
    })),
  classifyEmail: (emailId, type) =>
    set((state) => ({
      emails: state.emails.map((email) =>
        email.id === emailId ? { ...email, type } : email
      ),
    })),
}));