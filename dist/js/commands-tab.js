// ── Commands tab ─────────────────────────────────────────────────────────────
// Custom !commands and rotating Auto Messages. Two sub-sections behind a
// segmented toggle: they share the chat-send plumbing and the variable
// resolver, and nothing else.
//
// Layout is master-detail across the full pane width (no live preview column —
// there is no overlay for this tool, everything lands in chat or plays a sound
// in the app window).
//
// A command holds an ORDERED LIST of actions rather than a single response
// type, so "!discord posts a message AND plays a sound" needs no schema change.
//
// Note on /me: Helix POST /chat/messages silently drops or mangles anything
// starting with "/" or ".", so italic /me output is not offered here. It would
// need a write path on the IRC socket, which is read-only today.

import { store, toolBlocked, liveSet, noteChatter } from './store.js';
import { $, esc, flash, initDrag } from './utils.js';
import { playSound as playAudioFile } from './audio.js';

const { invoke } = window.__TAURI__.core;
const dialog = window.__TAURI__.dialog;

// ── Constants ────────────────────────────────────────────────────────────────

// Same tiers, same order, same wording as the Counters tab.
const PERMS = [
  { v:'viewer',      l:'Everyone' },
  { v:'follower',    l:'Followers' },
  { v:'sub',         l:'Subscribers' },
  { v:'mod',         l:'Mods only' },
  { v:'broadcaster', l:'Broadcaster only' },
];

const ANNOUNCE_COLORS = [
  { v:'primary', l:'Channel accent' },
  { v:'blue',    l:'Blue' },
  { v:'green',   l:'Green' },
  { v:'orange',  l:'Orange' },
  { v:'purple',  l:'Purple' },
];

const ACTION_TYPES = [
  { v:'chat',     l:'Chat message' },
  { v:'announce', l:'Announcement' },
  { v:'audio',    l:'Play a sound' },
  { v:'tool',     l:'Trigger a SPARK tool' },
  { v:'popup',    l:'Show on overlay' },
  { v:'wait',     l:'Wait' },
];

const TEXT_EFFECTS = [
  { v:'none',       l:'None' },
  { v:'typewriter', l:'Typewriter' },
  { v:'words',      l:'Word by word' },
  { v:'letters',    l:'Letter pop' },
];

// What a command can tell the rest of the app to do. Dispatched as a
// 'spark-action' window event; each tab listens for its own tool id, exactly
// like the existing spark-chat / spark-redeem / spark-goal buses. Going through
// an event rather than importing seven modules keeps this tab from becoming the
// hub of a circular import graph.
//
// needsTarget: the tool has named items and one must be picked.
// needsAmount: the action takes a number.
const TOOL_ACTIONS = {
  wheel:    { label:'Wheel',        actions:[ {v:'spin',  l:'Spin the wheel'} ] },
  giveaway: { label:'Giveaway',     actions:[ {v:'open',  l:'Open entries'}, {v:'close', l:'Close entries'}, {v:'draw', l:'Draw a winner'} ] },
  timers:   { label:'Timers',       needsTarget:true, actions:[ {v:'start', l:'Start'}, {v:'pause', l:'Pause'}, {v:'reset', l:'Reset'} ] },
  counters: { label:'Counters',     needsTarget:true, needsAmount:true, actions:[ {v:'add', l:'Add'}, {v:'subtract', l:'Subtract'}, {v:'set', l:'Set to'}, {v:'reset', l:'Reset to 0'} ] },
  goals:    { label:'Goals',        needsTarget:true, needsAmount:true, actions:[ {v:'add', l:'Add progress'} ] },
  credits:  { label:'Credits',      actions:[ {v:'play', l:'Roll the credits'} ] },
  pomodoro: { label:'Pomodoro',     actions:[ {v:'start', l:'Start'}, {v:'pause', l:'Pause'}, {v:'resume', l:'Resume'}, {v:'skip', l:'Skip phase'}, {v:'reset', l:'Reset'} ] },
};

const POPUP_POSITIONS = [
  {v:'top-left',l:'Top left'},        {v:'top-center',l:'Top centre'},       {v:'top-right',l:'Top right'},
  {v:'middle-left',l:'Middle left'},  {v:'middle-center',l:'Centre'},        {v:'middle-right',l:'Middle right'},
  {v:'bottom-left',l:'Bottom left'},  {v:'bottom-center',l:'Bottom centre'}, {v:'bottom-right',l:'Bottom right'},
];
const POPUP_ANIMS = [
  {v:'pop',l:'Pop'}, {v:'fade',l:'Fade'}, {v:'slide',l:'Slide up'}, {v:'none',l:'None'},
];
const POPUP_FONTS = ['Segoe UI','Roboto','Poppins','Montserrat','Oswald','Bebas Neue','Orbitron','Rajdhani','Press Start 2P','Quicksand','Fredoka','Baloo 2','Comic Neue','Playfair Display'];

// Grouped, and every entry shows what it turns into.
//   k  = the variable
//   d  = what it does, in plain words
//   ex = what it turns into when the command runs
const VAR_GROUPS = [
  { g:'The person who used the command', vars:[
    { k:'{user}',           d:'The person who typed it. If your mod runs a shoutout, this is your mod, not the person being shouted out. For that, use {targetusername} below', ex:'DaveTheStreamer' },
    { k:'{role}',           d:'What they are in your channel',                    ex:'subscriber' },
    { k:'{usercount}',      d:'How many times this person has used this command', ex:'12' },
    { k:'{topuser}',        d:'The person who has used this command the most',    ex:'dave' },
  ]},
  { g:'What they typed after the command', vars:[
    { k:'{args}',           d:'Everything they typed after the command',          ex:'they type "!so @dave hello", you get "@dave hello"' },
    { k:'{target}',         d:'Just the first word they typed after the command', ex:'@dave' },
    { k:'{arg1} {arg2}',    d:'One word at a time, counting from the left',       ex:'{arg2} of "add 5 now" gives 5' },
    { k:'{args:2}',         d:'Everything from the second word onwards',          ex:'"add 5 now" gives "5 now"' },
  ]},
  // These follow the mention automatically. {user} stays the person who typed
  // the command, so a mod running a shoutout makes {user} the mod, not the
  // subject. Both entries say so.
  { g:'The person the command is about', vars:[
    { k:'(how it works)',   d:'These use the name typed after the command. Nobody typed a name? Then they fall back to whoever ran it. This is what makes shoutouts work when a mod runs them', ex:'a mod types "!so D3stiny82", these are all about D3stiny82' },
    { k:'{targetusername}',  d:'Their name, spelled properly. Use this instead of {arg1}, which gives you exactly what was typed, @ sign and all', ex:'D3stiny82' },
    { k:'{targetfollowage}', d:'How long they have followed you',                 ex:'2 years, 3 months' },
    { k:'{targetaccountage}',d:'How long they have been on Twitch',               ex:'6 years' },
    { k:'{targetavatar}',    d:'The web address of their profile picture. Use it for an overlay image, not in chat', ex:'https://.../dave.png' },
  ]},
  { g:'Your stream', vars:[
    { k:'{channel}',        d:'Your channel name',                                ex:'davethestreamer' },
    { k:'{uptime}',         d:'How long you have been live. Says "not live" when you are offline', ex:'2h 14m' },
    { k:'{game}',           d:'The category your stream is set to',               ex:'Elden Ring' },
    { k:'{title}',          d:'Your stream title',                                ex:'Finally beating Malenia' },
    { k:'{viewers}',        d:'How many people are watching right now',           ex:'43' },
    { k:'{followers}',      d:'How many followers you have',                      ex:'1204' },
    { k:'{subcount}',       d:'How many subscribers you have',                    ex:'87' },
    { k:'{lastfollower}',   d:'The last person to follow you. Starts over when you close SPARK', ex:'dave' },
    { k:'{lastsub}',        d:'The last person to subscribe. Starts over when you close SPARK', ex:'dave' },
    { k:'{lastraider}',     d:'The last person to raid you. Starts over when you close SPARK', ex:'D3stiny82' },
  ]},
  { g:'When a raid, follow, sub or cheer sets it off', vars:[
    { k:'{user}',           d:'The person who raided, followed, subscribed or cheered. Nobody typed anything here, so this is them', ex:'D3stiny82' },
    { k:'{raiders}',        d:'How many people came with the raid',                ex:'42' },
    { k:'{amount}',         d:'Bits cheered, or how many subs were gifted',        ex:'500' },
    { k:'{targetusername}',  d:'The raider’s name. The other target variables work on them too, so a raid can show their picture', ex:'D3stiny82' },
  ]},
  { g:'When an ad break sets it off', vars:[
    { k:'{adduration}',     d:'How many seconds the ad break runs for',           ex:'180' },
    { k:'{adnextin}',       d:'Seconds until the break starts. Only means anything on the “ads are coming up” trigger; it is 0 on the other two', ex:'60' },
  ]},
  { g:'Your other SPARK tabs', vars:[
    { k:'{song}',           d:'The song playing right now',                       ex:'Never Gonna Give You Up' },
    { k:'{songartist}',     d:'Who the song is by',                               ex:'Rick Astley' },
    { k:'{songrequester}',  d:'Who asked for the song playing now. Says "nobody" if it was not requested', ex:'dave' },
    { k:'{nextsong}',       d:'The next song waiting to play',                    ex:'Take On Me' },
    { k:'{queuelength}',    d:'How many songs are waiting to play',               ex:'5' },
    { k:'{counter:Deaths}', d:'The number on one of your counters. Swap Deaths for your counter name', ex:'7' },
    { k:'{goal:Subs}',      d:'How far along a goal bar is. Swap Subs for your bar name', ex:'34' },
    { k:'{goal:Subs:target}',  d:'The number that bar is trying to reach',        ex:'50' },
    { k:'{goal:Subs:percent}', d:'How far along that bar is, as a percentage',    ex:'68%' },
    { k:'{timer:Break}',    d:'Time left on one of your timers. Swap Break for your timer name', ex:'4:32' },
    { k:'{wheelwinner}',    d:'What the wheel landed on last time',               ex:'Pizza' },
    { k:'{giveawaywinner}', d:'Who won the last giveaway',                        ex:'dave' },
    { k:'{taskcount}',      d:'How many tasks are not done yet',                  ex:'3' },
    { k:'{pomophase}',      d:'What the pomodoro timer is doing',                 ex:'work' },
    { k:'{chatters}',       d:'How many different people have talked since you opened SPARK', ex:'26' },
    { k:'{randomuser}',     d:'One of those people, picked at random',            ex:'dave' },
  ]},
  // Named "Utilities" rather than "Bits", which on Twitch means cheer currency.
  { g:'Utilities', vars:[
    { k:'{time}',           d:'The time right now',                               ex:'14:32' },
    { k:'{date}',           d:'Today’s date',                                ex:'03/08/2026' },
    { k:'{random 1-100}',   d:'A random whole number between the two numbers you give', ex:'57' },
    { k:'{pick a|b|c}',     d:'Picks one of your choices at random. Put a | between each one', ex:'{pick yes|no|maybe} gives maybe' },
    { k:'{upper text}',     d:'Turns your text into capitals',                    ex:'{upper hello} gives HELLO' },
    { k:'{lower text}',     d:'Turns your text into lowercase',                   ex:'{lower HELLO} gives hello' },
    { k:'{urlencode text}', d:'Makes text safe to put in a web link. You only need this if your command builds a link', ex:'{urlencode two words} gives two%20words' },
  ]},
];

// ── State ────────────────────────────────────────────────────────────────────

let commands = [];
let automsgs = [];
let cfg = { autoPauseOffline: true, adWarnSeconds: 60 };

let mode = 'commands';   // 'commands' | 'auto'
let selId = null;        // selected row in whichever list is showing
let saveTimer = null;

// Runtime only — never persisted.
const cdGlobal = {};     // commandId -> last fire ms
const cdUser   = {};     // commandId -> { username -> last fire ms }
let autoTick   = null;   // setInterval handle for the Auto Messages scheduler
let chatLines  = 0;      // messages seen since boot, for the "min chat lines" gate

// Which action cards are folded away, keyed by the action's stable aid. Purely
// a view preference, so it lives here rather than in the saved data.
const collapsed = new Set();
let lastEditorCmd = null;   // so "collapse everything" only fires on open

function uid(){ return Math.random().toString(36).slice(2,10); }

function persist(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(()=>{
    invoke('save_commands', { data:{ commands, automessages:automsgs, cfg } }).catch(()=>{});
  }, 200);
}

// ── Defaults ─────────────────────────────────────────────────────────────────

function newCommand(){
  // Pick a name that is already free, so clicking "New" twice doesn't greet
  // the streamer with a collision warning they didn't cause.
  let name = '!newcommand', n = 2;
  while(commandConflict(name, null)){ name = '!newcommand' + n; n++; }
  return {
    id: uid(),
    name,
    aliases: [],
    enabled: true,
    permission: 'viewer',
    cooldown: 5,        // seconds, whole channel
    userCooldown: 0,    // seconds, per viewer
    rewardId: '',       // optional channel point trigger
    when: 'always',     // always | live | offline
    categories: '',     // comma separated; blank = any category
    userCounts: {},     // login -> [uses, lastUsedMs]  (powers {usercount})
    actions: [ { type:'chat', text:'' } ],
  };
}

// ── Per-viewer counts ────────────────────────────────────────────────────────
// Kept on the command itself so they travel with backups and profile switches.
// A busy channel would otherwise grow this map forever, so it is capped: once
// past the limit the least recently seen viewers are dropped, which is exactly
// the set nobody is going to ask about.
const USER_COUNT_MAX = 800;

function bumpUserCount(cmd, login){
  const k = String(login||'').trim().toLowerCase();
  if(!k) return 0;
  if(!cmd.userCounts || typeof cmd.userCounts !== 'object') cmd.userCounts = {};
  const cur = cmd.userCounts[k];
  const n = (Array.isArray(cur) ? cur[0] : 0) + 1;
  cmd.userCounts[k] = [n, Date.now()];

  const keys = Object.keys(cmd.userCounts);
  if(keys.length > USER_COUNT_MAX){
    keys.sort((a,b) => (cmd.userCounts[a][1]||0) - (cmd.userCounts[b][1]||0));
    keys.slice(0, keys.length - USER_COUNT_MAX).forEach(x => delete cmd.userCounts[x]);
  }
  return n;
}

