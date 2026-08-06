// Pomodoro engine + UI. Lives inside the Tasks (Co-work) tab.
// Persisted as part of the tasks blob (key: pomo) via the tasks-tab persist().
import { $, esc, flash } from './utils.js';
import { playSound as playAudioFile } from './audio.js';
import { liveSet } from './store.js';

const { invoke } = window.__TAURI__.core;

// ── Preset modes ──────────────────────────────────────────────────────────────
const PRESETS = [
  { id:'classic',  name:'Classic 25/5',      work:25, short:5,  long:20, sprints:4 },
  { id:'deep',     name:'Deep Work 50/10',   work:50, short:10, long:25, sprints:4 },
  { id:'longfocus',name:'Long Focus 90/20',  work:90, short:20, long:30, sprints:2 },
  { id:'adhd',     name:'ADHD-Friendly 15/5',work:15, short:5,  long:15, sprints:4 },
  { id:'creative', name:'Creative 45/15',    work:45, short:15, long:30, sprints:4 },
  { id:'quick',    name:'Quick Tasks 10/3',  work:10, short:3,  long:10, sprints:6 },
];

// ── Themes ────────────────────────────────────────────────────────────────────
// bg may be a CSS gradient. font '' = system. mono forces monospace stack.
export const PTHEMES = {
  'Tomato Classic': { bg:'#b73a2e', text:'#fff3e9', accent:'#ffd9a0', work:'#ffe066', brk:'#9be89b', border:'#8f2d24', font:'Fredoka', radius:18 },
  'Minimal Dark':   { bg:'#17171c', text:'#f0f0f2', accent:'#8a8a96', work:'#e8e8ee', brk:'#7dd490', border:'#2c2c34', font:'Inter', radius:12 },
  'Minimal Light':  { bg:'#f7f7f4', text:'#26262b', accent:'#8a8a90', work:'#d95550', brk:'#4a9e5c', border:'#dddad2', font:'Inter', radius:12 },
  'Neon Arcade':    { bg:'#0d0221', text:'#eafcff', accent:'#00f0ff', work:'#ff2bd6', brk:'#00ff9d', border:'#00f0ff', font:'Orbitron', radius:10, glow:true },
  'Pixel Retro':    { bg:'#1b1b2d', text:'#ffffff', accent:'#ffd23f', work:'#ff6b6b', brk:'#6bff8a', border:'#ffd23f', font:'Press Start 2P', radius:0, pixel:true },
  'Lo-fi Café':     { bg:'#3b2f2a', text:'#f3e5d0', accent:'#d9a066', work:'#e8b97e', brk:'#a8c686', border:'#5a463d', font:'Comfortaa', radius:20 },
  'Terminal':       { bg:'#050805', text:'#33ff33', accent:'#33ff33', work:'#33ff33', brk:'#00cc88', border:'#1d5c1d', font:'VT323', radius:4, mono:true },
  'Glass':          { bg:'rgba(255,255,255,0.12)', text:'#ffffff', accent:'#ffffffcc', work:'#ffffff', brk:'#b6ffd9', border:'rgba(255,255,255,0.35)', font:'Poppins', radius:22, glass:true },
  'Forest':         { bg:'#1d3524', text:'#eaf5e6', accent:'#7ddc8f', work:'#a3e29b', brk:'#f2d478', border:'#2f4d36', font:'Nunito', radius:16 },
  'Ocean':          { bg:'#0b2a3f', text:'#e6f6ff', accent:'#4fc3f7', work:'#63d1ff', brk:'#7be3c0', border:'#164a67', font:'Rubik', radius:16 },
  'Sakura':         { bg:'#fdeef4', text:'#5b3a4a', accent:'#e57f9f', work:'#f06292', brk:'#81c784', border:'#f4c2d4', font:'Quicksand', radius:24 },
  'Sunset':         { bg:'linear-gradient(135deg,#ff7e5f 0%,#8e5285 100%)', text:'#fff6ee', accent:'#ffd9a0', work:'#ffe28a', brk:'#a8f0c6', border:'#c96a5a', font:'Poppins', radius:18 },
  'Custom':         null, // resolved from cfg.customTheme
};

const PHASE_LABEL = { work:'FOCUS', short:'SHORT BREAK', long:'LONG BREAK', await:'READY', idle:'' };
const POS_OPTIONS = [['top-left','Top-Left'],['top-center','Top-Center'],['top-right','Top-Right'],['bottom-left','Bottom-Left'],['bottom-center','Bottom-Center'],['bottom-right','Bottom-Right'],['center','Center'],['custom','Custom']];

