import { create } from 'zustand';
import {
  DEFAULT_PAGE,
  getPathnameForPage,
  normalizePageId,
  resolvePageFromPathname,
} from '@/lib/pageRoutes';

interface SetCurrentPageOptions {
  replaceHistory?: boolean;
  syncUrl?: boolean;
}

function syncPageUrl(pageId: string, replaceHistory = false): void {
  if (typeof window === 'undefined') {
    return;
  }

  const nextPathname = getPathnameForPage(pageId);
  if (window.location.pathname === nextPathname) {
    return;
  }

  const historyState = {
    ...(window.history.state ?? {}),
    aerolinkPage: pageId,
  };

  if (replaceHistory) {
    window.history.replaceState(historyState, '', nextPathname);
    return;
  }

  window.history.pushState(historyState, '', nextPathname);
}

const initialCurrentPage =
  typeof window === 'undefined'
    ? DEFAULT_PAGE
    : resolvePageFromPathname(window.location.pathname);

interface UIState {
  sidebarCollapsed: boolean;
  mobileSidebarOpen: boolean;
  currentPage: string;
  inventorySearchPreset: string;
  modalOpen: boolean;
  modalContent: string | null;
  toggleSidebar: () => void;
  setMobileSidebarOpen: (open: boolean) => void;
  setCurrentPage: (page: string, options?: SetCurrentPageOptions) => void;
  setInventorySearchPreset: (query: string) => void;
  clearInventorySearchPreset: () => void;
  openModal: (content: string) => void;
  closeModal: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  sidebarCollapsed: false,
  mobileSidebarOpen: false,
  currentPage: initialCurrentPage,
  inventorySearchPreset: '',
  modalOpen: false,
  modalContent: null,
  toggleSidebar: () =>
    set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  setMobileSidebarOpen: (open) => set({ mobileSidebarOpen: open }),
  setCurrentPage: (page, options = {}) =>
    set((state) => {
      const nextPage = normalizePageId(page);

      if (options.syncUrl !== false) {
        syncPageUrl(nextPage, options.replaceHistory === true);
      }

      if (state.currentPage === nextPage) {
        return state;
      }

      return { currentPage: nextPage };
    }),
  setInventorySearchPreset: (query) => set({ inventorySearchPreset: query }),
  clearInventorySearchPreset: () => set({ inventorySearchPreset: '' }),
  openModal: (content) => set({ modalOpen: true, modalContent: content }),
  closeModal: () => set({ modalOpen: false, modalContent: null }),
}));