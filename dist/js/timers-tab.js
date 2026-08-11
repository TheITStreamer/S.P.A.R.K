import { store, toolBlocked, toolEnabled } from './store.js';
import { $, esc, fmtTime, renderOverlayBar } from './utils.js';
import { playSound as playAudioFile } from './audio.js';
import { fontOptionsHtml, isCustomFont } from './fonts.js';

const { invoke } = window.__TAURI__.core;
const dialog = window.__TAURI__.dialog;

// Each timer: {id, name, duration, mode:'down'|'up', font, color,
//   startSound, endSound, endMessage, rewardId, anyRedeem, autoResume,
//   hideWhenIdle, _remaining, _running, _interval, _doneAt, wasRunning}
//
// Auto timers additionally carry {auto:true, autoText, nameTemplate, autoRemove,
// cfgId, cfgTitle, cfgColor}. Their number is NOT stored — it's derived from list
// position at render time so deleting one renumbers the rest without leaving
// stale labels behind.

let timers = [];
let savedTimers = [];

// One entry per channel point reward you want creating timers.
const CONFIG_DEFAULTS = {
  title:'Auto Timer', enabled:true, rewardId:'', duration:600,
  nameTemplate:'{text}', startMode:'immediate', // 'immediate' | 'command'
  font:'Roboto Mono', color:'#ffc83d', tagColor:'#ffc83d',
  startSound:null, endSound:null, endMessage:'',
  maxConcurrent:10, autoRemove:true, hideWhenIdle:false,
};
// Settings that apply across every config rather than per reward.
const GLOBAL_DEFAULTS = { numberOverlay:true, chatConfirm:true, overallMax:20 };

let autoConfigs = [];
let autoGlobal = { ...GLOBAL_DEFAULTS };

// Tag colours offered when adding a config, so a new one is distinguishable
// from the existing ones without the user having to pick a colour first.
const TAG_COLORS = ['#ffc83d','#66ccff','#43d17a','#ff8f4c','#c792ea','#ff6b9d','#4dd0c1','#f4d35e'];

function cfgById(id){ return autoConfigs.find(c=>c.id===id) || null; }

// Reads either the current multi-config shape or the earlier single-config one,
// so an existing setup carries over intact instead of silently resetting.
function loadAutoConfig(d){
  autoGlobal = { ...GLOBAL_DEFAULTS, ...(d.autoGlobal || {}) };
  if(Array.isArray(d.autoConfigs)){
    autoConfigs = d.autoConfigs.map(c=>({ ...CONFIG_DEFAULTS, ...c, id:c.id||uid() }));
    return;
  }
  const old = d.auto;
  if(old && typeof old === 'object'){
    const { numberOverlay, chatConfirm, ...rest } = old;
    if(numberOverlay!==undefined) autoGlobal.numberOverlay = numberOverlay;
    if(chatConfirm!==undefined)   autoGlobal.chatConfirm   = chatConfirm;
    autoConfigs = [{ ...CONFIG_DEFAULTS, ...rest, id:uid(), title:'Auto Timer' }];
    return;
  }
  autoConfigs = [];
}

let saveTimer_t = null;
function persist(){
  clearTimeout(saveTimer_t);
  saveTimer_t = setTimeout(()=>{
    const active = timers.map(t=>({
      id:t.id, name:t.name, duration:t.duration, mode:t.mode,
      font:t.font, color:t.color,
      startSound:t.startSound, endSound:t.endSound,
      endMessage:t.endMessage, rewardId:t.rewardId, anyRedeem:t.anyRedeem,
      autoResume:t.autoResume||false, hideWhenIdle:t.hideWhenIdle||false,
      auto:t.auto||false, autoText:t.autoText||'',
      nameTemplate:t.nameTemplate||'', autoRemove:t.autoRemove||false,
      cfgId:t.cfgId||'', cfgTitle:t.cfgTitle||'', cfgColor:t.cfgColor||'',
      remaining:t._remaining, wasRunning:t._running,
    }));
    invoke('save_timers',{ data:{
      saved:savedTimers, active,
      autoConfigs, autoGlobal,
    }});
  },300);
  pushOverlay();
}
function pushOverlay(){
  // `at` lets the overlay tick locally between pushes — SPARK only sends
  // state changes (start/pause/reset/finish), not one push per second.
  const now = Date.now();
  // "Only show while running" keeps an idle or paused timer off stream, but a
  // timer that has just finished still goes out: the overlay lingers on it for
  // ten seconds so the end message can be read.
  // Numbering comes from list position across every timer, so the index is
  // taken before the hidden ones are dropped.
  const active = timers
    .map((t,i)=>({ t, i }))
    .filter(({t}) => !(t.hideWhenIdle && !t._running
                       && !(t._doneAt && now - t._doneAt < 12000)))
    .map(({t,i})=>({
      id:t.id, name:overlayName(t,i), remaining:t._remaining, duration:t.duration,
      mode:t.mode, font:t.font, color:t.color, running:t._running,
      endMessage:t.endMessage, at: now,
    }));
  invoke('timers_overlay_update',{ timers: active });
}

function uid(){ return Math.random().toString(36).slice(2,10); }

// ── Numbering ─────────────────────────────────────────────────────────────────
// Numbers are always the live 1..N position in `timers`, resolved on every
// render. Nothing numeric is baked into a timer's stored name, so !dtm 2 can
// renumber everything after it without leaving a card labelled with a number
// that no longer addresses it.
function numOf(t){ return timers.indexOf(t) + 1; }

// Label shown in the app and pushed to the overlay. Auto timers resolve their
// template here; manual timers just use their name.
function displayName(t, i){
  const n = (i==null ? numOf(t) : i+1);
  if(!t.auto) return t.name || '';
  const tpl = t.nameTemplate || '{text}';
  return tpl.replace(/\{n\}/g, n)
            .replace(/\{text\}/g, t.autoText || '')
            .replace(/\{title\}/g, t.cfgTitle || '')
            .trim();
}

function overlayName(t, i){
  const n = (i==null ? numOf(t) : i+1);
  const base = displayName(t, i);
  // Only prefix when the template hasn't already placed the number itself.
  const hasN = t.auto && /\{n\}/.test(t.nameTemplate || '');
  return (autoGlobal.numberOverlay && !hasN) ? `${n}. ${base}` : base;
}

function say(msg){
  if(!autoGlobal.chatConfirm || !msg) return;
  invoke('twitch_send_chat_message',{ message: msg }).catch(()=>{});
}

