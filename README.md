# S.P.A.R.K. (BETA)
Some things may be a little janky/not work properly.

Streaming Panel for Alerts, Redeems and Key-tools. A Windows app for Twitch streamers. Everything will run locally on your PC.

## What it does

* **Wheel** - spin a wheel to pick from a list. Can be triggered by channel point redeems.
<img width="1402" height="932" alt="image" src="https://github.com/user-attachments/assets/58b05c9f-e0c8-448f-91bd-623a87e7bbc1" />

* **Giveaway** - viewers enter by typing a word in chat. Draw a winner with a slot machine overlay.
<img width="1402" height="932" alt="image" src="https://github.com/user-attachments/assets/7a871256-eca3-494a-9b83-a94bf10b1075" />

* **Timers** - countdown or stopwatch timers, started manually, by redeem, or by chat command.
<img width="1402" height="932" alt="image" src="https://github.com/user-attachments/assets/3d60c022-a721-4fcb-8d3c-6f9014eaff49" />

* **Tasks** - shared to do list for you and your viewers using `!task` commands as well as a pomodoro timer with its own commands. 
<img width="1402" height="932" alt="image" src="https://github.com/user-attachments/assets/9aa019e3-fc39-402f-b2c4-f7dfc2a0f0e7" />


* **Goals** - animated progress bars for followers, subs, bits, or custom chat commands.
<img width="1402" height="932" alt="image" src="https://github.com/user-attachments/assets/4cb8d09e-6f96-4a48-8852-b4be404f899e" />

* **Check-ins** - popup when a viewer redeems a check-in reward, with lifetime counts.
<img width="1402" height="932" alt="image" src="https://github.com/user-attachments/assets/081e99ae-445f-47cc-9441-47724915a647" />

* **Chat** - fully styled chat overlay with per role colors, follow and sub alerts, and animated emotes.
<img width="1402" height="932" alt="image" src="https://github.com/user-attachments/assets/f4f1152c-acbe-44bc-9e77-67f147465966" />

* **Counters** - death counters, hug counters, any number chat can raise or lower with a command.
<img width="1402" height="932" alt="image" src="https://github.com/user-attachments/assets/fc960a7f-226e-472c-aad0-8c8f3c48f090" />

* **Song Request** - viewers request songs with channel points or `!sr`. Plays through YouTube Music via [Pear Desktop](https://github.com/pear-devs/pear-desktop).
<img width="1402" height="932" alt="image" src="https://github.com/user-attachments/assets/93be422b-6426-4a96-a714-5f82f8770c6b" />

* **Credits** - end of stream rolling credits for mods, VIPs, subs, followers and chatters, plus a free text special thanks section. Only viewers who actually chatted get included. Pick a style preset or customize colors, fonts, scroll direction/speed, and section order yourself.
<img width="1402" height="932" alt="image" src="https://github.com/user-attachments/assets/25c70d9b-39b1-43ba-92a2-df9347fce06b" />

* **D.I.Y** - build your own chat and alert widgets. Style them with the visual designer or write your own CSS, pick a Google Font, and watch the live preview update while you edit. Alerts cover follows, subs, bits and raids with editable text and a sound. Chat can scroll any direction, tilt, show events inline, and stay single line if you want. Copy the widget URL into OBS and it runs off your live Twitch chat.
<img width="1402" height="932" alt="image" src="https://github.com/user-attachments/assets/61e375fb-8a02-4434-bdf4-a272ccb7ae34" />

Every tool has its own OBS browser source overlay. There is also a master overlay that can show several tools in one source, set up from the Settings tab, with drag and resize layout editing right in the browser.

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
* SPARK must be running for overlays to work.
* Windows only. 

## Building from source

```
npm install
npm run build
```

**NOTE:**Needs Node and Rust installed. The installer ends up in `src-tauri\target\release\bundle`.
