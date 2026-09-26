// ── Shared sound player ──────────────────────────────────────────────────────
// Single entry point for every sound in the app. Playback happens in Rust
// (src-tauri/src/audio.rs), NOT in the webview: webview audio comes out of the
// msedgewebview2.exe helper process, which OBS "Application Audio Capture"
// can't see when you pick SPARK. Rust playback comes out of spark.exe itself.
//
// A cap limits how many one-shot sounds play together. Extras are DROPPED
// rather than queued: a chat sound that arrives ten seconds late is worse than
// one that never played. The cap is enforced in Rust, which knows exactly
// which clips are still playing.
//
// Sustained sounds (loop:true) are exempt from the cap — they run until
// something stops them, so counting them would let one long clip block every
// alert in the app.

import { store } from './store.js';
import { slog } from './utils.js';

const { invoke } = window.__TAURI__.core;
const DEFAULT_MAX = 3;

export function maxConcurrent(){
  const n = store.settings && store.settings.audioMaxConcurrent;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX;
}

// path    absolute file path
// volume  0-100, default 100
// force   bypass the cap; use for Test buttons so they always play
// loop    sustained sound, exempt from the cap, runs until stop()
// onError optional callback(message) for a missing/incompatible file or
//         audio device problem. Errors are always written to the SPARK log too.
//
// Returns a handle with .stop(). Playback starts asynchronously; stop() works
// even if called before the sound has actually started.
export function playSound(path, opts = {}){
  if(!path) return null;

  const { volume = 100, force = false, loop = false, onError = null } = opts;
  const vol = Math.max(0, Math.min(1, (Number(volume) || 0) / 100));
  let stopped = false;

  const idP = invoke('audio_play', {
    path,
    volume: vol,
    looped: !!loop,
    force: !!force,
    max: maxConcurrent(),
  }).then(id => {
    // null = dropped by the cap. Otherwise, honour a stop() that raced ahead.
    if(id != null && stopped) invoke('audio_stop', { id }).catch(() => {});
    return id;
  }).catch(err => {
    const msg = String(err || 'Unknown audio error');
    slog('audio', 'play failed: ' + msg);
    if(onError) { try{ onError(msg); }catch(e){} }
    return null;
  });

  return {
    stop(){
      stopped = true;
      idP.then(id => { if(id != null) invoke('audio_stop', { id }).catch(() => {}); });
    },
  };
}

// Built-in three-note chime (Pomodoro fallback when no sound file is set).
export function playBeep(){
  invoke('audio_beep').catch(err => slog('audio', 'beep failed: ' + err));
}

// Panic button — silences everything, one-shots and loops alike.
export function stopAllSounds(){
  invoke('audio_stop_all').catch(() => {});
}