function startTimer(t){
  if(t._running) return;
  if(t.startSound) playAudioFile(t.startSound);
  t._running=true;
  t._doneAt=null;   // no longer in the post-finish window a hidden timer rides on
  // Timestamp-based ticking (like the pomodoro): a throttled/late interval
  // can't drift the clock — remaining is always derived from wall time, so
  // the app matches the overlay even if the window is minimized for minutes.
  if(t.mode==='down') t._endsAt   = Date.now() + t._remaining*1000;
  else                t._startedAt = Date.now() - t._remaining*1000;
  t._interval=setInterval(()=>{
    const prev=t._remaining;
    if(t.mode==='down'){
      t._remaining=Math.max(0,Math.round((t._endsAt-Date.now())/1000));
      if(t._remaining===0){ finishTimer(t); return; }
    } else {
      t._remaining=Math.max(0,Math.round((Date.now()-t._startedAt)/1000));
    }
    // Cheap update: only the time text, and only when the second changes —
    // no innerHTML rebuild / listener re-wiring per tick.
    if(t._remaining!==prev) tickTimerCard(t);
  },250);
  renderTimerCard(t);
  persist();
}

// Text-only refresh for the running tick (card + right-column preview).
function tickTimerCard(t){
  const card=$(`card-${t.id}`);
  const d=card&&card.querySelector('.timer-display');
  if(d) d.textContent=fmtTime(t._remaining);
  const prev=$('tmPreview');
  const pv=prev&&prev.querySelector(`[data-prev="${t.id}"] .tm-preview-time`);
  if(pv) pv.textContent=fmtTime(t._remaining);
}

function pauseTimer(t){
  if(!t._running) return;
  // Snapshot remaining from wall time before stopping
  if(t.mode==='down' && t._endsAt)    t._remaining=Math.max(0,Math.round((t._endsAt-Date.now())/1000));
  if(t.mode==='up'   && t._startedAt) t._remaining=Math.max(0,Math.round((Date.now()-t._startedAt)/1000));
  t._running=false; clearInterval(t._interval); renderTimerCard(t);
  persist();
}

function resetTimer(t){
  pauseTimer(t);
  t._doneAt=null;
  t._remaining = t.mode==='down' ? t.duration : 0;
  renderTimerCard(t); pushOverlay();
  persist();
}

// Commands tab: "Trigger a SPARK tool" -> Timers. A blank target means the
// first timer in the list, which is the sane default for anyone with one.
window.addEventListener('spark-action', e => {
  const d = e.detail || {};
  if(d.tool !== 'timers' || !toolEnabled('timers')) return;
  const want = String(d.target || '').toLowerCase();
  const t = want ? timers.find(x => String(x.name||'').toLowerCase() === want) : timers[0];
  if(!t) return;
  if(d.action === 'start')      startTimer(t);
  else if(d.action === 'pause') pauseTimer(t);
  else if(d.action === 'reset') resetTimer(t);
});

function finishTimer(t){
  t._running=false; clearInterval(t._interval);
  t._doneAt=Date.now();
  if(t.endSound) playAudioFile(t.endSound);
  pushOverlay();
  renderTimerCard(t);
  persist();
  // Auto timers can clean themselves up. Delay past the overlay's 10s linger so
  // the end message still gets its moment on stream before the card disappears.
  if(t.auto && t.autoRemove){
    setTimeout(()=>{
      if(!timers.includes(t) || t._running) return;
      removeTimer(t);
    }, 11000);
  }
}

function removeTimer(t){
  if(t._running){ t._running=false; clearInterval(t._interval); }
  const card=$(`card-${t.id}`); if(card) card.remove();
  const pc=$('tmPreview')&&$('tmPreview').querySelector(`[data-prev="${t.id}"]`);
  if(pc) pc.remove();
  timers = timers.filter(x=>x.id!==t.id);
  renderActiveList(); renderRightPreview(); renderConfigList(); pushOverlay(); persist();
}

// ── Build left column ──────────────────────────────────────────────────────────
function buildLeft(){
  const el=$('timersLeft'); if(!el) return;
  el.innerHTML=`
  <div class="card">
    <h2>New Timer</h2>
    <label>Name</label>
    <input type="text" id="tmName" placeholder="e.g. Break Timer">
    <label class="mt">Duration</label>
    <input type="text" id="tmDuration" placeholder="e.g. 5:00 or 1:30:00 or 1:12:00:00">
    <div class="hint">Format: mm:ss &nbsp;|&nbsp; h:mm:ss &nbsp;|&nbsp; d:h:mm:ss</div>
    <label class="mt">Mode</label>
    <select id="tmMode"><option value="down">Count down</option><option value="up">Count up (stopwatch)</option></select>
    <label class="mt">Font</label>
    <select id="tmFont">${fontOptionsHtml('Roboto Mono')}</select>
    <label class="mt">Text colour</label>
    <input type="color" id="tmColor" value="#ffc83d" style="width:60px;height:32px;border:none;background:none;cursor:pointer">
    <label class="mt">Start sound (optional)</label>
    <div class="row"><input type="text" id="tmStartSoundPath" placeholder="No file" readonly style="flex:1"><button class="btn-sm" id="tmPickStart">…</button><button class="btn-sm btn-ghost" id="tmClearStart">✕</button></div>
    <label class="mt">End sound (optional)</label>
    <div class="row"><input type="text" id="tmEndSoundPath" placeholder="No file" readonly style="flex:1"><button class="btn-sm" id="tmPickEnd">…</button><button class="btn-sm btn-ghost" id="tmClearEnd">✕</button></div>
    <label class="mt">End message (optional overlay text)</label>
    <input type="text" id="tmEndMsg" placeholder="Time's up!">
    <label class="mt">Trigger via channel point reward (optional)</label>
    <div class="row"><select id="tmRewardSelect" style="flex:1"></select><button class="btn-sm" id="tmRefreshRewards">⟳</button></div>
    <label class="checkrow"><input type="checkbox" id="tmAnyRedeem"> Any redeem starts this timer</label>
    <label class="checkrow mt"><input type="checkbox" id="tmAutoResume"> Auto-resume when SPARK opens</label>
    <div class="hint">Saves timer position between sessions and restarts automatically on open.</div>
    <label class="checkrow mt"><input type="checkbox" id="tmHideIdle"> Only show on overlay while running</label>
    <div class="hint">Keeps it off stream until it is counting. Paused hides it too. A finished timer still shows for ten seconds so its end message can be read.</div>
    <label class="hint">Or use chat command: <code>!timer &lt;name&gt;</code></label>
    <div class="row mt">
      <button class="btn-sm btn-gold full" id="tmAddBtn">＋ Add Timer</button>
      <button class="btn-sm full" id="tmSavePreset">Save as Preset</button>
    </div>
  </div>
  <div class="card">
    <h2>Auto Timers</h2>
    <div class="hint" style="margin-bottom:10px">Turn a channel point redeem into a brand new numbered timer. Whatever the viewer types becomes the label. Add one config per reward, so different redeems can each spawn their own kind of timer.</div>
    <div id="atConfigList"></div>
    <div class="row mt"><button class="btn-sm btn-gold full" id="atNewCfg">＋ New Auto Timer</button><button class="btn-sm" id="atRefreshRewards" title="Reload channel point rewards">⟳</button></div>
    <div style="margin-top:12px;padding:8px 10px;border-radius:8px;background:rgba(0,0,0,.2);font-size:.75rem;color:var(--muted)">
      <div id="atToolStatus" style="margin-bottom:6px"></div>
      <div id="atLastRedeem">No redeem seen yet this session.</div>
    </div>
    <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line, var(--line))">
      <div style="font-size:.75rem;color:var(--muted);font-weight:700;letter-spacing:.12em;text-transform:uppercase;margin-bottom:8px">Applies to all configs</div>
      <label class="mt">Overall limit across every config</label>
      <input type="number" id="atOverallMax" min="0" max="99" style="width:90px">
      <div class="hint">Stops the combined total from burying your overlay, whichever redeem is busy. 0 means no limit.</div>
      <label class="checkrow mt"><input type="checkbox" id="atNumberOverlay"> Show numbers on the overlay</label>
      <label class="checkrow"><input type="checkbox" id="atChatConfirm"> Confirm commands in chat</label>
    </div>
    <div class="hint" style="margin-top:12px">
      <strong>Chat commands</strong>, broadcaster and mods only:<br>
      <code>!stm &lt;n&gt;</code> start &nbsp; <code>!ptm &lt;n&gt;</code> pause &nbsp; <code>!rtm &lt;n&gt;</code> reset and restart<br>
      <code>!dtm &lt;n&gt;</code> delete &nbsp; <code>!ctm</code> clear all<br>
      Use <code>all</code> in place of a number for start, pause and reset.<br>
      Numbers run across every active timer, whichever config made it, including ones you added by hand.
    </div>
  </div>
  <div class="card">
    <h2>Saved Presets</h2>
    <div id="tmPresetList"></div>
  </div>
  <div class="card" style="margin-bottom:60px">
    <h2>Active Timers</h2>
    <div id="tmActiveList"></div>
  </div>`;
  wireTimerEvents();
  renderPresets();
  loadFontForInput();
}

