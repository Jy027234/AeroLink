import { useState, useEffect, useCallback } from 'react';
import { authApi, dashboardApi, rfqApi, quotationApi, orderApi, inventoryApi, inventoryItemApi, inventoryDetailApi, customerApi, supplierApi, supplierQuoteApi, notificationApi, emailApi, documentTemplateApi, documentApi, certificateApi, certificateTemplateApi, workflowApi, auditLogApi, pricingApi, inventoryAnalyticsApi, auctionApi, inventoryTransactionApi, userApi, notificationPreferenceApi, reportApi, shipmentTrackingApi, inquiryApi, pricingBIApi, blockchainApi, fmvApi, apiKeyApi, consignmentApi, exchangeVmiApi, technicalKitApi, channelBindingApi, notificationTemplateApi, imApi, notificationDispatcherApi, pushApi } from '@/api/client';
import type { SupplierQuoteItem, Auction, AuctionBid, InventoryTransaction, CreateOutboundPayload } from '@/api/client';
import type { RFQ, Quotation, Order, SupplierFollowUpLog, DocumentTemplate, GeneratedDocument, Certificate, CertificateTemplate, WorkflowDefinition, WorkflowInstance } from '@/types';

export { quotationApi, customerApi, documentTemplateApi, documentApi };

type Payload = Record<string, unknown>;
type ApiRecord = Record<string, unknown>;

function useQuery<T>(fetchFn: () => Promise<T>, deps: React.DependencyList = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchFn();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : '未知错误');
    } finally {
      setLoading(false);
    }
  }, [fetchFn]);

  useEffect(() => {
    void refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, loading, error, refetch };
}

function useMutation<T, D>(mutateFn: (data: D) => Promise<T>) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutate = useCallback(async (data: D): Promise<T | null> => {
    setLoading(true);
    setError(null);
    try {
      const result = await mutateFn(data);
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : '未知错误');
      return null;
    } finally {
      setLoading(false);
    }
  }, [mutateFn]);

  return { mutate, loading, error };
}

// ===== Auth Hooks =====
export const useLogin = () => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const login = useCallback(async (email: string, password: string) => {
    setLoading(true);
    setError(null);
    try {
      const response = await authApi.login(email, password);
      localStorage.setItem('aerolink_token', response.token);
      localStorage.setItem('aerolink_refresh_token', response.refreshToken);
      localStorage.setItem('aerolink_user', JSON.stringify(response.user));
      return response;
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('aerolink_token');
    localStorage.removeItem('aerolink_refresh_token');
    localStorage.removeItem('aerolink_user');
    window.location.href = '/';
  }, []);

  return { login, logout, loading, error };
};

export const useCurrentUser = () => {
  const [user] = useState<Payload | null>(() => {
    const stored = localStorage.getItem('aerolink_user');
    if (!stored) {
      return null;
    }

    try {
      return JSON.parse(stored);
    } catch {
      return null;
    }
  });

  return { user, loading: false };
};

// ===== Dashboard Hooks =====
export const useDashboardStats = () => {
  return useQuery(() => dashboardApi.getStats(), []);
};

export const useSalesFunnel = () => {
  return useQuery(() => dashboardApi.getFunnel(), []);
};

export const useRecentActivities = () => {
  return useQuery(() => dashboardApi.getActivities(), []);
};

// ===== RFQ Hooks =====
export const useRFQs = (filters?: { status?: string; urgency?: string }) => {
  return useQuery(() => rfqApi.getAll(filters), [filters?.status, filters?.urgency]);
};

export const useRFQ = (id: string) => {
  return useQuery(() => rfqApi.getById(id), [id]);
};

export const useCreateRFQ = () => {
  return useMutation<RFQ, Payload>((data) => rfqApi.create(data));
};

export const useUpdateRFQ = () => {
  return useMutation<RFQ, { id: string; data: Payload }>(({ id, data }) => rfqApi.update(id, data));
};

export const useUpdateRFQStatus = () => {
  const [loading, setLoading] = useState(false);

  const updateStatus = useCallback(async (id: string, status: string) => {
    setLoading(true);
    try {
      return await rfqApi.updateStatus(id, status);
    } finally {
      setLoading(false);
    }
  }, []);

  return { updateStatus, loading };
};

