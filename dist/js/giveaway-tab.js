import { store, toolBlocked, toolEnabled, liveSet } from './store.js';
import { $, esc, flash, renderOverlayBar } from './utils.js';

const { invoke } = window.__TAURI__.core;

let cfg = {
  entryWord:'giveaway', allowViewer:true, allowFollower:true, allowSubscriber:true,
  multiEntry:false, maxEntries:3, cooldownSecs:60,
  showEntryCount:true, winnerSeconds:8,
  chatEnabled: false,
  chatMsgAccepted:    '@<<username>> you\'re in the giveaway! Good luck!',
  chatMsgNotEligible: '@<<username>> you\'re not eligible to enter.',
};

function sendGaChatMsg(template, username) {
  if (!cfg.chatEnabled || !template) return;
  const msg = template.replace(/<<username>>/g, username || '').trim();
  if (msg) invoke('twitch_send_chat_message', { message: msg }).catch(() => {});
}
let open = false;
let entrants = []; // [{username, userId, display, count}]
let cooldowns = {}; // userId -> timestamp of last entry
let winnerHideTimer = null;
let winners = []; // this session's past winners: [{name, at}] — newest first

// ── Persist ────────────────────────────────────────────────────────────────────
let saveTimer = null;
function persist(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(()=>{
    invoke('save_giveaway',{ data:{ cfg, open:false, entrants:[] } }); // don't persist open/entrants across restarts
  },300);
  pushOverlay();
}
function pushOverlay(){
  invoke('giveaway_overlay_update',{ state:{
    open, entrantCount: entrants.length, showCount: cfg.showEntryCount,
  }});
}

// ── Entry handling ─────────────────────────────────────────────────────────────
// In-flight guard: the awaited follower lookup yields, so two rapid messages
// from the same user could both pass the duplicate check and enter twice.
const entering = new Set();
async function tryEnter(username, userId, display, isMod, isSub){
  if(!open) return;
  if(entering.has(userId)) return;
  entering.add(userId);
  try{ await doEnter(username, userId, display, isMod, isSub); }
  finally{ entering.delete(userId); }
}
async function doEnter(username, userId, display, isMod, isSub){
  const now = Date.now();
  // Eligibility: mods/broadcaster always pass; otherwise must match at least one allowed category
  if(!isMod){
    let eligible = cfg.allowViewer;
    if(!eligible && cfg.allowSubscriber && isSub) eligible = true;
    if(!eligible && cfg.allowFollower){
      try{
        eligible = await invoke('twitch_check_follower',{ userId, broadcasterId: store.twitch.userId });
      }catch(e){ eligible = cfg.allowViewer; }
    }
    if(!eligible){ sendGaChatMsg(cfg.chatMsgNotEligible, display); return; }
  }
  // existing entrant?
  const existing = entrants.find(e=>e.userId===userId);
  if(existing){
    if(!cfg.multiEntry) return;
    if(existing.count >= cfg.maxEntries) return;
    // cooldown
    const last = cooldowns[userId]||0;
    if(now - last < cfg.cooldownSecs*1000) return;
  }
  cooldowns[userId] = now;
  if(existing){ existing.count++; }
  else { entrants.push({username, userId, display, count:1}); }
  sendGaChatMsg(cfg.chatMsgAccepted, display);
  renderEntrantList();
  pushOverlay();
}

