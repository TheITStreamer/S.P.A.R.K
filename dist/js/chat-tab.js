import { store, isIgnored, addIgnore, cachedFollower, setCachedFollower } from './store.js';
import { $, esc, renderOverlayBar } from './utils.js';
import {
  defaultCfg, deepMerge, applyPreset, PRESETS, GOOGLE_FONTS,
  ROLE_KEYS, ROLE_LABELS, SHAPES, SHAPE_LABELS, ANIMS, ANIM_LABELS, DIRS,
  BACKGROUNDS, BACKGROUND_LABELS,
} from './chat-defaults.js';
import { playSound as playAudioFile } from './audio.js';

const { invoke } = window.__TAURI__.core;
const dialog = window.__TAURI__.dialog;

const FONT_WEIGHTS = [{v:400,l:'Regular'},{v:600,l:'Semibold'},{v:700,l:'Bold'},{v:800,l:'Extra Bold'}];

let cfg = defaultCfg();
cfg.ignoreList = [];
cfg.preset = 'Custom';
let activeRole = 'everyone';
let liveLog = []; // {username, display, message, ignored}
let saveTimer = null;

// Persistent cache (store.settings.followerCache) — survives restarts.
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

function lower(s){ return (s||'').trim().toLowerCase(); }

function persist(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(pushNow, 200);
}
function pushNow(){
  invoke('save_chat', { data: cfg });
  invoke('chat_overlay_settings', { cfg });
}

function markCustom(){
  // If a saved (★) custom preset is active, auto-write the change back into it
  // and keep it selected. With a built-in preset active, any tweak flips the
  // picker to "Custom".
  if(cfg.preset !== 'Custom' && cfg.customPresets && cfg.customPresets[cfg.preset]){
    cfg.customPresets[cfg.preset] = {
      layout: JSON.parse(JSON.stringify(cfg.layout)),
      roles:  JSON.parse(JSON.stringify(cfg.roles)),
      alerts: JSON.parse(JSON.stringify(cfg.alerts)),
    };
    return;
  }
  if(cfg.preset !== 'Custom'){
    cfg.preset = 'Custom';
    document.querySelectorAll('.chPresetBtn').forEach(b=>{
      b.classList.toggle('btn-gold', b.dataset.preset==='Custom');
      b.classList.toggle('btn-ghost', b.dataset.preset!=='Custom');
    });
  }
}

// ── Small HTML builders ─────────────────────────────────────────────────────
function field(label, inputHtml){ return `<div><label>${label}</label>${inputHtml}</div>`; }
function colorInput(id,val){ return `<input type="color" id="${id}" value="${val||'#000000'}" style="width:50px;height:32px;border:none;background:none;cursor:pointer">`; }
function numInput(id,val,min,max,step){ return `<input type="number" id="${id}" value="${val}" min="${min}" max="${max}" ${step?`step="${step}"`:''} style="width:100%">`; }
function selectInput(id, options, cur){ return `<select id="${id}">`+options.map(o=>`<option value="${o.v}" ${String(o.v)===String(cur)?'selected':''}>${o.l}</option>`).join('')+`</select>`; }
function checkInput(id, checked, label){ return `<label class="checkrow"><input type="checkbox" id="${id}" ${checked?'checked':''}> ${label}</label>`; }
function flashBtn(btn,msg){ if(!btn) return; const o=btn.textContent; btn.textContent=msg; setTimeout(()=>btn.textContent=o,1200); }
function on(id,evt,fn){ const el=$(id); if(el) el.addEventListener(evt,fn); }