function userCountOf(cmd, login){
  const k = String(login||'').trim().replace(/^@/,'').toLowerCase();
  const e = cmd && cmd.userCounts && cmd.userCounts[k];
  return Array.isArray(e) ? e[0] : 0;
}

function topUserOf(cmd){
  const m = (cmd && cmd.userCounts) || {};
  let best = '', n = -1;
  for(const k in m){ if((m[k][0]||0) > n){ n = m[k][0]; best = k; } }
  return best;
}

// ── Conditions ───────────────────────────────────────────────────────────────
// Checked after permission but before anything runs, so a command that is out
// of season stays completely silent rather than replying with an excuse.
async function conditionsMet(cmd){
  const when = cmd.when || 'always';
  const cats = String(cmd.categories || '').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
  if(when === 'always' && !cats.length) return true;   // no lookup needed

  await ensureStreamInfo();
  const si = streamInfo || {};
  if(when === 'live'    && !si.live) return false;
  if(when === 'offline' &&  si.live) return false;
  if(cats.length){
    const game = String(si.game || '').toLowerCase();
    if(!game || !cats.some(c => game.includes(c))) return false;
  }
  return true;
}

// Every action carries a stable aid so the collapsed/expanded state survives
// reordering and deleting — an index-keyed set would silently point at the
// wrong card the moment anything moved.
function newAction(type){
  const a = buildAction(type);
  a.aid = uid();
  return a;
}

function buildAction(type){
  if(type === 'announce') return { type:'announce', text:'', color:'primary' };
  if(type === 'audio')    return { type:'audio', path:'', volume:100 };
  if(type === 'tool')     return { type:'tool', tool:'wheel', action:'spin', target:'', amount:1 };
  if(type === 'wait')     return { type:'wait', seconds: 1 };
  if(type === 'popup')    return {
    type:'popup', text:'',
    textEffect:'none', effectSpeed:40,   // ms per character / word / letter
    pad: 18,                             // space between content and border
    imageMode:'none',      // none | file | url | avatar
    image:'', imageUrl:'',
    imageVer: 0,           // bumped on every file change; busts the overlay cache
    imageSize: 340,
    duration:5,
    posMode:'anchor',      // anchor | exact
    position:'middle-center',
    x:50, y:50, xUnit:'%', yUnit:'%',
    w:0, h:0, wUnit:'px', hUnit:'px',   // 0 = size to content
    anim:'pop', font:'Segoe UI', size:34, weight:700,
    color:'#ffffff', bg:'#1a1230', border:'#ffc83d',
    glow:false, shadow:true,
  };
  return { type:'chat', text:'' };
}

// ── Starter pack ─────────────────────────────────────────────────────────────
// The half-dozen commands nearly every channel ends up writing by hand. Text is
// deliberately placeholder-ish where it has to be (socials, discord) so it is
// obvious what needs editing.
// Each entry knows how to build itself, so the plain one-liners and the
// two-action ones (!so, !raidthanks) can sit in the same pickable list.
const STARTER_PACK = [
  { name:'!discord',   note:'Sends people to your Discord. Edit in your invite link.',
    text:'Come hang out in the Discord: <put your invite link here>' },
  { name:'!socials',   note:'Your other links. Edit these in.',
    text:'Find {channel} everywhere: <put your links here>' },
  { name:'!lurk',      note:'A friendly reply for people going quiet.',
    text:'Thanks for the lurk, {user}! Enjoy your background noise.' },
  { name:'!uptime',    note:'How long you have been live.',
    text:'{channel} has been live for {uptime}.' },
  { name:'!followage', note:'How long someone has followed. Works on a name too: !followage dave',
    text:'{targetusername} has been following for {targetfollowage}.' },
  { name:'!game',      note:'What you are currently playing.',
    text:'Currently playing: {game}' },
  { name:'!followers', note:'Your follower count.',
    text:'{channel} has {followers} followers.' },
  { name:'!so',        note:'Shoutout. Posts a message AND puts their picture on your overlay. Mods only.',
    build:() => starterShoutout() },
  { name:'!raidthanks', note:'Runs on its own when somebody raids you. Thanks them and shows their picture.',
    build:() => starterRaid() },
];

// A shoutout is the one starter that uses two actions, so it is built
// separately — chat line plus the @mention avatar on the overlay.
function starterShoutout(){
  const c = newCommand();
  c.name = '!so';
  c.permission = 'mod';
  c.cooldown = 0;
  // {targetusername}, {accountage} and the popup's avatar all follow the name the
  // viewer typed, so "!so D3stiny82" needs no special syntax here.
  // Note there is no way to read someone else's category: Twitch only gives
  // SPARK yours, so the line uses account age instead.
  c.actions = [
    Object.assign(newAction('chat'), {
      label: 'Shout them out in chat',
      text: 'Go give {targetusername} a follow over at twitch.tv/{targetusername}! They have been on Twitch for {targetaccountage}.',
    }),
    Object.assign(newAction('popup'), {
      label: 'Show their picture on stream',
      text:'{targetusername}', imageMode:'avatar', duration:8,
      position:'bottom-center', anim:'slide', size:40,
    }),
  ];
  return c;
}

// Fires on a raid rather than on anyone typing. The name still has to be
// unique, but nobody is expected to use it as a chat command.
function starterRaid(){
  const c = newCommand();
  c.name = '!raidthanks';
  c.permission = 'broadcaster';
  c.cooldown = 0;
  c.events = ['raid'];
  c.actions = [
    Object.assign(newAction('chat'), {
      label: 'Thank the raider',
      text: 'Thank you {user} for the raid with {raiders} viewers! Go show them some love at twitch.tv/{targetusername}',
    }),
    Object.assign(newAction('popup'), {
      label: 'Put their face on stream',
      text:'{user} raided with {raiders}!', imageMode:'avatar', duration:10,
      position:'middle-center', anim:'pop', size:44,
    }),
  ];
  return c;
}

function buildStarter(s){
  if(s.build) return s.build();
  const c = newCommand();
  c.name = s.name;
  c.actions = [ Object.assign(newAction('chat'), { text: s.text }) ];
  return c;
}

// Pick what you want rather than getting all nine. Anything whose name is
// already taken is shown but not selectable, with the reason, so it is obvious
// why it isn't on offer instead of it silently not appearing.
function openStarterPicker(){
  document.getElementById('cmdStarterModal')?.remove();

  const rows = STARTER_PACK.map(s => ({ s, clash: commandConflict(s.name, null) }));
  const free = rows.filter(r => !r.clash).length;

  const modal = document.createElement('div');
  modal.id = 'cmdStarterModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:9999;display:flex;align-items:center;justify-content:center';
  modal.innerHTML = `<div style="background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:22px;width:620px;max-height:88vh;overflow-y:auto;position:relative">
    <button id="cmdStarterClose" style="position:absolute;top:12px;right:14px;background:none;border:none;color:var(--muted);font-size:1.5rem;cursor:pointer">×</button>
    <div style="font-size:.7rem;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);font-weight:700;margin-bottom:6px">Starter commands</div>
    <div class="hint" style="margin:0 0 14px">Tick the ones you want. You can edit any of them afterwards.</div>

    <div class="row" style="gap:8px;margin-bottom:10px">
      <button class="btn-sm btn-ghost" id="cmdStarterAll">Select all</button>
      <button class="btn-sm btn-ghost" id="cmdStarterNone">Select none</button>
    </div>

    <div id="cmdStarterList">
      ${rows.map(({s, clash}, i) => `
        <div class="goal-card" style="padding:10px 12px;margin-bottom:8px;${clash?'opacity:.5':''}">
          <label class="checkrow" style="margin:0;align-items:flex-start;gap:8px;${clash?'cursor:default':'cursor:pointer'}">
            <input type="checkbox" class="cmd-starter" data-i="${i}" ${clash?'disabled':'checked'} style="margin-top:3px">
            <div style="flex:1;min-width:0">
              <div><strong>${esc(s.name)}</strong></div>
              <div class="hint" style="margin:2px 0 0">${esc(s.note)}</div>
              ${clash ? `<div class="hint" style="margin:2px 0 0;color:#ff5d73">Already in use by ${esc(clash.replace(/^.*?is already in use by /,'').replace(/\. Pick.*$/,''))}</div>` : ''}
            </div>
          </label>
        </div>`).join('')}
    </div>

    <hr class="sep">
    <div class="row" style="gap:8px">
      <button class="btn-sm" id="cmdStarterAdd" ${free?'':'disabled'}>Add selected</button>
      <button class="btn-sm btn-ghost" id="cmdStarterCancel">Cancel</button>
      <div style="flex:1"></div>
      <span class="hint" style="margin:0" id="cmdStarterCount"></span>
    </div>
  </div>`;

  document.body.appendChild(modal);

  const boxes = () => [...modal.querySelectorAll('.cmd-starter:not(:disabled)')];
  const updateCount = () => {
    const n = boxes().filter(b => b.checked).length;
    modal.querySelector('#cmdStarterCount').textContent = n ? `${n} selected` : 'Nothing selected';
    modal.querySelector('#cmdStarterAdd').disabled = n === 0;
  };
  boxes().forEach(b => b.addEventListener('change', updateCount));
  updateCount();

  const close = () => modal.remove();
  modal.querySelector('#cmdStarterClose').addEventListener('click', close);
  modal.querySelector('#cmdStarterCancel').addEventListener('click', close);
  modal.addEventListener('click', e => { if(e.target === modal) close(); });
  modal.querySelector('#cmdStarterAll').addEventListener('click', () => { boxes().forEach(b => b.checked = true); updateCount(); });
  modal.querySelector('#cmdStarterNone').addEventListener('click', () => { boxes().forEach(b => b.checked = false); updateCount(); });

  modal.querySelector('#cmdStarterAdd').addEventListener('click', () => {
    const chosen = boxes().filter(b => b.checked).map(b => STARTER_PACK[parseInt(b.dataset.i)]);
    chosen.forEach(s => commands.push(buildStarter(s)));
    persist(); renderList(); renderEditor();

    const msg = $('cmdStarterMsg');
    if(msg){
      const names = chosen.map(s => s.name);
      msg.textContent = names.length
        ? `Added ${names.join(', ')}.` + (names.includes('!discord') || names.includes('!socials') ? ' Remember to put your real links in.' : '')
        : '';
    }
    close();
  });
}

function newAutoMsg(){
  return {
    id: uid(),
    name: 'New auto message',
    enabled: true,
    messages: [''],
    intervalMin: 15,
    minLines: 5,
    order: 'rotate',    // 'rotate' | 'random'
    announce: false,
    color: 'primary',
    idx: 0,
  };
}

// ── Command name collision ───────────────────────────────────────────────────
// The streamer types "!sr" into a brand new command, hits save, and nothing
// ever fires because Song Request claimed it first. That failure is invisible
// at runtime, so it has to be caught loudly at the point of typing.
//
// Returns null when free, otherwise a sentence naming the exact owner.

function normCmd(s){
  const t = String(s||'').trim().toLowerCase();
  if(!t) return '';
  return t.startsWith('!') ? t : '!' + t;
}

// Everything outside this tab that already answers to a chat command.
function reservedOwners(){
  const owners = {};   // '!cmd' -> human-readable owner

  const claim = (c, who) => { const n = normCmd(c); if(n && !owners[n]) owners[n] = who; };

  // Tasks (Co-work) — !task and its sub-commands all live under one prefix.
  claim('!task', 'the Tasks tab');

  // Song Request
  claim('!sr', 'the Song Request tab');
  claim('!srblock', 'the Song Request tab');

  // This tab's own chat-management verbs. They're intercepted before command
  // matching, so a command with one of these names could never fire.
  claim('!addcom',  'the built-in command manager');
  claim('!editcom', 'the built-in command manager');
  claim('!delcom',  'the built-in command manager');

  // Counters — each counter can own up to three.
  const cnt = (store.counters && store.counters.counters) || [];
  cnt.forEach(c => {
    const who = `the counter “${c.name || 'Counter'}”`;
    claim(c.incCmd, who); claim(c.decCmd, who); claim(c.resetCmd, who);
  });

  // Goals — a "custom" bar is driven by !<barname with spaces removed>.
  const bars = (store.goals && store.goals.bars) || [];
  bars.forEach(b => {
    if(b.source === 'custom' && b.name){
      claim('!' + String(b.name).toLowerCase().replace(/\s/g,''), `the goal bar “${b.name}”`);
    }
  });

  // Giveaway listens for !<entryWord> (plus " open"/" close") and !draw.
  const ga = store.giveaway || {};
  claim(ga.entryWord || 'giveaway', 'the Giveaway entry word');
  claim('!draw', 'the Giveaway draw command');

  return owners;
}

// selfId lets a command keep its own name while being edited.
export function commandConflict(nameRaw, selfId){
  const n = normCmd(nameRaw);
  if(!n || n === '!') return 'Enter a command name, for example !discord.';
  if(/\s/.test(n)) return 'A command cannot contain spaces.';

  const reserved = reservedOwners();
  if(reserved[n]) return `${n} is already in use by ${reserved[n]}. Pick a different name.`;

  for(const c of commands){
    if(c.id === selfId) continue;
    if(normCmd(c.name) === n){
      return `${n} is already in use by your command “${c.name}”. Pick a different name.`;
    }
    if((c.aliases||[]).some(a => normCmd(a) === n)){
      return `${n} is already an alias of your command “${c.name}”. Pick a different name.`;
    }
  }
  return null;
}

// Aliases are checked against the same pool, plus the command's own name.
function aliasConflict(aliasRaw, selfId, ownName){
  const n = normCmd(aliasRaw);
  if(!n) return null;
  if(n === normCmd(ownName)) return `${n} is already this command's name.`;
  return commandConflict(aliasRaw, selfId);
}

// ── Variables ────────────────────────────────────────────────────────────────

let streamInfo = null;

async function ensureStreamInfo(){
  try{ streamInfo = await invoke('twitch_get_stream_info'); }
  catch(e){ streamInfo = null; }
  return streamInfo;
}

