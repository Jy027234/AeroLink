import { useEffect } from 'react';
import {
  useRFQs,
  useQuotations,
  useOrders,
  useInventory,
  useCustomers,
  useSuppliers,
  useSupplierFollowUpLogs,
  useEmails,
  useNotifications,
} from '@/hooks/useApi';
import {
  useRFQStore,
  useQuotationStore,
  useOrderStore,
  useInventoryStore,
  useCustomerStore,
  useSupplierStore,
  useSupplierFollowUpStore,
  useEmailStore,
  useNotificationStore,
} from '@/store';

export function DataInitializer({ children }: { children: React.ReactNode }) {
  const { data: rfqs } = useRFQs();
  const { data: quotations } = useQuotations();
  const { data: orders } = useOrders();
  const { data: inventory } = useInventory();
  const { data: customers } = useCustomers();
  const { data: suppliers } = useSuppliers();
  const { data: supplierFollowUpLogs } = useSupplierFollowUpLogs();
  const { data: emails } = useEmails();
  const { data: notifications } = useNotifications();

  useEffect(() => {
    if (rfqs) {
      useRFQStore.getState().setRFQs(rfqs);
    }
  }, [rfqs]);

  useEffect(() => {
    if (quotations) {
      useQuotationStore.getState().setQuotations(quotations);
    }
  }, [quotations]);

  useEffect(() => {
    if (orders) {
      useOrderStore.getState().setOrders(orders);
    }
  }, [orders]);

  useEffect(() => {
    if (inventory) {
      useInventoryStore.getState().setInventory(inventory);
    }
  }, [inventory]);

  useEffect(() => {
    if (customers) {
      useCustomerStore.getState().setCustomers(customers);
    }
  }, [customers]);

  useEffect(() => {
    if (suppliers) {
      useSupplierStore.getState().setSuppliers(suppliers);
    }
  }, [suppliers]);

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
