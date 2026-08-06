import { store, toolEnabled, toolBlocked } from './store.js';
import { $, esc, renderOverlayBar } from './utils.js';
import { drawGoalBar, loadGoogleFont } from './bar-renderer.js';
import { playSound as playAudioFile } from './audio.js';

const { invoke } = window.__TAURI__.core;
const dialog = window.__TAURI__.dialog;

// ── Preview dimensions (fixed in-app, actual size only matters for overlay) ──
const PREV_H = { h: 400, v: 80  }; // horizontal preview width, vertical preview width
const PREV_W = { h: 80,  v: 300 }; // horizontal preview height, vertical preview height

const GOOGLE_FONTS = ['Segoe UI','Roboto','Oswald','Bebas Neue','Montserrat','Orbitron','Press Start 2P','Rajdhani'];
const DEFAULT_EMOJIS = ['🎉','🎊','✨','🥳','⭐','🎈','🎆','🎇'];

// Themes: each has bgColor, borderColor, fillColor, fillColor2, textColor
const THEMES = {
  'Gold':    { bgColor:'#1a1230', borderColor:'#ffc83d', fillColor:'#ffc83d', fillColor2:'#ff9f43', textColor:'#ffffff' },
  'Neon Green': { bgColor:'#0d1a0d', borderColor:'#3ddc97', fillColor:'#3ddc97', fillColor2:'#00ff88', textColor:'var(--ok-ink)' },
  'Twitch':  { bgColor:'#1a0d2e', borderColor:'#9146ff', fillColor:'#9146ff', fillColor2:'#bf94ff', textColor:'#ffffff' },
  'Ocean':   { bgColor:'#0a1628', borderColor:'#4cc3ff', fillColor:'#0096c7', fillColor2:'#4cc3ff', textColor:'#90e0ef' },
  'Sunset':  { bgColor:'#1a0d0d', borderColor:'#ff5d73', fillColor:'#ff5d73', fillColor2:'#ffc83d', textColor:'#ffffff' },
  'Mono':    { bgColor:'#111111', borderColor:'#ffffff', fillColor:'#ffffff', fillColor2:'#aaaaaa', textColor:'#ffffff' },
  'Custom':  null,
};

let bars = [];
let saveTimer = null;
function uid(){ return Math.random().toString(36).slice(2,10); }

// ── Persist ───────────────────────────────────────────────────────────────────
function persist(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(()=>{ invoke('save_goals',{data:{bars}}); }, 200);
  pushOverlay();
}

function pushOverlay(){
  invoke('goals_overlay_update',{ goals: bars.map(b=>({
    id:b.id, name:b.name, current:b.current,
    milestones:b.milestones, currentMilestone:b.currentMilestone,
    orientation:b.orientation, style:b.style,
    bgColor:b.bgColor, borderColor:b.borderColor,
    fillColor:b.fillColor, fillColor2:b.fillColor2,
    textColor:b.textColor, font:b.font,
    width:b.width, height:b.height,
    showLabel:b.showLabel, showCurrent:b.showCurrent,
    showTarget:b.showTarget, showPct:b.showPct,
    textOutside:b.textOutside, active:b.active, source:b.source,
  }))});
}

// ── Drawing helpers ───────────────────────────────────────────────────────────
// Always draw at a fixed PREVIEW size in-app
function drawBar(canvas, bar, preview){
  const isV = bar.orientation==='v';
  if(preview){
    canvas.width  = isV ? 70  : 360;
    canvas.height = isV ? 220 : 72;
  } else {
    canvas.width  = isV ? (bar.height||80)  : (bar.width||400);
    canvas.height = isV ? (bar.width||300)  : (bar.height||80);
  }
  drawGoalBar(canvas.getContext('2d'), canvas.width, canvas.height, bar);
  // Lock display size to canvas pixel size so browser never upscales
  canvas.style.width  = canvas.width  + 'px';
  canvas.style.height = canvas.height + 'px';
}