let tmStartSoundFile=null, tmEndSoundFile=null;

function wireTimerEvents(){
  $('tmPickStart').addEventListener('click',async()=>{
    const f=await dialog.open({multiple:false,filters:[{name:'Audio',extensions:['mp3','wav','ogg','m4a']}]});
    if(f){ tmStartSoundFile=f; $('tmStartSoundPath').value=f; }
  });
  $('tmClearStart').addEventListener('click',()=>{ tmStartSoundFile=null; $('tmStartSoundPath').value=''; });
  $('tmPickEnd').addEventListener('click',async()=>{
    const f=await dialog.open({multiple:false,filters:[{name:'Audio',extensions:['mp3','wav','ogg','m4a']}]});
    if(f){ tmEndSoundFile=f; $('tmEndSoundPath').value=f; }
  });
  $('tmClearEnd').addEventListener('click',()=>{ tmEndSoundFile=null; $('tmEndSoundPath').value=''; });
  $('tmRefreshRewards').addEventListener('click',loadTimerRewards);
  $('tmAddBtn').addEventListener('click',addTimer);
  $('tmSavePreset').addEventListener('click',savePreset);
  wireAutoEvents();
  renderOverlayBar('tmOverlayMode','tmOverlayUrl','tmCopyUrl','timers',store.overlayUrls);
  // chat command: !timer <name>
  window.addEventListener('spark-chat',e=>{
    const d=e.detail;
    const msg=(d.message||'').trim();
    if(msg.toLowerCase().startsWith('!timer ')){
      if(toolBlocked('timers', d.display||d.username)) return;
      const name=msg.slice(7).trim().toLowerCase();
      const t=timers.find(x=>x.name.toLowerCase()===name);
      if(t){ resetTimer(t); startTimer(t); }
      return;
    }
    handleNumberCommand(d, msg);
  });
  // redeems
  window.addEventListener('spark-redeem',e=>{
    const d=e.detail;
    // Auto timers get first look, so a reward wired up here does not also
    // restart an existing timer that happens to share the same reward id.
    // If two configs point at the same reward, only the first one fires.
    const cfg=autoConfigs.find(c=>c.enabled && c.rewardId && c.rewardId===d.reward_id);
    // Every outcome is written to the diagnostics panel, including thrown
    // errors, which are caught here so the listener survives them.
    if(cfg){
      try{
        if(toolBlocked('timers', d.user_name)){ noteRedeem(d, cfg, 'tool-off'); return; }
        const res=spawnAutoTimer(cfg, d.user_input||'');
        noteRedeem(d, cfg, res.ok ? 'created' : res.reason);
      }catch(err){
        console.error('auto timer spawn failed:', err);
        noteRedeem(d, cfg, 'error', (err && err.message) ? err.message : String(err));
      }
      return;
    }
    noteRedeem(d, null, 'no-match');
    const anyMatch=timers.some(t=>t.anyRedeem||(t.rewardId&&t.rewardId===d.reward_id));
    if(!anyMatch) return;
    if(toolBlocked('timers', d.user_name)) return;
    timers.forEach(t=>{
      if(t.anyRedeem||(t.rewardId&&t.rewardId===d.reward_id)){
        resetTimer(t); startTimer(t);
      }
    });
  });
}

// ── Auto timers ───────────────────────────────────────────────────────────────
function wireAutoEvents(){
  const bind=(id,ev,fn)=>{ const el=$(id); if(el) el.addEventListener(ev,fn); };

  $('atOverallMax').value      = autoGlobal.overallMax;
  $('atNumberOverlay').checked = autoGlobal.numberOverlay;
  $('atChatConfirm').checked   = autoGlobal.chatConfirm;

  const saveGlobals=()=>{
    autoGlobal.overallMax    = Math.max(0, parseInt($('atOverallMax').value) || 0);
    autoGlobal.numberOverlay = $('atNumberOverlay').checked;
    autoGlobal.chatConfirm   = $('atChatConfirm').checked;
    pushOverlay();  // number prefixes may have just been switched on or off
    persist();
  };
  ['atOverallMax','atNumberOverlay','atChatConfirm'].forEach(id=>bind(id,'change',saveGlobals));

  bind('atRefreshRewards','click',loadTimerRewards);
  bind('atNewCfg','click',()=>{
    const cfg={
      ...CONFIG_DEFAULTS, id:uid(),
      title:`Auto Timer ${autoConfigs.length+1}`,
      tagColor:TAG_COLORS[autoConfigs.length % TAG_COLORS.length],
      color:TAG_COLORS[autoConfigs.length % TAG_COLORS.length],
    };
    autoConfigs.push(cfg);
    renderConfigList(); persist();
    openConfigEditor(cfg);
  });

  renderConfigList();
  renderLastRedeem();
  // The Settings tab owns the tool toggle and does not announce changes, so the
  // status line re-reads it rather than trusting a value captured at boot.
  setInterval(renderToolStatus, 2000);
}

