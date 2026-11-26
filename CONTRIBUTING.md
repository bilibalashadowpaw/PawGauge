# Contributing

Bug reports and pull requests are welcome.

## Licence of contributions

- Code, tests, docs and tooling you contribute are licensed under the **MIT licence** (see `LICENSE`), the same as the rest of the code. By opening a pull request you confirm you wrote it (or have the right to submit it) and agree to that.
- **Do not contribute ShadowBlack artwork or anything derived from it** (redraws, recolours, new poses, sprites). It is all rights reserved (see `ART-LICENSE.md`), and contributed art would carry unclear rights. Pull requests that add or change files under `src/mascot/` or `src/assets/tray/`, or the icon files in `build/` and `docs/`, will be declined. Fixes to the mascot's *code* (`src/mascot/*.js`, `*.css`, `*.html`) are fine.
- Do not add third-party code, icons or fonts without their licence. If you do add one, list it in `THIRD_PARTY_NOTICES.md`.

## Before you open a pull request

- `npm test` passes.
- Never include a real API key, a real balance or your own account names in code, tests, screenshots or issues. Use the demo data (`npm start -- --demo`).
- Security problems: see `SECURITY.md`, not a public issue.