// ── State ─────────────────────────────────────────────────────────────────────
let cfg = {
  enabled: true,
  modeId: 'classic',
  customModes: [],            // {id,name,work,short,long,sprints}
  theme: 'Tomato Classic',
  customTheme: { bg:'#221a3a', text:'var(--ink)', accent:'#ffc83d', work:'#ffc83d', brk:'#7dd490', border:'#3a2f63', radius:16 },
  autoStart: true,
  soundEnabled: true,
  soundPath: null,            // optional MP3; falls back to built-in beep
  focusTaskId: null,
  overlay: {
    style:'ring',             // ring | bar | minimal
    position:{ mode:'top-right', x:20, y:20 },
    scale:100, showDots:true, showPhase:true, showTask:true, showMode:false,
    master:false,             // also show as a panel in the master overlay
  },
};
let run = { phase:'idle', sprint:1, endsAt:0, paused:false, pausedRemain:0, next:null, done:0 };

let api = null;               // { persist, getHostTasks, completeTask }
let tickTimer = null;
let chatAttached = false;
let editingModeId = null;     // custom mode currently in editor ('__new' = creating)

// ── Helpers ───────────────────────────────────────────────────────────────────
function allModes(){ return [...PRESETS, ...cfg.customModes]; }
function mode(){ return allModes().find(m=>m.id===cfg.modeId) || PRESETS[0]; }
function theme(){ return PTHEMES[cfg.theme] || cfg.customTheme; }
function resolvedTheme(){ return cfg.theme==='Custom' ? {...cfg.customTheme, font:''} : theme(); }
function uid(){ return 'pm'+Math.random().toString(36).slice(2,9); }
function mmss(ms){
  const s=Math.max(0,Math.ceil(ms/1000));
  const m=Math.floor(s/60), ss=s%60;
  return `${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
}
function remainMs(){
  if(run.paused) return run.pausedRemain;
  if(run.phase==='work'||run.phase==='short'||run.phase==='long') return run.endsAt-Date.now();
  return 0;
}
function phaseTotalMs(ph){
  const m=mode();
  if(ph==='work') return m.work*60000;
  if(ph==='short') return m.short*60000;
  if(ph==='long') return m.long*60000;
  return 0;
}
function deepMerge(t,s){ if(!s) return t; for(const k in s){ const v=s[k]; if(v&&typeof v==='object'&&!Array.isArray(v)&&t[k]&&typeof t[k]==='object'){ deepMerge(t[k],v);} else t[k]=v; } return t; }

const loadedFonts = new Set();
function loadFont(f){
  if(!f||loadedFonts.has(f)) return; loadedFonts.add(f);
  const l=document.createElement('link'); l.rel='stylesheet';
  l.href=`https://fonts.googleapis.com/css2?family=${encodeURIComponent(f)}&display=swap`;
  document.head.appendChild(l);
}

// ── Persistence + overlay push ────────────────────────────────────────────────
export function pomoData(){ return { cfg, run }; }

function save(){
  liveSet('pomoPhase', run.paused ? 'paused' : (run.phase || 'idle'));  // {pomophase}
  if(api) api.persist();
  pushOverlay();
}

function focusTaskText(){
  if(!cfg.focusTaskId || !api) return null;
  const t = api.getHostTasks().find(t=>t.id===cfg.focusTaskId);
  return t ? t.text : null;
}

function pushOverlay(){
  invoke('pomodoro_overlay_update',{ state:{
    enabled: cfg.enabled,
    run:{ phase:run.phase, sprint:run.sprint, endsAt:run.endsAt, paused:run.paused,
          pausedRemain:run.pausedRemain, next:run.next, done:run.done },
    mode:{ name:mode().name, work:mode().work, short:mode().short, long:mode().long, sprints:mode().sprints },
    theme: resolvedTheme(),
    themeName: cfg.theme,
    overlay: cfg.overlay,
    focusTask: cfg.overlay.showTask ? focusTaskText() : null,
    totalMs: phaseTotalMs(run.phase==='await'?run.next:run.phase),
  }});
}

// ── Sounds ────────────────────────────────────────────────────────────────────
function beep(){
  try{
    const ac=new (window.AudioContext||window.webkitAudioContext)();
    const notes=[[880,0],[1108.7,0.18],[1318.5,0.36]];
    notes.forEach(([f,t])=>{
      const o=ac.createOscillator(), g=ac.createGain();
      o.frequency.value=f; o.type='sine';
      g.gain.setValueAtTime(0.001,ac.currentTime+t);
      g.gain.exponentialRampToValueAtTime(0.25,ac.currentTime+t+0.02);
      g.gain.exponentialRampToValueAtTime(0.001,ac.currentTime+t+0.35);
      o.connect(g); g.connect(ac.destination);
      o.start(ac.currentTime+t); o.stop(ac.currentTime+t+0.4);
    });
    setTimeout(()=>ac.close().catch(()=>{}),1200);
  }catch(e){}
}
function playPhaseSound(){
  if(!cfg.soundEnabled) return;
  if(cfg.soundPath){
    // Phase changes are rare and worth hearing, so they bypass the cap.
    if(!playAudioFile(cfg.soundPath, { force:true, onError: beep })) beep();
  } else beep();
}

