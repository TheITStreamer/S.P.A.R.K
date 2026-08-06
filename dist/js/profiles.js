// ── Profiles ──────────────────────────────────────────────────────────────────
// A profile is a named snapshot of everything SPARK holds for a stream setup:
// wheel lists, timers, goals, which tools are switched on, and so on. Swap
// profile and the whole app becomes that setup.
//
// The active profile's `data` slot is deliberately empty. Its data IS the live
// data on disk, which is what makes "the active profile updates automatically"
// free: there is nothing to intercept on every save, because there is no second
// copy to keep in step. Only inactive profiles carry a stored snapshot.
//
// Switching reloads the window. Tab modules keep internal state that never
// resets (initTimers appends restored timers rather than replacing them, for
// one), so swapping data underneath a running tab would duplicate rather than
// replace. A reload re-runs every tab's init against the new data, which is the
// same path a normal app start already takes and therefore the well-tested one.

import { store } from './store.js';

const { invoke } = window.__TAURI__.core;

// Domain -> the save command that writes it. Order matters only for tidiness.
export const PROFILED_DOMAINS = {
  wheel:       'save_wheel',
  giveaway:    'save_giveaway',
  timers:      'save_timers',
  tasks:       'save_tasks',
  goals:       'save_goals',
  checkins:    'save_checkins',
  songrequest: 'save_songrequest',
  chat:        'save_chat',
  counters:    'save_counters',
  credits:     'save_credits',
  diy:         'save_diy',
};

// Settings keys that belong to a profile. Everything else in settings is global
// and must survive a switch untouched, most importantly the profile list itself
// and anything auth related.
export const PROFILED_SETTING_KEYS = ['toolToggles', 'masterTools', 'masterBorderColor', 'theme'];

function uid(){ return Math.random().toString(36).slice(2,10); }
function clone(v){ return v==null ? v : JSON.parse(JSON.stringify(v)); }

export function profiles(){
  if(!Array.isArray(store.settings.profiles)) store.settings.profiles = [];
  return store.settings.profiles;
}
export function activeProfileId(){ return store.settings.activeProfileId || ''; }
export function activeProfile(){ return profiles().find(p=>p.id===activeProfileId()) || null; }

function sharedCounts(){
  if(!store.settings.sharedCheckinCounts || typeof store.settings.sharedCheckinCounts!=='object'){
    store.settings.sharedCheckinCounts = {};
  }
  return store.settings.sharedCheckinCounts;
}

// ── Shared data extraction ────────────────────────────────────────────────────
// Check-in totals and the credits chatter session are viewer history. They are
// pulled out of a snapshot so they stay global: a regular's check-in count
// should not appear to change because the stream is running a different setup.

// Lifts counts out of checkins into the shared store, keyed by config id so a
// count follows its config rather than the profile it happened to be created in.
function stripCheckins(checkins){
  const out = clone(checkins) || {};
  const store_ = sharedCounts();
  (out.configs || []).forEach(cfg=>{
    if(cfg && cfg.counts && Object.keys(cfg.counts).length) store_[cfg.id] = clone(cfg.counts);
    if(cfg) delete cfg.counts;
  });
  return out;
}

function restoreCheckins(checkins){
  const out = clone(checkins) || {};
  const store_ = sharedCounts();
  (out.configs || []).forEach(cfg=>{
    if(cfg && store_[cfg.id]) cfg.counts = clone(store_[cfg.id]);
  });
  return out;
}

// The credits session is the current stream's chatter roster. It rides alongside
// the config on disk and goes stale on its own, so it is never snapshotted and
// never overwritten by a switch.
function stripCredits(credits){
  const out = clone(credits) || {};
  delete out.session;
  return out;
}

// ── Snapshot / restore ────────────────────────────────────────────────────────

// Reads the canonical persisted state rather than the in-memory store, so a tab
// that has not mirrored something back into `store` cannot cause a silent loss.
export async function snapshotCurrent(){
  const data = await invoke('load_all_data');
  const snap = {};
  Object.keys(PROFILED_DOMAINS).forEach(k=>{
    if(k==='checkins')     snap[k] = stripCheckins(data[k]);
    else if(k==='credits') snap[k] = stripCredits(data[k]);
    else                   snap[k] = clone(data[k]) ?? {};
  });
  const s = data.settings || {};
  snap.settings = {};
  PROFILED_SETTING_KEYS.forEach(k=>{ if(s[k]!==undefined) snap.settings[k] = clone(s[k]); });
  return snap;
}

