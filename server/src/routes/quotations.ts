import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { buildContentDisposition } from '../lib/downloadHeaders.js';
import { validateBody } from '../middleware/validate.js';
import {
  quotationCreateSchema,
  quotationApproveSchema,
  quotationSendSchema,
  quotationWithdrawSchema,
  quotationAcceptSchema,
} from '../lib/validation.js';
import { AuthRequest } from '../middleware/auth.js';
import { generateQuotationPDF } from '../lib/pdfService.js';
import { decrypt } from '../lib/crypto.js';
import { sendEmail, type EmailAccountConfig } from '../lib/emailService.js';
import { createOrderFromQuotation, mapOrderResponse } from '../lib/orderWorkflowService.js';
import { ensureOrderContractDocument, ORDER_CONTRACT_DOCUMENT_TYPE } from '../lib/documentTemplateService.js';
import { emitWebhookEvent } from '../lib/webhookService.js';
import prisma from '../lib/prisma.js';

const router = Router();

function buildOutboundAccountConfig(account: {
  id: string;
  email: string;
  displayName: string | null;
  imapServer: string;
  imapPort: string;
  smtpServer: string;
  smtpPort: string;
  authCode: string;
  accountType: string;
}): EmailAccountConfig {
  return {
    id: account.id,
    email: account.email,
    displayName: account.displayName,
    imapServer: account.imapServer,
    imapPort: account.imapPort,
    smtpServer: account.smtpServer,
    smtpPort: account.smtpPort,
    authCode: decrypt(account.authCode),
    accountType: account.accountType,
  };
}

async function getDefaultOutboundAccount() {
  const account = await prisma.emailAccount.findFirst({
    where: { isActive: true },
    orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
  });

  if (!account) {
    throw new AppError('未配置可用的发件邮箱，请先在系统设置中启用默认邮箱账户', 400, 'BAD_REQUEST');
  }

  return buildOutboundAccountConfig(account);
}