function fmtUptime(startedAt){
  if(!startedAt) return 'not live';
  const ms = Date.now() - new Date(startedAt).getTime();
  if(!isFinite(ms) || ms < 0) return 'not live';
  const m = Math.floor(ms/60000), h = Math.floor(m/60);
  if(h > 0) return `${h}h ${m%60}m`;
  return `${m}m`;
}

function counterValue(name){
  const list = (store.counters && store.counters.counters) || [];
  const want = String(name||'').trim().toLowerCase();
  const c = list.find(x => String(x.name||'').toLowerCase() === want);
  return c ? String(c.value) : '0';
}

// A goal bar's target lives on its CURRENT MILESTONE, not on the bar itself —
// bars are milestone chains, so "the target" moves as each one is reached.
function goalValue(name, which){
  const bars = (store.goals && store.goals.bars) || [];
  const want = String(name||'').trim().toLowerCase();
  const b = want ? bars.find(x => String(x.name||'').toLowerCase() === want) : bars[0];
  if(!b) return '';
  const ms  = (b.milestones || [])[b.currentMilestone] || { target: 0 };
  const cur = b.current || 0;
  const tgt = ms.target || 0;
  if(which === 'target')  return String(tgt);
  if(which === 'percent') return tgt > 0 ? String(Math.floor((cur/tgt)*100)) + '%' : '0%';
  return String(cur);
}

function timerValue(name){
  const list = (store.timers && store.timers.list) || [];
  const want = String(name||'').trim().toLowerCase();
  const t = want ? list.find(x => String(x.name||'').toLowerCase() === want) : list[0];
  if(!t) return '';
  return fmtClock(t._remaining || 0);
}

function fmtClock(secs){
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), r = s%60;
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}`
               : `${m}:${String(r).padStart(2,'0')}`;
}

// "3 years, 2 months" style. Used by {followage} and {accountage}, both of
// which read better in words than as a raw date.
function fmtSince(iso){
  if(!iso) return '';
  const then = new Date(iso).getTime();
  if(!isFinite(then)) return '';
  let days = Math.floor((Date.now() - then) / 86400000);
  if(days < 1) return 'less than a day';
  const years = Math.floor(days/365); days -= years*365;
  const months = Math.floor(days/30);  days -= months*30;
  const bits = [];
  if(years)  bits.push(years  + (years===1?' year':' years'));
  if(months) bits.push(months + (months===1?' month':' months'));
  if(!years && days) bits.push(days + (days===1?' day':' days'));
  return bits.join(', ') || 'less than a day';
}

// Twitch lookups are cached for the life of a resolve pass and briefly beyond,
// because a shoutout template can reference the same person three times.
const userCache = new Map();   // login -> { at, data }
const USER_TTL = 60000;

async function lookupUser(login){
  const k = String(login||'').trim().replace(/^@/,'').toLowerCase();
  if(!k) return null;
  const hit = userCache.get(k);
  if(hit && Date.now() - hit.at < USER_TTL) return hit.data;
  try{
    const data = await invoke('twitch_get_user_by_login', { login: k });
    userCache.set(k, { at: Date.now(), data });
    return data;
  }catch(e){
    userCache.set(k, { at: Date.now(), data: null });
    return null;
  }
}

// First @mention in the args, else the first word, else the sender. This is
// what makes "!so @someone" and "!so someone" both work.
export function mentionedLogin(ctx){
  const args = String(ctx.args || '');
  const at = args.match(/@([A-Za-z0-9_]+)/);
  if(at) return at[1];
  const first = args.trim().split(/\s+/)[0];
  if(first) return first.replace(/^@/,'');
  return ctx.login || ctx.user || '';
}

// ctx: { user, login, userId, args, isMod, isSub, isVip, isBroadcaster }.
// Only touches the network when the template actually asks for something that
// needs it — a plain "!discord" reply makes zero API calls.
async function resolveVars(text, ctx){
  let out = String(text||'');
  if(!out) return out;

  if(/\{(uptime|game|title|viewers|channel)\}/i.test(out)) await ensureStreamInfo();
  const si = streamInfo || {};

  const args = String(ctx.args || '');
  const argList = args.split(/\s+/).filter(Boolean);

  // ── Text helpers. Done first so they can wrap other variables' output on a
  // second pass below. ──
  const simple = () => {
    out = out.replace(/\{user\}/gi,      ctx.user || '');
    out = out.replace(/\{sender\}/gi,    ctx.user || '');
    // Event-triggered runs carry a number: raid viewers, bits cheered, or how
    // many subs were gifted. Zero everywhere else.
    out = out.replace(/\{raiders\}/gi,   String(ctx.amount || 0));
    out = out.replace(/\{amount\}/gi,    String(ctx.amount || 0));
    // Ad break triggers. Zero everywhere else, which reads sensibly if someone
    // puts one in an ordinary command by mistake.
    out = out.replace(/\{adduration\}/gi, String(ctx.adDuration || 0));
    out = out.replace(/\{adnextin\}/gi,   String(ctx.adNextIn   || 0));
    out = out.replace(/\{target\}/gi,    argList[0] || '');
    out = out.replace(/\{args\}/gi,      args);
    out = out.replace(/\{args:(\d+)\}/gi, (_m,n) => argList.slice(Math.max(0,parseInt(n)-1)).join(' '));
    out = out.replace(/\{arg(\d+)\}/gi,  (_m,n) => argList[parseInt(n)-1] || '');
    out = out.replace(/\{channel\}/gi,   si.login || store.twitch.login || '');
    out = out.replace(/\{uptime\}/gi,    fmtUptime(si.started_at));
    out = out.replace(/\{game\}/gi,      si.game || '');
    out = out.replace(/\{category\}/gi,  si.game || '');
    out = out.replace(/\{title\}/gi,     si.title || '');
    out = out.replace(/\{viewers\}/gi,   String(si.viewers != null ? si.viewers : 0));
    out = out.replace(/\{role\}/gi,      ctx.isBroadcaster ? 'broadcaster' : ctx.isMod ? 'mod' : ctx.isVip ? 'VIP' : ctx.isSub ? 'subscriber' : 'viewer');
    out = out.replace(/\{time\}/gi,      new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}));
    out = out.replace(/\{date\}/gi,      new Date().toLocaleDateString());

    // ── SPARK's own tools ──
    const L = store.live || {};
    out = out.replace(/\{song\}/gi,           L.song || 'nothing playing');
    out = out.replace(/\{songartist\}/gi,     L.songArtist || '');
    // Pear autoplays its own tracks between requests, and those have no
    // requester. Without a fallback the message read "Requested by ."
    out = out.replace(/\{songrequester\}/gi,  L.songRequester || 'nobody, it came from autoplay');
    out = out.replace(/\{nextsong\}/gi,       L.nextSong || 'nothing queued');
    out = out.replace(/\{queuelength\}/gi,    String(L.queueLength || 0));
    out = out.replace(/\{wheelwinner\}/gi,    L.wheelWinner || 'nobody yet');
    out = out.replace(/\{giveawaywinner\}/gi, L.giveawayWinner || 'nobody yet');
    out = out.replace(/\{lastfollower\}/gi,   L.lastFollower || 'nobody yet');
    out = out.replace(/\{lastsub\}/gi,        L.lastSub || 'nobody yet');
    out = out.replace(/\{lastraider\}/gi,     L.lastRaider || 'nobody yet');
    out = out.replace(/\{pomophase\}/gi,      L.pomoPhase || 'idle');
    out = out.replace(/\{chatters\}/gi,       String(Object.keys(L.chatters || {}).length));
    out = out.replace(/\{randomuser\}/gi, () => {
      const names = Object.values(L.chatters || {});
      return names.length ? names[Math.floor(Math.random()*names.length)] : '';
    });
    out = out.replace(/\{taskcount\}/gi, () => {
      const list = (store.tasks && store.tasks.list) || [];
      return String(list.filter(t => !t.done).length);
    });

    // Per-viewer counts. {usercount} is the speaker's own tally for THIS
    // command; add :name for someone else's.
    out = out.replace(/\{usercount:\s*([^}]+)\}/gi, (_m, n) => String(userCountOf(ctx.cmd, n)));
    out = out.replace(/\{usercount\}/gi, String(ctx.userCount != null ? ctx.userCount : 0));
    out = out.replace(/\{topuser\}/gi, () => topUserOf(ctx.cmd) || 'nobody yet');

    out = out.replace(/\{counter:\s*([^}]+)\}/gi, (_m, n) => counterValue(n));
    out = out.replace(/\{goal:\s*([^:}]+):(target|percent)\}/gi, (_m, n, w) => goalValue(n, w.toLowerCase()));
    out = out.replace(/\{goal:\s*([^}]+)\}/gi, (_m, n) => goalValue(n, 'current'));
    out = out.replace(/\{timer:\s*([^}]+)\}/gi, (_m, n) => timerValue(n));

    out = out.replace(/\{random\s+(-?\d+)\s*-\s*(-?\d+)\}/gi, (_m, a, b) => {
      let lo = parseInt(a), hi = parseInt(b);
      if(lo > hi){ const t = lo; lo = hi; hi = t; }
      return String(lo + Math.floor(Math.random() * (hi - lo + 1)));
    });
    out = out.replace(/\{pick\s+([^}]+)\}/gi, (_m, list) => {
      const opts = list.split('|').map(s=>s.trim()).filter(Boolean);
      return opts.length ? opts[Math.floor(Math.random()*opts.length)] : '';
    });
  };
  simple();

  // ── Things that cost an API call. Each is only fetched if actually used. ──

  if(/\{followers\}/i.test(out)){
    let n = 0;
    try{ n = await invoke('twitch_get_follower_count', { broadcasterId: store.twitch.userId }); }catch(e){}
    out = out.replace(/\{followers\}/gi, String(n));
  }

  if(/\{subcount\}/i.test(out)){
    let n = 0;
    try{ n = await invoke('twitch_get_sub_count'); }catch(e){}
    out = out.replace(/\{subcount\}/gi, String(n));
  }

  // ── The "who is this about" rule ──
  // If the viewer typed a name after the command, these are about that person.
  // Otherwise they are about whoever ran it, so "!so D3stiny82" needs no extra
  // syntax. The explicit :name form also resolves but is not advertised.
  const subjectFor = async (explicit) => {
    if(explicit) return await lookupUser(explicit);
    const named = mentionedLogin(ctx);              // mention, else first word, else runner
    return named ? await lookupUser(named) : null;
  };

  // The short names ({followage}, {avatar}, {accountage}) resolve to the same
  // values; only the target* forms are advertised. {targetfollowage} does NOT
  // match the short pattern, because the regex anchors on the opening brace.
  if(/\{(?:targetfollowage|followage)(:[^}]+)?\}/i.test(out)){
    const m = out.match(/\{(?:targetfollowage|followage):([^}]+)\}/i);
    const u = await subjectFor(m ? m[1] : null);
    let since = '';
    // No lookup needed when it's the runner — their id is already in hand.
    const userId = u ? u.id : (ctx.userId || '');
    if(userId){
      try{ since = await invoke('twitch_get_followage', { userId }); }catch(e){}
    }
    out = out.replace(/\{(?:targetfollowage|followage)(:[^}]+)?\}/gi, since ? fmtSince(since) : 'not following');
  }

  if(/\{(?:targetaccountage|accountage)(:[^}]+)?\}/i.test(out)){
    const m = out.match(/\{(?:targetaccountage|accountage):([^}]+)\}/i);
    const u = await subjectFor(m ? m[1] : null);
    out = out.replace(/\{(?:targetaccountage|accountage)(:[^}]+)?\}/gi, u ? fmtSince(u.created_at) : '');
  }

  if(/\{(?:targetavatar|avatar)(:[^}]+)?\}/i.test(out)){
    const m = out.match(/\{(?:targetavatar|avatar):([^}]+)\}/i);
    const u = await subjectFor(m ? m[1] : null);
    out = out.replace(/\{(?:targetavatar|avatar)(:[^}]+)?\}/gi, u ? (u.profile_image_url || '') : '');
  }

  // {display} resolves to the same value as {targetusername}. Only
  // {targetusername} is advertised.
  if(/\{(targetusername|display)(:[^}]+)?\}/i.test(out)){
    const m = out.match(/\{(?:targetusername|display):([^}]+)\}/i);
    const u = await subjectFor(m ? m[1] : null);
    const name = u ? (u.display_name || '') : (ctx.user || '');
    out = out.replace(/\{(?:targetusername|display)(:[^}]+)?\}/gi, name);
  }

  // ── Transforms, applied last so they can wrap anything above ──
  out = out.replace(/\{upper\s+([^}]*)\}/gi,     (_m, s) => s.toUpperCase());
  out = out.replace(/\{lower\s+([^}]*)\}/gi,     (_m, s) => s.toLowerCase());
  out = out.replace(/\{urlencode\s+([^}]*)\}/gi, (_m, s) => encodeURIComponent(s));

  return out.trim();
}

// ── Running actions ──────────────────────────────────────────────────────────

let scopeWarned = false;

// force is used by the editor's Test button so a click always makes a noise.
function playAudio(path, volume, force){
  playAudioFile(path, { volume: volume == null ? 100 : volume, force: !!force });
}

// Sends are queued in Rust, so these calls return immediately and failures
// arrive later as a spark-send-error event (wired up at the bottom of the file)
// rather than as a rejected promise.
// Fire a tool action onto the shared bus. Fire-and-forget by design: if the
// target tab has its tool switched off in Settings it simply ignores this, and
// the command's other actions still run.
function runToolAction(a, ctx){
  window.dispatchEvent(new CustomEvent('spark-action', { detail: {
    tool:   a.tool,
    action: a.action,
    target: a.target || '',
    amount: Number.isFinite(a.amount) ? a.amount : parseFloat(a.amount) || 0,
    user:   ctx.user || '',
  }}));
}

async function runPopup(cmd, a, i, ctx){
  const text = a.text ? await resolveVars(a.text, ctx) : '';

  let image = '';
  const mode = a.imageMode || (a.image ? 'file' : 'none');   // migrate old saves
  if(mode === 'file' && a.image){
    // Served by a lookup route, not a raw path — see serve_command_image in
    // overlay.rs. imageVer changes whenever the file is swapped, which is what
    // stops the overlay showing the previous picture from cache.
    image = `/commands/image?id=${encodeURIComponent(cmd.id)}&i=${i}&v=${a.imageVer || 0}`;
  } else if(mode === 'url' && a.imageUrl){
    image = await resolveVars(a.imageUrl, ctx);
  } else if(mode === 'avatar'){
    // The whole point of the shoutout case: pull the profile picture of
    // whoever was @mentioned, falling back to the person who ran the command.
    const who = mentionedLogin(ctx);
    const u = who ? await lookupUser(who) : null;
    image = (u && u.profile_image_url) || '';
  }

  if(!text && !image) return;

  await invoke('commands_overlay_event', { event: {
    type:'popup', text, image,
    imageSize: a.imageSize || 340,
    duration: a.duration || 5,
    posMode: a.posMode || 'anchor',
    position: a.position || 'middle-center',
    x: a.x, y: a.y, xUnit: a.xUnit || '%', yUnit: a.yUnit || '%',
    w: a.w || 0, h: a.h || 0, wUnit: a.wUnit || 'px', hUnit: a.hUnit || 'px',
    anim: a.anim || 'pop',
    textEffect: a.textEffect || 'none',
    effectSpeed: a.effectSpeed || 40,
    pad: a.pad == null ? 18 : a.pad,
    font: a.font || 'Segoe UI',
    size: a.size || 34,
    weight: a.weight || 700,
    color: a.color || '#ffffff',
    bg: a.bg || '',
    border: a.border || '',
    glow: !!a.glow,
    shadow: a.shadow !== false,
  }});
}

// The wait is per RUN, not global. Each trigger of each command gets its own
// call into here, so one command sitting in a 5-second wait never holds up
// another command — or another viewer running the same one.
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runActions(cmd, ctx){
  const acts = cmd.actions || [];
  for(let i = 0; i < acts.length; i++){
    const a = acts[i];
    try{
      if(a.type === 'wait'){
        // Capped so a mistyped value can't leave a command hanging forever.
        const secs = Math.max(0, Math.min(300, Number(a.seconds) || 0));
        if(secs > 0) await sleep(secs * 1000);
      } else if(a.type === 'tool'){
        runToolAction(a, ctx);
      } else if(a.type === 'popup'){
        await runPopup(cmd, a, i, ctx);
      } else if(a.type === 'audio'){
        playAudio(a.path, a.volume);
      } else if(a.type === 'announce'){
        const msg = await resolveVars(a.text, ctx);
        if(msg) await invoke('twitch_send_announcement', { message: msg, color: a.color || 'primary' });
      } else {
        const msg = await resolveVars(a.text, ctx);
        if(msg) await invoke('twitch_send_chat_message', { message: msg });
      }
    }catch(e){ /* queueing can't realistically fail; real errors come by event */ }
  }
}

// ── Chat dispatch ────────────────────────────────────────────────────────────

async function permitted(tier, d){
  if(d.is_broadcaster) return true;
  if(tier === 'broadcaster') return false;
  if(d.is_mod) return true;
  if(tier === 'mod') return false;
  if(d.is_sub) return true;
  if(tier === 'sub') return false;
  if(tier === 'follower'){
    try{ return await invoke('twitch_check_follower', { userId: d.user_id, broadcasterId: store.twitch.userId }); }
    catch(e){ return false; }
  }
  return true;
}

function matchCommand(word){
  const w = normCmd(word);
  return commands.find(c =>
    c.enabled !== false && (
      normCmd(c.name) === w ||
      (c.aliases||[]).some(a => normCmd(a) === w)
    )
  );
}

// ── Managing commands from chat ──────────────────────────────────────────────
// !addcom !thing some text     !editcom !thing new text     !delcom !thing
//
// Mods and the broadcaster only. Anything created this way is a plain one-chat-
// action command; richer commands are still built in the app. Crucially this
// runs the SAME commandConflict() the editor uses, so a mod trying to claim
// !sr gets the identical explanation instead of a command that silently
// never fires.

function reply(text){
  invoke('twitch_send_chat_message', { message: text }).catch(()=>{});
}

function handleManage(d, msg){
  const m = msg.match(/^!(addcom|editcom|delcom)\s+(\S+)\s*([\s\S]*)$/i);
  if(!m) return false;
  if(!(d.is_mod || d.is_broadcaster)) return true;   // silently ignore non-mods

  const verb = m[1].toLowerCase();
  const name = normCmd(m[2]);
  const body = (m[3] || '').trim();
  const who  = d.display || d.username || '';

  if(verb === 'delcom'){
    const idx = commands.findIndex(c => normCmd(c.name) === name);
    if(idx < 0){ reply(`@${who} ${name} doesn't exist.`); return true; }
    const gone = commands[idx].name;
    commands.splice(idx, 1);
    if(selId && !commands.some(c => c.id === selId)) selId = null;
    persist(); renderList(); renderEditor();
    reply(`@${who} deleted ${gone}`);
    return true;
  }

  if(verb === 'editcom'){
    const c = commands.find(x => normCmd(x.name) === name);
    if(!c){ reply(`@${who} ${name} doesn't exist. Use !addcom to create it.`); return true; }
    if(!body){ reply(`@${who} give me something to say, e.g. !editcom ${name} new text`); return true; }
    // Reuse the first chat action if there is one, so a command that also
    // plays a sound keeps its sound.
    const chatAction = (c.actions || []).find(a => a.type === 'chat');
    if(chatAction) chatAction.text = body;
    else (c.actions = c.actions || []).push({ type:'chat', text: body });
    persist(); renderList();
    if(selId === c.id) renderEditor();
    reply(`@${who} updated ${c.name}`);
    return true;
  }

  // addcom
  if(!body){ reply(`@${who} usage: !addcom ${name} what it should say`); return true; }
  const clash = commandConflict(name, null);
  if(clash){ reply(`@${who} ${clash}`); return true; }

  const c = newCommand();
  c.name = name;
  c.actions = [{ type:'chat', text: body }];
  commands.push(c);
  persist(); renderList();
  reply(`@${who} added ${name}`);
  return true;
}