// Writes a snapshot back through the same commands the tabs use, so nothing
// bypasses the normal persistence path.
export async function applySnapshot(snap){
  const live = await invoke('load_all_data');
  for(const [key, cmd] of Object.entries(PROFILED_DOMAINS)){
    let payload = clone(snap && snap[key]) ?? {};
    if(key==='checkins') payload = restoreCheckins(payload);
    if(key==='credits'){
      // Keep whatever session is currently on disk; it belongs to this stream,
      // not to the profile being loaded.
      const sess = (live.credits || {}).session;
      if(sess) payload.session = clone(sess);
    }
    await invoke(cmd, { data: payload });
  }
  // Merge the profiled settings keys over the live ones, leaving tokens, caches
  // and the profile list exactly as they were.
  const incoming = (snap && snap.settings) || {};
  PROFILED_SETTING_KEYS.forEach(k=>{
    if(incoming[k]!==undefined) store.settings[k] = clone(incoming[k]);
    else delete store.settings[k];
  });
  await invoke('save_app_settings', { data: store.settings });
}

// ── Profile management ────────────────────────────────────────────────────────

// Gives a profile-less install one profile pointing at the data already there,
// so enabling this feature can never look like it wiped someone's setup.
export async function ensureBootstrapped(){
  const list = profiles();
  if(list.length && activeProfile()) return false;
  if(!list.length) list.push({ id: uid(), name: 'Default', data: null });
  store.settings.activeProfileId = list[0].id;
  list[0].data = null;
  await invoke('save_app_settings', { data: store.settings });
  return true;
}

export function uniqueName(base){
  const taken = new Set(profiles().map(p=>p.name.toLowerCase()));
  if(!taken.has(base.toLowerCase())) return base;
  let i=2;
  while(taken.has(`${base} ${i}`.toLowerCase())) i++;
  return `${base} ${i}`;
}

// `copyCurrent` false starts the profile at SPARK's defaults, which is an empty
// snapshot: every tab falls back to its own defaults when its data is empty.
export async function createProfile(name, copyCurrent){
  const snap = copyCurrent ? await snapshotCurrent() : {};
  const p = { id: uid(), name: uniqueName(name || 'New Profile'), data: snap };
  profiles().push(p);
  await invoke('save_app_settings', { data: store.settings });
  return p;
}

export async function renameProfile(id, name){
  const p = profiles().find(x=>x.id===id); if(!p) return;
  p.name = uniqueName(name || p.name);
  await invoke('save_app_settings', { data: store.settings });
}

export async function duplicateProfile(id){
  const p = profiles().find(x=>x.id===id); if(!p) return null;
  // Duplicating the active profile has to snapshot live data, since its own
  // slot is empty by design.
  const data = (p.id===activeProfileId()) ? await snapshotCurrent() : clone(p.data);
  const copy = { id: uid(), name: uniqueName(p.name+' copy'), data: data || {} };
  profiles().push(copy);
  await invoke('save_app_settings', { data: store.settings });
  return copy;
}

export async function deleteProfile(id){
  const list = profiles();
  if(list.length<=1) return { ok:false, reason:'Cannot delete the only profile.' };
  if(id===activeProfileId()) return { ok:false, reason:'Switch to another profile before deleting this one.' };
  store.settings.profiles = list.filter(p=>p.id!==id);
  await invoke('save_app_settings', { data: store.settings });
  return { ok:true };
}

// Parks the current state in the outgoing profile, loads the incoming one, then
// asks the caller to reload. Nothing is lost even if the reload never happens,
// because the outgoing snapshot is written before anything is overwritten.
export async function switchProfile(id){
  const list = profiles();
  const target = list.find(p=>p.id===id);
  if(!target) return { ok:false, reason:'That profile no longer exists.' };
  if(id===activeProfileId()) return { ok:false, reason:'That profile is already active.' };

  const outgoing = activeProfile();
  const snap = await snapshotCurrent();
  if(outgoing) outgoing.data = snap;

  const incoming = clone(target.data) || {};
  store.settings.activeProfileId = target.id;
  target.data = null;                       // it is the live one now
  await invoke('save_app_settings', { data: store.settings });

  // No explicit flush needed: every save_* command calls do_save, so the file
  // is already written by the time applySnapshot returns.
  await applySnapshot(incoming);
  return { ok:true, name: target.name };
}
