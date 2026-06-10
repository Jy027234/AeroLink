import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Eye,
  Download,
  Search,
  Calendar,
  Activity,
  AlertTriangle,
  User,
  Layers,
  ChevronLeft,
  ChevronRight,
  Loader2,
  X,
  FileJson,
  Monitor,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { useTranslation } from '@/i18n';
import { auditLogApi, type AuditLogItem, type AuditLogStats } from '@/api/client';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

const ACTION_OPTIONS = ['CREATE', 'UPDATE', 'DELETE', 'VIEW', 'LOGIN', 'LOGOUT', 'EXPORT', 'APPROVE', 'REJECT'];
const RESOURCE_OPTIONS = ['RFQ', 'QUOTATION', 'ORDER', 'INVENTORY', 'CUSTOMER', 'SUPPLIER', 'CERTIFICATE', 'SETTINGS', 'WORKFLOW'];
const STATUS_OPTIONS = ['SUCCESS', 'FAILURE'];

const actionColorMap: Record<string, { bg: string; text: string }> = {
  CREATE: { bg: 'bg-green-50', text: 'text-green-700' },
  UPDATE: { bg: 'bg-blue-50', text: 'text-blue-700' },
  DELETE: { bg: 'bg-red-50', text: 'text-red-700' },
  VIEW: { bg: 'bg-gray-50', text: 'text-gray-700' },
  LOGIN: { bg: 'bg-purple-50', text: 'text-purple-700' },
  LOGOUT: { bg: 'bg-gray-50', text: 'text-gray-700' },
  EXPORT: { bg: 'bg-yellow-50', text: 'text-yellow-700' },
  APPROVE: { bg: 'bg-emerald-50', text: 'text-emerald-700' },
  REJECT: { bg: 'bg-orange-50', text: 'text-orange-700' },
};

const actionLabelMap: Record<string, { zh: string; en: string }> = {
  CREATE: { zh: '创建', en: 'Create' },
  UPDATE: { zh: '更新', en: 'Update' },
  DELETE: { zh: '删除', en: 'Delete' },
  VIEW: { zh: '查看', en: 'View' },
  LOGIN: { zh: '登录', en: 'Login' },
  LOGOUT: { zh: '登出', en: 'Logout' },
  EXPORT: { zh: '导出', en: 'Export' },
  APPROVE: { zh: '批准', en: 'Approve' },
  REJECT: { zh: '拒绝', en: 'Reject' },
};

function ActionBadge({ action }: { action: string }) {
  const { locale } = useTranslation();
  const config = actionColorMap[action] || { bg: 'bg-gray-50', text: 'text-gray-700' };
  const label = actionLabelMap[action];
  return (
    <Badge variant="outline" className={cn(config.bg, config.text, 'border-0 font-medium')}>
      {label ? (locale === 'zh-CN' ? label.zh : label.en) : action}
    </Badge>
  );
}