// ── Stream events ────────────────────────────────────────────────────────────
// Raids, follows, subs and cheers all arrive on the goal bus already, carrying
// the person's name (and a count for raids, cheers and gift subs). A command
// can be set to fire on any of them.
//
// The person is put into ctx.args as well as ctx.user, which means {targetusername},
// {avatar}, {followage} and {accountage} land on the RAIDER with no extra
// syntax — the same rule that makes "!so someone" work.
const EVENT_TRIGGERS = [
  { v:'raid',    l:'Someone raids you' },
  { v:'follow',  l:'Someone follows' },
  { v:'sub',     l:'Someone subscribes' },
  { v:'giftsub', l:'Someone gifts subs' },
  { v:'bits',    l:'Someone cheers bits' },
  { v:'adwarn',  l:'Ads are coming up' },
  { v:'adstart', l:'Ads start' },
  { v:'adend',   l:'Ads finish' },
];

window.addEventListener('spark-goal', async e => {
  const d = e.detail || {};
  const name = d.user_name || '';
  const kind = d.kind || '';

  if(name){
    if(kind === 'follow') liveSet('lastFollower', name);
    else if(kind === 'sub' || kind === 'resub' || kind === 'giftsub') liveSet('lastSub', name);
    else if(kind === 'raid') liveSet('lastRaider', name);
  }

  // "resub" should satisfy a command set to fire on subs.
  const matchKind = kind === 'resub' ? 'sub' : kind;
  const hits = commands.filter(c => c.enabled !== false && Array.isArray(c.events) && c.events.includes(matchKind));
  if(!hits.length) return;
  if(toolBlocked('commands', name)) return;

  for(const cmd of hits){
    if(!(await conditionsMet(cmd))) continue;
    await runActions(cmd, {
      user:   name,
      login:  name,
      args:   name,          // makes {targetusername}/{avatar}/{followage} follow them
      amount: d.amount || 0,
      cmd,
      userCount: 0,
    });
  }
});

window.addEventListener('spark-chat', async e => {
  const d = e.detail || {};
  chatLines++;
  // Feeds {chatters} and {randomuser}. Everyone who speaks counts, including
  // people running commands.
  noteChatter(d.username, d.display || d.username);

  const msg = String(d.message || '').trim();
  if(!msg || msg[0] !== '!') return;

  // Management verbs are handled before command matching so someone can't
  // shadow them by creating a command called !addcom.
  if(/^!(addcom|editcom|delcom)\b/i.test(msg)){
    if(toolBlocked('commands', d.display || d.username)) return;
    handleManage(d, msg);
    return;
  }

  const parts = msg.split(/\s+/);
  const cmd = matchCommand(parts[0]);
  if(!cmd) return;

  if(toolBlocked('commands', d.display || d.username)) return;
  if(!(await permitted(cmd.permission, d))) return;
  if(!(await conditionsMet(cmd))) return;

  const now = Date.now();
  const who = String(d.username || '').toLowerCase();

  // Mods and the broadcaster skip cooldowns — they are usually testing.
  if(!d.is_mod && !d.is_broadcaster){
    if(cmd.cooldown > 0 && now - (cdGlobal[cmd.id] || 0) < cmd.cooldown * 1000) return;
    if(cmd.userCooldown > 0){
      const m = cdUser[cmd.id] || (cdUser[cmd.id] = {});
      if(now - (m[who] || 0) < cmd.userCooldown * 1000) return;
      m[who] = now;
    }
  }
  cdGlobal[cmd.id] = now;

  const userCount = bumpUserCount(cmd, d.username);
  persist();

  await runActions(cmd, {
    user:    d.display || d.username || '',
    login:   d.username || '',
    userId:  d.user_id || '',
    args:    parts.slice(1).join(' '),
    isMod:   !!d.is_mod, isSub: !!d.is_sub, isVip: !!d.is_vip,
    isBroadcaster: !!d.is_broadcaster,
    cmd, userCount,
  });
});

// Channel point trigger — same actions, no cooldown or permission (Twitch
// already gated it behind the reward's own cost and settings).
window.addEventListener('spark-redeem', async e => {
  const d = e.detail || {};
  const cmd = commands.find(c => c.enabled !== false && c.rewardId && c.rewardId === d.reward_id);
  if(!cmd) return;
  if(toolBlocked('commands', d.user_name || d.user_login)) return;
  if(!(await conditionsMet(cmd))) return;
  const userCount = bumpUserCount(cmd, d.user_login);
  persist();
  await runActions(cmd, {
    user:   d.user_name || d.user_login || '',
    login:  d.user_login || '',
    userId: d.user_id || '',
    args:   d.user_input || '',
    cmd, userCount,
  });
});

// ── Clock-driven jobs ──────────────────────────────────────────────────
// Two things here run on a clock rather than in response to anyone typing:
// the ad break triggers, then the rotating auto messages.

// ── Ad breaks ──────────────────────────────────────────────────────────
// Twitch only announces one of the three moments: the START of a break, via
// EventSub. The other two are derived.
//
//   coming up — polled from the ad schedule, which gives an absolute time for
//               the next break. The clock is then watched locally, so the
//               warning lands within a few seconds of the lead time even
//               though the schedule is only fetched once a minute.
//   finish    — a timer set from the start event plus the duration Twitch
//               reports. Nothing tells us an ad actually ended.
//
// A snooze after the warning has already gone out cannot be taken back. That
// is a limit of there being no warning event at all, not a fault here.

let adPollTick  = null;
let adCheckTick = null;
// nextAt/duration come from the schedule; warnedFor holds the nextAt value a
// warning has already been sent for, so one scheduled break warns exactly once.
const adState = { nextAt: 0, duration: 0, warnedFor: 0, endTimer: null };

function adWarnLead(){
  return Math.max(5, Math.min(600, parseInt(cfg.adWarnSeconds) || 60));
}

function anyCommandWants(kind){
  return commands.some(c => c.enabled !== false && Array.isArray(c.events) && c.events.includes(kind));
}

// Nobody types anything for these, so there is no permission or cooldown to
// apply — the same rule raids and follows already use.
async function fireAdCommands(kind, ctx){
  const hits = commands.filter(c => c.enabled !== false && Array.isArray(c.events) && c.events.includes(kind));
  if(!hits.length) return;
  if(toolBlocked('commands', '')) return;
  for(const cmd of hits){
    if(!(await conditionsMet(cmd))) continue;
    await runActions(cmd, Object.assign({
      user: store.twitch.login || '', login: store.twitch.login || '',
      args: '', cmd, userCount: 0,
    }, ctx));
  }
}

async function adPoll(){
  if(!store.twitch.connected) return;
  // Only the warning needs the schedule, so a setup without one makes no calls.
  if(!anyCommandWants('adwarn')){ adState.nextAt = 0; return; }
  try{
    const s = await invoke('twitch_get_ad_schedule');
    const t = Date.parse((s && s.next_ad_at) || '');
    // Twitch hands back an epoch-zero placeholder when no break is scheduled,
    // so anything not in the future is treated as "nothing due".
    adState.nextAt   = (isFinite(t) && t > Date.now()) ? t : 0;
    adState.duration = parseInt(s && s.duration) || 0;
  }catch(e){ /* no scope, offline, not an affiliate — the banner covers it */ }
}

function adCheck(){
  if(!adState.nextAt) return;
  const secs = Math.round((adState.nextAt - Date.now()) / 1000);
  if(secs < 0 || secs > adWarnLead()) return;
  if(adState.warnedFor === adState.nextAt) return;
  adState.warnedFor = adState.nextAt;
  fireAdCommands('adwarn', { adDuration: adState.duration, adNextIn: Math.max(0, secs) }).catch(()=>{});
}

window.addEventListener('spark-ad', async e => {
  const d = e.detail || {};
  const dur = Math.max(0, parseInt(d.duration) || 0);
  // The break is happening, so the schedule we were counting down to is spent.
  adState.nextAt = 0;
  clearTimeout(adState.endTimer);
  await fireAdCommands('adstart', { adDuration: dur, adNextIn: 0 });
  if(dur > 0){
    adState.endTimer = setTimeout(() => {
      fireAdCommands('adend', { adDuration: dur, adNextIn: 0 }).catch(()=>{});
    }, dur * 1000);
  }
  // Pick up the next break straight away rather than waiting for the next tick.
  adPoll().catch(()=>{});
});

