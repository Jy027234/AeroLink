import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Gavel,
  Search,
  Filter,
  Plus,
  Eye,
  Loader2,
  Clock,
  AlertTriangle,
  CheckCircle,
  XCircle,
  TrendingUp,
  TrendingDown,
  Lock,
  Hash,
  Timer,
  Send,
  Play,
  Ban,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAuctions, useCreateAuction, usePlaceBid } from '@/hooks/useApi';
import { auctionApi } from '@/api/client';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import type { Auction, AuctionBid } from '@/api/client';

type AuctionStatus = Auction['status'];
type AuctionType = Auction['type'];

/* ─── Config ─── */
const statusConfig: Record<AuctionStatus, { label: string; color: string; bgColor: string; icon: React.ElementType }> = {
  DRAFT: { label: 'Draft', color: 'text-gray-600', bgColor: 'bg-gray-50', icon: Clock },
  ACTIVE: { label: 'Active', color: 'text-green-600', bgColor: 'bg-green-50', icon: Gavel },
  CLOSED: { label: 'Closed', color: 'text-blue-600', bgColor: 'bg-blue-50', icon: CheckCircle },
  CANCELLED: { label: 'Cancelled', color: 'text-red-600', bgColor: 'bg-red-50', icon: XCircle },
};

const typeConfig: Record<AuctionType, { label: string; color: string; bgColor: string; icon: React.ElementType }> = {
  SALES: { label: 'Sales', color: 'text-blue-600', bgColor: 'bg-blue-50', icon: TrendingUp },
  REVERSE: { label: 'Reverse', color: 'text-purple-600', bgColor: 'bg-purple-50', icon: TrendingDown },
  SEALED: { label: 'Sealed', color: 'text-amber-600', bgColor: 'bg-amber-50', icon: Lock },
};

