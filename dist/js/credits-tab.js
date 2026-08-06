import { store, ignoreList, cachedFollower, setCachedFollower } from './store.js';
import { $, esc, renderOverlayBar, initDrag } from './utils.js';
import {
  defaultCfg, deepMerge, applyPreset, PRESETS,
  SECTION_KEYS, SECTION_LABELS, AUTO_SECTION_KEYS,
  GOOGLE_FONTS, BACKGROUNDS, BACKGROUND_LABELS,
  NAME_ORDERS, NAME_ORDER_LABELS, SCROLL_DIRS, SCROLL_DIR_LABELS,
  DOCKS, DOCK_LABELS,
} from './credits-defaults.js';
import { playSound as playAudioFile } from './audio.js';

const { invoke } = window.__TAURI__.core;
const dialog = window.__TAURI__.dialog;

let cfg = defaultCfg();
let saveTimer = null;

// ── Session chat tracking ───────────────────────────────────────────────────
// key = lowercase username. Persisted to disk (throttled) so an app restart
// mid/post-stream doesn't wipe the credits roster — on boot it's restored if
// the newest activity is fresher than SESSION_STALE_MS, otherwise it's treated
// as last stream's data and cleared.
let chatters = {};
let lastActivityAt = 0;
const SESSION_STALE_MS = 6 * 3600 * 1000;
let avatarCache = {};    // userId -> url
let hasResetThisBoot = false;

// Throttled disk save: at most one write per 30s, trailing save guaranteed
// (a pure debounce would never fire during nonstop chat).
let sessionSaveTimer = null;
let lastSessionSave = 0;
function scheduleSessionSave(){
  if(sessionSaveTimer) return;
  const wait = Math.max(0, 30000 - (Date.now() - lastSessionSave));
  sessionSaveTimer = setTimeout(()=>{
    sessionSaveTimer = null;
    lastSessionSave = Date.now();
    invoke('save_credits', { data: { ...cfg, session: { chatters, lastActivityAt } } });
  }, wait);
}

function clearSession(){
  chatters = {};
  lastActivityAt = 0;
  refreshSessionCount();
  schedulePushRoster();
  scheduleSessionSave();
}

const SAMPLE_CHATTERS = [
  { username:'modmax',        display:'ModMax',        is_mod:true,  is_vip:false, is_sub:false, is_follower:true,  firstSeenAt:1 },
  { username:'vipvicky',      display:'VipVicky',      is_mod:false, is_vip:true,  is_sub:true,  is_follower:true,  firstSeenAt:2 },
  { username:'subsam',        display:'SubSam',        is_mod:false, is_vip:false, is_sub:true,  is_follower:true,  firstSeenAt:3 },
  { username:'followerfiona', display:'FollowerFiona', is_mod:false, is_vip:false, is_sub:false, is_follower:true,  firstSeenAt:4 },
  { username:'viewervince',   display:'ViewerVince',   is_mod:false, is_vip:false, is_sub:false, is_follower:false, firstSeenAt:5 },
  { username:'chattercarl',   display:'ChatterCarl',   is_mod:false, is_vip:false, is_sub:false, is_follower:false, firstSeenAt:6 },
];

function lower(s){ return (s||'').trim().toLowerCase(); }

function persist(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(pushNow, 250);
}
function pushNow(){
  // Always write the session alongside cfg — a plain {data: cfg} save here
  // would strip the persisted chatters from disk on any settings tweak.
  invoke('save_credits', { data: { ...cfg, session: { chatters, lastActivityAt } } });
  invoke('credits_overlay_settings', { cfg, roster: resolveRoster(false) });
  sendPreview();
}

// The live-preview iframe runs in ?preview=1 mode and is driven directly via
// postMessage — unlike a real overlay it should ALWAYS show something after a
// settings change (sample names when no live chatters yet), otherwise style
// tweaks are invisible until credits actually play.
function sendPreview(){
  const frame = $('creditsPreviewFrame');
  if(!frame || !frame.contentWindow) return;
  const live = resolveRoster(false);
  const roster = live.length ? live : resolveRoster(true);
  frame.contentWindow.postMessage({ type:'spark-preview', cfg, roster }, '*');
}

// Lighter-weight refresh triggered by chat activity — keeps the overlay's
// cached roster current (for autoplay-on-load) without hitting disk on
// every single chat message.
let rosterPushTimer = null;
function schedulePushRoster(){
  clearTimeout(rosterPushTimer);
  rosterPushTimer = setTimeout(()=>{
    invoke('credits_overlay_settings', { cfg, roster: resolveRoster(false) });
    renderSessionRoster(); // debounced here — too costly per chat message
  }, 1500);
}