// ── Progress ──────────────────────────────────────────────────────────────────
function addProgress(bar, amount){
  bar.current = (bar.current||0) + amount;
  // A single big jump (e.g. a huge cheer) can cross several milestones —
  // advance through every one it clears, celebrating once.
  let ms = bar.milestones[bar.currentMilestone];
  if(ms && bar.current >= ms.target){
    celebrate(bar);
    while(bar.currentMilestone < bar.milestones.length-1
          && bar.current >= bar.milestones[bar.currentMilestone].target){
      bar.currentMilestone++;
    }
  }
  refreshBar(bar);
  persist();
}

// Commands tab: "Trigger a SPARK tool" -> Goals.
window.addEventListener('spark-action', e => {
  const d = e.detail || {};
  if(d.tool !== 'goals' || !toolEnabled('goals')) return;
  const want = String(d.target || '').toLowerCase();
  const bar = want ? bars.find(b => String(b.name||'').toLowerCase() === want) : bars[0];
  if(!bar) return;
  if(d.action === 'add') addProgress(bar, Number.isFinite(d.amount) ? d.amount : 0);
});

function celebrate(bar){
  if(bar.celebSound) playAudioFile(bar.celebSound);
  invoke('goals_overlay_update',{ goals: bars.map(b=>b.id===bar.id?{...b,_celebrate:true,_emojis:bar._emojis||DEFAULT_EMOJIS}:b)});
  setTimeout(()=>pushOverlay(), 5000);
}

// ── Twitch ────────────────────────────────────────────────────────────────────
window.addEventListener('spark-goal', e=>{
  if(!toolEnabled('goals')) return;
  const d=e.detail;
  bars.forEach(bar=>{
    if(!bar.active) return;
    if(bar.source==='follower' && d.kind==='follow') addProgress(bar, d.amount||1);
    if(bar.source==='sub'      && d.kind==='sub')    addProgress(bar, d.amount||1);
    if(bar.source==='bits'     && d.kind==='bits')   addProgress(bar, d.amount||0);
  });
});
window.addEventListener('spark-chat', e=>{
  const d=e.detail;
  if(!d.is_mod&&!d.is_broadcaster) return;
  const msg=(d.message||'').trim();
  if(!msg.startsWith('!')) return;
  const parts=msg.slice(1).split(' ');
  if(parts.length<2) return;
  const cmd=parts[0].toLowerCase(), amount=parseFloat(parts[1]);
  if(isNaN(amount)) return;
  const anyMatch=bars.some(bar=>bar.source==='custom'&&bar.name.toLowerCase().replace(/\s/g,'')===cmd);
  if(!anyMatch) return;
  if(toolBlocked('goals', d.display||d.username)) return;
  bars.forEach(bar=>{
    if(bar.source==='custom'&&bar.name.toLowerCase().replace(/\s/g,'')===cmd) addProgress(bar,amount);
  });
});

async function fetchFollowerCount(bar, statusEl){
  if(!store.twitch.userId){ if(statusEl) statusEl.textContent='Connect Twitch first.'; return; }
  if(statusEl) statusEl.textContent='Fetching...';
  try{
    const n=await invoke('twitch_get_follower_count',{broadcasterId:store.twitch.userId});
    bar.current=n; refreshBar(bar); persist();
    if(statusEl) statusEl.textContent='Fetched: '+n;
  }catch(e){ if(statusEl) statusEl.textContent='Error: '+String(e); }
}

async function fetchEmotes(bar){
  if(!store.twitch.userId) return;
  try{
    const r=await invoke('twitch_get_channel_emotes',{broadcasterId:store.twitch.userId});
    if(r.emotes?.length) bar._emojis=r.emotes.map(e=>e.url).filter(Boolean);
  }catch(e){}
}

// ── Render bar card ───────────────────────────────────────────────────────────
function refreshBar(bar){
  // mini canvas in card
  const mc=document.getElementById('bm-'+bar.id);
  if(mc) drawBar(mc, bar, true);
  // right column preview
  const pc=document.getElementById('bp-'+bar.id);
  if(pc) drawBar(pc, bar, true);
  // update manual input
  const mi=document.getElementById('bi-'+bar.id);
  if(mi) mi.value=Math.floor(bar.current||0);
}

function renderBarList(){
  const el=$('goalBarList'); if(!el) return;
  if(!bars.length){ el.innerHTML='<div class="hint">No goal bars yet.</div>'; return; }
  el.innerHTML=bars.map(barCardHtml).join('');
  bars.forEach(bar=>{ loadGoogleFont(bar.font); refreshBar(bar); wireCard(bar); });
}