// ===== Quotation Hooks =====
export const useQuotations = (filters?: { status?: string }) => {
  return useQuery(() => quotationApi.getAll(filters), [filters?.status]);
};

export const useQuotation = (id: string) => {
  return useQuery(() => quotationApi.getById(id), [id]);
};

export const useCreateQuotation = () => {
  return useMutation<Quotation, Payload>((data) => quotationApi.create(data));
};

export const useSubmitQuotation = () => {
  const [loading, setLoading] = useState(false);

  const submit = useCallback(async (id: string) => {
    setLoading(true);
    try {
      return await quotationApi.submitForApproval(id);
    } finally {
      setLoading(false);
    }
  }, []);

  return { submit, loading };
};

export const useApproveQuotation = () => {
  const [loading, setLoading] = useState(false);

  const approve = useCallback(async (id: string, action: 'approve' | 'reject') => {
    setLoading(true);
    try {
      return await quotationApi.approve(id, action);
    } finally {
      setLoading(false);
    }
  }, []);

  return { approve, loading };
};

// ===== Order Hooks =====
export const useOrders = () => {
  return useQuery(() => orderApi.getAll(), []);
};

export const useOrder = (id: string) => {
  return useQuery(() => orderApi.getById(id), [id]);
};

export const useCreateOrder = () => {
  return useMutation<Order, Payload>((data) => orderApi.create(data));
};

export const useUpdateOrder = () => {
  return useMutation<Order, { id: string; data: Payload }>(({ id, data }) => orderApi.update(id, data));
};

export const useDocumentTemplates = (documentType = 'ORDER_CONTRACT') => {
  return useQuery(() => documentTemplateApi.getAll({ documentType }), [documentType]);
};

export const useGeneratedDocuments = (filters?: { quotationId?: string; orderId?: string; documentType?: string }) => {
  return useQuery<GeneratedDocument[]>(() => documentApi.getAll(filters), [filters?.quotationId, filters?.orderId, filters?.documentType]);
};

export const useSaveDocumentTemplate = () => {
  return useMutation<DocumentTemplate, { id?: string; data: Partial<DocumentTemplate> }>(async ({ id, data }) => {
    if (id) {
      return documentTemplateApi.update(id, data);
    }
    return documentTemplateApi.create(data);
  });
};

// ===== Inventory Hooks =====
export const useInventory = () => {
  return useQuery(() => inventoryApi.getAll(), []);
};

export const useInventoryItem = (id: string) => {
  return useQuery(() => inventoryApi.getById(id), [id]);
};

export const useInventoryByPartNumber = (partNumber: string) => {
  return useQuery(() => inventoryApi.getByPartNumber(partNumber), [partNumber]);
};

// ===== Phase 3: 库存明细层 Hooks =====
export const useInventoryItems = () => {
  return useQuery(() => inventoryItemApi.getAll(), []);
};

export const useInventoryItemById = (id: string) => {
  return useQuery(() => inventoryItemApi.getById(id), [id]);
};

export const useInventoryItemByPartNumber = (partNumber: string) => {
  return useQuery(() => inventoryItemApi.getByPartNumber(partNumber), [partNumber]);
};

export const useInventoryDetails = () => {
  return useQuery(() => inventoryDetailApi.getAll(), []);
};

export const useInventoryDetailsByItemId = (itemId: string) => {
  return useQuery(() => inventoryDetailApi.getByItemId(itemId), [itemId]);
};

export const useInventoryDetailById = (id: string) => {
  return useQuery(() => inventoryDetailApi.getById(id), [id]);
};

// ===== Customer Hooks =====
export const useCustomers = () => {
  return useQuery(() => customerApi.getAll(), []);
};

export const useCustomer = (id: string) => {
  return useQuery(() => customerApi.getById(id), [id]);
};

// ===== Supplier Hooks =====
export const useSuppliers = (params?: { level?: string; page?: number; limit?: number }) => {
  return useQuery(() => supplierApi.getAll(params), [params?.level, params?.page, params?.limit]);
};

export const useSupplier = (id: string) => {
  return useQuery(() => supplierApi.getById(id), [id]);
};

export const useSupplierFollowUpLogs = (params?: { supplierId?: string; limit?: number }) => {
  return useQuery<SupplierFollowUpLog[]>(() => supplierApi.getFollowUpLogs(params), [params?.supplierId, params?.limit]);
};

