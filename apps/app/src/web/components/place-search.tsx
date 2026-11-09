// Search box over the published places, results grouped by level (docs/features/017-guided-levels/spec.md,
// principle 3): Départements, then Communes (arrondissements with their city). Callers route by `place.level`.
// The index (≈ 680 KB) loads on first focus or keystroke, never on page load (docs/features/018-speed-and-map).
import { useEffect, useState } from 'react';

import { loadFranceLevel, loadIndex } from '../../data/api';
import { cityOfArrondissement } from '../../data/commune-view';
import { departementPlaces, searchGrouped } from '../../data/search';
import type { IndexPlace } from '../../data/types';

const levelTag = (place: IndexPlace): string => {
  if (place.level === 'departement') {
    return `département ${place.code}`;
  }
  if (place.level === 'arrondissement') {
    const city = cityOfArrondissement(place.code);
    return `arrondissement${city ? ` · ${city.name}` : ''}`;
  }
  return `commune · ${place.departement ?? ''}`;
};

export const PlaceSearch = ({
  onPick,
  placeholder = 'Rechercher une commune, un département…',
  exclude = [],
  communesOnly = false,
}: {
  onPick: (place: IndexPlace) => void;
  placeholder?: string;
  exclude?: string[];
  /** Screens that need a town (property, simulator) hide the Départements group. */
  communesOnly?: boolean;
}) => {
  const [places, setPlaces] = useState<IndexPlace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [wanted, setWanted] = useState(false);
  useEffect(() => {
    if (!wanted) {
      return;
    }
    let current = true;
    // départements are not in the index: their names come from the France level file (shared with the France page);
    // a missing level file only costs that group
    const departements = communesOnly
      ? Promise.resolve([])
      : loadFranceLevel().then(
          (level) => departementPlaces([...level.types.apartment.rows, ...level.types.house.rows]),
          () => [],
        );
    Promise.all([loadIndex(), departements]).then(
      ([index, deps]) => current && setPlaces([...deps, ...index]),
      (e: Error) => current && setError(e.message),
    );
    return () => {
      current = false;
    };
  }, [wanted, communesOnly]);
  const loadingList = wanted && !places && !error && query.trim().length > 0;
  const groups = places
    ? searchGrouped(
        places.filter((p) => !exclude.includes(`${p.level}:${p.code}`) && !(communesOnly && p.level === 'departement')),
        query,
      )
    : [];
  return (
    <div className="cy-search">
      <input
        className="cy-input"
        type="search"
        aria-label={placeholder}
        placeholder={error ? 'Index indisponible' : placeholder}
        value={query}
        onFocus={() => setWanted(true)}
        onChange={(e) => {
          setWanted(true);
          setQuery(e.target.value);
        }}
        disabled={Boolean(error)}
      />
      {loadingList && (
        <ul className="cy-search-list" aria-label="Résultats" aria-busy="true">
          <li className="ink-3" style={{ padding: '5px 8px' }}>
            Chargement…
          </li>
        </ul>
      )}
      {groups.length > 0 && (
        <ul className="cy-search-list" aria-label="Résultats">
          {groups.map((group) => (
            <li key={group.key}>
              <div className="cy-search-group" role="presentation">
                {group.label}
              </div>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label={group.label}>
                {group.places.map((place) => (
                  <li key={`${place.level}:${place.code}`}>
                    <button
                      type="button"
                      onClick={() => {
                        onPick(place);
                        setQuery('');
                      }}>
                      <span>{place.name}</span>
                      <span className="ink-3">{levelTag(place)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
