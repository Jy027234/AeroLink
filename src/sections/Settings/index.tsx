import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuthStore } from '@/store';
import { useTranslation } from '@/i18n';
import { resolveVisibleSettingsTabs } from './tabRegistry';
import { getSettingsTabFromUrl, setSettingsTabInUrl, subscribeToSettingsTabUrlChange } from './tabUrlState';

export function SettingsPage() {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const { user } = useAuthStore();
  const visibleTabs = useMemo(() => resolveVisibleSettingsTabs({ user }), [user]);
  const defaultTab = visibleTabs[0]?.key ?? 'profile';
  const [activeTab, setActiveTab] = useState(() => getSettingsTabFromUrl() || defaultTab);
  const resolvedActiveTab = visibleTabs.some((tab) => tab.key === activeTab)
    ? activeTab
    : defaultTab;

  useEffect(() => {
    if (resolvedActiveTab !== activeTab) {
      setActiveTab(resolvedActiveTab);
    }

    const currentUrlTab = getSettingsTabFromUrl();
    if (resolvedActiveTab && currentUrlTab !== resolvedActiveTab) {
      setSettingsTabInUrl(resolvedActiveTab);
    }
  }, [activeTab, resolvedActiveTab]);

  useEffect(() => {
    return subscribeToSettingsTabUrlChange(() => {
      const nextTab = getSettingsTabFromUrl();
      if (nextTab) {
        setActiveTab(nextTab);
      }
    });
  }, []);

  const handleTabChange = (nextTab: string) => {
    setActiveTab(nextTab);
    setSettingsTabInUrl(nextTab);
  };

  return (
    <div className="space-y-6">
      <Tabs value={resolvedActiveTab} onValueChange={handleTabChange}>
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
