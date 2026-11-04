// Workbench shell: sidebar with the Cyfouri brand and navigation, top bar, content area.
// Screens are DOM components; navigation goes back to the router through the async `navigate` action
// so the same code also works inside a native webview later.
import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';

import { assetUrl } from '../../data/config';
import '../styles/tokens.css';
import '../styles/base.css';

export type Navigate = (href: string) => Promise<void>;

const NAV: { group: string; items: { href: string; label: string; key: string }[] }[] = [
  {
    group: 'Marché',
    items: [
      { key: 'home', href: '/', label: 'Vue nationale' },
      { key: 'map', href: '/map', label: 'Carte' },
      { key: 'explorer', href: '/explorer', label: 'Explorer' },
      { key: 'evolution', href: '/evolution', label: 'Évolution' },
      { key: 'compare', href: '/compare', label: 'Comparer' },
    ],
  },
  {
    group: 'Investir',
    items: [
      { key: 'property', href: '/property', label: 'Analyser un bien' },
      { key: 'simulator', href: '/simulator', label: 'Simulateur' },
    ],
  },
  { group: 'Aide', items: [{ key: 'method', href: '/method', label: 'Méthode & glossaire' }] },
];

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
  filters?: ReactNode;
  navigate: Navigate;
  children: ReactNode;
};

export const Shell = ({ active, title, crumbs, tools, filters, navigate, children }: ShellProps) => {
  // DOM components only run in the browser: the stored choice can be read at first render
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  const cycle = () => {
    setTheme(theme === 'auto' ? 'light' : theme === 'light' ? 'dark' : 'auto');
  };
  return (
    <div className="cy-app">
      <aside className="cy-sidebar">
        <NavLink href="/" navigate={navigate} className="cy-brand">
          {/* the logo url follows the site base path (GitHub Pages sub-path, native site URL) */}
          <span className="cy-brand-mark" aria-hidden style={{ '--logo': `url(${assetUrl('brand/logo-mark.png')})` } as CSSProperties} />
          <span className="cy-brand-name">CYFOURI</span>
        </NavLink>
        <nav className="cy-nav" aria-label="Navigation principale">
          {NAV.map((group) => (
            <div key={group.group} style={{ display: 'contents' }}>
              <div className="cy-nav-group">{group.group}</div>
              {group.items.map((item) => (
                <NavLink key={item.key} href={item.href} navigate={navigate} current={item.key === active}>
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="cy-sidebar-foot">
          <button type="button" className="cy-button ghost" onClick={cycle} aria-label="Changer de thème">
            Thème : {theme === 'auto' ? 'système' : theme === 'light' ? 'clair' : 'sombre'}
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
        <div>{filters}</div>
        <main className="cy-content">{children}</main>
      </div>
    </div>
  );
};
