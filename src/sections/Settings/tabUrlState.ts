const SETTINGS_TAB_EVENT = 'settings-tab-change';

export function getSettingsTabFromUrl() {
  const tab = new URLSearchParams(window.location.search).get('tab');
  return tab || undefined;
}

export function setSettingsTabInUrl(tabKey: string, mode: 'push' | 'replace' = 'replace') {
  const url = new URL(window.location.href);
  if (tabKey) {
    url.searchParams.set('tab', tabKey);
  } else {
    url.searchParams.delete('tab');
  }

  if (mode === 'push') {
    window.history.pushState(window.history.state, '', url);
  } else {
    window.history.replaceState(window.history.state, '', url);
  }

  window.dispatchEvent(
    new CustomEvent(SETTINGS_TAB_EVENT, {
      detail: { tabKey },
    })
  );
}

export function subscribeToSettingsTabUrlChange(listener: () => void) {
  const handler = () => listener();

  window.addEventListener('popstate', handler);
  window.addEventListener(SETTINGS_TAB_EVENT, handler as EventListener);

  return () => {
    window.removeEventListener('popstate', handler);
    window.removeEventListener(SETTINGS_TAB_EVENT, handler as EventListener);
  };
}
