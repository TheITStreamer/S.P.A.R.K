import { store, toolBlocked } from './store.js';
import { $, esc, flash, renderOverlayBar } from './utils.js';
import { initPomodoro, renderPomodoroUI, pomoData, pomoTasksChanged } from './pomodoro.js';

const { invoke } = window.__TAURI__.core;

function defaultBox(headerColor, posMode){
  return {
    bg:'#140e28', bgOpacity:88,
    textColor:'var(--ink)', headerColor,
    borderColor:'#ffffff', borderWidth:1,
    shape:'rounded', borderRadius:14,
    fontSize:15, headerSize:11,
    width:320, padding:14,
    position:{ mode:posMode, x:20, y:20 },
  };
}

let cfg = {
  maxViewer:3, maxFollower:5, maxSubscriber:10,
  completedFade:true, fadeSecs:10,
  hostBox:   defaultBox('#ffc83d', 'top-left'),
  viewerBox: defaultBox('#b8aee0', 'top-right'),
  overlay: {
    font:'', rowSpacing:3, completedStyle:'strikethrough',
    separateBoxes:false,
    position:{ mode:'top-left', x:20, y:20 },
  },
};
let tasks = [];
let nextNum = 1;

const FONT_OPTIONS = [
  ['', 'Default (System)'],
  ['Inter','Inter'], ['Roboto','Roboto'], ['Open Sans','Open Sans'],
  ['Montserrat','Montserrat'], ['Poppins','Poppins'], ['Oswald','Oswald'],
  ['Raleway','Raleway'], ['Nunito','Nunito'], ['Rubik','Rubik'],
  ['Barlow','Barlow'], ['Kanit','Kanit'], ['Teko','Teko'],
  ['Archivo Black','Archivo Black'], ['Anton','Anton'], ['Bebas Neue','Bebas Neue'],
  ['Righteous','Righteous'], ['Bangers','Bangers'], ['Fredoka','Fredoka'],
  ['Comfortaa','Comfortaa'], ['Permanent Marker','Permanent Marker'], ['Pacifico','Pacifico'],
  ['Dancing Script','Dancing Script'], ['Caveat','Caveat'], ['Russo One','Russo One'],
  ['Orbitron','Orbitron'], ['Press Start 2P','Press Start 2P'], ['Playfair Display','Playfair Display'],
];

