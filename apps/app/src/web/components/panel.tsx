// Docked panels, the KPI ribbon, the ⓘ and the empty / error states (docs/UI_UX.md).
import type { CSSProperties, ReactNode, SyntheticEvent } from 'react';

import { catalogueEntry } from '../../data/catalogue';

type PanelProps = {
  /** Omitted for a header-less strip (KPI ribbon). */
  title?: ReactNode;
  info?: string;
  tools?: ReactNode;
  /** Columns of the 12-column grid this panel spans. */
  span?: number;
  flush?: boolean;
  style?: CSSProperties;
  id?: string;
  /** Not shown on a phone (023): a view that does not work on a small screen (the year heatmaps). */
  hideOnPhone?: boolean;
  children: ReactNode;
};

export const Panel = ({ title, info, tools, span = 12, flush, style, id, hideOnPhone, children }: PanelProps) => (
  <section className={hideOnPhone ? 'cy-panel cy-no-phone' : 'cy-panel'} style={{ gridColumn: `span ${span}`, ...style }} id={id}>
    {(title != null || tools) && (
      <header className="cy-panel-head">
        <h2 className="cy-panel-title" style={{ margin: 0 }}>
          {title}
          {info && <InfoTip k={info} />}
        </h2>
        {tools && <div className="cy-panel-tools">{tools}</div>}
      </header>
    )}
    <div className={flush ? 'cy-panel-body flush' : 'cy-panel-body'}>{children}</div>
  </section>
);

const GAP = 8;

/** The pop is position: fixed so no scrolling panel clips it: put it under the ⓘ (above if no room), inside the window. */
const placePop = (event: SyntheticEvent<HTMLSpanElement>) => {
  const icon = event.currentTarget.getBoundingClientRect();
  const pop = event.currentTarget.querySelector<HTMLElement>('.cy-info-pop');
  if (!pop) {
    return;
  }
  const width = Math.min(300, window.innerWidth - 2 * GAP);
  pop.style.width = `${width}px`;
  pop.style.left = `${Math.max(GAP, Math.min(icon.left - 8, window.innerWidth - width - GAP))}px`;
  pop.style.top = `${icon.bottom + 5}px`;
  const height = pop.offsetHeight;
  if (icon.bottom + 5 + height > window.innerHeight - GAP && icon.top - 5 - height >= GAP) {
    pop.style.top = `${icon.top - 5 - height}px`;
  }
};

/** ⓘ with the catalogue entry of a field or metric: definition, how to read it, source. */
export const InfoTip = ({ k, extra }: { k: string; extra?: string }) => {
  const entry = catalogueEntry(k);
  if (!entry) {
    return null;
  }
  return (
    <span
      className="cy-info"
      tabIndex={0}
      role="note"
      aria-label={`${entry.label} : ${entry.definition}`}
      onMouseEnter={placePop}
      onFocus={placePop}
    >
      i
      <span className="cy-info-pop">
        <b>{entry.label}</b>
        {entry.definition}
        {entry.howToRead && <p>{entry.howToRead}</p>}
        {extra && <p>{extra}</p>}
        <p>Source : {entry.source}</p>
      </span>
    </span>
  );
};

export type KpiItem = {
  label: string;
  value: string;
  detail?: ReactNode;
  info?: string;
  tone?: 'pos' | 'neg' | 'warn';
};

/** One continuous strip of key figures split by 1 px rules. */
export const Ribbon = ({ items }: { items: KpiItem[] }) => (
  <div className="cy-ribbon">
    {items.map((item) => (
      <div className="cy-kpi" key={item.label}>
        <div className="cy-kpi-label">
          {item.label}
          {item.info && <InfoTip k={item.info} />}
        </div>
        <div className={`cy-kpi-value${item.tone ? ` ${item.tone}` : ''}`}>{item.value}</div>
        {item.detail != null && <div className="cy-kpi-detail">{item.detail}</div>}
      </div>
    ))}
  </div>
);

export const EmptyState = ({ children }: { children: ReactNode }) => <div className="cy-empty">{children}</div>;

export const ErrorPanel = ({ message, onRetry }: { message: string; onRetry?: () => void }) => (
  <div className="cy-error" role="alert">
    <span>{message}</span>
    {onRetry && (
      <button type="button" className="cy-button ghost" onClick={onRetry}>
        Réessayer
      </button>
    )}
  </div>
);

export const ReliabilityBadge = ({ n }: { n: number | null | undefined }) =>
  n != null && n < 30 ? <span className="cy-badge warn">fiabilité faible · {n} ventes</span> : null;
