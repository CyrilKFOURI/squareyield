// Workbench shell: sidebar with the SquareYield brand (and the Cyfouri signature) and navigation, top bar, content area.
// Screens are DOM components; navigation goes back to the router through the async `navigate` action
// so the same code also works inside a native webview later.
import { type ReactNode, useEffect, useState } from 'react';

import { APP_NAME, CyfouriSign, SquareYieldMark } from './brand';
import { PhoneShell } from './phone-shell';
import '../styles/tokens.css';
import '../styles/base.css';

export type Navigate = (href: string) => Promise<void>;

/** Two paths only (docs/features/017-guided-levels/spec.md): what a page links to is not repeated here. */
const NAV: { key: 'market' | 'invest'; href: string; label: string; hint: string; icon: string }[] = [
  { key: 'market', href: '/', label: 'Marché', hint: 'France → département → commune', icon: 'M3 17V9m5 8V5m5 12v-6m5 6V3' },
  { key: 'invest', href: '/investir', label: 'Investir', hint: 'Trouver, analyser, simuler', icon: 'M4 16l5-5 4 4 7-7M14 8h6v6' },
];

/** Older screens still pass their own key: each belongs to one path. */
const PATH_OF: Record<string, string> = {
  home: 'market', map: 'market', evolution: 'market', compare: 'market', departement: 'market', place: 'market',
  explorer: 'invest', property: 'invest', simulator: 'invest',
};

const SIDEBAR_KEY = 'cy-sidebar';
const readCollapsed = () => {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === 'collapsed';
  } catch {
    return false;
  }
};

/** Under this width the sidebar becomes a top strip: filters go back above the content. */
const NARROW = '(max-width: 900px)';
const readNarrow = () => typeof window !== 'undefined' && window.matchMedia(NARROW).matches;
/** Phone (docs/features/023-phone/spec.md): its own shell, the document scrolls. */
const PHONE = '(max-width: 700px)';
const readPhone = () => typeof window !== 'undefined' && window.matchMedia(PHONE).matches;
const FILTER_ICON = 'M3 4h16l-6 7v6l-4 2v-8z';

const Icon = ({ d }: { d: string }) => (
  <svg width="16" height="16" viewBox="0 0 22 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden className="cy-nav-icon">
    <path d={d} />
  </svg>
);

type Theme = 'light' | 'dark' | 'auto';

const readTheme = (): Theme => {
  try {
    return (localStorage.getItem('cy-theme') as Theme) || 'auto';
  } catch {
    return 'auto';
  }
};

const applyTheme = (theme: Theme) => {
  if (theme === 'auto') {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme;
  }
  try {
    localStorage.setItem('cy-theme', theme);
  } catch {
    // private mode: the choice lasts for this page only
  }
};

/** A link that hands navigation to the router (no full page load, works in a webview). */
export const NavLink = ({
  href,
  navigate,
  children,
  current,
  className,
}: {
  href: string;
  navigate: Navigate;
  children: ReactNode;
  current?: boolean;
  className?: string;
}) => (
  <a
    href={href}
    className={className}
    aria-current={current ? 'page' : undefined}
    onClick={(event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
        return; // new tab / window keeps the browser's behaviour
      }
      event.preventDefault();
      navigate(href);
    }}>
    {children}
  </a>
);

type ShellProps = {
  active: string;
  title: string;
  crumbs?: { label: string; href?: string }[];
  tools?: ReactNode;
  /** Numbered step header of the path (Steps component). */
  steps?: ReactNode;
  filters?: ReactNode;
  navigate: Navigate;
  children: ReactNode;
};

