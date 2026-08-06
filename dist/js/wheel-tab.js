import { store, toolBlocked, toolEnabled, liveSet } from './store.js';
import { $, esc, flash, initDrag, renderOverlayBar } from './utils.js';
import { drawWheel, winningIndex, angleForIndex, THEMES, defaultThemeNames } from './wheel.js';
import { playSound as playAudioFile } from './audio.js';

const { invoke } = window.__TAURI__.core;

const COLORS_DEFAULT = THEMES['Neon'];

let state = {
  items:[], fullItems:[], themeName:'Neon', customColors:null,
  angle:0, spinning:false, removeWinner:true,
};
let lists = {};
let activeListName = null;
let pendingRemoval = null;
let queue = [];
let winnerAudio = null;
let spinAudio = null;
let soundSettings = { enabled:false, path:null };
let spinSoundSettings = { enabled:false, path:null };
let announceSettings = { enabled:false, message:'🎉 The wheel landed on {winner}!' };
let overlaySettings = { winnerSeconds:5 };
let redeemSettings = { usePoints:true, anyReward:false, rewardId:'' };

const canvas = ()=> $('wCanvas');
const ctx    = ()=> canvas().getContext('2d');

function colors(){ return state.customColors?.length ? state.customColors : (THEMES[state.themeName]||THEMES['Neon']); }