function markCustom(){
  if(cfg.preset !== 'Custom'){
    cfg.preset = 'Custom';
    document.querySelectorAll('.crPresetBtn').forEach(b=>{
      b.classList.toggle('btn-gold', b.dataset.preset==='Custom');
      b.classList.toggle('btn-ghost', b.dataset.preset!=='Custom');
    });
  }
}

// ── Small HTML builders (same conventions as other tabs) ────────────────────
function field(label, inputHtml){ return `<div><label>${label}</label>${inputHtml}</div>`; }
function colorInput(id,val){ return `<input type="color" id="${id}" value="${val||'#000000'}" style="width:50px;height:32px;border:none;background:none;cursor:pointer">`; }
function numInput(id,val,min,max,step){ return `<input type="number" id="${id}" value="${val}" min="${min}" max="${max}" ${step?`step="${step}"`:''} style="width:100%">`; }
function selectInput(id, options, cur){ return `<select id="${id}">`+options.map(o=>`<option value="${o.v}" ${String(o.v)===String(cur)?'selected':''}>${o.l}</option>`).join('')+`</select>`; }
function checkInput(id, checked, label){ return `<label class="checkrow"><input type="checkbox" id="${id}" ${checked?'checked':''}> ${label}</label>`; }
function on(id,evt,fn){ const el=$(id); if(el) el.addEventListener(evt,fn); }
function flashBtn(btn,msg){ if(!btn) return; const o=btn.textContent; btn.textContent=msg; setTimeout(()=>btn.textContent=o,1200); }

// ── Preserve non-style fields across a preset switch ────────────────────────
function snapshotUserData(){
  const secMeta = {};
  SECTION_KEYS.forEach(k=>{
    const s = cfg.sections[k];
    secMeta[k] = { enabled:s.enabled, heading:s.heading, order:s.order, manualAdd:s.manualAdd };
  });
  return {
    excludeList: cfg.excludeList, specialThanks: cfg.specialThanks,
    customPresets: cfg.customPresets, rolePriority: cfg.rolePriority,
    secMeta,
  };
}
function restoreUserData(target, snap){
  target.excludeList = snap.excludeList;
  target.specialThanks = snap.specialThanks;
  target.customPresets = snap.customPresets;
  target.rolePriority = snap.rolePriority;
  SECTION_KEYS.forEach(k=>{
    Object.assign(target.sections[k], snap.secMeta[k]);
  });
}

// ── Preset picker ────────────────────────────────────────────────────────────
function presetPickerHtml(){
  const names = Object.keys(PRESETS);
  const customNames = Object.keys(cfg.customPresets||{});
  return `<div class="card">
    <h2>Style Preset</h2>
    <div class="hint">Pick a full look, then fine-tune anything below. Colours and fonts only. Your sections, headings, and lists are untouched.</div>
    <div class="row mt" style="flex-wrap:wrap;gap:6px">
      ${names.map(n=>`<button class="btn-sm crPresetBtn ${cfg.preset===n?'btn-gold':'btn-ghost'}" data-preset="${esc(n)}">${esc(n)}</button>`).join('')}
      <button class="btn-sm crPresetBtn ${cfg.preset==='Custom'?'btn-gold':'btn-ghost'}" data-preset="Custom">Custom</button>
    </div>
    ${customNames.length?`<div class="hint mt">Your saved presets</div>
    <div class="row mt" style="flex-wrap:wrap;gap:6px">
      ${customNames.map(n=>`<span class="row" style="gap:2px">
        <button class="btn-sm crCustomPresetBtn ${cfg.preset===n?'btn-gold':'btn-ghost'}" data-custompreset="${esc(n)}">★ ${esc(n)}</button>
        <button class="btn-sm btn-ghost crCustomPresetDel" data-delpreset="${esc(n)}" title="Delete preset" style="padding:6px 8px">✕</button>
      </span>`).join('')}
    </div>`:''}
    <div class="row mt" style="gap:6px">
      <button class="btn-sm btn-ghost" id="crSaveCustomPreset">Save current style as new preset…</button>
      ${cfg.preset!=='Custom' && cfg.customPresets && cfg.customPresets[cfg.preset] ? `<button class="btn-sm btn-ghost" id="crUpdateCustomPreset">Update "${esc(cfg.preset)}"</button>` : ''}
    </div>
  </div>`;
}
function wirePresetPicker(){
  document.querySelectorAll('.crPresetBtn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const name = btn.dataset.preset;
      if(name!=='Custom'){
        const snap = snapshotUserData();
        cfg = applyPreset(name);
        restoreUserData(cfg, snap);
        cfg.preset = name;
      } else {
        cfg.preset = 'Custom';
      }
      buildLeft();
      pushNow();
    });
  });
  document.querySelectorAll('.crCustomPresetBtn').forEach(btn=>{
    btn.addEventListener('click', ()=>applyCustomPreset(btn.dataset.custompreset));
  });
  document.querySelectorAll('.crCustomPresetDel').forEach(btn=>{
    btn.addEventListener('click', e=>{
      e.stopPropagation();
      if(confirm(`Delete saved preset "${btn.dataset.delpreset}"?`)) deleteCustomPreset(btn.dataset.delpreset);
    });
  });
  on('crSaveCustomPreset','click', saveCustomPreset);
  on('crUpdateCustomPreset','click', updateCustomPreset);
}