// ── Redeem diagnostics ────────────────────────────────────────────────────────
let lastRedeem = null;

function noteRedeem(d, cfg, outcome, error){
  lastRedeem = {
    at: new Date(),
    rewardId: d.reward_id || '',
    rewardTitle: d.reward_title || '',
    user: d.user_name || '',
    text: (d.user_input || '').trim(),
    matched: cfg ? cfg.title : null,
    outcome, error,
  };
  renderLastRedeem();
}

// Called by the tab's own settings render so the tool status line cannot go
// stale while the user is looking at it.
function refreshRedeemPanel(){ renderLastRedeem(); }

// What to tell the user for every way a matched redeem can end without a timer.
const OUTCOMES = {
  created:  { colour:'#43d17a', title:'Timer created', detail:'' },
  'tool-off': { colour:'#ff8f4c', title:'Blocked: Timers are switched off',
    detail:'The redeem matched, but the <strong>Timers</strong> tool is turned off under Tool Availability in the Settings tab. Tick it and the next redeem will work.' },
  'no-text': { colour:'#ff8f4c', title:'Blocked: nothing typed',
    detail:'The viewer typed nothing, so there was no label. Tick <strong>Require viewer to enter text</strong> on this reward in your Twitch dashboard.' },
  'cap-config': { colour:'#ff8f4c', title:'Blocked: this config is full',
    detail:'It has hit its own limit. Raise it in Edit, or clear some timers with !dtm or !ctm.' },
  'cap-overall': { colour:'#ff8f4c', title:'Blocked: overall limit reached',
    detail:'The combined total across every config is at the overall limit. Raise it below, or clear some timers.' },
};

// Renders the tool-availability value the redeem path actually reads, which can
// differ from the Settings checkbox until that tab's Save is pressed. Lives in
// its own element so redrawing it leaves the reward-assign controls below intact.
function renderToolStatus(){
  const el=$('atToolStatus'); if(!el) return;
  // A read failure is reported in place rather than thrown, since this element
  // is where errors surface.
  try{
    el.innerHTML = toolEnabled('timers')
      ? '<span style="color:#43d17a">Timers tool: on</span>'
      : '<span style="color:#ff8f4c">Timers tool: OFF. Tick Timers under Tool Availability in the Settings tab.</span>';
  }catch(err){
    el.innerHTML = `<span style="color:#ff6b6b">Could not read the tool setting: ${esc((err&&err.message)||String(err))}</span>`;
  }
}

function renderLastRedeem(){
  try{ renderToolStatus(); }catch(e){}
  const el=$('atLastRedeem'); if(!el) return;
  if(!lastRedeem){ el.textContent='No redeem seen yet this session.'; return; }
  const r=lastRedeem;
  const time=r.at.toLocaleTimeString();
  if(r.outcome==='error'){
    el.innerHTML=`<strong style="color:#ff6b6b">Something threw while handling the redeem</strong> ${time}<br>`
      +`${esc(r.rewardTitle||r.rewardId)}<br><span style="color:#ff6b6b">${esc(r.error||'')}</span>`;
    return;
  }
  el.innerHTML=lastRedeemBody(r, time);
  wireAssignButton();
}

function lastRedeemBody(r, time){
  if(r.matched){
    const o=OUTCOMES[r.outcome] || { colour:'#ff8f4c', title:'Blocked', detail:'' };
    return `<strong style="color:${o.colour}">${o.title}</strong> ${time}<br>`
      +`${esc(r.rewardTitle||r.rewardId)} matched "${esc(r.matched)}"`
      +(o.detail?`<br><span style="color:${o.colour}">${o.detail}</span>`:'');
  }
  // Nothing matched. Show the id so it can be compared against the configs, and
  // offer to attach it directly rather than hunting through the dropdown.
  const assign=autoConfigs.length
    ? `<div class="row mt"><select id="atAssignCfg" style="flex:1">${autoConfigs.map(c=>`<option value="${c.id}">${esc(c.title)}</option>`).join('')}</select><button class="btn-sm" id="atAssignBtn">Use this reward</button></div>`
    : '<div style="margin-top:6px">Add an auto timer first, then redeem again to attach it.</div>';
  return `<strong style="color:#ff8f4c">Last redeem matched no config</strong> ${time}<br>`
    +`${esc(r.rewardTitle||'(untitled reward)')}<br>`
    +`<span style="opacity:.8">id ${esc(r.rewardId||'none')}</span>`
    +(r.text?` &nbsp;|&nbsp; typed "${esc(r.text)}"`:' &nbsp;|&nbsp; <span style="color:#ff8f4c">nothing typed</span>')
    +assign;
}

// Wired after the body is in the DOM, since the button only exists for the
// unmatched case.
function wireAssignButton(){
  const btn=$('atAssignBtn'); if(!btn || !lastRedeem) return;
  const r=lastRedeem;
  btn.addEventListener('click',()=>{
    const c=cfgById($('atAssignCfg').value); if(!c) return;
    c.rewardId=r.rewardId;
    c._rewardTitle=r.rewardTitle||r.rewardId;
    c.enabled=true;
    renderConfigList(); persist();
    const el=$('atLastRedeem');
    if(el) el.innerHTML=`<strong style="color:#43d17a">Linked</strong> "${esc(c.title)}" now answers ${esc(c._rewardTitle)}. Redeem again to test.`;
  });
}

function configRowHtml(cfg){
  const live = timers.filter(t=>t.cfgId===cfg.id).length;
  // An unlinked config looks identical to a working one until a redeem silently
  // does nothing, so it says so in orange rather than hiding in the detail line.
  const reward = cfg.rewardId
    ? esc(cfg._rewardTitle || 'reward set')
    : '<span style="color:#ff8f4c;font-weight:600">no reward linked yet</span>';
  return `<div class="timer-card" id="atcfg-${cfg.id}" style="border-left:3px solid ${cfg.tagColor||'#ffc83d'}">
    <div class="timer-name-row">
      <span style="flex:1;font-weight:600">${esc(cfg.title||'Untitled')}</span>
      ${cfg.enabled?'':'<span class="tag" style="color:#ff8f4c;border:1px solid #ff8f4c">disabled</span>'}
      <button class="btn-sm" data-attest="${cfg.id}">Test</button>
      <button class="btn-sm btn-ghost" data-atedit="${cfg.id}">Edit</button>
      <button class="btn-sm btn-ghost" data-atdel="${cfg.id}">✕</button>
    </div>
    <div class="hint">${reward} &nbsp;|&nbsp; ${fmtTime(cfg.duration)} &nbsp;|&nbsp; ${cfg.startMode==='immediate'?'starts at once':'waits for !stm'}</div>
    <div class="hint">${live} active &nbsp;|&nbsp; limit ${cfg.maxConcurrent||'none'}</div>
  </div>`;
}

