# Project status

**Version 1.6.0** — https://github.com/MrPitPot/hamsohbat

## Latest
- Server relay fallback (src/relay.ts + Hub binary forwarding): when two people cannot connect peer-to-peer, audio, camera and screen share are recorded (MediaRecorder), forwarded by the Hub and played via MediaSource. No TURN key / card needed.
- Music player and bot ideas removed (cancelled by the owner).
- Auto input sensitivity, extra-strong noise cancellation, TeamSpeak click-to-join and channel quality, retuned sounds.

## Tests (last run, all green)
ui 66 · voice 55 (includes relay audio/camera/screen) · desktop-ui 35 · teamspeak 40 · api 171 · features 96

## Known
- Relay mode uses more server requests/bandwidth; fine for small groups.
- Real-exe installer test is sensitive to an existing install on the machine.

## 1.6.1 — security review (2026-10-15)
- Repo/history scanned: no secrets, tokens or keys tracked (.dev.vars, server-url.txt, test users are ignored).
- Added: login/register throttling (429), 90-day session expiry, redirect re-check for link previews (SSRF), Discord-CDN-only import fetch, `public/_headers` (nosniff, X-Frame-Options, Referrer-Policy, Permissions-Policy).
- Known/open: no strict CSP yet (needs testing with WASM/AudioWorklet); uploaded files are readable by anyone with the unguessable URL; public OpenRelay TURN credentials are not secret.

## 1.6.2 (2026-10-15)
- CSP via <meta> in index.html (tested: ui 66, voice 55 with CSP-violation listeners).
- TeamSpeak: mic processing moved off the audio callback + underrun not shown as error; channel join on mouse-down; ping only from ping/pong (patched tsproto resend.rs, applied by scripts/setup-desktop.mjs).
- Planned/experimental: Discord via user-supplied proxy (needs proxy type/config from the user; user account gateway = Discord ToS risk).

## 1.7.0 (2026-10-15)
- Discord-through-proxy screen (src/DiscordProxy.tsx, app.cpp ProxyStart/DiscordOpen, hs-proxy.exe = Mihomo v1.19.32, SHA-256 pinned in setup-desktop.mjs). Tests: proxy 18, proxy-exe 9 (real exe). Not verified: logging in to Discord through a real VPN, Discord voice (UDP) through it.