function styleOnlyPatch(){
  // Extract just the style-relevant fields so presets never carry content/toggles
  const sections = {};
  SECTION_KEYS.forEach(k=>{
    const s = cfg.sections[k];
    sections[k] = { headingColor:s.headingColor, headingSize:s.headingSize, nameColor:s.nameColor, nameSize:s.nameSize, divider:s.divider, font:s.font };
  });
  return {
    layout: JSON.parse(JSON.stringify(cfg.layout)),
    scroll: JSON.parse(JSON.stringify(cfg.scroll)),
    sections,
  };
}
function saveCustomPreset(){
  const name = (prompt('Name this preset:')||'').trim();
  if(!name) return;
  if(!cfg.customPresets) cfg.customPresets = {};
  cfg.customPresets[name] = styleOnlyPatch();
  cfg.preset = name;
  persist();
  buildLeft();
}
function updateCustomPreset(){
  if(!cfg.customPresets || !cfg.customPresets[cfg.preset]) return;
  cfg.customPresets[cfg.preset] = styleOnlyPatch();
  persist();
  buildLeft();
  flashBtn($('crUpdateCustomPreset'), 'Updated!');
}
function applyCustomPreset(name){
  const patch = cfg.customPresets && cfg.customPresets[name];
  if(!patch) return;
  const snap = snapshotUserData();
  cfg = deepMerge(defaultCfg(), patch);
  restoreUserData(cfg, snap);
  cfg.preset = name;
  buildLeft();
  pushNow();
}
function deleteCustomPreset(name){
  if(!cfg.customPresets) return;
  delete cfg.customPresets[name];
  if(cfg.preset===name) cfg.preset = 'Custom';
  persist();
  buildLeft();
}

// ── Section order (drag to reorder which section scrolls first) ────────────
function sectionOrderHtml(){
  const ordered = SECTION_KEYS.slice().sort((a,b)=>cfg.sections[a].order-cfg.sections[b].order);
  return `<div class="card" id="crSectionOrderCard">
    <h2>Section Order</h2>
    <div class="hint">Drag to reorder which section scrolls first (e.g. move Subscribers to the bottom).</div>
    <div id="crSectionOrderList" class="mt">
      ${ordered.map((k,i)=>`
        <div class="item-row" data-i="${i}" data-key="${k}">
          <span class="drag-handle">☰</span>
          <span class="item-name">${esc(cfg.sections[k].heading)}${cfg.sections[k].enabled?'':' <span class="tag">off</span>'}</span>
        </div>`).join('')}
    </div>
  </div>`;
}
function wireSectionOrder(){
  const container = $('crSectionOrderList'); if(!container) return;
  initDrag(container, (from,to)=>{
    const ordered = SECTION_KEYS.slice().sort((a,b)=>cfg.sections[a].order-cfg.sections[b].order);
    const [item] = ordered.splice(from,1);
    ordered.splice(to,0,item);
    ordered.forEach((k,i)=>{ cfg.sections[k].order = i; });
    persist();
    rebuildSectionOrder();
  });
}
function rebuildSectionOrder(){
  const card = $('crSectionOrderCard'); if(!card) return;
  card.outerHTML = sectionOrderHtml();
  wireSectionOrder();
}

