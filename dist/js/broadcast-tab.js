// ── Broadcast tab ─────────────────────────────────────────────────────────────
// Everything you would otherwise open twitch.tv for mid-stream.
//
// Layout (see #pane-broadcast in index.html):
//   left        stream info — title, category, tags, saved presets, marker
//   right top   live chat with moderation
//   right lower quick actions — raid, shoutout, poll, prediction
//   between the two right panes: a draggable divider
//
// Phase 1 of 3 lives here: the shell, the divider, and stream info. The chat
// pane and the quick actions are stubbed with a placeholder so the layout is
// real and testable before either is filled in.

import { store }                 from './store.js';
import { $, esc, flash }         from './utils.js';

const { invoke } = window.__TAURI__.core;

// store.broadcast = { presets:[{id,name,title,gameId,gameName,tags[]}],
//                     pollTemplates:[], predTemplates:[], splitPct }
let data = null;

// Whatever is currently in the three fields. Kept separate from the saved
// channel state so "unsaved changes" can be shown honestly.
let cur   = { title:'', gameId:'', gameName:'', tags:[] };
let saved = { title:'', gameId:'', gameName:'', tags:[] };

let searchTimer = null;
let searchResults = [];

function uid(){ return Math.random().toString(36).slice(2,10); }

function persist(){
  invoke('save_broadcast', { data }).catch(()=>{});
}

// Element-by-element rather than joining into one string: joining with an empty
// separator makes ['a','bc'] and ['ab','c'] look identical, which would leave a
// genuine tag change showing as "no unsaved changes".
function sameTags(a, b){
  if(!Array.isArray(a) || !Array.isArray(b)) return false;
  if(a.length !== b.length) return false;
  return a.every((t, i) => t === b[i]);
}

function dirty(){
  return cur.title !== saved.title
      || cur.gameId !== saved.gameId
      || !sameTags(cur.tags, saved.tags);
}

// ── Resizable divider ─────────────────────────────────────────────────────────
// flex-basis in percent rather than a pixel height, so the split survives a
// window resize instead of leaving one pane clipped.

function applySplit(){
  const pct = Math.min(85, Math.max(15, Number(data.splitPct) || 60));
  const chat = $('bcChatPane'), acts = $('bcActionsPane');
  if(chat) chat.style.flexBasis = pct + '%';
  if(acts) acts.style.flexBasis = (100 - pct) + '%';
}