function barCardHtml(bar){
  const ms=bar.milestones[bar.currentMilestone]||{target:100,label:''};
  const isV=bar.orientation==='v';
  return `<div class="goal-card" id="bc-${bar.id}">
    <div class="goal-card-header">
      <span class="goal-name">${esc(bar.name)}</span>
      <span class="tag">${bar.source}</span>
      <label class="checkrow" style="margin:0;flex-shrink:0"><input type="checkbox" class="ba" data-id="${bar.id}" ${bar.active?'checked':''}> On</label>
      <button class="btn-sm btn-ghost" data-edit="${bar.id}">Edit</button>
      <button class="btn-sm del" data-del="${bar.id}">Remove</button>
    </div>
    <canvas id="bm-${bar.id}" style="border-radius:8px;display:block;margin-top:8px;width:${isV?'35px':'180px'};height:${isV?'110px':'36px'}"></canvas>
    <div style="font-size:.75rem;color:var(--muted);margin-top:5px">${Math.floor(bar.current||0)} / ${ms.target}${ms.label?' ('+esc(ms.label)+')':''} ${bar.currentMilestone<bar.milestones.length-1?'<span class="tag">Milestone '+(bar.currentMilestone+1)+'/'+bar.milestones.length+'</span>':''}</div>
    ${bar.source==='custom'?`<div class="hint">Chat: <code>!${bar.name.toLowerCase().replace(/\s/g,'')}</code></div>`:''}
    <div class="row mt" style="gap:6px">
      <span style="font-size:.78rem;color:var(--muted);flex-shrink:0">Manual:</span>
      <input id="bi-${bar.id}" type="number" value="${Math.floor(bar.current||0)}" style="width:85px">
      <button class="btn-sm" data-set="${bar.id}">Set</button>
      ${bar.source==='follower'?`<button class="btn-sm btn-ghost" data-fetch="${bar.id}">Fetch</button>`:''}
    </div>
    <div id="bs-${bar.id}" class="hint" style="min-height:14px"></div>
  </div>`;
}

function wireCard(bar){
  const card=document.getElementById('bc-'+bar.id); if(!card) return;
  card.querySelector('.ba')?.addEventListener('change',e=>{ bar.active=e.target.checked; refreshBar(bar); persist(); });
  card.querySelector('[data-del]')?.addEventListener('click',()=>{ bars=bars.filter(b=>b.id!==bar.id); renderBarList(); renderRightPreview(); persist(); });
  card.querySelector('[data-edit]')?.addEventListener('click',()=>openEditor(bar));
  card.querySelector('[data-set]')?.addEventListener('click',()=>{
    const v=parseFloat(document.getElementById('bi-'+bar.id)?.value)||0;
    bar.current=v; refreshBar(bar); renderRightPreview(); persist();
  });
  card.querySelector('[data-fetch]')?.addEventListener('click',()=>{
    fetchFollowerCount(bar, document.getElementById('bs-'+bar.id));
  });
}

// ── Right column preview ──────────────────────────────────────────────────────
function renderRightPreview(){
  const el=$('goPreview'); if(!el) return;
  const active=bars.filter(b=>b.active);
  if(!active.length){ el.innerHTML='<div class="hint">No active goal bars.</div>'; return; }
  el.innerHTML=active.map(b=>{
    const isV=b.orientation==='v';
    // Set CSS width/height to match canvas pixels exactly — no browser scaling
    const cw=isV?70:360, ch=isV?220:72;
    return `<canvas id="bp-${b.id}" width="${cw}" height="${ch}" style="border-radius:10px;display:block;margin-bottom:12px;width:${cw}px;height:${ch}px"></canvas>`;
  }).join('');
  active.forEach(b=>{ loadGoogleFont(b.font); drawBar(document.getElementById('bp-'+b.id), b, true); });
}