// ── Persist ────────────────────────────────────────────────────────────────────
let saveTimer = null;
function persist(){
  if(activeListName && lists[activeListName]){
    lists[activeListName].items = state.items;
    lists[activeListName].fullItems = state.fullItems;
    lists[activeListName].themeName = state.themeName;
    lists[activeListName].customColors = state.customColors;
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(()=>{
    invoke('save_wheel',{ data:{
      lists, activeListName,
      activeState:{ items:state.items, fullItems:state.fullItems, themeName:state.themeName,
        customColors:state.customColors, removeWinner:state.removeWinner },
      sound: soundSettings, spinSound: spinSoundSettings, announce: announceSettings,
      overlaySettings, redeem: redeemSettings,
    }});
    pushOverlay(); // debounced with the save — render() fires persist() constantly
  },120);
}

async function pushOverlay(){
  await invoke('wheel_overlay_update',{ wheel:{ items:state.items, colors:colors() }});
}

// ── Render ─────────────────────────────────────────────────────────────────────
function draw(){ drawWheel(ctx(), canvas().width, state.items, colors(), state.angle); }

function render(){
  draw();
  renderItemList();
  renderThemePreview();
  $('wSpinBtn').disabled = state.spinning || state.items.length===0;
  $('wFullListNote').textContent = state.fullItems.length
    ? `Full list has ${state.fullItems.length} item(s); ${state.items.length} on wheel.`:'';
  persist();
}

function renderItemList(){
  const el = $('wItemList'); if(!el) return;
  if(!state.items.length){ el.innerHTML='<div class="hint">Wheel is empty.</div>'; return; }
  const cols = colors(), tw = state.items.reduce((s,it)=>s+(it.weight||1),0);
  el.innerHTML = state.items.map((it,i)=>{
    const p=((it.weight||1)/tw)*100; // items without an explicit weight count as 1
    const pct=p>=1?p.toFixed(0):p>=0.1?p.toFixed(1):p.toFixed(2);
    return `<div class="item-row" data-i="${i}">
      <span class="drag-handle" data-i="${i}">⠿</span>
      <span class="swatch" style="background:${cols[i%cols.length]}"></span>
      <span class="item-name">${esc(it.name)}</span>
      <span class="pct">${pct}%</span>
      <button class="mini" data-act="dec" data-i="${i}">−</button>
      <button class="mini" data-act="inc" data-i="${i}">+</button>
      <button class="mini del" data-act="del" data-i="${i}">✕</button>
    </div>`;
  }).join('');
  initDrag(el,(src,dest)=>{
    const moved=state.items.splice(src,1)[0];
    state.items.splice(dest,0,moved);
    render();
  });
}

function renderThemePreview(){
  const el=$('wThemePreview'); if(!el) return;
  el.innerHTML=colors().map(c=>`<div style="flex:1;background:${c}"></div>`).join('');
}

// ── Command-triggered actions ────────────────────────────────────────────────
// Fired by the Commands tab's "Trigger a SPARK tool" action. Same shape in
// every tab: check the tool id, honour the Settings toggle silently (the
// command has already replied in chat, so a second "tool is off" message would
// just be noise), then do the thing.
window.addEventListener('spark-action', e => {
  const d = e.detail || {};
  if(d.tool !== 'wheel' || !toolEnabled('wheel')) return;
  if(d.action === 'spin') doSpin(d.user || '');
});

// ── Spin ───────────────────────────────────────────────────────────────────────
function doSpin(redeemer){
  if(state.spinning||state.items.length===0) return;
  if(pendingRemoval!==null){
    if(state.removeWinner){
      const idx=state.items.findIndex(it=>it.name===pendingRemoval);
      if(idx>-1) state.items.splice(idx,1);
    }
    pendingRemoval=null;
    if(state.items.length===0){ render(); return; }
  }
  state.spinning=true; $('wSpinBtn').disabled=true;
  $('wheelWinner').innerHTML='';

  const finalAngle = Math.random()*2*Math.PI;
  const targetIdx  = winningIndex(state.items, finalAngle);
  const winnerName = state.items[targetIdx].name;
  const ws = overlaySettings.winnerSeconds||5;

  // The overlay must spin the SAME wheel the winner was computed on. If a
  // pending winner was just removed above, the overlay still shows the old
  // items (the update normally rides the debounced persist AFTER the spin
  // ends) — so push the current items first, then fire the spin.
  // Fire the sound at the same moment the overlay is told to spin so the SFX
  // lines up with the overlay animation (not the earlier in-app tick).
  pushOverlay()
    .catch(()=>{})
    .then(()=>{
      invoke('wheel_overlay_spin',{ finalAngle, winner:winnerName, winnerSeconds:ws });
      playSpinSound();
    });
  animateTo(finalAngle,()=>{
    pendingRemoval = winnerName;
    liveSet('wheelWinner', winnerName);   // powers {wheelwinner} in the Commands tab
    $('wheelWinner').innerHTML = esc(winnerName)+(redeemer?`<small>spun by ${esc(redeemer)}</small>`:'');
    playSound();
    announceWinner(winnerName, redeemer);
    state.spinning=false;
    render();
    if(queue.length) setTimeout(processQueue,5000);
  });
}

function animateTo(finalAngle, done){
  const turns=5+Math.floor(Math.random()*3);
  let target=finalAngle;
  while(target<state.angle+turns*2*Math.PI) target+=2*Math.PI;
  const startA=state.angle, delta=target-startA, dur=4200, t0=performance.now();
  function frame(now){
    const t=Math.min((now-t0)/dur,1), eased=1-Math.pow(1-t,4);
    state.angle=startA+delta*eased;
    draw();
    if(t<1) requestAnimationFrame(frame); else done();
  }
  requestAnimationFrame(frame);
}

function processQueue(){
  if(state.spinning||queue.length===0) return;
  doSpin(queue.shift());
}

// force: Test buttons bypass the app-wide concurrent-sound cap so a click
// always makes a noise, even mid-spin.
function playSound(force){
  if(!soundSettings.enabled||!soundSettings.path) return;
  winnerAudio = playAudioFile(soundSettings.path, {
    force: !!force,
    onError: ()=> showSoundWarn('Sound file missing or incompatible.'),
  });
}
function showSoundWarn(m){ const w=$('wSoundWarn'); if(w){ w.textContent='⚠ '+m; w.style.display='block'; }}

// Spin SFX — plays once when a spin starts, stopped when the wheel lands.
function playSpinSound(){
  stopSpinSound();
  if(!spinSoundSettings.enabled||!spinSoundSettings.path) return;
  // Sustained: it plays for the length of the spin and is stopped on landing,
  // so it's exempt from the concurrent cap rather than hogging a slot.
  spinAudio = playAudioFile(spinSoundSettings.path, {
    loop: false, force: true,
    onError: ()=>{ const w=$('wSpinSoundWarn'); if(w){ w.textContent='⚠ Spin sound missing or incompatible.'; w.style.display='block'; }},
  });
}
function stopSpinSound(){
  if(spinAudio){ spinAudio.stop(); spinAudio=null; }
}

// Post the winner to Twitch chat if enabled. {winner} and {spinner} are substituted.
function announceWinner(winnerName, redeemer){
  if(!announceSettings.enabled) return;
  if(!store.twitch.connected){ return; }
  let msg = (announceSettings.message||'').replace(/\{winner\}/gi, winnerName).replace(/\{spinner\}/gi, redeemer||'').replace(/\s+/g,' ').trim();
  if(!msg) return;
  const w=$('wAnnounceWarn'); if(w) w.style.display='none';
  invoke('twitch_send_chat_message',{ message: msg }).catch(e=>{
    if(w){ w.textContent='⚠ Chat: '+e; w.style.display='block'; }
  });
}

// ── Saved lists ────────────────────────────────────────────────────────────────
function refreshListSelect(){
  const sel=$('wListSelect'); if(!sel) return;
  const names=Object.keys(lists);
  sel.innerHTML=names.length?names.map(n=>`<option ${n===activeListName?'selected':''}>${esc(n)}</option>`)
    .join(''):'<option value="">(no saved lists)</option>';
  const tag=$('wActiveListTag'); if(tag) tag.textContent=activeListName||'no list';
}
function loadList(name){
  const L=lists[name]; if(!L) return;
  activeListName=name;
  state.items=(L.items||[]).map(x=>({...x}));
  state.fullItems=(L.fullItems||L.items||[]).map(x=>({...x}));
  state.themeName=L.themeName||'Neon';
  state.customColors=L.customColors||null;
  pendingRemoval=null; $('wheelWinner').innerHTML='';
  const sel=$('wThemeSelect'); if(sel) sel.value=state.themeName;
  const bi=$('wBulkInput'); if(bi) bi.value='';
  refreshListSelect(); render();
}

// ── Build left column HTML ─────────────────────────────────────────────────────
function buildLeftColumn(){
  const el=$('wheelLeft'); if(!el) return;
  el.innerHTML=`
  <div class="card">
    <h2>Saved Lists</h2>
    <div class="row"><select id="wListSelect" style="flex:1"></select><button class="btn-sm" id="wLoadBtn">Load</button></div>
    <div class="row mt"><input type="text" id="wNewListName" placeholder="New list name…" style="flex:1"><button class="btn-sm btn-gold" id="wSaveBtn">Save</button></div>
    <div class="row mt"><button class="btn-sm btn-ghost" id="wRenameBtn">Rename</button><button class="btn-sm btn-ghost" id="wDeleteBtn">Delete</button><span class="spacer"></span><span class="tag" id="wActiveListTag">no list</span></div>
  </div>
  <div class="card">
    <h2>Subjects</h2>
    <label for="wBulkInput">Bulk add (one per line)</label>
    <textarea id="wBulkInput" placeholder="Math&#10;History&#10;Science"></textarea>
    <div class="row mt"><button class="btn-sm btn-gold" id="wSetBtn">Set wheel from list</button><button class="btn-sm" id="wAppendBtn">Append</button></div>
    <div class="row mt"><input type="text" id="wQuickAdd" placeholder="Add one subject…" style="flex:1"><button class="btn-sm" id="wQuickAddBtn">Add</button></div>
    <div id="wItemList" style="margin-top:10px"></div>
    <div class="row mt"><button class="btn-sm btn-ghost" id="wResetBtn">Reset to full list</button><label class="checkrow" style="margin:0"><input type="checkbox" id="wRemoveWinner" checked> Remove winner</label></div>
    <div class="hint" id="wFullListNote"></div>
  </div>
  <div class="card">
    <h2>Colour Theme</h2>
    <div class="row"><select id="wThemeSelect" style="flex:1"></select><button class="btn-sm" id="wApplyTheme">Apply</button></div>
    <div id="wThemePreview" style="display:flex;gap:3px;margin-top:8px;height:16px;border-radius:4px;overflow:hidden"></div>
    <div class="row mt"><input type="text" id="wCustomColors" placeholder="#ff5d73,#ffc83d,…" style="flex:1"><button class="btn-sm" id="wCustomBtn">Use</button></div>
  </div>
  <div class="card">
    <h2>Winner Sound</h2>
    <label class="checkrow" style="margin-top:0"><input type="checkbox" id="wSoundEnabled"> Play sound on win</label>
    <div class="row mt"><button class="btn-sm" id="wPickSound">Choose MP3…</button><button class="btn-sm btn-ghost" id="wTestSound">Test</button><button class="btn-sm btn-ghost" id="wClearSound">Clear</button></div>
    <div class="hint" id="wSoundPath">No file selected.</div>
    <div class="warn" id="wSoundWarn" style="display:none"></div>
  </div>
  <div class="card">
    <h2>Spin Sound</h2>
    <label class="checkrow" style="margin-top:0"><input type="checkbox" id="wSpinSoundEnabled"> Play sound while spinning</label>
    <div class="row mt"><button class="btn-sm" id="wPickSpinSound">Choose MP3…</button><button class="btn-sm btn-ghost" id="wTestSpinSound">Test</button><button class="btn-sm btn-ghost" id="wClearSpinSound">Clear</button></div>
    <div class="hint" id="wSpinSoundPath">No file selected.</div>
    <div class="warn" id="wSpinSoundWarn" style="display:none"></div>
  </div>
  <div class="card">
    <h2>Announce Winner in Chat</h2>
    <label class="checkrow" style="margin-top:0"><input type="checkbox" id="wAnnounceEnabled"> Post winner to Twitch chat</label>
    <label for="wAnnounceMsg" style="margin-top:8px">Message: <code>{winner}</code> = winner, <code>{spinner}</code> = who redeemed</label>
    <input type="text" id="wAnnounceMsg" placeholder="🎉 The wheel landed on {winner}!" style="width:100%">
    <div class="hint">Requires Twitch connected (Settings). Sends as your channel.</div>
    <div class="warn" id="wAnnounceWarn" style="display:none"></div>
  </div>
  <div class="card">
    <h2>OBS Overlay</h2>
    <label for="wWinnerSecs">Show winner for (seconds)</label>
    <input type="number" id="wWinnerSecs" min="1" max="60" value="5" style="width:80px">
  </div>
  <div class="card">
    <h2>Twitch: spin on redeem</h2>
    <label class="checkrow"><input type="checkbox" id="wUsePoints" checked> Channel point redeems</label>
    <div id="wRewardPick" class="mt">
      <div class="row"><select id="wRewardSelect" style="flex:1"></select><button class="btn-sm" id="wRefreshRewards">⟳</button></div>
      <label class="checkrow"><input type="checkbox" id="wAnyReward"> Any redeem triggers spin</label>
    </div>
    <div class="row mt"><button class="btn-sm btn-twitch" id="wListenBtn">Start listening</button><button class="btn-sm btn-ghost" id="wStopBtn">Stop</button></div>
    <div class="warn" id="wTwWarn" style="display:none"></div>
  </div>`;
  wireWheelEvents();
}

function wireWheelEvents(){
  // lists
  $('wSaveBtn').addEventListener('click',()=>{
    let name=$('wNewListName').value.trim()||activeListName;
    if(!name){alert('Enter a list name.');return;}
    const typed=$('wBulkInput').value.split('\n').map(s=>s.trim()).filter(Boolean);
    const si=typed.length?typed.map(n=>({name:n,weight:1})):state.items.map(x=>({...x}));
    const sf=typed.length?typed.map(n=>({name:n,weight:1})):(state.fullItems.length?state.fullItems:state.items).map(x=>({...x}));
    lists[name]={items:si,fullItems:sf,themeName:state.themeName,customColors:state.customColors};
    activeListName=name;$('wNewListName').value='';
    refreshListSelect();persist();flash($('wSaveBtn'),'Saved ✓');
  });
  $('wLoadBtn').addEventListener('click',()=>{ const n=$('wListSelect').value; if(n&&lists[n]) loadList(n); });
  $('wRenameBtn').addEventListener('click',()=>{
    if(!activeListName){alert('Load a list first.');return;}
    const nn=prompt('Rename to:',activeListName); if(!nn?.trim()) return;
    lists[nn.trim()]=lists[activeListName]; if(nn.trim()!==activeListName) delete lists[activeListName];
    activeListName=nn.trim(); refreshListSelect(); persist();
  });
  $('wDeleteBtn').addEventListener('click',()=>{
    if(!activeListName||!confirm(`Delete "${activeListName}"?`)) return;
    delete lists[activeListName]; activeListName=null; refreshListSelect(); persist();
  });
  // subjects
  $('wSetBtn').addEventListener('click',()=>{
    const lines=$('wBulkInput').value.split('\n').map(s=>s.trim()).filter(Boolean);
    if(lines.length<2){alert('Enter at least 2 subjects.');return;}
    state.items=lines.map(n=>({name:n,weight:1}));
    state.fullItems=state.items.map(x=>({...x}));
    pendingRemoval=null;$('wheelWinner').innerHTML='';render();
  });
  $('wAppendBtn').addEventListener('click',()=>{
    $('wBulkInput').value.split('\n').map(s=>s.trim()).filter(Boolean).forEach(n=>{
      state.items.push({name:n,weight:1});
      if(!state.fullItems.find(x=>x.name===n)) state.fullItems.push({name:n,weight:1});
    }); render();
  });
  $('wQuickAddBtn').addEventListener('click',quickAdd);
  $('wQuickAdd').addEventListener('keydown',e=>{ if(e.key==='Enter') quickAdd(); });
  function quickAdd(){ const v=$('wQuickAdd').value.trim();if(!v)return;state.items.push({name:v,weight:1});if(!state.fullItems.find(x=>x.name===v))state.fullItems.push({name:v,weight:1});$('wQuickAdd').value='';render(); }
  $('wResetBtn').addEventListener('click',()=>{
    if(!state.fullItems.length){alert('No full list saved yet.');return;}
    state.items=state.fullItems.map(x=>({...x}));pendingRemoval=null;$('wheelWinner').innerHTML='';render();
  });
  $('wRemoveWinner').addEventListener('change',e=>{ state.removeWinner=e.target.checked;persist(); });
  $('wItemList').addEventListener('click',e=>{
    const b=e.target.closest('button');if(!b||state.spinning)return;
    const i=+b.dataset.i,act=b.dataset.act;
    // Snap to exactly 1 when doubling/halving crosses it, so an item can
    // always get back to equal odds (0.0001 doublings never land on 1 otherwise).
    if(act==='inc'){
      const old=state.items[i].weight||1;
      let w=Math.min(16,old*2);
      if(old<1&&w>1) w=1;
      state.items[i].weight=w;
    } else if(act==='dec'){
      const old=state.items[i].weight||1;
      let w=Math.max(0.0001,old/2);
      if(old>1&&w<1) w=1;
      state.items[i].weight=w;
    }
    else if(act==='del') state.items.splice(i,1);
    render();
  });
  // theme
  const ts=$('wThemeSelect');
  defaultThemeNames().forEach(n=>{ const o=document.createElement('option');o.textContent=n;ts.appendChild(o); });
  ts.value=state.themeName;
  $('wApplyTheme').addEventListener('click',()=>{ state.themeName=ts.value;state.customColors=null;render(); });
  ts.addEventListener('change',()=>{ state.themeName=ts.value;state.customColors=null;render(); });
  $('wCustomBtn').addEventListener('click',()=>{
    const raw=$('wCustomColors').value.split(',').map(s=>s.trim()).filter(s=>/^#?[0-9a-fA-F]{6}$/.test(s)).map(s=>s.startsWith('#')?s:'#'+s);
    if(raw.length<2){alert('Enter at least 2 hex colours.');return;}
    state.customColors=raw;render();
  });
  // sound
  const dialog=window.__TAURI__.dialog;
  $('wPickSound').addEventListener('click',async()=>{
    const f=await dialog.open({multiple:false,filters:[{name:'Audio',extensions:['mp3','wav','ogg','m4a']}]});
    if(!f)return; soundSettings.path=f;soundSettings.enabled=true;$('wSoundEnabled').checked=true;
    $('wSoundPath').textContent=f;$('wSoundWarn').style.display='none';persist();
  });
  $('wClearSound').addEventListener('click',()=>{ soundSettings.path=null;soundSettings.enabled=false;$('wSoundEnabled').checked=false;$('wSoundPath').textContent='No file selected.';persist(); });
  $('wTestSound').addEventListener('click',()=>{ const p=soundSettings.path;soundSettings.enabled=true;playSound(true);soundSettings.enabled=!!p; });
  $('wSoundEnabled').addEventListener('change',e=>{ soundSettings.enabled=e.target.checked;persist(); });
  // spin sound
  $('wPickSpinSound').addEventListener('click',async()=>{
    const f=await dialog.open({multiple:false,filters:[{name:'Audio',extensions:['mp3','wav','ogg','m4a']}]});
    if(!f)return; spinSoundSettings.path=f;spinSoundSettings.enabled=true;$('wSpinSoundEnabled').checked=true;
    $('wSpinSoundPath').textContent=f;$('wSpinSoundWarn').style.display='none';persist();
  });
  $('wClearSpinSound').addEventListener('click',()=>{ spinSoundSettings.path=null;spinSoundSettings.enabled=false;$('wSpinSoundEnabled').checked=false;$('wSpinSoundPath').textContent='No file selected.';persist(); });
  $('wTestSpinSound').addEventListener('click',()=>{ const en=spinSoundSettings.enabled;spinSoundSettings.enabled=true;playSpinSound();spinSoundSettings.enabled=en; });
  $('wSpinSoundEnabled').addEventListener('change',e=>{ spinSoundSettings.enabled=e.target.checked;persist(); });
  // announce winner in chat
  $('wAnnounceEnabled').addEventListener('change',e=>{ announceSettings.enabled=e.target.checked;persist(); });
  $('wAnnounceMsg').addEventListener('input',e=>{ announceSettings.message=e.target.value;persist(); });
  // overlay settings
  $('wWinnerSecs').addEventListener('change',e=>{ let v=parseInt(e.target.value);if(isNaN(v)||v<1)v=1;if(v>60)v=60;e.target.value=v;overlaySettings.winnerSeconds=v;persist(); });
  // spin
  $('wSpinBtn').addEventListener('click',()=>doSpin());
  // twitch redeems
  $('wListenBtn').addEventListener('click',async()=>{
    try{ await invoke('twitch_connect_eventsub'); }catch(e){ const w=$('wTwWarn');w.textContent='⚠ '+e;w.style.display='block'; }
  });
  $('wStopBtn').addEventListener('click',()=>invoke('twitch_disconnect'));
  $('wRefreshRewards').addEventListener('click',loadRewards);
  $('wAnyReward').addEventListener('change',e=>{
    $('wRewardSelect').disabled=e.target.checked;
    redeemSettings.anyReward=e.target.checked; persist();
  });
  $('wUsePoints').addEventListener('change',e=>{ redeemSettings.usePoints=e.target.checked; persist(); });
  $('wRewardSelect').addEventListener('change',e=>{ redeemSettings.rewardId=e.target.value; persist(); });
  // overlay url bar
  renderOverlayBar('wOverlayMode','wOverlayUrl','wCopyUrl','wheel',store.overlayUrls);
  // redeem listener
  window.addEventListener('spark-redeem',e=>{
    const d=e.detail;
    if(!$('wUsePoints').checked) return;
    if(!$('wAnyReward').checked){
      // saved id is the source of truth — the dropdown may not be loaded yet
      const want=redeemSettings.rewardId||$('wRewardSelect').value;
      if(want && d.reward_id!==want) return;
    }
    if(toolBlocked('wheel', d.user_name)) return;
    queue.push(d.user_name||'someone');
    processQueue();
  });
}

async function loadRewards(){
  try{
    const r=await invoke('twitch_get_rewards');
    const sel=$('wRewardSelect');
    sel.innerHTML=(r.rewards||[]).map(rw=>`<option value="${rw.id}">${esc(rw.title)} (${rw.cost})</option>`).join('')||'<option value="">(no rewards)</option>';
    // Restore the saved selection instead of resetting to the first reward.
    // If the saved reward no longer exists, leave the browser default but
    // don't clobber the saved id — it may belong to a reward that comes back.
    if(redeemSettings.rewardId && [...sel.options].some(o=>o.value===redeemSettings.rewardId)){
      sel.value=redeemSettings.rewardId;
    }
    sel.disabled=redeemSettings.anyReward;
  }catch(e){ const w=$('wTwWarn');if(w){w.textContent='⚠ '+e;w.style.display='block';} }
}

function sizeCanvas(){
  const avail=Math.min(window.innerWidth-450, window.innerHeight-220);
  const s=Math.max(320,Math.min(520,avail));
  const c=canvas(); c.width=s;c.height=s;
  const ptr=$('wPointer'); if(ptr) ptr.style.top=(Math.max(56,s*0.16)-26)+'px';
}
window.addEventListener('resize',()=>{ sizeCanvas();draw(); });

export async function initWheel(){
  buildLeftColumn();
  // restore saved state
  const d=store.wheel;
  lists=d.lists||{};
  soundSettings=Object.assign({enabled:false,path:null},d.sound||{});
  spinSoundSettings=Object.assign({enabled:false,path:null},d.spinSound||{});
  announceSettings=Object.assign({enabled:false,message:'🎉 The wheel landed on {winner}!'},d.announce||{});
  overlaySettings=Object.assign({winnerSeconds:5},d.overlaySettings||{});
  redeemSettings=Object.assign({usePoints:true,anyReward:false,rewardId:''},d.redeem||{});
  $('wUsePoints').checked=redeemSettings.usePoints;
  $('wAnyReward').checked=redeemSettings.anyReward;
  $('wRewardSelect').disabled=redeemSettings.anyReward;
  if(d.activeState?.items?.length){
    state.items=d.activeState.items;state.fullItems=d.activeState.fullItems||[];
    state.themeName=d.activeState.themeName||'Neon';state.customColors=d.activeState.customColors||null;
    state.removeWinner=d.activeState.removeWinner!==false;
    activeListName=d.activeListName||null;
  }
  $('wRemoveWinner').checked=state.removeWinner;
  $('wSoundEnabled').checked=soundSettings.enabled;
  $('wSoundPath').textContent=soundSettings.path||'No file selected.';
  $('wSpinSoundEnabled').checked=spinSoundSettings.enabled;
  $('wSpinSoundPath').textContent=spinSoundSettings.path||'No file selected.';
  $('wAnnounceEnabled').checked=announceSettings.enabled;
  $('wAnnounceMsg').value=announceSettings.message||'';
  $('wWinnerSecs').value=overlaySettings.winnerSeconds;
  const ts=$('wThemeSelect'); if(ts) ts.value=state.themeName;
  refreshListSelect();
  sizeCanvas();
  render();
  if(store.twitch.connected) loadRewards();
  window.addEventListener('spark-twitch-status', e=>{ if(e.detail?.connected) loadRewards(); });
}