// ── Draw ───────────────────────────────────────────────────────────────────────
function draw(){
  if(!entrants.length){
    const win=$('gaWinner');
    if(win){ win.textContent='No entrants yet!'; win.style.display='block'; setTimeout(()=>{ win.style.display='none'; },2000); }
    return;
  }
  // build weighted pool
  const pool = [];
  entrants.forEach(e=>{ for(let i=0;i<e.count;i++) pool.push(e); });
  const winner = pool[Math.floor(Math.random()*pool.length)];
  const names = [...new Set(entrants.map(e=>e.display))];
  invoke('giveaway_overlay_draw',{ winner: winner.display, entries: names, winnerSeconds: cfg.winnerSeconds||8 });
  // show in app — auto-hide after the same duration as the overlay
  const win = $('gaWinner');
  if(win){
    win.textContent='Winner: '+winner.display; win.style.display='block';
    clearTimeout(winnerHideTimer);
    winnerHideTimer = setTimeout(()=>{ win.style.display='none'; }, (cfg.winnerSeconds||8)*1000);
  }
  updateGiveawayPreview(winner.display);
  liveSet('giveawayWinner', winner.display);   // powers {giveawaywinner}
  winners.unshift({ name: winner.display, at: Date.now() });
  if(winners.length > 20) winners.pop();
  renderWinnerHistory();
  renderEntrantList();
}

// Session-only log so "wait, who won?" is never a problem after the overlay
// banner disappears. Cleared on app restart.
function renderWinnerHistory(){
  const el=$('gaWinnerHistory'); if(!el) return;
  if(!winners.length){ el.innerHTML=''; return; }
  const t=(ms)=>{ const d=new Date(ms); return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); };
  el.innerHTML='<div class="hint" style="margin-top:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;font-size:.7rem">Winners this session</div>'
    + winners.map(w=>`<div style="display:flex;gap:8px;font-size:.82rem;padding:2px 0"><span class="tag">${t(w.at)}</span><span>${esc(w.name)}</span></div>`).join('');
}

// ── Render ─────────────────────────────────────────────────────────────────────
function renderEntrantList(){
  const el=$('gaEntrantList'); if(!el) return;
  if(!entrants.length){ el.innerHTML='<div class="hint">No entrants yet.</div>'; return; }
  el.innerHTML = entrants.map((e,i)=>`
    <div class="entrant-row">
      <span class="entrant-count">${i+1}</span>
      <span style="flex:1">${esc(e.display)}</span>
      ${cfg.multiEntry?`<span class="tag">${e.count}x</span>`:''}
      <button class="btn-sm btn-ghost" data-uid="${esc(e.userId)}">✕</button>
    </div>`).join('');
  el.querySelectorAll('button[data-uid]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      entrants=entrants.filter(e=>e.userId!==btn.dataset.uid);
      renderEntrantList(); pushOverlay();
    });
  });
  const cnt=$('gaEntrantCount'); if(cnt) cnt.textContent=entrants.length+' entrant'+(entrants.length!==1?'s':'');
  const pc=$('gaPreviewCount'); if(pc) pc.textContent=entrants.length;
}

function renderStatus(){
  const pill=$('gaStatusPill'); if(!pill) return;
  pill.textContent=open?'OPEN':'CLOSED';
  pill.className='status-pill '+(open?'pill-open':'pill-closed');
  const ob=$('gaOpenBtn'),cb=$('gaCloseBtn'); if(!ob||!cb) return;
  ob.disabled=open; cb.disabled=!open;
  // right-col preview
  const ps=$('gaPreviewStatus'); if(ps) ps.textContent='Giveaway '+(open?'Open':'Closed');
  const pc=$('gaPreviewCount'); if(pc) pc.textContent=entrants.length;
}

function updateGiveawayPreview(winnerName){
  const pw=$('gaPreviewWinner');
  if(pw && winnerName) pw.textContent=winnerName;
  const pc=$('gaPreviewCount'); if(pc) pc.textContent=entrants.length;
}

function setOpen(v){ open=v; renderStatus(); pushOverlay(); }

// Commands tab: "Trigger a SPARK tool" -> Giveaway.
window.addEventListener('spark-action', e => {
  const d = e.detail || {};
  if(d.tool !== 'giveaway' || !toolEnabled('giveaway')) return;
  if(d.action === 'open')       setOpen(true);
  else if(d.action === 'close') setOpen(false);
  else if(d.action === 'draw')  draw();
});