// ── Editor modal ──────────────────────────────────────────────────────────────
function openEditor(bar){
  try{
    document.getElementById('goEdModal')?.remove();
    const modal=document.createElement('div');
    modal.id='goEdModal';
    modal.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:9999;display:flex;align-items:center;justify-content:center';

    const themeOpts=Object.keys(THEMES).map(k=>`<option value="${k}" ${(bar._theme||'Custom')===k?'selected':''}>${k}</option>`).join('');
    const fontOpts=GOOGLE_FONTS.map(f=>`<option value="${f}" ${bar.font===f?'selected':''}>${f}</option>`).join('');
    // Work on a draft — milestone edits only land on the bar when Save is
    // clicked, so Cancel/X actually cancels.
    const msDraft=JSON.parse(JSON.stringify(bar.milestones||[]));
    const msHtml=()=>msDraft.map((m,i)=>`
      <div style="display:flex;gap:8px;margin-bottom:6px">
        <input type="number" class="gm-t" data-i="${i}" value="${m.target}" style="width:90px" placeholder="Target">
        <input type="text"   class="gm-l" data-i="${i}" value="${esc(m.label||'')}" style="flex:1" placeholder="Label (optional)">
        <button class="btn-sm btn-ghost gm-d" data-i="${i}">Remove</button>
      </div>`).join('');

    modal.innerHTML=`
    <div style="background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:22px;width:600px;max-height:92vh;overflow-y:auto;position:relative">
      <button id="goEdX" style="position:absolute;top:12px;right:14px;background:none;border:none;color:var(--muted);font-size:1.4rem;cursor:pointer">x</button>
      <div style="font-size:.7rem;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);font-weight:700;margin-bottom:16px">Edit goal bar</div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div><label>Name</label><input id="ge-name" type="text" value="${esc(bar.name||'')}"></div>
        <div><label>Source</label><select id="ge-src">
          <option value="follower" ${bar.source==='follower'?'selected':''}>Followers (total)</option>
          <option value="sub"      ${bar.source==='sub'?'selected':''}>Subs (net new)</option>
          <option value="bits"     ${bar.source==='bits'?'selected':''}>Bits</option>
          <option value="custom"   ${bar.source==='custom'?'selected':''}>Custom (!command)</option>
        </select></div>
        <div><label>Orientation</label><select id="ge-orient">
          <option value="h" ${bar.orientation!=='v'?'selected':''}>Horizontal</option>
          <option value="v" ${bar.orientation==='v'?'selected':''}>Vertical</option>
        </select></div>
        <div><label>Style</label><select id="ge-style">
          <option value="solid"    ${bar.style==='solid'?'selected':''}>Solid</option>
          <option value="gradient" ${bar.style==='gradient'?'selected':''}>Gradient</option>
          <option value="neon"     ${bar.style==='neon'?'selected':''}>Neon Glow</option>
        </select></div>
        <div><label>Font</label><select id="ge-font">${fontOpts}</select></div>
        <div><label>Colour theme</label><select id="ge-theme">${themeOpts}</select></div>
      </div>

      <div id="ge-custom-colours" style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:12px">
        <div><label style="font-size:.72rem">Background</label><input id="ge-bg"     type="color" value="${bar.bgColor||'#1a1230'}" style="width:46px;height:30px;border:none;background:none;cursor:pointer"></div>
        <div><label style="font-size:.72rem">Border</label><input id="ge-border" type="color" value="${bar.borderColor||'var(--line)'}" style="width:46px;height:30px;border:none;background:none;cursor:pointer"></div>
        <div><label style="font-size:.72rem">Fill</label><input id="ge-fill"   type="color" value="${bar.fillColor||'#ffc83d'}" style="width:46px;height:30px;border:none;background:none;cursor:pointer"></div>
        <div><label style="font-size:.72rem">Fill 2</label><input id="ge-fill2"  type="color" value="${bar.fillColor2||'#ff9f43'}" style="width:46px;height:30px;border:none;background:none;cursor:pointer"></div>
        <div><label style="font-size:.72rem">Text</label><input id="ge-text"   type="color" value="${bar.textColor||'#ffffff'}" style="width:46px;height:30px;border:none;background:none;cursor:pointer"></div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div><label>Width (px)</label><input id="ge-w" type="number" value="${bar.width||400}" min="60" max="1200"></div>
        <div><label>Height (px)</label><input id="ge-h" type="number" value="${bar.height||80}" min="20" max="600"></div>
      </div>

      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:12px">
        <label style="display:flex;align-items:center;gap:6px;font-size:.85rem;cursor:pointer"><input type="checkbox" id="ge-lbl" ${bar.showLabel?'checked':''}> Label</label>
        <label style="display:flex;align-items:center;gap:6px;font-size:.85rem;cursor:pointer"><input type="checkbox" id="ge-cur" ${bar.showCurrent?'checked':''}> Current</label>
        <label style="display:flex;align-items:center;gap:6px;font-size:.85rem;cursor:pointer"><input type="checkbox" id="ge-tgt" ${bar.showTarget?'checked':''}> Target</label>
        <label style="display:flex;align-items:center;gap:6px;font-size:.85rem;cursor:pointer"><input type="checkbox" id="ge-pct" ${bar.showPct?'checked':''}> %</label>
        <label style="display:flex;align-items:center;gap:6px;font-size:.85rem;cursor:pointer"><input type="checkbox" id="ge-out" ${bar.textOutside!==false?'checked':''}> Text outside bar</label>
      </div>

      <div style="background:var(--bg);border-radius:10px;padding:12px;margin-bottom:14px;text-align:center">
        <div style="font-size:.7rem;color:var(--muted);margin-bottom:8px;letter-spacing:.1em;text-transform:uppercase">Preview</div>
        <canvas id="ge-prev" style="border-radius:8px;max-width:100%;max-height:200px;display:inline-block"></canvas>
      </div>

      <div style="font-size:.7rem;letter-spacing:.15em;text-transform:uppercase;color:var(--muted);font-weight:700;margin-bottom:8px">Milestones</div>
      <div id="ge-ms">${msHtml()}</div>
      <button class="btn-sm" id="ge-add-ms" style="margin-top:6px;margin-bottom:14px">+ Add Milestone</button>

      <div style="display:flex;gap:8px;align-items:center;margin-bottom:16px">
        <button id="ge-sfx-pick" style="font-family:inherit;cursor:pointer;border:none;border-radius:8px;font-size:.82rem;font-weight:600;padding:7px 12px;color:#fff;background:var(--btn)">SFX...</button>
        <span id="ge-sfx-name" style="font-size:.78rem;color:var(--muted);flex:1">${bar.celebSound?bar.celebSound.split(/[\\/]/).pop():'No file'}</span>
        <button id="ge-sfx-clear" style="font-family:inherit;cursor:pointer;border:1px solid var(--line);border-radius:8px;font-size:.82rem;padding:7px 12px;color:var(--muted);background:transparent">Clear</button>
        <label style="display:flex;align-items:center;gap:6px;font-size:.82rem;cursor:pointer"><input type="checkbox" id="ge-emotes" ${bar.useChannelEmotes?'checked':''}> Channel emotes</label>
      </div>

      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button id="ge-save" style="font-family:inherit;cursor:pointer;border:none;border-radius:8px;font-size:.88rem;font-weight:700;padding:9px 20px;color:#2b1d00;background:#ffc83d">Save</button>
        <button id="ge-cancel" style="font-family:inherit;cursor:pointer;border:1px solid var(--line);border-radius:8px;font-size:.88rem;padding:9px 20px;color:var(--muted);background:transparent">Cancel</button>
      </div>
    </div>`;
    document.body.appendChild(modal);

    let sfxPath=bar.celebSound;

    function getPreviewBar(){
      const th=document.getElementById('ge-theme')?.value;
      const thColours = th && THEMES[th] ? THEMES[th] : {};
      return {
        ...bar,
        name:       document.getElementById('ge-name')?.value||bar.name,
        source:     document.getElementById('ge-src')?.value,
        orientation:document.getElementById('ge-orient')?.value,
        style:      document.getElementById('ge-style')?.value,
        font:       document.getElementById('ge-font')?.value,
        bgColor:    thColours.bgColor    || document.getElementById('ge-bg')?.value,
        borderColor:thColours.borderColor|| document.getElementById('ge-border')?.value,
        fillColor:  thColours.fillColor  || document.getElementById('ge-fill')?.value,
        fillColor2: thColours.fillColor2 || document.getElementById('ge-fill2')?.value,
        textColor:  thColours.textColor  || document.getElementById('ge-text')?.value,
        showLabel:  document.getElementById('ge-lbl')?.checked,
        showCurrent:document.getElementById('ge-cur')?.checked,
        showTarget: document.getElementById('ge-tgt')?.checked,
        showPct:    document.getElementById('ge-pct')?.checked,
        textOutside:document.getElementById('ge-out')?.checked ?? true,
        milestones: msDraft,
        currentMilestone: Math.max(0, Math.min(bar.currentMilestone, msDraft.length-1)),
      };
    }

    function updateCustomColourVisibility(){
      const th=document.getElementById('ge-theme')?.value;
      const cc=document.getElementById('ge-custom-colours');
      if(cc) cc.style.display=(th==='Custom')?'grid':'none';
    }

    function livePreview(){
      const canvas=document.getElementById('ge-prev'); if(!canvas) return;
      const pb=getPreviewBar();
      loadGoogleFont(pb.font);
      const isV=pb.orientation==='v';
      canvas.width  = isV ? 80  : 380;
      canvas.height = isV ? 240 : 80;
      drawGoalBar(canvas.getContext('2d'), canvas.width, canvas.height, pb);
    }

    function renderMilestones(){
      const el=document.getElementById('ge-ms'); if(!el) return;
      el.innerHTML=msDraft.map((m,i)=>`
        <div style="display:flex;gap:8px;margin-bottom:6px">
          <input type="number" class="gm-t" data-i="${i}" value="${m.target}" style="width:90px" placeholder="Target">
          <input type="text"   class="gm-l" data-i="${i}" value="${esc(m.label||'')}" style="flex:1" placeholder="Label (optional)">
          <button class="btn-sm btn-ghost gm-d" data-i="${i}">Remove</button>
        </div>`).join('');
      el.querySelectorAll('.gm-t').forEach(inp=>inp.addEventListener('input',e=>{ msDraft[+e.target.dataset.i].target=+e.target.value||0; livePreview(); }));
      el.querySelectorAll('.gm-l').forEach(inp=>inp.addEventListener('input',e=>{ msDraft[+e.target.dataset.i].label=e.target.value; }));
      el.querySelectorAll('.gm-d').forEach(btn=>btn.addEventListener('click',e=>{ msDraft.splice(+e.target.dataset.i,1); renderMilestones(); livePreview(); }));
    }
    renderMilestones();

    // Wire live preview on all changes
    ['ge-name','ge-src','ge-orient','ge-style','ge-font','ge-theme','ge-bg','ge-border','ge-fill','ge-fill2','ge-text','ge-w','ge-h','ge-lbl','ge-cur','ge-tgt','ge-pct','ge-out'].forEach(id=>{
      document.getElementById(id)?.addEventListener('input',livePreview);
      document.getElementById(id)?.addEventListener('change',()=>{ updateCustomColourVisibility(); livePreview(); });
    });
    updateCustomColourVisibility();
    setTimeout(livePreview, 30);

    document.getElementById('ge-add-ms').addEventListener('click',()=>{ msDraft.push({target:0,label:''}); renderMilestones(); });
    document.getElementById('ge-sfx-pick').addEventListener('click',async()=>{
      const f=await dialog.open({multiple:false,filters:[{name:'Audio',extensions:['mp3','wav','ogg','m4a']}]});
      if(f){ sfxPath=f; document.getElementById('ge-sfx-name').textContent=f.split(/[\\/]/).pop(); }
    });
    document.getElementById('ge-sfx-clear').addEventListener('click',()=>{ sfxPath=null; document.getElementById('ge-sfx-name').textContent='No file'; });

    document.getElementById('ge-save').addEventListener('click',()=>{
      const th=document.getElementById('ge-theme')?.value||'Custom';
      const thColours = th&&THEMES[th] ? THEMES[th] : {};
      bar.name         = document.getElementById('ge-name').value.trim()||bar.name;
      bar.source       = document.getElementById('ge-src').value;
      bar.orientation  = document.getElementById('ge-orient').value;
      bar.style        = document.getElementById('ge-style').value;
      bar.font         = document.getElementById('ge-font').value;
      bar._theme       = th;
      bar.bgColor      = thColours.bgColor     || document.getElementById('ge-bg').value;
      bar.borderColor  = thColours.borderColor  || document.getElementById('ge-border').value;
      bar.fillColor    = thColours.fillColor    || document.getElementById('ge-fill').value;
      bar.fillColor2   = thColours.fillColor2   || document.getElementById('ge-fill2').value;
      bar.textColor    = thColours.textColor    || document.getElementById('ge-text').value;
      bar.width        = parseInt(document.getElementById('ge-w').value)||400;
      bar.height       = parseInt(document.getElementById('ge-h').value)||80;
      bar.showLabel    = document.getElementById('ge-lbl').checked;
      bar.showCurrent  = document.getElementById('ge-cur').checked;
      bar.showTarget   = document.getElementById('ge-tgt').checked;
      bar.showPct      = document.getElementById('ge-pct').checked;
      bar.textOutside  = document.getElementById('ge-out').checked;
      bar.celebSound   = sfxPath;
      bar.useChannelEmotes = document.getElementById('ge-emotes').checked;
      bar.milestones   = msDraft.length ? msDraft : [{target:100,label:''}];
      bar.currentMilestone = Math.max(0, Math.min(bar.currentMilestone, bar.milestones.length-1));
      if(bar.useChannelEmotes) fetchEmotes(bar);
      loadGoogleFont(bar.font);
      modal.remove();
      renderBarList();
      renderRightPreview();
      persist();
    });
    document.getElementById('ge-cancel').addEventListener('click',()=>modal.remove());
    document.getElementById('goEdX').addEventListener('click',()=>modal.remove());
    modal.addEventListener('click',e=>{ if(e.target===modal) modal.remove(); });
  }catch(err){ console.error('openEditor error:',err); }
}

