import { useState } from 'react';
import {
  Search,
  Plane,
  FileText,
  AlertTriangle,
  CheckCircle,
  XCircle,
  ArrowRightLeft,
  RefreshCw,
  Info,
  Wrench,
  BookOpen,
  Loader2,
  Inbox,
} from 'lucide-react';
import { useTranslation } from '@/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useIPCSearch, useCheckCompatibility } from '@/hooks/useApi';
import { Alert, AlertDescription } from '@/components/ui/alert';

export function TechnicalKit() {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const [showBetaAlert] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [aircraftType, setAircraftType] = useState('');
  const [msn, setMsn] = useState('');
  const [selectedIPC, setSelectedIPC] = useState<{
    id: string;
    partNumber: string;
    description: string;
    ataChapter: string;
    aircraftTypes: string[];
    supersededBy?: string;
    interchangeableWith: string[];
    alternateParts: string[];
    sbList?: Array<{ sbNumber: string; title: string; applicability: string[]; mandatory: boolean }>;
  } | null>(null);
  const [isCompatibilityOpen, setIsCompatibilityOpen] = useState(false);
  const [compatibilityResult, setCompatibilityResult] = useState<{
    isCompatible: boolean;
    warnings: string[];
    sbRequirements: string[];
  } | null>(null);

  const { data: searchResults, loading: searchLoading, error: searchError } = useIPCSearch(searchQuery);
  const { mutate: checkCompatibility, loading: checkLoading, error: checkError } = useCheckCompatibility();

  const handleCheckCompatibility = async () => {
    if (!selectedIPC || !aircraftType) return;
    const res = await checkCompatibility({
      partNumber: selectedIPC.partNumber,
      aircraftType,
      msn: msn || undefined,
    });
    if (res) {
      setCompatibilityResult(res);
      setIsCompatibilityOpen(true);
    }
  };

  return (
    <div className="space-y-6">
      {showBetaAlert && (
        <Alert className="bg-amber-50 border-amber-200 text-amber-800">
          <AlertTriangle className="w-4 h-4 text-amber-600" />
          <AlertDescription>
            {tx('本模块为演示版本，数据仅供展示，刷新后可能丢失。', 'This module is in demo mode. Data is for display only and may be lost after refresh.')}
          </AlertDescription>
        </Alert>
      )}
      {/* Search area */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <BookOpen className="w-5 h-5 text-brand-primary" />
            {tx('IPC数据检索', 'IPC Data Search')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-4">
            <div className="flex-1">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <Input
                  placeholder={tx('搜索件号或描述...', 'Search part number or description...')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>
            <div className="w-48">
              <Input
                placeholder={tx('机型（如 B737-800）', 'Aircraft type (e.g., B737-800)')}
                value={aircraftType}
                onChange={(e) => setAircraftType(e.target.value)}
              />
            </div>
            <div className="w-40">
              <Input
                placeholder={tx('MSN（可选）', 'MSN (optional)')}
                value={msn}
                onChange={(e) => setMsn(e.target.value)}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Search results */}
      {searchQuery && (
        <>
          {searchLoading ? (
            <div className="flex items-center justify-center h-48">
              <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
            </div>
          ) : searchError ? (
            <p className="text-sm text-red-500">{searchError}</p>
          ) : searchResults && searchResults.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {searchResults.map((ipc) => (
                <Card
                  key={ipc.id}
                  className={cn(
                    'cursor-pointer transition-all duration-200 hover:shadow-md',
                    selectedIPC?.id === ipc.id && 'ring-2 ring-brand-primary'
                  )}
                  onClick={() => setSelectedIPC(ipc)}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="font-mono font-semibold">{ipc.partNumber}</p>
                        <p className="text-sm text-gray-500">{ipc.description}</p>
                      </div>
                      <Badge variant="outline">ATA {ipc.ataChapter}</Badge>
                    </div>

                    <div className="mt-3">
                      <p className="text-xs text-gray-400">{tx('适用机型', 'Applicable Aircraft')}</p>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {ipc.aircraftTypes?.map((type) => (
                          <Badge key={type} variant="secondary" className="text-xs">
                            {type}
                          </Badge>
                        ))}
                      </div>
                    </div>

                    {ipc.supersededBy && (
                      <div className="mt-3 p-2 bg-yellow-50 rounded-lg flex items-center gap-2">
                        <RefreshCw className="w-4 h-4 text-yellow-600" />
                        <span className="text-sm text-yellow-700">
                          {tx('已替代为', 'Superseded by')}: {ipc.supersededBy}
                        </span>
                      </div>
                    )}

                    {ipc.interchangeableWith && ipc.interchangeableWith.length > 0 && (
                      <div className="mt-3">
                        <p className="text-xs text-gray-400">{tx('可互换件号', 'Interchangeable Part Numbers')}</p>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {ipc.interchangeableWith.map((part) => (
                            <Badge key={part} variant="outline" className="text-xs">
                              <ArrowRightLeft className="w-3 h-3 mr-1" />
                              {part}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}

                    <Button
                      className="w-full mt-4 bg-brand-primary hover:bg-brand-primary-hover"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedIPC(ipc);
                        handleCheckCompatibility();
                      }}
                      disabled={!aircraftType || checkLoading}
                    >
                      {checkLoading && selectedIPC?.id === ipc.id ? (
                        <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                      ) : (
                        <Plane className="w-4 h-4 mr-1" />
                      )}
                      {tx('检查适配性', 'Check Compatibility')}
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-500 text-center py-12">
              {tx('未找到匹配结果', 'No matching results')}
            </p>
          )}
        </>
      )}

      {/* Compatibility result dialog */}
      <Dialog open={isCompatibilityOpen} onOpenChange={setIsCompatibilityOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plane className="w-5 h-5" />
              {tx('件号适配结果', 'Part Number Compatibility Result')}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {selectedIPC && (
              <div className="p-4 bg-gray-50 rounded-lg">
                <p className="font-mono font-semibold">{selectedIPC.partNumber}</p>
                <p className="text-sm text-gray-500">{selectedIPC.description}</p>
                <div className="flex items-center gap-2 mt-2">
                  <Plane className="w-4 h-4 text-gray-400" />
                  <span>{aircraftType}</span>
                  {msn && <span className="text-gray-400">· MSN: {msn}</span>}
                </div>
              </div>
            )}

            {checkError && (
              <div className="p-4 bg-red-50 rounded-lg text-sm text-red-600">
                {tx('检查失败', 'Check failed')}: {checkError}
              </div>
            )}

            {compatibilityResult && (
              <>
                <div
                  className={cn(
                    'p-4 rounded-lg flex items-center gap-3',
                    compatibilityResult.isCompatible
                      ? 'bg-green-50 text-green-700'
                      : 'bg-red-50 text-red-700'
                  )}
                >
                  {compatibilityResult.isCompatible ? (
                    <CheckCircle className="w-8 h-8" />
                  ) : (
                    <XCircle className="w-8 h-8" />
                  )}
                  <div>
                    <p className="font-semibold">
                      {compatibilityResult.isCompatible
                        ? tx('件号适用', 'Part Number Applicable')
                        : tx('件号不适用', 'Part Number Not Applicable')}
                    </p>
                    <p className="text-sm">
                      {compatibilityResult.isCompatible
                        ? tx('该件号适用于所选机型。', 'This part number applies to the selected aircraft type.')
                        : tx('该件号不适用于所选机型。', 'This part number does not apply to the selected aircraft type.')}
                    </p>
                  </div>
                </div>

                {(compatibilityResult.warnings || []).length > 0 && (
                  <div className="p-4 bg-yellow-50 rounded-lg">
                    <p className="font-medium text-yellow-800 flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4" />
                      {tx('警告', 'Warnings')}
                    </p>
                    <ul className="mt-2 space-y-1">
                      {compatibilityResult.warnings.map((warning, index) => (
                        <li key={index} className="text-sm text-yellow-700">
                          · {warning}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {(compatibilityResult.sbRequirements || []).length > 0 && (
                  <div className="p-4 bg-blue-50 rounded-lg">
                    <p className="font-medium text-blue-800 flex items-center gap-2">
                      <FileText className="w-4 h-4" />
                      SB {tx('要求', 'Requirements')}
                    </p>
                    <ul className="mt-2 space-y-1">
                      {compatibilityResult.sbRequirements.map((sb, index) => (
                        <li key={index} className="text-sm text-blue-700">
                          · {sb}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCompatibilityOpen(false)}>
              {tx('关闭', 'Close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Feature tabs */}
      <Tabs defaultValue="compatibility">
        <TabsList>
          <TabsTrigger value="compatibility">{tx('适配检查', 'Compatibility Check')}</TabsTrigger>
          <TabsTrigger value="interchange">{tx('互换查询', 'Interchange Query')}</TabsTrigger>
          <TabsTrigger value="supersede">{tx('替代关系', 'Supersedure')}</TabsTrigger>
          <TabsTrigger value="sb">{tx('SB符合性', 'SB Compliance')}</TabsTrigger>
        </TabsList>

        <TabsContent value="compatibility" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{tx('包线适配预检', 'Envelope Compatibility Pre-check')}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="p-4 bg-gray-50 rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <Info className="w-4 h-4 text-blue-500" />
                    <span className="font-medium">{tx('TSN/CSN检查', 'TSN/CSN Check')}</span>
                  </div>
                  <p className="text-sm text-gray-500">
                    {tx('自动计算OH件号的剩余寿命，并检查客户飞机的包线要求。', 'Automatically calculates remaining life for OH parts and checks envelope requirements for the customer aircraft.')}
                  </p>
                </div>
                <div className="p-4 bg-gray-50 rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <Wrench className="w-4 h-4 text-blue-500" />
                    <span className="font-medium">{tx('最近运营方', 'Last Operator')}</span>
                  </div>
                  <p className="text-sm text-gray-500">
                    {tx('记录并校验最近运营方信息，保证可追溯性。', 'Records and validates Last Operator information for traceability.')}
                  </p>
                </div>
                <div className="p-4 bg-gray-50 rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <FileText className="w-4 h-4 text-blue-500" />
                    <span className="font-medium">{tx('证书校验', 'Certificate Validation')}</span>
                  </div>
                  <p className="text-sm text-gray-500">
                    {tx('校验8130-3/EASA Form 1证书与件号的匹配性。', 'Validates the matching between 8130-3/EASA Form 1 certificates and part numbers.')}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="interchange">
          <Card>
            <CardContent className="p-6">
              <div className="text-center py-12 text-gray-500">
              <Inbox className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                <ArrowRightLeft className="w-16 h-16 mx-auto mb-4 text-gray-300" />
                <p>{tx('输入件号查询可互换件号。', 'Enter a part number to query interchangeable part numbers.')}</p>
                <p className="text-sm mt-2">{tx('系统将显示可互换件号的库存和价格对比。', 'The system shows alternate part numbers with stock and price comparison.')}</p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="supersede">
          <Card>
            <CardContent className="p-6">
              <div className="text-center py-12 text-gray-500">
              <Inbox className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                <RefreshCw className="w-16 h-16 mx-auto mb-4 text-gray-300" />
                <p>{tx('查询件号替代关系信息。', 'Query supersedure information for a part number.')}</p>
                <p className="text-sm mt-2">{tx('系统高亮显示已替代件号及新件号的优势。', 'The system highlights superseded part numbers and advantages of newer parts.')}</p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="sb">
          <Card>
            <CardContent className="p-6">
              <div className="text-center py-12 text-gray-500">
              <Inbox className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                <FileText className="w-16 h-16 mx-auto mb-4 text-gray-300" />
                <p>{tx('SB符合性检查', 'SB compliance check')}</p>
                <p className="text-sm mt-2">{tx('校验件号是否匹配飞机SB改装状态。', 'Validates whether the part number matches aircraft SB modification status.')}</p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