// ── Build UI ───────────────────────────────────────────────────────────────────
function buildLeft(){
  const el=$('giveawayLeft'); if(!el) return;
  el.innerHTML=`
  <div class="card">
    <h2>Status <span class="status-pill pill-closed" id="gaStatusPill">CLOSED</span></h2>
    <div class="row">
      <button class="btn-green full" id="gaOpenBtn">Open Giveaway</button>
      <button class="btn-accent full" id="gaCloseBtn" disabled>Close</button>
    </div>
    <div class="row mt">
      <button class="btn-gold full" id="gaDrawBtn">Draw Winner</button>
    </div>
    <div class="ok" id="gaWinner" style="display:none;font-size:1.1rem;text-align:center;margin-top:8px"></div>
    <div class="hint mt" id="gaEntrantCount">0 entrants</div>
    <div id="gaWinnerHistory"></div>
  </div>
  <div class="card">
    <h2>Settings</h2>
    <label>Entry command word</label>
    <div class="row mb"><span style="color:var(--muted);margin-right:4px">!</span><input type="text" id="gaEntryWord" value="giveaway" style="flex:1"></div>
    <label>Who can enter</label>
    <label class="checkrow"><input type="checkbox" id="gaAllowViewer" checked> Viewers</label>
    <label class="checkrow"><input type="checkbox" id="gaAllowFollower" checked> Followers</label>
    <label class="checkrow"><input type="checkbox" id="gaAllowSub" checked> Subscribers</label>
    <hr class="sep">
    <label class="checkrow"><input type="checkbox" id="gaMultiEntry"> Allow multiple entries</label>
    <div id="gaMultiOpts" style="display:none;margin-top:8px">
      <label>Max entries per viewer</label>
      <input type="number" id="gaMaxEntries" value="3" min="1" max="100" style="width:80px">
      <label class="mt">Cooldown between entries (seconds)</label>
      <input type="number" id="gaCooldown" value="60" min="0" style="width:80px">
    </div>
    <hr class="sep">
    <label class="checkrow"><input type="checkbox" id="gaShowCount" checked> Show entry count on overlay</label>
    <label class="mt">Show winner for (seconds)</label>
    <input type="number" id="gaWinnerSecs" value="8" min="1" max="60" style="width:80px">
    <div class="hint">Mods can use <code>!giveaway open</code>, <code>!giveaway close</code>, <code>!draw</code></div>
  </div>
  <div class="card">
    <h2>Chat Responses</h2>
    <label class="checkrow"><input type="checkbox" id="gaChatEnabled" ${cfg.chatEnabled?'checked':''}> Send chat messages</label>
    <label class="mt">Entry accepted</label>
    <input type="text" id="gaChatAccepted" value="${esc(cfg.chatMsgAccepted||'')}" style="width:100%;font-size:.82rem">
    <label class="mt">Not eligible</label>
    <input type="text" id="gaChatNotEligible" value="${esc(cfg.chatMsgNotEligible||'')}" style="width:100%;font-size:.82rem">
    <div class="hint mt">Token: <code>&lt;&lt;username&gt;&gt;</code></div>
    <button class="btn-sm btn-gold full mt" id="gaSaveChatSettings">Save Chat Settings</button>
  </div>
  <div class="card">
    <h2>Entrants</h2>
    <div id="gaEntrantList"></div>
    <div class="row mt">
      <button class="btn-sm btn-ghost" id="gaClearBtn">Clear all entrants</button>
    </div>
  </div>`;
  wireEvents();
}

