import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface ControlledListExportButtonProps {
  locale: string;
  onExport: (scope: 'page' | 'filtered') => Promise<void>;
}

export function ControlledListExportButton({ locale, onExport }: ControlledListExportButtonProps) {
  const [exporting, setExporting] = useState(false);
  const zh = locale === 'zh-CN';

  const runExport = async (scope: 'page' | 'filtered') => {
    if (scope === 'filtered') {
      const confirmed = window.confirm(
        zh
          ? '将导出当前全部筛选结果（最多 5,000 条）。确认继续吗？'
          : 'Export all current filtered results (up to 5,000 rows)?',
      );
      if (!confirmed) return;
    }

    setExporting(true);
    try {
      await onExport(scope);
      toast.success(zh ? '导出已开始' : 'Export started');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : zh ? '导出失败' : 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" disabled={exporting}>
          {exporting ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Download className="w-4 h-4 mr-1" />}
          {zh ? '导出' : 'Export'}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => { void runExport('page'); }}>
          {zh ? '导出当前页 CSV' : 'Export current page CSV'}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => { void runExport('filtered'); }}>
          {zh ? '导出全部筛选结果（最多 5,000 条）' : 'Export all filtered results (max 5,000)'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