export const useInviteSupplier = () => {
  return useMutation<ApiRecord, { email: string; message?: string }>((data) => supplierApi.invite(data));
};

// ===== Supplier Quote Hooks =====
export const useSupplierQuotes = (filters?: { rfqId?: string; inquiryId?: string; status?: string; partNumber?: string }) => {
  return useQuery(() => supplierQuoteApi.getAll(filters), [filters?.rfqId, filters?.inquiryId, filters?.status, filters?.partNumber]);
};

export const useSupplierQuote = (id: string) => {
  return useQuery(() => supplierQuoteApi.getById(id), [id]);
};

export const useCreateSupplierQuote = () => {
  return useMutation<SupplierQuoteItem, Payload>((data) => supplierQuoteApi.create(data));
};

export const useUpdateSupplierQuote = () => {
  const [loading, setLoading] = useState(false);

  const update = useCallback(async (id: string, data: Payload) => {
    setLoading(true);
    try {
      return await supplierQuoteApi.update(id, data);
    } finally {
      setLoading(false);
    }
  }, []);

  return { update, loading };
};

export const useCompareSupplierQuotes = () => {
  const [loading, setLoading] = useState(false);

  const compare = useCallback(async (body: { rfqId?: string; inquiryId?: string }) => {
    setLoading(true);
    try {
      return await supplierQuoteApi.compare(body);
    } finally {
      setLoading(false);
    }
  }, []);

  return { compare, loading };
};

export const useSelectWinner = () => {
  const [loading, setLoading] = useState(false);

  const select = useCallback(async (id: string) => {
    setLoading(true);
    try {
      return await supplierQuoteApi.selectWinner(id);
    } finally {
      setLoading(false);
    }
  }, []);

  return { select, loading };
};

// ===== Notification Hooks =====
export const useNotifications = () => {
  return useQuery(() => notificationApi.getAll(), []);
};

export const useUnreadCount = () => {
  return useQuery(() => notificationApi.getUnreadCount(), []);
};

export const useMarkNotificationsRead = () => {
  const [loading, setLoading] = useState(false);

  const markAsRead = useCallback(async (id: string) => {
    setLoading(true);
    try {
      await notificationApi.markAsRead(id);
    } finally {
      setLoading(false);
    }
  }, []);

  const markAllAsRead = useCallback(async () => {
    setLoading(true);
    try {
      await notificationApi.markAllAsRead();
    } finally {
      setLoading(false);
    }
  }, []);

  return { markAsRead, markAllAsRead, loading };
};

// ===== Email Hooks =====
export const useEmails = (filters?: { type?: string; isRead?: boolean }) => {
  return useQuery(() => emailApi.getAll(filters), [filters?.type, filters?.isRead]);
};

export const useEmail = (id: string) => {
  return useQuery(() => emailApi.getById(id), [id]);
};

// ===== Certificate Hooks =====
export const useCertificates = (filters?: { status?: string; certificateType?: string; partNumber?: string; expiringWithinDays?: number }) => {
  return useQuery(() => certificateApi.list(filters), [filters?.status, filters?.certificateType, filters?.partNumber, filters?.expiringWithinDays]);
};

export const useCertificate = (id: string) => {
  return useQuery(() => certificateApi.get(id), [id]);
};

export const useCreateCertificate = () => {
  return useMutation<Certificate, Payload>((data) => certificateApi.issue(data));
};

export const useVerifyCertificate = () => {
  const [loading, setLoading] = useState(false);

  const verify = useCallback(async (id: string) => {
    setLoading(true);
    try {
      return await certificateApi.verify(id);
    } finally {
      setLoading(false);
    }
  }, []);

  return { verify, loading };
};

export const useRevokeCertificate = () => {
  const [loading, setLoading] = useState(false);

  const revoke = useCallback(async (id: string, reason: string) => {
    setLoading(true);
    try {
      return await certificateApi.revoke(id, reason);
    } finally {
      setLoading(false);
    }
  }, []);

  return { revoke, loading };
};

export const useRenewCertificate = () => {
  const [loading, setLoading] = useState(false);

  const renew = useCallback(async (id: string) => {
    setLoading(true);
    try {
      return await certificateApi.renew(id);
    } finally {
      setLoading(false);
    }
  }, []);

  return { renew, loading };
};