export const Shell = ({ active, title, crumbs, tools, steps, filters, navigate, children }: ShellProps) => {
  // DOM components only run in the browser: the stored choice can be read at first render
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = () => {
    setCollapsed(!collapsed);
    try {
      localStorage.setItem(SIDEBAR_KEY, collapsed ? 'open' : 'collapsed');
    } catch {
      // private mode: the choice lasts for this page only
    }
  };
  const [narrow, setNarrow] = useState(readNarrow);
  const [phone, setPhone] = useState(readPhone);
  useEffect(() => {
    const narrowQuery = window.matchMedia(NARROW);
    const phoneQuery = window.matchMedia(PHONE);
    const onChange = () => {
      setNarrow(narrowQuery.matches);
      setPhone(phoneQuery.matches);
    };
    narrowQuery.addEventListener('change', onChange);
    phoneQuery.addEventListener('change', onChange);
    return () => {
      narrowQuery.removeEventListener('change', onChange);
      phoneQuery.removeEventListener('change', onChange);
    };
  }, []);
  const path = PATH_OF[active] ?? active;
  const cycle = () => {
    setTheme(theme === 'auto' ? 'light' : theme === 'light' ? 'dark' : 'auto');
  };
  const themeLabel = theme === 'auto' ? 'système' : theme === 'light' ? 'clair' : 'sombre';
  if (phone) {
    return (
      <PhoneShell path={path} title={title} tools={tools} steps={steps} filters={filters} themeLabel={themeLabel} onTheme={cycle} navigate={navigate}>
        {children}
      </PhoneShell>
    );
  }
  return (
    <div className={collapsed ? 'cy-app collapsed' : 'cy-app'}>
      <aside className="cy-sidebar">
        <NavLink href="/" navigate={navigate} className="cy-brand">
          <CyfouriSign />
          <SquareYieldMark />
          <span className="cy-brand-name">{APP_NAME}</span>
        </NavLink>
        <nav className="cy-nav" aria-label="Navigation principale">
          {NAV.map((item) => (
            <NavLink key={item.key} href={item.href} navigate={navigate} current={item.key === path}>
              <Icon d={item.icon} />
              <span className="cy-nav-text">
                <span>{item.label}</span>
                <small>{item.hint}</small>
              </span>
            </NavLink>
          ))}
        </nav>
        {/* filters live in the sidebar (docs/features/020-sidebar-filters/spec.md): the page keeps its full width */}
        {filters && !narrow && (
          collapsed ? (
            <button type="button" className="cy-side-filters-open" onClick={toggle} title="Afficher les filtres" aria-label="Afficher les filtres">
              <Icon d={FILTER_ICON} />
            </button>
          ) : (
            <section className="cy-side-filters" aria-label="Filtres">
              <h2 className="cy-side-filters-title">Filtres</h2>
              {filters}
            </section>
          )
        )}
        <div className="cy-sidebar-foot">
          <NavLink href="/method" navigate={navigate} current={path === 'method'} className="cy-foot-link">
            Méthode & glossaire
          </NavLink>
          <button type="button" className="cy-button ghost" onClick={cycle} aria-label="Changer de thème">
            Thème : {themeLabel}
          </button>
          <button type="button" className="cy-button ghost cy-collapse" onClick={toggle}
            aria-label={collapsed ? 'Déplier le menu' : 'Replier le menu'} title={collapsed ? 'Déplier le menu' : 'Replier le menu'}>
            {collapsed ? '»' : '«'}
          </button>
        </div>
      </aside>
      <div className="cy-main">
        <header className="cy-topbar">
          <h1 className="cy-title" style={{ margin: 0 }}>
            {title}
          </h1>
          {crumbs && crumbs.length > 0 && (
            <nav className="cy-crumbs" aria-label="Fil d'Ariane">
              {crumbs.map((crumb, i) => (
                <span key={`${crumb.label}-${i}`}>
                  {i > 0 && '› '}
                  {crumb.href ? (
                    <NavLink href={crumb.href} navigate={navigate}>
                      {crumb.label}
                    </NavLink>
                  ) : (
                    crumb.label
                  )}
                </span>
              ))}
            </nav>
          )}
          <div className="cy-topbar-tools">{tools}</div>
        </header>
        {steps}
        {narrow && <div>{filters}</div>}
        <main className="cy-content">{children}</main>
      </div>
    </div>
  );
};
