import { executeBuiltinAgent, type AgentExecutionContext } from './aiAgentExecution.js';
import { assertSupplierQuoteEvidence, parseRfqExtractionOutput, parseSupplierQuoteExtractionOutput } from './aiOutputValidation.js';
export { generateCompletion, type AICompletionOptions, type AICompletionResult } from './aiCompletion.js';

export async function classifyRFQEmail(subject: string, body: string, context?: AgentExecutionContext) {
  const result = await executeBuiltinAgent('rfq_extraction', { subject, body }, context);
  return { ...parseRfqExtractionOutput(result.output), ai: { agentId: result.agentId, promptVersion: result.promptVersion, model: result.model } };
}

export async function extractSupplierQuoteEmail(
  subject: string,
  body: string,
  inquiryContext: unknown,
  context?: AgentExecutionContext,
) {
  const result = await executeBuiltinAgent('supplier_quote_extraction', { subject, body, inquiryContext }, context);
  return {
    ...assertSupplierQuoteEvidence(parseSupplierQuoteExtractionOutput(result.output), subject, body),
    ai: { agentId: result.agentId, promptVersion: result.promptVersion, model: result.model },
  };
}

export async function generateQuoteAnalysis(rfqDetails: string, supplierQuotes: string, context?: AgentExecutionContext): Promise<string> {
  return (await executeBuiltinAgent('quote_analysis', { rfqDetails, supplierQuotes }, context)).output;
}

export interface CustomerEmailContext {
  customerName: string;
  partNumber: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  incoterm?: string;
  incotermLocation?: string;
  leadTimeDays?: number;
  validityDays: number;
  lines?: Array<Record<string, unknown>>;
}

export async function generateCustomerEmail(quotation: CustomerEmailContext, context?: AgentExecutionContext): Promise<string> {
  return (await executeBuiltinAgent('customer_email', { quotation: { ...quotation, currency: 'USD' } }, context)).output;
}