export const useExpiringCertificates = (days?: number) => {
  return useQuery(() => certificateApi.expiring(days), [days]);
};

// ===== Certificate Template Hooks =====
export const useCertificateTemplates = (params?: { certificateType?: string; isActive?: boolean }) => {
  return useQuery(() => certificateTemplateApi.list(params), [params?.certificateType, params?.isActive]);
};

export const useCertificateTemplate = (id: string) => {
  return useQuery(() => certificateTemplateApi.get(id), [id]);
};

export const useSaveCertificateTemplate = () => {
  return useMutation<CertificateTemplate, { id?: string; data: Payload }>(async ({ id, data }) => {
    if (id) {
      return certificateTemplateApi.update(id, data);
    }
    return certificateTemplateApi.create(data);
  });
};

export const useDuplicateCertificateTemplate = () => {
  const [loading, setLoading] = useState(false);

  const duplicate = useCallback(async (id: string) => {
    setLoading(true);
    try {
      return await certificateTemplateApi.duplicate(id);
    } finally {
      setLoading(false);
    }
  }, []);

  return { duplicate, loading };
};

export const useAuditLogs = (filters?: {
  page?: number;
  limit?: number;
  userId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  status?: string;
  startDate?: string;
  endDate?: string;
  search?: string;
}) => {
  return useQuery(() => auditLogApi.getAll(filters), [
    filters?.page,
    filters?.limit,
    filters?.userId,
    filters?.action,
    filters?.resourceType,
    filters?.resourceId,
    filters?.status,
    filters?.startDate,
    filters?.endDate,
    filters?.search,
  ]);
};

export const useAuditLogStats = () => {
  return useQuery(() => auditLogApi.getStats(), []);
};

export const useAuditLog = (id: string) => {
  return useQuery(() => auditLogApi.getById(id), [id]);
};

export const useDeleteCertificateTemplate = () => {
  const [loading, setLoading] = useState(false);

  const deleteTemplate = useCallback(async (id: string) => {
    setLoading(true);
    try {
      return await certificateTemplateApi.delete(id);
    } finally {
      setLoading(false);
    }
  }, []);

  return { deleteTemplate, loading };
};

// ===== Workflow Hooks =====
export const useWorkflowDefinitions = (params?: { entityType?: string; isActive?: boolean }) => {
  return useQuery(() => workflowApi.listDefinitions(params), [params?.entityType, params?.isActive]);
};

export const useWorkflowDefinition = (id: string) => {
  return useQuery(() => workflowApi.getDefinition(id), [id]);
};

export const useSaveWorkflowDefinition = () => {
  return useMutation<WorkflowDefinition, { id?: string; data: Payload }>(async ({ id, data }) => {
    if (id) {
      return workflowApi.updateDefinition(id, data);
    }
    return workflowApi.createDefinition(data);
  });
};

export const useDuplicateWorkflowDefinition = () => {
  const [loading, setLoading] = useState(false);

  const duplicate = useCallback(async (id: string) => {
    setLoading(true);
    try {
      return await workflowApi.duplicateDefinition(id);
    } finally {
      setLoading(false);
    }
  }, []);

  return { duplicate, loading };
};

export const useDeleteWorkflowDefinition = () => {
  const [loading, setLoading] = useState(false);

  const deleteDefinition = useCallback(async (id: string) => {
    setLoading(true);
    try {
      return await workflowApi.deleteDefinition(id);
    } finally {
      setLoading(false);
    }
  }, []);

  return { deleteDefinition, loading };
};

export const useWorkflowInstances = (params?: { entityType?: string; entityId?: string; status?: string; page?: number; limit?: number }) => {
  return useQuery(() => workflowApi.listInstances(params), [
    params?.entityType,
    params?.entityId,
    params?.status,
    params?.page,
    params?.limit,
  ]);
};

export const useWorkflowInstance = (id: string) => {
  return useQuery(() => workflowApi.getInstance(id), [id]);
};

export const useStartWorkflowInstance = () => {
  return useMutation<WorkflowInstance, { definitionId: string; entityType: string; entityId: string; context?: Payload }>(
    async ({ definitionId, entityType, entityId, context }) => {
      return workflowApi.startInstance({ definitionId, entityType, entityId, context });
    }
  );
};

