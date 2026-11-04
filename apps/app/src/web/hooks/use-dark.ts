// Current colour theme of the page: the sidebar toggle (data-theme on <html>) or, without it, the system.
// Maps and charts read it so they redraw when the theme changes.
import { useSyncExternalStore } from 'react';

const isDark = () =>
  document.documentElement.dataset.theme === 'dark' ||
  (!document.documentElement.dataset.theme && window.matchMedia('(prefers-color-scheme: dark)').matches);

const subscribe = (onChange: () => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', onChange);
  return () => {
    observer.disconnect();
    media.removeEventListener('change', onChange);
  };
};

export const useDark = (): boolean => useSyncExternalStore(subscribe, isDark, () => false);
