import { store, toolBlocked, toolEnabled } from './store.js';
import { $, esc, renderOverlayBar } from './utils.js';
import { fontOptionsHtml } from './fonts.js';

const { invoke } = window.__TAURI__.core;

// ── Themes (same lightweight pattern as the Goals tab) ─────────────────────────
const THEMES = {
  'Gold':       { bgColor:'#1a1230', borderColor:'#ffc83d', textColor:'#ffffff', valueColor:'#ffc83d' },
  'Neon Green': { bgColor:'#0d1a0d', borderColor:'#3ddc97', textColor:'var(--ok-ink)', valueColor:'#3ddc97' },
  'Twitch':     { bgColor:'#1a0d2e', borderColor:'#9146ff', textColor:'#ffffff', valueColor:'#bf94ff' },
  'Ocean':      { bgColor:'#0a1628', borderColor:'#4cc3ff', textColor:'#90e0ef', valueColor:'#4cc3ff' },
  'Sunset':     { bgColor:'#1a0d0d', borderColor:'#ff5d73', textColor:'#ffffff', valueColor:'#ffc83d' },
  'Mono':       { bgColor:'#111111', borderColor:'#ffffff', textColor:'#ffffff', valueColor:'#ffffff' },
  'Custom':     null,
};
// Font list now shared app-wide — see fonts.js.
const SHAPES = [{v:'rounded',l:'Rounded'},{v:'pill',l:'Pill'},{v:'square',l:'Square'},{v:'circle',l:'Circle'},{v:'none',l:'None (text only)'}];
const ANIMS  = [{v:'pop',l:'Pop'},{v:'bounce',l:'Bounce'},{v:'shake',l:'Shake'},{v:'flash',l:'Flash'},{v:'none',l:'None'}];
const PERMS  = [
  { v:'viewer',      l:'Everyone' },
  { v:'follower',    l:'Followers' },
  { v:'sub',         l:'Subscribers' },
  { v:'mod',         l:'Mods only' },
  { v:'broadcaster', l:'Broadcaster only' },
];

// ── State ─────────────────────────────────────────────────────────────────────
let counters = [];
let layout = { direction:'column', align:'flex-start', gap:10 };
let saveTimer = null;

function uid(){ return Math.random().toString(36).slice(2,10); }
function slugCmd(name){ return '!'+(name||'counter').toLowerCase().replace(/[^a-z0-9]+/g,''); }

function newCounter(name){
  const n = name || 'Counter';
  return {
    id: uid(), name: n, value: 0,
    incCmd: slugCmd(n), decCmd: '', resetCmd: '',
    step: 1, min: null, max: null, allowArg: false, maxArg: 10,
    permission: 'viewer', visible: true,
    theme: 'Gold',
    style: {
      shape:'rounded', bgColor:'#1a1230', bgOpacity:.85, borderColor:'#ffc83d', borderWidth:1,
      glow:false, glowColor:'#ffc83d', glowSize:14,
      font:'Segoe UI', fontWeight:700, textColor:'#ffffff', fontSize:14,
      valueColor:'#ffc83d', valueFontSize:30, valueWeight:800,
      template:'{name}\n{value}', animOnChange:'pop',
      width:0, height:0, padding:14,
    },
  };
}

function persist(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(()=>{ invoke('save_counters',{ data:{ counters, layout } }); }, 200);
}
function pushOverlay(){
  invoke('counters_overlay_update', { counters: { layout, counters } });
}

function clampVal(c, v){
  let n = v;
  if(c.min!=null && c.min!=='' && n < c.min) n = c.min;
  if(c.max!=null && c.max!=='' && n > c.max) n = c.max;
  return n;
}
function setValue(c, v){
  c.value = clampVal(c, v);
  persist(); pushOverlay(); refreshCard(c);
}

// ── Twitch command handling ─────────────────────────────────────────────────
async function permitted(tier, d){
  if(d.is_broadcaster) return true;
  if(tier==='broadcaster') return false;
  if(d.is_mod) return true;
  if(tier==='mod') return false;
  if(d.is_sub) return true;
  if(tier==='sub') return false;
  if(tier==='follower'){
    try{ return await invoke('twitch_check_follower', { userId: d.user_id, broadcasterId: store.twitch.userId }); }
    catch(e){ return false; }
  }
  return true; // viewer = everyone
}

