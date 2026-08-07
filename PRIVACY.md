# Privacy

Nexus Local Curator stores excluded authors, hidden/reviewed authors, mod decisions, settings, timestamps, source URLs, and (when imported) a personal Nexus API key in Firefox's `browser.storage.local` area.

- No analytics or telemetry.
- No access to browser history, cookies, credentials, or unrelated websites.
- Normal Nexus-page filtering makes no extension-initiated network requests.
- The curated catalogue sends the personal API key, the selected game/sort, local excluded/hidden author IDs or names, and reviewed mod IDs directly to `api.nexusmods.com`. It requests at most 80 mod records at a time.
- The API key is not included in CSV or JSON exports.
- No curation or API data is sent to the extension developer or any third party other than Nexus Mods.

The extension has host permission for `www.nexusmods.com` and `next.nexusmods.com` so its content script can identify and filter mod cards, and for `api.nexusmods.com` for the optional curated catalogue.
