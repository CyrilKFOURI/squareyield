// Investir ① screen filters (spec 015), shown as the "Plus de filtres" group of the sidebar filter column (spec 020):
// one control per row, ranges as two small inputs side by side, values kept in the URL. Inputs commit on blur or
// Enter so typing does not rewrite the URL on every key.
import { type KeyboardEvent, useState } from 'react';

import { SCREEN_FILTER_KEYS } from '../../data/screen-filters';
import { FilterField, Segmented, Select } from './controls';

type Props = {
  params: Record<string, string>;
  onParams: (next: Record<string, string | undefined>) => Promise<void>;
  active: number;
  /** Région picker, for the whole of France only (a département is already in one région). */
  regions: { code: string; name: string }[] | null;
};

type ParamProps = Pick<Props, 'params' | 'onParams'>;

/** A number input bound to one URL key; `key` resets it when the URL changes from elsewhere (reset, back). */
const ParamInput = ({ name, label, placeholder, params, onParams }: { name: string; label: string; placeholder?: string } & ParamProps) => {
  const commit = (value: string) => onParams({ [name]: value.trim() || undefined });
  return (
    <input
      key={params[name] ?? ''}
      className="cy-input num"
      inputMode="decimal"
      aria-label={label}
      placeholder={placeholder}
      defaultValue={params[name] ?? ''}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && commit(e.currentTarget.value)}
    />
  );
};

const Single = ({ name, label, unit, ...rest }: { name: string; label: string; unit: string } & ParamProps) => (
  <FilterField label={label}>
    <span className="cy-more-single">
      <ParamInput name={name} label={`${label} (${unit})`} {...rest} />
      <span className="ink-3">{unit}</span>
    </span>
  </FilterField>
);

const Range = ({ min, max, label, unit, ...rest }: { min: string; max: string; label: string; unit: string } & ParamProps) => (
  <FilterField label={label}>
    <span className="cy-more-range">
      <ParamInput name={min} label={`${label} minimum (${unit})`} placeholder="min" {...rest} />
      <span className="ink-3" aria-hidden>–</span>
      <ParamInput name={max} label={`${label} maximum (${unit})`} placeholder="max" {...rest} />
      <span className="ink-3">{unit}</span>
    </span>
  </FilterField>
);

export const ScreenFilterPanel = ({ params, onParams, active, regions }: Props) => {
  const [open, setOpen] = useState(active > 0);
  const bind = { params, onParams };
  return (
    <div className="cy-more">
      <div className="cy-more-head">
        <button type="button" className="cy-more-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span aria-hidden className="cy-more-caret">{open ? '▾' : '▸'}</span>
          Plus de filtres
          {active > 0 && <span className="cy-badge">{active} actif{active > 1 ? 's' : ''}</span>}
        </button>
        {active > 0 && (
          <button type="button" className="cy-more-reset" onClick={() => onParams(Object.fromEntries(SCREEN_FILTER_KEYS.map((k) => [k, undefined])))}>
            Réinitialiser
          </button>
        )}
      </div>
      {open && (
        <div className="cy-more-body">
          <Single name="budget" label="Budget (bien type)" unit="€" {...bind} />
          <Range min="pmin" max="pmax" label="Prix au m²" unit="€/m²" {...bind} />
          <Range min="ymin" max="ymax" label="Rendement brut" unit="%" {...bind} />
          <FilterField label="Cash-flow">
            <Segmented label="Cash-flow" options={[{ value: '', label: 'Tous' }, { value: 'pos', label: 'Positif' }]} value={params.cf === 'pos' ? 'pos' : ''}
              onChange={(v) => onParams({ cf: v || undefined })} />
          </FilterField>
          <Range min="popmin" max="popmax" label="Population" unit="hab." {...bind} />
          <Single name="vacmax" label="Vacance max" unit="%" {...bind} />
          <Single name="fgmax" label="Passoires F/G max" unit="%" {...bind} />
          <FilterField label="Encadrement des loyers">
            <Segmented label="Encadrement des loyers" options={[{ value: '', label: 'Tous' }, { value: 'in', label: 'Oui' }, { value: 'out', label: 'Non' }]}
              value={params.rc === 'in' || params.rc === 'out' ? params.rc : ''} onChange={(v) => onParams({ rc: v || undefined })} />
          </FilterField>
          <FilterField label="Villes à risque">
            <Segmented label="Villes à risque" options={[{ value: '', label: 'Incluses' }, { value: 'out', label: 'Exclues' }]} value={params.risky === 'out' ? 'out' : ''}
              onChange={(v) => onParams({ risky: v || undefined })} />
          </FilterField>
          {regions && (
            <FilterField label="Région">
              <Select label="Région" options={[{ value: '', label: 'Toutes' }, ...regions.map((r) => ({ value: r.code, label: r.name }))]} value={params.region ?? ''}
                onChange={(v) => onParams({ region: v || undefined })} />
            </FilterField>
          )}
        </div>
      )}
    </div>
  );
};
