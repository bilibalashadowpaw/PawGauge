# Security

PawGauge reads API keys that already sit in your `~/.claude/settings.*.json` files, so how it handles them matters.

## What it does with your keys

- Keys are read from disk at poll time, used for one HTTPS request, and dropped. They are never cached, logged, written to disk or sent anywhere except the provider's own fixed endpoint (`src/main/providers/*.js`).
- The renderer is sandboxed (`sandbox`, `contextIsolation`, no Node integration) and has a strict content security policy. It never receives a key.
- The only thing the UI can ask the main process to open is a provider name; the URL comes from a table in the main process and must be `https://`.
- No telemetry, analytics or auto-update.

## What it stores

`prefs.json` (mascot on/off, account order) and `history.json` (balances and timestamps, used for the days-left estimate) in your app-data folder. Never keys.

## Reporting a problem

Please do not post a working exploit or a real key in a public issue. Open a private security advisory on the repository (Security tab, "Report a vulnerability"), or open an issue that says only "security report" and ask for a contact. If you ever pasted a key into an issue or log by mistake, rotate it at the provider right away.