// ── Preset picker ────────────────────────────────────────────────────────────
function presetPickerHtml(){
  const names = Object.keys(PRESETS);
  const customNames = Object.keys(cfg.customPresets||{});
  return `<div class="card">
    <h2>Style Preset</h2>
    <div class="hint">Pick a full look, then fine-tune anything below. Every field can be overridden. Spans everything from Serious to Bland to full Cutesy.</div>
    <div class="row mt" style="flex-wrap:wrap;gap:6px">
      ${names.map(n=>`<button class="btn-sm chPresetBtn ${cfg.preset===n?'btn-gold':'btn-ghost'}" data-preset="${esc(n)}">${esc(n)}</button>`).join('')}
      <button class="btn-sm chPresetBtn ${cfg.preset==='Custom'?'btn-gold':'btn-ghost'}" data-preset="Custom">Custom</button>
    </div>
    ${customNames.length?`<div class="hint mt">Your saved presets</div>
    <div class="row mt" style="flex-wrap:wrap;gap:6px">
      ${customNames.map(n=>`<span class="row" style="gap:2px">
        <button class="btn-sm chCustomPresetBtn ${cfg.preset===n?'btn-gold':'btn-ghost'}" data-custompreset="${esc(n)}">★ ${esc(n)}</button>
        <button class="btn-sm btn-ghost chCustomPresetDel" data-delpreset="${esc(n)}" title="Delete preset" style="padding:6px 8px">✕</button>
      </span>`).join('')}
    </div>`:''}
    <button class="btn-sm btn-ghost mt" id="chSaveCustomPreset">Save current style as preset…</button>
  </div>`;
}
function wirePresetPicker(){
  document.querySelectorAll('.chPresetBtn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const name = btn.dataset.preset;
      if(name!=='Custom'){
        const ignoreList = cfg.ignoreList, customPresets = cfg.customPresets;
        cfg = applyPreset(name);
        cfg.ignoreList = ignoreList;
        cfg.customPresets = customPresets;
        cfg.preset = name;
      } else {
        cfg.preset = 'Custom';
      }
      buildLeft();
      pushNow();
    });
  });
  document.querySelectorAll('.chCustomPresetBtn').forEach(btn=>{
    btn.addEventListener('click', ()=>applyCustomPreset(btn.dataset.custompreset));
  });
  document.querySelectorAll('.chCustomPresetDel').forEach(btn=>{
    btn.addEventListener('click', e=>{
      e.stopPropagation();
      if(confirm(`Delete saved preset "${btn.dataset.delpreset}"?`)) deleteCustomPreset(btn.dataset.delpreset);
    });
  });
  on('chSaveCustomPreset','click', saveCustomPreset);
}