// ── Engine ────────────────────────────────────────────────────────────────────
function startPhase(ph){
  run.phase=ph; run.paused=false; run.pausedRemain=0; run.next=null;
  run.endsAt=Date.now()+phaseTotalMs(ph);
  renderControls(); save();
}
function nextPhaseAfter(ph){
  const m=mode();
  if(ph==='work')  return run.sprint < m.sprints ? 'short' : 'long';
  if(ph==='short') return 'work';
  if(ph==='long')  return 'work';
  return 'work';
}
function advance(fromSkip){
  const cur = run.phase;
  const nxt = nextPhaseAfter(cur);
  if(cur==='work'){ run.done++; }
  if(cur==='short'){ run.sprint++; }
  if(cur==='long'){ run.sprint=1; }
  if(!fromSkip) playPhaseSound();

  if(cur==='long' && !fromSkip && !cfg.autoStart){
    // full cycle complete — go idle
    run.phase='idle'; run.next=null; run.endsAt=0;
    renderControls(); save(); return;
  }
  if(cfg.autoStart || fromSkip){
    startPhase(nxt);
  } else {
    run.phase='await'; run.next=nxt; run.endsAt=0; run.paused=false;
    renderControls(); save();
  }
}
function start(){
  if(run.phase==='await' && run.next){ startPhase(run.next); return; }
  if(run.paused){ resume(); return; }
  if(run.phase==='idle'){ run.sprint=1; run.done=0; startPhase('work'); }
}
function pause(){
  if(run.paused || run.phase==='idle' || run.phase==='await') return;
  run.paused=true; run.pausedRemain=Math.max(0,run.endsAt-Date.now());
  renderControls(); save();
}
function resume(){
  if(!run.paused) return;
  run.paused=false; run.endsAt=Date.now()+run.pausedRemain; run.pausedRemain=0;
  renderControls(); save();
}
function extend(min){
  if(run.phase==='idle'||run.phase==='await') return;
  if(run.paused) run.pausedRemain+=min*60000;
  else run.endsAt+=min*60000;
  save();
}
function skip(){
  if(run.phase==='idle') return;
  if(run.phase==='await'){ startPhase(run.next||'work'); return; }
  advance(true);
}
function reset(){
  run={ phase:'idle', sprint:1, endsAt:0, paused:false, pausedRemain:0, next:null, done:0 };
  renderControls(); save();
}

// Commands tab: "Trigger a SPARK tool" -> Pomodoro. Pomodoro lives inside the
// Tasks tab and has no toggle of its own, so nothing to gate on.
window.addEventListener('spark-action', e => {
  const d = e.detail || {};
  if(d.tool !== 'pomodoro') return;
  if(d.action === 'start')       start();
  else if(d.action === 'pause')  pause();
  else if(d.action === 'resume') resume();
  else if(d.action === 'skip')   skip();
  else if(d.action === 'reset')  reset();
});

function tick(){
  if(!cfg.enabled) return;
  if(!run.paused && (run.phase==='work'||run.phase==='short'||run.phase==='long')){
    if(Date.now()>=run.endsAt){ advance(false); return; }
  }
  updateTimeDisplays();
}

// ── Chat commands (!pomo — broadcaster/mods only) ─────────────────────────────
function attachChat(){
  if(chatAttached) return; chatAttached=true;
  window.addEventListener('spark-chat',e=>{
    const d=e.detail;
    if(!cfg.enabled) return;
    if(!(d.is_mod||d.is_broadcaster)) return;
    const raw=(d.message||'').trim(), lower=raw.toLowerCase();
    if(!lower.startsWith('!pomo')) return;
    const arg=lower.slice(5).trim();
    if(arg==='start') start();
    else if(arg==='pause') pause();
    else if(arg==='resume') resume();
    else if(arg==='skip') skip();
    else if(arg==='reset') reset();
    else if(arg.startsWith('mode ')){
      const q=raw.slice(raw.toLowerCase().indexOf('mode ')+5).trim().toLowerCase();
      const m=allModes().find(m=>m.name.toLowerCase().includes(q));
      if(m){ cfg.modeId=m.id; if(run.phase==='idle') { renderUI(); } else { renderControls(); } save(); }
    }
  });
}

