import type { ApprovalWorkflow, UserProfile } from './types';

export const mockUsers: UserProfile[] = [
  { id: 'u001', name: 'Michael Zhang', email: 'zhang@aerolink.com', role: 'manager', department: '销售部', phone: '+86-138-0000-0001', lastLoginAt: '2026-04-02T08:30:00Z' },
  { id: 'u002', name: 'Linda Li', email: 'li@aerolink.com', role: 'finance', department: 'Finance', phone: '+86-138-0000-0002' },
  { id: 'u003', name: 'Victor Wang', email: 'wang@aerolink.com', role: 'gm', department: 'Executive Office' },
  { id: 'u004', name: 'Kevin Chen', email: 'chen@aerolink.com', role: 'sales', department: '销售部' },
  { id: 'u005', name: 'Anna Zhao', email: 'zhao@aerolink.com', role: 'sales', department: '销售部' },
];

export const mockWorkflows: ApprovalWorkflow[] = [
  {
    id: 'wf001',
    name: 'Standard Quote Approval',
    description: 'Approval workflow for quotes between $5,000 and $50,000',
    levels: [
      { level: 'L1', name: 'Sales Manager Approval', approvers: ['Michael Zhang'], threshold: 5000 },
      { level: 'L2', name: 'Finance Approval', approvers: ['Linda Li'], threshold: 50000 },
    ],
    isActive: true,
    createdAt: '2026-01-01',
  },
  {
    id: 'wf002',
    name: 'High-value Quote Approval',
    description: 'Approval workflow for quotes above $50,000',
    levels: [
      { level: 'L1', name: 'Sales Manager Approval', approvers: ['Michael Zhang'], threshold: 50000 },
      { level: 'L2', name: 'Finance Approval', approvers: ['Linda Li'], threshold: 50000 },
      { level: 'L3', name: 'General Manager Approval', approvers: ['Victor Wang'], threshold: 999999 },
    ],
    isActive: true,
    createdAt: '2026-01-01',
  },
  {
    id: 'wf003',
    name: 'Urgent Demand Approval',
    description: 'Fast-track approval workflow for urgent AOG demands',
    levels: [
      { level: 'L1', name: 'Duty Manager Approval', approvers: ['Michael Zhang', 'Victor Wang'], threshold: 0 },
    ],
    isActive: true,
    createdAt: '2026-01-15',
  },
];