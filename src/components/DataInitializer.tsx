import { useEffect } from 'react';
import {
  useSupplierFollowUpLogs,
  useNotifications,
} from '@/hooks/useApi';
import {
  useSupplierFollowUpStore,
  useNotificationStore,
} from '@/store';

export function DataInitializer({ children }: { children: React.ReactNode }) {
  const { data: supplierFollowUpLogs } = useSupplierFollowUpLogs();
  const { data: notifications } = useNotifications();

  useEffect(() => {
    if (supplierFollowUpLogs) {
      useSupplierFollowUpStore.getState().setLogs(supplierFollowUpLogs);
    }
  }, [supplierFollowUpLogs]);

  useEffect(() => {
    if (notifications) {
      useNotificationStore.getState().setNotifications(notifications);
    }
  }, [notifications]);

  return <>{children}</>;
}