function startAdLoops(){
  clearInterval(adPollTick); clearInterval(adCheckTick);
  adPollTick  = setInterval(() => { adPoll().catch(()=>{}); }, 60000);
  adCheckTick = setInterval(adCheck, 5000);
  adPoll().catch(()=>{});   // fire-and-forget: must never hold up boot
}

// ── Auto Messages scheduler ───────────────────────────────────────────────
// Ticks once a minute. Each message tracks its own last-sent time and the chat
// line count at that moment, so "every 15 min but only if 5 people have said
// something" works without a second timer.

const autoState = {};   // id -> { lastAt, linesAt }

async function autoFire(m){
  const list = (m.messages || []).filter(t => String(t||'').trim());
  if(!list.length) return;

  let text;
  if(m.order === 'random'){
    text = list[Math.floor(Math.random() * list.length)];
  } else {
    const i = (m.idx || 0) % list.length;
    text = list[i];
    m.idx = (i + 1) % list.length;
    persist();
  }

  const resolved = await resolveVars(text, { user:'', args:'' });
  if(!resolved) return;
  try{
    if(m.announce) await invoke('twitch_send_announcement', { message: resolved, color: m.color || 'primary' });
    else           await invoke('twitch_send_chat_message', { message: resolved });
  }catch(err){ /* see runActions — failures arrive by event */ }
}

async function autoLoop(){
  if(!store.twitch.connected) return;
  if(!automsgs.some(m => m.enabled !== false)) return;

  // Posting "follow me!" into an empty offline chat is the classic bot
  // annoyance, so this is on by default.
  if(cfg.autoPauseOffline !== false){
    await ensureStreamInfo();
    if(!streamInfo || !streamInfo.live) return;
  }

  const now = Date.now();
  for(const m of automsgs){
    if(m.enabled === false) continue;
    const st = autoState[m.id] || (autoState[m.id] = { lastAt: now, linesAt: chatLines });
    const due = now - st.lastAt >= Math.max(1, m.intervalMin || 15) * 60000;
    if(!due) continue;
    if((m.minLines || 0) > 0 && chatLines - st.linesAt < m.minLines) continue;
    st.lastAt = now;
    st.linesAt = chatLines;
    await autoFire(m);
  }
}

function startAutoLoop(){
  clearInterval(autoTick);
  autoTick = setInterval(() => { autoLoop().catch(()=>{}); }, 60000);
}

// ── Scope banner ─────────────────────────────────────────────────────────────
// Announcements need the moderator:manage:announcements scope, which older
// tokens do not carry.

function showScopeBanner(missing){
  const host = $('cmdScopeWarn');
  if(!host) return;
  const list = (missing && missing.length) ? missing : ['Some features'];
  const what = list.join(' and ');
  // Must be "Log out" specifically: the refresh-token grant never widens
  // scopes, so only a fresh device-code auth picks the new one up.
  host.innerHTML = '⚠ ' + esc(what.charAt(0).toUpperCase() + what.slice(1))
    + ' need a Twitch permission your connection does not have yet. '
    + 'Go to <strong>Settings</strong>, click <strong>Log out</strong>, then connect Twitch again. '
    + 'Everything else works either way.';
  host.style.display = 'block';
}

async function checkScope(){
  if(!store.twitch.connected) return;
  try{
    const scopes = await invoke('twitch_token_scopes');
    const missing = [];
    if(!scopes.includes('moderator:manage:announcements')) missing.push('announcements');
    if(!scopes.includes('channel:read:ads')) missing.push('the ad break triggers');
    if(missing.length) showScopeBanner(missing);
  }catch(e){ /* offline or not connected — nothing useful to say */ }
}

// A send that fails after being queued reports back here. Bot-account problems
// are Settings' business; this only surfaces things the streamer would look for
// on this tab.
window.addEventListener('spark-send-error', e => {
  const d = e.detail || {};
  const host = $('cmdScopeWarn');
  if(!host) return;
  if(d.kind === 'announce' && (d.status === 401 || d.status === 403) && d.source !== 'bot'){
    if(!scopeWarned){ scopeWarned = true; showScopeBanner(['announcements']); }
    return;
  }
  if(d.kind === 'rate'){
    host.innerHTML = '⚠ ' + esc(d.reason || 'Twitch is rate-limiting SPARK; messages are being sent more slowly.');
    host.style.display = 'block';
  }
});

// ── UI: shell ────────────────────────────────────────────────────────────────

function buildShell(){
  const host = $('commandsMain');
  if(!host) return;
  host.innerHTML = `
    <div id="cmdScopeWarn" class="warn" style="display:none;margin-bottom:12px"></div>

    <div class="row" style="gap:8px;align-items:center;margin-bottom:14px">
      <button class="btn-sm" id="cmdModeCommands">Commands</button>
      <button class="btn-sm btn-ghost" id="cmdModeAuto">Auto Messages</button>
      <div style="flex:1"></div>
      <span class="hint" style="margin:0">Popup overlay:</span>
      <input type="text" id="cmdOverlayUrl" readonly style="width:230px;font-size:.8rem">
      <button class="btn-sm" id="cmdCopyUrl">Copy</button>
    </div>

    <!-- align-items MUST stay stretch (the default). With flex-start the two
         columns size to their content instead of to the pane, so #cmdEditor
         never gets a bounded height, its overflow-y:auto has nothing to scroll
         within, and a long command is simply clipped by the overflow:hidden on
         .cmd-body with no scrollbar anywhere. -->
    <div id="cmdSplit" style="display:flex;gap:16px;align-items:stretch;flex:1;min-height:0">
      <div style="width:300px;flex-shrink:0;display:flex;flex-direction:column;min-height:0">
        <div class="row" style="gap:6px;margin-bottom:8px">
          <input type="text" id="cmdSearch" placeholder="Search…" style="flex:1">
          <button class="btn-sm" id="cmdAddBtn">+ New</button>
        </div>
        <div id="cmdList" style="overflow-y:auto;flex:1;min-height:0"></div>
        <div id="cmdStarterWrap" style="margin-top:8px">
          <button class="btn-sm btn-ghost" id="cmdStarterBtn" style="width:100%">Add starter commands…</button>
          <div class="hint" id="cmdStarterMsg" style="margin-top:4px"></div>
        </div>
      </div>
      <!-- min-height:0 is required: a flex item defaults to min-height:auto,
           which refuses to shrink below its content and would defeat the
           overflow-y:auto above. -->
      <div id="cmdEditor" style="flex:1;min-width:0;min-height:0;overflow-y:auto"></div>
    </div>`;

  // Only needed for popup actions, but it lives in the header so it's findable
  // without hunting through an action editor.
  const urlEl = $('cmdOverlayUrl');
  if(urlEl){
    urlEl.value = (store.overlayUrls && store.overlayUrls.commands) || '';
    $('cmdCopyUrl').addEventListener('click', () => {
      urlEl.select();
      navigator.clipboard.writeText(urlEl.value).catch(()=>{});
      flash($('cmdCopyUrl'), 'Copied');
    });
  }

  $('cmdStarterBtn').addEventListener('click', openStarterPicker);

  $('cmdModeCommands').addEventListener('click', ()=> setMode('commands'));
  $('cmdModeAuto').addEventListener('click', ()=> setMode('auto'));
  $('cmdSearch').addEventListener('input', renderList);
  $('cmdAddBtn').addEventListener('click', ()=>{
    if(mode === 'commands'){
      const c = newCommand();
      commands.push(c); selId = c.id;
    } else {
      const m = newAutoMsg();
      automsgs.push(m); selId = m.id;
    }
    persist(); renderList(); renderEditor();
  });
}

function setMode(m){
  mode = m;
  selId = null;
  $('cmdModeCommands').className = m === 'commands' ? 'btn-sm' : 'btn-sm btn-ghost';
  $('cmdModeAuto').className     = m === 'auto'     ? 'btn-sm' : 'btn-sm btn-ghost';
  $('cmdAddBtn').textContent = m === 'commands' ? '+ New command' : '+ New message';
  $('cmdSearch').placeholder = m === 'commands' ? 'Search commands…' : 'Search auto messages…';
  // The starter pack only makes sense on the Commands side.
  $('cmdStarterWrap').style.display = m === 'commands' ? 'block' : 'none';
  renderList(); renderEditor();
}

// ── UI: list ─────────────────────────────────────────────────────────────────

// data-i is what initDrag() keys off; data-id is what the click handlers use.
function listRowHtml(item, sub, on, i){
  const active = item.id === selId;
  return `<div class="goal-card cmd-row" data-id="${item.id}" data-i="${i}" style="cursor:pointer;padding:10px 12px;margin-bottom:6px;${active?'border-color:#ffc83d':''}">
    <div style="display:flex;align-items:center;gap:8px">
      <span class="drag-handle" style="cursor:grab;color:#7a7a8c">⋮⋮</span>
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;${on?'':'opacity:.45'}">${esc(item.name || '(unnamed)')}</div>
        <div class="hint" style="margin:2px 0 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(sub)}</div>
      </div>
      <label class="checkrow" style="margin:0;flex-shrink:0" title="Enabled">
        <input type="checkbox" class="cmd-en" data-id="${item.id}" ${on?'checked':''}>
      </label>
    </div>
  </div>`;
}

function renderList(){
  const host = $('cmdList');
  if(!host) return;
  const q = ($('cmdSearch').value || '').trim().toLowerCase();

  // Index is the position in the FULL array so drag reordering stays correct;
  // dragging is disabled while a search is active anyway.
  if(mode === 'commands'){
    const rows = commands.map((c,i)=>({c,i})).filter(({c}) => !q || (c.name||'').toLowerCase().includes(q));
    host.innerHTML = rows.length
      ? rows.map(({c,i}) => {
          const KIND_LABEL = { audio:'sound', announce:'announcement', chat:'chat', tool:'tool', popup:'overlay' };
          const kinds = (c.actions||[]).map(a => KIND_LABEL[a.type] || a.type);
          const uniq = [...new Set(kinds)];
          const perm = PERMS.find(p => p.v === c.permission);
          const when = c.when === 'live' ? ' · live only' : c.when === 'offline' ? ' · offline only' : '';
          const ev = (c.events||[]).length ? ' · on ' + c.events.join('/') : '';
          const sub = `${uniq.join(' + ') || 'no actions'} · ${perm ? perm.l : 'Everyone'}${when}${ev}`;
          return listRowHtml(c, sub, c.enabled !== false, i);
        }).join('')
      : `<div class="hint">${q ? 'Nothing matches that search.' : 'No commands yet. Click <strong>+ New command</strong>.'}</div>`;
  } else {
    const rows = automsgs.map((m,i)=>({m,i})).filter(({m}) => !q || (m.name||'').toLowerCase().includes(q));
    host.innerHTML = rows.length
      ? rows.map(({m,i}) => {
          const n = (m.messages||[]).filter(t=>String(t||'').trim()).length;
          const sub = `${n} message${n===1?'':'s'} · every ${m.intervalMin||15} min`;
          return listRowHtml(m, sub, m.enabled !== false, i);
        }).join('')
      : `<div class="hint">${q ? 'Nothing matches that search.' : 'No auto messages yet. Click <strong>+ New message</strong>.'}</div>`;
  }

  host.querySelectorAll('.cmd-row').forEach(row => {
    row.addEventListener('click', ev => {
      if(ev.target.closest('.cmd-en') || ev.target.closest('.drag-handle')) return;
      selId = row.dataset.id;
      renderList(); renderEditor();
    });
  });
  host.querySelectorAll('.cmd-en').forEach(cb => {
    cb.addEventListener('change', () => {
      const arr = mode === 'commands' ? commands : automsgs;
      const it = arr.find(x => x.id === cb.dataset.id);
      if(it){ it.enabled = cb.checked; persist(); renderList(); }
    });
  });

  // HTML5 drag is unreliable in the Tauri WebView, so this is the shared
  // mousedown/mousemove helper every other tab uses. Skipped while filtering,
  // because the visible rows are then a subset and positions would be wrong.
  if(!q){
    initDrag(host, (src, dest) => {
      const arr = mode === 'commands' ? commands : automsgs;
      if(src == null || dest == null || src === dest) return;
      const [item] = arr.splice(src, 1);
      arr.splice(dest, 0, item);
      persist(); renderList();
    });
  }
}

// ── UI: editor ───────────────────────────────────────────────────────────────

function renderEditor(){
  const host = $('cmdEditor');
  if(!host) return;
  const arr = mode === 'commands' ? commands : automsgs;
  const item = arr.find(x => x.id === selId);
  if(!item){
    host.innerHTML = `<div class="hint" style="padding:40px 0;text-align:center">Select something on the left, or create a new one.</div>`;
    return;
  }
  if(mode === 'commands') renderCommandEditor(item);
  else renderAutoEditor(item);
}

function varHelpHtml(){
  return `<details style="margin-top:8px">
    <summary style="cursor:pointer;color:var(--muted);font-size:.82rem">Variables you can use</summary>
    <div style="margin-top:10px">

      <div class="hint" style="margin:0 0 4px">
        A variable is a placeholder. Type one into any box and SPARK swaps it for
        the real thing when the command runs.
      </div>
      <div class="hint" style="margin:0 0 12px">
        Type <code>Thanks for the follow, {user}!</code> and chat sees
        <em>Thanks for the follow, DaveTheStreamer!</em>
        The preview under each box always shows what chat will get.
      </div>

      ${VAR_GROUPS.map(grp => `
        <div style="font-size:.7rem;letter-spacing:.15em;text-transform:uppercase;color:var(--muted);font-weight:700;margin:16px 0 6px">${esc(grp.g)}</div>
        <div style="display:grid;grid-template-columns:auto 1fr;gap:8px 12px;font-size:.82rem;align-items:baseline">
          ${grp.vars.map(v => `
            <code style="white-space:nowrap">${esc(v.k)}</code>
            <div>
              <div>${esc(v.d)}</div>
              ${v.ex ? `<div class="hint" style="margin:1px 0 0;opacity:.75">becomes: ${esc(v.ex)}</div>` : ''}
            </div>`).join('')}
        </div>`).join('')}

      <div class="hint" style="margin-top:16px">
        Some of these have to ask Twitch for the answer. SPARK only does that when
        you actually use them, so mix and match as much as you like.
      </div>
    </div>
  </details>`;
}

