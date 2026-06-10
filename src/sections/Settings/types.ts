export interface UserProfile {
  id: string;
  name: string;
  email: string;
  role: string;
  department: string;
  avatar?: string;
  phone?: string;
  lastLoginAt?: string;
}

export interface ApprovalLevel {
  level: string;
  name: string;
  approvers: string[];
  threshold: number;
}

export interface ApprovalWorkflow {
  id: string;
  name: string;
  description: string;
  levels: ApprovalLevel[];
  isActive: boolean;
  createdAt: string;
}

export interface CurrentUserProfile {
  id?: string;
  name?: string;
  email?: string;
  role?: string;
  department?: string;
  avatar?: string;
}

export interface EmailAccount {
  id: string;
  email: string;
  displayName?: string;
  accountType: string;
  isActive: boolean;
  isDefault: boolean;
  lastSyncAt?: string;
  imapServer?: string;
  imapPort?: string;
  smtpServer?: string;
  smtpPort?: string;
  authCode?: string;
  syncInterval?: number;
}

export interface EmailAccountFormData {
  email: string;
  displayName: string;
  imapServer: string;
  imapPort: string;
  smtpServer: string;
  smtpPort: string;
  authCode: string;
  accountType: string;
  isDefault: boolean;
  syncInterval: number;
}