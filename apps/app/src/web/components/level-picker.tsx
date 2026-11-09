// Département / Commune step of the Marché path as a dropdown (docs/features/020-sidebar-filters/spec.md, design
// item 2): search (code or name, accents ignored) above a scrollable list with each place's median €/m², keyboard
// ↑ ↓ Entrée Échap. The list only loads when the dropdown opens (both files are cached and shared with the pages).
// The panel is position: fixed from the button's box, so `.cy-main { overflow: hidden }` cannot clip it.
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';

import { loadDepartementLevel, loadFranceLevel } from '../../data/api';
import { formatCount } from '../../data/format';
import { communeItems, departementItems, filterItems, levelHref, moveActive, type PickerItem } from '../../data/level-picker';
import type { DwellingType } from '../../data/types';
import type { Navigate } from './shell';

type Kind = 'departement' | 'commune';

const loadItems = (kind: Kind, dep: string, type: DwellingType): Promise<PickerItem[]> =>
  kind === 'departement'
    ? loadFranceLevel().then((level) => departementItems({ apartment: level.types.apartment.rows, house: level.types.house.rows }, type))
    : loadDepartementLevel(dep).then((level) =>
        communeItems({ apartment: level.types.apartment?.communes ?? [], house: level.types.house?.communes ?? [] }, type),
      );

const PANEL_WIDTH = 400;
const LIST_MAX = 360;
const PAGE = 10;

/** Where the panel goes: under the button, kept inside the window (600 px wide screens included). */
type Layout = { top: number; left: number; width: number; listMax: number };
const layoutOf = (button: HTMLElement | null): Layout | null => {
  if (!button) {
    return null;
  }
  const box = button.getBoundingClientRect();
  const width = Math.min(PANEL_WIDTH, window.innerWidth - 16);
  const left = Math.max(8, Math.min(box.left, window.innerWidth - width - 8));
  // search box + column heads take about 70 px
  const listMax = Math.max(140, Math.min(LIST_MAX, window.innerHeight - box.bottom - 86));
  return { top: box.bottom, left, width, listMax };
};

const ChevronDown = () => (
  <svg className="cy-level-caret" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
    <path d="M2 3.5l3 3 3-3" />
  </svg>
);

