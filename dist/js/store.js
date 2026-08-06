// Shared mutable store — all tab modules read/write here.
export const store = {
  wheel: {},
  giveaway: {},
  timers: { list:[] },
  tasks: { list:[], settings:{} },
  goals: { bars:[] },
  checkins: { configs:[], firstClaim:{} },
  songrequest: { cfg:{}, queue:[] },
  chat: {},
  counters: {},
  credits: {},
  commands: { commands:[], automessages:[], cfg:{} },
  settings: {},
  twitch_tokens: {},
  overlayUrls: {},
  twitch: { connected:false, userId:'', login:'', clientId:'' },

  // ── Live values for command variables ──────────────────────────────────────
  // Things that only exist at runtime inside a tab (the current song, the last
  // wheel winner, who is chatting) and are never persisted. Tabs write here as
  // they change; the Commands tab reads them when resolving {song}, {chatters}
  // and friends. Publishing into a shared object beats exporting a getter from
  // every tab and importing seven modules into commands-tab.
  live: {
    song: '', songArtist: '', songRequester: '', nextSong: '', queueLength: 0,
    wheelWinner: '', giveawayWinner: '',
    lastFollower: '', lastSub: '', lastRaider: '',
    pomoPhase: 'idle',
    chatters: {},          // lowercase login -> display name, this stream
  },
};

export function liveSet(key, value){
  store.live[key] = value;
}

export function noteChatter(login, display){
  const k = String(login||'').trim().toLowerCase();
  if(!k) return;
  store.live.chatters[k] = display || login;
}

// ── Global bot/user ignore list (Settings tab owns the UI) ──────────────────
// Lives in store.settings.ignoreList; all tabs reference it instead of
// keeping their own bot lists. Names are stored lowercase.

export function ignoreList(){
  if(!Array.isArray(store.settings.ignoreList)) store.settings.ignoreList = [];
  return store.settings.ignoreList;
}

export function isIgnored(name){
  const n = String(name||'').trim().toLowerCase();
  return !!n && ignoreList().includes(n);
}

export function addIgnore(name){
  const n = String(name||'').trim().toLowerCase();
  if(!n) return;
  const l = ignoreList();
  if(!l.includes(n)){ l.push(n); saveIgnoreList(); }
}

// Persists the whole settings object (it also carries ytm_token etc.) and
// tells every tab the list changed so they can re-filter.
export function saveIgnoreList(){
  window.__TAURI__.core.invoke('save_app_settings', { data: store.settings });
  window.dispatchEvent(new CustomEvent('spark-ignorelist'));
}

// ── Persistent follower cache ───────────────────────────────────────────────
// userId -> [isFollower(0|1), cachedAtMs], stored in settings so it survives
// restarts. Lets chat forward messages instantly (no per-message API wait) —
// at worst a viewer's very first message ever renders in the default style.
// 3-day TTL: long enough to cover restarts, short enough that an unfollow
// doesn't keep follower styling forever.
const FOLLOW_TTL_MS = 3*24*3600*1000;
let followSaveTimer = null;

function followMap(){
  if(!store.settings.followerCache || typeof store.settings.followerCache !== 'object') store.settings.followerCache = {};
  return store.settings.followerCache;
}

// true / false when cached and fresh, undefined when unknown.
export function cachedFollower(userId){
  if(!userId) return undefined;
  const e = followMap()[userId];
  if(!e) return undefined;
  if(Date.now() - (e[1]||0) > FOLLOW_TTL_MS){ delete followMap()[userId]; return undefined; }
  return !!e[0];
}

export function setCachedFollower(userId, val){
  if(!userId) return;
  const m = followMap();
  // prune expired entries when the map gets big
  if(Object.keys(m).length > 2000){
    const now = Date.now();
    for(const k in m){ if(now - (m[k][1]||0) > FOLLOW_TTL_MS) delete m[k]; }
  }
  m[userId] = [val?1:0, Date.now()];
  clearTimeout(followSaveTimer);
  followSaveTimer = setTimeout(()=>{
    window.__TAURI__.core.invoke('save_app_settings', { data: store.settings }).catch(()=>{});
  }, 5000);
}

