import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronUp, CreditCard, Loader2, Plus, RefreshCw, Wallet } from 'lucide-react';
import { settlementApi, procurementApi, type PurchaseCommitment, type SettlementAccount, type SettlementRecord, type SettlementRecordRequest } from '@/features/orders';
import type { Order } from '@/types';
import { useCapabilityStore } from '@/store';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { EvidenceDownload, EvidenceUpload, localDateTime, useCommandRunner, type EvidenceFile } from './Shared';

type AccountSide = 'RECEIVABLE' | 'PAYABLE';
type RecordKind = 'PAYMENT' | 'CREDIT' | 'REFUND' | 'REVERSAL' | 'TERMS';

type AccountForm = {
  side: AccountSide;
  purchaseCommitmentId: string;
  dueDate: string;
  occurredAt: string;
  externalSystem: string;
  voucherNumber: string;
  voucherLine: string;
  reason: string;
  evidence: EvidenceFile[];
};

type RecordForm = {
  kind: RecordKind;
  amount: string;
  reversalOfId: string;
  dueDate: string;
  occurredAt: string;
  externalSystem: string;
  voucherNumber: string;
  voucherLine: string;
  reason: string;
  evidence: EvidenceFile[];
};

const moneyPattern = /^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/;
const moneyIsPositive = (value: string) => {
  const normalized = value.trim();
  return moneyPattern.test(normalized) && /[1-9]/.test(normalized.replace('.', ''));
};

function nowLocal() {
  return localDateTime(new Date().toISOString());
}

function isoFromLocal(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function displayDate(value: string | null | undefined, locale: string) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US');
}

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

function freshAccountForm(side: AccountSide = 'RECEIVABLE'): AccountForm {
  return { side, purchaseCommitmentId: '', dueDate: '', occurredAt: nowLocal(), externalSystem: '', voucherNumber: '', voucherLine: '', reason: '', evidence: [] };
}

function freshRecordForm(): RecordForm {
  return { kind: 'PAYMENT', amount: '', reversalOfId: '', dueDate: '', occurredAt: nowLocal(), externalSystem: '', voucherNumber: '', voucherLine: '', reason: '', evidence: [] };
}

function sourceSummary(account: SettlementAccount) {
  const source = account.sourceSnapshot;
  return `${source.sourceNumber} · ${source.counterpartyName}`;
}

function sideLabel(side: AccountSide, tx: (zh: string, en: string) => string) {
  return side === 'RECEIVABLE' ? tx('应收', 'Receivable') : tx('应付', 'Payable');
}

function statusLabel(kind: SettlementRecord['kind'], side: AccountSide, tx: (zh: string, en: string) => string) {
  if (kind === 'OPEN') return tx('初始登记', 'Initial entry');
  if (kind === 'PAYMENT') return side === 'RECEIVABLE' ? tx('收款', 'Payment received') : tx('付款', 'Payment made');
  if (kind === 'CREDIT') return tx('减免', 'Credit');
  if (kind === 'REFUND') return side === 'RECEIVABLE' ? tx('退还客户款', 'Refund to customer') : tx('收回供应商退款', 'Refund from supplier');
  if (kind === 'REVERSAL') return tx('冲销', 'Reversal');
  return tx('条款调整', 'Terms adjustment');
}

function accountAmountLabel(key: string, side: AccountSide, tx: (zh: string, en: string) => string) {
  if (side === 'RECEIVABLE' && key === 'effectivePaid') return tx('有效已收', 'Effective received');
  if (side === 'RECEIVABLE' && key === 'unpaid') return tx('未收', 'Unreceived');
  const labels: Record<string, [string, string]> = {
    initialAmount: ['初始金额', 'Initial amount'],
    creditReduction: ['信用减免', 'Credit reduction'],
    effectivePaid: ['有效已付', 'Effective paid'],
    unpaid: ['未付', 'Unpaid'],
    pendingRefund: ['待退款', 'Pending refund'],
  };
  const pair = labels[key] || [key, key];
  return tx(pair[0], pair[1]);
}