// Named items the streamer can point a tool action at. Read live from the
// store so renaming a timer in its own tab is reflected here immediately.
function targetOptions(tool){
  if(tool === 'timers')   return ((store.timers && store.timers.list) || []).map(t => t.name).filter(Boolean);
  if(tool === 'counters') return ((store.counters && store.counters.counters) || []).map(c => c.name).filter(Boolean);
  if(tool === 'goals')    return ((store.goals && store.goals.bars) || []).map(b => b.name).filter(Boolean);
  return [];
}

// One line describing what an action does, for the collapsed header. The point
// is to make a folded card still answer "what is this step?" without opening it.
function actionSummary(a){
  const clip = (s, n=64) => {
    const t = String(s||'').replace(/\s+/g,' ').trim();
    return t ? (t.length > n ? t.slice(0,n-1) + '…' : t) : '';
  };
  if(a.type === 'wait')  return `${a.seconds == null ? 1 : a.seconds}s`;
  if(a.type === 'audio') return a.path ? a.path.split(/[\\/]/).pop() : 'no file chosen';
  if(a.type === 'tool'){
    const def = TOOL_ACTIONS[a.tool];
    const act = def && def.actions.find(x => x.v === a.action);
    let s = `${def ? def.label : a.tool} · ${act ? act.l : a.action}`;
    if(def && def.needsAmount && a.action !== 'reset') s += ' ' + (a.amount == null ? 1 : a.amount);
    if(def && def.needsTarget) s += ' → ' + (a.target || 'first one');
    return s;
  }
  if(a.type === 'popup'){
    const bits = [];
    if(a.text) bits.push(clip(a.text, 40));
    const mode = a.imageMode || (a.image ? 'file' : 'none');
    if(mode === 'file')   bits.push(a.image ? '+ image' : '+ image (none chosen)');
    if(mode === 'url')    bits.push('+ image from URL');
    if(mode === 'avatar') bits.push('+ @mention avatar');
    return bits.join(' ') || 'nothing set';
  }
  if(a.type === 'announce') return clip(a.text) || 'empty';
  return clip(a.text) || 'empty';
}

