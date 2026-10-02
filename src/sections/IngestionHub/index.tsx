import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Inbox,
  AlertTriangle,
  Clock,
  CheckCircle,
  Trash2,
  Eye,
  FileText,
  Send,
  Edit3,
  X,
  Mail,
  Loader2,
  MoreHorizontal,
  AlertCircle,
  Ban,
  Plus,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetFooter,
} from '@/components/ui/sheet';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useEmailStore } from '@/store';
import { emailApi } from '@/api/client';
import { RfqExtractionAssistant } from '@/components/BusinessAiAssistants';
import { useEmails } from '@/hooks/useApi';
import { useRFQs, useCreateRFQ } from '@/features/rfqs';
import { useCustomers } from '@/features/customers';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import type { Email, RFQ, EmailType } from '@/types';

const emailTypeConfig: Record<EmailType, { label: string; color: string; bgColor: string }> = {
  aog: { label: 'AOG Urgent', color: 'text-red-600', bgColor: 'bg-red-50 border-red-200' },
  standard: { label: 'Standard RFQ', color: 'text-yellow-600', bgColor: 'bg-yellow-50 border-yellow-200' },
  inquiry: { label: 'General Inquiry', color: 'text-green-600', bgColor: 'bg-green-50 border-green-200' },
  spam: { label: 'Spam', color: 'text-gray-500', bgColor: 'bg-gray-50 border-gray-200' },
};

function EmailTypeBadge({ type }: { type: EmailType }) {
  const normalizedType = emailTypeConfig[type] ? type : 'standard';
  const config = emailTypeConfig[normalizedType];
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);

  const labelMap: Record<EmailType, string> = {
    aog: tx('AOG紧急', 'AOG Urgent'),
    standard: tx('标准需求单', 'Standard RFQ'),
    inquiry: tx('普通询盘', 'General Inquiry'),
    spam: tx('垃圾邮件', 'Spam'),
  };

  return (
    <Badge
      variant="outline"
      className={cn(config.bgColor, config.color, 'border')}
    >
      {normalizedType === 'aog' && <AlertTriangle className="w-3 h-3 mr-1" />}
      {labelMap[normalizedType] || config.label}
    </Badge>
  );
}

function extractRFQFromEmail(email: Email): Partial<RFQ> {
  // Local rule-based prefill remains available without a configured AI model.
  const partNumberMatch = email.body.match(/(?:PN|Part Number|件号)[\s:：]+([A-Z0-9-]+)/i);
  const quantityMatch = email.body.match(/(?:Qty|Quantity|数量)[\s:：]+(\d+)/i);
  const dateMatch = email.body.match(/(?:Required Date|需求日期)[\s:：]+(\d{4}-\d{2}-\d{2})/i);
  const aircraftMatch = email.body.match(/(?:Aircraft|A\/C Type|机型)[\s:：]+([A-Z0-9-]+)/i);
  const priceMatch = email.body.match(/(?:Target Price|目标价格)[\s:：]+\$?([\d,]+)/i);

  return {
    partNumber: partNumberMatch?.[1] || '',
    quantity: quantityMatch ? parseInt(quantityMatch[1], 10) : undefined,
    requiredDate: dateMatch?.[1],
    aircraftType: aircraftMatch?.[1] || '',
    targetPrice: priceMatch ? parseInt(priceMatch[1].replace(',', '')) : undefined,
    urgency: email.type === 'aog' ? 'aog' : 'standard',
    customerName: email.fromName,
  };
}

type RfqDraftLine = {
  partNumber: string;
  quantity: string;
  uom: string;
  requiredDate: string;
};

function isValidDate(value?: string): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function exactCustomerMatches(customers: Array<{ id: string; name: string }> | null | undefined, name: string) {
  const normalizedName = name.trim().toLocaleLowerCase();
  if (!normalizedName) return [];
  return (customers || []).filter((customer) => customer.name.trim().toLocaleLowerCase() === normalizedName);
}

