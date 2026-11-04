// Flat controls flush with the grid: segmented buttons, selects, checkboxes, and the global filter bar.
import type { ReactNode } from 'react';

import { catalogueEntry } from '../../data/catalogue';
import type { Filters } from '../../data/filters';
import { METRICS } from '../../data/map';
import { bucketsFor } from '../../data/select';
import type { RoomsBucket } from '../../data/types';
import { InfoTip } from './panel';

export type Option<T extends string> = { value: T; label: string };

export const Segmented = <T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: Option<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) => (
  <div className="cy-seg" role="group" aria-label={label}>
    {options.map((option) => (
      <button
        key={option.value}
        type="button"
        aria-pressed={option.value === value}
        onClick={() => onChange(option.value)}>
        {option.label}
      </button>
    ))}
  </div>
);

export const Select = <T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: Option<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) => (
  <select className="cy-select" aria-label={label} value={value} onChange={(e) => onChange(e.target.value as T)}>
    {options.map((option) => (
      <option key={option.value} value={option.value}>
        {option.label}
      </option>
    ))}
  </select>
);

export const Check = ({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) => (
  <label className="cy-check">
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    {label}
  </label>
);

export const FilterField = ({ label, info, children }: { label: string; info?: string; children: ReactNode }) => (
  <div className="cy-filter">
    <span className="cy-filter-label">
      {label}
      {info && <InfoTip k={info} />}
    </span>
    {children}
  </div>
);

export const sizeLabel = (type: Filters['type'], size: string): string =>
  size === 'all' ? 'Toutes' : type === 'house' ? `${size} p.` : `T${size}`;

export type FilterKey = 'type' | 'size' | 'condition' | 'period' | 'metric' | 'reliable';

type FilterBarProps = {
  filters: Filters;
  onFilters: (next: Partial<Filters>) => void;
  show: FilterKey[];
  /** Periods published for the current view, newest last. */
  periods?: { year: string[]; half: string[] };
  allowMix?: boolean;
  children?: ReactNode;
};

/** The global segment filters; each screen shows the ones that change its figures. */
export const FilterBar = ({ filters, onFilters, show, periods, allowMix, children }: FilterBarProps) => {
  const typeOptions: Option<Filters['type']>[] = [
    { value: 'apartment', label: 'Appartements' },
    { value: 'house', label: 'Maisons' },
    ...(allowMix ? [{ value: 'all' as const, label: 'Ensemble (mélange)' }] : []),
  ];
  const sizes: RoomsBucket[] = filters.type === 'all' ? ['all'] : bucketsFor(filters.type);
  const periodList = periods ? periods[filters.periodType] : [];
  return (
    <div className="cy-filters">
      {show.includes('type') && (
        <FilterField label="Type de bien">
          <Segmented
            label="Type de bien"
            options={typeOptions}
            value={filters.type}
            onChange={(type) => onFilters({ type, size: 'all' })}
          />
        </FilterField>
      )}
      {show.includes('size') && filters.type !== 'all' && filters.condition === 'existing' && (
        <FilterField label="Taille">
          <Segmented
            label="Taille"
            options={sizes.map((size) => ({ value: size, label: sizeLabel(filters.type, size) }))}
            value={filters.size}
            onChange={(size) => onFilters({ size })}
          />
        </FilterField>
      )}
      {show.includes('condition') && (
        <FilterField label="Ancien / neuf" info="new_premium">
          <Segmented
            label="Ancien ou neuf"
            options={[
              { value: 'existing', label: 'Ancien' },
              { value: 'new', label: 'Neuf (VEFA)' },
            ]}
            value={filters.condition}
            onChange={(condition) => onFilters({ condition, size: 'all' })}
          />
        </FilterField>
      )}
      {show.includes('period') && (
        <FilterField label="Période">
          <div style={{ display: 'flex', gap: 6 }}>
            <Segmented
              label="Pas de temps"
              options={[
                { value: 'year', label: 'Année' },
                { value: 'half', label: 'Semestre' },
              ]}
              value={filters.periodType}
              onChange={(periodType) => onFilters({ periodType, period: null })}
            />
            {periodList.length > 0 && (
              <Select
                label="Période"
                options={[{ value: '', label: 'Dernière' }, ...[...periodList].reverse().map((p) => ({ value: p, label: p }))]}
                value={filters.period ?? ''}
                onChange={(period) => onFilters({ period: period || null })}
              />
            )}
          </div>
        </FilterField>
      )}
      {show.includes('metric') && (
        <FilterField label="Indicateur" info={filters.metric}>
          <Select
            label="Indicateur"
            options={METRICS.map((m) => ({ value: m.base, label: catalogueEntry(m.base)?.label ?? m.label }))}
            value={filters.metric}
            onChange={(metric) => onFilters({ metric })}
          />
        </FilterField>
      )}
      {show.includes('reliable') && (
        <FilterField label="Fiabilité" info="reliability">
          <Check label="≥ 30 ventes seulement" checked={filters.reliable} onChange={(reliable) => onFilters({ reliable })} />
        </FilterField>
      )}
      {children}
    </div>
  );
};
