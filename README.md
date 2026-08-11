# S.P.A.R.K. (BETA)
Some things may be a little janky/not work properly.

Streaming Panel for Alerts, Redeems and Key-tools. A Windows app for Twitch streamers. Everything will run locally on your PC.

## A.I Disclaimer
I do not claim to be a programmer or having made this. Yes, I prompted Claude and reviewed, tested, self QA'd and tweaked. I knew
what the outcomes should be and understand the issues enough to be able to redirect Claude to be able to fix as I do have an IT
background. I completely understand if you do not trust this project but I wanted to make it clear that I orginally made this for
just myself and decided to share incase someone else was interested. I do not claim to be the creator, I just gave prompts and if
it was good, I went with it. 

## What it does

* **Broadcast** - your title, category and tags without leaving SPARK, with saved presets that set all three at once. Live chat with timeout, ban, delete and pin. Raid, shoutout, polls and predictions with saved templates. Emote only, subs only and followers only chat, ad breaks and snooze.
<!-- SCREENSHOT NEEDED: Broadcast tab -->

* **Wheel** - spin a wheel to pick from a list. Can be triggered by channel point redeems.
<img width="1402" height="932" alt="image" src="https://github.com/user-attachments/assets/397f7c07-2cc8-4548-8957-399afa047894" />

* **Giveaway** - viewers enter by typing a word in chat. Draw a winner with a slot machine overlay.
<img width="1402" height="932" alt="image" src="https://github.com/user-attachments/assets/9a5ced5f-b9ac-4b3d-b06e-2dc0d00caf52" />

* **Timers** - countdown or stopwatch timers, started manually, by redeem, or by chat command.
<img width="1402" height="932" alt="image" src="https://github.com/user-attachments/assets/d4704883-5e89-47cb-87d6-f13d0a293884" />

* **Tasks** - shared to do list for you and your viewers using `!task` commands as well as a pomodoro timer with its own commands. 
<img width="1402" height="932" alt="image" src="https://github.com/user-attachments/assets/a4118f4d-7e34-4ba1-9c1e-060433a66c63" />

* **Goals** - animated progress bars for followers, subs, bits, or custom chat commands.
<img width="1402" height="932" alt="image" src="https://github.com/user-attachments/assets/36a9744d-dde6-4362-abe2-07b3a60f761e" />

* **Check-ins** - popup when a viewer redeems a check-in reward, with lifetime counts.
<img width="1402" height="932" alt="image" src="https://github.com/user-attachments/assets/f782b22b-772c-4c43-99ac-159d8ddbecf5" />

* **Chat** - fully styled chat overlay with per role colors, follow and sub alerts, and animated emotes.
<img width="1402" height="932" alt="image" src="https://github.com/user-attachments/assets/b2609e5c-4c78-4d88-8bc0-bd8099c7e5d6" />

* **Counters** - death counters, hug counters, any number chat can raise or lower with a command.
<img width="1402" height="932" alt="image" src="https://github.com/user-attachments/assets/0a2eb836-d0bb-4842-bde9-b9397baab91f" />

* **Commands** - your own `!commands` and rotating auto messages. Each command can chain several actions: reply in chat, play a sound, show a popup on an overlay, drive another tool, or wait in between.
<!-- SCREENSHOT NEEDED: Commands tab -->

* **Song Request** - viewers request songs with channel points or `!sr`. Plays through YouTube Music via [Pear Desktop](https://github.com/pear-devs/pear-desktop).
<img width="1402" height="932" alt="image" src="https://github.com/user-attachments/assets/b492bd8c-744f-430e-8ea8-f7306abc25fa" />

* **Credits** - end of stream rolling credits for mods, VIPs, subs, followers and chatters, plus a free text special thanks section. Only viewers who actually chatted get included. Pick a style preset or customize colors, fonts, scroll direction/speed, and section order yourself.
<img width="1402" height="932" alt="image" src="https://github.com/user-attachments/assets/3408a3dc-7e0a-4e88-9f92-b6598c17be72" />

* **D.I.Y** - build your own chat and alert widgets. Style them with the visual designer or write your own CSS, pick a Google Font, and watch the live preview update while you edit. Alerts cover follows, subs, bits and raids with editable text and a sound. Chat can scroll any direction, tilt, show events inline, and stay single line if you want. Copy the widget URL into OBS and it runs off your live Twitch chat.
<img width="1402" height="932" alt="image" src="https://github.com/user-attachments/assets/e47d707f-1df1-4677-b680-18baa5479bbc" />

Every tool has its own OBS browser source overlay. There is also a master overlay that can show several tools in one source, set up from the Settings tab, with drag and resize layout editing right in the browser.

## Getting around

Tools live in the sidebar down the left. Drag any of them up or down to put the ones you use most at the top, collapse the sidebar to icons when you want the extra width, or press **Ctrl+K** anywhere and type a few letters to jump straight to a tool.

**Profiles** let you keep completely separate setups - one for gaming, one for co-working, whatever you like - and switch between them in Settings.

## Install

1. Download the latest setup exe from [Releases](https://github.com/TheITStreamer/S.P.A.R.K/releases/latest).
2. Run it. Windows may warn about an unknown publisher, this is normal for a small unsigned app.
3. The app checks for new versions on startup and shows a banner when one is out.

## Setup

1. Open Settings and connect Twitch. You will need a free Twitch app Client ID, there are in app instruction to 
show you how to get one in about two minutes.
2. Add overlays to OBS as browser sources. Each tab shows its URL, default is `http://localhost:4747/`.
3. For Song Request, install Pear Desktop, enable its API server in the plugin menu and in the expanded menu for
it set the Auth to None, then hit Connect on the Song Request tab.

## Good to know

* Your data is saved at `%APPDATA%\com.spark.app\spark-data.json`.
* Settings has backup and restore. Twitch login is **NOT** included in backups, you just reconnect.
* Custom fonts you import are not included in backups either - only their names, so SPARK can tell you which ones to add again.
* After an update that needs new Twitch permissions, SPARK will ask you to reconnect. A plain refresh will not do it, Twitch never adds new permissions to an existing login.
* SPARK must be running for overlays to work.
* Windows only. 

## Building from source

```
npm install
npm run build
```

**NOTE:**Needs Node and Rust installed. The installer ends up in `src-tauri\target\release\bundle`.
