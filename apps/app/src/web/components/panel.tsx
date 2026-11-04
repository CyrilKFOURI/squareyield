// Docked panels, the KPI ribbon, the ⓘ and the empty / error states (docs/UI_UX.md).
import type { CSSProperties, ReactNode } from 'react';

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
  children: ReactNode;
};

export const Panel = ({ title, info, tools, span = 12, flush, style, id, children }: PanelProps) => (
  <section className="cy-panel" style={{ gridColumn: `span ${span}`, ...style }} id={id}>
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

/** ⓘ with the catalogue entry of a field or metric: definition, how to read it, source. */
export const InfoTip = ({ k, extra }: { k: string; extra?: string }) => {
  const entry = catalogueEntry(k);
  if (!entry) {
    return null;
  }
  return (
    <span className="cy-info" tabIndex={0} role="note" aria-label={`${entry.label} : ${entry.definition}`}>
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