// ── Master overlay membership ───────────────────────────────────────────────
// Which tools render on the master overlay (Settings owns the UI). Persisted
// in settings.masterTools: { toolId: true }. Everything defaults to off —
// per-tab overlay bars always show the tool's own unique URL.

export const MASTER_TOOL_DEFS = [
  { id:'wheel',      label:'Wheel' },
  { id:'giveaway',   label:'Giveaway' },
  { id:'timers',     label:'Timers' },
  { id:'tasks',      label:'Tasks (Co-work)' },
  { id:'pomodoro',   label:'Pomodoro' },
  { id:'goals',      label:'Goals' },
  { id:'checkins',   label:'Check-ins' },
  { id:'nowplaying', label:'Now Playing' },
];

export function masterTools(){
  if(!store.settings.masterTools || typeof store.settings.masterTools !== 'object') store.settings.masterTools = {};
  return store.settings.masterTools;
}

// ── Per-tool enable/disable ─────────────────────────────────────────────────
// Lets the streamer turn off a tool's chat commands / redeems when they aren't
// using that tab. State lives in store.settings.toolToggles keyed by tool id:
//   toolToggles[id] = { enabled: bool, msg: string }
// Absent id or enabled !== false means ENABLED, so a tool is active until it is
// explicitly turned off.

// The tools that listen for viewer commands/redeems, in Settings display order.
export const TOOL_DEFS = [
  { id:'songrequest', label:'Song Request' },
  { id:'wheel',       label:'Wheel' },
  { id:'giveaway',    label:'Giveaway' },
  { id:'timers',      label:'Timers' },
  { id:'tasks',       label:'Tasks (Co-work)' },
  { id:'goals',       label:'Goals' },
  { id:'checkins',    label:'Check-ins' },
  { id:'counters',    label:'Counters' },
  { id:'commands',    label:'Commands' },
];

const TOOL_DEFAULT_MSG = {
  songrequest: 'Song requests are turned off right now.',
  wheel:       'The wheel is turned off right now.',
  giveaway:    'Giveaways are turned off right now.',
  timers:      'Timers are turned off right now.',
  tasks:       'The task list is turned off right now.',
  goals:       'Goal commands are turned off right now.',
  checkins:    'Check-ins are turned off right now.',
  counters:    'Counters are turned off right now.',
  commands:    'Commands are turned off right now.',
};

export function toolDefaultMsg(id){
  return TOOL_DEFAULT_MSG[id] || 'That feature is turned off right now.';
}

export function toolToggles(){
  if(!store.settings.toolToggles || typeof store.settings.toolToggles !== 'object') store.settings.toolToggles = {};
  return store.settings.toolToggles;
}

export function toolEnabled(id){
  const t = toolToggles()[id];
  return !t || t.enabled !== false; // default: enabled
}

export function toolDisabledMsg(id){
  const t = toolToggles()[id];
  const m = t && typeof t.msg === 'string' ? t.msg : '';
  return m || toolDefaultMsg(id);
}

export function saveToolToggles(){
  window.__TAURI__.core.invoke('save_app_settings', { data: store.settings });
}

// Rate-limit the "turned off" reply per tool so a spammed command cannot flood
// chat.
const _toolMsgLast = {};

// Call from a tab's command/redeem handler once it knows the message/redeem
// targets that tool. Returns true if the tool is OFF (caller should stop);
// when off it also posts the customisable "turned off" reply to chat.
export function toolBlocked(id, username){
  if(toolEnabled(id)) return false;
  const now = Date.now();
  if(now - (_toolMsgLast[id] || 0) > 8000){
    _toolMsgLast[id] = now;
    const raw = toolDisabledMsg(id);
    if(raw && raw.trim()){
      const msg = raw.replace(/\{name\}/g, username || '').replace(/<<username>>/g, username || '').trim();
      if(msg) window.__TAURI__.core.invoke('twitch_send_chat_message', { message: msg }).catch(()=>{});
    }
  }
  return true;
}