function renderConfigList(){
  const el=$('atConfigList'); if(!el) return;
  if(!autoConfigs.length){
    el.innerHTML='<div class="hint">No auto timers set up yet. Add one to link a reward.</div>';
    return;
  }
  el.innerHTML=autoConfigs.map(configRowHtml).join('');
  el.querySelectorAll('button[data-atdel]').forEach(b=>b.addEventListener('click',()=>{
    autoConfigs=autoConfigs.filter(c=>c.id!==b.dataset.atdel);
    renderConfigList(); persist();
  }));
  el.querySelectorAll('button[data-atedit]').forEach(b=>b.addEventListener('click',()=>{
    const c=cfgById(b.dataset.atedit); if(c) openConfigEditor(c);
  }));
  el.querySelectorAll('button[data-attest]').forEach(b=>b.addEventListener('click',()=>{
    const c=cfgById(b.dataset.attest); if(c) spawnAutoTimer(c, `Test ${new Date().toLocaleTimeString()}`);
  }));
}

function openConfigEditor(cfg){
  try{
    document.getElementById('atEditorModal')?.remove();
    const modal=document.createElement('div');
    modal.id='atEditorModal';
    modal.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:9999;display:flex;align-items:center;justify-content:center';
    let startSfx=cfg.startSound, endSfx=cfg.endSound;
    const fname=p=>p?p.split(/[\\/]/).pop():'No file';
    const btnP='font-family:inherit;cursor:pointer;border:none;border-radius:8px;font-size:.85rem;font-weight:600;padding:8px 14px;color:#fff;background:var(--btn)';
    const btnG='font-family:inherit;cursor:pointer;border:1px solid var(--line);border-radius:8px;font-size:.85rem;padding:8px 14px;color:var(--muted);background:transparent';
    modal.innerHTML='<div style="background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:22px;width:560px;max-height:90vh;overflow-y:auto;position:relative">'
      +'<button id="atEdClose" style="position:absolute;top:12px;right:14px;background:none;border:none;color:var(--muted);font-size:1.5rem;cursor:pointer">x</button>'
      +'<div style="font-size:.7rem;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);font-weight:700;margin-bottom:16px">Editing: '+esc(cfg.title||'')+'</div>'
      +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">'
        +'<div><label>Title</label><input id="atEdTitle" type="text" value="'+esc(cfg.title||'')+'"></div>'
        +'<div><label>Channel point reward</label><select id="atEdReward"><option value="'+esc(cfg.rewardId||'')+'">'+esc(cfg._rewardTitle||cfg.rewardId||'Loading...')+'</option></select></div>'
      +'</div>'
      +'<div style="font-size:.72rem;color:var(--muted);margin-bottom:10px">The reward must have <strong>Require viewer to enter text</strong> ticked in your Twitch dashboard, otherwise there is nothing to label the timer with.</div>'
      +'<label style="display:flex;align-items:center;gap:8px;font-size:.85rem;cursor:pointer;margin-bottom:10px"><input type="checkbox" id="atEdEnabled" '+(cfg.enabled?'checked':'')+'>  Enabled</label>'
      +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">'
        +'<div><label>Duration</label><input id="atEdDuration" type="text" value="'+esc(fmtTime(cfg.duration))+'"><div style="font-size:.72rem;color:var(--muted);margin-top:3px">mm:ss | h:mm:ss | d:h:mm:ss</div></div>'
        +'<div><label>When created</label><select id="atEdStartMode"><option value="immediate" '+(cfg.startMode==='immediate'?'selected':'')+'>Start counting immediately</option><option value="command" '+(cfg.startMode==='command'?'selected':'')+'>Wait for !stm</option></select></div>'
      +'</div>'
      +'<div style="margin-bottom:10px"><label>Label template</label><input id="atEdTemplate" type="text" value="'+esc(cfg.nameTemplate||'{text}')+'"><div style="font-size:.72rem;color:var(--muted);margin-top:3px">{text} what the viewer typed | {n} timer number | {title} this config title</div></div>'
      +'<div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:10px;margin-bottom:10px">'
        +'<div><label>Font</label><select id="atEdFont">'+fontOptionsHtml(cfg.font||'Roboto Mono')+'</select></div>'
        +'<div><label>Text colour</label><input id="atEdColor" type="color" value="'+(cfg.color||'#ffc83d')+'" style="width:50px;height:32px;border:none;background:none;cursor:pointer"></div>'
        +'<div><label>Tag colour</label><input id="atEdTag" type="color" value="'+(cfg.tagColor||'#ffc83d')+'" style="width:50px;height:32px;border:none;background:none;cursor:pointer"></div>'
      +'</div>'
      +'<div style="margin-bottom:10px"><label>End message (optional overlay text)</label><input id="atEdEndMsg" type="text" value="'+esc(cfg.endMessage||'')+'"></div>'
      +'<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">'
        +'<button id="atEdPickStart" style="'+btnP+'">Start sound...</button>'
        +'<span id="atEdStartName" style="font-size:.78rem;color:var(--muted);flex:1;overflow:hidden;text-overflow:ellipsis">'+esc(fname(startSfx))+'</span>'
        +'<button id="atEdClearStart" style="'+btnG+'">Clear</button>'
      +'</div>'
      +'<div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">'
        +'<button id="atEdPickEnd" style="'+btnP+'">End sound...</button>'
        +'<span id="atEdEndName" style="font-size:.78rem;color:var(--muted);flex:1;overflow:hidden;text-overflow:ellipsis">'+esc(fname(endSfx))+'</span>'
        +'<button id="atEdClearEnd" style="'+btnG+'">Clear</button>'
      +'</div>'
      +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px;align-items:end">'
        +'<div><label>Max timers from this config</label><input id="atEdMax" type="number" min="0" max="99" value="'+(cfg.maxConcurrent||0)+'" style="width:90px"><div style="font-size:.72rem;color:var(--muted);margin-top:3px">0 means no limit of its own</div></div>'
        +'<label style="display:flex;align-items:center;gap:8px;font-size:.85rem;cursor:pointer"><input type="checkbox" id="atEdAutoRemove" '+(cfg.autoRemove?'checked':'')+'>  Remove once finished</label>'
      +'</div>'
      +'<label style="display:flex;align-items:center;gap:8px;font-size:.85rem;cursor:pointer;margin-bottom:6px"><input type="checkbox" id="atEdHideIdle" '+(cfg.hideWhenIdle?'checked':'')+'>  Only show on overlay while running</label>'
      +'<div style="font-size:.72rem;color:var(--muted);margin-bottom:16px">Timers from this config stay off stream until they are counting, which suits a config set to wait for !stm. A finished timer still shows for ten seconds so its end message can be read.</div>'
      +'<div style="display:flex;justify-content:flex-end;gap:8px">'
        +'<button id="atEdSave" style="font-family:inherit;cursor:pointer;border:none;border-radius:8px;font-size:.85rem;font-weight:600;padding:8px 14px;color:#2b1d00;background:#ffc83d">Save</button>'
        +'<button id="atEdCancel" style="'+btnG+'">Cancel</button>'
      +'</div>'
    +'</div>';
    document.body.appendChild(modal);

    invoke('twitch_get_rewards').then(r=>{
      const sel=document.getElementById('atEdReward'); if(!sel) return;
      sel.innerHTML='<option value="">(select reward)</option>'+(r.rewards||[]).map(rw=>'<option value="'+rw.id+'" '+(rw.id===cfg.rewardId?'selected':'')+'>'+esc(rw.title)+'</option>').join('');
    }).catch(()=>{});

    const pick=async()=>await dialog.open({multiple:false,filters:[{name:'Audio',extensions:['mp3','wav','ogg','m4a']}]});
    document.getElementById('atEdPickStart').addEventListener('click',async()=>{
      const f=await pick(); if(f){ startSfx=f; document.getElementById('atEdStartName').textContent=fname(f); }
    });
    document.getElementById('atEdClearStart').addEventListener('click',()=>{ startSfx=null; document.getElementById('atEdStartName').textContent='No file'; });
    document.getElementById('atEdPickEnd').addEventListener('click',async()=>{
      const f=await pick(); if(f){ endSfx=f; document.getElementById('atEdEndName').textContent=fname(f); }
    });
    document.getElementById('atEdClearEnd').addEventListener('click',()=>{ endSfx=null; document.getElementById('atEdEndName').textContent='No file'; });

    document.getElementById('atEdSave').addEventListener('click',()=>{
      const sel=document.getElementById('atEdReward');
      cfg.title        = document.getElementById('atEdTitle').value.trim() || cfg.title;
      // Only take the reward if the list actually loaded, otherwise a save while
      // Twitch is disconnected would clear the reward already chosen.
      if(sel.options.length>1 || sel.value) cfg.rewardId = sel.value;
      cfg._rewardTitle = sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : cfg._rewardTitle;
      cfg.enabled      = document.getElementById('atEdEnabled').checked;
      cfg.duration     = parseDuration(document.getElementById('atEdDuration').value || '600');
      cfg.startMode    = document.getElementById('atEdStartMode').value;
      cfg.nameTemplate = document.getElementById('atEdTemplate').value.trim() || '{text}';
      cfg.font         = document.getElementById('atEdFont').value.trim() || 'Roboto Mono';
      cfg.color        = document.getElementById('atEdColor').value;
      cfg.tagColor     = document.getElementById('atEdTag').value;
      cfg.endMessage   = document.getElementById('atEdEndMsg').value.trim();
      cfg.maxConcurrent= Math.max(0, parseInt(document.getElementById('atEdMax').value) || 0);
      cfg.autoRemove   = document.getElementById('atEdAutoRemove').checked;
      cfg.hideWhenIdle = document.getElementById('atEdHideIdle').checked;
      cfg.startSound   = startSfx;
      cfg.endSound     = endSfx;
      loadGoogleFont(cfg.font);
      // Live timers from this config follow the title and tag colour, but keep
      // the duration they were created with rather than jumping mid-countdown.
      timers.filter(t=>t.cfgId===cfg.id).forEach(t=>{
        t.cfgTitle=cfg.title; t.cfgColor=cfg.tagColor; t.nameTemplate=cfg.nameTemplate;
        t.hideWhenIdle=cfg.hideWhenIdle;
      });
      modal.remove();
      renderConfigList(); renderActiveList(); pushOverlay(); persist();
    });
    document.getElementById('atEdClose').addEventListener('click',()=>modal.remove());
    document.getElementById('atEdCancel').addEventListener('click',()=>modal.remove());
    modal.addEventListener('click',e=>{ if(e.target===modal) modal.remove(); });
  }catch(err){ console.error('openConfigEditor error:',err); }
}