window.addEventListener('spark-chat', async e => {
  const d = e.detail;
  const msg = (d.message||'').trim();
  if(!msg) return;
  const parts = msg.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const argRaw = parts[1];

  const match = counters.find(c =>
    (c.incCmd && cmd === c.incCmd.toLowerCase()) ||
    (c.decCmd && cmd === c.decCmd.toLowerCase()) ||
    (c.resetCmd && cmd === c.resetCmd.toLowerCase())
  );
  if(!match) return;
  if(toolBlocked('counters', d.display||d.username)) return;

  if(match.resetCmd && cmd === match.resetCmd.toLowerCase()){
    if(!(d.is_mod || d.is_broadcaster)) return; // reset is always mod+/broadcaster, regardless of permission setting
    setValue(match, 0);
    return;
  }

  if(!(await permitted(match.permission, d))) return;
  const isInc = match.incCmd && cmd === match.incCmd.toLowerCase();
  let delta = (match.step||1) * (isInc ? 1 : -1);
  if(match.allowArg && argRaw != null){
    // Clamp the viewer-typed amount so "!death 999999999" can't nuke the
    // counter — cap is per-counter (default 10).
    const cap = Number.isFinite(match.maxArg) ? match.maxArg : 10;
    const n = parseFloat(argRaw);
    if(isFinite(n) && n >= 0) delta = (isInc ? 1 : -1) * Math.min(n, cap);
  }
  setValue(match, (match.value||0) + delta);
});

// Commands tab: "Trigger a SPARK tool" -> Counters. Lets one command reply in
// chat AND move a counter, which the counter's own command can't do.
window.addEventListener('spark-action', e => {
  const d = e.detail || {};
  if(d.tool !== 'counters' || !toolEnabled('counters')) return;
  const want = String(d.target || '').toLowerCase();
  const c = want ? counters.find(x => String(x.name||'').toLowerCase() === want) : counters[0];
  if(!c) return;
  const amt = Number.isFinite(d.amount) ? d.amount : 0;
  if(d.action === 'add')           setValue(c, (c.value||0) + amt);
  else if(d.action === 'subtract') setValue(c, (c.value||0) - amt);
  else if(d.action === 'set')      setValue(c, amt);
  else if(d.action === 'reset')    setValue(c, 0);
});

// ── Card list (compact) ─────────────────────────────────────────────────────
function counterCardHtml(c){
  const cmds = [c.incCmd && `+ ${c.incCmd}`, c.decCmd && `− ${c.decCmd}`, c.resetCmd && `reset ${c.resetCmd}`].filter(Boolean).join('  ·  ');
  return `<div class="goal-card" id="cnt-${c.id}">
    <div class="goal-card-header">
      <span class="goal-name">${esc(c.name)}</span>
      <span class="tag">${PERMS.find(p=>p.v===c.permission)?.l||'Everyone'}</span>
      <label class="checkrow" style="margin:0;flex-shrink:0"><input type="checkbox" class="cnt-vis" data-id="${c.id}" ${c.visible!==false?'checked':''}> On overlay</label>
      <button class="btn-sm btn-ghost" data-edit="${c.id}">Edit</button>
      <button class="btn-sm del" data-del="${c.id}">Remove</button>
    </div>
    <div class="hint">${cmds || 'No commands set. Edit to add one'}</div>
    <div class="row mt" style="gap:8px;align-items:center">
      <button class="btn-sm mini" data-dec="${c.id}">−</button>
      <span id="cnt-val-${c.id}" style="font-size:1.3rem;font-weight:800;color:var(--gold);min-width:44px;text-align:center">${c.value}</span>
      <button class="btn-sm mini" data-inc="${c.id}">+</button>
      <input type="number" id="cnt-set-${c.id}" value="${c.value}" style="width:80px">
      <button class="btn-sm" data-set="${c.id}">Set</button>
      <button class="btn-sm btn-ghost" data-reset="${c.id}">Reset to 0</button>
    </div>
  </div>`;
}

function refreshCard(c){
  const v = $('cnt-val-'+c.id); if(v) v.textContent = c.value;
  const s = $('cnt-set-'+c.id); if(s) s.value = c.value;
}

function renderList(){
  const el = $('cntList'); if(!el) return;
  if(!counters.length){ el.innerHTML = '<div class="hint">No counters yet. Add one above.</div>'; return; }
  el.innerHTML = counters.map(counterCardHtml).join('');
  wireListEvents();
}

