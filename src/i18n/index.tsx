import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { zhCN } from './zh-CN';
import type { LocaleDict } from './zh-CN';
import { en } from './en';

type Locale = 'zh-CN' | 'en';

const dictionaries: Record<Locale, LocaleDict> = {
  'zh-CN': zhCN,
  en,
};

function getNestedValue(obj: unknown, path: string): string | undefined {
  const keys = path.split('.');
  let value: unknown = obj;
  for (const key of keys) {
    if (value == null) return undefined;
    if (typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === 'string' ? value : undefined;
}

interface I18nContextType {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextType>({
  locale: 'zh-CN',
  setLocale: () => {},
  t: (key: string) => key,
});

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const stored = localStorage.getItem('aerolink_locale') as Locale;
    return stored === 'en' ? 'en' : 'zh-CN';
  });

  useEffect(() => {
    document.documentElement.lang = locale === 'en' ? 'en' : 'zh-CN';
    document.documentElement.dir = 'ltr';
  }, [locale]);

  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale);
    localStorage.setItem('aerolink_locale', newLocale);
  }, []);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      const dict = dictionaries[locale];
      let text = getNestedValue(dict, key) || key;

      if (params) {
        Object.entries(params).forEach(([k, v]) => {
          text = text.replace(new RegExp(`{${k}}`, 'g'), String(v));
        });
      }

      return text;
    },
    [locale]
  );

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTranslation() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useTranslation must be used within I18nProvider');
  }
  return context;
}