// ── UI: controls (timer readout + buttons; cheap re-render) ──────────────────
function sprintDotsHtml(color){
  const m=mode();
  let dots='';
  for(let i=1;i<=m.sprints;i++){
    const done = i<run.sprint || (i===run.sprint && (run.phase==='short'||run.phase==='long'||(run.phase==='await'&&run.next!=='work')));
    const active = i===run.sprint && run.phase==='work';
    dots+=`<span style="display:inline-block;width:10px;height:10px;border-radius:50%;margin:0 3px;background:${done?color:'transparent'};border:2px solid ${color};${active?'box-shadow:0 0 6px '+color:''};opacity:${done||active?1:.45}"></span>`;
  }
  return dots;
}

function renderControls(){
  const el=$('pomoControls'); if(!el) return;
  const running = run.phase==='work'||run.phase==='short'||run.phase==='long';
  const isBreak = run.phase==='short'||run.phase==='long';
  const label = run.phase==='await' ? `NEXT: ${PHASE_LABEL[run.next]||''}` : (PHASE_LABEL[run.phase]||'');
  const timeStr = running ? mmss(remainMs()) : (run.phase==='await' ? mmss(phaseTotalMs(run.next)) : mmss(phaseTotalMs('work')));
  const col = isBreak ? '#7dd490' : 'var(--gold)';

  el.innerHTML=`
    <div style="text-align:center;padding:6px 0 2px">
      <div style="font-size:.7rem;letter-spacing:.18em;font-weight:700;color:${col};min-height:14px">${label}${run.paused?' · PAUSED':''}</div>
      <div style="line-height:1.15"><span id="pomoTime" style="display:inline-block;min-width:5.2ch;font-size:2.6rem;font-weight:800;font-variant-numeric:tabular-nums">${timeStr}</span></div>
      <div style="margin:2px 0 8px">${sprintDotsHtml(col)}</div>
    </div>
    <div class="row" style="justify-content:center;gap:6px;flex-wrap:wrap">
      ${running&&!run.paused
        ? `<button class="btn-sm" id="pmPause">Pause</button>`
        : `<button class="btn-sm btn-gold" id="pmStart">${run.paused?'Resume':(run.phase==='await'?'Start next':'Start')}</button>`}
      <button class="btn-sm" id="pmExtend" ${running?'':'disabled'}>+5 min</button>
      <button class="btn-sm" id="pmSkip" ${run.phase==='idle'?'disabled':''}>Skip</button>
      <button class="btn-sm btn-ghost" id="pmReset">Reset</button>
    </div>`;

  const w=(id,fn)=>{ const b=$(id); if(b) b.addEventListener('click',fn); };
  w('pmStart',start); w('pmPause',pause); w('pmExtend',()=>extend(5)); w('pmSkip',skip); w('pmReset',()=>{ if(confirm('Reset the pomodoro cycle?')) reset(); });
  updatePreview();
}

function updateTimeDisplays(){
  const t=$('pomoTime');
  if(t){
    const running = run.phase==='work'||run.phase==='short'||run.phase==='long';
    if(running) t.textContent=mmss(remainMs());
  }
  updatePreviewTime();
}

// ── UI: settings card ─────────────────────────────────────────────────────────
function modeOptionsHtml(){
  const groups = [
    ['Presets', PRESETS],
    ['Custom', cfg.customModes],
  ];
  return groups.map(([label,arr])=>arr.length?`<optgroup label="${label}">${arr.map(m=>
    `<option value="${m.id}"${cfg.modeId===m.id?' selected':''}>${esc(m.name)} (${m.work}/${m.short}, x${m.sprints})</option>`).join('')}</optgroup>`:'').join('');
}

function customEditorHtml(){
  const isNew = editingModeId==='__new';
  const m = isNew
    ? { name:'', work:25, short:5, long:15, sprints:4 }
    : cfg.customModes.find(x=>x.id===editingModeId);
  if(!m) return '';
  return `<div style="border:1px solid var(--row-line);border-radius:10px;padding:10px;margin-top:8px">
    <div style="font-size:.8rem;font-weight:700;margin-bottom:6px">${isNew?'New custom mode':'Edit custom mode'}</div>
    <div class="row"><label style="flex:1">Name</label><input type="text" id="pmCmName" value="${esc(m.name)}" style="width:150px" placeholder="My mode"></div>
    <div class="row mt"><label style="flex:1">Work (min)</label><input type="number" id="pmCmWork" value="${m.work}" min="1" max="480" style="width:70px"></div>
    <div class="row mt"><label style="flex:1">Short break (min)</label><input type="number" id="pmCmShort" value="${m.short}" min="1" max="120" style="width:70px"></div>
    <div class="row mt"><label style="flex:1">Long break (min)</label><input type="number" id="pmCmLong" value="${m.long}" min="1" max="180" style="width:70px"></div>
    <div class="row mt"><label style="flex:1">Sprints before long break</label><input type="number" id="pmCmSprints" value="${m.sprints}" min="1" max="16" style="width:70px"></div>
    <div class="row mt" style="gap:6px">
      <button class="btn-sm btn-gold" id="pmCmSave">${isNew?'Create':'Update'}</button>
      ${!isNew?'<button class="btn-sm btn-ghost" id="pmCmDelete">Delete</button>':''}
      <button class="btn-sm btn-ghost" id="pmCmCancel">Close</button>
    </div>
  </div>`;
}

