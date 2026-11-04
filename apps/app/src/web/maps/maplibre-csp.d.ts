// The CSP build has the same API as the main entry; only its worker is loaded separately.
declare module 'maplibre-gl/dist/maplibre-gl-csp' {
  export * from 'maplibre-gl';
}