function wireListEvents(){
  const el = $('cntList'); if(!el) return;
  el.querySelectorAll('.cnt-vis').forEach(cb=>{
    cb.addEventListener('change', ()=>{
      const c = counters.find(x=>x.id===cb.dataset.id); if(!c) return;
      c.visible = cb.checked; persist(); pushOverlay();
    });
  });
  el.querySelectorAll('[data-del]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      if(!confirm('Remove this counter?')) return;
      counters = counters.filter(c=>c.id!==btn.dataset.del);
      renderList(); persist(); pushOverlay();
    });
  });
  el.querySelectorAll('[data-edit]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const c = counters.find(x=>x.id===btn.dataset.edit); if(c) openEditor(c);
    });
  });
  el.querySelectorAll('[data-inc]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const c = counters.find(x=>x.id===btn.dataset.inc); if(c) setValue(c, (c.value||0)+(c.step||1));
    });
  });
  el.querySelectorAll('[data-dec]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const c = counters.find(x=>x.id===btn.dataset.dec); if(c) setValue(c, (c.value||0)-(c.step||1));
    });
  });
  el.querySelectorAll('[data-set]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const c = counters.find(x=>x.id===btn.dataset.set); if(!c) return;
      const n = parseFloat($('cnt-set-'+c.id).value);
      if(!isNaN(n)) setValue(c, n);
    });
  });
  el.querySelectorAll('[data-reset]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const c = counters.find(x=>x.id===btn.dataset.reset); if(c) setValue(c, 0);
    });
  });
}

// ── Editor modal ─────────────────────────────────────────────────────────────
function fieldColor(id, val){ return `<input type="color" id="${id}" value="${val}" style="width:50px;height:32px;border:none;background:none;cursor:pointer">`; }

