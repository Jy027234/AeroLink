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
    integrity?: {
      method: 'sha256_linked_records';
      storageScope: 'internal_database';
      externalTrustAnchor: false;
      decisionBoundary: string;
    };
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
          {tx('证书完整性校验', 'Certificate Integrity Check')}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {tx(
            '校验证书字段与同一业务库内的 SHA-256 关联记录是否一致；不构成第三方存证、独立不可篡改证明或最终适航依据。',
            'Checks whether certificate fields match linked SHA-256 records in the same business database. It is not third-party storage, independent immutability proof, or final airworthiness evidence.'
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
              {tx('校验完整性', 'Check Integrity')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {error && (
        <Card className="border-red-200 bg-red-50/30">
          <CardContent className="py-4 text-sm text-red-600">
            {tx('完整性校验失败', 'Integrity check failed')}: {error}
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
                      ? tx('完整性校验通过', 'Integrity Check Passed')
                      : tx('完整性校验不通过', 'Integrity Check Failed')}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {result.reason ||
                      tx(
                        '证书字段与内部关联哈希记录一致。',
                        'Certificate fields match the internal linked hash record.'
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
                  {tx('关联记录详情', 'Linked Record Details')}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground flex items-center gap-1">
                      <Hash className="w-3 h-3" />
                      {tx('记录索引', 'Record Index')}
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
                    {tx('关联记录哈希', 'Linked Record Hash')}
                  </div>
                  <div className="font-mono text-xs bg-gray-100 p-2 rounded break-all">
                    {result.block.hash}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground">
                      {tx('历史格式 Nonce', 'Legacy-format Nonce')}
                    </div>
                    <div className="font-mono">{result.block.nonce}</div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground">
                      {tx('哈希格式', 'Hash Format')}
                    </div>
                    <Badge variant="outline">SHA-256 linked record</Badge>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          <Card className="border-amber-200 bg-amber-50/30">
            <CardContent className="py-4 text-sm text-amber-800">
              {result.integrity?.decisionBoundary || tx(
                '此校验仅用于业务库内数据完整性核验，不构成第三方存证、独立不可篡改证明或最终适航依据。',
                'This check is limited to data integrity within the business database; it is not third-party storage, independent immutability proof, or final airworthiness evidence.'
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
