import { create } from 'zustand';
import { authApi } from '@/api/client';
import {
  hasCapability,
  type CapabilityGrant,
  type CapabilitySnapshot,
} from '@/lib/capabilities';

interface CapabilityState {
  grants: CapabilityGrant[];
  role: string | null;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  clear: () => void;
  can: (capability?: string) => boolean;
}

let pendingLoad: Promise<void> | null = null;
let capabilityGeneration = 0;

export const useCapabilityStore = create<CapabilityState>((set, get) => ({
  grants: [],
  role: null,
  loaded: false,
  loading: false,
  error: null,
  load: async () => {
    if (!pendingLoad) {
      const generation = capabilityGeneration;
      set({ loading: true, error: null });
      const loadPromise = authApi.getCapabilities()
        .then((snapshot: CapabilitySnapshot) => {
          if (generation !== capabilityGeneration) return;
          set({
            grants: snapshot.grants,
            role: snapshot.role,
            loaded: true,
            loading: false,
            error: null,
          });
        })
        .catch((error: unknown) => {
          if (generation !== capabilityGeneration) return;
          set({
            grants: [],
            role: null,
            loaded: true,
            loading: false,
            error: error instanceof Error ? error.message : '无法加载权限能力',
          });
        })
        .finally(() => {
          if (pendingLoad === loadPromise) {
            pendingLoad = null;
          }
        });
      pendingLoad = loadPromise;
    }

    await pendingLoad;
  },
  clear: () => {
    capabilityGeneration += 1;
    pendingLoad = null;
    set({ grants: [], role: null, loaded: false, loading: false, error: null });
  },
  can: (capability?: string) => hasCapability(get().grants, capability),
}));