export const LevelPicker = ({
  kind,
  dep = '',
  step,
  label,
  value,
  state,
  here,
  disabled = false,
  currentCode,
  type,
  query,
  listLabel,
  navigate,
}: {
  kind: Kind;
  /** Département whose communes are listed (commune picker). */
  dep?: string;
  step: number;
  label: string;
  /** Button text: the current place, or what to do. */
  value: string;
  state: 'current' | 'done' | 'todo';
  /** This page is the current place: choosing it again only closes the list. */
  here: boolean;
  disabled?: boolean;
  currentCode?: string;
  type: DwellingType;
  /** `?type=…` kept on the chosen page. */
  query: string;
  listLabel: string;
  navigate: Navigate;
}) => {
  const id = useId();
  const listId = `${id}-list`;
  const optionId = (i: number) => `${id}-opt-${i}`;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [search, setSearch] = useState('');
  /** Highlighted row; null = the current place (or the first row) until a key or the mouse moves it. */
  const [active, setActive] = useState<number | null>(null);
  const key = `${kind}:${dep}:${type}`;
  const [list, setList] = useState<{ key: string; items?: PickerItem[]; error?: string } | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    let current = true;
    loadItems(kind, dep, type).then(
      (items) => current && setList({ key, items }),
      (e: Error) => current && setList({ key, error: e.message }),
    );
    return () => {
      current = false;
    };
  }, [open, kind, dep, type, key]);

  // while open: focus the search box, close on a click elsewhere, follow the button when the window changes
  useEffect(() => {
    if (!open) {
      return;
    }
    inputRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !buttonRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onMove = (event: Event) => {
      if (!(event.target instanceof Node && panelRef.current?.contains(event.target))) {
        setLayout(layoutOf(buttonRef.current));
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open]);

  const loaded = list?.key === key ? list : null;
  const items = loaded?.items ?? [];
  const shownItems = filterItems(items, search);
  const currentIndex = shownItems.findIndex((item) => item.code === currentCode);
  const shown = shownItems.length === 0 ? -1 : (active ?? Math.max(0, currentIndex));

  // keep the highlighted row visible inside the list (the list scrolls, never the page)
  const centred = active === null;
  useEffect(() => {
    const listEl = listRef.current;
    const row = shown >= 0 ? (listEl?.children[shown] as HTMLElement | undefined) : undefined;
    if (!open || !listEl || !row) {
      return;
    }
    if (centred) {
      // first view of the list: the current place sits in the middle, with its neighbours around it
      listEl.scrollTop = row.offsetTop - (listEl.clientHeight - row.offsetHeight) / 2;
    } else if (row.offsetTop < listEl.scrollTop) {
      listEl.scrollTop = row.offsetTop;
    } else if (row.offsetTop + row.offsetHeight > listEl.scrollTop + listEl.clientHeight) {
      listEl.scrollTop = row.offsetTop + row.offsetHeight - listEl.clientHeight;
    }
  }, [open, shown, shownItems.length, centred]);

  const openPanel = () => {
    setLayout(layoutOf(buttonRef.current));
    setSearch('');
    setActive(null);
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) {
      buttonRef.current?.focus();
    }
  };
  const choose = (item: PickerItem) => {
    setOpen(false);
    if (item.code === currentCode && here) {
      buttonRef.current?.focus();
      return;
    }
    navigate(levelHref(item, query));
  };

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    const moves: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: PAGE, PageUp: -PAGE };
    if (event.key in moves) {
      event.preventDefault();
      setActive(moveActive(shown, moves[event.key], shownItems.length));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = shownItems[shown];
      if (item) {
        choose(item);
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'Tab') {
      setOpen(false); // focus moves on to the next control
    }
  };

  const withCount = kind === 'commune';
  const noun =
    kind === 'departement'
      ? 'départements'
      : items.length > 0 && items.every((item) => item.level === 'arrondissement')
        ? 'arrondissements'
        : 'communes';
  const status = disabled
    ? null
    : !loaded
      ? 'Chargement…'
      : loaded.error
        ? 'Liste indisponible pour le moment.'
        : shownItems.length === 0
          ? 'Aucun résultat.'
          : null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`cy-step cy-level ${state}${disabled ? ' disabled' : ''}${open ? ' open' : ''}`}
        aria-current={here ? 'step' : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`${label} : ${value}`}
        disabled={disabled}
        onClick={() => (open ? close(false) : openPanel())}
        onKeyDown={(event) => {
          if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !open) {
            event.preventDefault();
            openPanel();
          }
        }}>
        <b>{step}</b>
        <span>
          <small>{label}</small>
          <em>{value}</em>
        </span>
        <ChevronDown />
      </button>
      {open && layout && (
        <div
          ref={panelRef}
          className="cy-level-panel"
          style={{ top: layout.top, left: layout.left, width: layout.width }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              close(true);
            }
          }}>
          <div className="cy-level-search">
            <input
              ref={inputRef}
              className="cy-input"
              type="text"
              role="combobox"
              aria-label={`Rechercher (${kind === 'departement' ? 'numéro ou nom' : 'nom ou code'})`}
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={shown >= 0 ? optionId(shown) : undefined}
              placeholder={kind === 'departement' ? 'Numéro ou nom : 33, gir…' : 'Nom ou code INSEE…'}
              autoComplete="off"
              spellCheck={false}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setActive(0);
              }}
              onKeyDown={onSearchKey}
            />
          </div>
          <div className={`cy-level-row cy-level-head${withCount ? ' count' : ''}`} aria-hidden>
            <span>Code</span>
            <span>
              {loaded?.items ? (search.trim() ? `${shownItems.length} sur ${items.length} ${noun}` : `${items.length} ${noun}`) : noun}
            </span>
            <span>€/m² {type === 'house' ? 'maisons' : 'appart.'}</span>
            {withCount && <span>Ventes</span>}
          </div>
          {status && <p className="cy-level-status">{status}</p>}
          <ul ref={listRef} id={listId} role="listbox" aria-label={listLabel} className="cy-level-list" style={{ maxHeight: layout.listMax }}>
            {shownItems.map((item, i) => {
              const isCurrent = item.code === currentCode;
              return (
                <li
                  key={item.code}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === shown}
                  className={`cy-level-row${withCount ? ' count' : ''}${i === shown ? ' active' : ''}${isCurrent ? ' current' : ''}`}
                  onMouseMove={() => i !== shown && setActive(i)}
                  onMouseDown={(event) => event.preventDefault() /* keep the focus in the search box */}
                  onClick={() => choose(item)}>
                  <span className="cy-level-code">{item.code}</span>
                  <span className="cy-level-name">
                    {item.name}
                    {isCurrent && <span className="cy-level-here"> · actuel</span>}
                  </span>
                  <span className="cy-level-num">{formatCount(item.price == null ? null : Math.round(item.price))}</span>
                  {withCount && <span className="cy-level-num ink-3">{formatCount(item.n)}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </>
  );
};
