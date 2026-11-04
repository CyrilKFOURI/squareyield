# Cyfouri app (web + iOS/Android)

Expo SDK 58 + Expo Router. Every dashboard screen is an Expo DOM component (`src/web/screens`, `'use dom'`):
React DOM + CSS on the web, the same screen in a webview on iOS and Android. The app only reads the KPI
files published by the pipeline; it computes nothing heavy.

## Run on the web
```bash
npm install            # also copies the MapLibre worker to public/vendor
cd ../../pipeline && uv run rea sync-app && cd ../apps/app   # KPI files into public/data
npx expo start --web
```

## Checks
```bash
npm test               # unit tests (data helpers, core-kpi deal maths)
npx tsc --noEmit
npx expo lint
```

## Mobile app
The phone has no local server for the KPI files: set `EXPO_PUBLIC_SITE_URL` to the published web export
(it serves `data/` and `vendor/`): in `.env` for development, and as an EAS environment variable for builds
(`eas env:create --name EXPO_PUBLIC_SITE_URL --value https://<your-site>`). Use only a site you own: the app
loads the map worker script from it.
```bash
npx expo start                                   # Expo Go / development build
npm install -g eas-cli && eas login              # your Expo account
eas build -p android --profile preview           # installable APK
eas build -p ios --profile preview               # iOS simulator build
```
The price-check API (`ml`, `uv run rea-ml serve`) stays on your computer: it returns individual DVF sales,
which are never published. On a phone the property page shows the market, rent and money panels without it.

## Layout
- `src/app/` routes (thin wrappers: URL → filters)
- `src/web/` screens, components, charts (ECharts), maps (MapLibre), styles (`docs/UI_UX.md`)
- `src/data/` loaders, filters, selection helpers, KPI catalogue
- `src/core-kpi/` deal maths and French rules (no React), shared with the pipeline through fixtures
