// Phone shell (docs/features/023-phone/spec.md): the document scrolls, one compact sticky header, a bottom tab
// bar above the home indicator, filters in a bottom sheet. Same pages and props as the desktop Shell.
import { type ReactNode, useEffect, useState } from 'react';

import { APP_NAME, CyfouriSign, SquareYieldMark } from './brand';

type Navigate = (href: string) => Promise<void>;
type Tab = { key: string; href: string; label: string; icon: string };

const TABS: Tab[] = [
  { key: 'market', href: '/', label: 'Marché', icon: 'M3 17V9m5 8V5m5 12v-6m5 6V3' },
  { key: 'invest', href: '/investir', label: 'Investir', icon: 'M4 16l5-5 4 4 7-7M14 8h6v6' },
  { key: 'method', href: '/method', label: 'Méthode', icon: 'M5 3h10l4 4v14H5zM9 11h6M9 15h6' },
];
const FILTER_ICON = 'M3 4h16l-6 7v6l-4 2v-8z';
const THEME_ICON = 'M11 3a8 8 0 1 0 8 8 6 6 0 0 1-8-8z';

const Icon = ({ d, size = 20 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
    <path d={d} />
  </svg>
);

const go = (navigate: Navigate, href: string) => (event: React.MouseEvent<HTMLAnchorElement>) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
    return;
  }
  event.preventDefault();
  navigate(href);
};

type PhoneShellProps = {
  path: string;
  title: string;
  tools?: ReactNode;
  steps?: ReactNode;
  filters?: ReactNode;
  themeLabel: string;
  onTheme: () => void;
  navigate: Navigate;
  children: ReactNode;
};

/** Bottom sheet: the page behind does not scroll while it is open; a tap outside or "Voir" closes it. */
const FilterSheet = ({ onClose, children }: { onClose: () => void; children: ReactNode }) => {
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return (
    <div className="cy-sheet-backdrop" onClick={onClose}>
      <section className="cy-sheet" role="dialog" aria-modal="true" aria-label="Filtres" onClick={(event) => event.stopPropagation()}>
        <header className="cy-sheet-head">
          <h2>Filtres</h2>
          <button type="button" className="cy-button" onClick={onClose}>
            Voir
          </button>
        </header>
        <div className="cy-sheet-body cy-side-filters">{children}</div>
      </section>
    </div>
  );
};

export const PhoneShell = ({ path, title, tools, steps, filters, themeLabel, onTheme, navigate, children }: PhoneShellProps) => {
  const [sheet, setSheet] = useState(false);
  const close = () => setSheet(false);
  return (
    <div className="cy-app cy-phone">
      <header className="cy-phone-head">
        <a href="/" className="cy-phone-brand" aria-label={`${APP_NAME}, accueil`} onClick={go(navigate, '/')}>
          <CyfouriSign />
          <SquareYieldMark size={28} />
        </a>
        <div className="cy-phone-titles">
          <small>{APP_NAME}</small>
          <h1>{title}</h1>
        </div>
        {filters && (
          <button type="button" className="cy-phone-icon" onClick={() => setSheet(true)} aria-label="Filtres">
            <Icon d={FILTER_ICON} />
          </button>
        )}
        <button type="button" className="cy-phone-icon" onClick={onTheme} aria-label={`Thème : ${themeLabel}`} title={`Thème : ${themeLabel}`}>
          <Icon d={THEME_ICON} />
        </button>
      </header>
      {tools && <div className="cy-phone-tools">{tools}</div>}
      {steps}
      <main className="cy-content">{children}</main>
      <div className="cy-phone-end" aria-hidden />
      <nav className="cy-tabbar" aria-label="Navigation principale">
        {TABS.map((tab) => (
          <a key={tab.key} href={tab.href} aria-current={tab.key === path ? 'page' : undefined} onClick={go(navigate, tab.href)}>
            <Icon d={tab.icon} />
            <span>{tab.label}</span>
          </a>
        ))}
      </nav>
      {sheet && filters && <FilterSheet onClose={close}>{filters}</FilterSheet>}
    </div>
  );
};
