import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuthStore } from '@/store';
import { useTranslation } from '@/i18n';
import { resolveVisibleSettingsTabs } from './tabRegistry';

export function SettingsPage() {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const { user } = useAuthStore();
  const visibleTabs = useMemo(() => resolveVisibleSettingsTabs({ user }), [user]);
  const defaultTab = visibleTabs[0]?.key ?? 'profile';
  const [activeTab, setActiveTab] = useState(defaultTab);
  const resolvedActiveTab = visibleTabs.some((tab) => tab.key === activeTab)
    ? activeTab
    : defaultTab;

  return (
    <div className="space-y-6">
      <Tabs value={resolvedActiveTab} onValueChange={setActiveTab}>
        <TabsList
          className="grid w-fit"
          style={{ gridTemplateColumns: `repeat(${visibleTabs.length}, minmax(0, 1fr))` }}
        >
          {visibleTabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <TabsTrigger key={tab.key} value={tab.key} className={tab.triggerClassName}>
                {Icon ? <Icon className="w-4 h-4" /> : null}
                {tx(tab.labelZh, tab.labelEn)}
                {tab.featureStage === 'beta' ? (
                  <Badge variant="outline" className="ml-1 border-amber-300 bg-amber-100 text-amber-800 text-[10px] leading-none">
                    Beta
                  </Badge>
                ) : null}
              </TabsTrigger>
            );
          })}
        </TabsList>

        {visibleTabs.map((tab) => (
          <TabsContent key={tab.key} value={tab.key} className={tab.contentClassName}>
            {tab.render({ user })}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
