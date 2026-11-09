// Where the published files live. On the web they sit next to the page (relative paths). A native app
// (webview DOM components) has no such server: EXPO_PUBLIC_SITE_URL points at the published site.

export const siteUrl = (site: string | undefined, path: string): string => `${(site ?? '').replace(/\/$/, '')}/${path}`;

const SITE = process.env.EXPO_PUBLIC_SITE_URL;

/** KPI files (pipeline serve layer). EXPO_PUBLIC_DATA_URL still wins for a separate data host. */
export const DATA_URL = process.env.EXPO_PUBLIC_DATA_URL ?? siteUrl(SITE ?? process.env.EXPO_BASE_URL, 'data');

/** Static files copied by scripts (MapLibre worker). */
export const assetUrl = (path: string): string => siteUrl(SITE ?? process.env.EXPO_BASE_URL, path);

const RETRY_DELAYS_MS = [300, 1000, 2500];

/** fetch that retries a failed connection (not an HTTP error, not an abort): some networks reset the first
 * connections to the data host (seen on IPv6 to huggingface.co), and phones switch networks. */
export const fetchRetry = async (url: string, init?: RequestInit): Promise<Response> => {
  for (const delay of RETRY_DELAYS_MS) {
    try {
      return await fetch(url, init);
    } catch (error) {
      if (init?.signal?.aborted) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return fetch(url, init);
};