export const useWorkflowPendingTasks = () => {
  return useQuery(() => workflowApi.getPendingTasks(), []);
};

export const useWorkflowEntityHistory = (entityType: string, entityId: string) => {
  return useQuery(() => workflowApi.getEntityHistory(entityType, entityId), [entityType, entityId]);
};

export const useWorkflowAction = () => {
  const [loading, setLoading] = useState(false);

  const act = useCallback(async (instanceId: string, action: string, payload?: Payload) => {
    setLoading(true);
    try {
      return await workflowApi.instanceAction(instanceId, action, payload);
    } finally {
      setLoading(false);
    }
  }, []);

  return { act, loading };
};

// ===== Pricing / AI Recommendation Hooks =====
export const usePriceRecommendation = (params: {
  partNumber: string;
  quantity: number;
  customerId?: string;
  proposedPrice?: number;
}) => {
  return useQuery(() => pricingApi.getRecommendation(params), [params.partNumber, params.quantity, params.customerId, params.proposedPrice]);
};

export const usePriceHistory = (partNumber: string) => {
  return useQuery(() => pricingApi.getPriceHistory(partNumber), [partNumber]);
};

export const useBatchPriceRecommendations = () => {
  const [loading, setLoading] = useState(false);

  const getRecommendations = useCallback(async (items: Array<{ partNumber: string; quantity: number; customerId?: string }>) => {
    setLoading(true);
    try {
      return await pricingApi.getBatchRecommendations(items);
    } finally {
      setLoading(false);
    }
  }, []);

  return { getRecommendations, loading };
};

// ===== Inventory Analytics Hooks =====
export const useConsumptionTrend = (params?: { partNumber?: string; months?: number }) => {
  return useQuery(() => inventoryAnalyticsApi.getConsumptionTrend(params), [params?.partNumber, params?.months]);
};

export const useSafetyStock = (params?: { partNumber?: string; leadTimeDays?: number }) => {
  return useQuery(() => inventoryAnalyticsApi.getSafetyStock(params), [params?.partNumber, params?.leadTimeDays]);
};

export const useInventoryHealthSummary = () => {
  return useQuery(() => inventoryAnalyticsApi.getHealthSummary(), []);
};

export const useSeasonalForecast = (partNumber: string) => {
  return useQuery(() => inventoryAnalyticsApi.getSeasonalForecast(partNumber), [partNumber]);
};

// ===== Auction Hooks =====
export const useAuctions = (filters?: { status?: string; type?: string; partNumber?: string; search?: string }) => {
  return useQuery(() => auctionApi.list(filters), [filters?.status, filters?.type, filters?.partNumber, filters?.search]);
};

export const useAuction = (id: string) => {
  return useQuery(() => auctionApi.get(id), [id]);
};

export const useCreateAuction = () => {
  return useMutation<Auction, Payload>((data) => auctionApi.create(data));
};

export const usePlaceBid = () => {
  return useMutation<AuctionBid, { id: string; data: Payload }>(({ id, data }) => auctionApi.placeBid(id, data as { amount: number; quantity?: number; isAutoBid?: boolean; maxAutoBid?: number; notes?: string }));
};

export const useActiveAuctions = () => {
  return useQuery(() => auctionApi.getActive(), []);
};

// ===== Phase 5: Inventory Transaction Hooks =====
export const useInventoryTransactionsByDetail = (detailId: string) => {
  return useQuery(() => inventoryTransactionApi.getByDetailId(detailId), [detailId]);
};

export const useInventoryTransactionsByOrder = (orderId: string) => {
  return useQuery(() => inventoryTransactionApi.getByOrderId(orderId), [orderId]);
};

export const useCreateOutbound = () => {
  return useMutation<InventoryTransaction, CreateOutboundPayload>((data) => inventoryTransactionApi.createOutbound(data));
};

// ===== User Management Hooks =====
export const useUsers = () => {
  return useQuery(() => userApi.getAll(), []);
};

export const useUser = (id: string) => {
  return useQuery(() => userApi.getById(id), [id]);
};

export const useCreateUser = () => {
  return useMutation<User, Payload>((data) => userApi.create(data));
};

export const useUpdateUser = () => {
  return useMutation<User, { id: string; data: Payload }>(({ id, data }) => userApi.update(id, data));
};

