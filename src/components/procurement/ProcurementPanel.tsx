import { useCallback, useEffect, useState } from 'react';
import type { components } from '@/api/generated/openapi';
import { quotationApi, supplierApi, supplierQuoteApi, type SupplierQuoteItem } from '@/api/client';
import { procurementApi, type PurchaseCommitment } from '@/features/orders';
import type { Order, Quotation, Supplier } from '@/types';
import { useCapabilityStore } from '@/store';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EvidenceUpload, EvidenceDownload, useCommandRunner, type EvidenceFile } from './Shared';
import { StockReceiptPanel } from './StockReceiptPanel';
import { DirectShipmentPanel } from './DirectShipmentPanel';

type Schema = components['schemas'];
type DraftLine = { enabled: boolean; quantity: string; promisedDate: string; fulfillmentMode: 'STOCK_RECEIPT' | 'SUPPLIER_DIRECT';
  sourceType: 'SUPPLIER_QUOTE' | 'MANUAL'; quoteId: string; unitCost: string; reason: string; files: EvidenceFile[] };
const blankLine = (): DraftLine => ({ enabled: false, quantity: '1', promisedDate: '', fulfillmentMode: 'STOCK_RECEIPT',
  sourceType: 'SUPPLIER_QUOTE', quoteId: '', unitCost: '', reason: '', files: [] });
const message = (error: unknown) => error instanceof Error ? error.message : 'Request failed';