function focusOptionsHtml(hostTasks){
  const noneLabel = hostTasks.length ? '(none)' : '(no host tasks yet)';
  return [`<option value="">${noneLabel}</option>`]
    .concat(hostTasks.map(t=>`<option value="${t.id}"${cfg.focusTaskId===t.id?' selected':''}>${esc(t.text.length>40?t.text.slice(0,40)+'…':t.text)}</option>`)).join('');
}

function taskPickerHtml(){
  const hostTasks = api ? api.getHostTasks() : [];
  const tip = 'Picks one of your host tasks to show on the overlay while you focus. Add a host task in the card below first.';
  return `<div class="row mt"><label style="flex:1" title="${tip}">Focus task</label>
    <select id="pmFocusTask" style="max-width:180px" title="${tip}">${focusOptionsHtml(hostTasks)}</select>
    <button class="btn-sm" id="pmFocusDone" title="Mark focus task done"${cfg.focusTaskId?'':' disabled'}>✓</button>
  </div>
  <div class="hint">${hostTasks.length?'Shown on the overlay during focus. ✓ marks it complete.':'Add a host task in the card below, then pick it here to show it on the overlay.'}</div>`;
}

export function renderPomodoroUI(){
  const el=$('pomoCard'); if(!el) return;
  const th=resolvedTheme();
  const themeOpts=Object.keys(PTHEMES).map(k=>`<option value="${k}"${cfg.theme===k?' selected':''}>${k}</option>`).join('');
  const ov=cfg.overlay;

  if(!cfg.enabled){
    el.innerHTML=`
    <div class="card">
      <h2>🍅 Pomodoro</h2>
      <label class="checkrow" style="margin-top:0"><input type="checkbox" id="pmEnabled"> Enable Pomodoro timer</label>
      <div class="hint">Work in focused sprints with breaks in between, with a timer overlay for OBS.</div>
    </div>`;
    const en=$('pmEnabled');
    if(en) en.addEventListener('change',e=>{ cfg.enabled=e.target.checked; renderPomodoroUI(); save(); });
    updatePreviewVisibility();
    return;
  }

  el.innerHTML=`
  <div class="card">
    <h2>🍅 Pomodoro</h2>
    <label class="checkrow" style="margin-top:0"><input type="checkbox" id="pmEnabled" checked> Enable Pomodoro timer</label>
    <div id="pomoControls"></div>
    <div class="row mt">
      <label style="flex:1">Mode</label>
      <select id="pmMode" style="max-width:210px">${modeOptionsHtml()}</select>
    </div>
    <div class="row mt" style="gap:6px">
      <button class="btn-sm" id="pmNewMode">New custom mode…</button>
      ${cfg.customModes.find(m=>m.id===cfg.modeId)?'<button class="btn-sm" id="pmEditMode">Edit mode</button>':''}
    </div>
    <div id="pmCustomEditor">${editingModeId?customEditorHtml():''}</div>

    ${taskPickerHtml()}

    <label class="checkrow mt"><input type="checkbox" id="pmAutoStart"${cfg.autoStart?' checked':''}> Auto-start next phase</label>
    <label class="checkrow"><input type="checkbox" id="pmSound"${cfg.soundEnabled?' checked':''}> Sound on phase change</label>
    <div class="row mt" style="gap:6px">
      <button class="btn-sm" id="pmPickSound">Choose MP3…</button>
      <button class="btn-sm btn-ghost" id="pmTestSound">Test</button>
      <button class="btn-sm btn-ghost" id="pmClearSound">Clear</button>
    </div>
    <div class="hint" id="pmSoundPath">${cfg.soundPath?esc(cfg.soundPath):'Built-in chime.'}</div>

    <div class="mt">
      <h3 style="margin:12px 0 4px;font-size:.85rem">Overlay appearance</h3>
      <div class="row mt"><label style="flex:1">Theme</label><select id="pmTheme">${themeOpts}</select></div>
      <div id="pmCustomTheme" style="display:${cfg.theme==='Custom'?'block':'none'}">
        <div class="row mt"><label style="flex:1">Background</label><input type="color" id="pmCtBg" value="${cfg.customTheme.bg}"></div>
        <div class="row mt"><label style="flex:1">Text</label><input type="color" id="pmCtText" value="${cfg.customTheme.text}"></div>
        <div class="row mt"><label style="flex:1">Focus colour</label><input type="color" id="pmCtWork" value="${cfg.customTheme.work}"></div>
        <div class="row mt"><label style="flex:1">Break colour</label><input type="color" id="pmCtBrk" value="${cfg.customTheme.brk}"></div>
        <div class="row mt"><label style="flex:1">Border</label><input type="color" id="pmCtBorder" value="${cfg.customTheme.border}"></div>
      </div>
      <div class="row mt"><label style="flex:1" title="How progress is drawn: a ring around the time, a bar under it, or just the time">Style</label>
        <select id="pmStyle" title="How progress is drawn: a ring around the time, a bar under it, or just the time">
          <option value="ring"${ov.style==='ring'?' selected':''}>Progress ring</option>
          <option value="bar"${ov.style==='bar'?' selected':''}>Progress bar</option>
          <option value="minimal"${ov.style==='minimal'?' selected':''}>Minimal (text only)</option>
        </select>
      </div>
      <div class="hint">Ring wraps the time, bar sits under it, minimal is time only. Sprint dots are the separate checkbox below.</div>
      <div class="row mt"><label style="flex:1">Position</label>
        <select id="pmPos">${POS_OPTIONS.map(([v,l])=>`<option value="${v}"${ov.position.mode===v?' selected':''}>${l}</option>`).join('')}</select>
      </div>
      ${ov.position.mode==='custom'?`
      <div class="row mt"><label style="flex:1">X (px)</label><input type="number" id="pmPosX" value="${ov.position.x}" style="width:70px"></div>
      <div class="row mt"><label style="flex:1">Y (px)</label><input type="number" id="pmPosY" value="${ov.position.y}" style="width:70px"></div>`:''}
      <div class="row mt"><label style="flex:1">Size (%)</label><input type="number" id="pmScale" value="${ov.scale}" min="40" max="250" style="width:70px"></div>
      <label class="checkrow mt"><input type="checkbox" id="pmShowDots"${ov.showDots?' checked':''}> Show sprint dots</label>
      <label class="checkrow"><input type="checkbox" id="pmShowPhase"${ov.showPhase?' checked':''}> Show phase label</label>
      <label class="checkrow"><input type="checkbox" id="pmShowTask"${ov.showTask?' checked':''}> Show focus task</label>
      <label class="checkrow"><input type="checkbox" id="pmShowMode"${ov.showMode?' checked':''}> Show mode name</label>
    </div>
    <div class="hint" style="margin-top:8px">Chat: !pomo start · pause · resume · skip · reset · mode &lt;name&gt; (mods/broadcaster)</div>
  </div>`;

  wireUI();
  renderControls();
  updatePreviewVisibility();
  if(th.font) loadFont(th.font);
}

