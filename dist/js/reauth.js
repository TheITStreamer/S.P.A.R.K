// ── Re-auth check ─────────────────────────────────────────────────────────────
// A Twitch token only ever carries the scopes it was granted at the time it was
// created, and the refresh grant NEVER widens them. So when a SPARK release
// adds a scope, an existing connection silently keeps working for everything
// except the new feature — which is exactly what happened with ad breaks in
// 0.8.3: no error, no prompt, the buttons just did nothing.
//
// This compares what the saved token actually has against what this build asks
// for and puts a popup in front of the user when they differ. The required list
// comes from Rust (twitch_required_scopes) rather than a copy kept here, so a
// future release only has to edit the SCOPES const in twitch.rs.

import { store }     from './store.js';
import { $, esc }    from './utils.js';
import { selectTab } from './tab-chrome.js';
import { beginReauth } from './settings-tab.js';

const { invoke } = window.__TAURI__.core;

// Plain-English name for each scope, so the popup says "ad break triggers"
// rather than "channel:read:ads". Anything missing from this map falls back to
// the raw scope name — better an ugly popup than no popup at all.
const SCOPE_LABELS = {
  'channel:read:redemptions':        'channel point redeems',
  'channel:manage:redemptions':      'creating and editing channel point rewards',
  'channel:read:subscriptions':      'sub checks and sub goals',
  'moderator:read:followers':        'follower checks and follower goals',
  'bits:read':                       'bits goals',
  'chat:read':                       'reading chat',
  'user:write:chat':                 'sending chat messages',
  'moderator:manage:announcements':  'chat announcements',
  'channel:read:ads':                'ad break triggers',
  // Broadcast tab.
  'channel:manage:broadcast':        'editing your title, category and tags, and stream markers',
  'moderator:manage:banned_users':   'timeouts and bans',
  'moderator:manage:chat_messages':  'deleting and pinning chat messages',
  'channel:manage:raids':            'raiding another channel',
  'moderator:manage:shoutouts':      'shoutouts',
  'channel:manage:polls':            'polls',
  'channel:manage:predictions':      'predictions',
  'channel:manage:moderators':       'adding and removing mods',
  'channel:manage:vips':             'adding and removing VIPs',
  'user:manage:whispers':            'whispers',
  'channel:edit:commercial':         'starting ad breaks',
  'channel:manage:ads':              'snoozing the next ad',
  'moderator:read:chat_settings':    'reading your chat settings',
  'moderator:manage:chat_settings':  'emote-only, subs-only and followers-only chat',
  'channel:read:hype_train':         'the hype train overlay'
};

function labelFor(scope){
  return SCOPE_LABELS[scope] || scope;
}

// Only ever run the check once per app launch. spark-twitch-status fires
// several times during a normal connect (afterConnected, then EventSub's
// session_welcome from Rust), and three popups would be worse than none.
let checked = false;

let pendingMissing = [];

// ── Modal ─────────────────────────────────────────────────────────────────────

function showModal(missing){
  const box = $('reauthModal');
  const body = $('reauthBody');
  if(!box || !body) return;

  pendingMissing = missing;

  const items = missing.map(s => `<li>${esc(labelFor(s))}</li>`).join('');
  const many  = missing.length > 1;

  body.innerHTML =
      `<p>This version of SPARK added ${many ? 'features that need' : 'a feature that needs'} `
    + `${many ? 'Twitch permissions' : 'a Twitch permission'} your connection does not have yet.</p>`
    + `<p><strong>${many ? 'These will not work until you reconnect:' : 'This will not work until you reconnect:'}</strong></p>`
    + `<ul>${items}</ul>`
    + `<p>Everything else keeps working normally. Reconnecting takes about twenty seconds — `
    + `SPARK gives you a code to enter on Twitch, the same as when you first connected.</p>`
    + `<p class="reauth-note">Reconnecting is a full log out and log back in. A plain refresh `
    + `will not do it — Twitch never adds new permissions to an existing login.</p>`;

  box.classList.add('open');
}

function hideModal(){
  const box = $('reauthModal');
  if(box) box.classList.remove('open');
}

// "Later" suppresses the popup for this exact combination of app version and
// missing scopes. A new release, or a different scope going missing, brings it
// straight back — so dismissing it once can never hide a future problem.
function dismissKey(version, missing){
  return version + '|' + missing.slice().sort().join(',');
}

async function remember(key){
  try{
    store.settings.reauthDismissed = key;
    await invoke('save_app_settings', { data: store.settings });
  }catch(e){ /* a failed save just means it asks again next launch — fine */ }
}

// ── Wiring ────────────────────────────────────────────────────────────────────

function wire(){
  const later = $('reauthLater');
  const now   = $('reauthNow');
  const close = $('reauthClose');

  if(later) later.addEventListener('click', async () => {
    hideModal();
    try{
      const v = await invoke('get_app_version');
      await remember(dismissKey(v, pendingMissing));
    }catch(e){}
  });

  // Closing with the X is deliberately NOT the same as "Later" — it does not
  // record a dismissal, so the popup returns next launch. Someone who hits the
  // corner button to get on with their stream should still be reminded.
  if(close) close.addEventListener('click', hideModal);

  if(now) now.addEventListener('click', () => {
    hideModal();
    selectTab('settings');
    // Let the tab paint before the auth flow starts writing into its fields.
    setTimeout(() => { beginReauth(); }, 60);
  });
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function checkReauth(){
  if(checked) return;
  if(!store.twitch || !store.twitch.connected) return;
  checked = true;

  let granted, required, version;
  try{
    // required is local and instant; granted is a round-trip to Twitch and is
    // the one that can fail (offline, expired token). Both are awaited together
    // because neither is useful without the other.
    [granted, required, version] = await Promise.all([
      invoke('twitch_token_scopes'),
      invoke('twitch_required_scopes'),
      invoke('get_app_version')
    ]);
  }catch(e){
    // Offline, or the token needs a refresh that has not happened yet. Allow a
    // retry on the next status event rather than staying silent for the session.
    checked = false;
    return;
  }

  const have = new Set(granted || []);
  const missing = (required || []).filter(s => !have.has(s));
  if(!missing.length) return;

  if(store.settings.reauthDismissed === dismissKey(version, missing)) return;

  showModal(missing);
}

export function initReauth(){
  wire();
  // Connection is established asynchronously after boot, so react to the status
  // event rather than checking immediately. Also covers the case where the user
  // connects Twitch for the first time mid-session.
  window.addEventListener('spark-twitch-status', e => {
    if(e.detail && e.detail.connected) checkReauth().catch(()=>{});
  });
  // And cover an already-connected store if the event landed before this ran.
  checkReauth().catch(()=>{});
}