// ── Build left column ─────────────────────────────────────────────────────────
function buildLeft(){
  const el=$('goalsLeft'); if(!el) return;
  el.innerHTML=`
  <div class="card">
    <h2>New Goal Bar</h2>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div><label>Name</label><input type="text" id="gn-name" placeholder="Follower Goal"></div>
      <div><label>Source</label><select id="gn-src">
        <option value="follower">Followers (total)</option>
        <option value="sub">Subs (net new)</option>
        <option value="bits">Bits</option>
        <option value="custom">Custom</option>
      </select></div>
      <div><label>First target</label><input type="number" id="gn-target" value="100" min="1"></div>
      <div><label>Orientation</label><select id="gn-orient">
        <option value="h">Horizontal</option>
        <option value="v">Vertical</option>
      </select></div>
    </div>
    <button class="btn-gold full mt" id="gn-create">+ Create Goal Bar</button>
  </div>
  <div class="card" style="margin-bottom:60px">
    <h2>Goal Bars</h2>
    <div id="goalBarList"></div>
  </div>`;

  $('gn-create').addEventListener('click',()=>{
    const name=($('gn-name').value.trim()||'Goal');
    const th=THEMES['Gold'];
    const bar={
      id:uid(), name, source:$('gn-src').value,
      milestones:[{target:parseInt($('gn-target').value)||100, label:''}],
      currentMilestone:0, current:0,
      orientation:$('gn-orient').value,
      style:'solid', _theme:'Gold',
      ...th,
      font:'Segoe UI', width:400, height:80,
      showLabel:true, showCurrent:true, showTarget:true, showPct:false,
      textOutside:true, celebSound:null, useChannelEmotes:false,
      active:true, _emojis:null,
    };
    loadGoogleFont(bar.font);
    if(bar.source==='follower') fetchFollowerCount(bar, null);
    bars.push(bar);
    $('gn-name').value='';
    renderBarList();
    renderRightPreview();
    persist();
  });

  renderOverlayBar('goOverlayMode','goOverlayUrl','goCopyUrl','goals',store.overlayUrls);
  renderBarList();
  renderRightPreview();
}

export async function initGoals(){
  const d=store.goals||{};
  bars=(d.bars||[]).map(b=>({...b,_emojis:null}));
  bars.forEach(b=>{ loadGoogleFont(b.font); if(b.useChannelEmotes) fetchEmotes(b); });
  buildLeft();
  window.addEventListener('spark-twitch-status',e=>{ if(e.detail?.connected) { /* rewards auto-load elsewhere */ } });
}
