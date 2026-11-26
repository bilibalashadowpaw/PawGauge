# Security

PawGauge reads API keys that already sit in your Claude Code settings files (`settings.json`, `settings.*.json`), so how it handles them matters.

## What it does with your keys

- Keys are read from disk at poll time, used for one HTTPS request, and dropped. They are never cached, logged, written to disk or sent anywhere except the provider's own fixed endpoint (`src/main/providers/*.js`).
- A key from a settings file is sent only when the file's `ANTHROPIC_BASE_URL` is on one of that provider's own domains, matched as whole domains and checked each time the key is read. The one exception is a file with no address that you assigned to a provider yourself in `accounts.json`. Versions up to 0.4.40 matched MiniMax and DeepSeek by a word in the host name, so a relay with that word in its address could have its key sent to that provider. If that applied to you, rotate the relay key.
- The account check in the window shows file names, host names and the reason a file was skipped. It never receives a key or a whole URL.
- The renderer is sandboxed (`sandbox`, `contextIsolation`, no Node integration) and has a strict content security policy. It never receives a key.
- The only thing the UI can ask the main process to open is a provider name; the URL comes from a table in the main process and must be `https://`.
- No telemetry, analytics or auto-update.

## What it stores

`prefs.json` (mascot on/off, account order) and `history.json` (balances and timestamps, used for the days-left estimate) in your app-data folder. Never keys.

## Reporting a problem

Please do not post a working exploit or a real key in a public issue. Open a private security advisory on the repository (Security tab, "Report a vulnerability"), or open an issue that says only "security report" and ask for a contact. If you ever pasted a key into an issue or log by mistake, rotate it at the provider right away.