let fontsPreloaded = false;
function preloadFontOptions(){
  if(fontsPreloaded) return; fontsPreloaded=true;
  const families = FONT_OPTIONS.filter(([v])=>v).map(([v])=>`family=${encodeURIComponent(v)}`).join('&');
  const link=document.createElement('link');
  link.rel='stylesheet';
  link.href=`https://fonts.googleapis.com/css2?${families}&display=swap`;
  document.head.appendChild(link);
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function deepMerge(target, source){
  if(!source) return target;
  for(const k in source){
    const sv = source[k];
    if(sv && typeof sv==='object' && !Array.isArray(sv) && target[k] && typeof target[k]==='object'){
      deepMerge(target[k], sv);
    } else {
      target[k] = sv;
    }
  }
  return target;
}

function hostLabel(){
  const login = store.twitch && store.twitch.login;
  if(!login) return 'Host';
  return login.charAt(0).toUpperCase()+login.slice(1);
}

let saveTimer_k = null;
function persist(){
  clearTimeout(saveTimer_k);
  saveTimer_k = setTimeout(()=>{ invoke('save_tasks',{data:{cfg,tasks,nextNum,pomo:pomoData()}}); },300);
  pushOverlay();
}
function pushOverlay(){
  invoke('tasks_overlay_update',{state:{tasks,cfg,hostDisplay:hostLabel()}});
}

function uid(){ return Math.random().toString(36).slice(2,10); }

// Keep displayed numbers contiguous (1..N) whenever the task list changes,
// so removing a task doesn't leave gaps or push future numbers up forever.
function renumber(){
  tasks.forEach((t,i)=>{ t.num=i+1; });
  nextNum = tasks.length+1;
}

// ── Task operations ────────────────────────────────────────────────────────────
// In-flight guard: the awaited follower lookup yields, so two rapid
// "!task add" messages could both pass the limit check and go one over.
const addingTask = new Set();
async function addTask(username, userId, display, text, isMod, isSub, isBroadcaster){
  text = text.trim();
  if(!text) return;
  if(addingTask.has(userId)) return;
  addingTask.add(userId);
  try{ await doAddTask(username, userId, display, text, isMod, isSub, isBroadcaster); }
  finally{ addingTask.delete(userId); }
}
async function doAddTask(username, userId, display, text, isMod, isSub, isBroadcaster){
  const isHost = isBroadcaster;
  const userTasks = tasks.filter(t=>t.userId===userId&&!t.done);
  let limit = cfg.maxViewer;
  if(isHost||isMod){ limit=999; }
  else if(isSub){ limit=cfg.maxSubscriber; }
  else {
    try{
      const f=await invoke('twitch_check_follower',{userId,broadcasterId:store.twitch.userId});
      if(f) limit=cfg.maxFollower;
    }catch(e){}
  }
  if(userTasks.length>=limit) return;
  tasks.push({
    id:uid(), num:0, username, userId,
    display: display||username, text, done:false, doneAt:null,
    isHost: isHost||false,
  });
  renumber();
  renderTaskList(); persist();
}

function addHostTaskFromInput(){
  const inputEl = $('tkManualText');
  if(!inputEl) return;
  const v = inputEl.value.trim(); if(!v) return;
  tasks.push({
    id:uid(), num:0, username:'host', userId:'host',
    display: hostLabel(), text:v, done:false, doneAt:null, isHost:true,
  });
  renumber();
  inputEl.value=''; renderTaskList(); persist();
}

function doneTask(username, userId, num, isMod, isBroadcaster){
  const t = tasks.find(t=>t.num===num&&(t.userId===userId||isMod||isBroadcaster)&&!t.done);
  if(!t) return;
  t.done=true; t.doneAt=Date.now();
  renderTaskList(); persist();
  if(cfg.completedFade){
    setTimeout(()=>{ tasks=tasks.filter(x=>x.id!==t.id); renumber(); renderTaskList(); persist(); }, cfg.fadeSecs*1000);
  }
}

function removeUserTasks(username){
  tasks=tasks.filter(t=>t.username.toLowerCase()!==username.toLowerCase());
  renumber();
  renderTaskList(); persist();
}

function clearAllTasks(){
  tasks=[]; nextNum=1; renderTaskList(); persist();
}

// ── Render helpers ────────────────────────────────────────────────────────────
// Build a section block for a group of tasks
function sectionHtml(label, userTasks, isHost){
  const headerStyle = isHost
    ? 'color:var(--gold);font-weight:700;font-size:.8rem;letter-spacing:.12em;text-transform:uppercase;padding:6px 0 4px'
    : 'color:var(--muted);font-weight:600;font-size:.8rem;padding:6px 0 4px;border-top:1px solid var(--row-line);margin-top:4px';
  return `<div>
    <div style="${headerStyle}">${esc(label)}</div>
    ${userTasks.map(t=>`
      <div class="task-row${t.done?' task-done':''}">
        <span class="task-num">${t.num}</span>
        <span class="task-text">${esc(t.text)}</span>
        <button class="btn-sm btn-ghost" data-id="${t.id}">Remove</button>
      </div>`).join('')}
  </div>`;
}

function renderTaskList(){
  const el=$('taskListApp'); if(!el) return;

  if(!tasks.length){
    el.innerHTML='<div class="hint">No tasks yet. Viewers can use !task add &lt;task&gt;</div>';
    updateRightPreview();
    return;
  }

  // Separate host tasks from viewer tasks
  const hostTasks = tasks.filter(t=>t.isHost);
  const viewerTasks = tasks.filter(t=>!t.isHost);

  // Group viewer tasks by userId
  const groups = {};
  const order = [];
  viewerTasks.forEach(t=>{
    if(!groups[t.userId]){ groups[t.userId]={display:t.display,tasks:[]}; order.push(t.userId); }
    groups[t.userId].tasks.push(t);
  });

  let html='';
  // Host section always first
  if(hostTasks.length){
    html += sectionHtml(hostLabel(), hostTasks, true);
  }
  // Viewer groups
  order.forEach(uid=>{
    const g=groups[uid];
    html += sectionHtml('@'+g.display, g.tasks, false);
  });

  el.innerHTML=html;
  el.querySelectorAll('button[data-id]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      tasks=tasks.filter(t=>t.id!==btn.dataset.id);
      renumber();
      renderTaskList(); persist();
    });
  });

  updateRightPreview();
  pomoTasksChanged();
}