function actionHtml(a, i){
  const typeLabel = (ACTION_TYPES.find(t => t.v === a.type) || {}).l || a.type;
  // A name the streamer gave this step. Falls back to the type so an unnamed
  // action still reads sensibly.
  const shown = (a.label && a.label.trim()) ? a.label.trim() : typeLabel;
  const isShut = collapsed.has(a.aid);

  // Folded: just the header. Reorder and delete stay reachable so a long chain
  // can be rearranged without opening anything.
  if(isShut){
    return `<div class="goal-card" style="padding:8px 12px;margin-bottom:8px">
      <div class="row" style="align-items:center;gap:8px">
        <span class="hint" style="margin:0;min-width:18px">${i+1}.</span>
        <button class="btn-sm btn-ghost" data-act="fold" data-i="${i}" title="Expand" style="padding:2px 8px">▸</button>
        <strong style="font-size:.85rem;white-space:nowrap">${esc(shown)}</strong>
        <span class="hint" style="margin:0;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(actionSummary(a))}</span>
        <button class="btn-sm btn-ghost" data-act="up" data-i="${i}" title="Move up">↑</button>
        <button class="btn-sm btn-ghost" data-act="down" data-i="${i}" title="Move down">↓</button>
        <button class="btn-sm btn-ghost" data-act="del" data-i="${i}" title="Remove">✕</button>
      </div>
    </div>`;
  }

  const typeOpts = ACTION_TYPES.map(t => `<option value="${t.v}" ${a.type===t.v?'selected':''}>${t.l}</option>`).join('');
  let body = '';
  if(a.type === 'wait'){
    body = `<div class="row mt" style="align-items:center;gap:8px">
        <label style="margin:0">Pause for</label>
        <input type="number" data-act="waitsecs" data-i="${i}" value="${a.seconds==null?1:a.seconds}" min="0" max="300" step="0.1" style="width:100px">
        <label style="margin:0">seconds, then carry on</label>
      </div>
      <div class="hint">Only this run waits. Another command — or the same one from someone else — carries on as normal.</div>`;
  }
  else if(a.type === 'tool'){
    const def = TOOL_ACTIONS[a.tool] || TOOL_ACTIONS.wheel;
    const toolOpts = Object.entries(TOOL_ACTIONS)
      .map(([k,v]) => `<option value="${k}" ${a.tool===k?'selected':''}>${v.label}</option>`).join('');
    const actOpts = def.actions
      .map(x => `<option value="${x.v}" ${a.action===x.v?'selected':''}>${x.l}</option>`).join('');

    let extra = '';
    if(def.needsTarget){
      const names = targetOptions(a.tool);
      const opts = names.map(n => `<option value="${esc(n)}" ${a.target===n?'selected':''}>${esc(n)}</option>`).join('');
      extra += `<div><label>Which one</label><select data-act="tooltarget" data-i="${i}">
          <option value="">${names.length ? 'First one' : 'None set up yet'}</option>${opts}
        </select></div>`;
    }
    if(def.needsAmount && a.action !== 'reset'){
      extra += `<div><label>Amount</label><input type="number" data-act="toolamount" data-i="${i}" value="${a.amount==null?1:a.amount}" step="any"></div>`;
    }

    body = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:8px">
        <div><label>Tool</label><select data-act="tool" data-i="${i}">${toolOpts}</select></div>
        <div><label>Do what</label><select data-act="toolaction" data-i="${i}">${actOpts}</select></div>
        ${extra}
      </div>
      <div class="hint">If that tool is switched off in Settings, this step is skipped and the rest of the command still runs.</div>`;
  }
  else if(a.type === 'popup'){
    const posOpts  = POPUP_POSITIONS.map(p => `<option value="${p.v}" ${a.position===p.v?'selected':''}>${p.l}</option>`).join('');
    const animOpts = POPUP_ANIMS.map(p => `<option value="${p.v}" ${a.anim===p.v?'selected':''}>${p.l}</option>`).join('');
    const effOpts  = TEXT_EFFECTS.map(p => `<option value="${p.v}" ${(a.textEffect||'none')===p.v?'selected':''}>${p.l}</option>`).join('');
    const fontOpts = POPUP_FONTS.map(f => `<option value="${f}" ${a.font===f?'selected':''}>${f}</option>`).join('');
    const imgName  = a.image ? a.image.split(/[\\/]/).pop() : 'No file chosen';
    const mode     = a.imageMode || (a.image ? 'file' : 'none');
    const unitSel  = (act, val) => `<select data-act="${act}" data-i="${i}" style="width:60px">
        <option value="px" ${val==='px'?'selected':''}>px</option>
        <option value="%" ${val!=='px'?'selected':''}>%</option></select>`;

    let imageBody = '';
    if(mode === 'file'){
      imageBody = `<div class="row mt" style="align-items:center;gap:8px;flex-wrap:wrap">
          <button class="btn-sm" data-act="popimg" data-i="${i}">Choose image…</button>
          <span class="hint" style="margin:0">${esc(imgName)}</span>
        </div>`;
    } else if(mode === 'url'){
      imageBody = `<input type="text" data-act="popimgurl" data-i="${i}" value="${esc(a.imageUrl||'')}" placeholder="https://example.com/picture.png" style="width:100%;margin-top:8px">
        <div class="hint">Variables work here too. <code>{targetavatar}</code> gives you the picture of whoever the viewer named.</div>`;
    } else if(mode === 'avatar'){
      imageBody = `<div class="hint mt">Uses the profile picture of whoever is <code>@mentioned</code> in the command — <code>!so @someone</code>. Falls back to the person who ran it if nobody was mentioned.</div>`;
    }

    body = `<textarea data-act="poptext" data-i="${i}" rows="2" placeholder="Text to show (optional)" style="width:100%;margin-top:8px">${esc(a.text||'')}</textarea>
      <div class="hint" data-preview="${i}" style="margin-top:4px"></div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:10px">
        <div><label>Image</label><select data-act="popimgmode" data-i="${i}">
          <option value="none"   ${mode==='none'?'selected':''}>None</option>
          <option value="file"   ${mode==='file'?'selected':''}>From a file</option>
          <option value="url"    ${mode==='url'?'selected':''}>From a URL</option>
          <option value="avatar" ${mode==='avatar'?'selected':''}>Profile picture of @mentioned user</option>
        </select></div>
        ${mode!=='none' ? `<div><label>Max image size (px)</label><input type="number" data-act="popimgsize" data-i="${i}" value="${a.imageSize||340}" min="40" max="1200"></div>` : ''}
      </div>
      ${imageBody}

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:12px">
        <div><label>Placement</label><select data-act="popposmode" data-i="${i}">
          <option value="anchor" ${a.posMode!=='exact'?'selected':''}>Preset corner</option>
          <option value="exact"  ${a.posMode==='exact'?'selected':''}>Exact coordinates</option>
        </select></div>
        ${a.posMode==='exact' ? '' : `<div><label>Position</label><select data-act="popposition" data-i="${i}">${posOpts}</select></div>`}
      </div>

      ${a.posMode==='exact' ? `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-top:10px">
        <div><label>X</label><div class="row" style="gap:4px"><input type="number" data-act="popx" data-i="${i}" value="${a.x==null?50:a.x}" style="flex:1">${unitSel('popxunit', a.xUnit)}</div></div>
        <div><label>Y</label><div class="row" style="gap:4px"><input type="number" data-act="popy" data-i="${i}" value="${a.y==null?50:a.y}" style="flex:1">${unitSel('popyunit', a.yUnit)}</div></div>
        <div><label>Width (0 = auto)</label><div class="row" style="gap:4px"><input type="number" data-act="popw" data-i="${i}" value="${a.w||0}" min="0" style="flex:1">${unitSel('popwunit', a.wUnit)}</div></div>
        <div><label>Height (0 = auto)</label><div class="row" style="gap:4px"><input type="number" data-act="poph" data-i="${i}" value="${a.h||0}" min="0" style="flex:1">${unitSel('pophunit', a.hUnit)}</div></div>
      </div>
      <div class="hint">X and Y are the centre of the popup. A 1920x1080 scene at 50% / 50% puts it dead centre.</div>` : ''}

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-top:12px">
        <div><label>Animation</label><select data-act="popanim" data-i="${i}">${animOpts}</select></div>
        <div><label>Text effect</label><select data-act="popeffect" data-i="${i}">${effOpts}</select></div>
        ${(a.textEffect && a.textEffect !== 'none') ? `<div><label>Effect speed (ms each)</label><input type="number" data-act="popeffectspeed" data-i="${i}" value="${a.effectSpeed||40}" min="5" max="500"></div>` : ''}
        <div><label>Seconds on screen</label><input type="number" data-act="popduration" data-i="${i}" value="${a.duration||5}" min="1" max="60"></div>
        <div><label>Padding (px)</label><input type="number" data-act="poppad" data-i="${i}" value="${a.pad==null?18:a.pad}" min="0" max="80"></div>
        <div><label>Font</label><select data-act="popfont" data-i="${i}">${fontOpts}</select></div>
        <div><label>Text size (px)</label><input type="number" data-act="popsize" data-i="${i}" value="${a.size||34}" min="10" max="120"></div>
        <div><label>Text colour</label><input type="color" data-act="popcolor" data-i="${i}" value="${a.color||'#ffffff'}" style="width:50px;height:32px;border:none;background:none;cursor:pointer"></div>
        ${a.bg ? `<div><label>Background</label><input type="color" data-act="popbg" data-i="${i}" value="${a.bg}" style="width:50px;height:32px;border:none;background:none;cursor:pointer"></div>` : ''}
        ${a.border ? `<div><label>Border</label><input type="color" data-act="popborder" data-i="${i}" value="${a.border}" style="width:50px;height:32px;border:none;background:none;cursor:pointer"></div>` : ''}
      </div>
      <div class="row mt" style="gap:14px;flex-wrap:wrap;align-items:center">
        <label class="checkrow" style="margin:0"><input type="checkbox" data-act="popnobg" data-i="${i}" ${a.bg?'':'checked'}> No background</label>
        <label class="checkrow" style="margin:0"><input type="checkbox" data-act="popnoborder" data-i="${i}" ${a.border?'':'checked'}> No border</label>
        <label class="checkrow" style="margin:0"><input type="checkbox" data-act="popglow" data-i="${i}" ${a.glow?'checked':''}> Glow</label>
        <label class="checkrow" style="margin:0"><input type="checkbox" data-act="popshadow" data-i="${i}" ${a.shadow!==false?'checked':''}> Text shadow</label>
        <button class="btn-sm btn-ghost" data-act="poptest" data-i="${i}">Test on overlay</button>
      </div>
      <div class="hint">Add the overlay URL from the top of this tab as a Browser Source in OBS.</div>`;
  }
  else if(a.type === 'audio'){
    const fname = a.path ? a.path.split(/[\\/]/).pop() : 'No file selected';
    body = `<div class="row mt" style="align-items:center;gap:8px;flex-wrap:wrap">
        <button class="btn-sm" data-act="pick" data-i="${i}">Choose sound…</button>
        <button class="btn-sm btn-ghost" data-act="test" data-i="${i}">Test</button>
        <button class="btn-sm btn-ghost" data-act="clearfile" data-i="${i}">Clear</button>
        <span class="hint" style="margin:0">${esc(fname)}</span>
      </div>
      <div class="row mt" style="align-items:center;gap:8px">
        <label style="margin:0">Volume</label>
        <input type="range" min="0" max="100" value="${a.volume==null?100:a.volume}" data-act="vol" data-i="${i}" style="flex:1;max-width:220px">
        <span class="hint" style="margin:0" id="cmdVol${i}">${a.volume==null?100:a.volume}%</span>
      </div>`;
  } else {
    const colorSel = a.type === 'announce'
      ? `<div style="margin-top:8px;max-width:220px"><label>Highlight colour</label>
           <select data-act="color" data-i="${i}">${ANNOUNCE_COLORS.map(c=>`<option value="${c.v}" ${a.color===c.v?'selected':''}>${c.l}</option>`).join('')}</select></div>`
      : '';
    body = `<textarea data-act="text" data-i="${i}" rows="2" placeholder="What should it say?" style="width:100%;margin-top:8px">${esc(a.text||'')}</textarea>
      <div class="hint" data-preview="${i}" style="margin-top:4px"></div>
      ${colorSel}`;
  }
  return `<div class="goal-card" style="padding:12px;margin-bottom:10px">
    <div class="row" style="align-items:center;gap:8px">
      <span class="hint" style="margin:0;min-width:18px">${i+1}.</span>
      <button class="btn-sm btn-ghost" data-act="fold" data-i="${i}" title="Collapse" style="padding:2px 8px">▾</button>
      <select data-act="type" data-i="${i}" style="max-width:170px">${typeOpts}</select>
      <input type="text" data-act="label" data-i="${i}" value="${esc(a.label||'')}"
             placeholder="Name this step (optional)" style="flex:1;min-width:120px">
      <div style="flex:1"></div>
      <button class="btn-sm btn-ghost" data-act="up" data-i="${i}" title="Move up">↑</button>
      <button class="btn-sm btn-ghost" data-act="down" data-i="${i}" title="Move down">↓</button>
      <button class="btn-sm btn-ghost" data-act="del" data-i="${i}" title="Remove">✕</button>
    </div>
    ${body}
  </div>`;
}

function renderCommandEditor(c){
  const host = $('cmdEditor');

  // Opening a different command starts folded, so a long action chain is not a
  // wall of controls. Only fires on the switch, not on the many re-renders an
  // edit triggers.
  if(lastEditorCmd !== c.id){
    lastEditorCmd = c.id;
    if((c.actions||[]).length > 1) (c.actions||[]).forEach(a => collapsed.add(a.aid));
  }

  const permOpts = PERMS.map(p => `<option value="${p.v}" ${c.permission===p.v?'selected':''}>${p.l}</option>`).join('');

  host.innerHTML = `
    <div class="goal-card" style="padding:18px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div>
          <label>Command</label>
          <input type="text" id="cmdEdName" value="${esc(c.name)}" placeholder="!discord">
          <div class="warn" id="cmdEdNameWarn" style="display:none;margin-top:6px"></div>
        </div>
        <div>
          <label>Aliases (comma separated)</label>
          <input type="text" id="cmdEdAliases" value="${esc((c.aliases||[]).join(', '))}" placeholder="!dc, !server">
          <div class="warn" id="cmdEdAliasWarn" style="display:none;margin-top:6px"></div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:12px">
        <div><label>Who can use it</label><select id="cmdEdPerm">${permOpts}</select></div>
        <div><label>Cooldown (seconds)</label><input type="number" id="cmdEdCd" value="${c.cooldown||0}" min="0"></div>
        <div><label>Per-viewer cooldown (s)</label><input type="number" id="cmdEdUcd" value="${c.userCooldown||0}" min="0"></div>
      </div>
      <div class="hint">Cooldown applies to the whole channel; per-viewer limits one person. Mods and you always bypass both. 0 = off.</div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px">
        <div><label>Active</label><select id="cmdEdWhen">
          <option value="always"  ${(c.when||'always')==='always'?'selected':''}>Always</option>
          <option value="live"    ${c.when==='live'?'selected':''}>Only while live</option>
          <option value="offline" ${c.when==='offline'?'selected':''}>Only while offline</option>
        </select></div>
        <div><label>Only in these categories</label>
          <input type="text" id="cmdEdCats" value="${esc(c.categories||'')}" placeholder="Any category">
        </div>
      </div>
      <div class="hint">Categories are comma separated and match loosely, so "zelda" catches "The Legend of Zelda". When a command is out of season it stays completely silent rather than replying with an excuse.</div>

      <div style="margin-top:12px">
        <label>Also trigger from a channel point reward</label>
        <select id="cmdEdReward"><option value="">None</option></select>
        <div class="hint">Redeems ignore the cooldowns and permission above, since Twitch already gates them.</div>
      </div>

      <div style="margin-top:12px">
        <label>Also run automatically when…</label>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:2px 14px">
          ${EVENT_TRIGGERS.map(t => `<label class="checkrow" style="margin:2px 0">
            <input type="checkbox" class="cmd-ev" data-ev="${t.v}" ${(c.events||[]).includes(t.v)?'checked':''}> ${t.l}
          </label>`).join('')}
        </div>
        <div class="hint">Nobody types anything for these, so cooldowns and permission do not apply. <code>{user}</code> is the person who raided or followed, and <code>{targetavatar}</code> is their picture, so a raid can put their face on your overlay.</div>
        <div class="hint">The three ad triggers fire on their own too. <code>{adduration}</code> is how long the break runs, and <code>{adnextin}</code> is the seconds left before it starts.</div>
        <div class="row" style="align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap">
          <label style="margin:0">Warn</label>
          <input type="number" id="cmdEdAdWarn" value="${Math.max(5, Math.min(600, parseInt(cfg.adWarnSeconds)||60))}" min="5" max="600" style="width:90px">
          <label style="margin:0">seconds before an ad break</label>
        </div>
        <div class="hint">Shared by every command, since there is only one ad schedule. Twitch gives no warning of its own, so SPARK watches the schedule — snoozing a break after the warning has gone out cannot un-send it. “Ads finish” is worked out from the start plus the length Twitch reports, so a manually shortened break ends a little late.</div>
      </div>

      <hr class="sep">

      <div class="row" style="align-items:center;gap:8px;flex-wrap:wrap">
        <h2 style="margin:0;flex:1">Actions</h2>
        ${(c.actions||[]).length > 1 ? `<button class="btn-sm btn-ghost" id="cmdEdFoldAll">${(c.actions||[]).every(a=>collapsed.has(a.aid)) ? 'Expand all' : 'Collapse all'}</button>` : ''}
        <select id="cmdEdAddType" style="max-width:170px">${ACTION_TYPES.map(t=>`<option value="${t.v}">${t.l}</option>`).join('')}</select>
        <button class="btn-sm" id="cmdEdAddAction">Add action</button>
      </div>
      <div class="hint">They run top to bottom. A command can post a message and play a sound. Give each one a name to keep a long list straight.</div>
      <div id="cmdActions" style="margin-top:10px">
        ${(c.actions||[]).map((a,i)=>actionHtml(a,i)).join('') || '<div class="hint">No actions yet — this command will do nothing.</div>'}
      </div>
      ${varHelpHtml()}

      <hr class="sep">
      <h2 style="margin:0 0 6px">Test</h2>
      <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap">
        <label style="margin:0">as</label>
        <select id="cmdEdTestRole" style="max-width:150px">
          <option value="viewer">A viewer</option>
          <option value="follower">A follower</option>
          <option value="sub">A subscriber</option>
          <option value="vip">A VIP</option>
          <option value="mod">A mod</option>
          <option value="broadcaster" selected>You</option>
        </select>
        <input type="text" id="cmdEdTestArgs" placeholder="typed after the command, e.g. @someone" style="flex:1;min-width:180px">
        <button class="btn-sm" id="cmdEdTest">Run test</button>
      </div>
      <div class="hint" id="cmdEdTestResult" style="margin-top:6px"></div>

      <hr class="sep">
      <div class="row" style="gap:8px">
        <button class="btn-sm btn-ghost" id="cmdEdDupe">Duplicate</button>
        <div style="flex:1"></div>
        <button class="btn-sm btn-ghost" id="cmdEdDelete" style="color:#ff5d73">Delete</button>
      </div>
    </div>`;

  wireCommandEditor(c);
  fillRewards(c);
  updatePreviews(c);
}

function wireCommandEditor(c){
  const nameEl = $('cmdEdName');
  const nameWarn = $('cmdEdNameWarn');

  // Validate as they type so a clash is visible before they click away, but
  // only commit the value when it is actually free.
  const validateName = () => {
    const msg = commandConflict(nameEl.value, c.id);
    if(msg){
      nameWarn.textContent = '⚠ ' + msg;
      nameWarn.style.display = 'block';
      nameEl.style.borderColor = '#ff5d73';
      return false;
    }
    nameWarn.style.display = 'none';
    nameEl.style.borderColor = '';
    return true;
  };
  nameEl.addEventListener('input', validateName);
  nameEl.addEventListener('change', () => {
    if(!validateName()) return;         // keep the old name until it's valid
    c.name = normCmd(nameEl.value);
    nameEl.value = c.name;
    persist(); renderList();
  });
  validateName();

  const aliasEl = $('cmdEdAliases');
  const aliasWarn = $('cmdEdAliasWarn');
  const validateAliases = () => {
    const list = aliasEl.value.split(',').map(s=>s.trim()).filter(Boolean);
    for(const a of list){
      const msg = aliasConflict(a, c.id, c.name);
      if(msg){
        aliasWarn.textContent = '⚠ ' + msg;
        aliasWarn.style.display = 'block';
        aliasEl.style.borderColor = '#ff5d73';
        return null;
      }
    }
    aliasWarn.style.display = 'none';
    aliasEl.style.borderColor = '';
    return list.map(normCmd);
  };
  aliasEl.addEventListener('input', validateAliases);
  aliasEl.addEventListener('change', () => {
    const list = validateAliases();
    if(list === null) return;
    c.aliases = list;
    aliasEl.value = list.join(', ');
    persist();
  });
  validateAliases();

  $('cmdEdPerm').addEventListener('change', e => { c.permission = e.target.value; persist(); renderList(); });
  $('cmdEdCd').addEventListener('change',  e => { c.cooldown = Math.max(0, parseInt(e.target.value)||0); persist(); });
  $('cmdEdUcd').addEventListener('change', e => { c.userCooldown = Math.max(0, parseInt(e.target.value)||0); persist(); });
  $('cmdEdReward').addEventListener('change', e => { c.rewardId = e.target.value; persist(); });
  document.querySelectorAll('.cmd-ev').forEach(cb => {
    cb.addEventListener('change', () => {
      const set = new Set(c.events || []);
      cb.checked ? set.add(cb.dataset.ev) : set.delete(cb.dataset.ev);
      c.events = [...set];
      persist(); renderList();
    });
  });
  $('cmdEdWhen').addEventListener('change', e => { c.when = e.target.value; persist(); renderList(); });
  $('cmdEdCats').addEventListener('change', e => { c.categories = e.target.value.trim(); persist(); });
  const adWarnEl = $('cmdEdAdWarn');
  if(adWarnEl) adWarnEl.addEventListener('change', e => {
    cfg.adWarnSeconds = Math.max(5, Math.min(600, parseInt(e.target.value)||60));
    e.target.value = cfg.adWarnSeconds;
    persist();
  });

  const foldAll = $('cmdEdFoldAll');
  if(foldAll){
    foldAll.addEventListener('click', () => {
      const allShut = (c.actions||[]).every(a => collapsed.has(a.aid));
      (c.actions||[]).forEach(a => allShut ? collapsed.delete(a.aid) : collapsed.add(a.aid));
      renderCommandEditor(c);
    });
  }

  $('cmdEdAddAction').addEventListener('click', () => {
    c.actions = c.actions || [];
    const a = newAction($('cmdEdAddType').value);
    c.actions.push(a);
    collapsed.delete(a.aid);   // a brand new action opens — you just added it to edit it
    persist(); renderCommandEditor(c); renderList();
  });

  $('cmdActions').addEventListener('click', async ev => {
    const btn = ev.target.closest('[data-act]');
    if(!btn) return;
    const act = btn.dataset.act, i = parseInt(btn.dataset.i);
    const a = c.actions[i];
    if(!a) return;

    if(act === 'fold'){
      if(collapsed.has(a.aid)) collapsed.delete(a.aid); else collapsed.add(a.aid);
      renderCommandEditor(c);
    }
    else if(act === 'del'){ collapsed.delete(a.aid); c.actions.splice(i,1); persist(); renderCommandEditor(c); renderList(); }
    else if(act === 'up' && i > 0){ c.actions.splice(i-1,0,c.actions.splice(i,1)[0]); persist(); renderCommandEditor(c); }
    else if(act === 'down' && i < c.actions.length-1){ c.actions.splice(i+1,0,c.actions.splice(i,1)[0]); persist(); renderCommandEditor(c); }
    else if(act === 'pick'){
      const f = await dialog.open({ multiple:false, filters:[{name:'Audio',extensions:['mp3','wav','ogg','m4a']}] });
      if(f){ a.path = f; persist(); renderCommandEditor(c); }
    }
    else if(act === 'test'){ playAudio(a.path, a.volume, true); }
    else if(act === 'clearfile'){ a.path = ''; persist(); renderCommandEditor(c); }
    else if(act === 'popimg'){
      const f = await dialog.open({ multiple:false, filters:[{name:'Images',extensions:['png','jpg','jpeg','gif','webp','svg']}] });
      if(f){
        a.image = f;
        // The overlay fetches by command id + action index, so swapping the
        // file leaves the URL identical and the browser happily reuses the old
        // picture. Bumping this is what makes the change actually show up.
        a.imageVer = (a.imageVer || 0) + 1;
        persist(); renderCommandEditor(c);
      }
    }
    else if(act === 'poptest'){
      flash(btn, 'Sent');
      await runPopup(c, a, i, { user: store.twitch.login || 'you', args:'example' });
    }
  });

  $('cmdActions').addEventListener('change', ev => {
    const el = ev.target.closest('[data-act]');
    if(!el) return;
    const act = el.dataset.act, i = parseInt(el.dataset.i);
    const a = c.actions[i];
    if(!a) return;
    if(act === 'type'){
      const next = buildAction(el.value);
      // Same slot, same identity — keeps the collapse state attached to this
      // card rather than orphaning the old aid in the set forever.
      next.aid = a.aid;
      if(a.label) next.label = a.label;   // a name for the step survives a type change
      // Carry the text across so switching between the text-bearing types
      // (chat, announcement, popup) doesn't make them retype it.
      if(['chat','announce','popup'].includes(el.value) && a.text) next.text = a.text;
      c.actions[i] = next;
      collapsed.delete(a.aid);   // you just changed it, so show the new controls
      persist(); renderCommandEditor(c); renderList();
    }
    else if(act === 'color'){ a.color = el.value; persist(); }
    // ── Tool action ──
    else if(act === 'tool'){
      a.tool = el.value;
      // The old action name almost certainly doesn't exist on the new tool.
      const def = TOOL_ACTIONS[a.tool];
      a.action = def && def.actions.length ? def.actions[0].v : '';
      a.target = '';
      persist(); renderCommandEditor(c); renderList();
    }
    else if(act === 'toolaction'){ a.action = el.value; persist(); renderCommandEditor(c); }
    else if(act === 'tooltarget'){ a.target = el.value; persist(); }
    // ── Popup ──
    else if(act === 'popposition'){ a.position = el.value; persist(); }
    else if(act === 'popanim'){ a.anim = el.value; persist(); }
    else if(act === 'popeffect'){ a.textEffect = el.value; persist(); renderCommandEditor(c); }
    else if(act === 'popfont'){ a.font = el.value; persist(); }
    else if(act === 'popglow'){ a.glow = el.checked; persist(); }
    else if(act === 'popshadow'){ a.shadow = el.checked; persist(); }
    else if(act === 'popnobg'){
      // Remembering the last colour means unticking restores it rather than
      // dumping them back on an arbitrary default.
      if(el.checked){ a._lastBg = a.bg || '#1a1230'; a.bg = ''; }
      else { a.bg = a._lastBg || '#1a1230'; }
      persist(); renderCommandEditor(c);
    }
    else if(act === 'popnoborder'){
      if(el.checked){ a._lastBorder = a.border || '#ffc83d'; a.border = ''; }
      else { a.border = a._lastBorder || '#ffc83d'; }
      persist(); renderCommandEditor(c);
    }
    else if(act === 'popimgmode'){
      a.imageMode = el.value;
      persist(); renderCommandEditor(c);
    }
    else if(act === 'popposmode'){ a.posMode = el.value; persist(); renderCommandEditor(c); }
    else if(act === 'popxunit'){ a.xUnit = el.value; persist(); }
    else if(act === 'popyunit'){ a.yUnit = el.value; persist(); }
    else if(act === 'popwunit'){ a.wUnit = el.value; persist(); }
    else if(act === 'pophunit'){ a.hUnit = el.value; persist(); }
  });

  $('cmdActions').addEventListener('input', ev => {
    const el = ev.target.closest('[data-act]');
    if(!el) return;
    const act = el.dataset.act, i = parseInt(el.dataset.i);
    const a = c.actions[i];
    if(!a) return;
    // The preview can hit Twitch for {uptime}/{game}/{title}, so it is
    // debounced rather than run on every keystroke.
    if(act === 'label'){
      a.label = el.value;
      persist();
      return;   // don't re-render: it would blow away focus mid-typing
    }
    if(act === 'text' || act === 'poptext'){ a.text = el.value; persist(); queuePreview(c); }
    else if(act === 'vol'){
      a.volume = parseInt(el.value);
      const lbl = $('cmdVol' + i);
      if(lbl) lbl.textContent = a.volume + '%';
      persist();
    }
    else if(act === 'toolamount'){ a.amount = parseFloat(el.value) || 0; persist(); }
    else if(act === 'popduration'){ a.duration = Math.max(1, Math.min(60, parseInt(el.value)||5)); persist(); }
    else if(act === 'popsize'){ a.size = Math.max(10, Math.min(120, parseInt(el.value)||34)); persist(); }
    else if(act === 'popcolor'){ a.color = el.value; persist(); }
    else if(act === 'popbg'){ a.bg = el.value; persist(); }
    else if(act === 'popborder'){ a.border = el.value; persist(); }
    else if(act === 'popimgurl'){ a.imageUrl = el.value; persist(); }
    else if(act === 'popimgsize'){ a.imageSize = Math.max(40, Math.min(1200, parseInt(el.value)||340)); persist(); }
    else if(act === 'popx'){ a.x = parseFloat(el.value) || 0; persist(); }
    else if(act === 'popy'){ a.y = parseFloat(el.value) || 0; persist(); }
    else if(act === 'popw'){ a.w = Math.max(0, parseFloat(el.value) || 0); persist(); }
    else if(act === 'poph'){ a.h = Math.max(0, parseFloat(el.value) || 0); persist(); }
    else if(act === 'poppad'){ a.pad = Math.max(0, Math.min(80, parseInt(el.value)||0)); persist(); }
    else if(act === 'popeffectspeed'){ a.effectSpeed = Math.max(5, Math.min(500, parseInt(el.value)||40)); persist(); }
    else if(act === 'waitsecs'){ a.seconds = Math.max(0, Math.min(300, parseFloat(el.value)||0)); persist(); }
  });

  // Test as a chosen role. Runs the REAL permission and condition checks
  // against a fake viewer, so "why doesn't this fire for subs" is answerable
  // without recruiting an actual sub.
  $('cmdEdTest').addEventListener('click', async () => {
    const role = $('cmdEdTestRole').value;
    const args = $('cmdEdTestArgs').value || '';
    const out  = $('cmdEdTestResult');
    const fake = {
      username: store.twitch.login || 'testviewer',
      display:  store.twitch.login || 'TestViewer',
      user_id:  store.twitch.userId || '',
      is_broadcaster: role === 'broadcaster',
      is_mod:  role === 'mod',
      is_vip:  role === 'vip',
      is_sub:  role === 'sub',
      _fakeFollower: role === 'follower' || role === 'sub' || role === 'vip' || role === 'mod' || role === 'broadcaster',
    };

    // permitted() would hit Twitch for the follower tier; a simulated viewer
    // has no real follow state, so resolve that from the chosen role instead.
    let allowed;
    if(c.permission === 'follower') allowed = fake._fakeFollower;
    else allowed = await permitted(c.permission, fake);

    if(!allowed){
      out.innerHTML = `<span style="color:#ff5d73">✕ Blocked — ${esc(PERMS.find(p=>p.v===c.permission)?.l || '')} only. Nothing was sent.</span>`;
      return;
    }
    if(!(await conditionsMet(c))){
      const why = c.when === 'live' ? 'you are not live' : c.when === 'offline' ? 'you are live' : 'the current category does not match';
      out.innerHTML = `<span style="color:#ff5d73">✕ Blocked — ${esc(why)}. Nothing was sent.</span>`;
      return;
    }

    out.innerHTML = '<span style="color:#3ddc97">✓ Passed — running the actions.</span>';
    flash($('cmdEdTest'), 'Sent');
    await runActions(c, {
      user: fake.display, login: fake.username, userId: fake.user_id,
      args,
      isMod: fake.is_mod, isSub: fake.is_sub, isVip: fake.is_vip,
      isBroadcaster: fake.is_broadcaster,
      cmd: c, userCount: userCountOf(c, fake.username),
    });
  });

  $('cmdEdDupe').addEventListener('click', () => {
    const copy = JSON.parse(JSON.stringify(c));
    copy.id = uid();
    // Fresh aids, or the copy's cards would share collapsed state with the
    // original and folding one would fold both.
    (copy.actions||[]).forEach(a => { a.aid = uid(); });
    copy.aliases = [];
    // Guarantee a free name rather than creating the exact clash we warn about.
    let n = 2;
    while(commandConflict(c.name + n, null)) n++;
    copy.name = normCmd(c.name + n);
    commands.push(copy);
    selId = copy.id;
    persist(); renderList(); renderEditor();
  });

  $('cmdEdDelete').addEventListener('click', () => {
    if(!confirm(`Delete ${c.name}?`)) return;
    commands = commands.filter(x => x.id !== c.id);
    selId = null;
    persist(); renderList(); renderEditor();
  });
}

let previewTimer = null;
function queuePreview(c){
  clearTimeout(previewTimer);
  previewTimer = setTimeout(()=>{ updatePreviews(c).catch(()=>{}); }, 350);
}

// Live "this is what chat will see" line under each text box.
async function updatePreviews(c){
  const host = $('cmdActions');
  if(!host) return;
  for(let i = 0; i < (c.actions||[]).length; i++){
    const a = c.actions[i];
    const el = host.querySelector(`[data-preview="${i}"]`);
    if(!el || !a) continue;
    if(!['chat','announce','popup'].includes(a.type)) continue;
    if(!String(a.text||'').trim()){ el.textContent = ''; continue; }
    const out = await resolveVars(a.text, { user: store.twitch.login || 'viewer', args: 'example' });
    el.textContent = '→ ' + out;
  }
}

async function fillRewards(c){
  const sel = $('cmdEdReward');
  if(!sel || !store.twitch.connected) return;
  try{
    const r = await invoke('twitch_get_rewards');
    ((r && r.rewards) || []).forEach(rw => {
      const o = document.createElement('option');
      o.value = rw.id;
      o.textContent = rw.title;
      if(c.rewardId === rw.id) o.selected = true;
      sel.appendChild(o);
    });
  }catch(e){ /* not connected / no affiliate — leave it at None */ }
}

// ── UI: auto message editor ──────────────────────────────────────────────────

function renderAutoEditor(m){
  const host = $('cmdEditor');
  host.innerHTML = `
    <div class="goal-card" style="padding:18px">
      <label>Name (just for your list)</label>
      <input type="text" id="amName" value="${esc(m.name||'')}" placeholder="Socials plug">

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:12px">
        <div><label>Every (minutes)</label><input type="number" id="amInterval" value="${m.intervalMin||15}" min="1"></div>
        <div><label>Only if chat has said (lines)</label><input type="number" id="amLines" value="${m.minLines||0}" min="0"></div>
        <div><label>Order</label><select id="amOrder">
          <option value="rotate" ${m.order!=='random'?'selected':''}>Rotate in order</option>
          <option value="random" ${m.order==='random'?'selected':''}>Pick at random</option>
        </select></div>
      </div>
      <div class="hint">0 lines means it posts on the timer regardless of how quiet chat is.</div>

      <label class="checkrow mt"><input type="checkbox" id="amAnnounce" ${m.announce?'checked':''}> Post as a highlighted announcement</label>
      <div id="amColorWrap" style="display:${m.announce?'block':'none'};max-width:220px">
        <label>Highlight colour</label>
        <select id="amColor">${ANNOUNCE_COLORS.map(c=>`<option value="${c.v}" ${m.color===c.v?'selected':''}>${c.l}</option>`).join('')}</select>
      </div>

      <hr class="sep">
      <div class="row" style="align-items:center;gap:8px">
        <h2 style="margin:0;flex:1">Messages</h2>
        <button class="btn-sm" id="amAdd">Add message</button>
      </div>
      <div id="amList" style="margin-top:10px"></div>
      ${varHelpHtml()}

      <hr class="sep">
      <div class="row" style="gap:8px">
        <button class="btn-sm" id="amTest">Post one now</button>
        <div style="flex:1"></div>
        <button class="btn-sm btn-ghost" id="amDelete" style="color:#ff5d73">Delete</button>
      </div>
    </div>`;

  renderAutoMessages(m);

  $('amName').addEventListener('change', e => { m.name = e.target.value.trim() || 'Auto message'; e.target.value = m.name; persist(); renderList(); });
  $('amInterval').addEventListener('change', e => { m.intervalMin = Math.max(1, parseInt(e.target.value)||15); persist(); renderList(); });
  $('amLines').addEventListener('change', e => { m.minLines = Math.max(0, parseInt(e.target.value)||0); persist(); });
  $('amOrder').addEventListener('change', e => { m.order = e.target.value; persist(); });
  $('amAnnounce').addEventListener('change', e => {
    m.announce = e.target.checked;
    $('amColorWrap').style.display = m.announce ? 'block' : 'none';
    persist();
  });
  $('amColor').addEventListener('change', e => { m.color = e.target.value; persist(); });
  $('amAdd').addEventListener('click', () => { m.messages = m.messages || []; m.messages.push(''); persist(); renderAutoMessages(m); });
  $('amTest').addEventListener('click', async () => { flash($('amTest'), 'Posted'); await autoFire(m); });
  $('amDelete').addEventListener('click', () => {
    if(!confirm(`Delete "${m.name}"?`)) return;
    automsgs = automsgs.filter(x => x.id !== m.id);
    selId = null;
    persist(); renderList(); renderEditor();
  });
}

function renderAutoMessages(m){
  const host = $('amList');
  if(!host) return;
  const list = m.messages || [];
  host.innerHTML = list.length
    ? list.map((t,i) => `<div class="row" style="gap:8px;align-items:flex-start;margin-bottom:8px">
        <span class="hint" style="margin:6px 0 0;min-width:18px">${i+1}.</span>
        <textarea data-am="${i}" rows="2" style="flex:1" placeholder="Follow me on…">${esc(t)}</textarea>
        <button class="btn-sm btn-ghost" data-amdel="${i}" title="Remove">✕</button>
      </div>`).join('')
    : '<div class="hint">No messages yet — nothing will be posted.</div>';

  host.querySelectorAll('[data-am]').forEach(ta => {
    ta.addEventListener('input', () => { m.messages[parseInt(ta.dataset.am)] = ta.value; persist(); });
  });
  host.querySelectorAll('[data-amdel]').forEach(b => {
    b.addEventListener('click', () => { m.messages.splice(parseInt(b.dataset.amdel), 1); persist(); renderAutoMessages(m); renderList(); });
  });
}

// ── Init ─────────────────────────────────────────────────────────────────────

export async function initCommands(){
  const d = store.commands || {};
  commands = Array.isArray(d.commands) ? d.commands : [];
  automsgs = Array.isArray(d.automessages) ? d.automessages : [];
  cfg = Object.assign({ autoPauseOffline:true, adWarnSeconds:60 }, d.cfg || {});

  // Old saves predate some fields; fill them in so the editor never reads
  // undefined and writes NaN back to disk.
  commands.forEach(c => {
    if(!c.id) c.id = uid();
    if(!Array.isArray(c.aliases)) c.aliases = [];
    if(!Array.isArray(c.actions)) c.actions = [];
    c.actions.forEach(a => { if(a && !a.aid) a.aid = uid(); });
    if(!c.when) c.when = 'always';
    if(!Array.isArray(c.events)) c.events = [];
    if(typeof c.categories !== 'string') c.categories = '';
    if(!c.userCounts || typeof c.userCounts !== 'object') c.userCounts = {};
  });
  automsgs.forEach(m => {
    if(!m.id) m.id = uid();
    if(!Array.isArray(m.messages)) m.messages = [];
  });

  buildShell();
  setMode('commands');
  startAutoLoop();
  startAdLoops();

  // Fire-and-forget: a slow or failed Twitch call must never hold up boot.
  checkScope().catch(()=>{});
}
