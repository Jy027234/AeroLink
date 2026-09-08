import { useMemo } from 'react';
import { CheckCircle2, CircleDollarSign, Layers3 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CostSourceFields, type CostSourceValue } from './CostSourceFields';
import { createLineQuotationDraft } from './lineQuotationComposerModel';
import type { RFQ, RfqLine } from '@/types';

export type LineQuotationCostSource = CostSourceValue;

/**
 * The editable value for one RFQ line. The RFQ line id and part number are
 * intentionally retained in the draft so a caller cannot accidentally submit
 * a price or cost against a different line after the RFQ selection changes.
 */
export interface LineQuotationDraft extends LineQuotationCostSource {
  rfqLineId: string;
  partNumber: string;
  quantity: number;
  unitPrice: number;
  costPrice: number;
}

export type LineQuotationComposerRfq = Pick<RFQ, 'id' | 'rfqNumber' | 'customerName' | 'lines'>;

export interface LineQuotationComposerProps {
  rfq: LineQuotationComposerRfq | null | undefined;
  value: LineQuotationDraft[];
  onChange: (value: LineQuotationDraft[]) => void;
  disabled?: boolean;
}

function formatUsd(value: number) {
  return `$${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value)}`;
}

function lineInputId(lineId: string, field: string) {
  return `quotation-line-${lineId}-${field}`;
}