function PurchaseCard({ purchase, onChanged }: { purchase: PurchaseCommitment; onChanged: () => Promise<unknown> }) {
  const { locale } = useTranslation(); const tx = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  const can = useCapabilityStore(state => state.can);
  const runner = useCommandRunner(); const [uploadBusy, setUploadBusy] = useState(false);
  const [reason, setReason] = useState(''); const [reference, setReference] = useState('');
  const [files, setFiles] = useState<EvidenceFile[]>([]); const [error, setError] = useState('');
  const busy = runner.busy || uploadBusy;
  const canCost = can('purchase_commitment.view_cost');
  const canTransition = canCost && can('purchase_commitment.transition');
  const canApprove = canCost && can('purchase_commitment.approve');
  const labels: Record<string, string> = { DRAFT: tx('草稿', 'Draft'), PENDING_APPROVAL: tx('待审批', 'Pending approval'),
    APPROVED: tx('已批准', 'Approved'), REJECTED: tx('已驳回', 'Rejected'), CONFIRMED: tx('供应商已确认', 'Supplier confirmed'),
    CANCELLED: tx('已取消', 'Cancelled'), CLOSED: tx('已关闭', 'Closed') };
  async function act(action: 'submit' | 'approve' | 'reject' | 'cancel' | 'confirm') {
    setError('');
    const body = { version: purchase.version, reason: reason.trim() };
    const confirmation = { ...body, supplierReferenceNo: reference.trim(), evidenceIds: files.map(file => file.id) };
    try {
      await runner.run(JSON.stringify([purchase.id, action, action === 'confirm' ? confirmation : body]), key => action === 'confirm'
        ? procurementApi.confirm(purchase.id, confirmation, key) : procurementApi[action](purchase.id, body, key));
      setReason(''); setReference(''); setFiles([]); await onChanged();
    } catch (cause) { setError(message(cause)); }
  }
  const hasAction = (canTransition && ['DRAFT', 'REJECTED', 'APPROVED', 'CONFIRMED', 'PENDING_APPROVAL'].includes(purchase.status))
    || (canApprove && purchase.status === 'PENDING_APPROVAL');
  return <article className="min-w-0 space-y-3 break-words rounded border p-3" aria-label={purchase.commitmentNumber}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-medium">{purchase.commitmentNumber} · {purchase.supplierName}</h4><Badge variant="outline">{labels[purchase.status] || purchase.status}</Badge></div>
    {canCost && purchase.totalCost !== undefined && <p className="text-sm">{tx('采购金额', 'Purchase amount')}: USD {purchase.totalCost} · {tx('审批级别', 'Approval level')}: {purchase.approvalLevel || '—'}</p>}
    <ul className="space-y-2 text-sm">{purchase.lines.map(line => <li key={line.id}>
      <span className="font-mono">{line.partNumber}</span> · {line.quantity} {line.uom} · {line.fulfillmentMode === 'SUPPLIER_DIRECT' ? tx('供应商直发', 'Supplier direct') : tx('入库验收', 'Stock receipt')}
      <p className="text-muted-foreground">{tx('已验收入库 / 已直发 / 已取消', 'Stock received / direct dispatched / cancelled')}: {line.receivedQuantity} / {line.directShippedQuantity} / {line.cancelledQuantity}</p>
      {canCost && line.unitCost !== undefined && <p>{tx('单价', 'Unit cost')}: USD {line.unitCost}</p>}
    </li>)}</ul>
    {canCost && purchase.confirmationEvidence?.map(file => <EvidenceDownload key={file.id} id={file.id} />)}
    {hasAction && <div className="space-y-3 border-t pt-3">
      <Label className="block">{tx('操作依据', 'Action reason')}<Input maxLength={4000} value={reason} disabled={busy} onChange={event => setReason(event.target.value)} /></Label>
      {canTransition && purchase.status === 'APPROVED' && <>
        <Label className="block">{tx('供应商确认编号', 'Supplier confirmation reference')}<Input maxLength={200} value={reference} disabled={busy} onChange={event => setReference(event.target.value)} /></Label>
        <EvidenceUpload value={files} onChange={setFiles} disabled={runner.busy} onBusyChange={setUploadBusy} label={tx('供应商确认凭证', 'Supplier confirmation evidence')} />
      </>}
      <div className="flex flex-wrap gap-2">
        {canTransition && purchase.status === 'DRAFT' && <Button type="button" disabled={busy || reason.trim().length < 3} onClick={() => act('submit')}>{tx('提交审批', 'Submit for approval')}</Button>}
        {purchase.status === 'REJECTED' && <p className="text-sm text-muted-foreground">{tx('该版本已驳回；取消后按新的采购依据建单。', 'This version was rejected. Cancel it and create a new commitment with revised terms.')}</p>}
        {canApprove && purchase.status === 'PENDING_APPROVAL' && <>
          <Button type="button" disabled={busy || reason.trim().length < 3} onClick={() => act('approve')}>{tx('批准采购', 'Approve purchase')}</Button>
          <Button type="button" variant="outline" disabled={busy || reason.trim().length < 3} onClick={() => act('reject')}>{tx('驳回采购', 'Reject purchase')}</Button>
          <p className="w-full text-sm text-muted-foreground">{tx('审批人须符合金额级别，且不能是创建或提交人。', 'Approval requires the correct amount tier and an independent approver.')}</p>
        </>}
        {canTransition && purchase.status === 'APPROVED' && <Button type="button" disabled={busy || reason.trim().length < 3 || !reference.trim() || !files.length} onClick={() => act('confirm')}>{tx('登记供应商确认', 'Record supplier confirmation')}</Button>}
        {canTransition && !['CANCELLED', 'CLOSED'].includes(purchase.status) && <Button type="button" variant="outline" disabled={busy || reason.trim().length < 3} onClick={() => act('cancel')}>{tx('取消采购', 'Cancel purchase')}</Button>}
      </div>
    </div>}
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
  </article>;
}

