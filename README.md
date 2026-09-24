# Data 360 Inspector — Browser Extension

Chrome (MV3) + Firefox (MV3) extension for Salesforce Data Cloud / Data 360. Adds a
floating launcher on Data 360 pages to reveal API names on the mapping canvas and
export DLO / Data Stream / DMO field mappings.

Read-only — nothing is sent anywhere. Everything runs in your browser using data
the page already loaded.

## Layout
- `chrome/`  — Chrome MV3. Load: `chrome://extensions` → Developer mode → Load unpacked → pick `chrome/`.
- `firefox/` — Firefox MV3 (needs Firefox 128+). Load: `about:debugging` → This Firefox → Load Temporary Add-on → pick `firefox/manifest.json`.

## Features
- Mapping canvas: Hover / Pin API names (duplicate-label safe), Export mappings (DLO→DMO)
- DLO / Data Stream / DMO detail pages: Export Fields (API names, labels, types)

This is the **public, store-safe build** (mapping + Data Stream + DLO + DMO). In-dev
features and internal integrations are not included.

## Source
Built artifacts only. Source of truth is a private repo; do not hand-edit `inject.js`.