function openEditor(c){
  document.getElementById('cntEditorModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'cntEditorModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:9999;display:flex;align-items:center;justify-content:center';
  const s = c.style;
  const themeOpts = Object.keys(THEMES).map(t=>`<option value="${t}" ${c.theme===t?'selected':''}>${t}</option>`).join('');
  const fontOpts = fontOptionsHtml(s.font);
  const shapeOpts = SHAPES.map(o=>`<option value="${o.v}" ${s.shape===o.v?'selected':''}>${o.l}</option>`).join('');
  const animOpts = ANIMS.map(o=>`<option value="${o.v}" ${s.animOnChange===o.v?'selected':''}>${o.l}</option>`).join('');
  const permOpts = PERMS.map(o=>`<option value="${o.v}" ${c.permission===o.v?'selected':''}>${o.l}</option>`).join('');

  modal.innerHTML = `<div style="background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:22px;width:600px;max-height:90vh;overflow-y:auto;position:relative">
    <button id="cntEdClose" style="position:absolute;top:12px;right:14px;background:none;border:none;color:var(--muted);font-size:1.5rem;cursor:pointer">x</button>
    <div style="font-size:.7rem;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);font-weight:700;margin-bottom:16px">Editing: ${esc(c.name)}</div>

    <label>Name</label><input type="text" id="cntEdName" value="${esc(c.name)}">

    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:10px">
      <div><label>Increment command</label><input type="text" id="cntEdInc" value="${esc(c.incCmd)}" placeholder="!death"></div>
      <div><label>Decrement command</label><input type="text" id="cntEdDec" value="${esc(c.decCmd)}" placeholder="optional"></div>
      <div><label>Reset command</label><input type="text" id="cntEdReset" value="${esc(c.resetCmd)}" placeholder="optional"></div>
    </div>
    <div class="hint">Reset always requires a mod or the broadcaster, no matter who's allowed below.</div>

    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px;margin-top:10px">
      <div><label>Step amount</label><input type="number" id="cntEdStep" value="${c.step}" min="0.1" step="0.1"></div>
      <div><label>Min (blank = none)</label><input type="number" id="cntEdMin" value="${c.min==null?'':c.min}"></div>
      <div><label>Max (blank = none)</label><input type="number" id="cntEdMax" value="${c.max==null?'':c.max}"></div>
      <div><label>Who can use it</label><select id="cntEdPerm">${permOpts}</select></div>
    </div>
    <label class="checkrow mt"><input type="checkbox" id="cntEdArg" ${c.allowArg?'checked':''}> Allow a custom amount, e.g. <code>!death 3</code></label>
    <div class="row mt" style="align-items:center;gap:8px"><label style="margin:0">Max custom amount</label><input type="number" id="cntEdMaxArg" value="${Number.isFinite(c.maxArg)?c.maxArg:10}" min="1" max="10000" style="width:80px"></div>
    <div class="hint">Largest amount a viewer can add/subtract in one command. Bigger values are clamped to this.</div>
    <label class="checkrow mt"><input type="checkbox" id="cntEdVis" ${c.visible!==false?'checked':''}> Show on overlay</label>

    <hr class="sep">
    <label>Style theme</label><select id="cntEdTheme">${themeOpts}</select>
    <div id="cntEdCustomWrap" style="display:${c.theme==='Custom'?'block':'none'};margin-top:10px">
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px">
        <div><label>Shape</label><select id="cntEdShape">${shapeOpts}</select></div>
        <div><label>Background</label>${fieldColor('cntEdBg', s.bgColor)}</div>
        <div><label>Border</label>${fieldColor('cntEdBorder', s.borderColor)}</div>
        <div><label>Border width</label><input type="number" id="cntEdBw" value="${s.borderWidth}" min="0" max="8"></div>
      </div>
      <div class="row mt" style="gap:14px;flex-wrap:wrap;align-items:center">
        <label class="checkrow" style="margin:0"><input type="checkbox" id="cntEdGlow" ${s.glow?'checked':''}> Glow</label>
        <div>${fieldColor('cntEdGlowColor', s.glowColor)}</div>
        <div><input type="number" id="cntEdGlowSize" value="${s.glowSize}" min="0" max="40" style="width:70px"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:10px">
        <div><label>Font</label><select id="cntEdFont">${fontOpts}</select></div>
        <div><label>Label colour</label>${fieldColor('cntEdTextColor', s.textColor)}</div>
        <div><label>Label size (px)</label><input type="number" id="cntEdFs" value="${s.fontSize}" min="8" max="40"></div>
        <div><label>Value colour</label>${fieldColor('cntEdValColor', s.valueColor)}</div>
        <div><label>Value size (px)</label><input type="number" id="cntEdValFs" value="${s.valueFontSize}" min="10" max="80"></div>
        <div><label>Change animation</label><select id="cntEdAnim">${animOpts}</select></div>
      </div>
      <label class="mt">Display template</label>
      <input type="text" id="cntEdTemplate" value="${esc(s.template).replace(/\n/g,'\\n')}">
      <div class="hint">Use {name} and {value}. Use \\n for a line break, e.g. <code>{name}\\n{value}</code>.</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:10px">
        <div><label>Width (0 = auto)</label><input type="number" id="cntEdW" value="${s.width}" min="0" max="600"></div>
        <div><label>Height (0 = auto)</label><input type="number" id="cntEdH" value="${s.height}" min="0" max="400"></div>
        <div><label>Padding</label><input type="number" id="cntEdPad" value="${s.padding}" min="0" max="60"></div>
      </div>
    </div>

    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:20px">
      <button id="cntEdSave" class="btn-sm btn-gold">Save</button>
      <button id="cntEdCancel" class="btn-sm btn-ghost">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(modal);

  $('cntEdTheme').addEventListener('change', e=>{
    $('cntEdCustomWrap').style.display = e.target.value==='Custom' ? 'block' : 'none';
  });

  $('cntEdSave').addEventListener('click', ()=>{
    c.name       = $('cntEdName').value.trim() || c.name;
    c.incCmd     = $('cntEdInc').value.trim();
    c.decCmd     = $('cntEdDec').value.trim();
    c.resetCmd   = $('cntEdReset').value.trim();
    c.step       = parseFloat($('cntEdStep').value) || 1;
    const minV   = $('cntEdMin').value.trim(); c.min = minV===''?null:parseFloat(minV);
    const maxV   = $('cntEdMax').value.trim(); c.max = maxV===''?null:parseFloat(maxV);
    c.permission = $('cntEdPerm').value;
    c.allowArg   = $('cntEdArg').checked;
    c.maxArg     = Math.max(1, parseFloat($('cntEdMaxArg').value) || 10);
    c.visible    = $('cntEdVis').checked;
    c.theme      = $('cntEdTheme').value;

    if(c.theme !== 'Custom' && THEMES[c.theme]){
      Object.assign(c.style, THEMES[c.theme]);
    } else {
      c.style.shape       = $('cntEdShape').value;
      c.style.bgColor     = $('cntEdBg').value;
      c.style.borderColor = $('cntEdBorder').value;
      c.style.borderWidth = parseInt($('cntEdBw').value) || 0;
      c.style.glow        = $('cntEdGlow').checked;
      c.style.glowColor   = $('cntEdGlowColor').value;
      c.style.glowSize    = parseInt($('cntEdGlowSize').value) || 0;
      c.style.font        = $('cntEdFont').value;
      c.style.textColor   = $('cntEdTextColor').value;
      c.style.fontSize    = parseInt($('cntEdFs').value) || 14;
      c.style.valueColor  = $('cntEdValColor').value;
      c.style.valueFontSize = parseInt($('cntEdValFs').value) || 30;
      c.style.animOnChange  = $('cntEdAnim').value;
      c.style.template    = $('cntEdTemplate').value.replace(/\\n/g,'\n') || '{name}\n{value}';
      c.style.width        = parseInt($('cntEdW').value) || 0;
      c.style.height       = parseInt($('cntEdH').value) || 0;
      c.style.padding       = parseInt($('cntEdPad').value) || 0;
    }

    modal.remove(); renderList(); persist(); pushOverlay();
  });
  $('cntEdClose').addEventListener('click', ()=>modal.remove());
  $('cntEdCancel').addEventListener('click', ()=>modal.remove());
  modal.addEventListener('click', e=>{ if(e.target===modal) modal.remove(); });
}

// ── Layout controls ────────────────────────────────────────────────────────
function wireLayout(){
  $('cntLayoutDir').addEventListener('change', e=>{ layout.direction=e.target.value; persist(); pushOverlay(); });
  $('cntLayoutAlign').addEventListener('change', e=>{ layout.align=e.target.value; persist(); pushOverlay(); });
  $('cntLayoutGap').addEventListener('input', e=>{ layout.gap=parseInt(e.target.value)||0; persist(); pushOverlay(); });
}

// ── Build UI ──────────────────────────────────────────────────────────────────
function buildLeft(){
  const el = $('countersLeft'); if(!el) return;
  el.innerHTML = `
  <div class="card">
    <h2>Overlay Layout</h2>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
      <div><label>Direction</label><select id="cntLayoutDir">
        <option value="column" ${layout.direction==='column'?'selected':''}>Stacked (vertical)</option>
        <option value="row" ${layout.direction==='row'?'selected':''}>Row (horizontal)</option>
      </select></div>
      <div><label>Alignment</label><select id="cntLayoutAlign">
        <option value="flex-start" ${layout.align==='flex-start'?'selected':''}>Start</option>
        <option value="center" ${layout.align==='center'?'selected':''}>Centre</option>
        <option value="flex-end" ${layout.align==='flex-end'?'selected':''}>End</option>
      </select></div>
      <div><label>Spacing (px)</label><input type="number" id="cntLayoutGap" value="${layout.gap}" min="0" max="60"></div>
    </div>
  </div>
  <div class="card">
    <h2>New Counter</h2>
    <div class="row">
      <input type="text" id="cntNewName" placeholder="Deaths" style="flex:1">
      <button class="btn-sm btn-gold" id="cntNewBtn">Add</button>
    </div>
    <div class="hint">Each counter gets its own <code>!command</code> for chat to increase or decrease it, plus full style customisation.</div>
  </div>
  <div class="card" style="margin-bottom:60px">
    <h2>Counters</h2>
    <div id="cntList"></div>
  </div>`;

  wireLayout();

  $('cntNewBtn').addEventListener('click', ()=>{
    const name = $('cntNewName').value.trim() || 'Counter';
    counters.push(newCounter(name));
    $('cntNewName').value = '';
    renderList(); persist(); pushOverlay();
  });
  $('cntNewName').addEventListener('keydown', e=>{
    if(e.key==='Enter') $('cntNewBtn').click();
  });

  renderOverlayBar('cntOverlayMode','cntOverlayUrl','cntCopyUrl','counters',store.overlayUrls);
  renderList();
}

export async function initCounters(){
  const d = store.counters || {};
  if(Array.isArray(d.counters)) counters = d.counters;
  if(d.layout) Object.assign(layout, d.layout);

  buildLeft();

  // True live preview — the exact overlay OBS shows, real counters and values.
  // "On overlay" toggles show/hide live here.
  const frame = $('countersPreviewFrame');
  const urls = store.overlayUrls || {};
  if(frame && urls.counters) frame.src = urls.counters;

  pushOverlay(); // seed the overlay snapshot immediately
}