function updateRightPreview(){
  const prev=$('tkPreviewList'); if(!prev) return;
  if(!tasks.length){ prev.innerHTML='<div class="hint">No tasks yet.</div>'; return; }

  const hostTasks = tasks.filter(t=>t.isHost);
  const viewerTasks = tasks.filter(t=>!t.isHost);
  const groups={}, order=[];
  viewerTasks.forEach(t=>{
    if(!groups[t.userId]){ groups[t.userId]={display:t.display,tasks:[]}; order.push(t.userId); }
    groups[t.userId].tasks.push(t);
  });

  let html='';
  if(hostTasks.length){
    html+=`<div style="color:#ffc83d;font-size:.7rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;padding:4px 0 2px">${esc(hostLabel())}</div>`;
    html+=hostTasks.map(t=>`<div class="tk-prev-row${t.done?' tk-prev-done':''}"><span class="tk-prev-num">${t.num}</span><span class="tk-prev-text">${esc(t.text)}</span></div>`).join('');
    // Separator — only shown when host has tasks AND there's a viewer section to separate from
    if(!cfg.overlay.separateBoxes && order.length){
      html+=`<div style="border-top:${Math.max(1,cfg.hostBox.borderWidth)}px solid ${cfg.hostBox.borderColor};margin:6px 0;opacity:.5"></div>`;
    }
  }
  order.forEach(uid=>{
    const g=groups[uid];
    html+=`<div style="color:var(--muted);font-size:.72rem;font-weight:600;padding:4px 0 2px;border-top:1px solid rgba(255,255,255,.06);margin-top:2px">@${esc(g.display)}</div>`;
    html+=g.tasks.map(t=>`<div class="tk-prev-row${t.done?' tk-prev-done':''}"><span class="tk-prev-num">${t.num}</span><span class="tk-prev-user">@${esc(t.display)}</span><span class="tk-prev-text">${esc(t.text)}</span></div>`).join('');
  });
  prev.innerHTML=html;
}

// ── Visual settings field definitions ──────────────────────────────────────────
const BOX_FIELDS = [
  {key:'bg', label:'Background colour', type:'color'},
  {key:'bgOpacity', label:'Background opacity %', type:'number', min:0, max:100, w:70},
  {key:'textColor', label:'Text colour', type:'color'},
  {key:'headerColor', label:'Header colour', type:'color'},
  {key:'borderColor', label:'Border colour', type:'color'},
  {key:'borderWidth', label:'Border width (px)', type:'number', min:0, max:20, w:70},
  {key:'shape', label:'Shape', type:'select', options:[['rounded','Rounded'],['pill','Pill'],['square','Square'],['custom','Custom']]},
  {key:'borderRadius', label:'Border radius (px)', type:'number', min:0, max:200, w:70, showIf:b=>b.shape==='custom'},
  {key:'fontSize', label:'Task font size (px)', type:'number', min:8, max:48, w:70},
  {key:'headerSize', label:'Header font size (px)', type:'number', min:8, max:48, w:70},
  {key:'width', label:'Box width (px)', type:'number', min:100, max:1000, w:80},
  {key:'padding', label:'Padding (px)', type:'number', min:0, max:80, w:70},
];