// ── User-defined presets (built from whatever's currently configured) ──────
function saveCustomPreset(){
  const name = (prompt('Name this preset:')||'').trim();
  if(!name) return;
  if(name === 'Custom' || PRESETS[name]){ alert(`"${name}" is a built-in preset name. Pick a different one.`); return; }
  if(!cfg.customPresets) cfg.customPresets = {};
  cfg.customPresets[name] = {
    layout: JSON.parse(JSON.stringify(cfg.layout)),
    roles:  JSON.parse(JSON.stringify(cfg.roles)),
    alerts: JSON.parse(JSON.stringify(cfg.alerts)),
  };
  cfg.preset = name;
  persist();
  buildLeft();
}
function applyCustomPreset(name){
  const patch = cfg.customPresets && cfg.customPresets[name];
  if(!patch) return;
  const ignoreList = cfg.ignoreList, customPresets = cfg.customPresets;
  cfg = deepMerge(defaultCfg(), patch);
  cfg.ignoreList = ignoreList;
  cfg.customPresets = customPresets;
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

// The ignore list lives in Settings (global, shared by all tools). The quick-
// Ignore buttons in the Live Chat log below write to that global list.

// ── Layout & background ────────────────────────────────────────────────────
function layoutSectionHtml(){
  const l = cfg.layout;
  return `
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
    ${field('Background style', selectInput('lfBg', BACKGROUNDS.map(b=>({v:b,l:BACKGROUND_LABELS[b]})), l.bg))}
    <div style="align-self:end">${checkInput('lfBlur', l.panelBlur, 'Blur panel background')}</div>
    ${field('Background colour', colorInput('lfBgColor', l.bgColor))}
    ${field('Gradient 2nd colour', colorInput('lfBgColor2', l.bgColor2))}
    ${field('Background opacity', numInput('lfBgOpacity', l.bgOpacity, 0, 1, .05))}
    ${l.bg==='image' ? field('Background image URL', `<input type="text" id="lfBgImage" value="${esc(l.bgImage||'')}" placeholder="https://...">`) : ''}
  </div>
  ${l.bg==='image' ? `<div class="hint">Image URL must be a public web link. Local files can't be reached by an OBS browser source.</div>` : ''}
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:10px">
    ${field('New messages grow', selectInput('lfDir', [{v:'up',l:'Upward (newest bottom)'},{v:'down',l:'Downward (newest top)'}], l.direction))}
    ${field('Alignment', selectInput('lfAlign', [{v:'left',l:'Left'},{v:'center',l:'Centre'},{v:'right',l:'Right'}], l.align))}
    ${field('Max messages shown', numInput('lfMax', l.maxMessages, 3, 60, 1))}
    ${field('List width (px)', numInput('lfWidth', l.width, 200, 900, 10))}
    ${field('Spacing between (px)', numInput('lfGap', l.gap, 0, 30, 1))}
    ${field('Outer padding (px)', numInput('lfPad', l.padding, 0, 60, 1))}
  </div>
  <div class="row mt" style="gap:14px;flex-wrap:wrap">
    ${checkInput('lfFade', l.autoFade, 'Auto-fade old messages')}
    ${field('Fade after (sec)', numInput('lfFadeSecs', l.fadeAfter, 3, 120, 1))}
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px">
    ${field('Entry animation', selectInput('lfAnim', ANIMS.map(x=>({v:x,l:ANIM_LABELS[x]})), l.animIn))}
    ${l.animIn==='slide' ? field('Entry direction', selectInput('lfAnimDir', DIRS.map(x=>({v:x,l:x[0].toUpperCase()+x.slice(1)})), l.animInDir)) : ''}
  </div>
  <div class="row mt" style="gap:14px;flex-wrap:wrap">
    ${checkInput('lfTimestamp', l.showTimestamp, 'Show timestamps')}
    ${checkInput('lfBadges', l.showBadgeIcons, 'Show badge icons')}
    ${checkInput('lfEmotes', l.showEmotes, 'Show emote images')}
  </div>`;
}
function rebuildLayoutSection(){
  const el = $('chLayoutSection'); if(!el) return;
  el.innerHTML = layoutSectionHtml();
  wireLayoutSection();
}
function wireLayoutSection(){
  const l = cfg.layout;
  on('lfBg','change', e=>{ l.bg=e.target.value; markCustom(); persist(); rebuildLayoutSection(); });
  on('lfBlur','change', e=>{ l.panelBlur=e.target.checked; markCustom(); persist(); });
  on('lfBgColor','input', e=>{ l.bgColor=e.target.value; markCustom(); persist(); });
  on('lfBgColor2','input', e=>{ l.bgColor2=e.target.value; markCustom(); persist(); });
  on('lfBgOpacity','input', e=>{ l.bgOpacity=parseFloat(e.target.value); markCustom(); persist(); });
  on('lfBgImage','input', e=>{ l.bgImage=e.target.value; markCustom(); persist(); });
  on('lfDir','change', e=>{ l.direction=e.target.value; markCustom(); persist(); });
  on('lfAlign','change', e=>{ l.align=e.target.value; markCustom(); persist(); });
  on('lfMax','input', e=>{ l.maxMessages=parseInt(e.target.value)||20; markCustom(); persist(); });
  on('lfWidth','input', e=>{ l.width=parseInt(e.target.value)||460; markCustom(); persist(); });
  on('lfGap','input', e=>{ l.gap=parseInt(e.target.value)||8; markCustom(); persist(); });
  on('lfPad','input', e=>{ l.padding=parseInt(e.target.value)||10; markCustom(); persist(); });
  on('lfFade','change', e=>{ l.autoFade=e.target.checked; markCustom(); persist(); });
  on('lfFadeSecs','input', e=>{ l.fadeAfter=parseInt(e.target.value)||20; markCustom(); persist(); });
  on('lfAnim','change', e=>{ l.animIn=e.target.value; markCustom(); persist(); rebuildLayoutSection(); });
  on('lfAnimDir','change', e=>{ l.animInDir=e.target.value; markCustom(); persist(); });
  on('lfTimestamp','change', e=>{ l.showTimestamp=e.target.checked; markCustom(); persist(); });
  on('lfBadges','change', e=>{ l.showBadgeIcons=e.target.checked; markCustom(); persist(); });
  on('lfEmotes','change', e=>{ l.showEmotes=e.target.checked; markCustom(); persist(); });
}

// ── Role styles ────────────────────────────────────────────────────────────
function roleSectionHtml(){
  const r = cfg.roles[activeRole];
  return `
  <div class="row" style="flex-wrap:wrap;gap:6px;margin-bottom:12px">
    ${ROLE_KEYS.map(k=>`<button class="btn-sm chRoleBtn ${k===activeRole?'btn-gold':'btn-ghost'}" data-role="${k}">${ROLE_LABELS[k]}</button>`).join('')}
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
    <div style="align-self:end">${checkInput('rfUserAuto', r.usernameColor==='auto', "Use viewer's Twitch name colour")}</div>
    ${field('Username colour (if not auto)', colorInput('rfUserColor', r.usernameColor==='auto'?'#ffc83d':r.usernameColor))}
    ${field('Message text colour', colorInput('rfTextColor', r.textColor))}
    ${field('Bubble background', colorInput('rfBgColor', r.bgColor))}
    ${field('Background opacity', numInput('rfBgOpacity', r.bgOpacity, 0, 1, .05))}
    ${field('Border colour', colorInput('rfBorderColor', r.borderColor))}
    ${field('Border width (px)', numInput('rfBorderWidth', r.borderWidth, 0, 8, 1))}
    ${field('Shape', selectInput('rfShape', SHAPES.map(s=>({v:s,l:SHAPE_LABELS[s]})), r.shape))}
    ${field('Font', selectInput('rfFont', GOOGLE_FONTS.map(f=>({v:f,l:f})), r.font))}
    ${field('Font size (px)', numInput('rfFontSize', r.fontSize, 10, 32, 1))}
    ${field('Font weight', selectInput('rfFontWeight', FONT_WEIGHTS, r.fontWeight))}
    <div style="align-self:end">${checkInput('rfItalic', r.italic, 'Italic')}</div>
  </div>
  <div class="row mt" style="gap:14px;flex-wrap:wrap;align-items:center">
    ${checkInput('rfGlow', r.glow, 'Glow')}
    ${field('Glow colour', colorInput('rfGlowColor', r.glowColor))}
    ${field('Glow size', numInput('rfGlowSize', r.glowSize, 0, 40, 1))}
  </div>
  <div class="row mt" style="gap:14px;flex-wrap:wrap;align-items:center">
    ${checkInput('rfBadge', r.badge, 'Show badge icon')}
    ${field('Badge icon (emoji or text)', `<input type="text" id="rfBadgeIcon" value="${esc(r.badgeIcon||'')}" style="width:70px">`)}
    ${field('Custom image (overrides text)', `<span class="row" style="gap:6px;align-items:center">
      ${r.badgeImage?`<img src="${r.badgeImage}" style="height:24px;width:24px;object-fit:contain;border-radius:4px;background:rgba(255,255,255,.08)">`:''}
      <button class="btn-sm btn-ghost" id="rfBadgeImgPick">${r.badgeImage?'Change…':'Pick image…'}</button>
      ${r.badgeImage?`<button class="btn-sm btn-ghost" id="rfBadgeImgClear" title="Remove custom image">✕</button>`:''}
    </span>`)}
  </div>
  <div class="hint">Badge image: square PNG with transparency works best: <b>64×64 to 128×128 px, under 100&nbsp;KB</b> (hard cap 300&nbsp;KB). It renders at chat-text height (~18&nbsp;px), so bigger files just waste space.</div>`;
}
function rebuildRoleSection(){
  const el = $('chRoleSection'); if(!el) return;
  el.innerHTML = roleSectionHtml();
  wireRoleSection();
}
function wireRoleSection(){
  const r = cfg.roles[activeRole];
  document.querySelectorAll('.chRoleBtn').forEach(btn=>{
    btn.addEventListener('click', ()=>{ activeRole=btn.dataset.role; rebuildRoleSection(); });
  });
  const userColorInput = $('rfUserColor');
  if(userColorInput) userColorInput.disabled = r.usernameColor==='auto';
  on('rfUserAuto','change', e=>{
    r.usernameColor = e.target.checked ? 'auto' : ($('rfUserColor')?.value||'#ffc83d');
    if(userColorInput) userColorInput.disabled = e.target.checked;
    markCustom(); persist();
  });
  on('rfUserColor','input', e=>{ if(!$('rfUserAuto').checked){ r.usernameColor=e.target.value; markCustom(); persist(); } });
  on('rfTextColor','input', e=>{ r.textColor=e.target.value; markCustom(); persist(); });
  on('rfBgColor','input', e=>{ r.bgColor=e.target.value; markCustom(); persist(); });
  on('rfBgOpacity','input', e=>{ r.bgOpacity=parseFloat(e.target.value); markCustom(); persist(); });
  on('rfBorderColor','input', e=>{ r.borderColor=e.target.value; markCustom(); persist(); });
  on('rfBorderWidth','input', e=>{ r.borderWidth=parseInt(e.target.value)||0; markCustom(); persist(); });
  on('rfShape','change', e=>{ r.shape=e.target.value; markCustom(); persist(); });
  on('rfFont','change', e=>{ r.font=e.target.value; markCustom(); persist(); });
  on('rfFontSize','input', e=>{ r.fontSize=parseInt(e.target.value)||15; markCustom(); persist(); });
  on('rfFontWeight','change', e=>{ r.fontWeight=parseInt(e.target.value)||600; markCustom(); persist(); });
  on('rfItalic','change', e=>{ r.italic=e.target.checked; markCustom(); persist(); });
  on('rfGlow','change', e=>{ r.glow=e.target.checked; markCustom(); persist(); });
  on('rfGlowColor','input', e=>{ r.glowColor=e.target.value; markCustom(); persist(); });
  on('rfGlowSize','input', e=>{ r.glowSize=parseInt(e.target.value)||0; markCustom(); persist(); });
  on('rfBadge','change', e=>{ r.badge=e.target.checked; markCustom(); persist(); });
  on('rfBadgeIcon','input', e=>{ r.badgeIcon=e.target.value; markCustom(); persist(); });
  on('rfBadgeImgPick','click', async()=>{
    try{
      const f = await dialog.open({ multiple:false, filters:[{name:'Images',extensions:['png','jpg','jpeg','gif','webp']}] });
      if(!f) return;
      const bytes = await window.__TAURI__.fs.readFile(f);
      if(bytes.length > 300*1024){
        alert('That image is '+Math.round(bytes.length/1024)+' KB, which is too big for a chat badge.\n\nRecommended: square PNG, 64×64 to 128×128 px, under 100 KB (max 300 KB).');
        return;
      }
      let bin = '';
      for(let i=0;i<bytes.length;i+=32768) bin += String.fromCharCode.apply(null, bytes.subarray(i, i+32768));
      const ext  = (f.split('.').pop()||'png').toLowerCase();
      const mime = ext==='jpg'||ext==='jpeg' ? 'image/jpeg' : ext==='gif' ? 'image/gif' : ext==='webp' ? 'image/webp' : 'image/png';
      r.badgeImage = 'data:'+mime+';base64,'+btoa(bin);
      r.badge = true;
      markCustom(); persist(); rebuildRoleSection();
    }catch(e){ alert('Could not load image: '+(e&&e.message)); }
  });
  on('rfBadgeImgClear','click', ()=>{ r.badgeImage=''; markCustom(); persist(); rebuildRoleSection(); });
}

// ── Follow / Sub alerts ─────────────────────────────────────────────────────
function alertCardHtml(kind, prefix){
  const a = cfg.alerts[kind];
  return `<div class="card" id="${prefix}Card">
    <h2>${kind==='follow'?'Follow Alert':'Subscription Alert'}</h2>
    ${checkInput(prefix+'En', a.enabled!==false, 'Enabled, shows inline in the chat feed')}
    <label class="mt">Message template</label>
    <input type="text" id="${prefix}Text" value="${esc(a.text||'')}">
    <div class="hint">Use {name} for the viewer's display name.</div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;margin-top:10px">
      ${field('Icon', `<input type="text" id="${prefix}Icon" value="${esc(a.icon||'')}" style="width:60px">`)}
      ${field('Background', colorInput(prefix+'Bg', a.bgColor))}
      ${field('Text colour', colorInput(prefix+'Txt', a.textColor))}
      ${field('Shape', selectInput(prefix+'Shape', SHAPES.filter(s=>s!=='none').map(s=>({v:s,l:SHAPE_LABELS[s]})), a.shape))}
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;margin-top:10px">
      ${field('Font', selectInput(prefix+'Font', GOOGLE_FONTS.map(f=>({v:f,l:f})), a.font))}
      ${field('Font size', numInput(prefix+'Fs', a.fontSize, 10, 32, 1))}
      ${field('Font weight', selectInput(prefix+'Fw', FONT_WEIGHTS, a.fontWeight))}
      ${field('Duration (sec)', numInput(prefix+'Dur', a.duration, 1, 60, 1))}
    </div>
    <div class="row mt" style="gap:14px;flex-wrap:wrap;align-items:center">
      ${checkInput(prefix+'Glow', a.glow, 'Glow')}
      ${field('Glow colour', colorInput(prefix+'GlowColor', a.glowColor))}
      ${field('Glow size', numInput(prefix+'GlowSize', a.glowSize, 0, 40, 1))}
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px">
      ${field('Entry animation', selectInput(prefix+'Anim', ANIMS.map(x=>({v:x,l:ANIM_LABELS[x]})), a.animIn))}
      ${a.animIn==='slide' ? field('Entry direction', selectInput(prefix+'Dir', DIRS.map(x=>({v:x,l:x[0].toUpperCase()+x.slice(1)})), a.animInDir)) : ''}
    </div>
    <div class="row mt"><button class="btn-sm" id="${prefix}PickSfx">SFX…</button><span id="${prefix}SfxName" class="hint">${a.sound?a.sound.split(/[\\/]/).pop():'No file'}</span><button class="btn-sm btn-ghost" id="${prefix}ClearSfx">Clear</button></div>
  </div>`;
}
function rebuildAlertCard(kind, prefix){
  const card = $(prefix+'Card'); if(!card) return;
  card.outerHTML = alertCardHtml(kind, prefix);
  wireAlertCard(kind, prefix);
}
function wireAlertCard(kind, prefix){
  const a = cfg.alerts[kind];
  on(prefix+'En','change', e=>{ a.enabled=e.target.checked; markCustom(); persist(); });
  on(prefix+'Text','input', e=>{ a.text=e.target.value; markCustom(); persist(); });
  on(prefix+'Icon','input', e=>{ a.icon=e.target.value; markCustom(); persist(); });
  on(prefix+'Bg','input', e=>{ a.bgColor=e.target.value; markCustom(); persist(); });
  on(prefix+'Txt','input', e=>{ a.textColor=e.target.value; markCustom(); persist(); });
  on(prefix+'Shape','change', e=>{ a.shape=e.target.value; markCustom(); persist(); });
  on(prefix+'Font','change', e=>{ a.font=e.target.value; markCustom(); persist(); });
  on(prefix+'Fs','input', e=>{ a.fontSize=parseInt(e.target.value)||16; markCustom(); persist(); });
  on(prefix+'Fw','change', e=>{ a.fontWeight=parseInt(e.target.value)||800; markCustom(); persist(); });
  on(prefix+'Dur','input', e=>{ a.duration=parseInt(e.target.value)||6; markCustom(); persist(); });
  on(prefix+'Glow','change', e=>{ a.glow=e.target.checked; markCustom(); persist(); });
  on(prefix+'GlowColor','input', e=>{ a.glowColor=e.target.value; markCustom(); persist(); });
  on(prefix+'GlowSize','input', e=>{ a.glowSize=parseInt(e.target.value)||0; markCustom(); persist(); });
  on(prefix+'Anim','change', e=>{ a.animIn=e.target.value; markCustom(); persist(); rebuildAlertCard(kind, prefix); });
  on(prefix+'Dir','change', e=>{ a.animInDir=e.target.value; markCustom(); persist(); });
  on(prefix+'PickSfx','click', async()=>{
    const f=await dialog.open({multiple:false,filters:[{name:'Audio',extensions:['mp3','wav','ogg','m4a']}]});
    if(f){ a.sound=f; $(prefix+'SfxName').textContent=f.split(/[\\/]/).pop(); markCustom(); persist(); }
  });
  on(prefix+'ClearSfx','click', ()=>{ a.sound=null; $(prefix+'SfxName').textContent='No file'; markCustom(); persist(); });
}

// ── Live chat log (in-app, verification + quick-ignore) ────────────────────
function renderLiveLog(){
  const el = $('chLiveLog'); if(!el) return;
  const count = $('chLiveCount'); if(count) count.textContent = liveLog.length;
  if(!liveLog.length){ el.innerHTML='<div class="hint">Waiting for chat…</div>'; return; }
  el.innerHTML = liveLog.slice().reverse().map(m=>`
    <div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--row-line);font-size:.82rem;${m.ignored?'opacity:.4':''}">
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><b>${esc(m.display)}</b>: ${esc(m.message)}</span>
      ${m.ignored?'<span class="tag">ignored</span>':`<button class="btn-sm btn-ghost" data-ignoreuser="${esc(m.username)}" style="padding:2px 6px;font-size:.7rem">Ignore</button>`}
    </div>`).join('');
  el.querySelectorAll('[data-ignoreuser]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      addIgnore(btn.dataset.ignoreuser); // global list — fires spark-ignorelist, which re-renders the log
    });
  });
}

// ── Assemble left column ────────────────────────────────────────────────────
function buildLeft(){
  const el = $('chatLeft'); if(!el) return;
  el.innerHTML = `
    ${presetPickerHtml()}
    <div class="card">
      <h2>Layout &amp; Background</h2>
      <div id="chLayoutSection">${layoutSectionHtml()}</div>
    </div>
    <div class="card">
      <h2>Role Styles</h2>
      <div id="chRoleSection">${roleSectionHtml()}</div>
    </div>
    ${alertCardHtml('follow','afFollow')}
    ${alertCardHtml('sub','afSub')}
    <div class="card" style="margin-bottom:60px">
      <h2>Live Chat <span class="tag" id="chLiveCount">0</span></h2>
      <div class="hint">Recent messages from Twitch chat. Click Ignore to add a username to the global ignore list (Settings tab).</div>
      <div id="chLiveLog" style="max-height:220px;overflow-y:auto;margin-top:8px"></div>
    </div>
  `;
  wirePresetPicker();
  wireLayoutSection();
  wireRoleSection();
  wireAlertCard('follow','afFollow');
  wireAlertCard('sub','afSub');
  renderLiveLog();
  renderOverlayBar('chOverlayMode','chOverlayUrl','chCopyUrl','chat',store.overlayUrls);
}

// ── Twitch wiring ────────────────────────────────────────────────────────────
function playSfx(path){
  playAudioFile(path);
}

async function chatHandler(e){
  const d = e.detail;
  const uname = lower(d.username);
  const ignored = isIgnored(uname);
  liveLog.push({ username:d.username, display:d.display||d.username, message:d.message, ignored });
  if(liveLog.length>30) liveLog = liveLog.slice(-30); // keep the log light — last 30 only
  renderLiveLog();
  if(ignored) return;
  // Forward IMMEDIATELY — never await an API call here, or messages can reach
  // the overlay out of order. Follower status comes from the persistent cache;
  // on a miss we forward with the default style and warm the cache in the
  // background, so only a viewer's very first message ever is unstyled.
  const elevated = d.is_broadcaster || d.is_mod || d.is_vip || d.is_sub;
  let isFollower = false;
  if(!elevated){
    const c = cachedFollower(d.user_id);
    if(c !== undefined) isFollower = c;
    else checkFollower(d.user_id); // fire-and-forget — styles their next message
  }
  invoke('chat_overlay_message', { event: {
    type:'message', username:d.username, display:d.display, message:d.message,
    is_mod:d.is_mod, is_sub:d.is_sub, is_vip:d.is_vip, is_broadcaster:d.is_broadcaster,
    is_follower:isFollower, color:d.color, emotes:d.emotes||'',
  }});
}

function goalHandler(e){
  const d = e.detail;
  if(d.kind==='follow'){
    // New follower — flip the cache immediately so their chat
    // styling updates without waiting for a fresh API check
    if(d.user_id) setCachedFollower(d.user_id, true);
    if(cfg.alerts.follow.enabled===false) return;
    invoke('chat_overlay_alert', { event:{ type:'alert', kind:'follow', name:d.user_name } });
    playSfx(cfg.alerts.follow.sound);
  } else if(d.kind==='sub'){
    if(cfg.alerts.sub.enabled===false) return;
    invoke('chat_overlay_alert', { event:{ type:'alert', kind:'sub', name:d.user_name } });
    playSfx(cfg.alerts.sub.sound);
  } else if(d.kind==='bits'){
    // Cheers → D.I.Y alert widgets (the Chat overlay ignores unknown kinds).
    invoke('chat_overlay_alert', { event:{ type:'alert', kind:'cheer', name:d.user_name, amount:d.amount } });
  } else if(d.kind==='raid'){
    invoke('chat_overlay_alert', { event:{ type:'alert', kind:'raid', name:d.user_name, amount:d.amount } });
  }
}

async function fetchEmotes(){
  if(!store.twitch.userId) return;
  try{
    const [ch, gl] = await Promise.all([
      invoke('twitch_get_channel_emotes', { broadcasterId: store.twitch.userId }).catch(()=>({emotes:[]})),
      invoke('twitch_get_global_emotes').catch(()=>({emotes:[]})),
    ]);
    const merged = [...(gl.emotes||[]), ...(ch.emotes||[])].filter(e=>e.name && e.url);
    invoke('chat_overlay_emotes', { emotes: merged });
  }catch(e){}
}

// ── Init ─────────────────────────────────────────────────────────────────────
export async function initChat(){
  const saved = store.chat || {};
  cfg = deepMerge(defaultCfg(), saved);
  // The real ignore list lives in Settings (store.settings.ignoreList). This
  // field is held empty so saves do not reintroduce a per-tab list.
  cfg.ignoreList = [];

  // Re-flag the live log when the global list changes (quick-ignore, Settings edit)
  window.addEventListener('spark-ignorelist', ()=>{
    liveLog.forEach(m=>{ m.ignored = isIgnored(m.username); });
    renderLiveLog();
  });
  if(!cfg.preset) cfg.preset = 'Custom';
  if(!cfg.customPresets || typeof cfg.customPresets !== 'object') cfg.customPresets = saved.customPresets || {};

  buildLeft();

  const frame = $('chatPreviewFrame');
  const urls = store.overlayUrls||{};
  // Demo (looping showcase of every role + alerts) vs Live (real chat, exactly
  // what the OBS browser source shows). Demo is the default.
  function setPreviewMode(demo){
    if(frame && urls.chat) frame.src = urls.chat + (demo ? '?demo=1' : '');
    const db=$('chPrevDemo'), lb=$('chPrevLive');
    if(db){ db.classList.toggle('btn-gold', demo);  db.classList.toggle('btn-ghost', !demo); }
    if(lb){ lb.classList.toggle('btn-gold', !demo); lb.classList.toggle('btn-ghost', demo); }
  }
  $('chPrevDemo')?.addEventListener('click', ()=>setPreviewMode(true));
  $('chPrevLive')?.addEventListener('click', ()=>setPreviewMode(false));
  setPreviewMode(true);

  pushNow(); // seed the overlay snapshot so a freshly opened browser source shows current styling immediately

  if(store.twitch.connected) fetchEmotes();
  window.addEventListener('spark-twitch-status', e=>{ if(e.detail?.connected) fetchEmotes(); });
  window.addEventListener('spark-chat', chatHandler);
  window.addEventListener('spark-goal', goalHandler);
}