function CreatePurchase({ order, onCreated }: { order: Order; onCreated: () => Promise<unknown> }) {
  const { locale } = useTranslation(); const tx = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  const [open, setOpen] = useState(false); const [supplierSearch, setSupplierSearch] = useState('');
  const [suppliers, setSuppliers] = useState<Supplier[]>([]); const [supplierId, setSupplierId] = useState('');
  const [supplierName, setSupplierName] = useState('');
  const [quotation, setQuotation] = useState<Quotation | null>(null); const [quotes, setQuotes] = useState<SupplierQuoteItem[]>([]);
  const [drafts, setDrafts] = useState<Record<string, DraftLine>>({}); const [paymentTerms, setPaymentTerms] = useState('');
  const [loading, setLoading] = useState(false); const [error, setError] = useState('');
  const [uploading, setUploading] = useState<Record<string, boolean>>({}); const runner = useCommandRunner();
  const busy = runner.busy || Object.values(uploading).some(Boolean);
  useEffect(() => {
    if (!open) return;
    let active = true; setError(''); setLoading(true);
    quotationApi.getById(order.quotationId).then(async quote => {
      const sourceRows = await supplierQuoteApi.getAll({ rfqId: quote.rfqId });
      if (active) { setQuotation(quote); setQuotes(sourceRows); }
    }).catch(cause => { if (active) setError(message(cause)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, order.quotationId]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    const timer = setTimeout(() => supplierApi.getAll({ search: supplierSearch, limit: 50 }).then(result => {
      if (active) setSuppliers(result.data);
    }).catch(cause => { if (active) setError(message(cause)); }), 250);
    return () => { active = false; clearTimeout(timer); };
  }, [open, supplierSearch]);
  const update = (id: string, patch: Partial<DraftLine>) => setDrafts(previous => ({ ...previous, [id]: { ...(previous[id] || blankLine()), ...patch } }));
  async function create() {
    setError('');
    try {
      const lines: Schema['PurchaseCommitmentLineCreateRequest'][] = (order.lines || []).filter(line => drafts[line.id]?.enabled).map(line => {
        const draft = drafts[line.id]; const quantity = Number(draft.quantity); const date = new Date(draft.promisedDate);
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > line.quantity) throw new Error(tx('采购数量须为订单行范围内的正整数', 'Purchase quantity must be a positive integer within the order line'));
        if (Number.isNaN(date.getTime())) throw new Error(tx('请选择承诺交期', 'Choose a promised date'));
        let source: Schema['PurchaseCommitmentSource'];
        if (draft.sourceType === 'MANUAL') {
          if (!/^\d{1,14}(\.\d{1,4})?$/.test(draft.unitCost) || draft.reason.trim().length < 3 || !draft.files.length) throw new Error(tx('手工采购成本需要 USD 金额、依据及凭证', 'Manual purchase cost requires a USD amount, reason and evidence'));
          source = { type: 'MANUAL', currency: 'USD', unitCost: draft.unitCost, reason: draft.reason.trim(), evidenceFileIds: draft.files.map(file => file.id) };
        } else {
          if (!draft.quoteId) throw new Error(tx('请选择该行供应商报价', 'Choose a supplier quote for each selected line'));
          source = { type: 'SUPPLIER_QUOTE', supplierQuoteId: draft.quoteId };
        }
        return { orderLineId: line.id, quantity, promisedDate: date.toISOString(), fulfillmentMode: draft.fulfillmentMode, source };
      });
      if (!supplierId || !lines.length) throw new Error(tx('请选择供应商和采购行', 'Select a supplier and at least one order line'));
      const body = { orderId: order.id, supplierId, lines, ...(paymentTerms.trim() ? { paymentTerms: paymentTerms.trim() } : {}) };
      await runner.run(JSON.stringify(['create-purchase', body]), key => procurementApi.create(body, key));
      setDrafts({}); setPaymentTerms(''); setOpen(false); await onCreated();
    } catch (cause) { setError(message(cause)); }
  }
  return <section className="min-w-0 space-y-3 rounded border p-3 [&_fieldset]:min-w-0 [&_label]:min-w-0 [&_select]:min-w-0">
    <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(!open)}>{open ? tx('收起新采购', 'Close new purchase') : tx('新建采购承诺', 'New purchase commitment')}</Button>
    {open && <div className="space-y-4">
      <Label className="block">{tx('搜索供应商', 'Search suppliers')}<Input value={supplierSearch} disabled={busy} onChange={event => setSupplierSearch(event.target.value)} /></Label>
      <Label className="block">{tx('采购供应商', 'Purchase supplier')}<select className="h-9 w-full rounded border bg-background px-2" value={supplierId} disabled={busy} onChange={event => { setSupplierId(event.target.value); setSupplierName(event.target.selectedOptions[0]?.textContent || ''); setDrafts({}); }}>
        <option value="">{tx('请选择', 'Select')}</option>{supplierId && !suppliers.some(row => row.id === supplierId) && <option value={supplierId}>{supplierName}</option>}{suppliers.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
      </select></Label>
      {loading && <p role="status">{tx('加载销售与供货来源…', 'Loading sale and supplier sources…')}</p>}
      {(order.lines || []).map(line => {
        const draft = drafts[line.id] || blankLine();
        const rfqLineId = quotation?.lines?.find(row => row.id === line.quotationLineId)?.rfqLineId;
        const choices = quotes.filter(row => row.supplier.id === supplierId && row.rfqLineId === rfqLineId && row.partNumber === line.partNumber
          && row.currency === 'USD' && row.currencyStatus === 'VERIFIED' && (!row.validUntil || new Date(row.validUntil).getTime() > Date.now()));
        return <fieldset key={line.id} disabled={busy || !supplierId} className="space-y-3 rounded border p-3">
          <label className="flex items-center gap-2 font-medium"><input type="checkbox" checked={draft.enabled} onChange={event => update(line.id, { enabled: event.target.checked })} />{line.partNumber} · {tx('销售数量', 'Sold quantity')} {line.quantity} {line.uom}</label>
          {draft.enabled && <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Label className="grid gap-2">{tx('采购数量', 'Purchase quantity')}<Input type="number" min={1} max={line.quantity} step={1} value={draft.quantity} onChange={event => update(line.id, { quantity: event.target.value })} /></Label>
              <Label className="grid gap-2">{tx('承诺交期', 'Promised date')}<Input type="datetime-local" value={draft.promisedDate} onChange={event => update(line.id, { promisedDate: event.target.value })} /></Label>
              <Label className="grid gap-2">{tx('履约方式', 'Fulfilment')}<select className="h-9 w-full rounded border bg-background px-2" value={draft.fulfillmentMode} onChange={event => update(line.id, { fulfillmentMode: event.target.value as DraftLine['fulfillmentMode'] })}>
                <option value="STOCK_RECEIPT">{tx('收货入库后销售', 'Receive into stock')}</option><option value="SUPPLIER_DIRECT">{tx('供应商直发客户', 'Supplier direct to customer')}</option></select></Label>
              <Label className="grid gap-2">{tx('采购成本来源', 'Purchase cost source')}<select className="h-9 w-full rounded border bg-background px-2" value={draft.sourceType} onChange={event => update(line.id, { sourceType: event.target.value as DraftLine['sourceType'], files: [], quoteId: '' })}>
                <option value="SUPPLIER_QUOTE">{tx('已有供应商报价', 'Supplier quotation')}</option><option value="MANUAL">{tx('有凭证的手工成本', 'Manual cost with evidence')}</option></select></Label>
            </div>
            {draft.sourceType === 'SUPPLIER_QUOTE' ? <Label className="block">{tx('供应商报价', 'Supplier quotation')}<select className="h-9 w-full rounded border bg-background px-2" value={draft.quoteId} onChange={event => update(line.id, { quoteId: event.target.value })}>
              <option value="">{tx('请选择有效 USD 报价', 'Select a valid USD quote')}</option>{choices.map(row => <option value={row.id} key={row.id}>{row.partNumber} · USD {row.unitPrice} · {tx('数量', 'Qty')} {row.quantity}</option>)}</select>
              {!loading && !choices.length && <span className="text-sm text-muted-foreground">{tx('该供应商暂无匹配报价；可补录供货报价或使用有凭证的手工成本。', 'No matching supplier quote. Add a supplier quote or documented manual cost.')}</span>}
            </Label> : <>
              <Label className="block">{tx('手工采购单价 USD', 'Manual unit cost USD')}<Input inputMode="decimal" value={draft.unitCost} onChange={event => update(line.id, { unitCost: event.target.value })} /></Label>
              <Label className="block">{tx('成本依据', 'Cost basis')}<Input maxLength={4000} value={draft.reason} onChange={event => update(line.id, { reason: event.target.value })} /></Label>
              <EvidenceUpload value={draft.files} onChange={files => update(line.id, { files })} disabled={runner.busy} onBusyChange={value => setUploading(previous => ({ ...previous, [line.id]: value }))} />
            </>}
          </>}
        </fieldset>;
      })}
      <Label className="block">{tx('付款条款（可选）', 'Payment terms (optional)')}<Input value={paymentTerms} maxLength={2000} disabled={busy} onChange={event => setPaymentTerms(event.target.value)} /></Label>
      <Button type="button" disabled={busy || loading || !supplierId} onClick={create}>{tx('保存采购草稿', 'Save purchase draft')}</Button>
    </div>}
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
  </section>;
}

export function ProcurementPanel({ order, onChanged }: { order: Order; onChanged?: () => void | Promise<unknown> }) {
  const { locale } = useTranslation(); const tx = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  const can = useCapabilityStore(state => state.can);
  const [purchases, setPurchases] = useState<PurchaseCommitment[]>([]); const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const allowed = can('purchase_commitment.read');
  const load = useCallback(async () => {
    if (!allowed) return;
    setLoading(true); setError('');
    try { const result = await procurementApi.list(order.id); setPurchases(result.purchases); }
    catch (cause) { setError(message(cause)); throw cause; }
    finally { setLoading(false); }
  }, [allowed, order.id]);
  useEffect(() => { setPurchases([]); void load().catch(() => {}); }, [load]);
  const changed = async () => { await load(); await onChanged?.(); };
  if (!order.lineItemsMode || !allowed) return null;
  return <section className="min-w-0 space-y-3 rounded border p-3 sm:p-4" aria-label={tx('采购与收货', 'Procurement and receiving')}>
    <div className="flex items-center justify-between gap-2"><h3 className="font-semibold">{tx('采购与收货', 'Procurement and receiving')}</h3>
      <Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => void load().catch(() => {})}>{tx('刷新', 'Refresh')}</Button></div>
    {loading && <p role="status">{tx('加载采购承诺…', 'Loading purchase commitments…')}</p>}
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    <Tabs defaultValue="purchases">
      <TabsList className="grid w-full grid-cols-3"><TabsTrigger value="purchases">{tx('采购承诺', 'Purchases')}</TabsTrigger><TabsTrigger value="receipts">{tx('收货质检', 'Stock receipts')}</TabsTrigger><TabsTrigger value="direct">{tx('供应商直发', 'Direct delivery')}</TabsTrigger></TabsList>
      <TabsContent value="purchases" className="space-y-3">
        {can('purchase_commitment.create') && can('purchase_commitment.view_cost') && ['so_created', 'po_created'].includes(order.status) && <CreatePurchase key={order.id} order={order} onCreated={changed} />}
        {!loading && !error && !purchases.length && <p className="text-sm text-muted-foreground">{tx('本订单暂无采购承诺。自有库存销售可直接使用库存履约。', 'No purchase commitments. Owned stock can use inventory fulfilment directly.')}</p>}
        {purchases.map(purchase => <PurchaseCard key={purchase.id} purchase={purchase} onChanged={changed} />)}
      </TabsContent>
      <TabsContent value="receipts"><StockReceiptPanel key={order.id} orderId={order.id} purchases={purchases} onChanged={changed} /></TabsContent>
      <TabsContent value="direct"><DirectShipmentPanel key={order.id} orderId={order.id} purchases={purchases} onChanged={changed} /></TabsContent>
    </Tabs>
  </section>;
}