function validCommonForm(form: { dueDate?: string; occurredAt: string; externalSystem: string; voucherNumber: string; voucherLine: string; reason: string; evidence: EvidenceFile[] }, requireDueDate: boolean, tx: (zh: string, en: string) => string) {
  if (requireDueDate && !isoFromLocal(form.dueDate || '')) return tx('请选择有效截止日期', 'Choose a valid due date');
  if (!isoFromLocal(form.occurredAt)) return tx('请选择有效发生时间', 'Choose a valid occurred-at time');
  if (new Date(isoFromLocal(form.occurredAt)).getTime() > Date.now()) return tx('发生时间不能晚于当前时间', 'Occurred-at cannot be in the future');
  if (!form.externalSystem.trim() || form.externalSystem.trim().length > 100) return tx('请填写外部系统', 'Enter the external system');
  if (!form.voucherNumber.trim() || form.voucherNumber.trim().length > 200) return tx('请填写凭证号', 'Enter the voucher number');
  if (!form.voucherLine.trim() || form.voucherLine.trim().length > 200) return tx('请填写凭证行号', 'Enter the voucher line');
  if (form.reason.trim().length < 3) return tx('原因至少需要 3 个字符', 'Reason must contain at least 3 characters');
  if (!form.evidence.length) return tx('请上传至少一份结算凭证', 'Upload at least one settlement voucher');
  return '';
}

function HistoryRecord({ record, side, locale, tx, reversed, original }: { record: SettlementRecord; side: AccountSide; locale: string; tx: (zh: string, en: string) => string; reversed: boolean; original?: SettlementRecord }) {
  return <div className="min-w-0 space-y-2 rounded border p-2 text-sm" data-testid={`settlement-record-${record.id}`}>
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
      <div className="min-w-0 break-words">
        <p className="font-medium">{statusLabel(record.kind, side, tx)}{record.voucherNumber ? ` · ${record.voucherNumber}` : ''}</p>
        <p className="text-xs text-muted-foreground">{displayDate(record.occurredAt, locale)} · {record.externalSystem} · {record.voucherLine}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {record.amount !== null && <span className="font-mono">USD {record.amount}</span>}
        {reversed && <Badge variant="secondary">{tx('已冲销', 'Reversed')}</Badge>}
        {record.kind === 'REVERSAL' && <Badge variant="outline">{tx('冲销记录', 'Reversal')}</Badge>}
      </div>
    </div>
    {record.reason && <p className="break-words text-muted-foreground">{record.reason}</p>}
    {record.kind === 'TERMS' && record.dueDate && <p className="text-xs text-muted-foreground">{tx('新截止日期', 'New due date')}: {displayDate(record.dueDate, locale)}</p>}
    {original && <p className="text-xs text-muted-foreground">{tx('冲销原凭证', 'Reversed voucher')}: {original.voucherNumber} · {statusLabel(original.kind, side, tx)} · USD {original.amount}</p>}
    {record.evidence.length > 0 && <div className="flex flex-wrap gap-2">{record.evidence.map(file => <EvidenceDownload key={`${file.id}:${file.version}`} id={file.id} label={tx('下载凭证', 'Download voucher')} />)}</div>}
  </div>;
}