// ── Role priority (drag to reorder who wins when multiple roles apply) ─────
function rolePriorityHtml(){
  return `<div class="card" id="crRolePriorityCard">
    <h2>Role Priority</h2>
    <div class="hint">If a chatter qualifies for more than one section (e.g. Mod + Sub), the highest one here wins. Viewers is always the catch-all.</div>
    <div id="crRolePriorityList" class="mt">
      ${cfg.rolePriority.map((k,i)=>`
        <div class="item-row" data-i="${i}">
          <span class="drag-handle">☰</span>
          <span class="item-name">${i+1}. ${esc(SECTION_LABELS[k])}</span>
        </div>`).join('')}
    </div>
  </div>`;
}
function wireRolePriority(){
  const container = $('crRolePriorityList'); if(!container) return;
  initDrag(container, (from,to)=>{
    const arr = cfg.rolePriority;
    const [item] = arr.splice(from,1);
    arr.splice(to,0,item);
    persist();
    rebuildRolePriority();
  });
}
function rebuildRolePriority(){
  const card = $('crRolePriorityCard'); if(!card) return;
  card.outerHTML = rolePriorityHtml();
  wireRolePriority();
}

// ── Per-section cards ────────────────────────────────────────────────────────
function sectionCardHtml(key){
  const s = cfg.sections[key];
  const isSpecial = key==='special';
  return `<div class="card" id="crSecCard_${key}">
    <h2>${esc(SECTION_LABELS[key])}
      <label class="checkrow" style="display:inline-flex;margin:0 0 0 12px">
        <input type="checkbox" class="crSecEnabled" data-key="${key}" ${s.enabled?'checked':''}> Enabled
      </label>
    </h2>
    <label>Heading text</label>
    <input type="text" class="crSecHeading" data-key="${key}" value="${esc(s.heading)}">
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px;margin-top:10px">
      ${field('Heading colour', colorInput('crHc_'+key, s.headingColor))}
      ${field('Heading size', numInput('crHs_'+key, s.headingSize, 10, 60, 1))}
      ${field('Name colour', colorInput('crNc_'+key, s.nameColor))}
      ${field('Name size', numInput('crNs_'+key, s.nameSize, 8, 48, 1))}
    </div>
    <div class="mt">${field('Font (blank = use global font)', selectInput('crFont_'+key, [{v:'',l:'(use global font)'}, ...GOOGLE_FONTS.map(f=>({v:f,l:f}))], s.font||''))}</div>
    <div class="mt">${checkInput('crDiv_'+key, s.divider, 'Show divider line above this section')}</div>
    ${isSpecial ? `
      <label class="mt">Special Thanks messages (one per line, free text, not tied to chat)</label>
      <textarea id="crSpecialThanks" style="height:90px">${esc((cfg.specialThanks||[]).join('\n'))}</textarea>
    ` : `
      <label class="mt">Manually add names (one per line, shown in addition to detected chatters)</label>
      <textarea class="crManualAdd" data-key="${key}" style="height:70px">${esc((s.manualAdd||[]).join('\n'))}</textarea>
    `}
  </div>`;
}
function wireSectionCard(key){
  const s = cfg.sections[key];
  document.querySelectorAll(`.crSecEnabled[data-key="${key}"]`).forEach(el=>{
    el.addEventListener('change', e=>{ s.enabled=e.target.checked; persist(); rebuildSectionOrder(); });
  });
  document.querySelectorAll(`.crSecHeading[data-key="${key}"]`).forEach(el=>{
    el.addEventListener('input', e=>{ s.heading=e.target.value; persist(); rebuildSectionOrder(); });
  });
  on('crHc_'+key,'input', e=>{ s.headingColor=e.target.value; markCustom(); persist(); });
  on('crHs_'+key,'input', e=>{ s.headingSize=parseInt(e.target.value)||20; markCustom(); persist(); });
  on('crNc_'+key,'input', e=>{ s.nameColor=e.target.value; markCustom(); persist(); });
  on('crNs_'+key,'input', e=>{ s.nameSize=parseInt(e.target.value)||18; markCustom(); persist(); });
  on('crFont_'+key,'change', e=>{ s.font=e.target.value||null; markCustom(); persist(); });
  on('crDiv_'+key,'change', e=>{ s.divider=e.target.checked; markCustom(); persist(); });
  if(key==='special'){
    on('crSpecialThanks','input', e=>{
      cfg.specialThanks = e.target.value.split('\n').map(x=>x.trim()).filter(Boolean);
      persist();
    });
  } else {
    document.querySelectorAll(`.crManualAdd[data-key="${key}"]`).forEach(el=>{
      el.addEventListener('input', e=>{
        s.manualAdd = e.target.value.split('\n').map(x=>x.trim()).filter(Boolean);
        persist();
      });
    });
  }
}

