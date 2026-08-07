# Security

Never open a GitHub issue containing a Nexus API key. The extension stores the key only in Firefox extension storage and deliberately excludes it from CSV, JSON, public-blocklist, and diagnostics exports.

If a key is exposed, revoke or regenerate it at Nexus Mods before reporting the incident. Report security-sensitive defects privately to the repository owner rather than attaching secrets or private list exports to a public issue.
