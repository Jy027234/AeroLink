import { Badge } from '@/components/ui/badge';
import { useTranslation } from '@/i18n';

export function SettingsReadOnlyNotice({
  summaryZh,
  summaryEn,
}: {
  summaryZh: string;
  summaryEn: string;
}) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="border-amber-300 bg-amber-100 text-amber-800">
          {tx('只读 / 演示', 'Read-only / Demo')}
        </Badge>
        <p className="text-sm text-amber-900">{tx(summaryZh, summaryEn)}</p>
      </div>
    </div>
  );
}