// `text` is supplied directly by the Test button; a real redeem passes the
// viewer's input.
function spawnAutoTimer(cfg, text){
  text=(text||'').trim();
  if(!text){
    say(`"${cfg.title}" needs viewer text enabled on its reward before it can create a timer.`);
    return { ok:false, reason:'no-text' };
  }
  const mine=timers.filter(t=>t.cfgId===cfg.id).length;
  if(cfg.maxConcurrent>0 && mine>=cfg.maxConcurrent){
    say(`"${cfg.title}" is at its limit of ${cfg.maxConcurrent}. Clear some with !dtm or !ctm first.`);
    return { ok:false, reason:'cap-config' };
  }
  const total=timers.filter(t=>t.auto).length;
  if(autoGlobal.overallMax>0 && total>=autoGlobal.overallMax){
    say(`Overall auto timer limit reached (${autoGlobal.overallMax}). Clear some with !dtm or !ctm first.`);
    return { ok:false, reason:'cap-overall' };
  }
  const t={
    id:uid(),
    name:text,                       // fallback label if the template is emptied later
    auto:true, autoText:text, nameTemplate:cfg.nameTemplate,
    autoRemove:cfg.autoRemove,
    cfgId:cfg.id, cfgTitle:cfg.title, cfgColor:cfg.tagColor,
    duration:cfg.duration, mode:'down',
    font:cfg.font, color:cfg.color,
    startSound:cfg.startSound, endSound:cfg.endSound,
    endMessage:cfg.endMessage, rewardId:'', anyRedeem:false, autoResume:false,
    hideWhenIdle:!!cfg.hideWhenIdle,
    _remaining:cfg.duration, _running:false, _interval:null, _doneAt:null,
  };
  timers.push(t);
  loadGoogleFont(t.font);
  renderActiveList(); renderConfigList();
  if(cfg.startMode==='immediate') startTimer(t);
  else { pushOverlay(); persist(); }
  const n=numOf(t);
  say(cfg.startMode==='immediate'
    ? `⏱ Timer ${n} started: ${text} (${fmtTime(t.duration)})`
    : `⏱ Timer ${n} created: ${text}. Use !stm ${n} to start it.`);
  return { ok:true, timer:t };
}

// ── Numbered chat commands (broadcaster + mods only) ──────────────────────────
const NUM_CMDS={ '!stm':'start', '!ptm':'pause', '!rtm':'reset', '!dtm':'delete' };

