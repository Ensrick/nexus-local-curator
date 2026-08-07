# Nexus Local Curator

## Purpose

This repository contains a Firefox-first WebExtension that filters Nexus Mods listings using a private local author list and records per-mod curation decisions.

## Constraints

- Do not require or transmit a Nexus API key for core behavior.
- Keep all user data in `browser.storage.local` unless the user explicitly exports it.
- Never scrape the Nexus catalog or automate bulk API collection.
- Prefer stable `data-e2eid` attributes, with conservative selector fallbacks.
- Never rewrite Nexus's server-provided global result total as if it were locally exact.
- Treat Nexus page content as untrusted. Use DOM APIs and `textContent`; do not inject page-provided HTML.
- Preserve backward compatibility with the January 2026 prototype's `blockedAuthors` and `blockedMods` string arrays.

## Verification

Run `npm run check`. It must pass unit tests, Mozilla lint, and packaging before delivery.
