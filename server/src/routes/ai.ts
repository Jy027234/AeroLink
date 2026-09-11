import { Router } from 'express';
import { z } from 'zod';
import type { AuthRequest } from '../middleware/auth.js';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { assertCapability, requireCapability } from '../middleware/capability.js';
import { classifyRFQEmail } from '../lib/aiService.js';
import { executeBuiltinAgent } from '../lib/aiAgentExecution.js';
import { buildRfqReadScope } from '../lib/rfqAccess.js';
import prisma from '../lib/prisma.js';

const router = Router();
router.use(requireCapability('agent', 'run'));
const text = z.string().trim().min(1).max(40_000);
const identity = z.string().min(1).max(200);
const actor = (req: AuthRequest, action: string) => ({ actorId: req.user!.id, action });
const aiMetadata = (result: { agentId: string; promptVersion: number; model: string }) => ({
  agentId: result.agentId, promptVersion: result.promptVersion, model: result.model,
});

router.post('/parse-email', requireCapability('email', 'read'), asyncHandler(async (request, res) => {
  const req = request as AuthRequest;
  const input = z.union([
    z.object({ emailId: identity }).strict(),
    z.object({ subject: text, body: text }).strict(),
  ]).parse(req.body);
  let subject: string;
  let body: string;
  if ('emailId' in input) {
    const email = await prisma.email.findUnique({ where: { id: input.emailId }, select: { subject: true, body: true } });
    if (!email) throw new AppError('邮件不存在', 404, 'RESOURCE_NOT_FOUND');
    ({ subject, body } = email);
  } else ({ subject, body } = input);
  const result = await classifyRFQEmail(subject, body, actor(req, 'business.parse-email'));
  res.json({ success: true, data: result });
}));

router.post('/analyze-quotes', requireCapability('supplier_quote', 'read'), requireCapability('rfq', 'read'), asyncHandler(async (request, res) => {
  const req = request as AuthRequest;
  const input = z.union([
    z.object({ rfqId: identity }).strict(),
    z.object({ rfqDetails: text, supplierQuotes: text }).strict(),
  ]).parse(req.body);
  let rfqDetails: string;
  let supplierQuotes: string;
  if ('rfqId' in input) {
    const rfq = await prisma.rFQ.findFirst({
      where: { AND: [{ id: input.rfqId }, buildRfqReadScope(req.user!)] },
      select: { rfqNumber: true, partNumber: true, quantity: true, requiredDate: true, urgency: true,
        lines: { where: { status: { not: 'CANCELLED' } }, select: { lineNo: true, partNumber: true, quantity: true } } },
    });
    if (!rfq) throw new AppError('需求单不存在或无权访问', 404, 'RESOURCE_NOT_FOUND');
    const quotes = await prisma.supplierQuote.findMany({
      where: { rfqId: input.rfqId }, take: 101, orderBy: { createdAt: 'desc' },
      select: { id: true, partNumber: true, quantity: true, unitPriceDecimal: true, unitPrice: true,
        totalPriceDecimal: true, totalPrice: true, currency: true, currencyReviewStatus: true,
        leadTimeDays: true, validUntil: true, status: true, supplier: { select: { name: true } } },
    });
    if (!quotes.length) throw new AppError('该需求单尚无供应商报价', 409, 'STATE_CONFLICT');
    if (quotes.length > 100) throw new AppError('同一需求单报价超过 100 条，请先整理后分析', 400);
    rfqDetails = JSON.stringify(rfq);
    supplierQuotes = JSON.stringify(quotes.map((quote) => ({
      id: quote.id, supplier: quote.supplier.name, partNumber: quote.partNumber, quantity: quote.quantity,
      unitPrice: quote.unitPriceDecimal?.toString() ?? quote.unitPrice,
      totalPrice: quote.totalPriceDecimal?.toString() ?? quote.totalPrice,
      currency: quote.currency, currencyReviewStatus: quote.currencyReviewStatus,
      leadTimeDays: quote.leadTimeDays, validUntil: quote.validUntil, status: quote.status,
    })));
  } else ({ rfqDetails, supplierQuotes } = input);
  const result = await executeBuiltinAgent('quote_analysis', { rfqDetails, supplierQuotes }, actor(req, 'business.analyze-quotes'));
  res.json({ success: true, data: { analysis: result.output, ai: aiMetadata(result) } });
}));

router.post('/generate-email', requireCapability('quotation', 'read'), asyncHandler(async (request, res) => {
  const req = request as AuthRequest;
  const input = z.union([
    z.object({ quotationId: identity }).strict(),
    z.object({ customerName: text, partNumber: text, quantity: z.number().positive(), unitPrice: z.number().nonnegative(),
      totalPrice: z.number().nonnegative(), incoterm: z.string().max(100).optional(), incotermLocation: z.string().max(200).optional(),
      leadTimeDays: z.number().nonnegative().optional(), validityDays: z.number().positive() }).strict(),
  ]).parse(req.body);
  let quotation: Record<string, unknown>;
  if ('quotationId' in input) {
    const quote = await prisma.quotation.findUnique({ where: { id: input.quotationId },
      include: { creator: { select: { department: true } }, customer: { select: { name: true } },
        lines: { orderBy: { lineNo: 'asc' } } },
    });
    if (!quote) throw new AppError('报价不存在', 404, 'RESOURCE_NOT_FOUND');
    assertCapability(req.user!, 'quotation', 'read', { ownerId: quote.createdBy, department: quote.creator?.department });
    quotation = {
      quoteNumber: quote.quoteNumber, customerName: quote.customer.name, partNumber: quote.partNumber,
      quantity: quote.quantity, unitPrice: quote.unitPriceDecimal?.toString() ?? quote.unitPrice,
      totalPrice: quote.totalPriceDecimal?.toString() ?? quote.totalPrice,
      incoterm: quote.incoterm, incotermLocation: quote.incotermLocation, leadTimeDays: quote.leadTimeDays,
      validityDays: quote.validityDays,
      lines: quote.lines.map((line) => ({ partNumber: line.partNumber, quantity: line.quantity,
        unitPrice: line.unitPrice.toString(), totalPrice: line.lineTotal.toString() })),
    };
  } else quotation = input;
  const result = await executeBuiltinAgent('customer_email', { quotation: { ...quotation, currency: 'USD' } }, actor(req, 'business.generate-email'));
  res.json({ success: true, data: { email: result.output, ai: aiMetadata(result) } });
}));

router.post('/chat', asyncHandler(async (request, res) => {
  const req = request as AuthRequest;
  const input = z.object({ message: text }).strict().parse(req.body);
  const result = await executeBuiltinAgent('business_chat', input, actor(req, 'business.chat'));
  res.json({ success: true, data: { content: result.output, model: result.model, latency: result.latency, ai: aiMetadata(result) } });
}));

export default router;
