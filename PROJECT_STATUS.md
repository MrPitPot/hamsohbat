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

## 2026-11-01: standalone direction
- Removed everything that opened Discord from inside the app (Discord/VPN screen, Mihomo proxy core, WebView proxy code in desktop/app.cpp, installer/release/setup steps, proxy tests). The "Import from Discord" server-template import stays (it only reads a public template). desktop/app.cpp was edited without a Windows compiler: build it on Windows before releasing.
- Streams are capped at 720p/30 FPS (shared/voice.ts STREAM_MAX): screen share 2 Mbps, camera 1.2 Mbps; settings offer 360p15 / 480p30 / 720p30.
- Voice for server channels can now go through a LiveKit media server (SFU): server/livekit.ts (token), `POST /api/voice/token`, src/sfu.ts + voice.ts (remote audio/camera/screen arrive as plain MediaStreams). Enabled when LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are set; otherwise (and for DMs/group calls) voice stays peer-to-peer. Channel user limit can go up to 100.
- Tested here with a real LiveKit 1.13.11 built from source and real headless browsers: 3 people 11/11, 8 people 11/11, 16 people all hear each other (media server at ~6% of one core). Not tested: 100 people (needs the VPS: `lk load-test`, see selfhost/files/README-fa.md section 5), server-side enforcement of moderator mute, real internet/NAT conditions.
- Deployment files: selfhost/files/livekit.yaml, livekit.service, Caddyfile (voice subdomain), README-fa.md section 5.

## Experimental: Store (2026-11-01)
- Store page (rail bag icon, `/store`): name colours, avatar frames, profile effects, upload boost (50 MB files) and Hamsohbat Plus (30 days: badge, 20% off, Plus-only items, 50 MB files). Gifts to friends.
- Fake coins only: 1000 welcome coins, 100 daily, test coin packs that add coins without payment. A real gateway (e.g. Zarinpal) would replace `POST /api/store/packs/:id/buy` after verifying the payment.
- Code: shared/store.ts (catalog), server/store.ts (routes), src/Store.tsx + src/store.css. Tests: store 31.

## 1.7.0 (2026-10-15)
- Discord-through-proxy screen (src/DiscordProxy.tsx, app.cpp ProxyStart/DiscordOpen, hs-proxy.exe = Mihomo v1.19.32, SHA-256 pinned in setup-desktop.mjs). Tests: proxy 18, proxy-exe 9 (real exe). Not verified: logging in to Discord through a real VPN, Discord voice (UDP) through it.