// ── Exclude list ──────────────────────────────────────────────────────────────
function excludeListHtml(){
  return `<div class="card">
    <h2>Exclude List <span class="tag">credits only</span></h2>
    <div class="hint">One username per line. Excluded from the credits only. Bots you want ignored everywhere belong in Settings under Bot / User Ignore List (applied here automatically).</div>
    <textarea id="crExcludeList" style="height:80px">${esc((cfg.excludeList||[]).join('\n'))}</textarea>
  </div>`;
}
function wireExcludeList(){
  on('crExcludeList','input', e=>{
    cfg.excludeList = e.target.value.split('\n').map(lower).filter(Boolean);
    persist();
  });
}

// ── Ordering & scroll & layout settings ─────────────────────────────────────
function generalSettingsHtml(){
  const sc = cfg.scroll, l = cfg.layout;
  const horizontal = sc.direction==='left' || sc.direction==='right';
  return `<div class="card">
    <h2>Ordering &amp; Scroll</h2>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      ${field('Name order within a section', selectInput('crNameOrder', NAME_ORDERS.map(v=>({v,l:NAME_ORDER_LABELS[v]})), cfg.nameOrder))}
      ${field('Scroll direction', selectInput('crScrollDir', SCROLL_DIRS.map(v=>({v,l:SCROLL_DIR_LABELS[v]})), sc.direction))}
      ${field('Scroll speed (px/sec)', numInput('crScrollSpeed', sc.speed, 5, 300, 5))}
      ${field('Gap between names (px)', numInput('crGap', sc.gap, 0, 40, 1))}
      ${field('Gap between sections (px)', numInput('crSectionGap', sc.sectionGap, 0, 160, 2))}
      ${horizontal ? field('Dock position', selectInput('crDock', DOCKS.map(v=>({v,l:DOCK_LABELS[v]})), sc.dock)) : ''}
      ${horizontal ? field('Ticker band height (px)', numInput('crBandHeight', sc.bandHeight, 40, 400, 5)) : ''}
    </div>
    <div class="hint mt">${horizontal ? 'Sideways mode renders a ticker band docked to the top, middle, or bottom of the screen. Good for a bottom of screen credits crawl.' : 'Classic mode scrolls the full list vertically up or down the whole screen.'}</div>
    <div class="row mt" style="gap:14px;flex-wrap:wrap">
      ${checkInput('crLoop', sc.loop, 'Loop when finished')}
      ${!horizontal ? checkInput('crFadeEdges', sc.fadeEdges, 'Fade top/bottom edges') : ''}
      ${checkInput('crAutoplay', sc.autoplay, 'Auto-play when this overlay page loads')}
    </div>
    <div class="hint">Auto-play fires the moment the overlay page loads. In OBS, enable "Shutdown source when not visible" on this Browser Source so switching to its scene reloads (and re-triggers) it.</div>
  </div>
  <div class="card">
    <h2>Layout &amp; Background</h2>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      ${field('Font', selectInput('crFont', GOOGLE_FONTS.map(f=>({v:f,l:f})), l.font))}
      ${field('Alignment', selectInput('crAlign', [{v:'left',l:'Left'},{v:'center',l:'Centre'},{v:'right',l:'Right'}], l.align))}
      ${field('Width (px)', numInput('crWidth', l.width, 300, 1400, 10))}
      ${field('Background style', selectInput('crBg', BACKGROUNDS.map(b=>({v:b,l:BACKGROUND_LABELS[b]})), l.bg))}
      ${field('Background colour', colorInput('crBgColor', l.bgColor))}
      ${l.bg==='gradient' ? field('Gradient 2nd colour', colorInput('crBgColor2', l.bgColor2)) : ''}
      ${field('Background opacity', numInput('crBgOpacity', l.bgOpacity, 0, 1, .05))}
    </div>
    <div class="row mt" style="gap:14px;flex-wrap:wrap;align-items:center">
      ${checkInput('crAvatars', l.showAvatars, 'Show viewer avatars')}
      ${field('Avatar size (px)', numInput('crAvatarSize', l.avatarSize, 20, 120, 2))}
    </div>
    <div class="row mt" style="gap:8px;align-items:center">
      <button class="btn-sm" id="crMusicPick">Music bed…</button>
      <span id="crMusicName" class="hint">${l.music?l.music.split(/[\\/]/).pop():'No file'}</span>
      <button class="btn-sm btn-ghost" id="crMusicClear">Clear</button>
    </div>
    <div class="row mt" style="align-items:center;gap:8px">
      <label style="flex:1">Music volume</label><input type="range" id="crMusicVol" min="0" max="1" step=".05" value="${l.musicVolume}" style="width:140px">
    </div>
  </div>`;
}
function rebuildGeneralSettings(){
  const el = $('crGeneralSettings'); if(!el) return;
  el.innerHTML = generalSettingsHtml();
  wireGeneralSettings();
}
function wireGeneralSettings(){
  const sc = cfg.scroll, l = cfg.layout;
  on('crNameOrder','change', e=>{ cfg.nameOrder=e.target.value; persist(); });
  on('crScrollDir','change', e=>{ sc.direction=e.target.value; markCustom(); persist(); rebuildGeneralSettings(); });
  on('crScrollSpeed','input', e=>{ sc.speed=parseInt(e.target.value)||50; markCustom(); persist(); });
  on('crGap','input', e=>{ sc.gap=parseInt(e.target.value)||0; markCustom(); persist(); });
  on('crSectionGap','input', e=>{ sc.sectionGap=parseInt(e.target.value)||0; markCustom(); persist(); });
  on('crDock','change', e=>{ sc.dock=e.target.value; markCustom(); persist(); });
  on('crBandHeight','input', e=>{ sc.bandHeight=parseInt(e.target.value)||140; markCustom(); persist(); });
  on('crLoop','change', e=>{ sc.loop=e.target.checked; persist(); });
  on('crFadeEdges','change', e=>{ sc.fadeEdges=e.target.checked; markCustom(); persist(); });
  on('crAutoplay','change', e=>{ sc.autoplay=e.target.checked; persist(); });
  on('crFont','change', e=>{ l.font=e.target.value; markCustom(); persist(); });
  on('crAlign','change', e=>{ l.align=e.target.value; markCustom(); persist(); });
  on('crWidth','input', e=>{ l.width=parseInt(e.target.value)||640; markCustom(); persist(); });
  on('crBg','change', e=>{ l.bg=e.target.value; markCustom(); persist(); rebuildGeneralSettings(); });
  on('crBgColor','input', e=>{ l.bgColor=e.target.value; markCustom(); persist(); });
  on('crBgColor2','input', e=>{ l.bgColor2=e.target.value; markCustom(); persist(); });
  on('crBgOpacity','input', e=>{ l.bgOpacity=parseFloat(e.target.value); markCustom(); persist(); });
  on('crAvatars','change', e=>{ l.showAvatars=e.target.checked; persist(); });
  on('crAvatarSize','input', e=>{ l.avatarSize=parseInt(e.target.value)||44; persist(); });
  on('crMusicPick','click', async()=>{
    const f=await dialog.open({multiple:false,filters:[{name:'Audio',extensions:['mp3','wav','ogg','m4a']}]});
    if(f){ l.music=f; $('crMusicName').textContent=f.split(/[\\/]/).pop(); persist(); }
  });
  on('crMusicClear','click', ()=>{ l.music=null; $('crMusicName').textContent='No file'; persist(); });
  on('crMusicVol','input', e=>{ l.musicVolume=parseFloat(e.target.value); persist(); });
}

