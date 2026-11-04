// Search box over the published place index (communes, arrondissements, départements, régions).
import { useEffect, useState } from 'react';

import { loadIndex } from '../../data/api';
import { searchPlaces } from '../../data/search';
import type { GeoLevel, IndexPlace } from '../../data/types';

const LEVEL_SHORT: Record<GeoLevel, string> = {
  france: 'pays',
  region: 'région',
  departement: 'dép.',
  commune: 'commune',
  arrondissement: 'arr.',
};

export const PlaceSearch = ({
  onPick,
  placeholder = 'Rechercher une commune, un département…',
  exclude = [],
}: {
  onPick: (place: IndexPlace) => void;
  placeholder?: string;
  exclude?: string[];
}) => {
  const [places, setPlaces] = useState<IndexPlace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  useEffect(() => {
    loadIndex().then(setPlaces, (e: Error) => setError(e.message));
  }, []);
  const results = places
    ? searchPlaces(places, query).filter((p) => !exclude.includes(`${p.level}:${p.code}`)).slice(0, 8)
    : [];
  return (
    <div className="cy-search">
      <input
        className="cy-input"
        type="search"
        aria-label={placeholder}
        placeholder={error ? 'Index indisponible' : placeholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        disabled={Boolean(error)}
      />
      {results.length > 0 && (
        <ul className="cy-search-list" role="listbox">
          {results.map((place) => (
            <li key={`${place.level}:${place.code}`}>
              <button
                type="button"
                onClick={() => {
                  onPick(place);
                  setQuery('');
                }}>
                <span>{place.name}</span>
                <span className="ink-3">
                  {LEVEL_SHORT[place.level]} {place.level === 'commune' || place.level === 'arrondissement' ? place.departement : place.code}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
