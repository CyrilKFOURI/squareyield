// Explorer screen filters (spec 015): one docked strip of small inputs, values kept in the URL. Inputs commit
// on blur or Enter so typing does not rewrite the URL on every key.
import { type KeyboardEvent, useState } from 'react';

import { SCREEN_FILTER_KEYS } from '../../data/screen-filters';
import { FilterField, Segmented, Select } from './controls';
import { Panel } from './panel';

type Props = {
  params: Record<string, string>;
  onParams: (next: Record<string, string | undefined>) => Promise<void>;
  active: number;
  /** Région picker, for the départements list only. */
  regions: { code: string; name: string }[] | null;
};

const Field = ({ name, label, unit, params, onParams }: { name: string; label: string; unit: string } & Pick<Props, 'params' | 'onParams'>) => {
  const commit = (value: string) => onParams({ [name]: value.trim() || undefined });
  return (
    <FilterField label={label}>
      <span className="cy-unit">
        <input
          key={params[name] ?? ''}
          className="cy-input num"
          inputMode="decimal"
          aria-label={label}
          defaultValue={params[name] ?? ''}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && commit(e.currentTarget.value)}
          style={{ width: 84 }}
        />
        <span className="ink-3">{unit}</span>
      </span>
    </FilterField>
  );
};

export const ScreenFilterPanel = ({ params, onParams, active, regions }: Props) => {
  const [open, setOpen] = useState(active > 0);
  const field = (name: string, label: string, unit: string) => <Field name={name} label={label} unit={unit} params={params} onParams={onParams} />;
  return (
    <Panel
      span={12}
      title={`Filtres${active ? ` · ${active} actif${active > 1 ? 's' : ''}` : ''}`}
      tools={
        <div style={{ display: 'flex', gap: 6 }}>
          {active > 0 && (
            <button type="button" className="cy-button ghost" onClick={() => onParams(Object.fromEntries(SCREEN_FILTER_KEYS.map((k) => [k, undefined])))}>
              Réinitialiser
            </button>
          )}
          <button type="button" className="cy-button ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? 'Masquer' : 'Afficher'}
          </button>
        </div>
      }>
      {open && (
        <div className="cy-filters" style={{ border: 0, padding: 0 }}>
          {field('budget', 'Budget (bien type)', '€')}
          {field('pmin', 'Prix min', '€/m²')}
          {field('pmax', 'Prix max', '€/m²')}
          {field('ymin', 'Rendement min', '%')}
          {field('ymax', 'Rendement max', '%')}
          <FilterField label="Cash-flow">
            <Segmented label="Cash-flow" options={[{ value: '', label: 'Tous' }, { value: 'pos', label: 'Positif' }]} value={params.cf === 'pos' ? 'pos' : ''}
              onChange={(v) => onParams({ cf: v || undefined })} />
          </FilterField>
          {field('popmin', 'Population min', 'hab.')}
          {field('popmax', 'Population max', 'hab.')}
          {field('vacmax', 'Vacance max', '%')}
          {field('fgmax', 'Passoires F/G max', '%')}
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
    </Panel>
  );
};