export function IngestionHub() {
  const { emails, selectedEmail, setEmails, selectEmail, filter, setFilter, markAsRead, classifyEmail } = useEmailStore();
  const [page, setPage] = useState(1);
  const emailQuery = useEmails({
    type: filter === 'all' ? undefined : filter,
    excludeSpam: filter === 'all',
    page,
    limit: 20,
  });
  const { loading: rfqsLoading, refetch: refetchRFQs } = useRFQs();
  const { mutate: createRFQ } = useCreateRFQ();
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [extractedData, setExtractedData] = useState<Partial<RFQ>>({});
  const [draftLines, setDraftLines] = useState<RfqDraftLine[]>([]);
  const [customerSearch, setCustomerSearch] = useState('');
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [selectedCustomerName, setSelectedCustomerName] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const isCreatingRef = useRef(false);
  const { data: customerMatches } = useCustomers({
    search: selectedEmail ? customerSearch : undefined,
    page: 1,
    limit: 20,
  });
  const customerOptions = selectedCustomerId && customerMatches?.every((customer) => customer.id !== selectedCustomerId)
    ? [{ id: selectedCustomerId, name: selectedCustomerName }, ...(customerMatches || [])]
    : customerMatches || [];
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);

  useEffect(() => {
    if (emailQuery.data) setEmails(emailQuery.data.data);
  }, [emailQuery.data, setEmails]);

  const filteredEmails = emails;

  // Stats
  const stats = emailQuery.data?.summary || {
    total: emails.filter((e) => e.type !== 'spam').length,
    aog: emails.filter((e) => e.type === 'aog').length,
    standard: emails.filter((e) => e.type === 'standard').length,
    unread: emails.filter((e) => !e.isRead && e.type !== 'spam').length,
    spam: emails.filter((e) => e.type === 'spam').length,
  };

  if (rfqsLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-8 h-8 animate-spin text-brand-primary" />
        <span className="ml-2 text-gray-500">{tx('加载中...', 'Loading...')}</span>
      </div>
    );
  }

  const handleEmailClick = (email: Email) => {
    if (isCreatingRef.current) return;
    selectEmail(email);
    if (!email.isRead) {
      markAsRead(email.id);
      void emailApi.markAsRead(email.id).catch((error) => {
        void emailQuery.refetch();
        toast.error(error instanceof Error ? error.message : tx('标记已读失败', 'Failed to mark email as read'));
      });
    }
    const extracted = extractRFQFromEmail(email);
    setDraftLines([{
      partNumber: extracted.partNumber || '',
      quantity: extracted.quantity ? String(extracted.quantity) : '',
      uom: '',
      requiredDate: isValidDate(extracted.requiredDate) ? extracted.requiredDate : '',
    }]);
    setExtractedData(extracted);
    setCustomerSearch(email.fromName);
    setSelectedCustomerId('');
    setSelectedCustomerName('');
    setIsCreating(false);
    setIsSheetOpen(true);
    setIsEditing(false);
  };

  const handleCreateRFQ = async () => {
    if (!selectedEmail || isCreatingRef.current) return;

    const exactMatches = exactCustomerMatches(customerMatches, selectedEmail.fromName);
    const customerId = selectedCustomerId || (exactMatches.length === 1 ? exactMatches[0].id : '');
    const lines = draftLines.map((line) => ({
      partNumber: line.partNumber.trim(),
      quantity: Number(line.quantity),
      uom: line.uom.trim(),
      requiredDate: line.requiredDate,
    }));
    const validLines = lines.length > 0 && draftLines.every((line, index) => (
      Boolean(line.partNumber.trim())
      && /^\d+$/.test(line.quantity)
      && Number.isSafeInteger(lines[index].quantity)
      && lines[index].quantity > 0
      && Boolean(line.uom.trim())
      && isValidDate(line.requiredDate)
    ));
    if (!customerId || !validLines) return;

    const rfqData = {
      emailId: selectedEmail.id,
      customerId,
      urgency: (extractedData.urgency || 'standard').toUpperCase(),
      ...(extractedData.notes ? { notes: extractedData.notes } : {}),
      lines: draftLines.map((line) => ({
        partNumber: line.partNumber.trim(),
        quantity: Number(line.quantity),
        uom: line.uom.trim().toUpperCase(),
        requiredDate: line.requiredDate,
        ...(extractedData.aircraftType ? { aircraftType: extractedData.aircraftType } : {}),
        ...(extractedData.targetPrice !== undefined ? { targetPrice: extractedData.targetPrice } : {}),
      })),
    };

    isCreatingRef.current = true;
    setIsCreating(true);
    try {
      const result = await createRFQ(rfqData);
      setIsSheetOpen(false);
      selectEmail(null);
      refetchRFQs();
      await emailQuery.refetch();
      toast.success(tx(`需求单 ${result.rfqNumber} 创建成功。`, `RFQ ${result.rfqNumber} has been created successfully.`));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tx('创建需求单失败', 'Failed to create RFQ'));
    } finally {
      isCreatingRef.current = false;
      setIsCreating(false);
    }
  };

  const exactMatches = exactCustomerMatches(customerMatches, selectedEmail?.fromName || '');
  const matchedCustomerId = selectedCustomerId || (exactMatches.length === 1 ? exactMatches[0].id : '');
  const isDraftValid = draftLines.length > 0 && draftLines.every((line) => (
    Boolean(line.partNumber.trim())
    && /^\d+$/.test(line.quantity)
    && Number.isSafeInteger(Number(line.quantity))
    && Number(line.quantity) > 0
    && Boolean(line.uom.trim())
    && isValidDate(line.requiredDate)
  ));

  const handleClassify = async (email: Email, type: EmailType) => {
    const previousType = email.type;
    classifyEmail(email.id, type);
    try {
      await emailApi.classify(email.id, type);
      await emailQuery.refetch();
      toast.success(tx('邮件分类已更新', 'Email classification updated'));
    } catch (error) {
      classifyEmail(email.id, previousType);
      toast.error(error instanceof Error ? error.message : tx('更新邮件分类失败', 'Failed to update email classification'));
    }
  };

  const handleDiscard = async () => {
    if (!selectedEmail) return;
    try {
      await emailApi.discard(selectedEmail.id);
      setIsSheetOpen(false);
      selectEmail(null);
      await emailQuery.refetch();
      toast.success(tx('邮件已丢弃', 'Email discarded'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tx('丢弃邮件失败', 'Failed to discard email'));
    }
  };

  const handleFilterChange = (nextFilter: typeof filter) => {
    setPage(1);
    setFilter(nextFilter);
  };

  return (
    <div className="space-y-6">
      {/* Stat cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">{tx('邮件总数', 'Total Emails')}</p>
              <p className="text-2xl font-bold">{stats.total}</p>
            </div>
            <Mail className="w-8 h-8 text-gray-400" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">{tx('AOG紧急', 'AOG Urgent')}</p>
              <p className="text-2xl font-bold text-red-600">{stats.aog}</p>
            </div>
            <AlertTriangle className="w-8 h-8 text-red-500" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">{tx('标准需求单', 'Standard RFQs')}</p>
              <p className="text-2xl font-bold text-yellow-600">{stats.standard}</p>
            </div>
            <FileText className="w-8 h-8 text-yellow-500" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">{tx('未读', 'Unread')}</p>
              <p className="text-2xl font-bold text-blue-600">{stats.unread}</p>
            </div>
            <Inbox className="w-8 h-8 text-blue-500" />
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        {(['all', 'aog', 'standard', 'inquiry', 'spam'] as const).map((type) => (
          <Button
            key={type}
            variant={filter === type ? 'default' : 'outline'}
            size="sm"
            onClick={() => handleFilterChange(type)}
            className={cn(
              filter === type && 'bg-brand-primary hover:bg-brand-primary-hover',
              type === 'spam' && filter !== type && 'text-gray-500'
            )}
          >
            {type === 'all' && tx('全部', 'All')}
            {type === 'aog' && tx('AOG紧急', 'AOG Urgent')}
            {type === 'standard' && tx('标准需求单', 'Standard RFQ')}
            {type === 'inquiry' && tx('普通询盘', 'General Inquiry')}
            {type === 'spam' && tx('垃圾邮件', 'Spam')}
          </Button>
        ))}
      </div>

      {/* Email list */}
      <Card>
        <CardHeader>
          <CardTitle>{tx('邮件列表', 'Email List')}</CardTitle>
        </CardHeader>
        <CardContent>
          {emailQuery.error && (
            <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {emailQuery.error}
            </div>
          )}
          <div className="divide-y">
            {emailQuery.loading ? (
              <div className="flex items-center justify-center py-12 text-gray-500">
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                {tx('正在加载邮件...', 'Loading emails...')}
              </div>
            ) : filteredEmails.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                <Inbox className="w-16 h-16 mx-auto mb-4 text-gray-300" />
                <p>{tx('未找到邮件', 'No emails found')}</p>
              </div>
            ) : (
              filteredEmails.map((email) => (
                <div
                  key={email.id}
                  onClick={() => handleEmailClick(email)}
                  className={cn(
                    'p-4 hover:bg-gray-50 cursor-pointer transition-colors',
                    !email.isRead && 'bg-blue-50/50',
                    selectedEmail?.id === email.id && 'bg-brand-primary/5'
                  )}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3">
                      {!email.isRead && (
                        <span className="w-2 h-2 bg-blue-500 rounded-full mt-2 flex-shrink-0" />
                      )}
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{email.fromName}</span>
                          <EmailTypeBadge type={email.type} />
                          {email.processingStatus === 'processed' && (
                            <Badge variant="outline" className="border-green-200 bg-green-50 text-green-700">
                              {tx('已生成需求单', 'RFQ created')}
                            </Badge>
                          )}
                          {email.type === 'aog' && (
                            <span className="animate-pulse">
                              <AlertTriangle className="w-4 h-4 text-red-500" />
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-gray-900 mt-1">{email.subject}</p>
                        <p className="text-sm text-gray-500 line-clamp-2 mt-1">{email.body}</p>
                        <div className="flex items-center gap-4 mt-2 text-xs text-gray-400">
                          <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {new Date(email.receivedAt).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleEmailClick(email);
                        }}
                      >
                        <Eye className="w-4 h-4" />
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" onClick={(e) => e.stopPropagation()}>
                            <MoreHorizontal className="w-4 h-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => void handleClassify(email, 'aog')}>
                            <AlertCircle className="w-4 h-4 mr-2 text-red-500" />
                            {tx('标记为AOG', 'Mark as AOG')}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => void handleClassify(email, 'standard')}>
                            <FileText className="w-4 h-4 mr-2 text-yellow-500" />
                            {tx('标记为标准需求单', 'Mark as Standard RFQ')}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => void handleClassify(email, 'inquiry')}>
                            <Mail className="w-4 h-4 mr-2 text-green-500" />
                            {tx('标记为普通询盘', 'Mark as General Inquiry')}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => void handleClassify(email, 'spam')}>
                            <Ban className="w-4 h-4 mr-2 text-gray-500" />
                            {tx('移至垃圾邮件', 'Move to Spam')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
          {(emailQuery.data?.pagination.totalPages || 0) > 1 && (
            <div className="mt-4 flex items-center justify-between border-t pt-4 text-sm text-gray-500">
              <span>
                {tx(
                  `第 ${emailQuery.data?.pagination.page} / ${emailQuery.data?.pagination.totalPages} 页，共 ${emailQuery.data?.pagination.total} 封`,
                  `Page ${emailQuery.data?.pagination.page} of ${emailQuery.data?.pagination.totalPages}, ${emailQuery.data?.pagination.total} emails`,
                )}
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
                  {tx('上一页', 'Previous')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= (emailQuery.data?.pagination.totalPages || 1)}
                  onClick={() => setPage((value) => value + 1)}
                >
                  {tx('下一页', 'Next')}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Email details drawer */}
      <Sheet open={isSheetOpen} onOpenChange={setIsSheetOpen}>
        <SheetContent className="w-[600px] sm:max-w-[600px] overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              {selectedEmail && <EmailTypeBadge type={selectedEmail.type} />}
              {tx('需求单卡片', 'RFQ Card')}
            </SheetTitle>
          </SheetHeader>

          {selectedEmail && (
            <div className="space-y-6 py-6">
              {/* Email preview */}
              <div className="bg-gray-50 p-4 rounded-lg">
                <h4 className="text-sm font-medium text-gray-500 mb-2">{tx('原始邮件', 'Original Email')}</h4>
                <div className="space-y-2 text-sm">
                  <p><span className="text-gray-500">From:</span> {selectedEmail.fromName} ({selectedEmail.from})</p>
                  <p><span className="text-gray-500">Subject:</span> {selectedEmail.subject}</p>
                  <p><span className="text-gray-500">Time:</span> {new Date(selectedEmail.receivedAt).toLocaleString('en-US')}</p>
                  <div className="border-t pt-2 mt-2">
                    <pre className="whitespace-pre-wrap text-gray-700 text-xs">{selectedEmail.body}</pre>
                  </div>
                </div>
              </div>

              <RfqExtractionAssistant key={selectedEmail.id} emailId={selectedEmail.id} onApply={(result) => {
                setDraftLines(result.items.map((item) => ({
                  partNumber: item.partNumber,
                  quantity: Number.isSafeInteger(item.quantity) && (item.quantity ?? 0) > 0
                    ? String(item.quantity)
                    : '',
                  uom: item.quantityUnit || '',
                  requiredDate: isValidDate(item.requiredDate || undefined) ? item.requiredDate! : '',
                })));
                setExtractedData((draft) => ({ ...draft,
                  urgency: result.urgency.toLowerCase() as RFQ['urgency'],
                  aircraftType: result.aircraftType || draft.aircraftType,
                }));
                setIsEditing(true);
              }} />

              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-medium flex items-center gap-2">
                    <CheckCircle className="w-4 h-4 text-green-500" />
                    {tx('待确认需求行', 'Review demand lines')}
                  </h4>
                  <Button variant="ghost" size="sm" onClick={() => setIsEditing(!isEditing)}>
                    <Edit3 className="w-4 h-4 mr-1" />
                    {isEditing ? tx('完成', 'Done') : tx('编辑其他信息', 'Edit other details')}
                  </Button>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="ingestion-customer-search">{tx('客户', 'Customer')} *</Label>
                  <Input
                    id="ingestion-customer-search"
                    aria-label={tx('搜索客户', 'Search customers')}
                    value={customerSearch}
                    onChange={(event) => setCustomerSearch(event.target.value)}
                    placeholder={tx('搜索客户名称', 'Search customer names')}
                  />
                  <Select value={matchedCustomerId || undefined} onValueChange={(customerId) => {
                    const customer = customerMatches?.find((match) => match.id === customerId);
                    setSelectedCustomerId(customerId);
                    setSelectedCustomerName(customer?.name || '');
                  }}>
                    <SelectTrigger aria-label={tx('选择客户', 'Select customer')}>
                      <SelectValue placeholder={tx('选择客户', 'Select customer')} />
                    </SelectTrigger>
                    <SelectContent>
                      {customerOptions.map((customer) => (
                        <SelectItem key={customer.id} value={customer.id}>{customer.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {!matchedCustomerId && <p className="text-xs text-amber-700">{tx('请选择一个有效客户后才能创建需求单。', 'Select a valid customer before creating the RFQ.')}</p>}
                  {!selectedCustomerId && exactMatches.length === 1 && (
                    <p className="text-xs text-muted-foreground">{tx('已按发件人名称匹配客户，可在上方更改。', 'Matched the sender name to a customer. You can change it above.')}</p>
                  )}
                </div>

                <div className="space-y-3">
                  {draftLines.map((line, index) => (
                    <div key={index} className="space-y-3 rounded-lg border p-3">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">{tx(`需求行 ${index + 1}`, `Demand line ${index + 1}`)}</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={tx(`删除需求行 ${index + 1}`, `Remove demand line ${index + 1}`)}
                          disabled={draftLines.length <= 1}
                          onClick={() => setDraftLines((lines) => lines.filter((_, lineIndex) => lineIndex !== index))}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                        <div className="space-y-2">
                          <Label>{tx('件号 (PN)', 'Part Number (PN)')} *</Label>
                          <Input
                            aria-label={tx(`件号 (PN) ${index + 1}`, `Part Number (PN) ${index + 1}`)}
                            value={line.partNumber}
                            onChange={(event) => setDraftLines((lines) => lines.map((current, lineIndex) => (
                              lineIndex === index ? { ...current, partNumber: event.target.value } : current
                            )))}
                            className="font-mono"
                            placeholder="PN-123-456"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>{tx('数量 (Qty)', 'Quantity (Qty)')} *</Label>
                          <Input
                            type="number"
                            min="1"
                            step="1"
                            aria-label={tx(`数量 (Qty) ${index + 1}`, `Quantity (Qty) ${index + 1}`)}
                            value={line.quantity}
                            onChange={(event) => setDraftLines((lines) => lines.map((current, lineIndex) => (
                              lineIndex === index ? { ...current, quantity: event.target.value } : current
                            )))}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>{tx('单位', 'Unit')} *</Label>
                          <Input
                            aria-label={tx(`单位 ${index + 1}`, `Unit ${index + 1}`)}
                            value={line.uom}
                            maxLength={32}
                            onChange={(event) => setDraftLines((lines) => lines.map((current, lineIndex) => (
                              lineIndex === index ? { ...current, uom: event.target.value } : current
                            )))}
                            placeholder="EA"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>{tx('需求日期', 'Required Date')} *</Label>
                          <Input
                            type="date"
                            aria-label={tx(`需求日期 ${index + 1}`, `Required Date ${index + 1}`)}
                            value={line.requiredDate}
                            onChange={(event) => setDraftLines((lines) => lines.map((current, lineIndex) => (
                              lineIndex === index ? { ...current, requiredDate: event.target.value } : current
                            )))}
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                  {!isDraftValid && <p className="text-xs text-amber-700">{tx('每一行都需要有效件号、正整数数量、单位和需求日期。', 'Each line needs a part number, a positive whole quantity, a unit and a required date.')}</p>}
                  <Button type="button" variant="outline" onClick={() => setDraftLines((lines) => [...lines, { partNumber: '', quantity: '', uom: '', requiredDate: '' }])}>
                    <Plus className="mr-1 h-4 w-4" />
                    {tx('添加需求行', 'Add demand line')}
                  </Button>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>{tx('机型', 'Aircraft Type')}</Label>
                    {isEditing ? (
                      <Input value={extractedData.aircraftType || ''} onChange={(event) => setExtractedData({ ...extractedData, aircraftType: event.target.value })} />
                    ) : <div className="rounded border bg-blue-50 p-2">{extractedData.aircraftType || tx('未识别', 'Unrecognized')}</div>}
                  </div>
                  <div className="space-y-2">
                    <Label>{tx('目标价格', 'Target Price')}</Label>
                    {isEditing ? (
                      <Input type="number" min="0" value={extractedData.targetPrice ?? ''} onChange={(event) => setExtractedData({ ...extractedData, targetPrice: event.target.value ? Number(event.target.value) : undefined })} />
                    ) : <div className="rounded border bg-blue-50 p-2">{extractedData.targetPrice ? `$${extractedData.targetPrice}` : tx('未识别', 'Unrecognized')}</div>}
                  </div>
                  <div className="space-y-2">
                    <Label>{tx('紧急程度', 'Urgency')}</Label>
                    {isEditing ? (
                      <Select value={extractedData.urgency || 'standard'} onValueChange={(value) => setExtractedData({ ...extractedData, urgency: value as RFQ['urgency'] })}>
                        <SelectTrigger aria-label={tx('紧急程度', 'Urgency')}><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="aog">{tx('AOG 紧急', 'AOG Urgent')}</SelectItem>
                          <SelectItem value="urgent">{tx('紧急', 'Urgent')}</SelectItem>
                          <SelectItem value="standard">{tx('标准', 'Standard')}</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : <div className={cn('rounded border p-2', extractedData.urgency === 'aog' && 'border-red-100 bg-red-50 text-red-600', extractedData.urgency === 'urgent' && 'border-yellow-100 bg-yellow-50 text-yellow-600', extractedData.urgency === 'standard' && 'border-green-100 bg-green-50 text-green-600')}>
                      {extractedData.urgency === 'aog' ? tx('AOG 紧急', 'AOG Urgent') : extractedData.urgency === 'urgent' ? tx('紧急', 'Urgent') : tx('标准', 'Standard')}
                    </div>}
                  </div>
                  <div className="col-span-2 space-y-2">
                    <Label>{tx('备注', 'Notes')}</Label>
                    {isEditing ? (
                      <Textarea value={extractedData.notes || ''} onChange={(event) => setExtractedData({ ...extractedData, notes: event.target.value })} placeholder={tx('添加备注...', 'Add notes...')} />
                    ) : <div className="rounded border bg-gray-50 p-2"><span className="text-gray-500">{extractedData.notes || tx('暂无备注', 'No notes')}</span></div>}
                  </div>
                </div>
              </div>
            </div>
          )}

          <SheetFooter className="gap-2">
            <Button variant="outline" onClick={() => setIsSheetOpen(false)}>
              <X className="w-4 h-4 mr-1" />
              {tx('取消', 'Cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleDiscard()}
              disabled={Boolean(selectedEmail?.rfqId || selectedEmail?.processingStatus === 'processed')}
            >
              <Trash2 className="w-4 h-4 mr-1" />
              {tx('丢弃', 'Discard')}
            </Button>
            <Button
              onClick={handleCreateRFQ}
              disabled={isCreating || !matchedCustomerId || !isDraftValid || Boolean(selectedEmail?.rfqId || selectedEmail?.processingStatus === 'processed')}
              className="bg-brand-primary hover:bg-brand-primary-hover"
            >
              <Send className="w-4 h-4 mr-1" />
              {isCreating ? tx('正在创建...', 'Creating...') : tx('创建需求单', 'Create RFQ')}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}