function SettlementRecordForm({
  account,
  tx,
  canCreate,
  canUpdate,
  canReconcile,
  onChanged,
}: {
  account: SettlementAccount;
  tx: (zh: string, en: string) => string;
  canCreate: boolean;
  canUpdate: boolean;
  canReconcile: boolean;
  onChanged: () => Promise<void>;
}) {
  const runner = useCommandRunner();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<RecordForm>(freshRecordForm);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [error, setError] = useState('');
  const busy = runner.busy || uploadBusy;
  const reversedIds = useMemo(() => new Set(account.records.filter(record => record.reversalOfId).map(record => record.reversalOfId as string)), [account.records]);
  const targets = useMemo(() => account.records.filter(record => ['PAYMENT', 'CREDIT', 'REFUND'].includes(record.kind) && record.amount !== null && !reversedIds.has(record.id)), [account.records, reversedIds]);
  const canSelectedKind = form.kind === 'REVERSAL' ? canReconcile : form.kind === 'TERMS' ? canUpdate : canCreate;
  const update = (patch: Partial<RecordForm>) => setForm(previous => ({ ...previous, ...patch }));

  const submit = async () => {
    setError('');
    if (!canSelectedKind) { setError(tx('当前权限不能登记此类记录', 'Your permissions do not allow this record type')); return; }
    const requiresDue = form.kind === 'TERMS';
    const commonError = validCommonForm(form, requiresDue, tx);
    if (commonError) { setError(commonError); return; }
    if (form.kind === 'PAYMENT' || form.kind === 'CREDIT' || form.kind === 'REFUND') {
      if (!moneyIsPositive(form.amount)) { setError(tx('金额须大于零，最多四位小数', 'Amount must be greater than zero with up to four decimals')); return; }
    }
    if (form.kind === 'REVERSAL' && !targets.some(record => record.id === form.reversalOfId)) {
      setError(tx('请选择仍可冲销的原记录', 'Choose an eligible original record to reverse')); return;
    }
    const common = {
      version: account.version,
      occurredAt: isoFromLocal(form.occurredAt),
      externalSystem: form.externalSystem.trim(),
      voucherNumber: form.voucherNumber.trim(),
      voucherLine: form.voucherLine.trim(),
      reason: form.reason.trim(),
      evidenceIds: form.evidence.map(file => file.id),
    };
    let body: SettlementRecordRequest;
    if (form.kind === 'REVERSAL') body = { ...common, kind: 'REVERSAL', reversalOfId: form.reversalOfId };
    else if (form.kind === 'TERMS') body = { ...common, kind: 'TERMS', dueDate: isoFromLocal(form.dueDate) };
    else body = { ...common, kind: form.kind, amount: form.amount.trim() };
    const signature = `settlement-record:${account.id}:${JSON.stringify(body)}`;
    try {
      await runner.run(signature, key => settlementApi.appendRecord(account.id, body, key));
      setForm(freshRecordForm()); setOpen(false); setError('');
      await onChanged();
    } catch (cause) {
      setError(errorMessage(cause, tx('保存结算记录失败', 'Failed to save settlement record')));
    }
  };

  const hasRecordPermission = canCreate || canUpdate || canReconcile;
  return <>
    {hasRecordPermission && <Button type="button" variant="outline" size="sm" onClick={() => setOpen(previous => !previous)} disabled={busy}>
      <Plus className="mr-1 h-4 w-4" />{open ? tx('收起登记', 'Close entry') : tx('登记结算记录', 'Add settlement record')}
    </Button>}
    {open && <div className="space-y-3 rounded border bg-muted/20 p-3" data-testid={`settlement-record-form-${account.id}`}>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <Label className="grid min-w-0 gap-2">{tx('记录类型', 'Record type')}
          <select aria-label={tx('记录类型', 'Record type')} className="h-9 min-w-0 w-full rounded border bg-background px-2" value={form.kind} onChange={event => update({ kind: event.target.value as RecordKind, amount: '', reversalOfId: '', dueDate: '' })} disabled={busy}>
            {canCreate && <><option value="PAYMENT">{statusLabel('PAYMENT', account.side, tx)}</option><option value="CREDIT">{statusLabel('CREDIT', account.side, tx)}</option><option value="REFUND">{statusLabel('REFUND', account.side, tx)}</option></>}
            {canReconcile && <option value="REVERSAL">{statusLabel('REVERSAL', account.side, tx)}</option>}
            {canUpdate && <option value="TERMS">{statusLabel('TERMS', account.side, tx)}</option>}
          </select>
        </Label>
        {(form.kind === 'PAYMENT' || form.kind === 'CREDIT' || form.kind === 'REFUND') && <Label className="grid min-w-0 gap-2">{tx('金额（USD）', 'Amount (USD)')}
          <Input aria-label={tx('金额（USD）', 'Amount (USD)')} inputMode="decimal" value={form.amount} onChange={event => update({ amount: event.target.value })} disabled={busy} placeholder="0.0001" />
        </Label>}
        {form.kind === 'REVERSAL' && <Label className="grid min-w-0 gap-2 sm:col-span-2">{tx('冲销原记录', 'Original record to reverse')}
          <select aria-label={tx('冲销原记录', 'Original record to reverse')} className="h-9 min-w-0 w-full rounded border bg-background px-2" value={form.reversalOfId} onChange={event => update({ reversalOfId: event.target.value })} disabled={busy}>
            <option value="">{tx('请选择未冲销记录', 'Select an unreversed record')}</option>
            {targets.map(record => <option key={record.id} value={record.id}>{statusLabel(record.kind, account.side, tx)} · {record.voucherNumber} · USD {record.amount}</option>)}
          </select>
          {form.reversalOfId && <p className="rounded border bg-background p-2 text-xs text-muted-foreground">{(() => { const target = targets.find(record => record.id === form.reversalOfId); return target ? tx(`将全额冲销 ${target.voucherNumber}，金额 USD ${target.amount}。`, `This will reverse ${target.voucherNumber} in full for USD ${target.amount}.`) : ''; })()}</p>}
        </Label>}
        {form.kind === 'TERMS' && <Label className="grid min-w-0 gap-2">{tx('新截止日期', 'New due date')}<Input aria-label={tx('新截止日期', 'New due date')} type="datetime-local" value={form.dueDate} onChange={event => update({ dueDate: event.target.value })} disabled={busy} /></Label>}
        <Label className="grid min-w-0 gap-2">{tx('发生时间', 'Occurred at')}<Input aria-label={tx('发生时间', 'Occurred at')} type="datetime-local" value={form.occurredAt} onChange={event => update({ occurredAt: event.target.value })} disabled={busy} /></Label>
        <Label className="grid min-w-0 gap-2">{tx('外部系统', 'External system')}<Input value={form.externalSystem} maxLength={100} onChange={event => update({ externalSystem: event.target.value })} disabled={busy} /></Label>
        <Label className="grid min-w-0 gap-2">{tx('凭证号', 'Voucher number')}<Input value={form.voucherNumber} maxLength={200} onChange={event => update({ voucherNumber: event.target.value })} disabled={busy} /></Label>
        <Label className="grid min-w-0 gap-2">{tx('凭证行号', 'Voucher line')}<Input value={form.voucherLine} maxLength={200} onChange={event => update({ voucherLine: event.target.value })} disabled={busy} /></Label>
      </div>
      <Label className="grid min-w-0 gap-2">{tx('原因', 'Reason')}<Textarea value={form.reason} minLength={3} maxLength={4000} onChange={event => update({ reason: event.target.value })} disabled={busy} /></Label>
      <EvidenceUpload value={form.evidence} onChange={value => update({ evidence: value })} onBusyChange={setUploadBusy} disabled={runner.busy} label={tx('结算凭证（至少一份）', 'Settlement voucher (at least one)')} />
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <Button type="button" onClick={() => void submit()} disabled={busy || !canSelectedKind}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}{tx('保存结算记录', 'Save settlement record')}</Button>
    </div>}
  </>;
}