export function LineQuotationComposer({ rfq, value, onChange, disabled = false }: LineQuotationComposerProps) {
  const rfqLines = useMemo(
    () => (rfq?.lines ?? []).filter(line => line.status === 'OPEN'),
    [rfq?.lines],
  );
  const valueByLineId = useMemo(
    () => new Map(value.map(line => [line.rfqLineId, line])),
    [value],
  );
  const displayTotal = value.reduce(
    (sum, line) => sum + Math.max(0, line.quantity) * Math.max(0, line.unitPrice),
    0,
  );

  const updateLines = (next: LineQuotationDraft[]) => {
    const order = new Map(rfqLines.map((line, index) => [line.id, index]));
    onChange([...next].sort((left, right) => (order.get(left.rfqLineId) ?? 0) - (order.get(right.rfqLineId) ?? 0)));
  };

  const toggleLine = (line: RfqLine, checked: boolean) => {
    if (checked) {
      if (valueByLineId.has(line.id)) return;
      updateLines([...value, createLineQuotationDraft(line)]);
      return;
    }
    updateLines(value.filter(item => item.rfqLineId !== line.id));
  };

  const updateLine = (lineId: string, patch: Partial<LineQuotationDraft>) => {
    updateLines(value.map(line => line.rfqLineId === lineId ? { ...line, ...patch } : line));
  };

  if (!rfq) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground" role="status">
          请选择 RFQ 后填写多行报价。
        </CardContent>
      </Card>
    );
  }

  if (rfqLines.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Layers3 className="h-4 w-4" />
            {rfq.rfqNumber}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground" role="status">
          此 RFQ 没有可报价的明细行。
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="flex items-center gap-2 text-base">
          <Layers3 className="h-4 w-4" />
          多行报价 · {rfq.rfqNumber}
        </CardTitle>
        <p className="text-sm text-muted-foreground">{rfq.customerName} · 选择要报价的 RFQ 明细行；每行的件号和 RFQ 行 ID 会随提交保留。</p>
      </CardHeader>
      <CardContent>
        <fieldset disabled={disabled} className="space-y-4">
          <legend className="sr-only">选择报价行</legend>
          <div className="grid gap-2 rounded-md border bg-muted/20 p-3" aria-label="RFQ 明细行选择">
            {rfqLines.map(line => {
              const selected = valueByLineId.has(line.id);
              const checkboxId = lineInputId(line.id, 'selected');
              return (
                <div key={line.id} className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-background">
                  <Checkbox
                    id={checkboxId}
                    aria-label={`选择 ${line.partNumber}`}
                    checked={selected}
                    onCheckedChange={checked => toggleLine(line, checked === true)}
                  />
                  <Label htmlFor={checkboxId} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm">
                    <span className="text-muted-foreground">#{line.lineNo}</span>
                    <span className="font-mono font-medium">{line.partNumber}</span>
                    <span className="text-muted-foreground">需求 {line.quantity} {line.uom}</span>
                  </Label>
                  {selected && <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />}
                </div>
              );
            })}
          </div>

          {value.length === 0 ? (
            <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground" role="status">
              请至少选择一条 RFQ 明细行。
            </div>
          ) : (
            <div className="space-y-4">
              {rfqLines.filter(line => valueByLineId.has(line.id)).map(line => {
                const draft = valueByLineId.get(line.id)!;
                const quantityId = lineInputId(line.id, 'quantity');
                const unitPriceId = lineInputId(line.id, 'unit-price');
                const costPriceId = lineInputId(line.id, 'cost-price');
                const sourceValue: CostSourceValue = {
                  costSourceType: draft.costSourceType,
                  costSourceId: draft.costSourceId,
                  costSourceReason: draft.costSourceReason,
                };
                return (
                  <section key={line.id} aria-label={`报价行 ${line.lineNo} ${line.partNumber}`} className="space-y-4 rounded-lg border p-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold">第 {line.lineNo} 行 · <span className="font-mono">{line.partNumber}</span></p>
                        <p className="text-xs text-muted-foreground">需求上限 {line.quantity} {line.uom}</p>
                      </div>
                      <span className="rounded bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700">USD</span>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-3">
                      <div className="space-y-1.5">
                        <Label htmlFor={quantityId}>报价数量</Label>
                        <Input
                          id={quantityId}
                          aria-label={`${line.partNumber} 报价数量`}
                          type="number"
                          min={1}
                          max={line.quantity}
                          step={1}
                          value={draft.quantity}
                          onChange={event => {
                            const parsed = Number.parseInt(event.target.value, 10);
                            const quantity = Number.isFinite(parsed) ? Math.min(line.quantity, Math.max(1, parsed)) : 1;
                            updateLine(line.id, { quantity });
                          }}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={unitPriceId}>销售单价（USD）</Label>
                        <Input
                          id={unitPriceId}
                          aria-label={`${line.partNumber} 销售单价`}
                          type="number"
                          min={0}
                          step="0.0001"
                          value={draft.unitPrice}
                          onChange={event => updateLine(line.id, { unitPrice: Math.max(0, Number.parseFloat(event.target.value) || 0) })}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={costPriceId}>成本单价（USD）</Label>
                        <Input
                          id={costPriceId}
                          aria-label={`${line.partNumber} 成本单价`}
                          type="number"
                          min={0}
                          step="0.0001"
                          readOnly={draft.costSourceType !== 'MANUAL'}
                          value={draft.costPrice}
                          onChange={event => updateLine(line.id, { costPrice: Math.max(0, Number.parseFloat(event.target.value) || 0) })}
                        />
                      </div>
                    </div>

                    <CostSourceFields
                      active={!disabled}
                      value={sourceValue}
                      rfqId={rfq.id}
                      rfqLineId={line.id}
                      partNumber={line.partNumber}
                      quantity={draft.quantity}
                      onChange={(source, unitCost) => updateLine(line.id, {
                        ...source,
                        ...(unitCost !== undefined ? { costPrice: unitCost } : {}),
                      })}
                    />
                  </section>
                );
              })}
            </div>
          )}

          <div className="flex items-center justify-between rounded-md border bg-blue-50/60 p-3" data-testid="quotation-display-total">
            <div className="flex items-center gap-2 text-sm font-medium text-blue-950">
              <CircleDollarSign className="h-4 w-4" />
              <span>展示合计（USD）</span>
            </div>
            <span className="font-mono font-semibold text-blue-700">{formatUsd(displayTotal)}</span>
          </div>
          <p className="text-xs text-muted-foreground">合计仅用于当前页面展示；服务器以每条 quotation line 的数量和单价为准。</p>
        </fieldset>
      </CardContent>
    </Card>
  );
}