const POS_OPTIONS = [['top-left','Top-Left'],['top-right','Top-Right'],['bottom-left','Bottom-Left'],['bottom-right','Bottom-Right'],['custom','Custom']];

function fieldRow(id, label, inputHtml){
  return `<div class="row mt"><label style="flex:1">${label}</label>${inputHtml}</div>`;
}

function boxFieldsHtml(prefix, box){
  return BOX_FIELDS.filter(f=>!f.showIf||f.showIf(box)).map(f=>{
    const id=`tk${prefix}_${f.key}`;
    let input;
    if(f.type==='color') input=`<input type="color" id="${id}" value="${box[f.key]}">`;
    else if(f.type==='number') input=`<input type="number" id="${id}" value="${box[f.key]}" min="${f.min}" max="${f.max}" style="width:${f.w}px">`;
    else if(f.type==='select') input=`<select id="${id}">${f.options.map(([v,l])=>`<option value="${v}"${box[f.key]===v?' selected':''}>${l}</option>`).join('')}</select>`;
    return fieldRow(id,f.label,input);
  }).join('');
}

function posFieldsHtml(prefix, pos){
  let html = fieldRow(`tk${prefix}_posMode`,'Position',
    `<select id="tk${prefix}_posMode">${POS_OPTIONS.map(([v,l])=>`<option value="${v}"${pos.mode===v?' selected':''}>${l}</option>`).join('')}</select>`);
  if(pos.mode==='custom'){
    html += fieldRow(`tk${prefix}_posX`,'X (px)',`<input type="number" id="tk${prefix}_posX" value="${pos.x}" style="width:70px">`);
    html += fieldRow(`tk${prefix}_posY`,'Y (px)',`<input type="number" id="tk${prefix}_posY" value="${pos.y}" style="width:70px">`);
  }
  return html;
}

function wireBoxFields(prefix, boxKey){
  BOX_FIELDS.forEach(f=>{
    const id=`tk${prefix}_${f.key}`;
    const elm=$(id); if(!elm) return;
    const evName = f.type==='color' ? 'input' : 'change';
    elm.addEventListener(evName, e=>{
      cfg[boxKey][f.key] = f.type==='number' ? +e.target.value : e.target.value;
      if(f.key==='shape'){ buildLeft(); renderTaskList(); }
      persist();
    });
  });
}

function wirePosFields(prefix, posObj){
  const modeEl=$(`tk${prefix}_posMode`);
  if(modeEl) modeEl.addEventListener('change', e=>{
    posObj.mode = e.target.value;
    buildLeft(); renderTaskList();
    persist();
  });
  const xEl=$(`tk${prefix}_posX`);
  if(xEl) xEl.addEventListener('change', e=>{ posObj.x=+e.target.value; persist(); });
  const yEl=$(`tk${prefix}_posY`);
  if(yEl) yEl.addEventListener('change', e=>{ posObj.y=+e.target.value; persist(); });
}

