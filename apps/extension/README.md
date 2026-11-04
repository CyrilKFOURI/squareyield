# Extension "Analyser ce bien"

Opens the property dashboard of the app prefilled with the listing you are looking at.
Spec and legal frame: `docs/features/008-browser-extension/spec.md`.

## Install (developer mode, Chrome / Edge / Brave)
1. Start the app (`cd apps/app && npx expo start --web`) and, for the price check, the API (`cd ml && uv run rea-ml serve`).
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, pick this folder.
3. On a listing page, click the extension icon, check the fields, click **Ouvrir l'analyse**.

## Privacy
Permissions: `activeTab` and `scripting` only. The page is read once, when you click, in that tab only;
only price, surface, rooms, type, postcode and town are read; nothing is sent or stored by the extension.

## Tests
`node --test "test/*.test.js"` (no dependency).
