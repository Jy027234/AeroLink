import { useState } from 'react';
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
  Calendar,
  Plane,
  DollarSign,
  Hash,
  Loader2,
  MoreHorizontal,
  AlertCircle,
  Ban,
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
import { useEmailStore, useCustomerStore } from '@/store';
import { useRFQs, useCreateRFQ } from '@/hooks/useApi';
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
  const config = emailTypeConfig[type];
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
      {type === 'aog' && <AlertTriangle className="w-3 h-3 mr-1" />}
      {labelMap[type] || config.label}
    </Badge>
  );
}

function extractRFQFromEmail(email: Email): Partial<RFQ> {
  // Simulated AI extraction logic
  const partNumberMatch = email.body.match(/(?:PN|Part Number|件号)[\s:：]+([A-Z0-9-]+)/i);
  const quantityMatch = email.body.match(/(?:Qty|Quantity|数量)[\s:：]+(\d+)/i);
  const dateMatch = email.body.match(/(?:Required Date|需求日期)[\s:：]+(\d{4}-\d{2}-\d{2})/i);
  const aircraftMatch = email.body.match(/(?:Aircraft|A\/C Type|机型)[\s:：]+([A-Z0-9-]+)/i);
  const priceMatch = email.body.match(/(?:Target Price|目标价格)[\s:：]+\$?([\d,]+)/i);

  return {
    partNumber: partNumberMatch?.[1] || '',
    quantity: quantityMatch ? parseInt(quantityMatch[1]) : 1,
    requiredDate: dateMatch?.[1] || new Date().toISOString().split('T')[0],
    aircraftType: aircraftMatch?.[1] || '',
    targetPrice: priceMatch ? parseInt(priceMatch[1].replace(',', '')) : undefined,
    urgency: email.type === 'aog' ? 'aog' : 'standard',
    customerName: email.fromName,
  };
}