// ── Build UI ──────────────────────────────────────────────────────────────────
function buildLeft(){
  const el=$('tasksLeft'); if(!el) return;
  el.innerHTML=`
  <div id="pomoCard"></div>
  <div class="card">
    <h2>Controls</h2>
    <div class="row mb">
      <button class="btn-accent btn-sm" id="tkClearBtn">Clear all tasks</button>
    </div>
    <label class="checkrow"><input type="checkbox" id="tkFadeEnabled" checked> Fade completed tasks</label>
    <div class="row mt">
      <input type="number" id="tkFadeSecs" value="10" min="1" max="60" style="width:70px"> seconds
    </div>
  </div>
  <div class="card">
    <h2>Task Limits per user</h2>
    <label>Viewers</label><input type="number" id="tkMaxViewer" value="3" min="0" style="width:70px">
    <label class="mt">Followers</label><input type="number" id="tkMaxFollower" value="5" min="0" style="width:70px">
    <label class="mt">Subscribers</label><input type="number" id="tkMaxSub" value="10" min="0" style="width:70px">
    <div class="hint">Mods and broadcaster have no limit.</div>
  </div>
  <div class="card">
    <h2>Add host task</h2>
    <div class="row">
      <input type="text" id="tkManualText" placeholder="Your task…" style="flex:1">
      <button class="btn-sm btn-gold" id="tkManualAdd">Add</button>
    </div>
  </div>
  <div class="card">
    <h2>Visual Settings</h2>
    <label class="checkrow"><input type="checkbox" id="tkSeparateBoxes"${cfg.overlay.separateBoxes?' checked':''}> Separate host and viewer boxes</label>

    ${!cfg.overlay.separateBoxes ? `
    <div class="mt">
      <h3 style="margin:10px 0 4px;font-size:.8rem;opacity:.7">Combined box position</h3>
      ${posFieldsHtml('Combined', cfg.overlay.position)}
    </div>` : ''}

    <div class="mt">
      <h3 style="margin:12px 0 4px;font-size:.85rem">Host box</h3>
      ${boxFieldsHtml('Host', cfg.hostBox)}
      ${cfg.overlay.separateBoxes ? posFieldsHtml('Host', cfg.hostBox.position) : ''}
    </div>

    <div class="mt">
      <h3 style="margin:12px 0 4px;font-size:.85rem">Viewer box</h3>
      ${boxFieldsHtml('Viewer', cfg.viewerBox)}
      ${cfg.overlay.separateBoxes ? posFieldsHtml('Viewer', cfg.viewerBox.position) : ''}
    </div>

    <div class="mt">
      <h3 style="margin:12px 0 4px;font-size:.85rem">Global overlay</h3>
      <div class="row mt"><label style="flex:1">Font family</label>
        <select id="tkOverlayFont" style="min-width:160px">
          ${FONT_OPTIONS.map(([v,l])=>`<option value="${v}" style="font-family:'${v||'inherit'}'"${cfg.overlay.font===v?' selected':''}>${l}</option>`).join('')}
        </select>
      </div>
      <div class="row mt"><label style="flex:1">Row spacing (px)</label><input type="number" id="tkRowSpacing" value="${cfg.overlay.rowSpacing}" min="0" max="30" style="width:70px"></div>
      <div class="row mt"><label style="flex:1">Completed style</label>
        <select id="tkCompletedStyle">
          <option value="strikethrough"${cfg.overlay.completedStyle==='strikethrough'?' selected':''}>Strikethrough</option>
          <option value="fade"${cfg.overlay.completedStyle==='fade'?' selected':''}>Fade</option>
          <option value="hide"${cfg.overlay.completedStyle==='hide'?' selected':''}>Hide</option>
        </select>
      </div>
    </div>
  </div>
  <div class="card" style="margin-bottom:60px">
    <h2>Task List</h2>
    <div id="taskListApp"></div>
  </div>`;

  $('tkClearBtn').addEventListener('click',()=>{ if(confirm('Clear all tasks?')) clearAllTasks(); });
  $('tkFadeEnabled').addEventListener('change',e=>{ cfg.completedFade=e.target.checked; persist(); });
  $('tkFadeSecs').addEventListener('change',e=>{ cfg.fadeSecs=Math.max(1,+e.target.value); persist(); });
  $('tkMaxViewer').addEventListener('change',e=>{ cfg.maxViewer=Math.max(0,+e.target.value); persist(); });
  $('tkMaxFollower').addEventListener('change',e=>{ cfg.maxFollower=Math.max(0,+e.target.value); persist(); });
  $('tkMaxSub').addEventListener('change',e=>{ cfg.maxSubscriber=Math.max(0,+e.target.value); persist(); });
  $('tkManualAdd').addEventListener('click', addHostTaskFromInput);
  $('tkManualText').addEventListener('keydown', e=>{
    if(e.key==='Enter'){ e.preventDefault(); addHostTaskFromInput(); }
  });

  $('tkSeparateBoxes').addEventListener('change', e=>{
    cfg.overlay.separateBoxes = e.target.checked;
    buildLeft(); renderTaskList(); persist();
  });
  wireBoxFields('Host','hostBox');
  wireBoxFields('Viewer','viewerBox');
  if(!cfg.overlay.separateBoxes) wirePosFields('Combined', cfg.overlay.position);
  else {
    wirePosFields('Host', cfg.hostBox.position);
    wirePosFields('Viewer', cfg.viewerBox.position);
  }
  preloadFontOptions();
  $('tkOverlayFont').addEventListener('change', e=>{ cfg.overlay.font=e.target.value; persist(); });
  $('tkRowSpacing').addEventListener('change', e=>{ cfg.overlay.rowSpacing=Math.max(0,+e.target.value); persist(); });
  $('tkCompletedStyle').addEventListener('change', e=>{ cfg.overlay.completedStyle=e.target.value; persist(); });

  renderOverlayBar('tkOverlayMode','tkOverlayUrl','tkCopyUrl','tasks',store.overlayUrls);

  // Pomodoro overlay URL (standalone route — not part of master)
  const pu=$('pomoOverlayUrl');
  if(pu){
    pu.value=store.overlayUrls.pomodoro||'';
    const pb=$('pomoCopyUrl');
    if(pb) pb.addEventListener('click',()=>{ navigator.clipboard.writeText(pu.value); flash(pb,'Copied ✓'); });
  }

  renderPomodoroUI(); // pomoCard was just recreated
}

