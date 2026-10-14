# Project status

**Version 1.4.0** — deployed target: Cloudflare Worker (see `server-url.txt`, not in git).

## Done
- Discord-style features (threads, forums, stage, polls, stickers, soundboard, events, webhooks, AutoMod, audit log, 2FA, Discord import), Persian + English.
- AI noise cancellation (GTCRN / RNNoise in an AudioWorklet); same RNNoise + gate in the TeamSpeak bridge.
- Windows app: own title bar, no browser menus, game activity, MSI installer, updater.
- TeamSpeak client: server log, ping/packet loss, user & server info, 3 chat kinds, channel create/edit/delete, nickname, talk power, ban, dialogs.

## Tests (last run, all green unless noted)
api 171 · features 96 · ui 65 · voice 50 · teamspeak 40 · desktop-ui 34 · cargo test 2 · desktop (real exe) 26/27*
\* installer step is sensitive to a pre-existing install on the machine; verified manually.

## Changed in the last step
`src/noise.ts`, `src/TeamSpeak.tsx`, `src/TitleBar.tsx`, `src/voice.ts`, `desktop/app.cpp`, `desktop/teamspeak/src/{main,audio}.rs`, tests, `scripts/{release,setup-desktop,check-i18n,merge-fa}.mjs`

## Remaining
- Deploy 1.4.0 to Cloudflare (`npx wrangler deploy` after `node scripts/release.mjs`).
- Publish repository to GitHub.
