import { useQuery } from '@tanstack/react-query';
import { inventoryApi, supplierQuoteApi } from '@/api/client';
import { useCapabilityStore } from '@/store';
import { useTranslation } from '@/i18n';
import { queryKeys } from '@/lib/queryClient';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export type CostSourceValue = {
  costSourceType: 'SUPPLIER_QUOTE' | 'INVENTORY_DETAIL' | 'MANUAL';
  costSourceId: string;
  costSourceReason: string;
};

type Props = {
  value: CostSourceValue;
  onChange: (value: CostSourceValue, unitCost?: number) => void;
  rfqId: string;
  /** Modern line-first quotations must match the exact RFQ demand line. */
  rfqLineId?: string;
  partNumber: string;
  quantity: number;
  active?: boolean;
  expectedCost?: number;
};

export function CostSourceFields({ value, onChange, rfqId, rfqLineId, partNumber, quantity, active = true, expectedCost }: Props) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  const can = useCapabilityStore(state => state.can);
  const supplierAllowed = can('supplier_quote.read');
  const inventoryAllowed = can('inventory.view_cost');
  const supplierQuotes = useQuery({
    queryKey: [...queryKeys.all, 'cost-source-supplier-quotes', rfqId, rfqLineId || '', partNumber],
    queryFn: () => supplierQuoteApi.getAll({ rfqId, partNumber }),
    enabled: active && value.costSourceType === 'SUPPLIER_QUOTE' && supplierAllowed && Boolean(rfqId && partNumber),
    staleTime: 0,
  });
  const inventory = useQuery({
    queryKey: [...queryKeys.all, 'cost-source-inventory', partNumber],
    queryFn: () => inventoryApi.getByPartNumber(partNumber),
    enabled: active && value.costSourceType === 'INVENTORY_DETAIL' && inventoryAllowed && Boolean(partNumber),
    staleTime: 0,
  });
  const priceMatches = (price: number) => expectedCost === undefined || Math.round(price * 10000) === Math.round(expectedCost * 10000);
  const options = value.costSourceType === 'SUPPLIER_QUOTE'
    ? (supplierAllowed ? supplierQuotes.data ?? [] : []).filter(source =>
      source.rfqId === rfqId && (!rfqLineId || source.rfqLineId === rfqLineId) && source.partNumber === partNumber && source.quantity >= quantity &&
      source.currency === 'USD' && source.currencyStatus === 'VERIFIED' &&
      !['rejected', 'expired'].includes(source.status.toLowerCase()) &&
      (!source.validUntil || new Date(source.validUntil).getTime() > Date.now()) && priceMatches(source.unitPrice),
    ).map(source => ({ id: source.id, price: source.unitPrice, label: `${source.supplier?.name ?? tx('供应商', 'Supplier')} · ${source.partNumber} · ${source.quantity} · USD ${source.unitPrice.toFixed(4)}` }))
    : (inventoryAllowed ? inventory.data ?? [] : []).filter(source =>
      source.partNumber === partNumber && source.type?.toLowerCase() === 'own' &&
      ['AVAILABLE', 'RESERVED'].includes(source.status?.toUpperCase() ?? '') && source.quantity >= quantity &&
      typeof source.unitCost === 'number' && priceMatches(source.unitCost),
    ).map(source => ({ id: source.id, price: source.unitCost!, label: `${source.serialNumber || source.batchNumber || source.location || source.partNumber} · ${source.quantity} · USD ${source.unitCost!.toFixed(4)}` }));
  const query = value.costSourceType === 'SUPPLIER_QUOTE' ? supplierQuotes : inventory;
  const canLoad = Boolean(partNumber && (value.costSourceType !== 'SUPPLIER_QUOTE' || rfqId));
  return <div className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3">
    <div className="space-y-2">
      <Label>{tx('成本来源 *', 'Cost source *')}</Label>
      <Select value={value.costSourceType} onValueChange={type => onChange({ costSourceType: type as CostSourceValue['costSourceType'], costSourceId: '', costSourceReason: '' })}>
        <SelectTrigger aria-label={tx('成本来源', 'Cost source')}><SelectValue /></SelectTrigger>
        <SelectContent>
          {supplierAllowed && <SelectItem value="SUPPLIER_QUOTE">{tx('供应商报价', 'Supplier quote')}</SelectItem>}
          {inventoryAllowed && <SelectItem value="INVENTORY_DETAIL">{tx('自有库存', 'Own inventory')}</SelectItem>}
          <SelectItem value="MANUAL">{tx('人工成本', 'Manual cost')}</SelectItem>
        </SelectContent>
      </Select>
    </div>
    {value.costSourceType === 'MANUAL' ? <div className="space-y-2">
      <Label>{tx('人工成本依据 *', 'Manual cost basis *')}</Label>
      <Textarea aria-label={tx('人工成本依据', 'Manual cost basis')} value={value.costSourceReason} onChange={event => onChange({ ...value, costSourceReason: event.target.value })} maxLength={1000} placeholder={tx('填写成本的来源及核对依据', 'Describe the source and supporting basis')} rows={2} />
    </div> : <div className="space-y-2">
      <Label>{tx('选择来源记录 *', 'Select source *')}</Label>
      <Select value={value.costSourceId} onValueChange={id => {
        const source = options.find(option => option.id === id);
        if (source) onChange({ ...value, costSourceId: id, costSourceReason: '' }, source.price);
      }} disabled={!canLoad || query.isLoading || Boolean(query.error)}>
        <SelectTrigger aria-label={tx('选择来源记录', 'Select source')}><SelectValue placeholder={tx('选择已核实的来源', 'Choose a verified source')} /></SelectTrigger>
        <SelectContent>{options.map(option => <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>)}</SelectContent>
      </Select>
      {!canLoad ? <p className="text-xs text-slate-600">{tx('请先选择需求和件号。', 'Choose the RFQ and part first.')}</p>
        : query.error ? <div className="text-sm text-red-600">{tx('来源加载失败', 'Unable to load sources')} <Button type="button" size="sm" variant="outline" onClick={() => void query.refetch()}>{tx('重试', 'Retry')}</Button></div>
        : query.isLoading ? <p className="text-xs text-slate-600">{tx('正在加载来源…', 'Loading sources…')}</p>
        : options.length === 0 ? <p className="text-xs text-slate-600">{tx('没有满足当前件号、数量和币种的已核实来源。请先补齐来源记录，或填写有依据的人工成本。', 'No verified source matches this part, quantity and currency. Update the source record or provide a supported manual cost.')}</p>
        : <p className="text-xs text-slate-600">{tx('选择后使用来源单价；审批时会再次核对可用数量和有效期。', 'The source price is used; quantity and validity are checked again at approval.')}</p>}
    </div>}
  </div>;
}