// ── Session info / controls ─────────────────────────────────────────────────
function sessionCardHtml(){
  return `<div class="card">
    <h2>Session</h2>
    <div class="hint" id="crSessionCount">${Object.keys(chatters).length} chatter(s) tracked this session.</div>
    <div id="crSessionRoster"></div>
    <div class="row mt" style="gap:8px">
      <button class="btn-sm btn-ghost" id="crResetSession">Reset Session</button>
      <button class="btn-sm btn-ghost" id="crPreviewSample">Preview (sample names)</button>
      <button class="btn-gold btn-sm" id="crPlayLive">▶ Play Credits</button>
    </div>
    <div class="hint mt">Session survives an app restart (up to 6h idle). It auto-resets when SPARK first connects to Twitch after a fresh stream, or any time you click Reset Session.</div>
  </div>`;
}
function refreshSessionCount(){
  const el = $('crSessionCount'); if(el) el.textContent = `${Object.keys(chatters).length} chatter(s) tracked this session.`;
}
// Visual confirmation of exactly who will appear in the credits, per section.
function renderSessionRoster(){
  const el = $('crSessionRoster'); if(!el) return;
  const roster = resolveRoster(false);
  el.innerHTML = roster.length ? roster.map(sec=>`
    <div class="mt"><b>${esc(sec.heading)}</b> <span class="tag">${sec.names.length}</span>
      <div class="hint" style="word-break:break-word">${sec.names.map(n=>esc(n.name)).join(', ')}</div>
    </div>`).join('')
    : '<div class="hint mt">Nothing collected yet. Names appear here as viewers chat.</div>';
}
function wireSessionCard(){
  on('crResetSession','click', ()=>{
    clearSession();
    flashBtn($('crResetSession'), 'Reset!');
  });
  on('crPreviewSample','click', ()=>playCredits(true));
  on('crPlayLive','click', ()=>playCredits(false));
}

