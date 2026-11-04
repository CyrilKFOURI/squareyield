'use dom';

// Méthode & glossaire: every indicator of the catalogue, the sources and the comparability rules.
import { useState } from 'react';

import { KPI_CATALOGUE, type KpiEntry } from '../../data/catalogue';
import { Segmented } from '../components/controls';
import { DataTable } from '../components/data-table';
import { Panel } from '../components/panel';
import { Shell } from '../components/shell';
import type { ScreenProps } from '../screen-props';

type Family = 'all' | 'M' | 'D' | 'X';

const FAMILIES: { value: Family; label: string }[] = [
  { value: 'all', label: 'Tous' },
  { value: 'M', label: 'Marché' },
  { value: 'D', label: 'Opération' },
  { value: 'X', label: 'Compléments' },
];

const SEGMENT_LABELS: Record<string, string> = {
  type: 'type',
  size: 'taille',
  condition: 'ancien/neuf',
  period: 'période',
  area: 'territoire',
};

const SOURCES = [
  ['DVF', 'DGFiP', 'Ventes signées 2021-S2 → 2026-S1, mises à jour semestrielles', 'Licence Ouverte (pas de réidentification, pas d’indexation)'],
  ['Carte des loyers', 'ANIL / DHUP', 'Loyers d’annonce 2025, non meublés, charges comprises', 'Licence Ouverte'],
  ['Observatoires locaux des loyers', 'Réseau OLL', 'Loyers en place 2014–2025, 72 agglomérations', 'Licence Ouverte'],
  ['Recensement, Filosofi', 'INSEE', 'Population, logements, revenus, emploi', 'Licence Ouverte'],
  ['DPE logements existants', 'ADEME', 'Diagnostics depuis juillet 2021', 'Licence Ouverte'],
  ['REI', 'DGFiP', 'Taux de taxe foncière votés', 'Licence Ouverte'],
  ['Contours administratifs', 'Etalab', 'Communes et départements simplifiés', 'Licence Ouverte'],
];

const RULES = [
  'Un appartement se compare à des appartements, une maison à des maisons : la vue « ensemble » n’est jamais classée ni cartographiée.',
  'Chaque chiffre appartient à une cellule : territoire × type × taille × ancien/neuf × période.',
  'Publié à partir de 10 ventes ; « fiabilité faible » sous 30 ; classements, scores et couleurs de carte à partir de 30.',
  'Le loyer est lu à la surface médiane de la cellule (le loyer au m² baisse quand la surface augmente).',
  'Prix = ventes passées signées (DVF) ; loyers ANIL = annonces actuelles ; loyers OLL = loyers en place.',
  'Années incomplètes comparées par semestre seulement.',
  'Aucune vente individuelle n’est publiée : le grain le plus fin est la section cadastrale avec au moins 10 ventes.',
];

export default function MethodScreen({ navigate }: ScreenProps) {
  const [family, setFamily] = useState<Family>('all');
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const rows = KPI_CATALOGUE.filter(
    (k) =>
      (family === 'all' || k.id.startsWith(family)) &&
      (!q || `${k.id} ${k.label} ${k.definition}`.toLowerCase().includes(q)),
  );
  return (
    <Shell active="method" title="Méthode & glossaire" navigate={navigate}>
      <div className="cy-grid">
        <Panel
          title={`Indicateurs (${rows.length})`}
          flush
          tools={
            <>
              <input
                className="cy-input"
                style={{ width: 220 }}
                placeholder="Chercher un indicateur"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Chercher un indicateur"
              />
              <Segmented label="Famille" options={FAMILIES} value={family} onChange={setFamily} />
            </>
          }>
          <DataTable<KpiEntry>
            rows={rows}
            rowKey={(k) => k.id}
            columns={[
              { key: 'id', label: 'Id', render: (k) => <span className="ink-3">{k.id}</span> },
              { key: 'label', label: 'Indicateur', render: (k) => <b style={{ fontWeight: 500 }}>{k.label}</b> },
              { key: 'unit', label: 'Unité', render: (k) => <span className="ink-2">{k.unit}</span> },
              {
                key: 'definition',
                label: 'Définition et lecture',
                render: (k) => (
                  <div style={{ whiteSpace: 'normal', minWidth: 360, maxWidth: 620 }}>
                    {k.definition}
                    {k.howToRead && <div className="ink-3">{k.howToRead}</div>}
                  </div>
                ),
              },
              {
                key: 'segments',
                label: 'Varie selon',
                render: (k) => (
                  <span className="ink-2">
                    {k.segments.length ? k.segments.map((s) => SEGMENT_LABELS[s]).join(', ') : 'vos hypothèses'}
                  </span>
                ),
              },
              {
                key: 'source',
                label: 'Source',
                render: (k) => <div style={{ whiteSpace: 'normal', maxWidth: 280 }} className="ink-2">{k.source}</div>,
              },
            ]}
          />
        </Panel>
        <Panel title="Sources" span={7} flush>
          <DataTable<string[]>
            rows={SOURCES}
            rowKey={(s) => s[0]}
            columns={[
              { key: 'name', label: 'Jeu de données', render: (s) => <b style={{ fontWeight: 500 }}>{s[0]}</b> },
              { key: 'producer', label: 'Producteur', render: (s) => s[1] },
              { key: 'scope', label: 'Contenu', render: (s) => <span className="ink-2">{s[2]}</span> },
              { key: 'licence', label: 'Licence', render: (s) => <span className="ink-3">{s[3]}</span> },
            ]}
          />
        </Panel>
        <Panel title="Règles de comparaison" span={5}>
          <ol style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 8 }}>
            {RULES.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ol>
        </Panel>
      </div>
    </Shell>
  );
}
