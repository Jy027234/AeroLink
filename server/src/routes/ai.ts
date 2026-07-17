import { Router } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { requireCapability } from '../middleware/capability.js';
import {
  classifyRFQEmail,
  generateQuoteAnalysis,
  generateCustomerEmail,
  generateCompletion,
} from '../lib/aiService.js';

const router = Router();

router.use(requireCapability('agent', 'run'));

router.post(
  '/parse-email',
  asyncHandler(async (req, res) => {
    const { subject, body } = req.body;
    if (!subject || !body) {
      throw new AppError('subject 和 body 为必填项', 400);
    }
    const result = await classifyRFQEmail(subject, body);
    res.json({ success: true, data: result });
  })
);

router.post(
  '/analyze-quotes',
  asyncHandler(async (req, res) => {
    const { rfqDetails, supplierQuotes } = req.body;
    if (!rfqDetails || !supplierQuotes) {
      throw new AppError('rfqDetails 和 supplierQuotes 为必填项', 400);
    }
    const result = await generateQuoteAnalysis(rfqDetails, supplierQuotes);
    res.json({ success: true, data: { analysis: result } });
  })
);

router.post(
  '/generate-email',
  asyncHandler(async (req, res) => {
    const {
      customerName,
      partNumber,
      quantity,
      unitPrice,
      totalPrice,
      incoterm,
      incotermLocation,
      leadTimeDays,
      validityDays,
    } = req.body;
    if (!customerName || !partNumber || !unitPrice || !totalPrice) {
      throw new AppError('customerName, partNumber, unitPrice, totalPrice 为必填项', 400);
    }
    const result = await generateCustomerEmail({
      customerName,
      partNumber,
      quantity: quantity || 1,
      unitPrice,
      totalPrice,
      incoterm,
      incotermLocation,
      leadTimeDays,
      validityDays: validityDays || 30,
    });
    res.json({ success: true, data: { email: result } });
  })
);

router.post(
  '/chat',
  asyncHandler(async (req, res) => {
    const { message, systemPrompt, temperature, maxTokens } = req.body;
    if (!message) {
      throw new AppError('message 为必填项', 400);
    }
    const result = await generateCompletion(
      [
        { role: 'system', content: systemPrompt || '你是AeroLink航材交易平台的AI助手。' },
        { role: 'user', content: message },
      ],
      { temperature: temperature ?? 0.7, maxTokens: maxTokens ?? 2048 }
    );
    res.json({ success: true, data: result });
  })
);

export default router;