function updatePreviewVisibility(){
  const w=$('pomoPreviewWrap');
  if(w) w.style.display=cfg.enabled?'block':'none';
}

function wireUI(){
  const w=(id,ev,fn)=>{ const e=$(id); if(e) e.addEventListener(ev,fn); };

  w('pmEnabled','change',e=>{
    cfg.enabled=e.target.checked;
    if(!cfg.enabled){ run={ phase:'idle', sprint:1, endsAt:0, paused:false, pausedRemain:0, next:null, done:0 }; }
    renderPomodoroUI(); save();
  });

  w('pmMode','change',e=>{
    cfg.modeId=e.target.value; editingModeId=null;
    if(run.phase!=='idle' && !confirm('Mode changed. Reset the current cycle to apply timings now? (Cancel keeps the current phase running.)')){
      renderPomodoroUI(); save(); return;
    }
    if(run.phase!=='idle') run={ phase:'idle', sprint:1, endsAt:0, paused:false, pausedRemain:0, next:null, done:0 };
    renderPomodoroUI(); save();
  });
  w('pmNewMode','click',()=>{ editingModeId='__new'; renderPomodoroUI(); });
  w('pmEditMode','click',()=>{ editingModeId=cfg.modeId; renderPomodoroUI(); });

  // custom editor
  w('pmCmSave','click',()=>{
    const name=$('pmCmName').value.trim();
    if(!name){ alert('Enter a mode name.'); return; }
    const vals={
      name,
      work:Math.max(1,+$('pmCmWork').value||25),
      short:Math.max(1,+$('pmCmShort').value||5),
      long:Math.max(1,+$('pmCmLong').value||15),
      sprints:Math.max(1,Math.min(16,+$('pmCmSprints').value||4)),
    };
    if(editingModeId==='__new'){
      const m={ id:uid(), ...vals };
      cfg.customModes.push(m); cfg.modeId=m.id;
    } else {
      const m=cfg.customModes.find(x=>x.id===editingModeId);
      if(m) Object.assign(m,vals);
    }
    editingModeId=null; renderPomodoroUI(); save();
  });
  w('pmCmDelete','click',()=>{
    if(!confirm('Delete this custom mode?')) return;
    cfg.customModes=cfg.customModes.filter(x=>x.id!==editingModeId);
    if(cfg.modeId===editingModeId) cfg.modeId='classic';
    editingModeId=null; renderPomodoroUI(); save();
  });
  w('pmCmCancel','click',()=>{ editingModeId=null; renderPomodoroUI(); });

  // focus task
  w('pmFocusTask','change',e=>{ cfg.focusTaskId=e.target.value||null; renderPomodoroUI(); save(); });
  w('pmFocusDone','click',()=>{
    if(cfg.focusTaskId && api){ api.completeTask(cfg.focusTaskId); cfg.focusTaskId=null; renderPomodoroUI(); save(); }
  });

  // options
  w('pmAutoStart','change',e=>{ cfg.autoStart=e.target.checked; save(); });
  w('pmSound','change',e=>{ cfg.soundEnabled=e.target.checked; save(); });
  w('pmPickSound','click',async()=>{
    const dialog=window.__TAURI__.dialog;
    const f=await dialog.open({multiple:false,filters:[{name:'Audio',extensions:['mp3','wav','ogg','m4a']}]});
    if(!f) return;
    cfg.soundPath=f; cfg.soundEnabled=true;
    $('pmSound').checked=true; $('pmSoundPath').textContent=f; save();
  });
  w('pmTestSound','click',playPhaseSound);
  w('pmClearSound','click',()=>{ cfg.soundPath=null; $('pmSoundPath').textContent='Built-in chime.'; save(); });

  // theme + overlay
  w('pmTheme','change',e=>{ cfg.theme=e.target.value; renderPomodoroUI(); save(); });
  const ct=(id,key)=>w(id,'input',e=>{ cfg.customTheme[key]=e.target.value; updatePreview(); save(); });
  ct('pmCtBg','bg'); ct('pmCtText','text'); ct('pmCtWork','work'); ct('pmCtBrk','brk'); ct('pmCtBorder','border');
  w('pmStyle','change',e=>{ cfg.overlay.style=e.target.value; updatePreview(); save(); });
  w('pmPos','change',e=>{ cfg.overlay.position.mode=e.target.value; renderPomodoroUI(); save(); });
  w('pmPosX','change',e=>{ cfg.overlay.position.x=+e.target.value; save(); });
  w('pmPosY','change',e=>{ cfg.overlay.position.y=+e.target.value; save(); });
  w('pmScale','change',e=>{ cfg.overlay.scale=Math.max(40,Math.min(250,+e.target.value||100)); save(); });
  w('pmShowDots','change',e=>{ cfg.overlay.showDots=e.target.checked; updatePreview(); save(); });
  w('pmShowPhase','change',e=>{ cfg.overlay.showPhase=e.target.checked; updatePreview(); save(); });
  w('pmShowTask','change',e=>{ cfg.overlay.showTask=e.target.checked; updatePreview(); save(); });
  w('pmShowMode','change',e=>{ cfg.overlay.showMode=e.target.checked; updatePreview(); save(); });
  // Master-overlay membership is configured in Settings → Master Overlay.
}