function SettlementAccountCard({ account, locale, tx, canCreate, canUpdate, canReconcile, onChanged }: {
  account: SettlementAccount;
  locale: string;
  tx: (zh: string, en: string) => string;
  canCreate: boolean;
  canUpdate: boolean;
  canReconcile: boolean;
  onChanged: () => Promise<void>;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const reversedIds = useMemo(() => new Set(account.records.filter(record => record.reversalOfId).map(record => record.reversalOfId as string)), [account.records]);
  const amountKeys = ['initialAmount', 'creditReduction', 'effectivePaid', 'unpaid', 'pendingRefund'] as const;
  const amounts = { ...account.amounts, initialAmount: account.initialAmount };
  return <article className="min-w-0 space-y-3 break-words rounded border p-3" data-testid={`settlement-account-${account.id}`} aria-label={`${sideLabel(account.side, tx)} · ${sourceSummary(account)}`}>
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
      <div className="min-w-0"><h4 className="flex min-w-0 flex-wrap items-center gap-2 font-medium"><span className="break-words">{sideLabel(account.side, tx)} · {sourceSummary(account)}</span><Badge variant="outline">USD</Badge></h4><p className="text-xs text-muted-foreground">{tx('到期', 'Due')}: {displayDate(account.dueDate, locale)} · {tx('版本', 'Version')} {account.version}</p></div>
      <SettlementRecordForm account={account} tx={tx} canCreate={canCreate} canUpdate={canUpdate} canReconcile={canReconcile} onChanged={onChanged} />
    </div>
    <dl className="grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-5">
      {amountKeys.map(key => <div key={key} className="min-w-0 rounded bg-muted/30 p-2"><dt className="text-xs text-muted-foreground">{accountAmountLabel(key, account.side, tx)}</dt><dd className="break-all font-mono text-sm">USD {amounts[key]}</dd></div>)}
    </dl>
    <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2">
      <span className="text-sm text-muted-foreground">{tx(`${account.records.length} 条历史记录`, `${account.records.length} historical records`)}</span>
      <Button type="button" variant="ghost" size="sm" onClick={() => setHistoryOpen(previous => !previous)} aria-expanded={historyOpen}>{historyOpen ? <ChevronUp className="mr-1 h-4 w-4" /> : <ChevronDown className="mr-1 h-4 w-4" />}{historyOpen ? tx('收起历史', 'Hide history') : tx('查看历史', 'View history')}</Button>
    </div>
    {historyOpen && <div className="space-y-2" aria-label={tx('结算历史', 'Settlement history')}>{account.records.map(record => <HistoryRecord key={record.id} record={record} side={account.side} locale={locale} tx={tx} reversed={reversedIds.has(record.id)} original={account.records.find(row => row.id === record.reversalOfId)} />)}</div>}
  </article>;
}

export interface SettlementPanelProps {
  order: Order;
  onChanged?: () => void | Promise<unknown>;
}

export function SettlementPanel({ order, onChanged }: SettlementPanelProps) {
  const { locale } = useTranslation();
  const tx = useCallback((zh: string, en: string) => locale === 'zh-CN' ? zh : en, [locale]);
  const canRead = useCapabilityStore(state => state.can('settlement.read'));
  const canCost = useCapabilityStore(state => state.can('settlement.view_cost'));
  const canCreate = useCapabilityStore(state => state.can('settlement.create'));
  const canUpdate = useCapabilityStore(state => state.can('settlement.update'));
  const canReconcile = useCapabilityStore(state => state.can('settlement.reconcile'));
  const modern = order.lineItemsMode === true;
  const [accounts, setAccounts] = useState<SettlementAccount[]>([]);
  const [purchases, setPurchases] = useState<PurchaseCommitment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [accountFormOpen, setAccountFormOpen] = useState(false);
  const [accountForm, setAccountForm] = useState<AccountForm>(() => freshAccountForm());
  const [accountUploadBusy, setAccountUploadBusy] = useState(false);
  const [accountError, setAccountError] = useState('');
  const runner = useCommandRunner();
  const generation = useRef(0);

  const load = useCallback(async () => {
    const request = ++generation.current;
    if (!canRead || !modern) {
      setAccounts([]); setPurchases([]); setLoading(false); setError(''); return;
    }
    setLoading(true); setError(''); setAccounts([]); setPurchases([]);
    try {
      const result = await settlementApi.list(order.id);
      if (request !== generation.current) return;
      const visible = result?.accounts ?? [];
      setAccounts(canCost ? visible : visible.filter(account => account.side === 'RECEIVABLE'));
      if (canCost && canCreate) {
        const purchaseResult = await procurementApi.list(order.id);
        if (request !== generation.current) return;
        setPurchases(purchaseResult?.purchases ?? []);
      }
    } catch (cause) {
      if (request !== generation.current) return;
      setAccounts([]); setPurchases([]); setError(errorMessage(cause, tx('结算记录加载失败', 'Failed to load settlement records')));
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [canCost, canCreate, canRead, modern, order.id, tx]);

  useEffect(() => {
    generation.current += 1;
    setAccounts([]); setPurchases([]); setError(''); setAccountFormOpen(false); setAccountForm(freshAccountForm()); setAccountError('');
    void load();
    return () => { generation.current += 1; };
  }, [canCost, canRead, load, modern, order.id]);

  const confirmedPurchases = useMemo(() => purchases.filter(purchase => (purchase.status === 'CONFIRMED' || purchase.status === 'CLOSED') && purchase.currency === 'USD'), [purchases]);

  const refreshAfterChange = useCallback(async () => {
    await load();
    try { await onChanged?.(); }
    catch { setError(tx('结算已保存，订单详情刷新失败，请重试加载订单。', 'Settlement saved, but order details could not refresh. Reload the order.')); }
  }, [load, onChanged, tx]);

  const createAccount = async () => {
    setAccountError('');
    if (accountForm.side === 'PAYABLE' && !canCost) { setAccountError(tx('当前账号不能登记应付结算', 'This account cannot create payable settlement')); return; }
    const commonError = validCommonForm(accountForm, true, tx);
    if (commonError) { setAccountError(commonError); return; }
    if (accountForm.side === 'PAYABLE' && !confirmedPurchases.some(purchase => purchase.id === accountForm.purchaseCommitmentId)) {
      setAccountError(tx('请选择当前订单已确认或已关闭的采购承诺', 'Choose a confirmed or closed purchase commitment for this order')); return;
    }
    const common = {
      orderId: order.id,
      dueDate: isoFromLocal(accountForm.dueDate),
      occurredAt: isoFromLocal(accountForm.occurredAt),
      externalSystem: accountForm.externalSystem.trim(),
      voucherNumber: accountForm.voucherNumber.trim(),
      voucherLine: accountForm.voucherLine.trim(),
      reason: accountForm.reason.trim(),
      evidenceIds: accountForm.evidence.map(file => file.id),
    };
    const body = accountForm.side === 'PAYABLE'
      ? { ...common, side: 'PAYABLE' as const, purchaseCommitmentId: accountForm.purchaseCommitmentId }
      : { ...common, side: 'RECEIVABLE' as const };
    const signature = `settlement-account:${JSON.stringify(body)}`;
    try {
      await runner.run(signature, key => settlementApi.create(body, key));
      setAccountForm(freshAccountForm(accountForm.side)); setAccountFormOpen(false); setAccountError('');
      await refreshAfterChange();
    } catch (cause) {
      setAccountError(errorMessage(cause, tx('保存结算账户失败', 'Failed to save settlement account')));
    }
  };

  if (!modern || !canRead) return null;
  const visibleAccounts = accounts.filter(account => account.orderId === order.id && (canCost || account.side === 'RECEIVABLE'));
  const canOpenAccount = canCreate && ['so_created', 'po_created', 'shipped', 'delivered'].includes(order.status.toLowerCase());
  const busy = runner.busy || accountUploadBusy;
  return <section className="min-w-0 space-y-4 rounded-lg border p-3 sm:p-4" aria-label={tx('结算与凭证', 'Settlement and vouchers')}>
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
      <div className="min-w-0"><h3 className="flex items-center gap-2 font-semibold"><Wallet className="h-4 w-4" />{tx('结算与凭证', 'Settlement and vouchers')}</h3><p className="text-sm text-muted-foreground">{tx('金额由订单与采购事实派生；本页只登记外部凭证，不直接执行付款。', 'Amounts are derived from order and purchase facts; this page records external vouchers only.')}</p></div>
      <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={loading || busy}><RefreshCw className={cn('mr-1 h-4 w-4', loading && 'animate-spin')} />{tx('刷新', 'Refresh')}</Button>
    </div>
    {loading && <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />{tx('正在加载结算记录…', 'Loading settlement records…')}</p>}
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    {canOpenAccount && <div className="space-y-3 border-t pt-3">
      <Button type="button" onClick={() => setAccountFormOpen(previous => !previous)} disabled={busy || loading || Boolean(error)}><Plus className="mr-1 h-4 w-4" />{accountFormOpen ? tx('收起新建', 'Close new account') : tx('新建结算记录', 'New settlement account')}</Button>
      {accountFormOpen && <div className="space-y-3 rounded border bg-muted/20 p-3" data-testid="settlement-account-form">
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <Label className="grid min-w-0 gap-2">{tx('结算方向', 'Settlement side')}<select aria-label={tx('结算方向', 'Settlement side')} className="h-9 min-w-0 w-full rounded border bg-background px-2" value={accountForm.side} onChange={event => setAccountForm(previous => ({ ...previous, side: event.target.value as AccountSide, purchaseCommitmentId: '' }))} disabled={busy}>
            <option value="RECEIVABLE">{sideLabel('RECEIVABLE', tx)}</option>{canCost && <option value="PAYABLE">{sideLabel('PAYABLE', tx)}</option>}
          </select></Label>
          {accountForm.side === 'PAYABLE' && <Label className="grid min-w-0 gap-2">{tx('采购承诺来源', 'Purchase commitment source')}<select aria-label={tx('采购承诺来源', 'Purchase commitment source')} className="h-9 min-w-0 w-full rounded border bg-background px-2" value={accountForm.purchaseCommitmentId} onChange={event => setAccountForm(previous => ({ ...previous, purchaseCommitmentId: event.target.value }))} disabled={busy || !confirmedPurchases.length}>
            <option value="">{tx('请选择已确认采购承诺', 'Select a confirmed purchase commitment')}</option>{confirmedPurchases.map(purchase => <option key={purchase.id} value={purchase.id}>{purchase.commitmentNumber} · {purchase.supplierName}</option>)}
          </select>{!confirmedPurchases.length && <span className="text-xs text-muted-foreground">{tx('当前订单没有可用的已确认或已关闭采购承诺。', 'No confirmed or closed purchase commitment is available for this order.')}</span>}</Label>}
          <Label className="grid min-w-0 gap-2">{tx('到期时间', 'Due date')}<Input aria-label={tx('到期时间', 'Due date')} type="datetime-local" value={accountForm.dueDate} onChange={event => setAccountForm(previous => ({ ...previous, dueDate: event.target.value }))} disabled={busy} /></Label>
          <Label className="grid min-w-0 gap-2">{tx('发生时间', 'Occurred at')}<Input aria-label={tx('发生时间', 'Occurred at')} type="datetime-local" value={accountForm.occurredAt} onChange={event => setAccountForm(previous => ({ ...previous, occurredAt: event.target.value }))} disabled={busy} /></Label>
          <Label className="grid min-w-0 gap-2">{tx('外部系统', 'External system')}<Input value={accountForm.externalSystem} maxLength={100} onChange={event => setAccountForm(previous => ({ ...previous, externalSystem: event.target.value }))} disabled={busy} /></Label>
          <Label className="grid min-w-0 gap-2">{tx('凭证号', 'Voucher number')}<Input value={accountForm.voucherNumber} maxLength={200} onChange={event => setAccountForm(previous => ({ ...previous, voucherNumber: event.target.value }))} disabled={busy} /></Label>
          <Label className="grid min-w-0 gap-2">{tx('凭证行号', 'Voucher line')}<Input value={accountForm.voucherLine} maxLength={200} onChange={event => setAccountForm(previous => ({ ...previous, voucherLine: event.target.value }))} disabled={busy} /></Label>
        </div>
        <Label className="grid min-w-0 gap-2">{tx('原因', 'Reason')}<Textarea value={accountForm.reason} minLength={3} maxLength={4000} onChange={event => setAccountForm(previous => ({ ...previous, reason: event.target.value }))} disabled={busy} /></Label>
        <EvidenceUpload value={accountForm.evidence} onChange={value => setAccountForm(previous => ({ ...previous, evidence: value }))} onBusyChange={setAccountUploadBusy} disabled={runner.busy} label={tx('结算凭证（至少一份）', 'Settlement voucher (at least one)')} />
        {accountError && <p role="alert" className="text-sm text-red-600">{accountError}</p>}
        <Button type="button" onClick={() => void createAccount()} disabled={busy || (accountForm.side === 'PAYABLE' && !confirmedPurchases.length)}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CreditCard className="mr-2 h-4 w-4" />}{tx('保存结算记录', 'Save settlement account')}</Button>
      </div>}
    </div>}
    {!loading && !error && visibleAccounts.length === 0 && <p className="text-sm text-muted-foreground">{tx('当前订单还没有结算记录。', 'No settlement records for this order yet.')}</p>}
    {visibleAccounts.length > 0 && <div className="min-w-0 space-y-3" aria-label={tx('结算账户列表', 'Settlement account list')}>
      {visibleAccounts.map(account => <SettlementAccountCard key={account.id} account={account} locale={locale} tx={tx} canCreate={canCreate} canUpdate={canUpdate} canReconcile={canReconcile} onChanged={refreshAfterChange} />)}
    </div>}
  </section>;
}