/* ─── Countdown ─── */
interface TimeLeft {
  total: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

function getTimeLeft(endAt: string): TimeLeft {
  const total = new Date(endAt).getTime() - Date.now();
  if (total <= 0) return { total: 0, days: 0, hours: 0, minutes: 0, seconds: 0 };
  const days = Math.floor(total / (1000 * 60 * 60 * 24));
  const hours = Math.floor((total % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((total % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((total % (1000 * 60)) / 1000);
  return { total, days, hours, minutes, seconds };
}

function Countdown({ endAt }: { endAt: string }) {
  const [timeLeft, setTimeLeft] = useState<TimeLeft>(() => getTimeLeft(endAt));
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);

  useEffect(() => {
    const timer = setInterval(() => setTimeLeft(getTimeLeft(endAt)), 1000);
    return () => clearInterval(timer);
  }, [endAt]);

  if (timeLeft.total <= 0) {
    return <span className="text-red-600 font-medium text-sm">{tx('已结束', 'Ended')}</span>;
  }

  return (
    <span className="font-mono text-sm tabular-nums">
      {timeLeft.days > 0 && `${timeLeft.days}d `}
      {String(timeLeft.hours).padStart(2, '0')}:
      {String(timeLeft.minutes).padStart(2, '0')}:
      {String(timeLeft.seconds).padStart(2, '0')}
    </span>
  );
}

/* ─── Badges ─── */
function AuctionStatusBadge({ status }: { status: AuctionStatus }) {
  const config = statusConfig[status];
  const Icon = config.icon;
  const { locale } = useTranslation();
  const labelMap: Record<AuctionStatus, string> = {
    DRAFT: locale === 'zh-CN' ? '草稿' : 'Draft',
    ACTIVE: locale === 'zh-CN' ? '进行中' : 'Active',
    CLOSED: locale === 'zh-CN' ? '已结束' : 'Closed',
    CANCELLED: locale === 'zh-CN' ? '已取消' : 'Cancelled',
  };
  return (
    <Badge variant="outline" className={cn(config.bgColor, config.color, 'border')}>
      <Icon className="w-3 h-3 mr-1" />
      {labelMap[status] || config.label}
    </Badge>
  );
}

function AuctionTypeBadge({ type }: { type: AuctionType }) {
  const config = typeConfig[type];
  const Icon = config.icon;
  const { locale } = useTranslation();
  const labelMap: Record<AuctionType, string> = {
    SALES: locale === 'zh-CN' ? '销售拍卖' : 'Sales',
    REVERSE: locale === 'zh-CN' ? '反向拍卖' : 'Reverse',
    SEALED: locale === 'zh-CN' ? '密封拍卖' : 'Sealed',
  };
  return (
    <Badge variant="outline" className={cn(config.bgColor, config.color, 'border')}>
      <Icon className="w-3 h-3 mr-1" />
      {labelMap[type] || config.label}
    </Badge>
  );
}

/* ─── Bid display helper ─── */
function getCurrentBidDisplay(auction: Auction, locale: string): { label: string; value: string; color: string } {
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const bids = auction.bids || [];
  if (auction.type === 'SEALED' && auction.status === 'ACTIVE') {
    return { label: tx('出价密封', 'Bids Sealed'), value: '—', color: 'text-amber-600' };
  }
  if (bids.length === 0) {
    const sp = auction.startingPrice;
    return {
      label: tx('起拍价', 'Starting Price'),
      value: sp !== undefined ? `${auction.currency} ${sp.toLocaleString()}` : '—',
      color: 'text-gray-600',
    };
  }
  if (auction.type === 'SALES') {
    const max = Math.max(...bids.map((b) => b.amount));
    return { label: tx('最高出价', 'Highest Bid'), value: `${auction.currency} ${max.toLocaleString()}`, color: 'text-green-600' };
  }
  if (auction.type === 'REVERSE') {
    const min = Math.min(...bids.map((b) => b.amount));
    return { label: tx('最低出价', 'Lowest Bid'), value: `${auction.currency} ${min.toLocaleString()}`, color: 'text-green-600' };
  }
  const winning = bids.find((b) => b.isWinning);
  if (winning) {
    return { label: tx('中标出价', 'Winning Bid'), value: `${auction.currency} ${winning.amount.toLocaleString()}`, color: 'text-blue-600' };
  }
  return { label: tx('出价数', 'Bids'), value: `${bids.length}`, color: 'text-gray-600' };
}

/* ─── Create Auction Dialog ─── */
function CreateAuctionDialog({
  isOpen,
  onClose,
  onCreated,
}: {
  isOpen: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const { mutate: createAuction, loading: isSubmitting } = useCreateAuction();

  const now = new Date();
  const defaultEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const toDatetimeLocal = (d: Date) => {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const [formData, setFormData] = useState({
    title: '',
    description: '',
    type: 'SALES' as AuctionType,
    partNumber: '',
    quantity: 1,
    conditionCode: '',
    startingPrice: 0,
    reservePrice: undefined as number | undefined,
    buyNowPrice: undefined as number | undefined,
    currency: 'USD',
    startAt: toDatetimeLocal(now),
    endAt: toDatetimeLocal(defaultEnd),
    autoExtend: false,
    extendMinutes: 5,
  });

  const handleSubmit = async () => {
    if (!formData.title.trim() || !formData.partNumber.trim() || formData.quantity <= 0) {
      alert(tx('请填写所有必填字段（标题、件号、数量）。', 'Please fill in all required fields (Title, Part Number, Quantity).'));
      return;
    }

    const payload = {
      title: formData.title,
      description: formData.description || undefined,
      type: formData.type,
      partNumber: formData.partNumber,
      quantity: formData.quantity,
      conditionCode: formData.conditionCode || undefined,
      startingPrice: formData.startingPrice || undefined,
      reservePrice: formData.reservePrice,
      buyNowPrice: formData.buyNowPrice,
      currency: formData.currency,
      startAt: new Date(formData.startAt).toISOString(),
      endAt: new Date(formData.endAt).toISOString(),
      autoExtend: formData.autoExtend,
      extendMinutes: formData.extendMinutes,
    };

    const result = await createAuction(payload);
    if (result) {
      alert(tx('拍卖创建成功。', 'Auction created successfully.'));
      onClose();
      onCreated();
      setFormData({
        title: '',
        description: '',
        type: 'SALES',
        partNumber: '',
        quantity: 1,
        conditionCode: '',
        startingPrice: 0,
        reservePrice: undefined,
        buyNowPrice: undefined,
        currency: 'USD',
        startAt: toDatetimeLocal(new Date()),
        endAt: toDatetimeLocal(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)),
        autoExtend: false,
        extendMinutes: 5,
      });
    } else {
      alert(tx('创建拍卖失败。', 'Failed to create auction.'));
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="w-5 h-5" />
            {tx('创建拍卖', 'Create Auction')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{tx('标题 *', 'Title *')}</Label>
              <Input
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                placeholder={tx('输入拍卖标题', 'Enter auction title')}
              />
            </div>
            <div className="space-y-2">
              <Label>{tx('拍卖类型 *', 'Auction Type *')}</Label>
              <Select
                value={formData.type}
                onValueChange={(v) => setFormData({ ...formData, type: v as AuctionType })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="SALES">{tx('销售拍卖', 'Sales')}</SelectItem>
                  <SelectItem value="REVERSE">{tx('反向拍卖', 'Reverse')}</SelectItem>
                  <SelectItem value="SEALED">{tx('密封拍卖', 'Sealed')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>{tx('描述', 'Description')}</Label>
            <Textarea
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              placeholder={tx('输入拍卖描述（可选）', 'Enter auction description (optional)')}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{tx('件号 *', 'Part Number *')}</Label>
              <Input
                value={formData.partNumber}
                onChange={(e) => setFormData({ ...formData, partNumber: e.target.value })}
                placeholder={tx('输入件号', 'Enter part number')}
              />
            </div>
            <div className="space-y-2">
              <Label>{tx('数量 *', 'Quantity *')}</Label>
              <Input
                type="number"
                min={1}
                value={formData.quantity}
                onChange={(e) => setFormData({ ...formData, quantity: parseInt(e.target.value) || 0 })}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{tx('状态代码', 'Condition Code')}</Label>
              <Input
                value={formData.conditionCode}
                onChange={(e) => setFormData({ ...formData, conditionCode: e.target.value })}
                placeholder="e.g. OH, SV, AR"
              />
            </div>
            <div className="space-y-2">
              <Label>{tx('币种', 'Currency')}</Label>
              <Select
                value={formData.currency}
                onValueChange={(v) => setFormData({ ...formData, currency: v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="USD">USD</SelectItem>
                  <SelectItem value="EUR">EUR</SelectItem>
                  <SelectItem value="CNY">CNY</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>{tx('起拍价', 'Starting Price')}</Label>
              <Input
                type="number"
                min={0}
                step={0.01}
                value={formData.startingPrice}
                onChange={(e) => setFormData({ ...formData, startingPrice: parseFloat(e.target.value) || 0 })}
              />
            </div>
            <div className="space-y-2">
              <Label>{tx('保留价', 'Reserve Price')}</Label>
              <Input
                type="number"
                min={0}
                step={0.01}
                value={formData.reservePrice ?? ''}
                onChange={(e) => setFormData({ ...formData, reservePrice: e.target.value ? parseFloat(e.target.value) : undefined })}
              />
            </div>
            <div className="space-y-2">
              <Label>{tx('一口价', 'Buy Now Price')}</Label>
              <Input
                type="number"
                min={0}
                step={0.01}
                value={formData.buyNowPrice ?? ''}
                onChange={(e) => setFormData({ ...formData, buyNowPrice: e.target.value ? parseFloat(e.target.value) : undefined })}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{tx('开始时间', 'Start At')}</Label>
              <Input
                type="datetime-local"
                value={formData.startAt}
                onChange={(e) => setFormData({ ...formData, startAt: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>{tx('结束时间', 'End At')}</Label>
              <Input
                type="datetime-local"
                value={formData.endAt}
                onChange={(e) => setFormData({ ...formData, endAt: e.target.value })}
              />
            </div>
          </div>

          <div className="flex items-center gap-4 p-3 border rounded-lg">
            <div className="flex items-center gap-2 flex-1">
              <Switch
                checked={formData.autoExtend}
                onCheckedChange={(checked) => setFormData({ ...formData, autoExtend: checked })}
              />
              <Label className="cursor-pointer">{tx('自动延长', 'Auto Extend')}</Label>
            </div>
            {formData.autoExtend && (
              <div className="flex items-center gap-2">
                <Label className="text-sm">{tx('延长分钟数', 'Extend Minutes')}</Label>
                <Input
                  type="number"
                  min={1}
                  className="w-24 h-8"
                  value={formData.extendMinutes}
                  onChange={(e) => setFormData({ ...formData, extendMinutes: parseInt(e.target.value) || 5 })}
                />
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {tx('取消', 'Cancel')}
          </Button>
          <Button
            className="bg-[#64b5f6] hover:bg-[#42a5f5]"
            onClick={handleSubmit}
            disabled={isSubmitting}
          >
            {isSubmitting ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Plus className="w-4 h-4 mr-1" />}
            {tx('创建拍卖', 'Create Auction')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ─── Auction Detail Dialog ─── */
function AuctionDetailDialog({
  auction,
  isOpen,
  onClose,
  onBidPlaced,
}: {
  auction: Auction | null;
  isOpen: boolean;
  onClose: () => void;
  onBidPlaced: () => void;
}) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const { mutate: placeBid, loading: bidSubmitting } = usePlaceBid();

  const [bids, setBids] = useState<AuctionBid[]>([]);
  const [bidsLoading, setBidsLoading] = useState(false);
  const [bidsError, setBidsError] = useState(false);
  const [bidAmount, setBidAmount] = useState('');
  const [bidNotes, setBidNotes] = useState('');
  const [bidError, setBidError] = useState<string | null>(null);

  const loadBids = useCallback(async () => {
    if (!auction) return;
    setBidsLoading(true);
    setBidsError(false);
    try {
      const result = await auctionApi.getBids(auction.id);
      setBids(result);
    } catch {
      setBidsError(true);
    } finally {
      setBidsLoading(false);
    }
  }, [auction]);

  useEffect(() => {
    if (isOpen && auction) {
      setBidAmount('');
      setBidNotes('');
      setBidError(null);
      void loadBids();
    }
  }, [isOpen, auction, loadBids]);

  if (!auction) return null;

  const isActive = auction.status === 'ACTIVE';
  const isSealedActive = auction.type === 'SEALED' && isActive;
  const currentBids = auction.bids || bids || [];

  const validateBid = (amount: number): string | null => {
    if (amount <= 0) return tx('出价必须大于 0', 'Bid amount must be greater than 0');
    if (auction.type === 'SALES') {
      const highest = currentBids.length > 0 ? Math.max(...currentBids.map((b) => b.amount)) : (auction.startingPrice ?? 0);
      if (amount <= highest) return tx(`出价必须高于当前最高价 ${highest}`, `Bid must be higher than current highest ${highest}`);
    }
    if (auction.type === 'REVERSE') {
      const lowest = currentBids.length > 0 ? Math.min(...currentBids.map((b) => b.amount)) : (auction.startingPrice ?? Infinity);
      if (lowest === Infinity) {
        if (amount <= 0) return tx('出价必须大于 0', 'Bid amount must be greater than 0');
      } else if (amount >= lowest) {
        return tx(`出价必须低于当前最低价 ${lowest}`, `Bid must be lower than current lowest ${lowest}`);
      }
    }
    return null;
  };

  const handlePlaceBid = async () => {
    const amount = parseFloat(bidAmount);
    if (Number.isNaN(amount)) {
      setBidError(tx('请输入有效的出价金额', 'Please enter a valid bid amount'));
      return;
    }
    const error = validateBid(amount);
    if (error) {
      setBidError(error);
      return;
    }
    setBidError(null);
    const result = await placeBid({
      id: auction.id,
      data: { amount, notes: bidNotes || undefined },
    });
    if (result) {
      alert(tx('出价成功', 'Bid placed successfully'));
      setBidAmount('');
      setBidNotes('');
      void loadBids();
      onBidPlaced();
    } else {
      alert(tx('出价失败', 'Failed to place bid'));
    }
  };

  const bidDisplay = getCurrentBidDisplay({ ...auction, bids: currentBids }, locale);

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Gavel className="w-5 h-5" />
            {tx('拍卖详情', 'Auction Details')} — {auction.auctionNumber}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Header info */}
          <div className="flex justify-between items-start p-4 bg-gray-50 rounded-lg">
            <div>
              <p className="font-mono font-semibold text-lg">{auction.auctionNumber}</p>
              <p className="text-sm text-gray-500">{auction.title}</p>
              {auction.description && <p className="text-sm text-gray-400 mt-1">{auction.description}</p>}
            </div>
            <div className="flex gap-2">
              <AuctionTypeBadge type={auction.type} />
              <AuctionStatusBadge status={auction.status} />
            </div>
          </div>

          {/* Key metrics */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="p-4 border rounded-lg">
              <p className="text-xs text-gray-400">{tx('件号', 'Part Number')}</p>
              <p className="font-mono font-semibold">{auction.partNumber}</p>
            </div>
            <div className="p-4 border rounded-lg">
              <p className="text-xs text-gray-400">{tx('数量', 'Quantity')}</p>
              <p className="font-semibold">{auction.quantity} EA</p>
            </div>
            <div className="p-4 border rounded-lg">
              <p className="text-xs text-gray-400">{tx('当前出价', 'Current Bid')}</p>
              <p className={cn('font-semibold', bidDisplay.color)}>{bidDisplay.value}</p>
            </div>
            <div className="p-4 border rounded-lg">
              <p className="text-xs text-gray-400">{tx('剩余时间', 'Time Left')}</p>
              <Countdown endAt={auction.endAt} />
            </div>
          </div>

          {/* Details grid */}
          <div className="grid grid-cols-2 gap-4 p-4 bg-gray-50 rounded-lg text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">{tx('起拍价', 'Starting Price')}</span>
              <span>{auction.startingPrice !== undefined ? `${auction.currency} ${auction.startingPrice.toLocaleString()}` : '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">{tx('保留价', 'Reserve Price')}</span>
              <span>{auction.reservePrice !== undefined ? `${auction.currency} ${auction.reservePrice.toLocaleString()}` : '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">{tx('一口价', 'Buy Now Price')}</span>
              <span>{auction.buyNowPrice !== undefined ? `${auction.currency} ${auction.buyNowPrice.toLocaleString()}` : '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">{tx('状态代码', 'Condition')}</span>
              <span>{auction.conditionCode || '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">{tx('开始时间', 'Start At')}</span>
              <span>{new Date(auction.startAt).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">{tx('结束时间', 'End At')}</span>
              <span>{new Date(auction.endAt).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">{tx('自动延长', 'Auto Extend')}</span>
              <span>{auction.autoExtend ? tx('是', 'Yes') : tx('否', 'No')}</span>
            </div>
            {auction.autoExtend && (
              <div className="flex justify-between">
                <span className="text-gray-500">{tx('延长分钟', 'Extend Minutes')}</span>
                <span>{auction.extendMinutes} min</span>
              </div>
            )}
            {auction.finalPrice !== undefined && (
              <div className="flex justify-between col-span-2">
                <span className="text-gray-500">{tx('成交价', 'Final Price')}</span>
                <span className="font-bold text-blue-600">{auction.currency} {auction.finalPrice.toLocaleString()}</span>
              </div>
            )}
          </div>

          {/* Bid history */}
          <div>
            <h4 className="font-medium mb-3 flex items-center gap-2">
              <Hash className="w-4 h-4" />
              {tx('出价记录', 'Bid History')} ({currentBids.length})
            </h4>
            {bidsLoading && (
              <div className="flex items-center justify-center py-4 text-gray-500">
                <Loader2 className="h-5 w-5 animate-spin text-[#64b5f6]" />
                <span className="ml-2 text-sm">{tx('加载出价中...', 'Loading bids...')}</span>
              </div>
            )}
            {bidsError && !bidsLoading && (
              <div className="flex items-center gap-2 text-amber-600 text-sm py-2">
                <AlertTriangle className="w-4 h-4" />
                {tx('出价记录加载失败', 'Failed to load bids')}
              </div>
            )}
            {!bidsLoading && currentBids.length === 0 && (
              <p className="text-sm text-gray-500 py-2">{tx('暂无出价', 'No bids yet')}</p>
            )}
            {currentBids.length > 0 && (
              <div className="border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{tx('出价人', 'Bidder')}</TableHead>
                      <TableHead>{tx('金额', 'Amount')}</TableHead>
                      <TableHead>{tx('数量', 'Quantity')}</TableHead>
                      <TableHead>{tx('时间', 'Time')}</TableHead>
                      <TableHead>{tx('状态', 'Status')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {currentBids
                      .slice()
                      .sort((a, b) => new Date(b.bidTime).getTime() - new Date(a.bidTime).getTime())
                      .map((bid) => (
                        <TableRow key={bid.id}>
                          <TableCell>{bid.bidderName}</TableCell>
                          <TableCell>
                            {isSealedActive ? (
                              <span className="text-amber-600 italic">{tx('密封', 'Sealed')}</span>
                            ) : (
                              <span className="font-mono font-semibold">
                                {bid.currency} {bid.amount.toLocaleString()}
                              </span>
                            )}
                          </TableCell>
                          <TableCell>{bid.quantity}</TableCell>
                          <TableCell className="text-sm text-gray-500">
                            {new Date(bid.bidTime).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')}
                          </TableCell>
                          <TableCell>
                            {bid.isWinning && (
                              <Badge variant="outline" className="bg-green-50 text-green-600 border-green-200">
                                <CheckCircle className="w-3 h-3 mr-1" />
                                {tx('领先', 'Winning')}
                              </Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>

          {/* Bid input */}
          {isActive && (
            <div className="p-4 border rounded-lg space-y-4">
              <h4 className="font-medium flex items-center gap-2">
                <Send className="w-4 h-4" />
                {tx('提交出价', 'Place Bid')}
              </h4>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>{tx('出价金额', 'Bid Amount')} ({auction.currency})</Label>
                  <Input
                    type="number"
                    min={0}
                    step={0.01}
                    value={bidAmount}
                    onChange={(e) => {
                      setBidAmount(e.target.value);
                      setBidError(null);
                    }}
                    placeholder={auction.type === 'REVERSE' ? tx('输入更低价格', 'Enter lower price') : tx('输入出价', 'Enter bid amount')}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{tx('备注', 'Notes')}</Label>
                  <Input
                    value={bidNotes}
                    onChange={(e) => setBidNotes(e.target.value)}
                    placeholder={tx('可选', 'Optional')}
                  />
                </div>
              </div>
              {bidError && (
                <div className="flex items-center gap-2 text-red-600 text-sm">
                  <AlertTriangle className="w-4 h-4" />
                  {bidError}
                </div>
              )}
              <Button
                className="bg-[#64b5f6] hover:bg-[#42a5f5]"
                onClick={handlePlaceBid}
                disabled={bidSubmitting || !bidAmount}
              >
                {bidSubmitting ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Send className="w-4 h-4 mr-1" />}
                {tx('提交出价', 'Place Bid')}
              </Button>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {tx('关闭', 'Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ─── Main Auctions Page ─── */
export function Auctions() {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);

  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState('all');
  const [selectedAuction, setSelectedAuction] = useState<Auction | null>(null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  const filters = useMemo(() => {
    const f: { status?: string; type?: string; partNumber?: string; search?: string } = {};
    if (statusFilter) f.status = statusFilter;
    if (typeFilter) f.type = typeFilter;
    if (searchQuery) f.search = searchQuery;
    return f;
  }, [statusFilter, typeFilter, searchQuery]);

  const { data: auctions, loading, error, refetch } = useAuctions(filters);
  const auctionList = auctions || [];

  const filteredAuctions = useMemo(() => {
    let list = auctionList;
    if (activeTab !== 'all') {
      list = list.filter((a) => a.status === activeTab.toUpperCase());
    }
    return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [auctionList, activeTab]);

  const stats = useMemo(() => ({
    total: auctionList.length,
    active: auctionList.filter((a) => a.status === 'ACTIVE').length,
    closed: auctionList.filter((a) => a.status === 'CLOSED').length,
    cancelled: auctionList.filter((a) => a.status === 'CANCELLED').length,
  }), [auctionList]);

  const handleViewDetail = (auction: Auction) => {
    setSelectedAuction(auction);
    setIsDetailOpen(true);
  };

  const handleActivate = async (auction: Auction) => {
    try {
      await auctionApi.activate(auction.id);
      alert(tx('拍卖已激活', 'Auction activated'));
      void refetch();
    } catch {
      alert(tx('激活失败', 'Failed to activate auction'));
    }
  };

  const handleCancel = async (auction: Auction) => {
    if (!confirm(tx('确定要取消此拍卖吗？', 'Are you sure you want to cancel this auction?'))) return;
    try {
      await auctionApi.cancel(auction.id);
      alert(tx('拍卖已取消', 'Auction cancelled'));
      void refetch();
    } catch {
      alert(tx('取消失败', 'Failed to cancel auction'));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-8 h-8 animate-spin text-[#64b5f6]" />
        <span className="ml-2 text-gray-500">{tx('加载中...', 'Loading...')}</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-gray-500">{tx('拍卖总数', 'Total Auctions')}</p>
            <p className="text-2xl font-bold">{stats.total}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-gray-500">{tx('进行中', 'Active')}</p>
            <p className="text-2xl font-bold text-green-600">{stats.active}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-gray-500">{tx('已结束', 'Closed')}</p>
            <p className="text-2xl font-bold text-blue-600">{stats.closed}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-gray-500">{tx('已取消', 'Cancelled')}</p>
            <p className="text-2xl font-bold text-red-600">{stats.cancelled}</p>
          </CardContent>
        </Card>
      </div>

      {/* Error banner */}
      {error && (
        <div role="alert" className="flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-900 md:flex-row md:items-center md:justify-between">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0" />
            <div>
              <p className="font-medium">{tx('拍卖列表加载失败', 'Failed to load auctions')}</p>
              <p className="text-sm text-amber-800">{tx('当前显示的数据可能不是最新，请重试。', 'The list may be stale. Please retry.')}</p>
            </div>
          </div>
          <Button variant="outline" onClick={() => void refetch()}>
            {tx('重试刷新', 'Retry Refresh')}
          </Button>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex-1 min-w-[300px] flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <Input
              placeholder={tx('搜索件号或标题...', 'Search part number or title...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder={tx('状态', 'Status')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">{tx('全部状态', 'All Status')}</SelectItem>
              <SelectItem value="DRAFT">{tx('草稿', 'Draft')}</SelectItem>
              <SelectItem value="ACTIVE">{tx('进行中', 'Active')}</SelectItem>
              <SelectItem value="CLOSED">{tx('已结束', 'Closed')}</SelectItem>
              <SelectItem value="CANCELLED">{tx('已取消', 'Cancelled')}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder={tx('类型', 'Type')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">{tx('全部类型', 'All Types')}</SelectItem>
              <SelectItem value="SALES">{tx('销售拍卖', 'Sales')}</SelectItem>
              <SelectItem value="REVERSE">{tx('反向拍卖', 'Reverse')}</SelectItem>
              <SelectItem value="SEALED">{tx('密封拍卖', 'Sealed')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => { setStatusFilter(''); setTypeFilter(''); setSearchQuery(''); }}>
            <Filter className="w-4 h-4 mr-1" />
            {tx('重置', 'Reset')}
          </Button>
          <Button className="bg-[#64b5f6] hover:bg-[#42a5f5]" onClick={() => setIsCreateOpen(true)}>
            <Plus className="w-4 h-4 mr-1" />
            {tx('创建拍卖', 'Create Auction')}
          </Button>
        </div>
      </div>

      {/* Tabs & Table */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="all">{tx('全部', 'All')}</TabsTrigger>
          <TabsTrigger value="DRAFT">{tx('草稿', 'Draft')}</TabsTrigger>
          <TabsTrigger value="ACTIVE">{tx('进行中', 'Active')}</TabsTrigger>
          <TabsTrigger value="CLOSED">{tx('已结束', 'Closed')}</TabsTrigger>
          <TabsTrigger value="CANCELLED">{tx('已取消', 'Cancelled')}</TabsTrigger>
        </TabsList>

        <TabsContent value={activeTab} className="mt-4">
          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{tx('拍卖编号', 'Auction Number')}</TableHead>
                    <TableHead>{tx('标题', 'Title')}</TableHead>
                    <TableHead>{tx('类型', 'Type')}</TableHead>
                    <TableHead>{tx('状态', 'Status')}</TableHead>
                    <TableHead>{tx('件号', 'Part Number')}</TableHead>
                    <TableHead>{tx('当前出价', 'Current Bid')}</TableHead>
                    <TableHead>{tx('结束时间', 'Ends In')}</TableHead>
                    <TableHead>{tx('操作', 'Actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredAuctions.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center py-12 text-gray-500">
                        <Gavel className="w-16 h-16 mx-auto mb-4 text-gray-300" />
                        <p>{tx('未找到拍卖', 'No auctions found')}</p>
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredAuctions.map((auction) => {
                      const bidInfo = getCurrentBidDisplay(auction, locale);
                      return (
                        <TableRow key={auction.id} className="hover:bg-gray-50">
                          <TableCell className="font-mono font-medium">{auction.auctionNumber}</TableCell>
                          <TableCell>{auction.title}</TableCell>
                          <TableCell><AuctionTypeBadge type={auction.type} /></TableCell>
                          <TableCell><AuctionStatusBadge status={auction.status} /></TableCell>
                          <TableCell className="font-mono">{auction.partNumber}</TableCell>
                          <TableCell>
                            <div className="flex flex-col">
                              <span className={cn('font-semibold text-sm', bidInfo.color)}>{bidInfo.value}</span>
                              <span className="text-xs text-gray-400">{bidInfo.label}</span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              <Timer className="w-3 h-3 text-gray-400" />
                              <Countdown endAt={auction.endAt} />
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => handleViewDetail(auction)}
                              >
                                <Eye className="w-4 h-4" />
                              </Button>
                              {auction.status === 'DRAFT' && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  onClick={() => handleActivate(auction)}
                                >
                                  <Play className="w-4 h-4 text-green-600" />
                                </Button>
                              )}
                              {auction.status === 'ACTIVE' && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  onClick={() => handleCancel(auction)}
                                >
                                  <Ban className="w-4 h-4 text-red-600" />
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <AuctionDetailDialog
        auction={selectedAuction}
        isOpen={isDetailOpen}
        onClose={() => {
          setIsDetailOpen(false);
          setSelectedAuction(null);
        }}
        onBidPlaced={() => void refetch()}
      />

      <CreateAuctionDialog
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onCreated={() => void refetch()}
      />
    </div>
  );
}