// ── Roster resolution ────────────────────────────────────────────────────────
function resolveRoster(sampleMode){
  // Global ignore list (Settings) + credits-specific excludes
  const excl = new Set([...ignoreList(), ...(cfg.excludeList||[])].map(lower));
  const buckets = {}; AUTO_SECTION_KEYS.forEach(k=>buckets[k]=[]);
  const source = sampleMode ? SAMPLE_CHATTERS : Object.values(chatters);

  source.forEach(c=>{
    if(excl.has(lower(c.username))) return;
    let bucket = 'viewers';
    for(const key of cfg.rolePriority){
      if(key==='mods' && c.is_mod){ bucket='mods'; break; }
      if(key==='vips' && c.is_vip){ bucket='vips'; break; }
      if(key==='subs' && c.is_sub){ bucket='subs'; break; }
      if(key==='followers' && c.is_follower){ bucket='followers'; break; }
    }
    buckets[bucket].push(c);
  });

  const result = [];
  SECTION_KEYS.forEach(key=>{
    const sec = cfg.sections[key];
    if(!sec || !sec.enabled) return;
    let names;
    if(key==='special'){
      names = (cfg.specialThanks||[]).map(t=>({ name:t, avatarUrl:null }));
    } else {
      let list = (buckets[key]||[]).map(c=>({
        name: c.display || c.username, avatarUrl: c.avatarUrl || null, _first: c.firstSeenAt || 0,
      }));
      (sec.manualAdd||[]).forEach(n=>{ if(n) list.push({ name:n, avatarUrl:null, _first:0 }); });
      const seen = new Set();
      list = list.filter(x=>{ const k=lower(x.name); if(seen.has(k)) return false; seen.add(k); return true; });
      if(cfg.nameOrder==='alpha') list.sort((a,b)=>a.name.localeCompare(b.name));
      else if(cfg.nameOrder==='shuffle') list.sort(()=>Math.random()-.5);
      else list.sort((a,b)=>a._first-b._first);
      names = list.map(({name,avatarUrl})=>({name,avatarUrl}));
    }
    if(!names.length) return;
    result.push({
      key, heading:sec.heading, headingColor:sec.headingColor, headingSize:sec.headingSize,
      nameColor:sec.nameColor, nameSize:sec.nameSize, divider:sec.divider, font:sec.font||null,
      order:sec.order, names,
    });
  });
  result.sort((a,b)=>a.order-b.order);
  return result;
}

// Credits music runs for the whole roll, so it bypasses the concurrent cap
// rather than occupying a slot for minutes. Volume here is 0-1; the shared
// player takes 0-100.
function playMusic(path, volume){
  playAudioFile(path, { volume: (volume==null?0.6:volume)*100, force:true });
}

// Commands tab: "Trigger a SPARK tool" -> Credits. Credits has no Settings
// toggle (it is not in TOOL_DEFS), so there is nothing to check here.
window.addEventListener('spark-action', e => {
  const d = e.detail || {};
  if(d.tool !== 'credits') return;
  if(d.action === 'play') playCredits(false);
});

function playCredits(sampleMode){
  const roster = resolveRoster(sampleMode);
  invoke('credits_overlay_play', { event: { type:'play', roster, layout:cfg.layout, scroll:cfg.scroll } });
  if(!sampleMode) playMusic(cfg.layout.music, cfg.layout.musicVolume);
}

// ── Twitch chat tracking ─────────────────────────────────────────────────────
// Shared persistent cache (store.settings.followerCache) — same one chat uses.
async function checkFollower(userId){
  if(!userId) return false;
  const c = cachedFollower(userId);
  if(c !== undefined) return c;
  if(!store.twitch.userId) return false;
  try{
    const r = await invoke('twitch_check_follower', { userId, broadcasterId: store.twitch.userId });
    setCachedFollower(userId, !!r);
    return !!r;
  }catch(e){ return false; }
}