function initDivider(){
  const bar = $('bcDivider'), right = document.querySelector('#pane-broadcast .bc-right');
  if(!bar || !right) return;

  // mousedown/mousemove rather than the HTML5 drag API — the latter is
  // unreliable in this WebView, same reason the other drag handles avoid it.
  bar.addEventListener('mousedown', e => {
    e.preventDefault();
    document.body.classList.add('bc-dragging');

    const move = ev => {
      const r = right.getBoundingClientRect();
      if(r.height <= 0) return;
      const pct = ((ev.clientY - r.top) / r.height) * 100;
      data.splitPct = Math.min(85, Math.max(15, pct));
      applySplit();
    };
    const up = () => {
      document.body.classList.remove('bc-dragging');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      persist();   // only on release — not on every pixel of the drag
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

// ── Left column ───────────────────────────────────────────────────────────────

function buildLeft(){
  const el = $('bcLeft'); if(!el) return;
  el.innerHTML = `
  <div class="card">
    <h2>Status</h2>
    <div id="bcStatus" class="hint">Not connected to Twitch.</div>
  </div>

  <div class="card">
    <h2>Stream Info</h2>
    <div class="warn" id="bcInfoWarn" style="display:none"></div>
    <label>Title</label>
    <input type="text" id="bcTitle" maxlength="140" placeholder="What are you streaming?">
    <div class="hint" id="bcTitleCount">0 / 140</div>

    <label class="mt">Category</label>
    <div id="bcCatCurrent"></div>
    <input type="text" id="bcCatSearch" placeholder="Search for a game or category…" autocomplete="off">
    <div id="bcCatResults" style="display:none"></div>

    <label class="mt">Tags</label>
    <div class="row" style="gap:6px">
      <input type="text" id="bcTagInput" placeholder="Add a tag and press Enter" style="flex:1">
      <button class="btn-sm" id="bcTagAdd">Add</button>
    </div>
    <div id="bcTagList" style="margin-top:8px"></div>
    <div class="hint">Up to 10 tags, 25 characters each. Spaces are removed — Twitch does not allow them inside a tag.</div>

    <div class="row mt">
      <button class="btn-sm btn-gold" id="bcApply">Apply to Twitch</button>
      <button class="btn-sm btn-ghost" id="bcRevert">Revert</button>
      <span class="ok" id="bcInfoOk" style="display:none;margin-left:4px">Updated!</span>
    </div>
  </div>

  <div class="card">
    <h2>Presets</h2>
    <div class="hint" style="margin-bottom:8px">A preset stores the title, category and tags together. Loading one fills all three in at once — it does not send anything to Twitch until you press Apply.</div>
    <div id="bcPresetList"></div>
    <div class="row mt" style="gap:6px">
      <input type="text" id="bcPresetName" placeholder="Name this setup, e.g. Horror night" style="flex:1">
      <button class="btn-sm btn-gold" id="bcPresetSave">Save current</button>
    </div>
  </div>

  <div class="card">
    <h2>Stream Marker</h2>
    <div class="hint" style="margin-bottom:8px">Drops a bookmark at the current moment so you can find it later when editing the VOD. Only works while you are live.</div>
    <div class="row" style="gap:6px">
      <input type="text" id="bcMarkerDesc" placeholder="Optional note, e.g. clutch play" style="flex:1">
      <button class="btn-sm" id="bcMarker">Add marker</button>
    </div>
    <div class="warn" id="bcMarkerWarn" style="display:none"></div>
    <div class="ok" id="bcMarkerOk" style="display:none"></div>
  </div>

`;

  wireLeft();
  renderTags();
  renderPresets();
}

// ── Tags ──────────────────────────────────────────────────────────────────────

function renderTags(){
  const host = $('bcTagList'); if(!host) return;
  if(!cur.tags.length){ host.innerHTML = '<div class="hint">No tags.</div>'; return; }
  host.innerHTML = cur.tags.map((t,i) =>
    `<span class="tag" style="margin:0 6px 6px 0;display:inline-flex;align-items:center;gap:6px">${esc(t)}`
    + `<button class="btn-sm btn-ghost" style="padding:0 5px;font-size:.7rem;line-height:1.4" data-tagdel="${i}" title="Remove">✕</button></span>`
  ).join('');
  host.querySelectorAll('[data-tagdel]').forEach(b=>{
    b.addEventListener('click', ()=>{ cur.tags.splice(+b.dataset.tagdel,1); renderTags(); syncDirty(); });
  });
}

function addTag(){
  const inp = $('bcTagInput'); if(!inp) return;
  // Twitch rejects tags containing spaces outright, so collapse rather than
  // letting the streamer discover it via a failed save.
  const raw = (inp.value||'').trim().replace(/\s+/g,'');
  if(!raw) return;
  if(cur.tags.length >= 10){ showInfoWarn('Twitch allows 10 tags at most.'); return; }
  if(raw.length > 25){ showInfoWarn('Tags can be 25 characters at most.'); return; }
  if(cur.tags.some(t => t.toLowerCase() === raw.toLowerCase())){ inp.value=''; return; }
  cur.tags.push(raw);
  inp.value = '';
  renderTags(); syncDirty();
}

// ── Category search ───────────────────────────────────────────────────────────

function renderCatResults(){
  const host = $('bcCatResults'); if(!host) return;
  if(!searchResults.length){ host.style.display='none'; host.innerHTML=''; return; }
  host.style.display='block';
  host.innerHTML = searchResults.map((g,i)=>`
    <div class="row" data-cat="${i}" style="align-items:center;gap:8px;padding:5px 6px;border-radius:8px;cursor:pointer">
      ${g.box_art ? `<img src="${esc(g.box_art)}" alt="" style="width:26px;height:36px;border-radius:4px;object-fit:cover;flex-shrink:0">` : ''}
      <span style="flex:1;font-size:.85rem">${esc(g.name||'')}</span>
    </div>`).join('');
  host.querySelectorAll('[data-cat]').forEach(row=>{
    row.addEventListener('click', ()=>{
      const g = searchResults[+row.dataset.cat]; if(!g) return;
      cur.gameId = String(g.id||''); cur.gameName = String(g.name||'');
      searchResults = [];
      const s = $('bcCatSearch'); if(s) s.value = '';
      renderCatResults(); renderCurrentCat(); syncDirty();
    });
  });
}

// Sits ABOVE the search box and is deliberately loud. It used to be a faded
// hint underneath, which read as placeholder text — easy to mistake for the
// search having failed to keep what you picked.
function renderCurrentCat(){
  const el = $('bcCatCurrent'); if(!el) return;
  if(cur.gameName){
    el.innerHTML =
        '<div style="font-size:.68rem;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);font-weight:700;margin-bottom:2px">Selected category</div>'
      + `<div style="font-size:1rem;font-weight:700;color:var(--ink);margin-bottom:8px">${esc(cur.gameName)}</div>`;
  } else {
    el.innerHTML =
        '<div style="font-size:.68rem;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);font-weight:700;margin-bottom:2px">Selected category</div>'
      + '<div style="font-size:.95rem;font-weight:600;color:var(--accent);margin-bottom:8px">None set</div>';
  }
}

function onCatType(){
  clearTimeout(searchTimer);
  const q = ($('bcCatSearch').value||'').trim();
  if(q.length < 2){ searchResults = []; renderCatResults(); return; }
  // Debounced: this fires per keystroke and Helix rate-limits per token.
  searchTimer = setTimeout(async ()=>{
    try{
      searchResults = await invoke('twitch_search_categories', { query: q }) || [];
    }catch(e){ searchResults = []; }
    renderCatResults();
  }, 300);
}

// ── Presets ───────────────────────────────────────────────────────────────────

function renderPresets(){
  const host = $('bcPresetList'); if(!host) return;
  const list = data.presets || [];
  if(!list.length){ host.innerHTML = '<div class="hint">No presets saved yet.</div>'; return; }
  host.innerHTML = list.map((p,i)=>`
    <div class="row" style="align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--row-line)">
      <div style="flex:1;min-width:0">
        <div style="font-weight:600">${esc(p.name||'Untitled')}</div>
        <div class="hint" style="margin:0">${esc(p.gameName||'no category')}${(p.tags&&p.tags.length)?' · '+p.tags.length+' tag'+(p.tags.length===1?'':'s'):''}</div>
      </div>
      <button class="btn-sm btn-green" data-pload="${i}">Load</button>
      <button class="btn-sm btn-ghost" data-pdel="${i}">✕</button>
    </div>`).join('');

  host.querySelectorAll('[data-pload]').forEach(b=>{
    b.addEventListener('click', ()=>{
      const p = (data.presets||[])[+b.dataset.pload]; if(!p) return;
      cur = {
        title:    p.title || '',
        gameId:   p.gameId || '',
        gameName: p.gameName || '',
        tags:     Array.isArray(p.tags) ? p.tags.slice() : [],
      };
      fillFields();
      flash(b, 'Loaded');
    });
  });
  host.querySelectorAll('[data-pdel]').forEach(b=>{
    b.addEventListener('click', ()=>{
      data.presets.splice(+b.dataset.pdel,1);
      persist(); renderPresets();
    });
  });
}

function savePreset(){
  const nameEl = $('bcPresetName');
  const name = (nameEl.value||'').trim();
  if(!name){ showInfoWarn('Give the preset a name first.'); return; }
  if(!Array.isArray(data.presets)) data.presets = [];
  // Same name replaces, so re-saving a tweaked setup does not pile up copies.
  const existing = data.presets.findIndex(p => (p.name||'').toLowerCase() === name.toLowerCase());
  const entry = { id: uid(), name, title: cur.title, gameId: cur.gameId, gameName: cur.gameName, tags: cur.tags.slice() };
  if(existing >= 0) data.presets[existing] = { ...entry, id: data.presets[existing].id };
  else data.presets.push(entry);
  nameEl.value = '';
  persist(); renderPresets();
}

// ── Fields ────────────────────────────────────────────────────────────────────

function fillFields(){
  const t = $('bcTitle'); if(t) t.value = cur.title || '';
  updateTitleCount();
  renderCurrentCat();
  renderTags();
  syncDirty();
}

function updateTitleCount(){
  const el = $('bcTitleCount'); if(!el) return;
  const n = (cur.title||'').length;
  el.textContent = `${n} / 140`;
}

function syncDirty(){
  const btn = $('bcApply'); if(!btn) return;
  const d = dirty();
  btn.textContent = d ? 'Apply to Twitch •' : 'Apply to Twitch';
  const rev = $('bcRevert'); if(rev) rev.style.display = d ? '' : 'none';
}

function showInfoWarn(msg){
  const e = $('bcInfoWarn'); if(!e) return;
  e.textContent = '⚠ ' + msg; e.style.display = 'block';
  const ok = $('bcInfoOk'); if(ok) ok.style.display = 'none';
}
function clearInfoWarn(){ const e=$('bcInfoWarn'); if(e) e.style.display='none'; }

// ── Talking to Twitch ─────────────────────────────────────────────────────────

async function loadChannel(){
  if(!store.twitch.connected){
    const s = $('bcStatus'); if(s) s.textContent = 'Not connected to Twitch. Connect in Settings first.';
    return;
  }
  try{
    const info = await invoke('twitch_get_channel_info');
    saved = {
      title:    info.title || '',
      gameId:   String(info.game_id || ''),
      gameName: info.game_name || '',
      tags:     Array.isArray(info.tags) ? info.tags.slice() : [],
    };
    // Never stomp on edits in progress — a background refresh should not eat
    // a title someone is halfway through typing.
    if(!dirty() || (!cur.title && !cur.gameId && !cur.tags.length)){
      cur = { ...saved, tags: saved.tags.slice() };
      fillFields();
    } else {
      syncDirty();
    }
  }catch(e){
    showInfoWarn(String(e));
  }
  refreshStatus();
}

async function applyInfo(){
  clearInfoWarn();
  if(!store.twitch.connected){ showInfoWarn('Connect Twitch in Settings first.'); return; }
  if(!(cur.title||'').trim()){ showInfoWarn('A stream title cannot be empty.'); return; }

  const btn = $('bcApply');
  if(btn) btn.disabled = true;
  try{
    // Only send what actually changed. Sending a game_id you did not touch is
    // harmless, but sending a title you did not touch would overwrite an edit
    // made from your phone a moment ago.
    //
    // Every key is ALWAYS sent, using null for "unchanged". Rust reads them as
    // Option and null means None — the same result as leaving the key out, but
    // it does not depend on how a MISSING argument gets deserialised, which is
    // not worth guessing at when this cannot be compiled and tried.
    await invoke('twitch_update_channel_info', {
      title:  cur.title  !== saved.title  ? cur.title  : null,
      gameId: cur.gameId !== saved.gameId ? cur.gameId : null,
      tags:   sameTags(cur.tags, saved.tags) ? null : cur.tags.slice(),
    });
    saved = { ...cur, tags: cur.tags.slice() };
    syncDirty();
    const ok = $('bcInfoOk');
    if(ok){ ok.style.display='inline'; setTimeout(()=>{ ok.style.display='none'; }, 2000); }
  }catch(e){
    showInfoWarn(String(e));
  }finally{
    if(btn) btn.disabled = false;
  }
}

async function addMarker(){
  const warn = $('bcMarkerWarn'), ok = $('bcMarkerOk');
  if(warn) warn.style.display='none';
  if(ok) ok.style.display='none';
  try{
    const r = await invoke('twitch_create_stream_marker', { description: ($('bcMarkerDesc').value||'') });
    const pos = Number(r && r.position);
    const at = isFinite(pos) && pos > 0
      ? ` at ${Math.floor(pos/3600)}h ${Math.floor((pos%3600)/60)}m ${Math.floor(pos%60)}s`
      : '';
    if(ok){ ok.textContent = `Marker added${at}.`; ok.style.display='block'; }
    $('bcMarkerDesc').value = '';
  }catch(e){
    if(warn){ warn.textContent = '⚠ ' + String(e); warn.style.display='block'; }
  }
}

// ── Status card ───────────────────────────────────────────────────────────────

let statusTick = null;

function fmtUptime(startedAt){
  if(!startedAt) return '';
  const ms = Date.now() - new Date(startedAt).getTime();
  if(!isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms/1000);
  return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;
}

async function refreshStatus(){
  const el = $('bcStatus'); if(!el) return;
  if(!store.twitch.connected){ el.textContent = 'Not connected to Twitch.'; return; }
  let si = null;
  try{ si = await invoke('twitch_get_stream_info'); }catch(e){}
  if(!si){ el.textContent = 'Could not read your stream status.'; return; }

  const bits = [];
  if(si.live){
    bits.push(`<span style="color:var(--ok-ink)">● Live</span>`);
    const up = fmtUptime(si.started_at);
    if(up) bits.push(`up ${up}`);
    bits.push(`${si.viewers||0} viewer${si.viewers===1?'':'s'}`);
  } else {
    bits.push('○ Offline');
  }

  // Ad timing is READ ONLY here, deliberately. Every ad trigger stays in the
  // Commands tab; this is just so the next break is visible while you are
  // editing your title.
  try{
    const ad = await invoke('twitch_get_ad_schedule');
    const next = ad && ad.next_ad_at;
    if(next){
      const secs = Math.floor((new Date(next).getTime() - Date.now())/1000);
      if(isFinite(secs) && secs > 0){
        const m = Math.floor(secs/60), s = secs%60;
        bits.push(`next ad in ${m}m ${String(s).padStart(2,'0')}s`);
      }
    }
  }catch(e){ /* no ads scope, or not an affiliate — simply omit it */ }

  el.innerHTML = bits.join(' &nbsp;·&nbsp; ');
}

// ── Chat pane ─────────────────────────────────────────────────────────────────
// A moderator view, not an overlay. The Chat TAB styles what viewers see in OBS;
// this is what you look at while streaming.
//
// Messages are kept in an array and the log is redrawn from it. Chat is capped
// well below the point where that costs anything, and redrawing from state
// keeps "this message was deleted" honest without hunting for a DOM node.

const CHAT_MAX = 200;
let msgs = [];            // {id, msgId, userId, login, display, text, color, mod, sub, vip, broadcaster, removed}
let pinnedMsgId = '';
let stickBottom = true;   // false once the user scrolls up to read something

function buildChatPane(){
  const host = $('bcChatPane'); if(!host) return;
  host.innerHTML = `
    <div class="bc-chat-head">
      <span style="flex:1">Chat</span>
      <span id="bcChatCount" style="font-weight:600;letter-spacing:0;text-transform:none">0</span>
      <button class="btn-sm btn-ghost" id="bcChatClearView" title="Clear this view only — nothing is deleted on Twitch">Clear view</button>
    </div>
    <div class="bc-chat-log" id="bcChatLog"></div>
    <div class="warn" id="bcChatWarn" style="display:none;margin:0 10px"></div>
    <div class="bc-chat-foot">
      <select id="bcSayAs" style="width:auto;flex:0 0 auto" title="Who this message comes from"></select>
      <input type="text" id="bcSay" placeholder="Send a message to chat…" style="flex:1" maxlength="480">
      <button class="btn-sm btn-gold" id="bcSayBtn">Send</button>
    </div>`;

  const log = $('bcChatLog');
  if(log){
    log.addEventListener('scroll', ()=>{
      // Only auto-scroll when already parked at the bottom, so reading back
      // through chat is not yanked away by every new message.
      stickBottom = (log.scrollHeight - log.scrollTop - log.clientHeight) < 40;
    });
    // One delegated listener for the whole log. Wiring a listener per button
    // per message would mean hundreds of them, all needing tearing down again
    // as messages scroll off.
    log.addEventListener('click', e=>{
      const btn = e.target.closest('[data-act]');
      if(!btn || !log.contains(btn)) return;
      onChatAction(btn.dataset.act, btn.dataset.i);
    });
  }

  const say = $('bcSay');
  if(say) say.addEventListener('keydown', e=>{ if(e.key === 'Enter'){ e.preventDefault(); sendSay(); } });
  const sb = $('bcSayBtn'); if(sb) sb.addEventListener('click', sendSay);
  const cv = $('bcChatClearView');
  if(cv) cv.addEventListener('click', ()=>{ msgs = []; renderChat(); });

  const as = $('bcSayAs');
  if(as) as.addEventListener('change', ()=>{ data.sendAs = as.value; persist(); });
  refreshSendAs().catch(()=>{});

  renderChat();
}

// ── Who the message comes from ────────────────────────────────────────────────
// Without this, a connected bot account swallows everything: SPARK has always
// preferred the bot for every outgoing message, so there was no way to say
// something in chat under your own name.
//
// The picker only appears when a bot is actually connected — with no bot there
// is nothing to choose between.

async function refreshSendAs(){
  const sel = $('bcSayAs'); if(!sel) return;
  let bot = null;
  try{ bot = await invoke('twitch_bot_status'); }catch(e){}

  if(!bot || !bot.connected){
    sel.style.display = 'none';
    return;
  }

  const me  = store.twitch.login || 'you';
  const who = bot.login || 'bot';
  // Default to the bot, matching what SPARK did before this existed.
  const cur = data.sendAs === 'broadcaster' ? 'broadcaster' : 'bot';
  data.sendAs = cur;

  sel.style.display = '';
  sel.innerHTML =
      `<option value="bot"${cur==='bot'?' selected':''}>${esc(who)}</option>`
    + `<option value="broadcaster"${cur==='broadcaster'?' selected':''}>${esc(me)}</option>`;
}

function chatWarn(msg){
  const e = $('bcChatWarn'); if(!e) return;
  e.textContent = '⚠ ' + msg;
  e.style.display = 'block';
  clearTimeout(chatWarn._t);
  chatWarn._t = setTimeout(()=>{ e.style.display='none'; }, 6000);
}

function badgesFor(m){
  let out = '';
  if(m.broadcaster) out += '<span class="bc-badge">host</span>';
  else if(m.mod)    out += '<span class="bc-badge">mod</span>';
  if(m.vip)         out += '<span class="bc-badge">vip</span>';
  if(m.sub)         out += '<span class="bc-badge">sub</span>';
  return out;
}

// One message's markup. Kept separate from the render so a new message can be
// appended on its own — see appendMsg.
function msgHtml(m){
  // Twitch refuses to delete a broadcaster's or a mod's message, and refuses to
  // time out a mod. Hiding the buttons is kinder than an error after the click.
  const protectedUser = m.broadcaster || m.mod;
  const acts = m.removed ? '' : `
    <div class="bc-msg-acts">
      ${protectedUser ? '' : `<button data-act="del" data-i="${m.id}">Delete</button>`}
      ${protectedUser ? '' : `<button data-act="to" data-i="${m.id}">10m</button>`}
      ${protectedUser ? '' : `<button data-act="ban" data-i="${m.id}" class="danger">Ban</button>`}
      <button data-act="pin" data-i="${m.id}">${pinnedMsgId === m.msgId ? 'Pinned' : 'Pin'}</button>
    </div>`;
  const colour = m.color && /^#[0-9a-f]{6}$/i.test(m.color) ? m.color : 'var(--gold-ink)';
  return badgesFor(m)
    + `<span class="bc-msg-name" style="color:${colour}" data-act="user" data-i="${m.id}">${esc(m.display||m.login)}</span>`
    + `<span style="color:var(--muted)">: </span>`
    + `<span>${esc(m.text)}</span>`
    + acts;
}

function updateCount(){
  const c = $('bcChatCount'); if(c) c.textContent = msgs.length;
}

function scrollIfStuck(log){
  if(stickBottom) log.scrollTop = log.scrollHeight;
}

// Full rebuild. Only used when the whole list changes — first paint, clearing
// the view, or a moderation action that struck several messages at once. NOT
// used per incoming message; see appendMsg for why.
function renderChat(){
  const log = $('bcChatLog'); if(!log) return;
  updateCount();
  if(!msgs.length){
    log.innerHTML = '<div class="hint" style="padding:10px">Waiting for chat…</div>';
    return;
  }
  log.innerHTML = msgs.map(m =>
    `<div class="bc-msg${m.removed?' bc-removed':''}" data-mid="${m.id}">${msgHtml(m)}</div>`
  ).join('');
  scrollIfStuck(log);
}

// Appends ONE node rather than redrawing the log. Rebuilding 200 messages on
// every arrival is fine at conversational pace and awful during a raid, which
// is exactly when a moderator view has to stay responsive.
//
// Clicks are handled by one delegated listener on the log (see buildChatPane),
// so appended nodes need no wiring of their own.
function appendMsg(m){
  const log = $('bcChatLog'); if(!log) return;
  // First real message replaces the "Waiting for chat…" hint.
  const hint = log.querySelector('.hint');
  if(hint) hint.remove();

  const div = document.createElement('div');
  div.className = 'bc-msg';
  div.dataset.mid = m.id;
  div.innerHTML = msgHtml(m);
  log.appendChild(div);

  // Trim the DOM in step with the array so the two never disagree.
  while(log.childElementCount > CHAT_MAX) log.removeChild(log.firstElementChild);

  updateCount();
  scrollIfStuck(log);
}

// Restrike a single message in place instead of redrawing everything.
function markNodeRemoved(id){
  const log = $('bcChatLog'); if(!log) return;
  const node = log.querySelector(`[data-mid="${id}"]`);
  if(!node) return;
  node.classList.add('bc-removed');
  const acts = node.querySelector('.bc-msg-acts');
  if(acts) acts.remove();
}

async function onChatAction(act, id){
  const m = msgs.find(x => String(x.id) === String(id));
  if(!m) return;

  if(act === 'user'){ openUserMenu(m); return; }

  try{
    if(act === 'del'){
      if(!m.msgId){ chatWarn('That message arrived without an id, so it cannot be deleted individually.'); return; }
      await invoke('twitch_delete_message', { messageId: m.msgId });
      // Mark rather than remove: seeing what you just deleted, struck through,
      // is the confirmation.
      m.removed = true;
      markNodeRemoved(m.id);
    } else if(act === 'to'){
      await invoke('twitch_ban_user', { userId: m.userId, duration: 600, reason: null });
      markUserRemoved(m.userId);
    } else if(act === 'ban'){
      if(!confirm(`Permanently ban ${m.display || m.login}?\n\nThis cannot be undone from here without unbanning them on Twitch.`)) return;
      await invoke('twitch_ban_user', { userId: m.userId, duration: null, reason: null });
      markUserRemoved(m.userId);
    } else if(act === 'pin'){
      if(!m.msgId){ chatWarn('That message arrived without an id, so it cannot be pinned.'); return; }
      await invoke('twitch_pin_message', { messageId: m.msgId });
      pinnedMsgId = m.msgId;
      // Only the button label changes, and only on two messages at most.
      const log = $('bcChatLog');
      if(log) log.querySelectorAll('[data-act="pin"]').forEach(b=>{
        const other = msgs.find(x => String(x.id) === String(b.dataset.i));
        b.textContent = (other && other.msgId === pinnedMsgId) ? 'Pinned' : 'Pin';
      });
    }
  }catch(e){
    chatWarn(String(e));
  }
}

// A timeout or ban clears that user's recent messages on Twitch's side too, so
// reflect it here rather than leaving them looking untouched. Several messages
// change at once, so this one restrikes each affected node directly rather than
// redrawing the whole log.
function markUserRemoved(userId){
  msgs.forEach(m=>{
    if(m.userId === userId && !m.removed){ m.removed = true; markNodeRemoved(m.id); }
  });
}

async function sendSay(){
  const inp = $('bcSay'); if(!inp) return;
  const text = (inp.value||'').trim();
  if(!text) return;
  inp.value = '';
  try{
    // Same queued sender every other tab uses, so this cannot trip the rate
    // limit independently of the rest of SPARK.
    //
    // Two commands, not one with an optional argument: twitch_send_chat_message
    // is called from seven other files and is left exactly as it was.
    const sel = $('bcSayAs');
    const picking = sel && sel.style.display !== 'none';
    if(picking) await invoke('twitch_send_chat_as', { message: text, asAccount: sel.value });
    else        await invoke('twitch_send_chat_message', { message: text });
  }catch(e){ chatWarn(String(e)); }
}

let nextMsgId = 1;

function onChatMessage(d){
  msgs.push({
    id:          nextMsgId++,
    msgId:       d.msg_id || '',
    userId:      d.user_id || '',
    login:       d.username || '',
    display:     d.display || d.username || '',
    text:        d.message || '',
    color:       d.color || '',
    mod:         !!d.is_mod,
    sub:         !!d.is_sub,
    vip:         !!d.is_vip,
    broadcaster: !!d.is_broadcaster,
    removed:     false,
  });
  if(msgs.length > CHAT_MAX) msgs = msgs.slice(-CHAT_MAX);
  appendMsg(msgs[msgs.length - 1]);
}

// ── Actions pane ──────────────────────────────────────────────────────────────

let activePoll = null;
let activePred = null;
let pollTick   = null;

// Sections collapse so you can shut the ones you are not using and keep the
// pane short. Which are open is remembered in broadcast.openSecs.
function sec(id, title, bodyHtml){
  const open = !(data.openSecs && data.openSecs[id] === false);
  return `<div class="bc-sec${open ? '' : ' closed'}" data-sec="${id}">
      <div class="bc-sec-head" data-sechead="${id}">
        <span>${title}</span>
        <span class="bc-sec-tag" id="bcTag_${id}" style="display:none"></span>
        <span class="bc-arrow">\u25be</span>
      </div>
      <div class="bc-sec-body">${bodyHtml}</div>
    </div>`;
}

// A short status on a collapsed header, so a shut section can still say that a
// poll is running or that emote-only is on.
function secTag(id, text){
  const el = $('bcTag_' + id); if(!el) return;
  if(text){ el.textContent = text; el.style.display = ''; }
  else     { el.style.display = 'none'; }
}

// How long someone must ALREADY have been following before they may chat.
// Not "the mode turns on later" — it is a minimum follow age, which is what
// makes it useful against follow-and-spam bots. Same steps Twitch offers.
// Twitch accepts 0..129600 minutes (90 days).
const FOLLOW_AGES = [
  [0,     'Any follower'],
  [10,    '10 minutes'],
  [30,    '30 minutes'],
  [60,    '1 hour'],
  [1440,  '1 day'],
  [10080, '1 week'],
  [43200, '1 month'],
  [129600,'3 months'],
];

// Seconds a viewer must wait between messages. Twitch accepts 3..120.
const SLOW_WAITS = [
  [3,  '3 seconds'],  [5,  '5 seconds'],   [10, '10 seconds'],
  [20, '20 seconds'], [30, '30 seconds'],  [60, '1 minute'],
  [120,'2 minutes'],
];

// Ad lengths Twitch accepts, in the steps Kyle asked for.
const AD_LENGTHS = [
  [30,  '30s'],  [60,  '1m'],   [90,  '1m 30s'],
  [120, '2m'],   [150, '2m 30s'],[180, '3m'],
];

function buildActionsPane(){
  const host = $('bcActionsPane'); if(!host) return;
  host.innerHTML = `
    <div class="warn" id="bcActWarn" style="display:none"></div>
    <div class="ok"   id="bcActOk"   style="display:none"></div>

    ${sec('chatmode', 'Chat Mode', `
      <div class="bc-btn-grid">
        <button class="btn-sm btn-ghost" id="bcModeEmote">Emote only</button>
        <button class="btn-sm btn-ghost" id="bcModeSub">Subs only</button>
        <button class="btn-sm btn-ghost" id="bcModeFollow">Followers only</button>
        <button class="btn-sm btn-ghost" id="bcModeSlow">Slow mode</button>
      </div>
      <div style="margin-top:8px">
        <label style="margin-bottom:4px">Followers-only: must have followed for at least</label>
        <select id="bcFollowMins">${FOLLOW_AGES.map(([m,l]) =>
          `<option value="${m}">${l}</option>`).join('')}</select>
        <div class="hint">Makes a brand-new follower wait before they can chat. Follow-and-spam bots follow and post straight away, so even ten minutes stops most of them. Only applies while followers-only is on.</div>
      </div>
      <div style="margin-top:8px">
        <label style="margin-bottom:4px">Slow mode: wait between messages</label>
        <select id="bcSlowWait">${SLOW_WAITS.map(([s,l]) =>
          `<option value="${s}"${s===30?' selected':''}>${l}</option>`).join('')}</select>
      </div>
      <button class="btn-sm btn-danger mt full" id="bcClearChat">Clear chat history</button>
      <div class="hint">Clearing wipes chat for everyone watching. It cannot be undone.</div>
    `)}

    ${sec('ads', 'Ads', `
      <div class="bc-btn-grid">
        ${AD_LENGTHS.map(([secs,label]) =>
          `<button class="btn-sm btn-ghost" data-ad="${secs}">${label}</button>`).join('')}
      </div>
      <button class="btn-sm mt full" id="bcSnooze">Snooze next ad (+5 min)</button>
      <div class="hint" id="bcAdHint">Ads only run while you are live, and Twitch enforces a cooldown between breaks.</div>
    `)}

    ${sec('raid', 'Raid &amp; Shoutout', `
      <div class="row" style="gap:6px">
        <input type="text" id="bcTargetName" placeholder="Channel name" style="flex:1">
        <button class="btn-sm" id="bcShoutout">Shoutout</button>
        <button class="btn-sm btn-gold" id="bcRaid">Raid</button>
      </div>
      <div class="hint">Raiding opens Twitch's 90-second countdown rather than moving everyone straight away. <span id="bcCancelWrap" style="display:none"><a href="#" id="bcCancelRaid">Cancel the pending raid</a></span></div>
    `)}

    ${sec('poll', 'Poll', `
      <div id="bcPollActive"></div>
      <div id="bcPollForm">
        <input type="text" id="bcPollTitle" maxlength="60" placeholder="Question, e.g. Which map next?">
        <div id="bcPollChoices" style="margin-top:6px"></div>
        <div class="row" style="gap:6px;margin-top:6px">
          <button class="btn-sm btn-ghost" id="bcPollAddChoice">+ Answer</button>
          <input type="number" id="bcPollDur" value="120" min="15" max="1800" style="width:88px" title="Seconds">
          <span class="hint" style="margin:0;align-self:center">seconds</span>
          <button class="btn-sm btn-gold" id="bcPollStart" style="margin-left:auto">Start poll</button>
        </div>
        <div id="bcPollTemplates" style="margin-top:10px"></div>
        <div class="row" style="gap:6px;margin-top:6px">
          <input type="text" id="bcPollTplName" placeholder="Save this as a template…" style="flex:1">
          <button class="btn-sm" id="bcPollTplSave">Save</button>
        </div>
      </div>
    `)}

    ${sec('pred', 'Prediction', `
      <div id="bcPredActive"></div>
      <div id="bcPredForm">
        <input type="text" id="bcPredTitle" maxlength="45" placeholder="Question, e.g. Will we win?">
        <div id="bcPredOutcomes" style="margin-top:6px"></div>
        <div class="row" style="gap:6px;margin-top:6px">
          <button class="btn-sm btn-ghost" id="bcPredAddOutcome">+ Outcome</button>
          <input type="number" id="bcPredWin" value="120" min="30" max="1800" style="width:88px" title="Seconds open for">
          <span class="hint" style="margin:0;align-self:center">seconds</span>
          <button class="btn-sm btn-gold" id="bcPredStart" style="margin-left:auto">Start prediction</button>
        </div>
        <div id="bcPredTemplates" style="margin-top:10px"></div>
        <div class="row" style="gap:6px;margin-top:6px">
          <input type="text" id="bcPredTplName" placeholder="Save this as a template…" style="flex:1">
          <button class="btn-sm" id="bcPredTplSave">Save</button>
        </div>
      </div>
    `)}`;

  wireSections();
  renderChoiceInputs('bcPollChoices', pollChoices, 5);
  renderChoiceInputs('bcPredOutcomes', predOutcomes, 10);
  renderTemplates('poll');
  renderTemplates('pred');
  wireActions();
  refreshActive().catch(()=>{});
  refreshChatModes().catch(()=>{});
}

function wireSections(){
  const host = $('bcActionsPane'); if(!host) return;
  host.querySelectorAll('[data-sechead]').forEach(h=>{
    h.addEventListener('click', ()=>{
      const id = h.dataset.sechead;
      const box = host.querySelector(`[data-sec="${id}"]`); if(!box) return;
      box.classList.toggle('closed');
      if(!data.openSecs) data.openSecs = {};
      data.openSecs[id] = !box.classList.contains('closed');
      persist();
    });
  });
}

// ── Chat modes ────────────────────────────────────────────────────────────────

let chatModes = { emote_mode:false, subscriber_mode:false, follower_mode:false,
                  follower_mode_duration:0, slow_mode:false, slow_mode_wait_time:30 };

function paintChatModes(){
  const set = (id, on) => {
    const b = $(id); if(!b) return;
    // Reuse the existing button styles rather than inventing a toggle: gold
    // reads as "this is on" everywhere else in SPARK.
    b.className = 'btn-sm ' + (on ? 'btn-gold' : 'btn-ghost');
  };
  set('bcModeEmote',  chatModes.emote_mode);
  set('bcModeSub',    chatModes.subscriber_mode);
  set('bcModeFollow', chatModes.follower_mode);
  set('bcModeSlow',   chatModes.slow_mode);

  const mins = $('bcFollowMins');
  if(mins && document.activeElement !== mins){
    const cur = String(chatModes.follower_mode_duration || 0);
    // A duration set from Twitch's own UI can be a value not in our list.
    // Add it rather than silently snapping the display to "Any follower".
    if(!Array.from(mins.options).some(o => o.value === cur)){
      const o = document.createElement('option');
      o.value = cur;
      o.textContent = `${cur} minutes`;
      mins.appendChild(o);
    }
    mins.value = cur;
  }

  const wait = $('bcSlowWait');
  if(wait && document.activeElement !== wait){
    const cur = String(chatModes.slow_mode_wait_time || 30);
    // A wait set from Twitch's own UI can be a value not in our list.
    if(!Array.from(wait.options).some(o => o.value === cur)){
      const o = document.createElement('option');
      o.value = cur; o.textContent = cur + ' seconds';
      wait.appendChild(o);
    }
    wait.value = cur;
  }

  const on = [];
  if(chatModes.emote_mode)      on.push('emote');
  if(chatModes.subscriber_mode) on.push('subs');
  if(chatModes.follower_mode)   on.push('followers');
  if(chatModes.slow_mode)       on.push('slow');
  secTag('chatmode', on.length ? on.join(' + ') : '');
}

async function refreshChatModes(){
  if(!store.twitch.connected) return;
  try{
    const s = await invoke('twitch_get_chat_settings');
    chatModes = s || chatModes;
    paintChatModes();
  }catch(e){ /* no scope yet, or offline — leave the buttons as they are */ }
}

const MODE_LABEL = {
  emote:      'Emote-only',
  subscriber: 'Subs-only',
  follower:   'Followers-only',
  slow:       'Slow mode',
};

async function toggleChatMode(mode, key){
  const want = !chatModes[key];
  try{
    // The one argument means different units per mode — MINUTES of follow age
    // for follower mode, SECONDS between messages for slow mode. Rust reads it
    // per mode; the mistake to avoid is sending one picker's value for both.
    let amount = null;
    if(mode === 'follower') amount = Number($('bcFollowMins').value) || 0;
    if(mode === 'slow')     amount = Number($('bcSlowWait').value)  || 30;

    await invoke('twitch_set_chat_mode', { mode, enabled: want, minutes: amount });
    chatModes[key] = want;
    if(want && mode === 'follower') chatModes.follower_mode_duration = amount || 0;
    if(want && mode === 'slow')     chatModes.slow_mode_wait_time   = amount || 30;
    paintChatModes();
    actOk(want ? `${MODE_LABEL[mode] || 'That mode'} is on.` : 'Turned off.');
  }catch(e){ actWarn(String(e)); }
}

async function clearChat(){
  if(!confirm('Clear the entire chat for everyone watching?\n\nThis cannot be undone.')) return;
  try{
    // Empty message id = clear everything. Same endpoint as deleting one.
    await invoke('twitch_delete_message', { messageId: '' });
    msgs = [];
    renderChat();
    actOk('Chat cleared.');
  }catch(e){ actWarn(String(e)); }
}

// ── Ads ───────────────────────────────────────────────────────────────────────

async function runAd(seconds){
  try{
    const r = await invoke('twitch_start_commercial', { length: seconds });
    const wait = Number(r && r.retry_after);
    actOk(`Ad break started${isFinite(wait) && wait > 0 ? ` — next one allowed in ${Math.ceil(wait/60)} min` : ''}.`);
    refreshStatus().catch(()=>{});
  }catch(e){ actWarn(String(e)); }
}

async function snoozeAd(){
  try{
    const r = await invoke('twitch_snooze_ad');
    const left = r && r.snooze_count;
    actOk(`Next ad pushed back 5 minutes${left != null ? ` — ${left} snooze${left === 1 ? '' : 's'} left` : ''}.`);
    refreshStatus().catch(()=>{});
  }catch(e){ actWarn(String(e)); }
}

function actWarn(msg){
  const e = $('bcActWarn'); if(!e) return;
  e.textContent = '⚠ ' + msg; e.style.display = 'block';
  const ok = $('bcActOk'); if(ok) ok.style.display = 'none';
  clearTimeout(actWarn._t);
  actWarn._t = setTimeout(()=>{ e.style.display='none'; }, 8000);
}
function actOk(msg){
  const e = $('bcActOk'); if(!e) return;
  e.textContent = msg; e.style.display = 'block';
  const w = $('bcActWarn'); if(w) w.style.display = 'none';
  clearTimeout(actOk._t);
  actOk._t = setTimeout(()=>{ e.style.display='none'; }, 5000);
}

// ── Poll / prediction option inputs ───────────────────────────────────────────

let pollChoices  = ['', ''];
let predOutcomes = ['', ''];

function renderChoiceInputs(hostId, arr, max){
  const host = $(hostId); if(!host) return;
  host.innerHTML = arr.map((v,i)=>`
    <div class="row" style="gap:6px;margin-bottom:4px">
      <input type="text" maxlength="25" placeholder="Answer ${i+1}" value="${esc(v)}" data-opt="${i}" style="flex:1">
      ${arr.length > 2 ? `<button class="btn-sm btn-ghost" data-optdel="${i}">✕</button>` : ''}
    </div>`).join('');
  host.querySelectorAll('[data-opt]').forEach(inp=>{
    inp.addEventListener('input', ()=>{ arr[+inp.dataset.opt] = inp.value; });
  });
  host.querySelectorAll('[data-optdel]').forEach(b=>{
    b.addEventListener('click', ()=>{
      arr.splice(+b.dataset.optdel, 1);
      renderChoiceInputs(hostId, arr, max);
    });
  });
}

// ── Templates ─────────────────────────────────────────────────────────────────
// The reason this tab beats Twitch's own page: Twitch makes you retype every
// poll from scratch. Same preset idea as the Wheel's saved lists.

function tplKey(kind){ return kind === 'poll' ? 'pollTemplates' : 'predTemplates'; }

function renderTemplates(kind){
  const host = $(kind === 'poll' ? 'bcPollTemplates' : 'bcPredTemplates'); if(!host) return;
  const list = data[tplKey(kind)] || [];
  if(!list.length){ host.innerHTML = '<div class="hint" style="margin:0">No saved templates.</div>'; return; }
  host.innerHTML = list.map((t,i)=>`
    <div class="row" style="align-items:center;gap:6px;padding:3px 0">
      <span style="flex:1;font-size:.8rem;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.name||t.title||'Untitled')}</span>
      <button class="btn-sm btn-green" data-tpl="${kind}:${i}">Load</button>
      <button class="btn-sm btn-ghost" data-tpldel="${kind}:${i}">✕</button>
    </div>`).join('');

  host.querySelectorAll('[data-tpl]').forEach(b=>{
    b.addEventListener('click', ()=>{
      const [k,i] = b.dataset.tpl.split(':');
      const t = (data[tplKey(k)]||[])[+i]; if(!t) return;
      if(k === 'poll'){
        $('bcPollTitle').value = t.title || '';
        $('bcPollDur').value   = t.duration || 120;
        pollChoices = (t.options||['','']).slice(0,5);
        while(pollChoices.length < 2) pollChoices.push('');
        renderChoiceInputs('bcPollChoices', pollChoices, 5);
      } else {
        $('bcPredTitle').value = t.title || '';
        $('bcPredWin').value   = t.duration || 120;
        predOutcomes = (t.options||['','']).slice(0,10);
        while(predOutcomes.length < 2) predOutcomes.push('');
        renderChoiceInputs('bcPredOutcomes', predOutcomes, 10);
      }
      flash(b, 'Loaded');
    });
  });
  host.querySelectorAll('[data-tpldel]').forEach(b=>{
    b.addEventListener('click', ()=>{
      const [k,i] = b.dataset.tpldel.split(':');
      data[tplKey(k)].splice(+i,1);
      persist(); renderTemplates(k);
    });
  });
}

function saveTemplate(kind){
  const nameEl = $(kind === 'poll' ? 'bcPollTplName' : 'bcPredTplName');
  const name = (nameEl.value||'').trim();
  if(!name){ actWarn('Name the template first.'); return; }
  const key = tplKey(kind);
  if(!Array.isArray(data[key])) data[key] = [];
  const entry = kind === 'poll'
    ? { id: uid(), name, title: $('bcPollTitle').value||'', duration: Number($('bcPollDur').value)||120, options: pollChoices.slice() }
    : { id: uid(), name, title: $('bcPredTitle').value||'', duration: Number($('bcPredWin').value)||120, options: predOutcomes.slice() };
  const at = data[key].findIndex(t => (t.name||'').toLowerCase() === name.toLowerCase());
  if(at >= 0) data[key][at] = { ...entry, id: data[key][at].id };
  else data[key].push(entry);
  nameEl.value = '';
  persist(); renderTemplates(kind);
}

// ── Live poll / prediction state ──────────────────────────────────────────────

function renderActivePoll(){
  const host = $('bcPollActive'), form = $('bcPollForm'); if(!host || !form) return;
  if(!activePoll){ host.innerHTML = ''; form.style.display = ''; return; }
  form.style.display = 'none';
  const total = (activePoll.choices||[]).reduce((n,c)=>n+(c.votes||0),0) || 0;
  const left = activePoll.ends_at ? Math.max(0, Math.round((new Date(activePoll.ends_at).getTime()-Date.now())/1000)) : 0;
  host.innerHTML = `
    <div style="font-weight:600;margin-bottom:6px">${esc(activePoll.title||'')}</div>
    ${(activePoll.choices||[]).map(c=>{
      const pct = total ? Math.round((c.votes||0)/total*100) : 0;
      return `<div style="margin-bottom:5px">
        <div style="display:flex;font-size:.78rem"><span style="flex:1">${esc(c.title||'')}</span><span class="hint" style="margin:0">${c.votes||0} · ${pct}%</span></div>
        <div style="height:5px;border-radius:3px;background:var(--sunken);overflow:hidden;margin-top:2px"><div style="height:100%;width:${pct}%;background:var(--gold)"></div></div>
      </div>`;
    }).join('')}
    <div class="row mt" style="gap:6px;align-items:center">
      <span class="hint" style="margin:0;flex:1">${left ? left+'s left' : 'ending…'}</span>
      <button class="btn-sm" id="bcPollEnd">End now</button>
      <button class="btn-sm btn-ghost" id="bcPollCancel">Cancel</button>
    </div>`;
  const e = $('bcPollEnd');    if(e) e.addEventListener('click', ()=>endPoll('TERMINATED'));
  const c = $('bcPollCancel'); if(c) c.addEventListener('click', ()=>endPoll('ARCHIVED'));
}

function renderActivePred(){
  const host = $('bcPredActive'), form = $('bcPredForm'); if(!host || !form) return;
  if(!activePred){ host.innerHTML = ''; form.style.display = ''; return; }
  form.style.display = 'none';
  const locked = activePred.status === 'LOCKED';
  host.innerHTML = `
    <div style="font-weight:600;margin-bottom:2px">${esc(activePred.title||'')}</div>
    <div class="hint" style="margin-bottom:6px">${locked ? 'Locked — pick the winner to pay out.' : 'Open for predictions.'}</div>
    ${(activePred.outcomes||[]).map(o=>`
      <div class="row" style="gap:6px;align-items:center;margin-bottom:4px">
        <span style="flex:1;font-size:.8rem">${esc(o.title||'')}</span>
        <span class="hint" style="margin:0">${o.users||0} · ${(o.points||0).toLocaleString()}</span>
        <button class="btn-sm btn-green" data-win="${esc(o.id||'')}">Winner</button>
      </div>`).join('')}
    <div class="row mt" style="gap:6px">
      ${locked ? '' : '<button class="btn-sm" id="bcPredLock">Lock</button>'}
      <button class="btn-sm btn-ghost" id="bcPredCancel">Refund everyone</button>
    </div>`;
  host.querySelectorAll('[data-win]').forEach(b=>{
    b.addEventListener('click', ()=>endPred('RESOLVED', b.dataset.win));
  });
  const l = $('bcPredLock');   if(l) l.addEventListener('click', ()=>endPred('LOCKED'));
  const c = $('bcPredCancel'); if(c) c.addEventListener('click', ()=>{
    if(confirm('Cancel this prediction and refund everyone their channel points?')) endPred('CANCELED');
  });
}

async function refreshActive(){
  if(!store.twitch.connected) return;
  try{ activePoll = await invoke('twitch_get_active_poll'); }catch(e){ activePoll = null; }
  try{ activePred = await invoke('twitch_get_active_prediction'); }catch(e){ activePred = null; }
  renderActivePoll();
  renderActivePred();
  // So a shut section still tells you something is running.
  secTag('poll', activePoll ? 'running' : '');
  secTag('pred', activePred ? (activePred.status === 'LOCKED' ? 'locked' : 'running') : '');
}

async function endPoll(status){
  if(!activePoll) return;
  try{
    await invoke('twitch_end_poll', { pollId: activePoll.id, status });
    activePoll = null; renderActivePoll();
    actOk(status === 'ARCHIVED' ? 'Poll cancelled.' : 'Poll ended.');
  }catch(e){ actWarn(String(e)); }
}

async function endPred(status, winner){
  if(!activePred) return;
  try{
    await invoke('twitch_end_prediction', {
      predictionId: activePred.id, status, winningOutcomeId: winner || null,
    });
    // Locking keeps it on screen — it still needs resolving afterwards.
    if(status === 'LOCKED') await refreshActive();
    else { activePred = null; renderActivePred(); }
    actOk(status === 'LOCKED' ? 'Predictions locked.'
        : status === 'CANCELED' ? 'Prediction cancelled, points refunded.'
        : 'Prediction paid out.');
  }catch(e){ actWarn(String(e)); }
}

// ── Wiring ────────────────────────────────────────────────────────────────────

// Raid and shoutout both take a user id, but you think in channel names.
async function lookupUser(login){
  const name = (login||'').trim().replace(/^@/,'');
  if(!name) throw new Error('Type a channel name first.');
  const u = await invoke('twitch_get_user_by_login', { login: name });
  const id = u && (u.id || u.user_id);
  if(!id) throw new Error(`No Twitch channel called "${name}".`);
  return { id: String(id), name: u.display_name || u.login || name };
}

function wireActions(){
  const em = $('bcModeEmote');  if(em) em.addEventListener('click', ()=>toggleChatMode('emote','emote_mode'));
  const sm = $('bcModeSub');    if(sm) sm.addEventListener('click', ()=>toggleChatMode('subscriber','subscriber_mode'));
  const fm = $('bcModeFollow'); if(fm) fm.addEventListener('click', ()=>toggleChatMode('follower','follower_mode'));

  // Changing the minimum follow age while followers-only is ALREADY on has to
  // re-send it — otherwise the dropdown silently disagrees with Twitch until
  // the mode is toggled off and on again.
  const fmins = $('bcFollowMins');
  if(fmins) fmins.addEventListener('change', async ()=>{
    if(!chatModes.follower_mode) return;   // it is just a setting for next time
    const minutes = Number(fmins.value) || 0;
    try{
      await invoke('twitch_set_chat_mode', { mode:'follower', enabled:true, minutes });
      chatModes.follower_mode_duration = minutes;
      paintChatModes();
      actOk('Minimum follow age updated.');
    }catch(e){ actWarn(String(e)); }
  });
  const sl = $('bcModeSlow');   if(sl) sl.addEventListener('click', ()=>toggleChatMode('slow','slow_mode'));
  const cc = $('bcClearChat');  if(cc) cc.addEventListener('click', clearChat);

  // Same as the follow-age picker: changing the wait while slow mode is already
  // on has to re-send, or the dropdown quietly disagrees with Twitch.
  const swait = $('bcSlowWait');
  if(swait) swait.addEventListener('change', async ()=>{
    if(!chatModes.slow_mode) return;
    const secs = Number(swait.value) || 30;
    try{
      await invoke('twitch_set_chat_mode', { mode:'slow', enabled:true, minutes:secs });
      chatModes.slow_mode_wait_time = secs;
      paintChatModes();
      actOk('Slow mode wait updated.');
    }catch(e){ actWarn(String(e)); }
  });

  const pane = $('bcActionsPane');
  if(pane) pane.querySelectorAll('[data-ad]').forEach(b=>{
    b.addEventListener('click', ()=>{
      const secs = Number(b.dataset.ad);
      if(!confirm(`Run a ${b.textContent} ad break now?`)) return;
      runAd(secs);
    });
  });
  const sn = $('bcSnooze'); if(sn) sn.addEventListener('click', snoozeAd);

  const raid = $('bcRaid');
  if(raid) raid.addEventListener('click', async ()=>{
    try{
      const u = await lookupUser($('bcTargetName').value);
      if(!confirm(`Raid ${u.name}?\n\nTwitch shows a 90-second countdown before your viewers are moved.`)) return;
      await invoke('twitch_start_raid', { targetId: u.id });
      actOk(`Raiding ${u.name} — countdown started.`);
      const w = $('bcCancelWrap'); if(w) w.style.display = 'inline';
    }catch(e){ actWarn(String(e && e.message ? e.message : e)); }
  });

  const so = $('bcShoutout');
  if(so) so.addEventListener('click', async ()=>{
    try{
      const u = await lookupUser($('bcTargetName').value);
      await invoke('twitch_send_shoutout', { targetId: u.id });
      actOk(`Shouted out ${u.name}.`);
    }catch(e){ actWarn(String(e && e.message ? e.message : e)); }
  });

  const cr = $('bcCancelRaid');
  if(cr) cr.addEventListener('click', async e=>{
    e.preventDefault();
    try{
      await invoke('twitch_cancel_raid');
      actOk('Raid cancelled.');
      const w = $('bcCancelWrap'); if(w) w.style.display = 'none';
    }catch(err){ actWarn(String(err)); }
  });

  const pac = $('bcPollAddChoice');
  if(pac) pac.addEventListener('click', ()=>{
    if(pollChoices.length >= 5){ actWarn('Twitch allows five answers at most.'); return; }
    pollChoices.push(''); renderChoiceInputs('bcPollChoices', pollChoices, 5);
  });
  const poc = $('bcPredAddOutcome');
  if(poc) poc.addEventListener('click', ()=>{
    if(predOutcomes.length >= 10){ actWarn('Twitch allows ten outcomes at most.'); return; }
    predOutcomes.push(''); renderChoiceInputs('bcPredOutcomes', predOutcomes, 10);
  });

  const ps = $('bcPollStart');
  if(ps) ps.addEventListener('click', async ()=>{
    try{
      await invoke('twitch_create_poll', {
        title: $('bcPollTitle').value || '',
        choices: pollChoices.slice(),
        duration: Number($('bcPollDur').value) || 120,
      });
      await refreshActive();
      actOk('Poll started.');
    }catch(e){ actWarn(String(e)); }
  });

  const prs = $('bcPredStart');
  if(prs) prs.addEventListener('click', async ()=>{
    try{
      await invoke('twitch_create_prediction', {
        title: $('bcPredTitle').value || '',
        outcomes: predOutcomes.slice(),
        window: Number($('bcPredWin').value) || 120,
      });
      await refreshActive();
      actOk('Prediction started.');
    }catch(e){ actWarn(String(e)); }
  });

  const pt = $('bcPollTplSave'); if(pt) pt.addEventListener('click', ()=>saveTemplate('poll'));
  const rt = $('bcPredTplSave'); if(rt) rt.addEventListener('click', ()=>saveTemplate('pred'));

  // Poll and prediction state changes on Twitch's side (viewers voting, the
  // timer running out), so it has to be polled. 5s only while something is
  // actually running — see refreshActive returning null otherwise.
  clearInterval(pollTick);
  pollTick = setInterval(()=>{
    if(activePoll || activePred) refreshActive().catch(()=>{});
  }, 5000);
}

// ── Per-chatter menu ──────────────────────────────────────────────────────────
// Opened by clicking a name in chat. A plain prompt-free menu anchored to the
// pane rather than a floating popup: the chat log scrolls constantly, and a
// popup pinned to a moving message would slide away from the pointer.

function openUserMenu(m){
  const host = $('bcChatWarn'); if(!host) return;
  const name = m.display || m.login;
  host.style.display = 'block';
  host.innerHTML = `
    <div class="row" style="gap:6px;align-items:center;flex-wrap:wrap">
      <span style="flex:1;min-width:120px"><strong>${esc(name)}</strong></span>
      <button class="btn-sm btn-ghost" data-um="mod">${m.mod ? 'Unmod' : 'Mod'}</button>
      <button class="btn-sm btn-ghost" data-um="vip">${m.vip ? 'Remove VIP' : 'VIP'}</button>
      <button class="btn-sm btn-ghost" data-um="whisper">Whisper</button>
      ${(m.broadcaster||m.mod) ? '' : '<button class="btn-sm btn-ghost" data-um="to">Timeout 10m</button>'}
      <button class="btn-sm btn-ghost" data-um="close">✕</button>
    </div>`;
  clearTimeout(chatWarn._t);

  host.querySelectorAll('[data-um]').forEach(b=>{
    b.addEventListener('click', async ()=>{
      const act = b.dataset.um;
      if(act === 'close'){ host.style.display='none'; return; }
      try{
        if(act === 'mod'){
          await invoke('twitch_set_moderator', { userId: m.userId, add: !m.mod });
          actOk(`${name} is ${m.mod ? 'no longer a mod' : 'now a mod'}.`);
        } else if(act === 'vip'){
          await invoke('twitch_set_vip', { userId: m.userId, add: !m.vip });
          actOk(`${name} is ${m.vip ? 'no longer a VIP' : 'now a VIP'}.`);
        } else if(act === 'whisper'){
          const text = prompt(`Whisper to ${name}:`);
          if(!text) return;
          await invoke('twitch_send_whisper', { userId: m.userId, message: text });
          actOk(`Whispered ${name}.`);
        } else if(act === 'to'){
          await invoke('twitch_ban_user', { userId: m.userId, duration: 600, reason: null });
          markUserRemoved(m.userId);
        }
        host.style.display = 'none';
      }catch(e){ chatWarn(String(e)); }
    });
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

function wireLeft(){
  const t = $('bcTitle');
  if(t) t.addEventListener('input', ()=>{ cur.title = t.value; updateTitleCount(); syncDirty(); clearInfoWarn(); });

  const cs = $('bcCatSearch');
  if(cs) cs.addEventListener('input', onCatType);

  const ti = $('bcTagInput');
  if(ti) ti.addEventListener('keydown', e=>{ if(e.key === 'Enter'){ e.preventDefault(); addTag(); } });
  const ta = $('bcTagAdd'); if(ta) ta.addEventListener('click', addTag);

  const ap = $('bcApply');   if(ap) ap.addEventListener('click', ()=>applyInfo());
  const rv = $('bcRevert');  if(rv) rv.addEventListener('click', ()=>{
    cur = { ...saved, tags: saved.tags.slice() };
    fillFields(); clearInfoWarn();
  });
  const mk = $('bcMarker');  if(mk) mk.addEventListener('click', ()=>addMarker());
  const ps = $('bcPresetSave'); if(ps) ps.addEventListener('click', savePreset);
}

export async function initBroadcast(){
  data = store.broadcast || {};
  if(!Array.isArray(data.presets))       data.presets = [];
  if(!Array.isArray(data.pollTemplates)) data.pollTemplates = [];
  if(!Array.isArray(data.predTemplates)) data.predTemplates = [];
  if(typeof data.splitPct !== 'number')  data.splitPct = 60;
  store.broadcast = data;

  buildLeft();
  buildChatPane();
  buildActionsPane();
  applySplit();
  initDivider();

  // Chat arrives as a global event forwarded by app.js, the same one the Chat
  // and Commands tabs listen to. No second IRC connection.
  window.addEventListener('spark-chat', e=>{ if(e.detail) onChatMessage(e.detail); });

  // Fire-and-forget: a slow or unreachable Twitch must never hold up boot.
  loadChannel().catch(()=>{});

  window.addEventListener('spark-twitch-status', e=>{
    if(e.detail && e.detail.connected){
      loadChannel().catch(()=>{});
      // Connecting or disconnecting a bot changes whether there is anything to
      // choose between, so the picker has to be rebuilt rather than drawn once.
      refreshSendAs().catch(()=>{});
    }
  });
  window.addEventListener('spark-bot-status', ()=>{ refreshSendAs().catch(()=>{}); });
  // Going live or offline changes uptime, viewers and the ad schedule at once.
  window.addEventListener('spark-stream', ()=>{ refreshStatus().catch(()=>{}); });

  clearInterval(statusTick);
  statusTick = setInterval(()=>{ refreshStatus().catch(()=>{}); }, 30000);
}