function StatusBadge({ status }: { status: string }) {
  const { locale } = useTranslation();
  const isSuccess = status === 'SUCCESS';
  const label = isSuccess
    ? (locale === 'zh-CN' ? '成功' : 'SUCCESS')
    : (locale === 'zh-CN' ? '失败' : 'FAILURE');
  return (
    <Badge variant="outline" className={cn(isSuccess ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700', 'border-0')}>
      {label}
    </Badge>
  );
}

function DiffView({ changesJson }: { changesJson?: string | null }) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);

  if (!changesJson) return <p className="text-sm text-muted-foreground">{tx('无变更记录', 'No changes recorded')}</p>;

  let changes: Record<string, { before: unknown; after: unknown }> | null = null;
  try {
    changes = JSON.parse(changesJson);
  } catch {
    return <pre className="text-xs bg-muted p-2 rounded">{changesJson}</pre>;
  }

  if (!changes || Object.keys(changes).length === 0) {
    return <p className="text-sm text-muted-foreground">{tx('无变更记录', 'No changes recorded')}</p>;
  }

  return (
    <div className="space-y-2">
      {Object.entries(changes).map(([field, diff]) => (
        <div key={field} className="border rounded-md overflow-hidden">
          <div className="bg-muted px-3 py-1 text-xs font-medium">{field}</div>
          <div className="grid grid-cols-2 divide-x text-sm">
            <div className="p-2 bg-red-50">
              <div className="text-xs text-red-500 mb-1">{tx('变更前', 'Before')}</div>
              <div className="text-red-700 break-all">{JSON.stringify(diff.before)}</div>
            </div>
            <div className="p-2 bg-green-50">
              <div className="text-xs text-green-500 mb-1">{tx('变更后', 'After')}</div>
              <div className="text-green-700 break-all">{JSON.stringify(diff.after)}</div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function AuditLogs() {
  const { locale } = useTranslation();
  const tx = useCallback((zh: string, en: string) => (locale === 'zh-CN' ? zh : en), [locale]);

  const [logs, setLogs] = useState<AuditLogItem[]>([]);
  const [stats, setStats] = useState<AuditLogStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [limit] = useState(20);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  const [filters, setFilters] = useState({
    action: '',
    resourceType: '',
    status: '',
    userId: '',
    startDate: '',
    endDate: '',
    search: '',
  });

  const [detailLog, setDetailLog] = useState<AuditLogItem | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [logsRes, statsRes] = await Promise.all([
        auditLogApi.getAll({
          page,
          limit,
          ...(filters.action ? { action: filters.action } : {}),
          ...(filters.resourceType ? { resourceType: filters.resourceType } : {}),
          ...(filters.status ? { status: filters.status } : {}),
          ...(filters.userId ? { userId: filters.userId } : {}),
          ...(filters.startDate ? { startDate: filters.startDate } : {}),
          ...(filters.endDate ? { endDate: filters.endDate } : {}),
          ...(filters.search ? { search: filters.search } : {}),
        }),
        auditLogApi.getStats(),
      ]);
      setLogs(logsRes.data);
      setTotal(logsRes.pagination.total);
      setTotalPages(logsRes.pagination.totalPages);
      setStats(statsRes);
    } catch (err) {
      toast.error(tx('加载审计日志失败', 'Failed to load audit logs'));
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [page, limit, filters, tx]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleFilterChange = (key: string, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPage(1);
  };

  const clearFilters = () => {
    setFilters({
      action: '',
      resourceType: '',
      status: '',
      userId: '',
      startDate: '',
      endDate: '',
      search: '',
    });
    setPage(1);
  };

  const hasFilters = useMemo(
    () => Object.values(filters).some((v) => v !== ''),
    [filters]
  );

  const openDetail = (log: AuditLogItem) => {
    setDetailLog(log);
    setDetailOpen(true);
  };

  const exportCsv = () => {
    const headers = [tx('时间', 'Timestamp'), tx('用户', 'User'), tx('操作', 'Action'), tx('资源类型', 'Resource Type'), tx('资源ID', 'Resource ID'), tx('资源名称', 'Resource Name'), tx('状态', 'Status'), tx('IP地址', 'IP Address'), tx('详情', 'Details')];
    const rows = logs.map((log) => [
      log.createdAt,
      log.userName || tx('系统', 'System'),
      log.action,
      log.resourceType,
      log.resourceId || '',
      log.resourceName || '',
      log.status,
      log.ipAddress || '',
      log.details || '',
    ]);

    const csv = [headers.join(','), ...rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    toast.success(tx('导出成功', 'Export successful'));
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US');
  };

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{tx('审计日志', 'Audit Logs')}</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {tx('追踪系统所有关键操作与变更记录', 'Track all critical system operations and changes')}
          </p>
        </div>
        <Button variant="outline" onClick={exportCsv}>
          <Download className="w-4 h-4 mr-2" />
          {tx('导出 CSV', 'Export CSV')}
        </Button>
      </div>

      {/* Statistics Cards */}
      {stats && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <Activity className="w-4 h-4" />
                {tx('今日操作总数', 'Actions Today')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.totalToday}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-red-500" />
                {tx('今日失败操作', 'Failed Today')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className={cn('text-2xl font-bold', stats.failedToday > 0 ? 'text-red-600' : '')}>
                {stats.failedToday}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <User className="w-4 h-4" />
                {tx('本周活跃用户', 'Top Users (7d)')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.topUsers.length}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {stats.topUsers.slice(0, 3).map((u) => u.userName || tx('系统', 'System')).join(', ')}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <Layers className="w-4 h-4" />
                {tx('本周热门资源', 'Top Resources (7d)')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.topResourceTypes.length}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {stats.topResourceTypes.slice(0, 3).map((r) => r.resourceType).join(', ')}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap gap-3 items-end">
            <div className="flex-1 min-w-[200px]">
              <Label className="text-xs mb-1.5 block">{tx('搜索', 'Search')}</Label>
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder={tx('用户、资源名称、资源ID、详情...', 'User, resource name, ID, details...')}
                  className="pl-9"
                  value={filters.search}
                  onChange={(e) => handleFilterChange('search', e.target.value)}
                />
              </div>
            </div>
            <div className="w-[160px]">
              <Label className="text-xs mb-1.5 block">{tx('操作类型', 'Action')}</Label>
              <Select value={filters.action} onValueChange={(v) => handleFilterChange('action', v)}>
                <SelectTrigger>
                  <SelectValue placeholder={tx('全部', 'All')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">{tx('全部', 'All')}</SelectItem>
                  {ACTION_OPTIONS.map((a) => (
                    <SelectItem key={a} value={a}>{a}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-[160px]">
              <Label className="text-xs mb-1.5 block">{tx('资源类型', 'Resource Type')}</Label>
              <Select value={filters.resourceType} onValueChange={(v) => handleFilterChange('resourceType', v)}>
                <SelectTrigger>
                  <SelectValue placeholder={tx('全部', 'All')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">{tx('全部', 'All')}</SelectItem>
                  {RESOURCE_OPTIONS.map((r) => (
                    <SelectItem key={r} value={r}>{r}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-[140px]">
              <Label className="text-xs mb-1.5 block">{tx('状态', 'Status')}</Label>
              <Select value={filters.status} onValueChange={(v) => handleFilterChange('status', v)}>
                <SelectTrigger>
                  <SelectValue placeholder={tx('全部', 'All')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">{tx('全部', 'All')}</SelectItem>
                  {STATUS_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-[180px]">
              <Label className="text-xs mb-1.5 block">{tx('用户ID', 'User ID')}</Label>
              <Input
                placeholder={tx('输入用户ID', 'Enter user ID')}
                value={filters.userId}
                onChange={(e) => handleFilterChange('userId', e.target.value)}
              />
            </div>
            <div className="w-[160px]">
              <Label className="text-xs mb-1.5 block">{tx('开始日期', 'Start Date')}</Label>
              <div className="relative">
                <Calendar className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  type="date"
                  className="pl-9"
                  value={filters.startDate}
                  onChange={(e) => handleFilterChange('startDate', e.target.value)}
                />
              </div>
            </div>
            <div className="w-[160px]">
              <Label className="text-xs mb-1.5 block">{tx('结束日期', 'End Date')}</Label>
              <div className="relative">
                <Calendar className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  type="date"
                  className="pl-9"
                  value={filters.endDate}
                  onChange={(e) => handleFilterChange('endDate', e.target.value)}
                />
              </div>
            </div>
            {hasFilters && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                <X className="w-4 h-4 mr-1" />
                {tx('清除', 'Clear')}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardContent className="pt-6">
          {loading && logs.length === 0 ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[180px]">{tx('时间', 'Timestamp')}</TableHead>
                      <TableHead>{tx('用户', 'User')}</TableHead>
                      <TableHead>{tx('操作', 'Action')}</TableHead>
                      <TableHead>{tx('资源类型', 'Resource Type')}</TableHead>
                      <TableHead>{tx('资源名称', 'Resource Name')}</TableHead>
                      <TableHead>{tx('状态', 'Status')}</TableHead>
                      <TableHead>{tx('IP 地址', 'IP Address')}</TableHead>
                      <TableHead className="text-right">{tx('操作', 'Actions')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {logs.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                          {tx('暂无审计日志', 'No audit logs found')}
                        </TableCell>
                      </TableRow>
                    ) : (
                      logs.map((log) => (
                        <TableRow key={log.id} className="cursor-pointer hover:bg-muted/50" onClick={() => openDetail(log)}>
                          <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                            {formatDate(log.createdAt)}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <User className="w-3.5 h-3.5 text-muted-foreground" />
                              <span className="text-sm">{log.userName || tx('系统', 'System')}</span>
                              {log.userRole && (
                                <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                                  {log.userRole}
                                </span>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            <ActionBadge action={log.action} />
                          </TableCell>
                          <TableCell className="text-sm">{log.resourceType}</TableCell>
                          <TableCell className="text-sm max-w-[200px] truncate" title={log.resourceName || ''}>
                            {log.resourceName || log.resourceId || '-'}
                          </TableCell>
                          <TableCell>
                            <StatusBadge status={log.status} />
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground font-mono">
                            {log.ipAddress || '-'}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); openDetail(log); }}>
                              <Eye className="w-4 h-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between mt-4">
                  <div className="text-sm text-muted-foreground">
                    {tx('共 {total} 条记录', 'Total {total} records').replace('{total}', String(total))}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={page === 1}
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </Button>
                    <span className="text-sm text-muted-foreground">
                      {page} / {totalPages}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      disabled={page === totalPages}
                    >
                      <ChevronRight className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Detail Dialog */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileJson className="w-5 h-5" />
              {tx('审计日志详情', 'Audit Log Detail')}
            </DialogTitle>
          </DialogHeader>
          <ScrollArea className="flex-1 pr-4">
            {detailLog && (
              <div className="space-y-6">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label className="text-xs text-muted-foreground">{tx('ID', 'ID')}</Label>
                    <div className="text-sm font-mono break-all">{detailLog.id}</div>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">{tx('时间', 'Timestamp')}</Label>
                    <div className="text-sm">{formatDate(detailLog.createdAt)}</div>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">{tx('用户', 'User')}</Label>
                    <div className="text-sm">{detailLog.userName || tx('系统', 'System')}</div>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">{tx('用户角色', 'User Role')}</Label>
                    <div className="text-sm">{detailLog.userRole || '-'}</div>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">{tx('操作', 'Action')}</Label>
                    <div className="mt-1">
                      <ActionBadge action={detailLog.action} />
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">{tx('状态', 'Status')}</Label>
                    <div className="mt-1">
                      <StatusBadge status={detailLog.status} />
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">{tx('资源类型', 'Resource Type')}</Label>
                    <div className="text-sm">{detailLog.resourceType}</div>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">{tx('资源ID', 'Resource ID')}</Label>
                    <div className="text-sm font-mono break-all">{detailLog.resourceId || '-'}</div>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">{tx('资源名称', 'Resource Name')}</Label>
                    <div className="text-sm">{detailLog.resourceName || '-'}</div>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">{tx('IP 地址', 'IP Address')}</Label>
                    <div className="text-sm font-mono">{detailLog.ipAddress || '-'}</div>
                  </div>
                </div>

                <Separator />

                <div>
                  <Label className="text-xs text-muted-foreground flex items-center gap-1">
                    <Monitor className="w-3 h-3" />
                    {tx('User Agent', 'User Agent')}
                  </Label>
                  <div className="text-xs text-muted-foreground bg-muted p-2 rounded mt-1 break-all">
                    {detailLog.userAgent || '-'}
                  </div>
                </div>

                {detailLog.details && (
                  <div>
                    <Label className="text-xs text-muted-foreground">{tx('详情', 'Details')}</Label>
                    <div className="text-sm bg-muted p-2 rounded mt-1">{detailLog.details}</div>
                  </div>
                )}

                {detailLog.errorMessage && (
                  <div>
                    <Label className="text-xs text-muted-foreground text-red-500">{tx('错误信息', 'Error Message')}</Label>
                    <div className="text-sm bg-red-50 text-red-700 p-2 rounded mt-1">{detailLog.errorMessage}</div>
                  </div>
                )}

                <div>
                  <Label className="text-xs text-muted-foreground mb-2 block">{tx('变更对比', 'Changes Diff')}</Label>
                  <DiffView changesJson={detailLog.changes} />
                </div>
              </div>
            )}
          </ScrollArea>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetailOpen(false)}>
              {tx('关闭', 'Close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