function wireEvents(){
  $('gaOpenBtn').addEventListener('click',()=>setOpen(true));
  $('gaCloseBtn').addEventListener('click',()=>setOpen(false));
  $('gaDrawBtn').addEventListener('click',draw);
  $('gaClearBtn').addEventListener('click',()=>{ entrants=[]; renderEntrantList(); pushOverlay(); });
  $('gaEntryWord').addEventListener('change',e=>{ cfg.entryWord=e.target.value.trim()||'giveaway'; persist(); });
  $('gaAllowViewer').addEventListener('change',e=>{ cfg.allowViewer=e.target.checked;persist(); });
  $('gaAllowFollower').addEventListener('change',e=>{ cfg.allowFollower=e.target.checked;persist(); });
  $('gaAllowSub').addEventListener('change',e=>{ cfg.allowSubscriber=e.target.checked;persist(); });
  $('gaMultiEntry').addEventListener('change',e=>{ cfg.multiEntry=e.target.checked;$('gaMultiOpts').style.display=e.target.checked?'block':'none';persist(); });
  $('gaMaxEntries').addEventListener('change',e=>{ cfg.maxEntries=Math.max(1,+e.target.value);persist(); });
  $('gaCooldown').addEventListener('change',e=>{ cfg.cooldownSecs=Math.max(0,+e.target.value);persist(); });
  $('gaShowCount').addEventListener('change',e=>{ cfg.showEntryCount=e.target.checked;persist(); });
  $('gaWinnerSecs').addEventListener('change',e=>{ cfg.winnerSeconds=Math.max(1,+e.target.value);persist(); });
  $('gaChatEnabled').addEventListener('change',e=>{ cfg.chatEnabled=e.target.checked;persist(); });
  $('gaSaveChatSettings').addEventListener('click',()=>{
    cfg.chatEnabled         = $('gaChatEnabled').checked;
    cfg.chatMsgAccepted     = $('gaChatAccepted').value;
    cfg.chatMsgNotEligible  = $('gaChatNotEligible').value;
    persist(); flash($('gaSaveChatSettings'),'Saved!');
  });
  renderOverlayBar('gaOverlayMode','gaOverlayUrl','gaCopyUrl','giveaway',store.overlayUrls);
  // chat commands
  window.addEventListener('spark-chat',e=>{
    const d=e.detail;
    const msg=(d.message||'').trim().toLowerCase();
    const isMod=d.is_mod||d.is_broadcaster;
    const word=cfg.entryWord.toLowerCase();
    const isGaCmd = msg===`!${word}` || msg===`!${word} open` || msg===`!${word} close` || msg==='!draw';
    if(isGaCmd && toolBlocked('giveaway', d.display||d.username)) return;
    // entry command
    if(msg===`!${word}`) tryEnter(d.username,d.user_id,d.display,d.is_mod,d.is_sub);
    // mod controls
    if(isMod){
      if(msg===`!${word} open`) setOpen(true);
      if(msg===`!${word} close`) setOpen(false);
      if(msg==='!draw') draw();
    }
  });
}

export async function initGiveaway(){
  buildLeft();
  const d=store.giveaway;
  if(d.cfg) Object.assign(cfg,d.cfg);
  renderStatus();
  renderEntrantList();
  // restore ui
  if($('gaEntryWord')) $('gaEntryWord').value=cfg.entryWord;
  if($('gaAllowViewer')) $('gaAllowViewer').checked=cfg.allowViewer;
  if($('gaAllowFollower')) $('gaAllowFollower').checked=cfg.allowFollower;
  if($('gaAllowSub')) $('gaAllowSub').checked=cfg.allowSubscriber;
  if($('gaMultiEntry')){ $('gaMultiEntry').checked=cfg.multiEntry; $('gaMultiOpts').style.display=cfg.multiEntry?'block':'none'; }
  if($('gaMaxEntries')) $('gaMaxEntries').value=cfg.maxEntries;
  if($('gaCooldown')) $('gaCooldown').value=cfg.cooldownSecs;
  if($('gaShowCount')) $('gaShowCount').checked=cfg.showEntryCount;
  if($('gaWinnerSecs')) $('gaWinnerSecs').value=cfg.winnerSeconds;
  if($('gaChatEnabled')) $('gaChatEnabled').checked=cfg.chatEnabled;
  if($('gaChatAccepted')) $('gaChatAccepted').value=cfg.chatMsgAccepted||'';
  if($('gaChatNotEligible')) $('gaChatNotEligible').value=cfg.chatMsgNotEligible||'';
}