export const useDeleteUser = () => {
  return useMutation<ApiRecord, string>((id) => userApi.delete(id));
};

// ===== Auth Profile Hooks =====
export const useUpdateProfile = () => {
  return useMutation<User, Payload>((data) => authApi.updateMe(data));
};

export const useChangePassword = () => {
  return useMutation<ApiRecord, { currentPassword: string; newPassword: string }>((data) => authApi.changePassword(data));
};

// ===== Agent Hooks =====
export const useAgents = () => {
  return useQuery(() => agentApi.getAll(), []);
};

// ===== Notification Preference Hooks =====
export const useNotificationPreference = () => {
  return useQuery(() => notificationPreferenceApi.getMine(), []);
};

export const useUpdateNotificationPreference = () => {
  return useMutation<NotificationPreference, Partial<NotificationPreference>>((data) => notificationPreferenceApi.updateMine(data));
};

// ===== Report Hooks =====
export const useReportSummary = () => {
  return useQuery(() => reportApi.getSummary(), []);
};

export const useSalesTrend = (months?: number) => {
  return useQuery(() => reportApi.getSalesTrend(months), [months]);
};

export const useConversionAnalysis = () => {
  return useQuery(() => reportApi.getConversionAnalysis(), []);
};

export const useCustomerContribution = () => {
  return useQuery(() => reportApi.getCustomerContribution(), []);
};

export const useInventoryTurnover = () => {
  return useQuery(() => reportApi.getInventoryTurnover(), []);
};

// ===== Shipment Tracking Hooks =====
export const useShipmentTrackings = () => {
  return useQuery(() => shipmentTrackingApi.getAll(), []);
};

export const useShipmentTrackingByOrder = (orderId: string) => {
  return useQuery(() => shipmentTrackingApi.getByOrderId(orderId), [orderId]);
};

export const useCustomsRisks = () => {
  return useQuery(() => shipmentTrackingApi.getCustomsRisks(), []);
};

export const useShipmentAlerts = () => {
  return useQuery(() => shipmentTrackingApi.getAlerts(), []);
};

// ===== Inquiry Hooks =====
export const useInquiries = () => {
  return useQuery(() => inquiryApi.getAll(), []);
};

export const useCreateInquiry = () => {
  return useMutation<Inquiry[], { rfqId: string; supplierIds: string[]; isAOG: boolean; notes?: string }>((data) => inquiryApi.create(data));
};

// ===== Pricing BI Hooks =====
export const usePricingSummary = () => {
  return useQuery(() => pricingBIApi.getSummary(), []);
};

export const useMarketIntelligence = () => {
  return useQuery(() => pricingBIApi.getMarketIntelligence(), []);
};

export const usePricingSuggestions = () => {
  return useQuery(() => pricingBIApi.getPricingSuggestions(), []);
};

export const useLostOrders = () => {
  return useQuery(() => pricingBIApi.getLostOrders(), []);
};

export const usePricingFactorWeights = () => {
  return useQuery(() => pricingBIApi.getFactorWeights(), []);
};

// ===== Blockchain Verification Hooks =====
export const useBlockchainVerify = () => {
  return useMutation<BlockchainVerificationResult, string>((certificateId) => blockchainApi.verify(certificateId));
};

// ===== FMV Hooks =====
export const useFMVCalculate = () => {
  return useMutation<FMVResult, { partNumber: string; conditionCode: string }>((data) => fmvApi.calculate(data.partNumber, data.conditionCode));
};

// ===== API Key Hooks =====
export const useApiKeys = () => {
  return useQuery(() => apiKeyApi.getAll(), []);
};

export const useCreateApiKey = () => {
  return useMutation<ApiKeyItem, { name: string; scopes: string[]; rateLimit: number }>((data) => apiKeyApi.create(data));
};

export const useRevokeApiKey = () => {
  return useMutation<ApiKeyItem, string>((id) => apiKeyApi.revoke(id));
};

// ===== Consignment Hooks =====
export const useConsignments = () => {
  return useQuery(() => consignmentApi.getAll(), []);
};

export const useConsignmentStats = () => {
  return useQuery(() => consignmentApi.getStats(), []);
};

export const useCreateConsignment = () => {
  return useMutation<ConsignmentItem, object>((data) => consignmentApi.create(data));
};

