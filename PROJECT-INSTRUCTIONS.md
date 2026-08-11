# SPARK Project Instructions

Paste this into the SPARK project's custom instructions in Claude, replacing
what's there. Everything below reflects the code as of v0.9.0.

---

## SPARK Project Instructions

**Project:** S.P.A.R.K. — Streaming Panel for Alerts, Redeems and Key tools
**Location:** `D:\Streamer Apps\SPARK` (Kyle's machine)
**Framework:** Tauri v2, Windows only
**GitHub:** https://github.com/TheITStreamer/S.P.A.R.K
**Overlay server:** port 4747 — but it SCANS 4747-4797 and takes the first free
one, so it is not guaranteed
**Data:** `%APPDATA%\com.spark.app\` — `spark-data.json`, `follower-cache.json`,
`profiles\<id>.json`, `fonts\`

### Building

```
rmdir /s /q src-tauri\target      (paths contain spaces; stale target breaks builds)
npm install
npm run build                     patch bump, then build
npm run build:minor               minor bump (0.9.x -> 0.10.0), then build
npm run build:major               major bump, then build
```

**THERE IS NO FRONTEND-ONLY SHORTCUT.** `tauri.conf.json` sets
`build.frontendDist = "../dist"` with no devUrl, so Tauri compiles the whole
frontend INTO the exe. Replacing `dist\` on disk changes nothing. Every change,
frontend or Rust, needs a full rebuild.

`bump.js` runs from npm's prebuild hook, so EVERY build bumps the version —
including builds that then fail to compile. The version routinely runs ahead of
the last released commit. That is expected.

---

### Architecture

**Rust** (`src-tauri/src/`):
- `lib.rs` — AppData, Shared state, persist helpers, profiles, follower cache,
  fonts, update check, keypresses, app entry, all command registration
- `overlay.rs` — tiny_http server (16 workers), serves overlay HTML/JS, fonts
- `twitch.rs` — device-code OAuth, token refresh, EventSub, IRC chat, and every
  Helix call (~107 Tauri commands across the two files)

**AppData fields:** wheel, giveaway, timers, tasks, goals, checkins,
songrequest, chat, counters, credits, diy, commands, broadcast, settings,
twitch_tokens, bot_tokens

**Frontend** (`dist/`) — one file per tab:
`app.js` (boot, help, update check), `store.js`, `utils.js`, `tab-chrome.js`
(sidebar, drag reorder, Ctrl+K), `fonts.js`, `reauth.js`, `profiles.js`,
`theme.js`, `audio.js`, `bar-renderer.js`, `overlay-common.js`, `diy-runtime.js`,
plus `*-tab.js` for: wheel, giveaway, timers, tasks, goals, checkins,
songrequest, chat, counters, credits, diy, commands, broadcast, settings.
`pomodoro.js` lives inside the Tasks tab.

**14 tabs:** Wheel, Giveaway, Timers, Tasks, Goals, Check-ins, Chat, Counters,
Commands, Credits, Song Request, D.I.Y, Broadcast, Settings.

**Navigation is a SIDEBAR, not a tab bar.** Vertical, collapses to icons,
drag to reorder (saved in settings.tabOrder), Ctrl+K jump box. The old overflow
menu is gone — do not reintroduce it.

**Overlays** (`dist/overlays/`): wheel, giveaway, timers, tasks, pomodoro,
goals, checkins, nowplaying, srqueue, chat, counters, credits, commands, master.
D.I.Y widgets are generated in Rust rather than being a file.

---

### Key technical rules

- **Never block boot.** Anything that could hang goes in the background.
- **Rust rebuild needed for everything.** See above.
- **Kyle cannot open DevTools** in production builds. Anything that fails
  silently is undiagnosable for him — always surface a real error.
- **Syntax check** JS with `node --check` before packaging.
- **HTML5 drag API is unreliable** in this WebView — use mousedown/mousemove.
  Every drag handle in SPARK does.
- **CSS variables** are unavailable in elements built outside DOM scope.
- **Remote calls go through Rust (reqwest), not browser fetch.** A webview
  fetch to a third-party origin failed silently for two whole releases. The
  only remaining frontend fetch is YouTube oEmbed.
- **GitHub API requires a User-Agent header** — reqwest does not set one.
- **Tauri optional arguments:** prefer sending explicit `null` over omitting a
  key, and do not widen the signature of a command with many callers.
- **Twitch scopes:** requesting scopes the app does not call can get the app
  suspended. Every scope in SCOPES must have a real call behind it.
- Twitch tokens: a refresh NEVER widens scopes. New permissions require a full
  logout and re-auth — the re-auth popup handles this automatically.

---

### Song Request — Pear Desktop

Connects to **Pear Desktop** (`pear-devs/pear-desktop`), not YTMDesktop.
Its API server is enabled in Pear's plugin menu with Auth set to None.
`!sr <url>` for subs/mods with a cooldown, channel point reward integration,
Now Playing overlay in three styles, blocked-songs list.

---

### Before building anything

Verify what you are going to do with Kyle first.

Read the actual files rather than working from memory — this document describes
the shape of things, not the current contents.

Kyle prefers plain language over jargon, and short answers over long ones.