function handleNumberCommand(d, msg){
  const parts=msg.split(/\s+/);
  const cmd=(parts[0]||'').toLowerCase();
  if(cmd!=='!ctm' && !(cmd in NUM_CMDS)) return;
  // Permission is checked before the tool-disabled notice so a regular viewer
  // typing !stm never triggers a "timers are off" message aimed at them.
  if(!(d.is_mod || d.is_broadcaster)) return;
  if(toolBlocked('timers', d.display||d.username)) return;

  if(cmd==='!ctm'){
    if(!timers.length){ say('No active timers to clear.'); return; }
    const n=timers.length;
    timers.forEach(t=>{ if(t._running){ t._running=false; clearInterval(t._interval); } });
    timers=[];
    renderActiveList(); renderRightPreview(); renderConfigList(); pushOverlay(); persist();
    say(`⏱ Cleared ${n} timer${n===1?'':'s'}.`);
    return;
  }

  const act=NUM_CMDS[cmd];
  const arg=(parts[1]||'').toLowerCase();
  if(!arg){ say(`Usage: ${cmd} <number>${act==='delete'?'':' or '+cmd+' all'}`); return; }

  if(arg==='all'){
    if(act==='delete'){ say('Use !ctm to remove every timer.'); return; }
    if(!timers.length){ say('No active timers.'); return; }
    // Snapshot first: reset/start mutate running state as we go.
    [...timers].forEach(t=>{
      if(act==='start') startTimer(t);
      else if(act==='pause') pauseTimer(t);
      else if(act==='reset'){ resetTimer(t); startTimer(t); }
    });
    say(`⏱ ${act==='start'?'Started':act==='pause'?'Paused':'Reset'} all ${timers.length} timers.`);
    return;
  }

  const n=parseInt(arg);
  if(!n || n<1 || n>timers.length){
    say(timers.length ? `No timer ${arg}. There ${timers.length===1?'is':'are'} only ${timers.length}.` : 'There are no active timers.');
    return;
  }
  const t=timers[n-1];
  const label=displayName(t);
  if(act==='start'){
    if(t._running){ say(`⏱ Timer ${n} is already running.`); return; }
    startTimer(t); say(`⏱ Timer ${n} started: ${label} (${fmtTime(t._remaining)})`);
  } else if(act==='pause'){
    if(!t._running){ say(`⏱ Timer ${n} is already paused.`); return; }
    pauseTimer(t); say(`⏱ Timer ${n} paused at ${fmtTime(t._remaining)}: ${label}`);
  } else if(act==='reset'){
    resetTimer(t); startTimer(t);
    say(`⏱ Timer ${n} reset: ${label} (${fmtTime(t.duration)})`);
  } else if(act==='delete'){
    removeTimer(t);
    say(`⏱ Timer ${n} removed: ${label}. Remaining timers renumbered.`);
  }
}

function parseDuration(str){
  str=str.trim();
  if(str.includes(':')){
    const parts=str.split(':').map(x=>parseInt(x)||0);
    if(parts.length===4) return parts[0]*86400+parts[1]*3600+parts[2]*60+parts[3]; // d:h:mm:ss
    if(parts.length===3) return parts[0]*3600+parts[1]*60+parts[2];                // h:mm:ss
    return parts[0]*60+(parts[1]||0);                                              // mm:ss
  }
  return parseInt(str)||0;
}

function addTimer(){
  const name=$('tmName').value.trim()||'Timer';
  const dur=parseDuration($('tmDuration').value||'300');
  const mode=$('tmMode').value;
  const font=$('tmFont').value.trim()||'Roboto Mono';
  const color=$('tmColor').value||'#ffc83d';
  const endMsg=$('tmEndMsg').value.trim();
  const rewardId=$('tmRewardSelect').value||'';
  const anyRedeem=$('tmAnyRedeem').checked;
  const autoResume=$('tmAutoResume').checked;
  const hideWhenIdle=$('tmHideIdle').checked;
  const t={
    id:uid(), name, duration:dur, mode, font, color,
    startSound:tmStartSoundFile, endSound:tmEndSoundFile,
    endMessage:endMsg, rewardId, anyRedeem, autoResume, hideWhenIdle,
    _remaining:mode==='down'?dur:0, _running:false, _interval:null, _doneAt:null,
  };
  timers.push(t);
  loadGoogleFont(font);
  renderActiveList();
  persist();
}

function savePreset(){
  const name=$('tmName').value.trim()||'Timer';
  const dur=parseDuration($('tmDuration').value||'300');
  const preset={
    id:uid(), name, duration:dur, mode:$('tmMode').value,
    font:$('tmFont').value.trim()||'Roboto Mono',
    color:$('tmColor').value||'#ffc83d',
    endMessage:$('tmEndMsg').value.trim(),
    startSound:tmStartSoundFile, endSound:tmEndSoundFile,
    rewardId:$('tmRewardSelect').value||'', anyRedeem:$('tmAnyRedeem').checked,
    autoResume:$('tmAutoResume').checked,
    hideWhenIdle:$('tmHideIdle').checked,
  };
  savedTimers.push(preset);
  persist();
  renderPresets();
}

function renderPresets(){
  const el=$('tmPresetList'); if(!el) return;
  if(!savedTimers.length){ el.innerHTML='<div class="hint">No presets saved.</div>'; return; }
  el.innerHTML=savedTimers.map((p,i)=>`
    <div class="timer-card">
      <div class="timer-name-row">
        <span style="flex:1;font-weight:600">${esc(p.name)}</span>
        <span class="tag">${fmtTime(p.duration)}</span>
        <button class="btn-sm btn-green" data-pi="${i}">▶ Add</button>
        <button class="btn-sm btn-ghost" data-di="${i}">✕</button>
      </div>
    </div>`).join('');
  el.querySelectorAll('button[data-pi]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const p={...savedTimers[+btn.dataset.pi]};
      const t={...p,id:uid(),_remaining:p.mode==='down'?p.duration:0,_running:false,_interval:null,_doneAt:null};
      timers.push(t); loadGoogleFont(t.font); renderActiveList(); persist();
    });
  });
  el.querySelectorAll('button[data-di]').forEach(btn=>{
    btn.addEventListener('click',()=>{ savedTimers.splice(+btn.dataset.di,1); persist(); renderPresets(); });
  });
}

function renderActiveList(){
  const el=$('tmActiveList'); if(!el) return;
  if(!timers.length){ el.innerHTML='<div class="hint">No active timers.</div>'; return; }
  const empty=el.querySelector('.hint'); if(empty) empty.remove();
  timers.forEach(t=>{ const ce=$(`card-${t.id}`); if(!ce) appendTimerCard(t); else renderTimerCard(t); });
  el.querySelectorAll('[data-timer-id]').forEach(card=>{
    if(!timers.find(t=>t.id===card.dataset.timerId)) card.remove();
  });
}

function appendTimerCard(t){
  const el=$('tmActiveList'); if(!el) return;
  const div=document.createElement('div');
  div.className='timer-card'; div.dataset.timerId=t.id; div.id=`card-${t.id}`;
  el.appendChild(div);
  renderTimerCard(t);
}

