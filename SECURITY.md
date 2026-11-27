# Security

PawGauge reads API keys that already sit in your Claude Code settings files (`settings.json`, `settings.*.json`), so how it handles them matters.

## What it does with your keys

- Keys are read from disk at poll time, used for one HTTPS request, and dropped. They are never cached, logged, copied elsewhere on disk (see the `settings.json` rewrite below) or sent anywhere except the provider's own fixed endpoint (`src/main/providers/*.js`).
- A key from a settings file is sent only when the file's `ANTHROPIC_BASE_URL` is on one of that provider's own domains, matched as whole domains and checked each time the key is read. The one exception is a file with no address that you assigned to a provider yourself, in `accounts.json` or on the Accounts screen. The screen asks in a system dialog that names the file and the destination, with Cancel as the default. Versions up to 0.4.40 matched MiniMax and DeepSeek by a word in the host name, so a relay with that word in its address could have its key sent to that provider. If that applied to you, rotate the relay key.
- The Accounts screen in the window shows account names, file names, host names and the reason a file was skipped. It never receives a key or a whole URL. Account choices change only PawGauge's own `accounts.json`, and only files directly inside Claude Code's folder can be added.
- The one change PawGauge can make to a Claude Code file is the top-level `statusLine` entry in `settings.json` (Claude usage setup, Windows). It happens after a system dialog that shows the entry, with Cancel as the default, or as removal when PawGauge is uninstalled. The entry is inserted or cut as text, so the rest of the file stays byte for byte; no backup is made. Because the file is rewritten, any key in it is carried over unchanged, through a temporary file beside it that is renamed over the original (one stranded by a crash is deleted the next time PawGauge starts). Another status line is never replaced or removed, and nothing is written if the file changed after you were asked. That status line runs PawGauge's PowerShell script with `-ExecutionPolicy Bypass`. The script (`tools/statusline-snapshot.ps1`) saves only `rate_limits` and sends nothing anywhere.
- The renderer is sandboxed (`sandbox`, `contextIsolation`, no Node integration) and has a strict content security policy. It never receives a key.
- The only thing the UI can ask the main process to open is a provider name; the URL comes from a table in the main process and must be `https://`.
- No telemetry, analytics or auto-update.

## What it stores

`prefs.json` (mascot on/off, account order) and `history.json` (balances and timestamps, used for the days-left estimate) in your app-data folder. Never keys.

## Reporting a problem

Please do not post a working exploit or a real key in a public issue. Open a private security advisory on the repository (Security tab, "Report a vulnerability"), or open an issue that says only "security report" and ask for a contact. If you ever pasted a key into an issue or log by mistake, rotate it at the provider right away.
