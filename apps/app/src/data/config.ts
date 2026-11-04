// Where the published files live. On the web they sit next to the page (relative paths). A native app
// (webview DOM components) has no such server: EXPO_PUBLIC_SITE_URL points at the published site.

export const siteUrl = (site: string | undefined, path: string): string => `${(site ?? '').replace(/\/$/, '')}/${path}`;

const SITE = process.env.EXPO_PUBLIC_SITE_URL;

/** KPI files (pipeline serve layer). EXPO_PUBLIC_DATA_URL still wins for a separate data host. */
export const DATA_URL = process.env.EXPO_PUBLIC_DATA_URL ?? siteUrl(SITE ?? process.env.EXPO_BASE_URL, 'data');

/** Static files copied by scripts (MapLibre worker). */
export const assetUrl = (path: string): string => siteUrl(SITE ?? process.env.EXPO_BASE_URL, path);
