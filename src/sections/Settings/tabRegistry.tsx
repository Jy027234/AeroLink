import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Bot, CheckCircle, Link2, RefreshCw, User, Users } from 'lucide-react';
import { AgentManagement } from './AgentManagement';
import { ApprovalWorkflowSettings } from './ApprovalWorkflowSettings';
import { ChannelBindingSettings } from './ChannelBindingSettings';
import { ContractTemplateManagement } from './ContractTemplateManagement';
import { EmailSettings } from './EmailSettings';
import { NotificationSettings } from './NotificationSettings';
import { ProfileSettings } from './ProfileSettings';
import { SecuritySettings } from './SecuritySettings';
import { UserManagement } from './UserManagement';
import { WebhookManagementPanel } from './WebhookManagementPanel';
import type { CurrentUserProfile } from './types';

export type SettingsFeatureStage = 'stable' | 'beta';

export interface SettingsTabContext {
  user: CurrentUserProfile | null;
  can: (capability: string) => boolean;
}

export interface SettingsTabDefinition {
  key: string;
  labelZh: string;
  labelEn: string;
  icon?: LucideIcon;
  triggerClassName?: string;
  contentClassName?: string;
  featureStage: SettingsFeatureStage;
  requiredCapability?: string;
  isVisible?: (context: SettingsTabContext) => boolean;
  render: (context: SettingsTabContext) => ReactNode;
}

export const settingsTabRegistry: SettingsTabDefinition[] = [
  {
    key: 'profile',
    labelZh: '资料',
    labelEn: 'Profile',
    icon: User,
    triggerClassName: 'gap-1',
    contentClassName: 'mt-4',
    featureStage: 'stable',
    render: ({ user }) => <ProfileSettings user={user} />,
  },
  {
    key: 'approvals',
    labelZh: '审批',
    labelEn: 'Approvals',
    icon: CheckCircle,
    triggerClassName: 'gap-1',
    contentClassName: 'mt-4',
    featureStage: 'stable',
    requiredCapability: 'workflow.read',
    render: () => <ApprovalWorkflowSettings />,
  },
  {
    key: 'users',
    labelZh: '用户',
    labelEn: 'Users',
    icon: Users,
    triggerClassName: 'gap-1',
    contentClassName: 'mt-4',
    featureStage: 'stable',
    requiredCapability: 'user.manage',
    render: () => <UserManagement />,
  },
  {
    key: 'notifications',
    labelZh: '通知',
    labelEn: 'Notifications',
    contentClassName: 'space-y-6',
    featureStage: 'stable',
    render: () => <NotificationSettings />,
  },
  {
    key: 'channels',
    labelZh: '渠道绑定',
    labelEn: 'Channel Bindings',
    icon: Link2,
    triggerClassName: 'gap-1',
    contentClassName: 'mt-4',
    featureStage: 'stable',
    requiredCapability: 'integration.read',
    render: () => <ChannelBindingSettings />,
  },
  {
    key: 'email',
    labelZh: '邮箱',
    labelEn: 'Email',
    contentClassName: 'space-y-6',
    featureStage: 'stable',
    requiredCapability: 'email_account.manage',
    render: () => <EmailSettings />,
  },
  {
    key: 'contracts',
    labelZh: '合同模板',
    labelEn: 'Contracts',
    contentClassName: 'space-y-6',
    featureStage: 'stable',
    requiredCapability: 'certificate_template.manage',
    render: () => <ContractTemplateManagement />,
  },
  {
    key: 'security',
    labelZh: '安全',
    labelEn: 'Security',
    contentClassName: 'space-y-6',
    featureStage: 'stable',
    requiredCapability: 'session.read',
    render: () => <SecuritySettings />,
  },
  {
    key: 'agents',
    labelZh: 'AI智能体',
    labelEn: 'AI Agent',
    icon: Bot,
    triggerClassName: 'gap-1',
    contentClassName: 'mt-4',
    featureStage: 'stable',
    requiredCapability: 'agent.manage',
    render: () => <AgentManagement />,
  },
  {
    key: 'webhooks',
    labelZh: 'Webhooks',
    labelEn: 'Webhooks',
    icon: RefreshCw,
    triggerClassName: 'gap-1',
    contentClassName: 'mt-4',
    featureStage: 'stable',
    requiredCapability: 'webhook.manage',
    render: () => <WebhookManagementPanel />,
  },
];

export function resolveVisibleSettingsTabs(context: SettingsTabContext): SettingsTabDefinition[] {
  return settingsTabRegistry.filter((tab) => {
    if (tab.requiredCapability && !context.can(tab.requiredCapability)) {
      return false;
    }

    if (tab.isVisible) {
      return tab.isVisible(context);
    }

    return true;
  });
}
