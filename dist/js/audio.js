// ── Shared sound player ──────────────────────────────────────────────────────
// Single entry point for every sound in the app, so a spammed sound command (or
// several tools firing at once) cannot stack unbounded overlapping clips.
//
// A cap limits how many one-shot sounds play together. Extras are DROPPED
// rather than queued: a chat sound that arrives ten seconds late is worse than
// one that never played.
//
// Sustained sounds (the wheel's spin loop) are tracked separately — they run
// until something stops them, so counting them against the cap would let one
// long clip block every alert in the app.

import { store } from './store.js';

const DEFAULT_MAX = 3;

const oneShots = new Set();   // Audio elements counted against the cap
const sustained = new Set();  // loop:true — exempt from the cap

export function maxConcurrent(){
  const n = store.settings && store.settings.audioMaxConcurrent;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX;
}

// path    absolute file path (NOT a URL — converted here)
// volume  0-100, default 100
// force   bypass the cap; use for Test buttons so they always play
// loop    sustained sound, exempt from the cap, runs until stop()
// onError optional callback for a missing/incompatible file
//
// Returns a handle with .stop(), or null when the sound was dropped.
export function playSound(path, opts = {}){
  if(!path) return null;

  const { volume = 100, force = false, loop = false, onError = null } = opts;

  if(!loop && !force && oneShots.size >= maxConcurrent()) return null;

  let a;
  try{
    a = new Audio(window.__TAURI__.core.convertFileSrc(path));
  }catch(e){
    if(onError) onError();
    return null;
  }

  a.volume = Math.max(0, Math.min(1, volume / 100));
  a.loop = !!loop;

  const bucket = loop ? sustained : oneShots;
  bucket.add(a);
  const release = () => bucket.delete(a);

  // A looping clip never fires 'ended', so only stop() clears it.
  a.addEventListener('ended', release);
  a.addEventListener('error', () => { release(); if(onError) onError(); });

  a.play().catch(() => { release(); if(onError) onError(); });

  return {
    stop(){
      try{ a.pause(); a.currentTime = 0; }catch(e){}
      release();
    },
    el: a,
  };
}

// Panic button — silences everything, one-shots and loops alike.
export function stopAllSounds(){
  [...oneShots, ...sustained].forEach(a => {
    try{ a.pause(); a.currentTime = 0; }catch(e){}
  });
  oneShots.clear();
  sustained.clear();
}

export function activeSoundCount(){
  return oneShots.size + sustained.size;
}