function renderTimerCard(t){
  const card=$(`card-${t.id}`); if(!card) return;
  const state=t._running?'Running':(t._remaining===0&&t.mode==='down'?'Done':'Paused');
  const n=numOf(t);
  const tag=t.auto&&t.cfgTitle
    ? `<span class="tag" style="background:${t.cfgColor||'#ffc83d'}22;color:${t.cfgColor||'#ffc83d'};border:1px solid ${t.cfgColor||'#ffc83d'}">${esc(t.cfgTitle)}</span>`
    : '';
  card.innerHTML=`
    <div class="timer-name-row">
      <span class="tag" style="background:#ffc83d;color:#1a1400;font-weight:800;min-width:22px;text-align:center" title="Use !stm ${n}, !rtm ${n} etc. in chat">${n}</span>
      <span style="flex:1;font-weight:600">${esc(displayName(t))}</span>
      ${tag}
      <span class="timer-state">${state}</span>
    </div>
    <div class="timer-display" style="font-family:'${t.font}',monospace;color:${t.color}">${fmtTime(t._remaining)}</div>
    <div class="timer-controls">
      <button class="btn-sm btn-green" data-act="start">Play</button>
      <button class="btn-sm" data-act="pause">Pause</button>
      <button class="btn-sm btn-ghost" data-act="reset">Reset</button>
      <button class="btn-sm btn-ghost" data-act="remove">Remove</button>
    </div>
    <label class="checkrow" style="font-size:.78rem;margin-top:6px">
      <input type="checkbox" data-act="autoresume" ${t.autoResume?'checked':''}> Auto-resume when SPARK opens
    </label>
    <label class="checkrow" style="font-size:.78rem">
      <input type="checkbox" data-act="hideidle" ${t.hideWhenIdle?'checked':''}> Only show on overlay while running
    </label>`;
  card.querySelectorAll('button[data-act]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const act=btn.dataset.act;
      if(act==='start') startTimer(t);
      else if(act==='pause') pauseTimer(t);
      else if(act==='reset') resetTimer(t);
      else if(act==='remove') removeTimer(t);
    });
  });
  const arCb=card.querySelector('[data-act="autoresume"]');
  if(arCb) arCb.addEventListener('change',()=>{ t.autoResume=arCb.checked; persist(); });
  const hiCb=card.querySelector('[data-act="hideidle"]');
  if(hiCb) hiCb.addEventListener('change',()=>{ t.hideWhenIdle=hiCb.checked; pushOverlay(); persist(); });
  renderRightPreview();
}

function renderRightPreview(){
  const el=$('tmPreview'); if(!el) return;
  if(!timers.length){ el.innerHTML='<div class="hint" style="color:var(--muted)">No active timers.</div>'; return; }
  const empty=el.querySelector('.hint'); if(empty) empty.remove();
  timers.forEach((t,i)=>{
    let pc=el.querySelector(`[data-prev="${t.id}"]`);
    if(!pc){
      pc=document.createElement('div');
      pc.className='tm-preview-card'; pc.dataset.prev=t.id;
      el.appendChild(pc);
    }
    const ptag=t.auto&&t.cfgTitle
      ? ` <span style="color:${t.cfgColor||'#ffc83d'};font-size:.72rem">${esc(t.cfgTitle)}</span>`
      : '';
    pc.innerHTML=`
      <div class="tm-preview-name"><span style="color:#ffc83d;font-weight:800">${i+1}.</span> ${esc(displayName(t,i))}${ptag}</div>
      <div class="tm-preview-time" style="font-family:'${t.font||'monospace'}',monospace;color:${t.color||'#ffc83d'}">${fmtTime(t._remaining)}</div>
      <div class="tm-preview-state">${t._running?'Running':(t._remaining===0&&t.mode==='down'?'Done':'Paused')}</div>`;
  });
  el.querySelectorAll('[data-prev]').forEach(pc=>{
    if(!timers.find(t=>t.id===pc.dataset.prev)) pc.remove();
  });
}

// fonts.js loads every built-in family once at boot and custom families come
// from /fonts.css, so this only has to cover a family that predates both —
// something typed into the free-text box this picker replaced.
function loadGoogleFont(font){
  if(!font) return;
  if(isCustomFont(font)) return; // an imported file, not a Google family
  const id='gfont-'+font.replace(/\s/g,'-');
  if(document.getElementById(id)) return;
  const link=document.createElement('link');
  link.id=id; link.rel='stylesheet';
  link.href=`https://fonts.googleapis.com/css2?family=${encodeURIComponent(font)}&display=swap`;
  document.head.appendChild(link);
}
function loadFontForInput(){
  const inp=$('tmFont'); if(!inp) return;
  inp.addEventListener('change',()=>loadGoogleFont(inp.value.trim()));
}

async function loadTimerRewards(){
  try{
    const r=await invoke('twitch_get_rewards');
    const rewards=r.rewards||[];
    const opts='<option value="">(none)</option>'+rewards.map(rw=>`<option value="${rw.id}">${esc(rw.title)}</option>`).join('');
    const sel=$('tmRewardSelect');
    if(sel){ const cur=sel.value; sel.innerHTML=opts; sel.value=cur; }
    // Cache reward names so the config rows can show something friendlier than a
    // raw id, and so they survive a restart before Twitch reconnects.
    let changed=false;
    autoConfigs.forEach(c=>{
      const rw=rewards.find(x=>x.id===c.rewardId);
      if(rw && c._rewardTitle!==rw.title){ c._rewardTitle=rw.title; changed=true; }
    });
    if(changed){ renderConfigList(); persist(); }
  }catch(e){}
}

export async function initTimers(){
  const d=store.timers;
  // Load config before buildLeft() so wireAutoEvents() can populate the fields.
  loadAutoConfig(d);
  buildLeft();
  savedTimers=(d.saved||[]);
  // Restore active timers from saved state
  const active=d.active||[];
  active.forEach(state=>{
    const t={
      ...state,
      _remaining: state.remaining ?? (state.mode==='down' ? state.duration : 0),
      _running: false, _interval: null,
    };
    timers.push(t);
    loadGoogleFont(t.font);
  });
  autoConfigs.forEach(c=>loadGoogleFont(c.font));
  renderPresets();
  renderActiveList();
  // Auto-resume timers that were running when SPARK closed
  timers.filter(t=>t.autoResume&&t.wasRunning).forEach(t=>startTimer(t));
  pushOverlay();
  if(store.twitch.connected) loadTimerRewards();
  window.addEventListener('spark-twitch-status', e=>{ if(e.detail?.connected) loadTimerRewards(); });
  // Periodic save every 30s while any timer is running
  setInterval(()=>{ if(timers.some(t=>t._running)) persist(); }, 30000);
}