function textToHtml(text: string) {
  return text
    .split('\n')
    .map((line) => `<p>${line}</p>`)
    .join('');
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { status, page, limit } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * pageSize;

    const where: Prisma.QuotationWhereInput = {};
    if (status) where.status = status.toString().toUpperCase();

    const [quotations, total] = await Promise.all([
      prisma.quotation.findMany({
        where,
        include: {
          customer: true,
          creator: { select: { id: true, name: true } },
          approver: { select: { id: true, name: true } },
          rfq: { select: { id: true, rfqNumber: true, urgency: true } },
          orders: {
            select: { id: true, orderNumber: true },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
          generatedDocuments: {
            orderBy: { generatedAt: 'desc' },
            take: 3,
          },
          outboundEmails: {
            orderBy: { createdAt: 'desc' },
            take: 5,
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      prisma.quotation.count({ where }),
    ]);

    const userRole = (req as AuthRequest).user?.role;
    const isAdminOrManager = userRole === 'admin' || userRole === 'manager';
    res.json({
      success: true,
      data: quotations.map((q) => {
        const latestContract = q.generatedDocuments.find((doc) => doc.documentType === ORDER_CONTRACT_DOCUMENT_TYPE);
        const latestEmail = q.outboundEmails.find((email) => email.purpose === 'QUOTATION_SEND');
        const latestOrder = q.orders[0];

        return {
          id: q.id,
          quoteNumber: q.quoteNumber,
          rfqId: q.rfqId,
          customerId: q.customerId,
          customerName: q.customer.name,
          customerEmail: q.customer.email,
          customerContactName: q.customer.contactName,
          partNumber: q.partNumber,
          quantity: q.quantity,
          unitPrice: q.unitPrice,
          totalPrice: q.totalPrice,
          ...(isAdminOrManager ? { costPrice: q.costPrice, margin: q.margin } : {}),
          certificateFiles: q.certificateFiles?.split(',').filter(Boolean) || [],
          template: q.template.toLowerCase(),
          status: q.status.toLowerCase(),
          validityDays: q.validityDays,
          saleType: q.saleType,
          incoterm: q.incoterm,
          incotermLocation: q.incotermLocation,
          leadTimeDays: q.leadTimeDays,
          leadTimeBasis: q.leadTimeBasis,
          moq: q.moq,
          mpq: q.mpq,
          priceBasis: q.priceBasis,
          taxIncluded: q.taxIncluded,
          taxRate: q.taxRate,
          warrantyDays: q.warrantyDays,
          warrantyTerms: q.warrantyTerms,
          packagingRequirement: q.packagingRequirement,
          shippingMethod: q.shippingMethod,
          countryOfOrigin: q.countryOfOrigin,
          hsCode: q.hsCode,
          eccn: q.eccn,
          dualUse: q.dualUse,
          ccRecipients: q.ccRecipients ? JSON.parse(q.ccRecipients) : [],
          commonNote: q.commonNote,
          eSignatureStatus: q.eSignatureStatus,
          createdAt: q.createdAt.toISOString(),
          createdBy: q.creator.name,
          approvedBy: q.approver?.name || q.approvedBy,
          approvedAt: q.approvedAt?.toISOString(),
          sentAt: q.sentAt?.toISOString(),
          acceptedAt: q.acceptedAt?.toISOString(),
          withdrawnAt: q.withdrawnAt?.toISOString(),
          withdrawalReason: q.withdrawalReason,
          customerConfirmationNote: q.customerConfirmationNote,
          expiryDate: q.expiryDate.toISOString().split('T')[0],
          orderId: latestOrder?.id,
          orderNumber: latestOrder?.orderNumber,
          contractDocumentId: latestContract?.id,
          contractDocumentTitle: latestContract?.title,
          lastEmailStatus: latestEmail?.status.toLowerCase(),
          lastEmailSentAt: latestEmail?.sentAt?.toISOString(),
          rfqUrgency: q.rfq?.urgency?.toLowerCase(),
        };
      }),
      pagination: { page: pageNum, limit: pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const quotation = await prisma.quotation.findUnique({
      where: { id: req.params.id },
      include: {
        customer: true,
        creator: { select: { id: true, name: true } },
        approver: { select: { id: true, name: true } },
        rfq: true,
        approvals: { include: { approver: true } },
        orders: { include: { customer: true } },
        generatedDocuments: {
          orderBy: { generatedAt: 'desc' },
          include: { template: true },
        },
        outboundEmails: {
          orderBy: { createdAt: 'desc' },
          include: {
            account: {
              select: {
                id: true,
                email: true,
                displayName: true,
              },
            },
          },
        },
      },
    });

    if (!quotation) {
      throw new AppError('报价单不存在', 404);
    }

    res.json({
      success: true,
      data: {
        ...quotation,
        status: quotation.status.toLowerCase(),
        template: quotation.template.toLowerCase(),
        acceptedAt: quotation.acceptedAt?.toISOString(),
        withdrawnAt: quotation.withdrawnAt?.toISOString(),
        sentAt: quotation.sentAt?.toISOString(),
        approvedAt: quotation.approvedAt?.toISOString(),
        createdAt: quotation.createdAt.toISOString(),
        expiryDate: quotation.expiryDate.toISOString().split('T')[0],
        certificateFiles: quotation.certificateFiles?.split(',').filter(Boolean) || [],
        ccRecipients: quotation.ccRecipients ? JSON.parse(quotation.ccRecipients) : [],
        customerEmail: quotation.customer.email,
        customerContactName: quotation.customer.contactName,
        rfqUrgency: quotation.rfq?.urgency?.toLowerCase(),
        contractDocumentId: quotation.generatedDocuments.find((doc) => doc.documentType === ORDER_CONTRACT_DOCUMENT_TYPE)?.id,
        contractDocumentTitle: quotation.generatedDocuments.find((doc) => doc.documentType === ORDER_CONTRACT_DOCUMENT_TYPE)?.title,
        outboundEmails: quotation.outboundEmails.map((email) => ({
          id: email.id,
          purpose: email.purpose.toLowerCase(),
          toEmail: email.toEmail,
          subject: email.subject,
          status: email.status.toLowerCase(),
          sentAt: email.sentAt?.toISOString(),
          withdrawnAt: email.withdrawnAt?.toISOString(),
          withdrawalReason: email.withdrawalReason,
          createdAt: email.createdAt.toISOString(),
          updatedAt: email.updatedAt.toISOString(),
          account: email.account,
        })),
      },
    });
  })
);

router.post(
  '/',
  validateBody(quotationCreateSchema),
  asyncHandler(async (req, res) => {
  const { rfqId, customerId, partNumber, quantity, unitPrice, costPrice, certificateFiles, template, validityDays,
    saleType, shipToId, shipForId, incoterm, incotermLocation, leadTimeDays, leadTimeBasis,
    moq, mpq, priceBasis, taxIncluded, taxRate, warrantyDays, warrantyTerms,
    packagingRequirement, shippingMethod, ccRecipients, commonNote,
    eSignature, eSignatureStatus, countryOfOrigin, hsCode, eccn, dualUse,
  } = req.body;

    // Check if associated RFQ is AOG
    let isAog = false;
    if (rfqId) {
      const rfq = await prisma.rFQ.findUnique({ where: { id: rfqId } });
      if (rfq && rfq.urgency.toUpperCase() === 'AOG') {
        isAog = true;
      }
    }

    const finalValidityDays = isAog ? 1 : (validityDays || 7);
    const totalPrice = quantity * unitPrice;
    const margin = totalPrice > 0
      ? ((totalPrice - costPrice * quantity) / totalPrice * 100)
      : 0;
    const quoteNumber = `QT-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + finalValidityDays);

    const quotation = await prisma.quotation.create({
      data: {
        quoteNumber,
        rfqId,
        customerId,
        partNumber,
        quantity,
        unitPrice,
        totalPrice,
        costPrice,
        margin,
        certificateFiles: Array.isArray(certificateFiles) ? certificateFiles.join(',') : certificateFiles,
        template: template?.toUpperCase() || 'STANDARD',
        status: isAog ? 'PENDING_APPROVAL' : 'DRAFT',
        validityDays: finalValidityDays,
        saleType: saleType || 'Sale',
        shipToId: shipToId || null,
        shipForId: shipForId || null,
        incoterm: incoterm || null,
        incotermLocation: incotermLocation || null,
        leadTimeDays: leadTimeDays || null,
        leadTimeBasis: leadTimeBasis || null,
        moq: moq || null,
        mpq: mpq || null,
        priceBasis: priceBasis || null,
        taxIncluded: taxIncluded !== undefined ? taxIncluded : true,
        taxRate: taxRate || null,
        warrantyDays: warrantyDays || 90,
        warrantyTerms: warrantyTerms || null,
        packagingRequirement: packagingRequirement || null,
        shippingMethod: shippingMethod || null,
        ccRecipients: Array.isArray(ccRecipients) ? JSON.stringify(ccRecipients) : ccRecipients || null,
        commonNote: commonNote || null,
        eSignature: eSignature || null,
        eSignatureStatus: eSignatureStatus || 'Unsigned',
        countryOfOrigin: countryOfOrigin || null,
        hsCode: hsCode || null,
        eccn: eccn || null,
        dualUse: dualUse !== undefined ? dualUse : false,
        expiryDate,
        createdBy: (req as AuthRequest).user!.id,
      },
      include: { customer: true },
    });

    // If AOG, update RFQ status to quoting and notify managers
    if (isAog && rfqId) {
      await prisma.rFQ.update({
        where: { id: rfqId },
        data: { status: 'QUOTING' },
      });

      // Create parallel approval notifications for manager and gm
      const managers = await prisma.user.findMany({
        where: { role: { in: ['MANAGER', 'GM'] }, isActive: true },
        select: { id: true },
      });

      await prisma.notification.createMany({
        data: managers.map((m) => ({
          userId: m.id,
          title: 'AOG 报价单待审批',
          message: `AOG 紧急报价单 ${quotation.quoteNumber}（件号 ${quotation.partNumber}）已创建，请尽快审批。有效期仅 1 天。`,
          type: 'warning' as const,
          link: `/quotations/${quotation.id}`,
        })),
      });
    }

    await emitWebhookEvent('quotation.created', {
      quotationId: quotation.id,
      quoteNumber: quotation.quoteNumber,
      customerId: quotation.customerId,
      customerName: quotation.customer.name,
      rfqId: quotation.rfqId,
      status: quotation.status,
      totalPrice: quotation.totalPrice,
      margin: quotation.margin,
      createdBy: (req as AuthRequest).user?.id,
    });

    res.status(201).json({
      success: true,
      data: {
        id: quotation.id,
        quoteNumber: quotation.quoteNumber,
        customerName: quotation.customer.name,
        status: quotation.status.toLowerCase(),
        totalPrice: quotation.totalPrice,
        margin: quotation.margin,
      },
    });
  })
);

router.post(
  '/:id/submit',
  asyncHandler(async (req, res) => {
    const quotation = await prisma.quotation.update({
      where: { id: req.params.id },
      data: { status: 'PENDING_APPROVAL' },
    });

    await emitWebhookEvent('quotation.submitted', {
      quotationId: quotation.id,
      quoteNumber: quotation.quoteNumber,
      status: quotation.status,
      submittedBy: (req as AuthRequest).user?.id,
      submittedAt: new Date().toISOString(),
    });

    res.json({
      success: true,
      data: { ...quotation, status: quotation.status.toLowerCase() },
    });
  })
);

router.post(
  '/:id/approve',
  validateBody(quotationApproveSchema),
  asyncHandler(async (req, res) => {
    const { action, comment } = req.body;
    const userId = (req as AuthRequest).user!.id;

    const quotationWithRfq = await prisma.quotation.findUnique({
      where: { id: req.params.id },
      include: { rfq: true },
    });

    if (!quotationWithRfq) {
      throw new AppError('报价单不存在', 404);
    }

    const isAog = quotationWithRfq.rfq?.urgency?.toUpperCase() === 'AOG';

    const quotation = await prisma.quotation.update({
      where: { id: req.params.id },
      data: {
        status: action === 'approve' ? 'APPROVED' : 'REJECTED',
        approvedBy: action === 'approve' ? userId : null,
        approvedAt: action === 'approve' ? new Date() : null,
      },
    });

    await prisma.approval.create({
      data: {
        quotationId: req.params.id,
        level: isAog ? 'AOG' : (quotation.totalPrice > 50000 ? 'GM' : quotation.totalPrice > 5000 ? 'FINANCE' : 'MANAGER'),
        approverId: userId,
        action: action.toUpperCase(),
        comment,
      },
    });

    await emitWebhookEvent(action === 'approve' ? 'quotation.approved' : 'quotation.rejected', {
      quotationId: quotation.id,
      quoteNumber: quotation.quoteNumber,
      status: quotation.status,
      totalPrice: quotation.totalPrice,
      comment,
      approvedBy: action === 'approve' ? userId : null,
      reviewedBy: userId,
      reviewedAt: new Date().toISOString(),
    });

    res.json({
      success: true,
      data: { ...quotation, status: quotation.status.toLowerCase() },
    });
  })
);

router.post(
  '/:id/send',
  validateBody(quotationSendSchema),
  asyncHandler(async (req, res) => {
    const quotation = await prisma.quotation.findUnique({
      where: { id: req.params.id },
      include: { customer: true },
    });

    if (!quotation) {
      throw new AppError('报价单不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    if (quotation.status === 'WITHDRAWN') {
      throw new AppError('已撤回的报价不能再次发送，请复制或新建报价后重新发送', 400, 'BAD_REQUEST');
    }

    if (!['APPROVED', 'SENT'].includes(quotation.status)) {
      throw new AppError('只有已审批报价才能发送给客户', 400, 'BAD_REQUEST');
    }

    if (!quotation.customer.email) {
      throw new AppError('客户未配置邮箱地址，无法发送报价', 400, 'BAD_REQUEST');
    }

    const account = await getDefaultOutboundAccount();
    const subject = req.body.subject || `Quotation ${quotation.quoteNumber} - ${quotation.partNumber}`;
    const plainBody = req.body.message || [
      `${quotation.customer.contactName || quotation.customer.name} 您好，`,
      '',
      `附件为报价单 ${quotation.quoteNumber}，对应件号 ${quotation.partNumber}。`,
      `数量：${quotation.quantity}`,
      `总价：USD ${quotation.totalPrice.toLocaleString('en-US')}`,
      `销售类型：${quotation.saleType || 'Sale'}`,
      `贸易术语：${quotation.incoterm || '-'} ${quotation.incotermLocation || ''}`,
      `交货期：${quotation.leadTimeDays || '-'} 天`,
      `含税：${quotation.taxIncluded ? '是' : '否'}${quotation.taxRate ? ` (税率 ${quotation.taxRate}%)` : ''}`,
      `质保：${quotation.warrantyDays || 90} 天`,
      '',
      '如确认报价，请在系统中登记客户确认，系统将自动生成销售订单与合同。',
      '',
      'AeroLink 销售团队',
    ].join('\n');

    const pdfBuffer = await generateQuotationPDF({
      quoteNumber: quotation.quoteNumber,
      customerName: quotation.customer.name,
      partNumber: quotation.partNumber,
      quantity: quotation.quantity,
      unitPrice: quotation.unitPrice,
      totalPrice: quotation.totalPrice,
      costPrice: quotation.costPrice,
      margin: quotation.margin,
      validityDays: quotation.validityDays,
      saleType: quotation.saleType,
      incoterm: quotation.incoterm || '',
      incotermLocation: quotation.incotermLocation || '',
      leadTimeDays: quotation.leadTimeDays || undefined,
      leadTimeBasis: quotation.leadTimeBasis || '',
      moq: quotation.moq || undefined,
      mpq: quotation.mpq || undefined,
      priceBasis: quotation.priceBasis || '',
      taxIncluded: quotation.taxIncluded,
      taxRate: quotation.taxRate || undefined,
      warrantyDays: quotation.warrantyDays,
      warrantyTerms: quotation.warrantyTerms || '',
      packagingRequirement: quotation.packagingRequirement || '',
      shippingMethod: quotation.shippingMethod || '',
      commonNote: quotation.commonNote || '',
      certificateFiles: quotation.certificateFiles?.split(',').filter(Boolean),
      createdAt: quotation.createdAt.toISOString(),
      expiryDate: quotation.expiryDate.toISOString().split('T')[0],
      createdBy: quotation.createdBy,
    });

    const pendingEmail = await prisma.outboundEmail.create({
      data: {
        purpose: 'QUOTATION_SEND',
        quotationId: quotation.id,
        customerId: quotation.customerId,
        accountId: account.id,
        toEmail: quotation.customer.email,
        subject,
        textBody: plainBody,
        htmlBody: textToHtml(plainBody),
        status: 'PENDING',
      },
    });

    try {
      const sendResult = await sendEmail(account, {
        to: quotation.customer.email,
        subject,
        body: plainBody,
        html: textToHtml(plainBody),
        attachments: [
          {
            filename: `${quotation.quoteNumber}.pdf`,
            content: pdfBuffer,
            contentType: 'application/pdf',
          },
        ],
      });

      const sentAt = new Date();
      const [updatedQuotation, updatedEmail] = await prisma.$transaction([
        prisma.quotation.update({
          where: { id: quotation.id },
          data: {
            status: 'SENT',
            sentAt,
          },
        }),
        prisma.outboundEmail.update({
          where: { id: pendingEmail.id },
          data: {
            status: 'SENT',
            sentAt,
            providerMessageId: sendResult.messageId ?? undefined,
          },
        }),
      ]);

      await emitWebhookEvent('quotation.sent', {
        quotationId: updatedQuotation.id,
        quoteNumber: updatedQuotation.quoteNumber,
        status: updatedQuotation.status,
        sentAt: updatedQuotation.sentAt?.toISOString(),
        outboundEmailId: updatedEmail.id,
        toEmail: updatedEmail.toEmail,
      });

      res.json({
        success: true,
        data: {
          id: updatedQuotation.id,
          quoteNumber: updatedQuotation.quoteNumber,
          status: updatedQuotation.status.toLowerCase(),
          sentAt: updatedQuotation.sentAt?.toISOString(),
          outboundEmailId: updatedEmail.id,
          customerEmail: quotation.customer.email,
        },
      });
    } catch (error) {
      await prisma.outboundEmail.update({
        where: { id: pendingEmail.id },
        data: {
          status: 'FAILED',
          errorMessage: error instanceof Error ? error.message : 'Unknown send error',
        },
      });
      throw new AppError('报价邮件发送失败，请检查默认邮箱账户配置后重试', 500, 'INTERNAL_ERROR');
    }
  })
);

router.post(
  '/:id/withdraw',
  validateBody(quotationWithdrawSchema),
  asyncHandler(async (req, res) => {
    const quotation = await prisma.quotation.findUnique({
      where: { id: req.params.id },
      include: {
        customer: true,
        outboundEmails: {
          where: { purpose: 'QUOTATION_SEND', status: 'SENT' },
          orderBy: { sentAt: 'desc' },
          take: 1,
        },
      },
    });

    if (!quotation) {
      throw new AppError('报价单不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    if (quotation.status === 'ACCEPTED') {
      throw new AppError('客户已确认的报价不能直接撤回，请通过订单/变更流程处理', 400, 'BAD_REQUEST');
    }

    if (quotation.status === 'WITHDRAWN') {
      throw new AppError('该报价已撤回，无需重复操作', 400, 'BAD_REQUEST');
    }

    const latestSentEmail = quotation.outboundEmails[0];
    if (!latestSentEmail) {
      throw new AppError('当前报价没有已发送记录，不能执行撤回', 400, 'BAD_REQUEST');
    }

    const reason = req.body.reason;
    const sendWithdrawalNotice = req.body.sendWithdrawalNotice ?? true;
    const withdrawnAt = new Date();

    const [updatedQuotation] = await prisma.$transaction([
      prisma.quotation.update({
        where: { id: quotation.id },
        data: {
          status: 'WITHDRAWN',
          withdrawnAt,
          withdrawalReason: reason,
        },
      }),
      prisma.outboundEmail.update({
        where: { id: latestSentEmail.id },
        data: {
          status: 'WITHDRAWN',
          withdrawnAt,
          withdrawalReason: reason,
        },
      }),
    ]);

    let noticeId: string | undefined;
    if (sendWithdrawalNotice) {
      if (!quotation.customer.email) {
        throw new AppError('客户未配置邮箱，无法发送撤回通知', 400, 'BAD_REQUEST');
      }

      const account = await getDefaultOutboundAccount();
      const subject = `Withdrawal Notice: ${quotation.quoteNumber}`;
      const plainBody = [
        `${quotation.customer.contactName || quotation.customer.name} 您好，`,
        '',
        `此前发送的报价单 ${quotation.quoteNumber} 已撤回，请忽略旧版报价。`,
        `撤回原因：${reason}`,
        '',
        '如需新版报价，我们会尽快补发。',
        '',
        'AeroLink 销售团队',
      ].join('\n');

      const notice = await prisma.outboundEmail.create({
        data: {
          purpose: 'QUOTATION_WITHDRAWAL',
          quotationId: quotation.id,
          customerId: quotation.customerId,
          accountId: account.id,
          toEmail: quotation.customer.email,
          subject,
          textBody: plainBody,
          htmlBody: textToHtml(plainBody),
          status: 'PENDING',
          withdrawalReason: reason,
        },
      });

      try {
        const sendResult = await sendEmail(account, {
          to: quotation.customer.email,
          subject,
          body: plainBody,
          html: textToHtml(plainBody),
        });

        const updatedNotice = await prisma.outboundEmail.update({
          where: { id: notice.id },
          data: {
            status: 'SENT',
            sentAt: new Date(),
            providerMessageId: sendResult.messageId ?? undefined,
          },
        });
        noticeId = updatedNotice.id;
      } catch (error) {
        await prisma.outboundEmail.update({
          where: { id: notice.id },
          data: {
            status: 'FAILED',
            errorMessage: error instanceof Error ? error.message : 'Unknown withdrawal send error',
          },
        });
        throw new AppError('报价已标记撤回，但撤回通知发送失败，请检查邮箱配置后重试', 500, 'INTERNAL_ERROR');
      }
    }

    await emitWebhookEvent('quotation.withdrawn', {
      quotationId: updatedQuotation.id,
      quoteNumber: updatedQuotation.quoteNumber,
      withdrawnAt: updatedQuotation.withdrawnAt?.toISOString(),
      withdrawalReason: updatedQuotation.withdrawalReason,
      withdrawalNoticeId: noticeId,
    });

    res.json({
      success: true,
      data: {
        id: updatedQuotation.id,
        quoteNumber: updatedQuotation.quoteNumber,
        status: updatedQuotation.status.toLowerCase(),
        withdrawnAt: updatedQuotation.withdrawnAt?.toISOString(),
        withdrawalReason: updatedQuotation.withdrawalReason,
        withdrawalNoticeId: noticeId,
      },
    });
  })
);

router.post(
  '/:id/accept',
  validateBody(quotationAcceptSchema),
  asyncHandler(async (req, res) => {
    const quotation = await prisma.quotation.findUnique({
      where: { id: req.params.id },
      include: {
        customer: true,
      },
    });

    if (!quotation) {
      throw new AppError('报价单不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    if (quotation.status === 'WITHDRAWN') {
      throw new AppError('已撤回的报价不能登记客户确认', 400, 'BAD_REQUEST');
    }

    if (!['APPROVED', 'SENT', 'ACCEPTED'].includes(quotation.status)) {
      throw new AppError('当前报价状态不能登记客户确认', 400, 'BAD_REQUEST');
    }

    const acceptedAt = quotation.acceptedAt || new Date();
    const { poNumber, deliveryDate, templateId, confirmationNote } = req.body;

    const { updatedQuotation, order, isNewOrder } = await prisma.$transaction(async (tx) => {
      const updated = await tx.quotation.update({
        where: { id: quotation.id },
        data: {
          status: 'ACCEPTED',
          acceptedAt,
          customerConfirmationNote: confirmationNote ?? quotation.customerConfirmationNote,
        },
      });

      const existingOrder = await tx.order.findFirst({
        where: { quotationId: quotation.id },
        include: { customer: true },
      });

      if (existingOrder) {
        return {
          updatedQuotation: updated,
          order: existingOrder,
          isNewOrder: false,
        };
      }

      const createdOrder = await createOrderFromQuotation({
        tx,
        quotation: updated,
        customer: quotation.customer,
        poNumber,
        deliveryDate,
      });

      return {
        updatedQuotation: updated,
        order: createdOrder,
        isNewOrder: true,
      };
    });

    const generatedDocument = await ensureOrderContractDocument({
      quotation: updatedQuotation,
      customer: quotation.customer,
      order,
      templateId,
      generatedById: (req as AuthRequest).user?.id,
    });

    await emitWebhookEvent('quotation.accepted', {
      quotationId: updatedQuotation.id,
      quoteNumber: updatedQuotation.quoteNumber,
      acceptedAt: updatedQuotation.acceptedAt?.toISOString(),
      orderId: order.id,
      contractDocumentId: generatedDocument.id,
      autoCreatedOrder: isNewOrder,
    });

    if (isNewOrder) {
      await emitWebhookEvent('order.created', {
        orderId: order.id,
        orderNumber: order.orderNumber,
        soNumber: order.soNumber,
        quotationId: order.quotationId,
        customerId: order.customerId,
        customerName: order.customer.name,
        status: order.status,
        totalAmount: order.totalAmount,
        createdAt: order.createdAt.toISOString(),
      });
    }

    res.json({
      success: true,
      data: {
        id: updatedQuotation.id,
        quoteNumber: updatedQuotation.quoteNumber,
        status: updatedQuotation.status.toLowerCase(),
        acceptedAt: updatedQuotation.acceptedAt?.toISOString(),
        customerConfirmationNote: updatedQuotation.customerConfirmationNote,
        order: mapOrderResponse(order),
        contractDocumentId: generatedDocument.id,
        contractDocumentTitle: generatedDocument.title,
      },
    });
  })
);

router.get(
  '/:id/pdf',
  asyncHandler(async (req, res) => {
    const quotation = await prisma.quotation.findUnique({
      where: { id: req.params.id },
      include: { customer: true },
    });

    if (!quotation) {
      throw new AppError('报价单不存在', 404);
    }

    const pdfBuffer = await generateQuotationPDF({
      quoteNumber: quotation.quoteNumber,
      customerName: quotation.customer.name,
      partNumber: quotation.partNumber,
      quantity: quotation.quantity,
      unitPrice: quotation.unitPrice,
      totalPrice: quotation.totalPrice,
      costPrice: quotation.costPrice,
      margin: quotation.margin,
      validityDays: quotation.validityDays,
      saleType: quotation.saleType,
      incoterm: quotation.incoterm || '',
      incotermLocation: quotation.incotermLocation || '',
      leadTimeDays: quotation.leadTimeDays || undefined,
      leadTimeBasis: quotation.leadTimeBasis || '',
      moq: quotation.moq || undefined,
      mpq: quotation.mpq || undefined,
      priceBasis: quotation.priceBasis || '',
      taxIncluded: quotation.taxIncluded,
      taxRate: quotation.taxRate || undefined,
      warrantyDays: quotation.warrantyDays,
      warrantyTerms: quotation.warrantyTerms || '',
      packagingRequirement: quotation.packagingRequirement || '',
      shippingMethod: quotation.shippingMethod || '',
      commonNote: quotation.commonNote || '',
      certificateFiles: quotation.certificateFiles?.split(',').filter(Boolean),
      createdAt: quotation.createdAt.toISOString(),
      expiryDate: quotation.expiryDate.toISOString().split('T')[0],
      createdBy: quotation.createdBy,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', buildContentDisposition(`${quotation.quoteNumber}.pdf`));
    res.send(pdfBuffer);
  })
);

export default router;
