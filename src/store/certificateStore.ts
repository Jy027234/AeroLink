import { create } from 'zustand';
import type { Certificate, CertificateTemplate } from '@/types';

interface CertificateState {
  certificates: Certificate[];
  templates: CertificateTemplate[];
  selectedCertificate: Certificate | null;
  selectedTemplate: CertificateTemplate | null;
  setCertificates: (certificates: Certificate[]) => void;
  setTemplates: (templates: CertificateTemplate[]) => void;
  selectCertificate: (certificate: Certificate | null) => void;
  selectTemplate: (template: CertificateTemplate | null) => void;
  addCertificate: (certificate: Certificate) => void;
  updateCertificate: (certificate: Certificate) => void;
  addTemplate: (template: CertificateTemplate) => void;
  updateTemplate: (template: CertificateTemplate) => void;
  removeTemplate: (id: string) => void;
  getByStatus: (status: Certificate['status']) => Certificate[];
  getByType: (type: Certificate['certificateType']) => Certificate[];
}

export const useCertificateStore = create<CertificateState>((set, get) => ({
  certificates: [],
  templates: [],
  selectedCertificate: null,
  selectedTemplate: null,
  setCertificates: (certificates) => set({ certificates }),
  setTemplates: (templates) => set({ templates }),
  selectCertificate: (certificate) => set({ selectedCertificate: certificate }),
  selectTemplate: (template) => set({ selectedTemplate: template }),
  addCertificate: (certificate) =>
    set((state) => ({ certificates: [certificate, ...state.certificates] })),
  updateCertificate: (certificate) =>
    set((state) => ({
      certificates: state.certificates.map((c) => (c.id === certificate.id ? certificate : c)),
    })),
  addTemplate: (template) =>
    set((state) => ({ templates: [template, ...state.templates] })),
  updateTemplate: (template) =>
    set((state) => ({
      templates: state.templates.map((t) => (t.id === template.id ? template : t)),
    })),
  removeTemplate: (id) =>
    set((state) => ({
      templates: state.templates.filter((t) => t.id !== id),
    })),
  getByStatus: (status) => get().certificates.filter((c) => c.status === status),
  getByType: (type) => get().certificates.filter((c) => c.certificateType === type),
}));
