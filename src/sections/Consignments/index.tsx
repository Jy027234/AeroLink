import { useState } from 'react';
import {
  Search,
  Plus,
  Package,
  AlertTriangle,
  CheckCircle,
  Clock,
  Eye,
  Edit3,
  Loader2,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { useConsignments, useConsignmentStats, useCreateConsignment } from '@/hooks/useApi';

export function Consignments() {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  const { data: consignments, loading: listLoading, error: listError } = useConsignments();
  const { data: stats, loading: statsLoading, error: statsError } = useConsignmentStats();
  const { mutate: createConsignment, loading: createLoading } = useCreateConsignment();

  const filtered = consignments?.filter((c) => {
    const matchesSearch =
      !searchQuery ||
      c.agreementNumber.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.partNumber.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.supplierName.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === 'all' || c.status === statusFilter;
    return matchesSearch && matchesStatus;
  }) ?? [];

  const statusConfig: Record<string, { label: string; color: string; bgColor: string; icon: React.ElementType }> = {
    ACTIVE: { label: 'Active', color: 'text-green-600', bgColor: 'bg-green-50', icon: CheckCircle },
    EXPIRED: { label: 'Expired', color: 'text-red-600', bgColor: 'bg-red-50', icon: AlertTriangle },
    TERMINATED: { label: 'Terminated', color: 'text-gray-600', bgColor: 'bg-gray-50', icon: Trash2 },
    SETTLING: { label: 'Settling', color: 'text-yellow-600', bgColor: 'bg-yellow-50', icon: Clock },
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{tx('寄售管理', 'Consignment Management')}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {tx('管理寄售协议、跟踪库存消耗、自动结算', 'Manage consignment agreements, track inventory consumption, auto-settlement')}
          </p>
        </div>
        <Button className="bg-brand-primary hover:bg-brand-primary-hover" onClick={() => setIsCreateOpen(true)}>
          <Plus className="w-4 h-4 mr-1" />
          {tx('新建寄售协议', 'New Consignment')}
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        {statsLoading ? (
          <>
            <LoadingStatCard />
            <LoadingStatCard />
            <LoadingStatCard />
            <LoadingStatCard />
          </>
        ) : statsError ? (
          <Card className="col-span-4">
            <CardContent className="py-4 text-sm text-red-500">{statsError}</CardContent>
          </Card>
        ) : stats ? (
          <>
            <Card>
              <CardContent className="py-4">
                <div className="text-2xl font-bold">{stats.activeCount}</div>
                <div className="text-xs text-muted-foreground">{tx('活跃协议', 'Active Agreements')}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="py-4">
                <div className="text-2xl font-bold text-yellow-600">{stats.stockAlertCount}</div>
                <div className="text-xs text-muted-foreground">{tx('库存预警', 'Stock Alerts')}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="py-4">
                <div className="text-2xl font-bold text-red-600">{stats.expiringSoonCount}</div>
                <div className="text-xs text-muted-foreground">{tx('即将到期', 'Expiring Soon')}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="py-4">
                <div className="text-2xl font-bold">{stats.totalConsumed}</div>
                <div className="text-xs text-muted-foreground">{tx('累计消耗', 'Total Consumed')}</div>
              </CardContent>
            </Card>
          </>
        ) : null}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <Input
            className="pl-9"
            placeholder={tx('搜索协议号、件号、供应商', 'Search agreement, part number, supplier...')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v)}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder={tx('全部状态', 'All Status')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{tx('全部状态', 'All Status')}</SelectItem>
            <SelectItem value="ACTIVE">{tx('活跃', 'Active')}</SelectItem>
            <SelectItem value="EXPIRED">{tx('已到期', 'Expired')}</SelectItem>
            <SelectItem value="TERMINATED">{tx('已终止', 'Terminated')}</SelectItem>
            <SelectItem value="SETTLING">{tx('结算中', 'Settling')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <Card>
        {listLoading ? (
          <div className="flex items-center justify-center h-48">
            <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
          </div>
        ) : listError ? (
          <div className="p-4 text-sm text-red-500">{listError}</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tx('协议号', 'Agreement')}</TableHead>
                <TableHead>{tx('件号', 'Part Number')}</TableHead>
                <TableHead>{tx('供应商', 'Supplier')}</TableHead>
                <TableHead>{tx('库存', 'Stock')}</TableHead>
                <TableHead>{tx('消耗', 'Consumed')}</TableHead>
                <TableHead>{tx('到期日', 'End Date')}</TableHead>
                <TableHead>{tx('状态', 'Status')}</TableHead>
                <TableHead>{tx('操作', 'Actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((item) => {
                const status = statusConfig[item.status];
                const StatusIcon = status.icon;
                const isLowStock = item.status === 'ACTIVE' && item.currentQuantity <= item.minStockLevel;
                const isExpiring = item.status === 'ACTIVE' && new Date(item.endDate) < new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

                return (
                  <TableRow key={item.id}>
                    <TableCell className="font-mono text-xs">{item.agreementNumber}</TableCell>
                    <TableCell className="font-mono text-xs">{item.partNumber}</TableCell>
                    <TableCell>{item.supplierName}</TableCell>
                    <TableCell>
                      <div className={cn('flex items-center gap-1', isLowStock && 'text-red-600')}>
                        <Package className="w-3 h-3" />
                        {item.currentQuantity} / {item.quantity}
                        {isLowStock && <AlertTriangle className="w-3 h-3 text-red-500" />}
                      </div>
                    </TableCell>
                    <TableCell>{item.consumedQuantity}</TableCell>
                    <TableCell>
                      <div className={cn('flex items-center gap-1', isExpiring && 'text-yellow-600')}>
                        <Clock className="w-3 h-3" />
                        {item.endDate}
                        {isExpiring && <AlertTriangle className="w-3 h-3 text-yellow-500" />}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge className={cn(status.bgColor, status.color, 'border-0')}>
                        <StatusIcon className="w-3 h-3 mr-1" />
                        {status.label}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button size="sm" variant="ghost">
                          <Eye className="w-3 h-3" />
                        </Button>
                        <Button size="sm" variant="ghost">
                          <Edit3 className="w-3 h-3" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Create Dialog */}
      <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{tx('新建寄售协议', 'New Consignment Agreement')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>{tx('标题 *', 'Title *')}</Label>
              <Input placeholder={tx('输入协议标题', 'Enter agreement title')} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{tx('供应商 *', 'Supplier *')}</Label>
                <Input placeholder={tx('供应商名称', 'Supplier name')} />
              </div>
              <div className="space-y-2">
                <Label>{tx('件号 *', 'Part Number *')}</Label>
                <Input placeholder={tx('件号', 'Part number')} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{tx('数量 *', 'Quantity *')}</Label>
                <Input type="number" min={1} defaultValue={1} />
              </div>
              <div className="space-y-2">
                <Label>{tx('最低库存', 'Min Stock')}</Label>
                <Input type="number" min={0} defaultValue={0} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>{tx('到期日 *', 'End Date *')}</Label>
              <Input type="date" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateOpen(false)}>
              {tx('取消', 'Cancel')}
            </Button>
            <Button className="bg-brand-primary hover:bg-brand-primary-hover" disabled={createLoading}>
              {createLoading ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
              {tx('创建', 'Create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function LoadingStatCard() {
  return (
    <Card>
      <CardContent className="py-4 flex items-center justify-center h-16">
        <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
      </CardContent>
    </Card>
  );
}

function Trash2(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </svg>
  );
}