// ===== Exchange / VMI Hooks =====
export const useExchangeQuotes = () => {
  return useQuery(() => exchangeVmiApi.getExchanges(), []);
};

export const useVMIAgreements = () => {
  return useQuery(() => exchangeVmiApi.getVMIAgreements(), []);
};

export const useRestockSuggestions = () => {
  return useQuery(() => exchangeVmiApi.getRestockSuggestions(), []);
};

export const useExchangeVMIStats = () => {
  return useQuery(() => exchangeVmiApi.getStats(), []);
};

// ===== Technical Kit / IPC Hooks =====
export const useIPCSearch = (q: string) => {
  return useQuery(() => technicalKitApi.search(q), [q]);
};

export const useCheckCompatibility = () => {
  return useMutation<CompatibilityResult, { partNumber: string; aircraftType: string; msn?: string }>((data) => technicalKitApi.checkCompatibility(data.partNumber, data.aircraftType, data.msn));
};

// ===== Channel Binding Hooks =====
export const useChannelBindings = () => {
  return useQuery(() => channelBindingApi.getMine(), []);
};

export const useCreateChannelBinding = () => {
  return useMutation<UserChannelBinding, { channel: string; config: Record<string, string> }>((data) => channelBindingApi.create(data));
};

export const useUpdateChannelBinding = () => {
  return useMutation<UserChannelBinding, { id: string; config?: Record<string, string>; isActive?: boolean }>((data) => channelBindingApi.update(data.id, data));
};

export const useDeleteChannelBinding = () => {
  return useMutation<ApiRecord, string>((id) => channelBindingApi.delete(id));
};

// ===== Notification Template Hooks =====
export const useNotificationTemplates = () => {
  return useQuery(() => notificationTemplateApi.getAll(), []);
};

export const useNotificationTemplatesByEvent = (event: string) => {
  return useQuery(() => notificationTemplateApi.getByEvent(event), [event]);
};

export const useCreateNotificationTemplate = () => {
  return useMutation<NotificationTemplate, object>((data) => notificationTemplateApi.create(data));
};

export const useUpdateNotificationTemplate = () => {
  return useMutation<NotificationTemplate, { id: string; data: object }>(({ id, data }) => notificationTemplateApi.update(id, data));
};

// ===== IM Send Hooks =====
export const useSendWechat = () => {
  return useMutation<{ success: boolean; messageId?: string }, { userId: string; message: { title: string; description: string; url?: string } }>((data) => imApi.sendWechat(data.userId, data.message));
};

export const useSendDingtalk = () => {
  return useMutation<{ success: boolean; messageId?: string }, { userId: string; message: { title: string; text: string; url?: string } }>((data) => imApi.sendDingtalk(data.userId, data.message));
};

export const useSendLark = () => {
  return useMutation<{ success: boolean; messageId?: string }, { userId: string; message: { title: string; content: string; url?: string } }>((data) => imApi.sendLark(data.userId, data.message));
};

export const useSendSms = () => {
  return useMutation<{ success: boolean; messageId?: string }, { phone: string; message: string }>((data) => imApi.sendSms(data.phone, data.message));
};

export const useSendSlack = () => {
  return useMutation<{ success: boolean; messageId?: string }, { userId: string; message: { title: string; text: string; url?: string } }>((data) => imApi.sendSlack(data.userId, data.message));
};

export const useSendTeams = () => {
  return useMutation<{ success: boolean; messageId?: string }, { userId: string; message: { title: string; text: string; url?: string } }>((data) => imApi.sendTeams(data.userId, data.message));
};

// ===== Unified Notification Dispatcher Hook =====
export const useDispatchNotification = () => {
  return useMutation<DispatchNotificationResult, DispatchNotificationPayload>((data) => notificationDispatcherApi.dispatch(data));
};

// ===== PWA Web Push Hooks =====
export const useVapidPublicKey = () => {
  return useQuery(() => pushApi.getVapidPublicKey(), []);
};

export const usePushSubscribe = () => {
  return useMutation<{ success: boolean }, PushSubscriptionPayload>((data) => pushApi.subscribe(data));
};

export const usePushUnsubscribe = () => {
  return useMutation<{ success: boolean }, void>(() => pushApi.unsubscribe());
};

export const usePushStatus = () => {
  return useQuery(() => pushApi.getSubscriptionStatus(), []);
};