async function fetchAvatar(userId){
  if(!userId || avatarCache[userId] !== undefined) return avatarCache[userId];
  try{
    const info = await invoke('twitch_get_user_info', { userId });
    const url = info && info.profile_image_url || null;
    avatarCache[userId] = url;
    return url;
  }catch(e){ avatarCache[userId] = null; return null; }
}

async function chatHandler(e){
  const d = e.detail;
  const uname = lower(d.username);
  if(!uname) return;
  if(ignoreList().includes(uname) || (cfg.excludeList||[]).map(lower).includes(uname)) return;

  const existing = chatters[uname];
  const elevated = d.is_broadcaster || d.is_mod || d.is_vip || d.is_sub;
  const isFollower = existing ? existing.is_follower : (elevated ? false : await checkFollower(d.user_id));

  chatters[uname] = {
    username: d.username, display: d.display || d.username, user_id: d.user_id,
    is_mod: !!(d.is_mod || d.is_broadcaster), is_vip: !!d.is_vip, is_sub: !!d.is_sub,
    is_follower: !!isFollower,
    firstSeenAt: existing ? existing.firstSeenAt : Date.now(),
    avatarUrl: existing ? existing.avatarUrl : null,
  };
  lastActivityAt = Date.now();
  refreshSessionCount();
  schedulePushRoster();
  scheduleSessionSave();

  if(cfg.layout.showAvatars && d.user_id && chatters[uname].avatarUrl == null){
    fetchAvatar(d.user_id).then(url=>{ if(chatters[uname]) chatters[uname].avatarUrl = url; });
  }
}

function twitchStatusHandler(e){
  if(!e.detail || !e.detail.connected) return;
  if(hasResetThisBoot) return;
  hasResetThisBoot = true;
  clearSession();
}

// ── Assemble left column ────────────────────────────────────────────────────
function buildLeft(){
  const el = $('creditsLeft'); if(!el) return;
  el.innerHTML = `
    ${sessionCardHtml()}
    ${presetPickerHtml()}
    ${sectionOrderHtml()}
    ${rolePriorityHtml()}
    ${SECTION_KEYS.map(sectionCardHtml).join('')}
    ${excludeListHtml()}
    <div id="crGeneralSettings">${generalSettingsHtml()}</div>
    <div style="height:40px"></div>
  `;
  wireSessionCard();
  wirePresetPicker();
  wireSectionOrder();
  wireRolePriority();
  SECTION_KEYS.forEach(wireSectionCard);
  wireExcludeList();
  wireGeneralSettings();
  renderSessionRoster();
  renderOverlayBar('crOverlayMode','crOverlayUrl','crCopyUrl','credits',store.overlayUrls);
}

// ── Init ─────────────────────────────────────────────────────────────────────
export async function initCredits(){
  const saved = store.credits || {};
  const sess = saved.session || null;
  cfg = deepMerge(defaultCfg(), saved);
  delete cfg.session; // session data rides alongside cfg on disk, never inside it
  if(!cfg.preset) cfg.preset = 'Custom';
  if(!cfg.customPresets || typeof cfg.customPresets !== 'object') cfg.customPresets = saved.customPresets || {};

  // Restore the persisted chatter session if it's fresh (crash/restart mid-
  // stream); stale data is last stream's — leave it to the connect-reset.
  if(sess && sess.chatters && (Date.now() - (sess.lastActivityAt || 0)) < SESSION_STALE_MS){
    chatters = sess.chatters;
    lastActivityAt = sess.lastActivityAt || 0;
    hasResetThisBoot = true; // restored a live session — don't wipe it when Twitch connects
  }

  buildLeft();

  const frame = $('creditsPreviewFrame');
  const urls = store.overlayUrls || {};
  if(frame && urls.credits){
    frame.src = urls.credits + '?preview=1';
    frame.addEventListener('load', ()=>sendPreview());
  }

  pushNow(); // seed overlay snapshot so a freshly opened browser source shows current styling immediately

  window.addEventListener('spark-chat', chatHandler);
  window.addEventListener('spark-twitch-status', twitchStatusHandler);
  // Global ignore list changed — re-resolve the roster (overlay cache + tab display)
  window.addEventListener('spark-ignorelist', ()=>schedulePushRoster());
}
