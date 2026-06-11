import { useState } from 'react';
import {
  Shield,
  Search,
  CheckCircle,
  XCircle,
  Link,
  Hash,
  Clock,
  Loader2,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { useBlockchainVerify } from '@/hooks/useApi';

export function BlockchainVerification() {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const [certificateId, setCertificateId] = useState('');
  const [result, setResult] = useState<{
    verified: boolean;
    block?: {
      index: number;
      timestamp: string;
      certificateId: string;
      certificateHash: string;
      previousHash: string;
      hash: string;
      nonce: number;
    };
    certificateHash?: string;
    reason?: string;
  } | null>(null);

  const { mutate: verify, loading, error } = useBlockchainVerify();

  const handleVerify = async () => {
    if (!certificateId.trim()) return;
    const res = await verify(certificateId.trim());
    if (res) {
      setResult(res);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Shield className="w-7 h-7 text-brand-primary" />
          {tx('区块链证书存证', 'Blockchain Certificate Storage')}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {tx(
            '基于 SHA-256 哈希链的证书存证系统，确保证书数据不可篡改',
            'SHA-256 hash chain based certificate storage system ensuring data immutability'
          )}
        </p>
      </div>

      {/* Search */}
      <Card>
        <CardContent className="py-6">
          <div className="flex items-end gap-4">
            <div className="flex-1 space-y-2">
              <div className="text-sm font-medium">
                {tx('证书 ID *', 'Certificate ID *')}
              </div>
              <Input
                value={certificateId}
                onChange={(e) => setCertificateId(e.target.value)}
                placeholder={tx('输入证书 ID', 'Enter certificate ID')}
              />
            </div>
            <Button
              className="bg-brand-primary hover:bg-brand-primary-hover h-10"
              onClick={handleVerify}
              disabled={loading}
            >
              {loading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Search className="w-4 h-4" />
              )}
              {tx('验证存证', 'Verify Storage')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {error && (
        <Card className="border-red-200 bg-red-50/30">
          <CardContent className="py-4 text-sm text-red-600">
            {tx('验证失败', 'Verification failed')}: {error}
          </CardContent>
        </Card>
      )}

      {/* Result */}
      {result && (
        <div className="space-y-4">
          {/* Status Card */}
          <Card
            className={cn(
              'border-2',
              result.verified
                ? 'border-green-200 bg-green-50/30'
                : 'border-red-200 bg-red-50/30'
            )}
          >
            <CardContent className="py-6">
              <div className="flex items-center gap-4">
                {result.verified ? (
                  <CheckCircle className="w-12 h-12 text-green-500" />
                ) : (
                  <XCircle className="w-12 h-12 text-red-500" />
                )}
                <div>
                  <div className="text-lg font-bold">
                    {result.verified
                      ? tx('存证验证通过', 'Verification Passed')
                      : tx('存证验证失败', 'Verification Failed')}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {result.reason ||
                      tx(
                        '证书数据完整，未被篡改',
                        'Certificate data is intact and untampered'
                      )}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Block Details */}
          {result.block && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Link className="w-5 h-5 text-brand-primary" />
                  {tx('区块详情', 'Block Details')}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground flex items-center gap-1">
                      <Hash className="w-3 h-3" />
                      {tx('区块索引', 'Block Index')}
                    </div>
                    <div className="font-mono font-medium">
                      #{result.block.index}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {tx('时间戳', 'Timestamp')}
                    </div>
                    <div className="font-mono text-sm">
                      {new Date(result.block.timestamp).toLocaleString(
                        locale === 'zh-CN' ? 'zh-CN' : 'en-US'
                      )}
                    </div>
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">
                    {tx('证书哈希', 'Certificate Hash')}
                  </div>
                  <div className="font-mono text-xs bg-gray-100 p-2 rounded break-all">
                    {result.block.certificateHash}
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">
                    {tx('前序哈希', 'Previous Hash')}
                  </div>
                  <div className="font-mono text-xs bg-gray-100 p-2 rounded break-all">
                    {result.block.previousHash}
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">
                    {tx('区块哈希', 'Block Hash')}
                  </div>
                  <div className="font-mono text-xs bg-gray-100 p-2 rounded break-all">
                    {result.block.hash}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground">
                      {tx('Nonce', 'Nonce')}
                    </div>
                    <div className="font-mono">{result.block.nonce}</div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground">
                      {tx('难度', 'Difficulty')}
                    </div>
                    <Badge variant="outline">4 leading zeros</Badge>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
