import { useEffect } from 'react';
import {
  useSupplierFollowUpLogs,
  useEmails,
  useNotifications,
} from '@/hooks/useApi';
import {
  useSupplierFollowUpStore,
  useEmailStore,
  useNotificationStore,
} from '@/store';

export function DataInitializer({ children }: { children: React.ReactNode }) {
  const { data: supplierFollowUpLogs } = useSupplierFollowUpLogs();
  const { data: emails } = useEmails();
  const { data: notifications } = useNotifications();

  useEffect(() => {
    if (supplierFollowUpLogs) {
      useSupplierFollowUpStore.getState().setLogs(supplierFollowUpLogs);
    }
  }, [supplierFollowUpLogs]);

  useEffect(() => {
    if (emails) {
      useEmailStore.getState().setEmails(emails);
    }
  }, [emails]);

  useEffect(() => {
    if (notifications) {
      useNotificationStore.getState().setNotifications(notifications);
    }
  }, [notifications]);

  return <>{children}</>;
}
