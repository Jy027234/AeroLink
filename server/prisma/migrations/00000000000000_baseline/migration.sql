-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'SALES',
    "department" TEXT,
    "avatar" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emailNotify" BOOLEAN NOT NULL DEFAULT true,
    "systemNotify" BOOLEAN NOT NULL DEFAULT true,
    "approvalNotify" BOOLEAN NOT NULL DEFAULT true,
    "aogAlert" BOOLEAN NOT NULL DEFAULT true,
    "weeklyReport" BOOLEAN NOT NULL DEFAULT false,
    "wechatNotify" BOOLEAN NOT NULL DEFAULT false,
    "dingtalkNotify" BOOLEAN NOT NULL DEFAULT false,
    "larkNotify" BOOLEAN NOT NULL DEFAULT false,
    "smsNotify" BOOLEAN NOT NULL DEFAULT false,
    "pushNotify" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "buyerType" TEXT NOT NULL DEFAULT 'End User',
    "businessDescription" TEXT,
    "contactName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "registeredAddress" TEXT,
    "shipToAddress" TEXT,
    "shipForAddress" TEXT,
    "shippingContactName" TEXT,
    "shippingContactPhone" TEXT,
    "creditLimit" DOUBLE PRECISION,
    "creditRating" TEXT,
    "paymentTerms" TEXT,
    "paymentMethod" TEXT,
    "annualRevenue" DOUBLE PRECISION,
    "vatNumber" TEXT,
    "iataCode" TEXT,
    "icaoCode" TEXT,
    "aocNumber" TEXT,
    "preferredIncoterm" TEXT,
    "customsBroker" TEXT,
    "qualityApprovalStatus" TEXT NOT NULL DEFAULT 'Pending',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastOrderAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_contacts" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "role" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "receiveRFQ" BOOLEAN NOT NULL DEFAULT false,
    "receivePO" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "customer_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competitor_listings" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "competitorName" TEXT NOT NULL,
    "advantageParts" TEXT,
    "priceLevel" TEXT,
    "notes" TEXT,

    CONSTRAINT "competitor_listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decision_makers" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "concerns" TEXT,
    "vetoItems" TEXT,

    CONSTRAINT "decision_makers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "supplierType" TEXT NOT NULL DEFAULT 'Distributor',
    "cageCode" TEXT,
    "caac145CertificateNo" TEXT,
    "caac145CertificateUrl" TEXT,
    "pmaHolder" BOOLEAN NOT NULL DEFAULT false,
    "ctsoaHolder" BOOLEAN NOT NULL DEFAULT false,
    "oemAuthorized" BOOLEAN NOT NULL DEFAULT false,
    "oemAuthorizationUrl" TEXT,
    "qualityApprovalExpiry" TIMESTAMP(3),
    "lastAuditDate" TIMESTAMP(3),
    "nextAuditDue" TIMESTAMP(3),
    "approvedPartCategories" TEXT,
    "specializesInAircraft" TEXT,
    "incotermsOffered" TEXT,
    "canSupplyRotable" BOOLEAN NOT NULL DEFAULT false,
    "canSupplyChemical" BOOLEAN NOT NULL DEFAULT false,
    "hasDangerousGoodsLicense" BOOLEAN NOT NULL DEFAULT false,
    "hasColdChain" BOOLEAN NOT NULL DEFAULT false,
    "level" TEXT NOT NULL DEFAULT 'C',
    "status" TEXT NOT NULL DEFAULT 'active',
    "paymentTerms" TEXT,
    "leadTime" INTEGER,
    "leadTimeAverage" INTEGER,
    "onTimeDeliveryRate" DOUBLE PRECISION,
    "performanceScore" INTEGER,
    "certificateTypesProvided" TEXT,
    "moqPolicy" TEXT,
    "warrantyPolicy" TEXT,
    "returnPolicy" TEXT,
    "bankAccountInfo" TEXT,
    "lastOrderAt" TIMESTAMP(3),
    "activationToken" TEXT,
    "activationTokenExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_portal_users" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "supplier_portal_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory" (
    "id" TEXT NOT NULL,
    "partNumber" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "serialNumber" TEXT,
    "batchNumber" TEXT,
    "manufacturer" TEXT,
    "manufacturerCageCode" TEXT,
    "ataChapter" TEXT,
    "alternatePartNumbers" TEXT,
    "conditionCode" TEXT NOT NULL DEFAULT 'NE',
    "certificateType" TEXT NOT NULL DEFAULT 'NONE',
    "certificateNumber" TEXT,
    "certificateFileUrl" TEXT,
    "lifeLimited" BOOLEAN NOT NULL DEFAULT false,
    "totalHours" DOUBLE PRECISION,
    "totalCycles" DOUBLE PRECISION,
    "remainingHours" DOUBLE PRECISION,
    "remainingCycles" DOUBLE PRECISION,
    "manufactureDate" TIMESTAMP(3),
    "shelfLifeDate" TIMESTAMP(3),
    "overhaulDate" TIMESTAMP(3),
    "nextOverhaulDue" TIMESTAMP(3),
    "adStatus" TEXT,
    "sbStatus" TEXT,
    "repairScheme" TEXT,
    "previousOperator" TEXT,
    "removalAircraftReg" TEXT,
    "removalDate" TIMESTAMP(3),
    "removalReason" TEXT,
    "nonIncidentStatement" BOOLEAN NOT NULL DEFAULT false,
    "militarySource" BOOLEAN NOT NULL DEFAULT false,
    "traceabilityDocs" TEXT,
    "location" TEXT NOT NULL,
    "warehouse" TEXT,
    "shelf" TEXT,
    "storageCondition" TEXT,
    "ata300Packaging" BOOLEAN NOT NULL DEFAULT false,
    "unitCost" DOUBLE PRECISION NOT NULL,
    "unitOfMeasure" TEXT NOT NULL DEFAULT 'EA',
    "countryOfOrigin" TEXT,
    "hsCode" TEXT,
    "type" TEXT NOT NULL DEFAULT 'OWN',
    "supplierId" TEXT,
    "eta" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_items" (
    "id" TEXT NOT NULL,
    "partNumber" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "partCategory" TEXT NOT NULL DEFAULT 'CONSUMABLE',
    "trackingType" TEXT NOT NULL DEFAULT 'BATCH',
    "manufacturer" TEXT,
    "manufacturerCageCode" TEXT,
    "ataChapter" TEXT,
    "alternatePartNumbers" TEXT,
    "unitOfMeasure" TEXT NOT NULL DEFAULT 'EA',
    "countryOfOrigin" TEXT,
    "hsCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_details" (
    "id" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "serialNumber" TEXT,
    "batchNumber" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "conditionCode" TEXT NOT NULL DEFAULT 'NE',
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "warehouse" TEXT,
    "shelf" TEXT,
    "location" TEXT NOT NULL,
    "certificateType" TEXT NOT NULL DEFAULT 'NONE',
    "certificateNumber" TEXT,
    "certificateFileUrl" TEXT,
    "lifeLimited" BOOLEAN NOT NULL DEFAULT false,
    "totalHours" DOUBLE PRECISION,
    "remainingHours" DOUBLE PRECISION,
    "totalCycles" DOUBLE PRECISION,
    "remainingCycles" DOUBLE PRECISION,
    "manufactureDate" TIMESTAMP(3),
    "shelfLifeDate" TIMESTAMP(3),
    "overhaulDate" TIMESTAMP(3),
    "nextOverhaulDue" TIMESTAMP(3),
    "adStatus" TEXT,
    "sbStatus" TEXT,
    "repairScheme" TEXT,
    "previousOperator" TEXT,
    "removalAircraftReg" TEXT,
    "removalDate" TIMESTAMP(3),
    "removalReason" TEXT,
    "nonIncidentStatement" BOOLEAN NOT NULL DEFAULT false,
    "militarySource" BOOLEAN NOT NULL DEFAULT false,
    "traceabilityDocs" TEXT,
    "storageCondition" TEXT,
    "ata300Packaging" BOOLEAN NOT NULL DEFAULT false,
    "shelfLifeDays" INTEGER,
    "storageTempMin" DOUBLE PRECISION,
    "storageTempMax" DOUBLE PRECISION,
    "hazardClass" TEXT,
    "unitCost" DOUBLE PRECISION NOT NULL,
    "supplierId" TEXT,
    "eta" TIMESTAMP(3),
    "type" TEXT NOT NULL DEFAULT 'OWN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_details_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emails" (
    "id" TEXT NOT NULL,
    "from" TEXT NOT NULL,
    "fromName" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" TEXT NOT NULL DEFAULT 'STANDARD',
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "attachments" TEXT,
    "accountId" TEXT,

    CONSTRAINT "emails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_accounts" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "imapServer" TEXT NOT NULL,
    "imapPort" TEXT NOT NULL,
    "smtpServer" TEXT NOT NULL,
    "smtpPort" TEXT NOT NULL,
    "authCode" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "accountType" TEXT NOT NULL DEFAULT '163',
    "lastSyncAt" TIMESTAMP(3),
    "syncInterval" INTEGER NOT NULL DEFAULT 5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rfqs" (
    "id" TEXT NOT NULL,
    "rfqNumber" TEXT NOT NULL,
    "emailId" TEXT,
    "customerId" TEXT NOT NULL,
    "partNumber" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "uom" TEXT NOT NULL DEFAULT 'EA',
    "conditionCode" TEXT NOT NULL DEFAULT 'NE',
    "description" TEXT,
    "serialNumber" TEXT,
    "batchNumber" TEXT,
    "ataChapter" TEXT,
    "aircraftType" TEXT,
    "aircraftModel" TEXT,
    "alternatePartNumbers" TEXT,
    "targetPrice" DOUBLE PRECISION,
    "targetPriceCurrency" TEXT NOT NULL DEFAULT 'USD',
    "certificateRequired" BOOLEAN NOT NULL DEFAULT true,
    "certificateType" TEXT,
    "requiredDate" TIMESTAMP(3) NOT NULL,
    "responseDeadline" TIMESTAMP(3),
    "leadTimeDays" INTEGER,
    "urgency" TEXT NOT NULL DEFAULT 'STANDARD',
    "urgencyJustification" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "rfqs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inquiries" (
    "id" TEXT NOT NULL,
    "inquiryNumber" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "isAOG" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "inquiries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inquiry_items" (
    "id" TEXT NOT NULL,
    "inquiryId" TEXT NOT NULL,
    "partNumber" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "requiredDate" TIMESTAMP(3) NOT NULL,
    "certificateRequired" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "inquiry_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_quotes" (
    "id" TEXT NOT NULL,
    "inquiryId" TEXT,
    "rfqId" TEXT,
    "supplierId" TEXT NOT NULL,
    "partNumber" TEXT NOT NULL,
    "description" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DOUBLE PRECISION NOT NULL,
    "totalPrice" DOUBLE PRECISION NOT NULL,
    "leadTimeDays" INTEGER NOT NULL,
    "validUntil" TIMESTAMP(3),
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "isWinner" BOOLEAN NOT NULL DEFAULT false,
    "aiScore" DOUBLE PRECISION,
    "aiRecommendation" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_follow_up_logs" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "rfqId" TEXT,
    "rfqNumber" TEXT,
    "actionType" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "notes" TEXT,
    "preferredChannel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "supplier_follow_up_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotations" (
    "id" TEXT NOT NULL,
    "quoteNumber" TEXT NOT NULL,
    "rfqId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "partNumber" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DOUBLE PRECISION NOT NULL,
    "totalPrice" DOUBLE PRECISION NOT NULL,
    "costPrice" DOUBLE PRECISION NOT NULL,
    "margin" DOUBLE PRECISION NOT NULL,
    "saleType" TEXT NOT NULL DEFAULT 'Sale',
    "shipToId" TEXT,
    "shipForId" TEXT,
    "incoterm" TEXT,
    "incotermLocation" TEXT,
    "leadTimeDays" INTEGER,
    "leadTimeBasis" TEXT,
    "moq" INTEGER,
    "mpq" INTEGER,
    "priceBasis" TEXT,
    "taxIncluded" BOOLEAN NOT NULL DEFAULT true,
    "taxRate" DOUBLE PRECISION,
    "warrantyDays" INTEGER NOT NULL DEFAULT 90,
    "warrantyTerms" TEXT,
    "validityDays" INTEGER NOT NULL DEFAULT 7,
    "validityDeadline" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "packagingRequirement" TEXT,
    "shippingMethod" TEXT,
    "inspectionStandard" TEXT,
    "inspectionReportIncluded" BOOLEAN NOT NULL DEFAULT false,
    "certificateOfConformance" BOOLEAN NOT NULL DEFAULT false,
    "countryOfOrigin" TEXT,
    "hsCode" TEXT,
    "eccn" TEXT,
    "dualUse" BOOLEAN NOT NULL DEFAULT false,
    "ccRecipients" TEXT,
    "commonNote" TEXT,
    "certificateFiles" TEXT,
    "template" TEXT NOT NULL DEFAULT 'STANDARD',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "withdrawnAt" TIMESTAMP(3),
    "withdrawalReason" TEXT,
    "customerConfirmationNote" TEXT,
    "eSignature" TEXT,
    "eSignatureStatus" TEXT NOT NULL DEFAULT 'Unsigned',
    "expiryDate" TIMESTAMP(3) NOT NULL,
    "orderId" TEXT,
    "orderNumber" TEXT,
    "contractDocumentId" TEXT,
    "contractDocumentTitle" TEXT,
    "lastEmailStatus" TEXT,
    "lastEmailSentAt" TIMESTAMP(3),
    "inventoryDetailId" TEXT,
    "serialNumber" TEXT,
    "batchNumber" TEXT,
    "reservedQuantity" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "quotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" TEXT NOT NULL,
    "quotationId" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "approverId" TEXT NOT NULL,
    "action" TEXT,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "soNumber" TEXT NOT NULL,
    "poNumber" TEXT,
    "quotationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "partNumber" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "totalAmount" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SO_CREATED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveryDate" TIMESTAMP(3),
    "trackingNumber" TEXT,
    "carrier" TEXT,
    "saleType" TEXT NOT NULL DEFAULT 'Sale',
    "incoterm" TEXT,
    "incotermLocation" TEXT,
    "shipToId" TEXT,
    "shipForId" TEXT,
    "warrantyDays" INTEGER,
    "warrantyStartDate" TIMESTAMP(3),
    "certificateRequired" BOOLEAN NOT NULL DEFAULT true,
    "certificateType" TEXT,
    "certificateDelivered" BOOLEAN NOT NULL DEFAULT false,
    "packagingStandard" TEXT,
    "shippingMethod" TEXT,
    "carrierAccount" TEXT,
    "inspectionRequired" BOOLEAN NOT NULL DEFAULT false,
    "inspectionPassed" BOOLEAN,
    "inspectionDate" TIMESTAMP(3),
    "customsClearanceRequired" BOOLEAN NOT NULL DEFAULT false,
    "customsDeclarationNo" TEXT,
    "importDuty" DOUBLE PRECISION,
    "vatAmount" DOUBLE PRECISION,
    "totalLandCost" DOUBLE PRECISION,
    "poNumberCustomer" TEXT,
    "soNumberInternal" TEXT,
    "exchangeCoreCharge" DOUBLE PRECISION,
    "exchangeCoreDueDate" TIMESTAMP(3),
    "eSignatureCustomer" TEXT,
    "eSignatureSupplier" TEXT,
    "inventoryDetailId" TEXT,
    "serialNumber" TEXT,
    "batchNumber" TEXT,
    "outboundQuantity" INTEGER NOT NULL DEFAULT 0,
    "outboundStatus" TEXT NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_transactions" (
    "id" TEXT NOT NULL,
    "inventoryDetailId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "beforeQuantity" INTEGER NOT NULL,
    "afterQuantity" INTEGER NOT NULL,
    "orderId" TEXT,
    "quotationId" TEXT,
    "referenceNo" TEXT,
    "referenceType" TEXT,
    "notes" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "documentType" TEXT NOT NULL DEFAULT 'ORDER_CONTRACT',
    "description" TEXT,
    "bodyTemplate" TEXT NOT NULL,
    "headerTemplate" TEXT,
    "footerTemplate" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "document_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generated_documents" (
    "id" TEXT NOT NULL,
    "templateId" TEXT,
    "quotationId" TEXT,
    "orderId" TEXT,
    "customerId" TEXT,
    "documentType" TEXT NOT NULL DEFAULT 'ORDER_CONTRACT',
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'GENERATED',
    "contentHtml" TEXT NOT NULL,
    "payloadJson" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generatedById" TEXT,

    CONSTRAINT "generated_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_emails" (
    "id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "quotationId" TEXT,
    "customerId" TEXT,
    "accountId" TEXT,
    "toEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "textBody" TEXT NOT NULL,
    "htmlBody" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "providerMessageId" TEXT,
    "sentAt" TIMESTAMP(3),
    "withdrawnAt" TIMESTAMP(3),
    "withdrawalReason" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outbound_emails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_tracking" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "trackingNumber" TEXT NOT NULL,
    "carrier" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "estimatedDelivery" TIMESTAMP(3),

    CONSTRAINT "shipment_tracking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracking_events" (
    "id" TEXT NOT NULL,
    "trackingId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "location" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "tracking_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ipc_data" (
    "id" TEXT NOT NULL,
    "partNumber" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "ataChapter" TEXT NOT NULL,
    "aircraftTypes" TEXT NOT NULL,
    "supersededBy" TEXT,
    "interchangeableWith" TEXT,
    "alternateParts" TEXT,

    CONSTRAINT "ipc_data_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vmi_agreements" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "partNumber" TEXT NOT NULL,
    "minStock" INTEGER NOT NULL,
    "maxStock" INTEGER NOT NULL,
    "reorderPoint" INTEGER NOT NULL,
    "reorderQty" INTEGER NOT NULL,

    CONSTRAINT "vmi_agreements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'INFO',
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "link" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_agents" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'CHAT',
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "config" TEXT NOT NULL DEFAULT '{}',
    "prompts" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_models" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "apiKey" TEXT,
    "baseUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "config" TEXT NOT NULL DEFAULT '{}',
    "capabilities" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'POST',
    "authType" TEXT NOT NULL DEFAULT 'none',
    "authToken" TEXT,
    "secret" TEXT,
    "customHeaders" TEXT NOT NULL DEFAULT '{}',
    "timeoutMs" INTEGER NOT NULL DEFAULT 10000,
    "maxRetries" INTEGER NOT NULL DEFAULT 3,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSuccessAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_subscriptions" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "eventTypes" TEXT NOT NULL DEFAULT '[]',
    "filters" TEXT NOT NULL DEFAULT '{"logic":"AND","rules":[]}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "requestHeaders" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 5,
    "nextRetryAt" TIMESTAMP(3),
    "responseStatus" INTEGER,
    "responseBody" TEXT,
    "lastError" TEXT,
    "failureReason" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "quarantineReason" TEXT,
    "quarantineAt" TIMESTAMP(3),
    "dlqReviewedBy" TEXT,
    "dlqAction" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_replay_batches" (
    "id" TEXT NOT NULL,
    "triggeredBy" TEXT NOT NULL DEFAULT 'SYSTEM',
    "filterQuery" TEXT NOT NULL DEFAULT '{}',
    "deliveryIds" TEXT NOT NULL DEFAULT '[]',
    "totalDeliveries" INTEGER NOT NULL DEFAULT 0,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "pending" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_replay_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_failure_analysis" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "failureReason" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "lastOccurrence" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstOccurrence" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_failure_analysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_webhook_endpoints" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "urlPath" TEXT NOT NULL,
    "authMethod" TEXT NOT NULL DEFAULT 'HMAC',
    "secret" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inbound_webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_webhook_deliveries" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "processedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbound_webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_audit_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "changes" TEXT,
    "sourceIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_logs" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "input" TEXT,
    "output" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SUCCESS',
    "error" TEXT,
    "duration" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runtime_tasks" (
    "id" TEXT NOT NULL,
    "triggerType" TEXT NOT NULL,
    "triggerSource" TEXT,
    "triggerReferenceId" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "currentStepIndex" INTEGER NOT NULL DEFAULT 0,
    "context" TEXT NOT NULL DEFAULT '{}',
    "result" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "agent_runtime_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runtime_steps" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "capability" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "params" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "result" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_runtime_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runtime_confirmations" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "titleZh" TEXT,
    "titleEn" TEXT,
    "description" TEXT NOT NULL,
    "descriptionZh" TEXT,
    "descriptionEn" TEXT,
    "data" TEXT NOT NULL DEFAULT '{}',
    "options" TEXT NOT NULL DEFAULT '[]',
    "selectedOption" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "confirmedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_runtime_confirmations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificate_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "certificateType" TEXT NOT NULL DEFAULT 'AAC-038',
    "description" TEXT,
    "bodyTemplate" TEXT NOT NULL,
    "headerTemplate" TEXT,
    "footerTemplate" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "certificate_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificates" (
    "id" TEXT NOT NULL,
    "certificateNumber" TEXT NOT NULL,
    "templateId" TEXT,
    "inventoryId" TEXT,
    "inventoryDetailId" TEXT,
    "orderId" TEXT,
    "supplierId" TEXT,
    "quotationId" TEXT,
    "partNumber" TEXT NOT NULL,
    "serialNumber" TEXT,
    "description" TEXT,
    "quantity" INTEGER,
    "conditionCode" TEXT,
    "certificateType" TEXT NOT NULL DEFAULT 'AAC-038',
    "issueDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiryDate" TIMESTAMP(3),
    "issuedBy" TEXT NOT NULL,
    "issuedById" TEXT NOT NULL,
    "issuerCompany" TEXT,
    "issuerAddress" TEXT,
    "issuerCertNo" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "qrCodeData" TEXT,
    "verificationUrl" TEXT,
    "fileUrl" TEXT,
    "fileHash" TEXT,
    "traceHistory" TEXT NOT NULL DEFAULT '[]',
    "parentCertificateId" TEXT,
    "countryOfOrigin" TEXT,
    "manufactureDate" TIMESTAMP(3),
    "batchNumber" TEXT,
    "ataChapter" TEXT,
    "aircraftModel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "certificates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_definitions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "entityType" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_steps" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "stepOrder" INTEGER NOT NULL,
    "stepType" TEXT NOT NULL DEFAULT 'APPROVAL',
    "approverRole" TEXT,
    "approverUserId" TEXT,
    "approverDepartment" TEXT,
    "agentId" TEXT,
    "isParallel" BOOLEAN NOT NULL DEFAULT false,
    "parallelMinCount" INTEGER,
    "timeoutHours" INTEGER NOT NULL DEFAULT 24,
    "timeoutAction" TEXT NOT NULL DEFAULT 'ESCALATE',
    "conditionExpression" TEXT,
    "autoAction" TEXT,
    "notificationTemplate" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_instances" (
    "id" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "currentStepId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "startedBy" TEXT NOT NULL,
    "context" TEXT NOT NULL DEFAULT '{}',

    CONSTRAINT "workflow_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_instance_steps" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "stepOrder" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "assignedTo" TEXT,
    "assignedRole" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "result" TEXT,

    CONSTRAINT "workflow_instance_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_actions" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "instanceStepId" TEXT,
    "actionType" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorRole" TEXT,
    "actorName" TEXT,
    "comment" TEXT,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "userName" TEXT,
    "userRole" TEXT,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "resourceName" TEXT,
    "changes" TEXT,
    "details" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "sessionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SUCCESS',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auctions" (
    "id" TEXT NOT NULL,
    "auctionNumber" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL DEFAULT 'SALES',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "partNumber" TEXT NOT NULL,
    "partDescription" TEXT,
    "quantity" INTEGER NOT NULL,
    "conditionCode" TEXT,
    "certificateType" TEXT,
    "startingPrice" DOUBLE PRECISION,
    "reservePrice" DOUBLE PRECISION,
    "buyNowPrice" DOUBLE PRECISION,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "autoExtend" BOOLEAN NOT NULL DEFAULT true,
    "extendMinutes" INTEGER NOT NULL DEFAULT 5,
    "sellerId" TEXT,
    "buyerId" TEXT,
    "invitedSupplierIds" TEXT,
    "winnerBidId" TEXT,
    "finalPrice" DOUBLE PRECISION,
    "closedAt" TIMESTAMP(3),
    "closedReason" TEXT,
    "inventoryId" TEXT,
    "rfqId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auctions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auction_bids" (
    "id" TEXT NOT NULL,
    "auctionId" TEXT NOT NULL,
    "bidderId" TEXT NOT NULL,
    "bidderType" TEXT NOT NULL DEFAULT 'USER',
    "bidderName" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "isAutoBid" BOOLEAN NOT NULL DEFAULT false,
    "maxAutoBid" DOUBLE PRECISION,
    "bidTime" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isWinning" BOOLEAN NOT NULL DEFAULT false,
    "isSealed" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,

    CONSTRAINT "auction_bids_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consignments" (
    "id" TEXT NOT NULL,
    "agreementNumber" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "supplierId" TEXT NOT NULL,
    "customerId" TEXT,
    "supplierName" TEXT NOT NULL,
    "customerName" TEXT,
    "partNumber" TEXT NOT NULL,
    "partDescription" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "unitCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "conditionCode" TEXT,
    "agreementDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endDate" TIMESTAMP(3) NOT NULL,
    "minStockLevel" INTEGER NOT NULL DEFAULT 0,
    "reorderPoint" INTEGER NOT NULL DEFAULT 0,
    "reorderQuantity" INTEGER NOT NULL DEFAULT 0,
    "settlementTerms" TEXT NOT NULL DEFAULT 'MONTHLY',
    "paymentTerms" TEXT,
    "commissionRate" DOUBLE PRECISION,
    "initialQuantity" INTEGER NOT NULL DEFAULT 0,
    "consumedQuantity" INTEGER NOT NULL DEFAULT 0,
    "returnedQuantity" INTEGER NOT NULL DEFAULT 0,
    "currentQuantity" INTEGER NOT NULL DEFAULT 0,
    "lastSettlementDate" TIMESTAMP(3),
    "nextSettlementDate" TIMESTAMP(3),
    "isOverdue" BOOLEAN NOT NULL DEFAULT false,
    "daysUntilExpiry" INTEGER,
    "inventoryId" TEXT,
    "orderIds" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "scopes" TEXT NOT NULL DEFAULT '["read"]',
    "rateLimit" INTEGER NOT NULL DEFAULT 1000,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blockchain_records" (
    "id" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "certificateId" TEXT NOT NULL,
    "certificateHash" TEXT NOT NULL,
    "previousHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "nonce" INTEGER NOT NULL,

    CONSTRAINT "blockchain_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_channel_bindings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "config" TEXT NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_channel_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_templates" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_userId_key" ON "notification_preferences"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_email_key" ON "suppliers"("email");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_activationToken_key" ON "suppliers"("activationToken");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_items_partNumber_key" ON "inventory_items"("partNumber");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_details_inventoryItemId_serialNumber_key" ON "inventory_details"("inventoryItemId", "serialNumber");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_details_inventoryItemId_batchNumber_conditionCode_key" ON "inventory_details"("inventoryItemId", "batchNumber", "conditionCode", "warehouse");

-- CreateIndex
CREATE UNIQUE INDEX "email_accounts_email_key" ON "email_accounts"("email");

-- CreateIndex
CREATE UNIQUE INDEX "rfqs_rfqNumber_key" ON "rfqs"("rfqNumber");

-- CreateIndex
CREATE UNIQUE INDEX "rfqs_emailId_key" ON "rfqs"("emailId");

-- CreateIndex
CREATE UNIQUE INDEX "inquiries_inquiryNumber_key" ON "inquiries"("inquiryNumber");

-- CreateIndex
CREATE INDEX "supplier_follow_up_logs_supplierId_createdAt_idx" ON "supplier_follow_up_logs"("supplierId", "createdAt");

-- CreateIndex
CREATE INDEX "supplier_follow_up_logs_taskId_idx" ON "supplier_follow_up_logs"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "quotations_quoteNumber_key" ON "quotations"("quoteNumber");

-- CreateIndex
CREATE UNIQUE INDEX "orders_orderNumber_key" ON "orders"("orderNumber");

-- CreateIndex
CREATE UNIQUE INDEX "orders_soNumber_key" ON "orders"("soNumber");

-- CreateIndex
CREATE UNIQUE INDEX "orders_quotationId_key" ON "orders"("quotationId");

-- CreateIndex
CREATE INDEX "orders_status_createdAt_idx" ON "orders"("status", "createdAt");

-- CreateIndex
CREATE INDEX "inventory_transactions_inventoryDetailId_createdAt_idx" ON "inventory_transactions"("inventoryDetailId", "createdAt");

-- CreateIndex
CREATE INDEX "inventory_transactions_orderId_idx" ON "inventory_transactions"("orderId");

-- CreateIndex
CREATE INDEX "inventory_transactions_type_createdAt_idx" ON "inventory_transactions"("type", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "document_templates_code_key" ON "document_templates"("code");

-- CreateIndex
CREATE INDEX "document_templates_documentType_isActive_isDefault_idx" ON "document_templates"("documentType", "isActive", "isDefault");

-- CreateIndex
CREATE INDEX "generated_documents_quotationId_documentType_idx" ON "generated_documents"("quotationId", "documentType");

-- CreateIndex
CREATE INDEX "generated_documents_orderId_documentType_idx" ON "generated_documents"("orderId", "documentType");

-- CreateIndex
CREATE INDEX "outbound_emails_quotationId_purpose_status_idx" ON "outbound_emails"("quotationId", "purpose", "status");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_tracking_orderId_key" ON "shipment_tracking"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "ipc_data_partNumber_key" ON "ipc_data"("partNumber");

-- CreateIndex
CREATE INDEX "webhook_subscriptions_isActive_idx" ON "webhook_subscriptions"("isActive");

-- CreateIndex
CREATE INDEX "webhook_subscriptions_endpointId_isActive_idx" ON "webhook_subscriptions"("endpointId", "isActive");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_nextRetryAt_idx" ON "webhook_deliveries"("status", "nextRetryAt");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_idx" ON "webhook_deliveries"("status");

-- CreateIndex
CREATE INDEX "webhook_deliveries_endpointId_createdAt_idx" ON "webhook_deliveries"("endpointId", "createdAt");

-- CreateIndex
CREATE INDEX "webhook_deliveries_eventId_idx" ON "webhook_deliveries"("eventId");

-- CreateIndex
CREATE INDEX "webhook_replay_batches_status_createdAt_idx" ON "webhook_replay_batches"("status", "createdAt");

-- CreateIndex
CREATE INDEX "webhook_failure_analysis_failureReason_idx" ON "webhook_failure_analysis"("failureReason");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_failure_analysis_endpointId_failureReason_key" ON "webhook_failure_analysis"("endpointId", "failureReason");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_webhook_endpoints_urlPath_key" ON "inbound_webhook_endpoints"("urlPath");

-- CreateIndex
CREATE INDEX "inbound_webhook_endpoints_sourceSystem_isActive_idx" ON "inbound_webhook_endpoints"("sourceSystem", "isActive");

-- CreateIndex
CREATE INDEX "inbound_webhook_deliveries_status_receivedAt_idx" ON "inbound_webhook_deliveries"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "webhook_audit_logs_userId_createdAt_idx" ON "webhook_audit_logs"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "webhook_audit_logs_resourceType_resourceId_idx" ON "webhook_audit_logs"("resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "agent_runtime_tasks_status_updatedAt_idx" ON "agent_runtime_tasks"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "agent_runtime_tasks_type_updatedAt_idx" ON "agent_runtime_tasks"("type", "updatedAt");

-- CreateIndex
CREATE INDEX "agent_runtime_steps_taskId_sequence_idx" ON "agent_runtime_steps"("taskId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "agent_runtime_confirmations_taskId_key" ON "agent_runtime_confirmations"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "certificate_templates_code_key" ON "certificate_templates"("code");

-- CreateIndex
CREATE INDEX "certificate_templates_certificateType_isActive_isDefault_idx" ON "certificate_templates"("certificateType", "isActive", "isDefault");

-- CreateIndex
CREATE UNIQUE INDEX "certificates_certificateNumber_key" ON "certificates"("certificateNumber");

-- CreateIndex
CREATE INDEX "certificates_partNumber_status_idx" ON "certificates"("partNumber", "status");

-- CreateIndex
CREATE INDEX "certificates_certificateType_status_idx" ON "certificates"("certificateType", "status");

-- CreateIndex
CREATE INDEX "certificates_expiryDate_status_idx" ON "certificates"("expiryDate", "status");

-- CreateIndex
CREATE INDEX "certificates_inventoryId_idx" ON "certificates"("inventoryId");

-- CreateIndex
CREATE INDEX "certificates_inventoryDetailId_idx" ON "certificates"("inventoryDetailId");

-- CreateIndex
CREATE INDEX "certificates_orderId_idx" ON "certificates"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_definitions_code_key" ON "workflow_definitions"("code");

-- CreateIndex
CREATE INDEX "workflow_definitions_entityType_isActive_idx" ON "workflow_definitions"("entityType", "isActive");

-- CreateIndex
CREATE INDEX "workflow_steps_workflowId_stepOrder_idx" ON "workflow_steps"("workflowId", "stepOrder");

-- CreateIndex
CREATE INDEX "workflow_instances_entityType_entityId_idx" ON "workflow_instances"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "workflow_instances_status_startedAt_idx" ON "workflow_instances"("status", "startedAt");

-- CreateIndex
CREATE INDEX "workflow_instance_steps_instanceId_stepOrder_idx" ON "workflow_instance_steps"("instanceId", "stepOrder");

-- CreateIndex
CREATE INDEX "workflow_instance_steps_assignedTo_status_idx" ON "workflow_instance_steps"("assignedTo", "status");

-- CreateIndex
CREATE INDEX "workflow_actions_instanceId_createdAt_idx" ON "workflow_actions"("instanceId", "createdAt");

-- CreateIndex
CREATE INDEX "workflow_actions_actorId_createdAt_idx" ON "workflow_actions"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_resourceType_resourceId_idx" ON "audit_logs"("resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "audit_logs_userId_createdAt_idx" ON "audit_logs"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_action_createdAt_idx" ON "audit_logs"("action", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "auctions_auctionNumber_key" ON "auctions"("auctionNumber");

-- CreateIndex
CREATE INDEX "auctions_status_endAt_idx" ON "auctions"("status", "endAt");

-- CreateIndex
CREATE INDEX "auctions_partNumber_status_idx" ON "auctions"("partNumber", "status");

-- CreateIndex
CREATE INDEX "auction_bids_auctionId_bidTime_idx" ON "auction_bids"("auctionId", "bidTime");

-- CreateIndex
CREATE INDEX "auction_bids_auctionId_amount_idx" ON "auction_bids"("auctionId", "amount");

-- CreateIndex
CREATE UNIQUE INDEX "consignments_agreementNumber_key" ON "consignments"("agreementNumber");

-- CreateIndex
CREATE INDEX "consignments_status_endDate_idx" ON "consignments"("status", "endDate");

-- CreateIndex
CREATE INDEX "consignments_supplierId_status_idx" ON "consignments"("supplierId", "status");

-- CreateIndex
CREATE INDEX "consignments_partNumber_status_idx" ON "consignments"("partNumber", "status");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_keyHash_key" ON "api_keys"("keyHash");

-- CreateIndex
CREATE INDEX "api_keys_keyHash_idx" ON "api_keys"("keyHash");

-- CreateIndex
CREATE INDEX "api_keys_isActive_idx" ON "api_keys"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "blockchain_records_index_key" ON "blockchain_records"("index");

-- CreateIndex
CREATE UNIQUE INDEX "blockchain_records_certificateId_key" ON "blockchain_records"("certificateId");

-- CreateIndex
CREATE INDEX "blockchain_records_certificateId_idx" ON "blockchain_records"("certificateId");

-- CreateIndex
CREATE INDEX "blockchain_records_index_idx" ON "blockchain_records"("index");

-- CreateIndex
CREATE UNIQUE INDEX "user_channel_bindings_userId_channel_key" ON "user_channel_bindings"("userId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "notification_templates_event_channel_key" ON "notification_templates"("event", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_userId_key" ON "push_subscriptions"("userId");

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitor_listings" ADD CONSTRAINT "competitor_listings_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_makers" ADD CONSTRAINT "decision_makers_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_portal_users" ADD CONSTRAINT "supplier_portal_users_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_details" ADD CONSTRAINT "inventory_details_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_details" ADD CONSTRAINT "inventory_details_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emails" ADD CONSTRAINT "emails_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "email_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_emailId_fkey" FOREIGN KEY ("emailId") REFERENCES "emails"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry_items" ADD CONSTRAINT "inquiry_items_inquiryId_fkey" FOREIGN KEY ("inquiryId") REFERENCES "inquiries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_quotes" ADD CONSTRAINT "supplier_quotes_inquiryId_fkey" FOREIGN KEY ("inquiryId") REFERENCES "inquiries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_quotes" ADD CONSTRAINT "supplier_quotes_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "rfqs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_quotes" ADD CONSTRAINT "supplier_quotes_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_follow_up_logs" ADD CONSTRAINT "supplier_follow_up_logs_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_follow_up_logs" ADD CONSTRAINT "supplier_follow_up_logs_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "rfqs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_approvedBy_fkey" FOREIGN KEY ("approvedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "quotations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "quotations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_inventoryDetailId_fkey" FOREIGN KEY ("inventoryDetailId") REFERENCES "inventory_details"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "document_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "quotations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_emails" ADD CONSTRAINT "outbound_emails_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "quotations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_emails" ADD CONSTRAINT "outbound_emails_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_emails" ADD CONSTRAINT "outbound_emails_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "email_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_tracking" ADD CONSTRAINT "shipment_tracking_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_events" ADD CONSTRAINT "tracking_events_trackingId_fkey" FOREIGN KEY ("trackingId") REFERENCES "shipment_tracking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vmi_agreements" ADD CONSTRAINT "vmi_agreements_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_webhook_deliveries" ADD CONSTRAINT "inbound_webhook_deliveries_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "inbound_webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runtime_steps" ADD CONSTRAINT "agent_runtime_steps_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "agent_runtime_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runtime_confirmations" ADD CONSTRAINT "agent_runtime_confirmations_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "agent_runtime_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "certificate_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_inventoryId_fkey" FOREIGN KEY ("inventoryId") REFERENCES "inventory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_inventoryDetailId_fkey" FOREIGN KEY ("inventoryDetailId") REFERENCES "inventory_details"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "quotations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "workflow_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_instances" ADD CONSTRAINT "workflow_instances_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "workflow_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_instance_steps" ADD CONSTRAINT "workflow_instance_steps_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "workflow_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_instance_steps" ADD CONSTRAINT "workflow_instance_steps_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "workflow_steps"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_actions" ADD CONSTRAINT "workflow_actions_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "workflow_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_actions" ADD CONSTRAINT "workflow_actions_instanceStepId_fkey" FOREIGN KEY ("instanceStepId") REFERENCES "workflow_instance_steps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auction_bids" ADD CONSTRAINT "auction_bids_auctionId_fkey" FOREIGN KEY ("auctionId") REFERENCES "auctions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_channel_bindings" ADD CONSTRAINT "user_channel_bindings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
