import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { aiApi, type AICallMetadata, type AIRfqExtraction } from '@/api/client';
import { useCapabilityStore } from '@/store';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';

// Each business record mounts a separate panel (keyed by its ID). Ignore a late
// response after the user switches records or closes the enclosing dialog.
function Suggestion<T extends { ai: AICallMetadata }>({ label, request, children, disabled = false }: {
  label: string; request: () => Promise<T>; children: (result: T) => ReactNode; disabled?: boolean;
}) {
  const [result, setResult] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  useEffect(() => () => { generation.current++; }, []);
  const run = async () => {
    const current = ++generation.current;
    setLoading(true); setError(''); setResult(null);
    try {
      const output = await request();
      if (generation.current === current) setResult(output);
    } catch (failure) {
      if (generation.current === current) setError(failure instanceof Error ? failure.message : tx('AI 调用失败', 'AI request failed'));
    } finally {
      if (generation.current === current) setLoading(false);
    }
  };
  return <div className="space-y-3">
    <Button type="button" variant="outline" size="sm" disabled={disabled || loading} onClick={() => void run()}>
      {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}{label}
    </Button>
    <p className="text-xs text-muted-foreground">{tx('使用已发布提示词生成建议，请核对后采用。模型由管理员在系统设置中配置。', 'Suggestions use the published prompt. Review before applying. Models are configured in Settings.')}</p>
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    {result && <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
      <p className="text-xs text-muted-foreground">{result.ai.model} · {tx('提示词版本', 'Prompt version')} {result.ai.promptVersion}</p>
      {children(result)}
    </div>}
  </div>;
}

export function RfqExtractionAssistant({ emailId, onApply }: {
  emailId: string; onApply: (result: AIRfqExtraction, lineIndex: number) => void;
}) {
  const can = useCapabilityStore((state) => state.can);
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  if (!can('agent.run') || !can('email.read')) return null;
  return <Suggestion key={emailId} label={tx('AI 提取需求建议', 'Extract with AI')} request={() => aiApi.parseEmailById(emailId)}>
    {(result) => <>
      <p className="text-sm">{tx('邮件类型', 'Type')}：{result.type} · {tx('紧急程度', 'Urgency')}：{result.urgency}</p>
      {!result.partNumbers.length && <p className="text-sm">{tx('未识别出明确件号，请人工确认邮件。', 'No confirmed part number found. Please review the email.')}</p>}
      {result.partNumbers.length > 1 && <p className="text-sm">{tx('识别到多项需求。当前卡片一次创建一项，选择后请在需求单详情中补齐其他明细。', 'Multiple items found. This card creates one item; add the remaining lines in the RFQ details.')}</p>}
      {result.partNumbers.map((part, index) => <div key={`${part}-${index}`} className="flex items-center justify-between gap-2 text-sm">
        <span>{part} × {result.quantities[index]}</span>
        <Button type="button" size="sm" variant="secondary" onClick={() => onApply(result, index)}>{tx('填入待确认卡片', 'Apply to draft')}</Button>
      </div>)}
    </>}
  </Suggestion>;
}

export function QuotationEmailAssistant({ quotationId, onApply, disabled }: {
  quotationId: string; onApply: (message: string) => void; disabled?: boolean;
}) {
  const can = useCapabilityStore((state) => state.can);
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  if (!can('agent.run') || !can('quotation.read')) return null;
  return <Suggestion key={quotationId} label={tx('生成 AI 邮件草稿', 'Generate AI email draft')} request={() => aiApi.generateQuotationEmail(quotationId)} disabled={disabled}>
    {(result) => <>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-sans text-sm">{result.email}</pre>
      <Button type="button" size="sm" disabled={disabled} onClick={() => onApply(result.email)}>{tx('采用草稿并替换邮件内容', 'Replace message with this draft')}</Button>
    </>}
  </Suggestion>;
}

export function QuoteAnalysisAssistant({ rfqId }: { rfqId: string | null }) {
  const can = useCapabilityStore((state) => state.can);
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  if (!can('agent.run') || !can('supplier_quote.read') || !can('rfq.read')) return null;
  return <Dialog key={rfqId}>
    <DialogTrigger asChild><Button variant="outline" disabled={!rfqId}><Sparkles className="mr-2 h-4 w-4" />{tx('AI 报价分析', 'AI quote analysis')}</Button></DialogTrigger>
    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader><DialogTitle>{tx('供应商报价分析建议', 'Supplier quote analysis')}</DialogTitle><DialogDescription>{tx('分析当前 RFQ 的报价、交期和风险。定价与供应商选择仍由用户确认。', 'Analyze quotes, lead times and risks for this RFQ. You decide pricing and supplier selection.')}</DialogDescription></DialogHeader>
      {rfqId && <Suggestion label={tx('开始分析', 'Analyze')} request={() => aiApi.analyzeRfqQuotes(rfqId)}>
        {(result) => <pre className="whitespace-pre-wrap font-sans text-sm">{result.analysis}</pre>}
      </Suggestion>}
    </DialogContent>
  </Dialog>;
}

export function BusinessChatAssistant() {
  const can = useCapabilityStore((state) => state.can);
  const [message, setMessage] = useState('');
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  if (!can('agent.run')) return null;
  return <Dialog>
    <DialogTrigger asChild><Button variant="outline"><Sparkles className="mr-2 h-4 w-4" />{tx('AI 业务问答', 'AI business assistant')}</Button></DialogTrigger>
    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader><DialogTitle>{tx('AI 业务问答', 'AI business assistant')}</DialogTitle><DialogDescription>{tx('根据您提供的内容回答业务问题。不会读取未提供的业务记录，也不会执行审批、下单或发送邮件。', 'Answers use the information you provide. The assistant cannot read other records or approve, order or send emails.')}</DialogDescription></DialogHeader>
      <Textarea aria-label={tx('业务问题', 'Business question')} value={message} onChange={(event) => setMessage(event.target.value)} maxLength={40000} placeholder={tx('请输入问题和必要背景', 'Enter your question and relevant context')} />
      <Suggestion label={tx('获取建议', 'Get advice')} request={() => aiApi.chat(message)} disabled={!message.trim()}>
        {(result) => <pre className="whitespace-pre-wrap font-sans text-sm">{result.content}</pre>}
      </Suggestion>
    </DialogContent>
  </Dialog>;
}