export function IngestionHub() {
  const { emails, selectedEmail, selectEmail, filter, setFilter, markAsRead, classifyEmail } = useEmailStore();
  const { loading: rfqsLoading, refetch: refetchRFQs } = useRFQs();
  const { mutate: createRFQ } = useCreateRFQ();
  const { customers } = useCustomerStore();
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [extractedData, setExtractedData] = useState<Partial<RFQ>>({});
  const [isEditing, setIsEditing] = useState(false);
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);

  // Filter emails
  const filteredEmails = emails.filter((email) => {
    if (filter === 'all') return email.type !== 'spam';
    return email.type === filter;
  });

  // Stats
  const stats = {
    total: emails.filter((e) => e.type !== 'spam').length,
    aog: emails.filter((e) => e.type === 'aog').length,
    standard: emails.filter((e) => e.type === 'standard').length,
    unread: emails.filter((e) => !e.isRead && e.type !== 'spam').length,
    spam: emails.filter((e) => e.type === 'spam').length,
  };

  if (rfqsLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-8 h-8 animate-spin text-[#64b5f6]" />
        <span className="ml-2 text-gray-500">{tx('加载中...', 'Loading...')}</span>
      </div>
    );
  }

  const handleEmailClick = (email: Email) => {
    selectEmail(email);
    if (!email.isRead) {
      markAsRead(email.id);
    }
    const extracted = extractRFQFromEmail(email);
    setExtractedData(extracted);
    setIsSheetOpen(true);
    setIsEditing(false);
  };

  const handleCreateRFQ = async () => {
    if (!selectedEmail || !extractedData.partNumber) return;

    const customerId = customers.find((c) => c.name.includes(selectedEmail.fromName))?.id || 'unknown';
    
    const rfqData = {
      emailId: selectedEmail.id,
      customerId,
      customerName: selectedEmail.fromName,
      partNumber: extractedData.partNumber,
      quantity: extractedData.quantity || 1,
      requiredDate: extractedData.requiredDate || new Date().toISOString().split('T')[0],
      aircraftType: extractedData.aircraftType,
      targetPrice: extractedData.targetPrice,
      urgency: extractedData.urgency || 'standard',
      notes: extractedData.notes,
      createdBy: 'u001',
    };

    const result = await createRFQ(rfqData);
    
    if (result) {
      setIsSheetOpen(false);
      selectEmail(null);
      refetchRFQs();
      alert(tx(`需求单 ${result.rfqNumber} 创建成功。`, `RFQ ${result.rfqNumber} has been created successfully.`));
    }
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
            onClick={() => setFilter(type)}
            className={cn(
              filter === type && 'bg-[#64b5f6] hover:bg-[#42a5f5]',
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
          <div className="divide-y">
            {filteredEmails.length === 0 ? (
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
                    selectedEmail?.id === email.id && 'bg-[#64b5f6]/5'
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
                          <DropdownMenuItem onClick={() => classifyEmail(email.id, 'aog')}>
                            <AlertCircle className="w-4 h-4 mr-2 text-red-500" />
                            {tx('标记为AOG', 'Mark as AOG')}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => classifyEmail(email.id, 'standard')}>
                            <FileText className="w-4 h-4 mr-2 text-yellow-500" />
                            {tx('标记为标准需求单', 'Mark as Standard RFQ')}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => classifyEmail(email.id, 'inquiry')}>
                            <Mail className="w-4 h-4 mr-2 text-green-500" />
                            {tx('标记为普通询盘', 'Mark as General Inquiry')}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => classifyEmail(email.id, 'spam')}>
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

              {/* AI extracted fields */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-medium flex items-center gap-2">
                    <CheckCircle className="w-4 h-4 text-green-500" />
                    {tx('AI 提取信息', 'AI Extracted Information')}
                  </h4>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setIsEditing(!isEditing)}
                  >
                    <Edit3 className="w-4 h-4 mr-1" />
                    {isEditing ? tx('完成', 'Done') : tx('编辑', 'Edit')}
                  </Button>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className="flex items-center gap-2">
                      <Hash className="w-4 h-4 text-gray-400" />
                      {tx('件号 (PN)', 'Part Number (PN)')}
                    </Label>
                    {isEditing ? (
                      <Input
                        value={extractedData.partNumber || ''}
                        onChange={(e) => setExtractedData({ ...extractedData, partNumber: e.target.value })}
                        className="font-mono"
                      />
                    ) : (
                      <div className="p-2 bg-blue-50 rounded border border-blue-100">
                        <span className="font-mono font-medium">{extractedData.partNumber || tx('未识别', 'Unrecognized')}</span>
                      </div>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label className="flex items-center gap-2">
                      <Hash className="w-4 h-4 text-gray-400" />
                      {tx('数量 (Qty)', 'Quantity (Qty)')}
                    </Label>
                    {isEditing ? (
                      <Input
                        type="number"
                        value={extractedData.quantity || ''}
                        onChange={(e) => setExtractedData({ ...extractedData, quantity: parseInt(e.target.value) })}
                      />
                    ) : (
                      <div className="p-2 bg-blue-50 rounded border border-blue-100">
                        <span className="font-medium">{extractedData.quantity || tx('未识别', 'Unrecognized')}</span>
                      </div>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label className="flex items-center gap-2">
                      <Calendar className="w-4 h-4 text-gray-400" />
                      {tx('需求日期', 'Required Date')}
                    </Label>
                    {isEditing ? (
                      <Input
                        type="date"
                        value={extractedData.requiredDate || ''}
                        onChange={(e) => setExtractedData({ ...extractedData, requiredDate: e.target.value })}
                      />
                    ) : (
                      <div className="p-2 bg-blue-50 rounded border border-blue-100">
                        <span className="font-medium">{extractedData.requiredDate || tx('未识别', 'Unrecognized')}</span>
                      </div>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label className="flex items-center gap-2">
                      <Plane className="w-4 h-4 text-gray-400" />
                      {tx('机型', 'Aircraft Type')}
                    </Label>
                    {isEditing ? (
                      <Input
                        value={extractedData.aircraftType || ''}
                        onChange={(e) => setExtractedData({ ...extractedData, aircraftType: e.target.value })}
                      />
                    ) : (
                      <div className="p-2 bg-blue-50 rounded border border-blue-100">
                        <span className="font-medium">{extractedData.aircraftType || tx('未识别', 'Unrecognized')}</span>
                      </div>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label className="flex items-center gap-2">
                      <DollarSign className="w-4 h-4 text-gray-400" />
                      {tx('目标价格', 'Target Price')}
                    </Label>
                    {isEditing ? (
                      <Input
                        type="number"
                        value={extractedData.targetPrice || ''}
                        onChange={(e) => setExtractedData({ ...extractedData, targetPrice: parseInt(e.target.value) })}
                      />
                    ) : (
                      <div className="p-2 bg-blue-50 rounded border border-blue-100">
                        <span className="font-medium">
                          {extractedData.targetPrice ? `$${extractedData.targetPrice}` : tx('未识别', 'Unrecognized')}
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label className="flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 text-gray-400" />
                      {tx('紧急程度', 'Urgency')}
                    </Label>
                    {isEditing ? (
                      <Select
                        value={extractedData.urgency}
                        onValueChange={(value) => setExtractedData({ ...extractedData, urgency: value as RFQ['urgency'] })}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="aog">{tx('AOG 紧急', 'AOG Urgent')}</SelectItem>
                          <SelectItem value="urgent">{tx('紧急', 'Urgent')}</SelectItem>
                          <SelectItem value="standard">{tx('标准', 'Standard')}</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : (
                      <div className={cn(
                        'p-2 rounded border',
                        extractedData.urgency === 'aog' && 'bg-red-50 border-red-100 text-red-600',
                        extractedData.urgency === 'urgent' && 'bg-yellow-50 border-yellow-100 text-yellow-600',
                        extractedData.urgency === 'standard' && 'bg-green-50 border-green-100 text-green-600'
                      )}>
                        <span className="font-medium">
                          {extractedData.urgency === 'aog' && tx('AOG 紧急', 'AOG Urgent')}
                          {extractedData.urgency === 'urgent' && tx('紧急', 'Urgent')}
                          {extractedData.urgency === 'standard' && tx('标准', 'Standard')}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>{tx('备注', 'Notes')}</Label>
                  {isEditing ? (
                    <Textarea
                      value={extractedData.notes || ''}
                      onChange={(e) => setExtractedData({ ...extractedData, notes: e.target.value })}
                      placeholder={tx('添加备注...', 'Add notes...')}
                    />
                  ) : (
                    <div className="p-2 bg-gray-50 rounded border">
                      <span className="text-gray-500">{extractedData.notes || tx('暂无备注', 'No notes')}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          <SheetFooter className="gap-2">
            <Button variant="outline" onClick={() => setIsSheetOpen(false)}>
              <X className="w-4 h-4 mr-1" />
              {tx('取消', 'Cancel')}
            </Button>
            <Button variant="destructive" onClick={() => setIsSheetOpen(false)}>
              <Trash2 className="w-4 h-4 mr-1" />
              {tx('丢弃', 'Discard')}
            </Button>
            <Button
              onClick={handleCreateRFQ}
              disabled={!extractedData.partNumber}
              className="bg-[#64b5f6] hover:bg-[#42a5f5]"
            >
              <Send className="w-4 h-4 mr-1" />
              Create RFQ
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}