// ── Right-column live preview (mirrors the overlay layout) ────────────────────
const PREV_RING_R=40, PREV_RING_C=2*Math.PI*PREV_RING_R;
function updatePreview(){
  const el=$('pomoPreviewBox'); if(!el) return;
  if(!cfg.enabled){ el.innerHTML=''; el.style.cssText='display:none'; return; }
  const th=resolvedTheme();
  if(th.font) loadFont(th.font);
  const isBreak = run.phase==='short'||run.phase==='long'||(run.phase==='await'&&run.next!=='work');
  const col = isBreak ? th.brk : th.work;
  const label = run.phase==='await' ? `NEXT: ${PHASE_LABEL[run.next]||''}` : (PHASE_LABEL[run.phase]||'READY');
  const task = focusTaskText();
  const fontStack = th.mono ? `'${th.font}', 'Courier New', monospace` : (th.font ? `'${th.font}', sans-serif` : 'inherit');

  el.style.cssText=`background:${th.bg};color:${th.text};border:2px solid ${th.border};border-radius:${th.radius}px;padding:14px;text-align:center;font-family:${fontStack};${th.glass?'backdrop-filter:blur(8px);':''}${th.glow?`box-shadow:0 0 18px ${th.accent}66;`:''}`;

  // fixed-width time so digit changes never reshape the box
  const timeHtml=(size)=>`<div style="line-height:1.2"><span id="pomoPrevTime" style="display:inline-block;min-width:5.2ch;font-size:${size};font-weight:800;font-variant-numeric:tabular-nums">${previewTimeStr()}</span></div>`;

  let body='';
  if(cfg.overlay.style==='ring'){
    body=`<div style="position:relative;width:104px;height:104px;margin:0 auto">
      <svg width="104" height="104" viewBox="0 0 96 96" style="transform:rotate(-90deg)">
        <circle cx="48" cy="48" r="${PREV_RING_R}" fill="none" stroke="${th.border}" stroke-width="6" opacity=".55"/>
        <circle id="pomoPrevRing" cx="48" cy="48" r="${PREV_RING_R}" fill="none" stroke="${col}" stroke-width="6"
          stroke-linecap="round" stroke-dasharray="${PREV_RING_C}" stroke-dashoffset="${PREV_RING_C*(1-previewPct()/100)}"/>
      </svg>
      <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">${timeHtml('1.3rem')}</div>
    </div>`;
  } else {
    body=timeHtml('2rem');
    if(cfg.overlay.style==='bar'){
      body+=`<div style="height:6px;border-radius:3px;background:${th.border};margin-top:8px;overflow:hidden"><div id="pomoPrevBar" style="height:100%;width:${previewPct()}%;background:${col};transition:width .25s linear"></div></div>`;
    }
  }

  el.innerHTML=`
    ${cfg.overlay.showMode?`<div style="font-size:.6rem;opacity:.7;letter-spacing:.1em">${esc(mode().name)}</div>`:''}
    ${cfg.overlay.showPhase?`<div style="font-size:.65rem;letter-spacing:.2em;font-weight:700;color:${col}">${label}${run.paused?' · PAUSED':''}</div>`:''}
    ${body}
    ${cfg.overlay.showDots?`<div style="margin-top:4px">${sprintDotsHtml(col)}</div>`:''}
    ${cfg.overlay.showTask&&task?`<div style="font-size:.72rem;opacity:.85;margin-top:6px;border-top:1px solid ${th.border};padding-top:6px">${esc(task)}</div>`:''}
  `;
}
function previewTimeStr(){
  const running = run.phase==='work'||run.phase==='short'||run.phase==='long';
  if(running) return mmss(remainMs());
  if(run.phase==='await') return mmss(phaseTotalMs(run.next));
  return mmss(phaseTotalMs('work'));
}
function previewPct(){
  const running = run.phase==='work'||run.phase==='short'||run.phase==='long';
  if(!running) return 0;
  const total=phaseTotalMs(run.phase);
  return total?Math.max(0,Math.min(100,100*(1-remainMs()/total))):0;
}
function updatePreviewTime(){
  const t=$('pomoPrevTime'); if(t) t.textContent=previewTimeStr();
  const bar=$('pomoPrevBar');
  if(bar) bar.style.width=previewPct()+'%';
  const ring=$('pomoPrevRing');
  if(ring) ring.setAttribute('stroke-dashoffset', String(PREV_RING_C*(1-previewPct()/100)));
}

