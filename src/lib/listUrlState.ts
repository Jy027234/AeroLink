import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';

const LIST_URL_STATE_EVENT = 'aerolink:list-url-state-change';

function readParam(key: string): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get(key);
}

function writeParam(key: string, value: string, fallback: string): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (!value || value === fallback) {
    url.searchParams.delete(key);
  } else {
    url.searchParams.set(key, value);
  }
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== current) {
    window.history.replaceState(window.history.state, '', next);
    window.dispatchEvent(new Event(LIST_URL_STATE_EVENT));
  }
}

/**
 * Keeps one list filter, sort, or page value in the URL. Defaults are omitted
 * from the query string so copied URLs stay compact, while browser navigation
 * still restores an exact list state.
 */
export function useListUrlStringState(
  key: string,
  fallback: string,
): [string, Dispatch<SetStateAction<string>>] {
  const [value, setValue] = useState(() => readParam(key) ?? fallback);

  useEffect(() => {
    const sync = () => setValue(readParam(key) ?? fallback);
    window.addEventListener('popstate', sync);
    window.addEventListener(LIST_URL_STATE_EVENT, sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener(LIST_URL_STATE_EVENT, sync);
    };
  }, [fallback, key]);

  const setUrlValue = useCallback<Dispatch<SetStateAction<string>>>((nextValue) => {
    setValue((previous) => {
      const next = typeof nextValue === 'function' ? nextValue(previous) : nextValue;
      writeParam(key, next, fallback);
      return next;
    });
  }, [fallback, key]);

  return [value, setUrlValue];
}

export function useListUrlNumberState(
  key: string,
  fallback: number,
  minimum = 1,
): [number, Dispatch<SetStateAction<number>>] {
  const parse = useCallback((value: string | null) => {
    const number = Number.parseInt(value ?? '', 10);
    return Number.isFinite(number) && number >= minimum ? number : fallback;
  }, [fallback, minimum]);
  const [value, setValue] = useState(() => parse(readParam(key)));

  useEffect(() => {
    const sync = () => setValue(parse(readParam(key)));
    window.addEventListener('popstate', sync);
    window.addEventListener(LIST_URL_STATE_EVENT, sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener(LIST_URL_STATE_EVENT, sync);
    };
  }, [key, parse]);

  const setUrlValue = useCallback<Dispatch<SetStateAction<number>>>((nextValue) => {
    setValue((previous) => {
      const candidate = typeof nextValue === 'function' ? nextValue(previous) : nextValue;
      const next = Number.isFinite(candidate) && candidate >= minimum ? candidate : fallback;
      writeParam(key, String(next), String(fallback));
      return next;
    });
  }, [fallback, key, minimum]);

  return [value, setUrlValue];
}
