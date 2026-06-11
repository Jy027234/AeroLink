import { useState } from 'react';
import {
  Key,
  Plus,
  Copy,
  Trash2,
  CheckCircle,
  XCircle,
  Clock,
  Shield,
  Globe,
  Loader2,
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
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { useApiKeys, useCreateApiKey, useRevokeApiKey } from '@/hooks/useApi';

const scopeColors: Record<string, string> = {
  read: 'bg-blue-100 text-blue-700',
  write: 'bg-green-100 text-green-700',
  admin: 'bg-red-100 text-red-700',
};

export function ApiPlatform() {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyScopes, setNewKeyScopes] = useState<string[]>(['read']);
  const [newKeyRateLimit, setNewKeyRateLimit] = useState(1000);
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);

  const { data: keys, loading: keysLoading, error: keysError, refetch } = useApiKeys();
  const { mutate: createKey, loading: createLoading } = useCreateApiKey();
  const { mutate: revokeKey } = useRevokeApiKey();

  const handleCreate = async () => {
    if (!newKeyName.trim()) return;
    const res = await createKey({
      name: newKeyName.trim(),
      scopes: newKeyScopes,
      rateLimit: newKeyRateLimit,
    });
    if (res) {
      setNewlyCreatedKey(res.key || null);
      setNewKeyName('');
      setNewKeyScopes(['read']);
      setNewKeyRateLimit(1000);
      setIsCreateOpen(false);
      setShowKey(true);
      void refetch();
    }
  };

  const handleRevoke = async (id: string) => {
    const res = await revokeKey(id);
    if (res) {
      void refetch();
    }
  };

  const activeKeys = keys?.filter((k) => k.isActive) ?? [];
  const revokedKeys = keys?.filter((k) => !k.isActive) ?? [];
  const totalQuota = keys?.reduce((sum, k) => sum + k.rateLimit, 0) ?? 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{tx('API 开放平台', 'API Platform')}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {tx('管理 API Key、查看开放接口文档、集成第三方系统', 'Manage API Keys, view open API docs, integrate third-party systems')}
          </p>
        </div>
        <Button className="bg-brand-primary hover:bg-brand-primary-hover" onClick={() => setIsCreateOpen(true)}>
          <Plus className="w-4 h-4 mr-1" />
          {tx('新建 API Key', 'New API Key')}
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        <Card>
          <CardContent className="py-4">
            <div className="text-2xl font-bold">{keysLoading ? '-' : activeKeys.length}</div>
            <div className="text-xs text-muted-foreground">{tx('活跃 Key', 'Active Keys')}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <div className="text-2xl font-bold">{keysLoading ? '-' : revokedKeys.length}</div>
            <div className="text-xs text-muted-foreground">{tx('已撤销', 'Revoked')}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <div className="text-2xl font-bold">{keysLoading ? '-' : totalQuota.toLocaleString()}</div>
            <div className="text-xs text-muted-foreground">{tx('总请求配额/小时', 'Total Quota/Hour')}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <div className="text-2xl font-bold">8</div>
            <div className="text-xs text-muted-foreground">{tx('开放接口', 'Open Endpoints')}</div>
          </CardContent>
        </Card>
      </div>

      {/* API Key List */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Key className="w-5 h-5 text-brand-primary" />
            {tx('API Key 管理', 'API Key Management')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {keysLoading ? (
            <div className="flex items-center justify-center h-48">
              <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
            </div>
          ) : keysError ? (
            <p className="text-sm text-red-500">{keysError}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tx('名称', 'Name')}</TableHead>
                  <TableHead>{tx('Key', 'Key')}</TableHead>
                  <TableHead>{tx('权限', 'Scopes')}</TableHead>
                  <TableHead>{tx('限流', 'Rate Limit')}</TableHead>
                  <TableHead>{tx('状态', 'Status')}</TableHead>
                  <TableHead>{tx('最后使用', 'Last Used')}</TableHead>
                  <TableHead>{tx('操作', 'Actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys?.map((key) => (
                  <TableRow key={key.id}>
                    <TableCell className="font-medium">{key.name}</TableCell>
                    <TableCell>
                      <code className="text-xs bg-gray-100 px-2 py-1 rounded font-mono">
                        {key.keyPrefix}
                      </code>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        {key.scopes?.map((s) => (
                          <Badge key={s} className={cn('text-xs', scopeColors[s] || 'bg-gray-100')}>
                            {s}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>{key.rateLimit.toLocaleString()}/h</TableCell>
                    <TableCell>
                      {key.isActive ? (
                        <Badge className="bg-green-100 text-green-700 border-0">
                          <CheckCircle className="w-3 h-3 mr-1" />
                          Active
                        </Badge>
                      ) : (
                        <Badge className="bg-gray-100 text-gray-700 border-0">
                          <XCircle className="w-3 h-3 mr-1" />
                          Revoked
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {key.lastUsedAt ? (
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Clock className="w-3 h-3" />
                          {new Date(key.lastUsedAt).toLocaleDateString()}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        {key.isActive && (
                          <Button size="sm" variant="ghost" onClick={() => handleRevoke(key.id)}>
                            <Trash2 className="w-3 h-3 text-red-500" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                )) ?? []}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* API Documentation */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Globe className="w-5 h-5 text-brand-primary" />
            {tx('开放 API 文档', 'Open API Documentation')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="bg-gray-50 rounded-lg p-4 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Shield className="w-4 h-4 text-green-500" />
              {tx('认证方式', 'Authentication')}
            </div>
            <p className="text-xs text-muted-foreground">
              {tx('所有 API 请求需要在 Header 中携带 X-API-Key', 'All API requests must include X-API-Key in the header')}
            </p>
            <code className="block text-xs bg-gray-900 text-green-400 p-3 rounded font-mono">
              curl -H "X-API-Key: ak_live_xxxxxxxx" https://api.aerolink.com/api/v1/health
            </code>
          </div>

          <div className="space-y-2">
            <div className="text-sm font-medium">{tx('可用接口', 'Available Endpoints')}</div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              {[
                { method: 'GET', path: '/api/v1/health', desc: 'Health Check' },
                { method: 'GET', path: '/api/v1/rfqs', desc: 'List RFQs' },
                { method: 'GET', path: '/api/v1/quotations', desc: 'List Quotations' },
                { method: 'GET', path: '/api/v1/orders', desc: 'List Orders' },
                { method: 'GET', path: '/api/v1/inventory', desc: 'List Inventory' },
                { method: 'GET', path: '/api/v1/customers', desc: 'List Customers' },
                { method: 'GET', path: '/api/v1/suppliers', desc: 'List Suppliers' },
                { method: 'GET', path: '/api/v1/certificates', desc: 'List Certificates' },
                { method: 'GET', path: '/api/v1/auctions', desc: 'List Auctions' },
                { method: 'GET', path: '/api/v1/pricing/recommendation', desc: 'Price Recommendation' },
              ].map((ep) => (
                <div key={ep.path} className="flex items-center gap-2 p-2 bg-gray-50 rounded">
                  <Badge className={cn(
                    'text-xs',
                    ep.method === 'GET' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
                  )}>
                    {ep.method}
                  </Badge>
                  <span className="font-mono text-gray-600">{ep.path}</span>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Create Dialog */}
      <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{tx('新建 API Key', 'Create API Key')}</DialogTitle>
            <DialogDescription className="sr-only">{tx('创建新的API密钥', 'Create a new API key')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>{tx('名称 *', 'Name *')}</Label>
              <Input
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder={tx('例如：ERP 集成', 'e.g. ERP Integration')}
              />
            </div>
            <div className="space-y-2">
              <Label>{tx('权限范围', 'Scopes')}</Label>
              <div className="flex gap-4">
                {['read', 'write', 'admin'].map((scope) => (
                  <label key={scope} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={newKeyScopes.includes(scope)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setNewKeyScopes([...newKeyScopes, scope]);
                        } else {
                          setNewKeyScopes(newKeyScopes.filter((s) => s !== scope));
                        }
                      }}
                    />
                    <Badge className={scopeColors[scope]}>{scope}</Badge>
                  </label>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label>{tx('请求限流（/小时）', 'Rate Limit (/hour)')}</Label>
              <Input
                type="number"
                min={100}
                max={50000}
                value={newKeyRateLimit}
                onChange={(e) => setNewKeyRateLimit(parseInt(e.target.value) || 1000)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateOpen(false)}>
              {tx('取消', 'Cancel')}
            </Button>
            <Button
              className="bg-brand-primary hover:bg-brand-primary-hover"
              onClick={handleCreate}
              disabled={createLoading}
            >
              {createLoading ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
              {tx('创建', 'Create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Show Newly Created Key */}
      {newlyCreatedKey && showKey && (
        <Dialog open={showKey} onOpenChange={setShowKey}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-green-600">
                <CheckCircle className="w-5 h-5" />
                {tx('API Key 创建成功', 'API Key Created')}
              </DialogTitle>
              <DialogDescription className="sr-only">{tx('新创建的API密钥信息', 'Newly created API key info')}</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                <p className="text-sm text-yellow-800 mb-2">
                  {tx('请立即复制并保存此 Key，它只会显示一次！', 'Please copy and save this key immediately. It will only be shown once!')}
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-sm bg-gray-900 text-green-400 p-3 rounded font-mono break-all">
                    {newlyCreatedKey}
                  </code>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      navigator.clipboard.writeText(newlyCreatedKey);
                    }}
                  >
                    <Copy className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={() => { setShowKey(false); setNewlyCreatedKey(null); }}>
                {tx('我已保存', 'I have saved it')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