// ── Called by tasks-tab when the task list changes ────────────────────────────
export function pomoTasksChanged(){
  // focus task may have been completed/removed elsewhere
  if(cfg.focusTaskId && api && !api.getHostTasks().find(t=>t.id===cfg.focusTaskId)){
    cfg.focusTaskId=null;
  }
  const sel=$('pmFocusTask');
  if(sel){
    const hostTasks=api?api.getHostTasks():[];
    sel.innerHTML=focusOptionsHtml(hostTasks);
    const done=$('pmFocusDone'); if(done) done.disabled=!cfg.focusTaskId;
  }
  updatePreview(); pushOverlay();
}

// ── Init ──────────────────────────────────────────────────────────────────────
export function initPomodoro(saved, apiObj){
  api=apiObj;
  if(saved){
    if(saved.cfg) deepMerge(cfg, saved.cfg);
    if(saved.run) deepMerge(run, saved.run);
  }
  // sanity: if app was closed mid-phase and time elapsed, hold at "await next"
  const running = run.phase==='work'||run.phase==='short'||run.phase==='long';
  if(running && !run.paused && Date.now()>=run.endsAt){
    const nxt=nextPhaseAfter(run.phase);
    if(run.phase==='work') run.done++;
    if(run.phase==='short') run.sprint++;
    if(run.phase==='long') run.sprint=1;
    run.phase='await'; run.next=nxt; run.endsAt=0;
  }
  if(!allModes().find(m=>m.id===cfg.modeId)) cfg.modeId='classic';

  renderPomodoroUI();
  attachChat();
  if(tickTimer) clearInterval(tickTimer);
  tickTimer=setInterval(tick,250);
  pushOverlay();
  // Master-overlay membership is owned by Settings (settings.masterTools).
}
