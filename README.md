# Nexus Local Curator

Nexus Local Curator is a Firefox-first WebExtension for maintaining an effectively unlimited local author filter, a per-mod shortlist, and an optional API-powered catalogue of unreviewed mods.

Normal Nexus-page filtering does not require an API key. The review stream uses a personal Nexus API key stored only in Firefox, requests ordinary Nexus source pages one at a time, filters them locally, and remembers the exact source position for each filter/sort combination.

## Features

- State-aware **Exclude/Include**, **Hide/Unhide**, **Keep/Unkeep**, and **Trim/Untrim** toggles directly on Nexus mod cards.
- Stable matching by Nexus user ID when the page exposes it, with a case-insensitive username fallback.
- Per-mod **Keep** shortlist, **Trim** shortlist for mods worth keeping only in part, and **Skip** decisions. Older **Maybe** decisions remain preserved and manageable.
- Two separate author filters: **Reviewed authors** for catalogs you have already checked and **Excluded authors** for creators you want nothing from.
- Immediate filtering of current and dynamically loaded cards.
- A persistent, lightweight review stream that never sends the full author blacklist to Nexus.
- Every filter or category visit checks page 1 for newly uploaded mods; **Resume backlog** returns to the saved older-work checkpoint.
- Recent **Previous** batch history is saved with each backlog checkpoint and survives Firefox restarts.
- Completely filtered source pages are skipped in bounded groups of at most fifty; an empty group pauses with its checked page range and a resumable cursor instead of chaining indefinitely.
- Requests remain one-at-a-time, stop at the first nonempty result, and never prefetch.
- Exclude and Hide use constant-time in-memory indexes, stable card controls, and batched background storage writes to keep clicks responsive with thousands of saved authors.
- Raw Nexus language/category suffixes are hidden because they do not reflect local author decisions.
- Temporary **Show Hidden**, **Show Blocked**, and **Show Skipped** controls that never alter saved decisions.
- A prominent **Show skipped mods** view in **Manage**, with direct links and removal controls for correcting skips.
- A count-labelled **Manage saved lists** menu for viewing skipped/kept/trimmed mods, hidden authors, excluded authors, or every list without rendering thousands of unrelated rows.
- Automatic Nexus-tab recovery after an extension update, with a short background-message retry before reloading an orphaned tab.
- A read-only **Local status** column on the Nexus Tracking Centre showing **Blocked**, **Hidden**, or **Good** for each mod author.
- Author profile catalogues remain visible even for excluded or hidden authors; only individually skipped mods are removed there.
- Normal grid reflow with no empty card-sized gaps.
- Separate counts for hidden authors/mods, excluded authors/mods, skipped mods, kept candidates, and trimmed candidates.
- CSV export/import for long-lived curation data.
- JSON full backup.
- Automatic last-change recovery snapshot with one-click restoration.
- A guarded Firefox-page queue for clearing Nexus's existing ignored-user list with selectable pacing and server-confirmed progress.
- Automatic migration from the January 2026 prototype's string lists.

## Install for personal testing

1. Open Firefox and visit `about:debugging`.
2. Select **This Firefox**.
3. Select **Load Temporary Add-on**.
4. Choose `extension/manifest.json` from this repository.
5. Open a Nexus Mods listing. Each recognised mod card receives curation controls.

Temporary add-ons unload when Firefox exits. The fixed Gecko extension ID preserves a consistent identity during development, but normal permanent installation still requires Mozilla signing on standard Firefox.

## Permanent Firefox installation and updates

Release and Beta Firefox require Mozilla to sign an extension before it can remain installed. For a public extension with automatic updates:

1. Run `npm run check` and use the generated ZIP from `web-ext-artifacts/`.
2. Sign in to the [AMO Developer Hub](https://addons.mozilla.org/developers/addon/submit/distribution).
3. Submit the ZIP and choose distribution **On this site**.
4. Complete the listing and wait for Mozilla validation or review.
5. Install the approved extension from its Firefox Add-ons page.

Firefox then keeps the extension across restarts and automatically installs each higher version published to the same AMO listing. Never commit or share AMO API credentials. Existing local curation data remains associated with the fixed extension ID `nexus-local-curator@danjo.local`.

For a private, permanent installation without a public AMO listing:

1. Create AMO API credentials from the [AMO API keys page](https://addons.mozilla.org/developers/addon/api/key/).
2. Run `npm run sign:unlisted`.
3. Enter the JWT issuer and hidden JWT secret when prompted. They exist only in the signing process environment and are not written to the repository.
4. After Mozilla accepts the submission, open `about:addons`, select **Install Add-on From File**, and choose the signed `.xpi` in `web-ext-artifacts/`.

An unlisted signed XPI remains installed in standard Firefox but is updated manually: increase the extension version, sign the new build through the same AMO add-on identity, and install the newer XPI.

## Share the extension privately

Share only the Mozilla-signed `.xpi` from the release folder. The recipient opens the file in Firefox and approves **Add**. The package contains extension code and artwork only: API keys, local author/mod lists, recovery snapshots, and diagnostics remain in the originating Firefox profile and are not bundled. Because this is an unlisted private build, future updates must be shared and installed as a newer signed `.xpi`.

## Clear the Nexus-side blocked-author list

1. Open `https://www.nexusmods.com/settings/content-blocking` while signed in.
2. Use the bottom-right **Nexus blocked authors** panel.
3. Select a queue speed, choose **Start verified queue**, and confirm the destructive action.
4. Keep the page open until the panel reports completion, or use **Stop** to halt the queue.

The queue operates only on username controls inside the ignored-users section. It waits for each username to disappear before counting the removal, pauses for 30 seconds after every 100 confirmations, and stops if Nexus displays an error or fails to confirm a removal. This does not alter the extension's separate local author list.

## Development

Requires Firefox 142 or newer and a current Node.js LTS release.

```powershell
npm install
npm run check
```

`npm run check` runs unit tests, Mozilla's extension linter, and creates a ZIP in `web-ext-artifacts/`.

For an isolated development browser:

```powershell
npx web-ext run --source-dir extension
```

Do not use `--keep-profile-changes` with your everyday Firefox profile.

## Counts and pagination

With an API key configured, the extension replaces the listing with the first Nexus source page containing locally visible mods. Entering any filter/sort context starts from page 1 so new uploads cannot be hidden by an older saved cursor. **Resume backlog** restores that context's saved checkpoint, while **Check newest** returns to page 1 without discarding it. Completely filtered pages are checked in the extension background rather than transferred into the Nexus tab. The scanned source-page range is displayed honestly because an exact post-filtered total is unavailable without scanning the full catalogue. Hiding cards uses `display: none`, so CSS grid and flex layouts reflow without empty spaces.

## API key

The normal page filter needs no API key. The review stream requires a personal Nexus API key. Import the key's text file in **Manage**; the key remains in Firefox's extension storage and is excluded from CSV/JSON exports. The 80-result Nexus option remains supported. Requests run sequentially, stop at the first page with visible content, and pause after at most fifty empty source pages or two minutes. Nexus's current API limits and acceptable-use rules still apply.

## Privacy

See [PRIVACY.md](PRIVACY.md).