// Attached exactly once (buildLeft() re-runs on visual-setting changes and
// would otherwise register duplicate listeners, causing chat commands to fire multiple times).
let chatListenerAttached = false;
function attachChatListener(){
  if(chatListenerAttached) return;
  chatListenerAttached = true;
  window.addEventListener('spark-chat',e=>{
    const d=e.detail;
    const raw=(d.message||'').trim();
    const lower=raw.toLowerCase();
    const isMod=d.is_mod||d.is_broadcaster;
    if(lower.startsWith('!task')){ if(toolBlocked('tasks', d.display||d.username)) return; }
    if(lower.startsWith('!task add ')){
      const text=raw.slice(10).trim();
      addTask(d.username,d.user_id,d.display||d.username,text,d.is_mod,d.is_sub,d.is_broadcaster);
    } else if(lower.startsWith('!task done ')){
      const num=parseInt(raw.slice(11));
      if(!isNaN(num)) doneTask(d.username,d.user_id,num,isMod,d.is_broadcaster);
    } else if(isMod&&lower.startsWith('!task remove ')){
      removeUserTasks(raw.slice(13).replace(/^@/,'').trim());
    } else if(isMod&&lower==='!task clear'){
      clearAllTasks();
    }
  });
}

export async function initTasks(){
  const d=store.tasks;
  if(d.cfg) deepMerge(cfg, d.cfg);
  if(d.tasks) tasks=d.tasks;
  renumber(); // normalize any gaps in the saved numbering

  initPomodoro(d.pomo||null, {
    persist,
    getHostTasks: ()=>tasks.filter(t=>t.isHost&&!t.done),
    completeTask: (id)=>{
      const t=tasks.find(t=>t.id===id&&!t.done);
      if(!t) return;
      t.done=true; t.doneAt=Date.now();
      renderTaskList(); persist();
      if(cfg.completedFade){
        setTimeout(()=>{ tasks=tasks.filter(x=>x.id!==t.id); renumber(); renderTaskList(); persist(); }, cfg.fadeSecs*1000);
      }
    },
  });

  buildLeft();
  attachChatListener();
  if($('tkMaxViewer'))   $('tkMaxViewer').value=cfg.maxViewer;
  if($('tkMaxFollower')) $('tkMaxFollower').value=cfg.maxFollower;
  if($('tkMaxSub'))      $('tkMaxSub').value=cfg.maxSubscriber;
  if($('tkFadeEnabled')) $('tkFadeEnabled').checked=cfg.completedFade;
  if($('tkFadeSecs'))    $('tkFadeSecs').value=cfg.fadeSecs;
  renderTaskList();
}
