// Contract between a route (native side, reads the URL) and its screen (DOM component).
import type { DOMProps } from 'expo/dom';

import type { Filters } from '../data/filters';

export type ScreenProps = {
  filters: Filters;
  /** Route parameters that are not filters (e.g. compare list, property form). */
  params: Record<string, string>;
  onFilters: (next: Partial<Filters>) => Promise<void>;
  onParams: (next: Record<string, string | undefined>) => Promise<void>;
  navigate: (href: string) => Promise<void>;
  dom?: DOMProps;
};
