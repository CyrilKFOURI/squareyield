// Route side of a dashboard screen: URL params in, filter changes and navigation out.
import { type Href, router, useLocalSearchParams } from 'expo-router';

import { DEFAULT_FILTERS, type Filters, parseFilters, toParams } from '@/data/filters';

const FILTER_KEYS = Object.keys(DEFAULT_FILTERS);

export const useScreen = () => {
  const raw = useLocalSearchParams<Record<string, string>>();
  const filters = parseFilters(raw);
  const params = Object.fromEntries(
    Object.entries(raw).filter(([key, value]) => !FILTER_KEYS.includes(key) && typeof value === 'string'),
  ) as Record<string, string>;
  return {
    filters,
    params,
    onFilters: async (next: Partial<Filters>) => {
      const merged = toParams({ ...filters, ...next });
      // keys back to their default are removed from the URL
      router.setParams(Object.fromEntries(FILTER_KEYS.map((key) => [key, merged[key]])) as never);
    },
    onParams: async (next: Record<string, string | undefined>) => {
      router.setParams(next as never);
    },
    navigate: async (href: string) => {
      router.push(href as Href);
    },
  };
};
