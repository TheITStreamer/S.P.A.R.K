import { store, toolBlocked } from './store.js';
import { $, esc, renderOverlayBar } from './utils.js';
import { playSound as playAudioFile } from './audio.js';
import { fontOptionsHtml } from './fonts.js';

const { invoke } = window.__TAURI__.core;
const dialog = window.__TAURI__.dialog;

// ── State ─────────────────────────────────────────────────────────────────────
// configs: [{id, name, rewardId, anyRedeem, text, shape, animation, entryDir,
//   bgColor, textColor, borderColor, font, duration, sfx,
//   width, height, counts:{userId:{display,total,checkedInThisStream}} }]
let configs = [];
// firstClaim: {rewardId, display, shape, animation, entryDir, bgColor,
//   textColor, borderColor, font, sfx, pos, winner:{display,avatar}}
let firstClaim = { rewardId:'', anyRedeem:false, display:'was first!',
  shape:'rounded', animation:'slide', entryDir:'bottom',
  bgColor:'var(--panel)', textColor:'#ffffff', borderColor:'#ffc83d',
  font:'Segoe UI', fontSize:15, width:320, height:0,
  sfx:null, pos:'top-right', winner:null,
  autoHide:false, hideSecs:30 };

// Per-session tracking
let checkedInThisStream = {}; // configId -> Set of userIds
let avatarCache = {};          // userId -> profile_image_url
let firstClaimedThisStream = false;

let saveTimer_c = null;
function uid(){ return Math.random().toString(36).slice(2,10); }

function persist(){
  clearTimeout(saveTimer_c);
  saveTimer_c = setTimeout(()=>{
    invoke('save_checkins',{ data:{ configs, firstClaim }});
  },200);
}

// ── Avatar fetch ──────────────────────────────────────────────────────────────
async function getAvatar(userId){
  if(avatarCache[userId]) return avatarCache[userId];
  try{
    const r = await invoke('twitch_get_user_info',{ userId });
    const url = r.profile_image_url || '';
    avatarCache[userId] = url;
    return url;
  }catch(e){ return ''; }
}

// ── Check-in handling ─────────────────────────────────────────────────────────
async function handleRedeem(rewardId, userId, userDisplay){
  // First claim check
  if(!firstClaimedThisStream && firstClaim.rewardId === rewardId){
    firstClaimedThisStream = true;
    const avatar = await getAvatar(userId);
    firstClaim.winner = { display: userDisplay, avatar };
    playSfx(firstClaim.sfx);
    invoke('checkins_overlay_event',{ event:{
      type:'first', cfg: firstClaim,
    }});
    updateFirstPreview();
    persist();
  }

  // Regular check-in configs
  for(const cfg of configs){
    if(!cfg.anyRedeem && cfg.rewardId !== rewardId) continue;
    if(!checkedInThisStream[cfg.id]) checkedInThisStream[cfg.id] = new Set();
    if(checkedInThisStream[cfg.id].has(userId)) continue; // already checked in this stream
    checkedInThisStream[cfg.id].add(userId);

    // Increment lifetime count
    if(!cfg.counts) cfg.counts={};
    if(!cfg.counts[userId]) cfg.counts[userId]={ display:userDisplay, total:0 };
    cfg.counts[userId].total++;
    cfg.counts[userId].display = userDisplay;

    const count = cfg.counts[userId].total;
    const text = (cfg.text||'{name} has checked in {count} times!')
      .replace(/\{name\}/g, userDisplay)
      .replace(/\{count\}/g, count);
    const avatar = await getAvatar(userId);

    playSfx(cfg.sfx);
    invoke('checkins_overlay_event',{ event:{
      type:'checkin',
      configId: cfg.id,
      text, avatar, display: userDisplay,
      shape: cfg.shape, animation: cfg.animation, entryDir: cfg.entryDir,
      bgColor: cfg.bgColor, textColor: cfg.textColor, borderColor: cfg.borderColor,
      font: cfg.font, duration: cfg.duration||5,
      width: cfg.width||320, height: cfg.height||90,
      fontSize: cfg.fontSize||15,
      pos: cfg.pos||'bottom-right',
    }});
    renderCountsForConfig(cfg);
    persist();
  }
}

function playSfx(path, force){
  playAudioFile(path, { force: !!force });
}

// ── Twitch redeems ────────────────────────────────────────────────────────────
window.addEventListener('spark-redeem', e=>{
  const d=e.detail;
  const rewardId=d.reward_id;
  const targetsCheckin = (firstClaim.rewardId===rewardId) || configs.some(c=>c.anyRedeem||c.rewardId===rewardId);
  if(targetsCheckin && toolBlocked('checkins', d.user_name||'someone')) return;
  handleRedeem(rewardId, d.user_id, d.user_name||'someone');
});

// ── Config card rendering ─────────────────────────────────────────────────────
function renderCountsForConfig(cfg){
  const el=document.getElementById('ci-counts-'+cfg.id); if(!el) return;
  const counts = cfg.counts||{};
  const entries = Object.entries(counts).sort((a,b)=>b[1].total-a[1].total);
  if(!entries.length){ el.innerHTML='<div class="hint">No check-ins yet.</div>'; return; }
  el.innerHTML=`<div style="max-height:160px;overflow-y:auto">`+
    entries.map(([uid,v])=>`<div style="display:flex;gap:8px;padding:3px 0;font-size:.82rem;border-bottom:1px solid var(--row-line)">
      <span style="flex:1;color:var(--ink)">${esc(v.display)}</span>
      <span class="tag">${v.total}x</span>
      <button class="btn-sm btn-ghost" style="padding:2px 6px;font-size:.72rem" data-uid="${uid}" data-cfg="${cfg.id}">Edit</button>
    </div>`).join('')+`</div>`;
  el.querySelectorAll('button[data-uid]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const c=configs.find(x=>x.id===btn.dataset.cfg); if(!c||!c.counts) return;
      const uid=btn.dataset.uid;
      const cur=c.counts[uid]?.total||0;
      const v=prompt(`Edit check-in count for ${c.counts[uid]?.display||uid}:`,cur);
      if(v===null) return;
      const n=parseInt(v);
      if(!isNaN(n)){ c.counts[uid].total=Math.max(0,n); renderCountsForConfig(c); persist(); }
    });
  });
}

// Fire a fake check-in at the overlay (and preview) — no channel points spent,
// no counts touched.
function testConfig(cfg){
  const text = (cfg.text||'{name} has checked in {count} times!')
    .replace(/\{name\}/g,'TestViewer').replace(/\{count\}/g,'7');
  playSfx(cfg.sfx, true);   // Test button — always audible
  invoke('checkins_overlay_event',{ event:{
    type:'checkin', configId: cfg.id,
    text, avatar:'', display:'TestViewer',
    shape: cfg.shape, animation: cfg.animation, entryDir: cfg.entryDir,
    bgColor: cfg.bgColor, textColor: cfg.textColor, borderColor: cfg.borderColor,
    font: cfg.font, duration: cfg.duration||5,
    width: cfg.width||320, height: cfg.height||90,
    fontSize: cfg.fontSize||15, pos: cfg.pos||'bottom-right',
  }});
}

function configCardHtml(cfg){
  return `<div class="goal-card" id="cicfg-${cfg.id}">
    <div class="goal-card-header">
      <span class="goal-name">${esc(cfg.name)}</span>
      <button class="btn-sm" data-citest="${cfg.id}">Test</button>
      <button class="btn-sm btn-ghost" data-ciedit="${cfg.id}">Edit</button>
      <button class="btn-sm del" data-cidel="${cfg.id}">Remove</button>
    </div>
    <div class="hint">${cfg.anyRedeem?'Any redeem triggers check-in':'Reward: '+(cfg._rewardTitle||cfg.rewardId||'not set')}</div>
    <div class="hint">Text: <em>${esc(cfg.text||'{name} has checked in {count} times!')}</em></div>
    <div style="margin-top:10px;font-size:.75rem;color:var(--muted);font-weight:700;letter-spacing:.12em;text-transform:uppercase;margin-bottom:6px">Check-in counts</div>
    <div id="ci-counts-${cfg.id}"><div class="hint">No check-ins yet.</div></div>
  </div>`;
}

function renderConfigList(){
  const el=$('ciConfigList'); if(!el) return;
  if(!configs.length){ el.innerHTML='<div class="hint">No check-in configs yet.</div>'; return; }
  el.innerHTML=configs.map(configCardHtml).join('');
  configs.forEach(cfg=>renderCountsForConfig(cfg));
  el.querySelectorAll('button[data-cidel]').forEach(btn=>{
    btn.addEventListener('click',()=>{ configs=configs.filter(c=>c.id!==btn.dataset.cidel); renderConfigList(); persist(); });
  });
  el.querySelectorAll('button[data-ciedit]').forEach(btn=>{
    btn.addEventListener('click',()=>{ const cfg=configs.find(c=>c.id===btn.dataset.ciedit); if(cfg) openEditor(cfg); });
  });
  el.querySelectorAll('button[data-citest]').forEach(btn=>{
    btn.addEventListener('click',()=>{ const cfg=configs.find(c=>c.id===btn.dataset.citest); if(cfg) testConfig(cfg); });
  });
}

// ── First claim section ───────────────────────────────────────────────────────
function updateFirstPreview(){
  const el=$('ciFirstWinner');
  if(!el) return;
  el.textContent = firstClaim.winner
    ? firstClaim.winner.display+' '+firstClaim.display
    : '(no one yet this stream)';
}

function buildFirstSection(){
  const el=$('ciFirstSection'); if(!el) return;
  el.innerHTML=`
  <div class="card">
    <h2>First Claim</h2>
    <div class="hint">Separate reward. The first viewer to redeem this stays displayed until cleared.</div>
    <label class="mt">Reward (from the list below)</label>
    <div class="row"><select id="ciFirstReward" style="flex:1"></select><button class="btn-sm" id="ciRefreshFirst">Refresh</button></div>
    <label class="checkrow"><input type="checkbox" id="ciFirstAny"> Any redeem = First Claim</label>
    <label class="mt">Display text</label>
    <input type="text" id="ciFirstText" value="${esc(firstClaim.display||'was first!')}">
    <label class="mt">Position</label>
    <select id="ciFirstPos">
      <option value="top-left"     ${firstClaim.pos==='top-left'?'selected':''}>Top Left</option>
      <option value="top-center"   ${firstClaim.pos==='top-center'?'selected':''}>Top Centre</option>
      <option value="top-right"    ${firstClaim.pos==='top-right'?'selected':''}>Top Right</option>
      <option value="middle-left"  ${firstClaim.pos==='middle-left'?'selected':''}>Middle Left</option>
      <option value="middle"       ${firstClaim.pos==='middle'?'selected':''}>Middle</option>
      <option value="middle-right" ${firstClaim.pos==='middle-right'?'selected':''}>Middle Right</option>
      <option value="bottom-left"  ${firstClaim.pos==='bottom-left'?'selected':''}>Bottom Left</option>
      <option value="bottom-center"${firstClaim.pos==='bottom-center'?'selected':''}>Bottom Centre</option>
      <option value="bottom-right" ${firstClaim.pos==='bottom-right'?'selected':''}>Bottom Right</option>
    </select>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;margin-top:10px">
      <div><label>Shape</label><select id="ciFirstShape">
        <option value="rounded" ${firstClaim.shape==='rounded'?'selected':''}>Rounded</option>
        <option value="pill" ${firstClaim.shape==='pill'?'selected':''}>Pill</option>
        <option value="square" ${firstClaim.shape==='square'?'selected':''}>Square</option>
      </select></div>
      <div><label>BG</label><input id="ciFirstBg" type="color" value="${firstClaim.bgColor||'var(--panel)'}" style="width:50px;height:32px;border:none;background:none;cursor:pointer"></div>
      <div><label>Text</label><input id="ciFirstTextColor" type="color" value="${firstClaim.textColor||'#ffffff'}" style="width:50px;height:32px;border:none;background:none;cursor:pointer"></div>
      <div><label>Border/Ring</label><input id="ciFirstBorder" type="color" value="${firstClaim.borderColor||'#ffc83d'}" style="width:50px;height:32px;border:none;background:none;cursor:pointer"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;margin-top:10px">
      <div><label>Font</label><select id="ciFirstFont">${fontOptionsHtml(firstClaim.font||'Segoe UI')}</select></div>
      <div><label>Font size (px)</label><input id="ciFirstFs" type="number" value="${firstClaim.fontSize||15}" min="10" max="40"></div>
      <div><label>Width (px)</label><input id="ciFirstW" type="number" value="${firstClaim.width||320}" min="200" max="800"></div>
      <div><label>Height (px)<br><span style="font-size:.7rem;color:var(--muted)">0 = auto</span></label><input id="ciFirstH" type="number" value="${firstClaim.height||0}" min="0" max="300"></div>
    </div>
    <div class="row mt"><button class="btn-sm" id="ciFirstPickSfx">SFX…</button><span id="ciFirstSfxName" style="font-size:.78rem;color:var(--muted)">${firstClaim.sfx?firstClaim.sfx.split(/[\\/]/).pop():'No file'}</span><button class="btn-sm btn-ghost" id="ciFirstClearSfx">Clear</button></div>
    <label class="checkrow mt"><input type="checkbox" id="ciFirstAutoHide" ${firstClaim.autoHide?'checked':''}> Auto-hide after delay</label>
    <div id="ciFirstAutoHideOpts" style="display:${firstClaim.autoHide?'block':'none'};margin-top:6px">
      <label>Hide after (seconds)</label>
      <input type="number" id="ciFirstHideSecs" value="${firstClaim.hideSecs||30}" min="1" max="300" style="width:80px">
    </div>
    <button class="btn-sm btn-gold mt full" id="ciFirstSave">Save First Claim settings</button>
    <button class="btn-sm mt full" id="ciFirstTest">Test First Claim popup</button>
    <hr class="sep">
    <div style="font-size:.78rem;color:var(--muted)">This stream: <span id="ciFirstWinner">(no one yet)</span></div>
    <button class="btn-sm btn-ghost mt" id="ciFirstClear">Clear first claim (reset for this stream)</button>
  </div>`;
  wireFirsEvents();
  updateFirstPreview();
  // Populate reward selects if connected
  if(store.twitch.connected) loadRewardsIntoSelects();
}

function wireFirsEvents(){
  let sfxPath = firstClaim.sfx;
  $('ciFirstSave').addEventListener('click',()=>{
    firstClaim.rewardId = $('ciFirstReward')?.value||'';
    firstClaim.anyRedeem = $('ciFirstAny')?.checked||false;
    firstClaim.display = $('ciFirstText')?.value.trim()||'was first!';
    firstClaim.pos = $('ciFirstPos')?.value||'top-right';
    firstClaim.shape = $('ciFirstShape')?.value||'rounded';
    firstClaim.bgColor = $('ciFirstBg')?.value||'var(--panel)';
    firstClaim.textColor = $('ciFirstTextColor')?.value||'#ffffff';
    firstClaim.borderColor = $('ciFirstBorder')?.value||'#ffc83d';
    firstClaim.font = $('ciFirstFont')?.value||'Segoe UI';
    firstClaim.fontSize = parseInt($('ciFirstFs')?.value)||15;
    firstClaim.width = parseInt($('ciFirstW')?.value)||320;
    firstClaim.height = parseInt($('ciFirstH')?.value)||0;
    firstClaim.sfx = sfxPath;
    firstClaim.autoHide = $('ciFirstAutoHide')?.checked||false;
    firstClaim.hideSecs = parseInt($('ciFirstHideSecs')?.value)||30;
    persist();
    flash($('ciFirstSave'),'Saved!');
  });
  $('ciFirstPickSfx').addEventListener('click',async()=>{
    const f=await dialog.open({multiple:false,filters:[{name:'Audio',extensions:['mp3','wav','ogg','m4a']}]});
    if(f){ sfxPath=f; $('ciFirstSfxName').textContent=f.split(/[\\/]/).pop(); }
  });
  $('ciFirstClearSfx').addEventListener('click',()=>{ sfxPath=null; $('ciFirstSfxName').textContent='No file'; });
  $('ciFirstClear').addEventListener('click',()=>{
    firstClaimedThisStream=false; firstClaim.winner=null;
    invoke('checkins_overlay_event',{event:{type:'first_clear'}});
    updateFirstPreview();
  });
  $('ciRefreshFirst').addEventListener('click',loadRewardsIntoSelects);
  // Test uses a copy — the real winner/persisted state is untouched.
  $('ciFirstTest').addEventListener('click',()=>{
    playSfx(firstClaim.sfx, true);
    invoke('checkins_overlay_event',{ event:{
      type:'first', cfg: { ...firstClaim, winner:{ display:'TestViewer', avatar:'' } },
    }});
  });
  $('ciFirstAutoHide').addEventListener('change',e=>{
    $('ciFirstAutoHideOpts').style.display = e.target.checked ? 'block' : 'none';
  });
}

function flash(btn,msg){ const o=btn.textContent;btn.textContent=msg;setTimeout(()=>btn.textContent=o,1200); }

// ── Reward select population ──────────────────────────────────────────────────
async function loadRewardsIntoSelects(){
  let rewards=[];
  try{ const r=await invoke('twitch_get_rewards'); rewards=r.rewards||[]; }
  catch(e){ return; }
  // update all reward selects that may exist in the DOM
  ['ciFirstReward','ciNewReward','ciEdReward'].forEach(id=>{
    const sel=$(id); if(!sel) return;
    const cur = id==='ciFirstReward' ? (firstClaim.rewardId||sel.value) : sel.value;
    sel.innerHTML='<option value="">(select reward)</option>'+
      rewards.map(r=>`<option value="${r.id}" ${r.id===cur?'selected':''}>${esc(r.title)}</option>`).join('');
  });
  configs.forEach(cfg=>{
    const rw=rewards.find(r=>r.id===cfg.rewardId);
    if(rw) cfg._rewardTitle=rw.title;
  });
  // also update firstClaim reward title
  const fr=rewards.find(r=>r.id===firstClaim.rewardId);
  if(fr) firstClaim._rewardTitle=fr.title;
}

// ── Config editor modal ───────────────────────────────────────────────────────
function openEditor(cfg){
  try{
    document.getElementById('ciEditorModal')?.remove();
    const modal=document.createElement('div');
    modal.id='ciEditorModal';
    modal.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:9999;display:flex;align-items:center;justify-content:center';
    let sfxPath=cfg.sfx;
    const sfxLabel = cfg.sfx ? cfg.sfx.split(/[\\/]/).pop() : 'No file';
    modal.innerHTML='<div style="background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:22px;width:520px;max-height:90vh;overflow-y:auto;position:relative">'
      +'<button id="ciEdClose" style="position:absolute;top:12px;right:14px;background:none;border:none;color:var(--muted);font-size:1.5rem;cursor:pointer">x</button>'
      +'<div style="font-size:.7rem;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);font-weight:700;margin-bottom:16px">Editing: '+esc(cfg.name||'')+'</div>'
      +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">'
        +'<div><label>Name</label><input id="ciEdName" type="text" value="'+esc(cfg.name||'')+'"></div>'
        +'<div><label>Trigger reward</label><select id="ciEdReward"><option value="'+esc(cfg.rewardId||'')+'">'+esc(cfg._rewardTitle||cfg.rewardId||'Loading...')+'</option></select></div>'
      +'</div>'
      +'<label style="display:flex;align-items:center;gap:8px;font-size:.85rem;cursor:pointer;margin-bottom:10px"><input type="checkbox" id="ciEdAny" '+(cfg.anyRedeem?'checked':'')+'>  Any redeem triggers check-in</label>'
      +'<div style="margin-bottom:10px"><label>Popup text</label><input type="text" id="ciEdText" value="'+esc(cfg.text||'{name} has checked in {count} times!')+'"><div style="font-size:.72rem;color:var(--muted);margin-top:3px">Use {name} and {count}</div></div>'
      +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">'
        +'<div><label>Shape</label><select id="ciEdShape"><option value="rounded" '+(cfg.shape==='rounded'?'selected':'')+'>Rounded</option><option value="pill" '+(cfg.shape==='pill'?'selected':'')+'>Pill</option><option value="square" '+(cfg.shape==='square'?'selected':'')+'>Square</option></select></div>'
        +'<div><label>Animation</label><select id="ciEdAnim"><option value="slide" '+(cfg.animation==='slide'?'selected':'')+'>Slide</option><option value="bounce" '+(cfg.animation==='bounce'?'selected':'')+'>Bounce</option><option value="fade" '+(cfg.animation==='fade'?'selected':'')+'>Fade</option><option value="pop" '+(cfg.animation==='pop'?'selected':'')+'>Pop</option></select></div>'
        +'<div><label>Entry direction</label><select id="ciEdDir"><option value="bottom" '+(cfg.entryDir==='bottom'?'selected':'')+'>Bottom</option><option value="top" '+(cfg.entryDir==='top'?'selected':'')+'>Top</option><option value="left" '+(cfg.entryDir==='left'?'selected':'')+'>Left</option><option value="right" '+(cfg.entryDir==='right'?'selected':'')+'>Right</option></select></div>'
        +'<div><label>Queue position</label><select id="ciEdPos">'
          +'<option value="bottom-right" '+((cfg.pos||'bottom-right')==='bottom-right'?'selected':'')+'>Bottom Right</option>'
          +'<option value="bottom-center" '+(cfg.pos==='bottom-center'?'selected':'')+'>Bottom Centre</option>'
          +'<option value="bottom-left" '+(cfg.pos==='bottom-left'?'selected':'')+'>Bottom Left</option>'
          +'<option value="middle-right" '+(cfg.pos==='middle-right'?'selected':'')+'>Middle Right</option>'
          +'<option value="middle-left" '+(cfg.pos==='middle-left'?'selected':'')+'>Middle Left</option>'
          +'<option value="top-right" '+(cfg.pos==='top-right'?'selected':'')+'>Top Right</option>'
          +'<option value="top-center" '+(cfg.pos==='top-center'?'selected':'')+'>Top Centre</option>'
          +'<option value="top-left" '+(cfg.pos==='top-left'?'selected':'')+'>Top Left</option>'
        +'</select></div>'
      +'</div>'
      +'<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:10px">'
        +'<div><label>BG</label><input id="ciEdBg" type="color" value="'+(cfg.bgColor||'var(--panel)')+'" style="width:50px;height:32px;border:none;background:none;cursor:pointer"></div>'
        +'<div><label>Text</label><input id="ciEdTxt" type="color" value="'+(cfg.textColor||'#ffffff')+'" style="width:50px;height:32px;border:none;background:none;cursor:pointer"></div>'
        +'<div><label>Border</label><input id="ciEdBorder" type="color" value="'+(cfg.borderColor||'#ffc83d')+'" style="width:50px;height:32px;border:none;background:none;cursor:pointer"></div>'
      +'</div>'
      +'<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px;margin-bottom:10px">'
        +'<div><label>Font</label><select id="ciEdFont">'+fontOptionsHtml(cfg.font||'Segoe UI')+'</select></div>'
        +'<div><label>Font size (px)</label><input id="ciEdFs" type="number" value="'+(cfg.fontSize||15)+'" min="10" max="40"></div>'
        +'<div><label>Width (px)</label><input id="ciEdW" type="number" value="'+(cfg.width||320)+'" min="200" max="800"></div>'
        +'<div><label>Height (px)</label><input id="ciEdH" type="number" value="'+(cfg.height||90)+'" min="60" max="300"></div>'
      +'</div>'
      +'<div style="margin-bottom:12px"><label>Duration (sec)</label><input id="ciEdDur" type="number" value="'+(cfg.duration||5)+'" min="1" max="60" style="width:80px"></div>'
      +'<div style="display:flex;gap:8px;align-items:center;margin-bottom:16px">'
        +'<button id="ciEdPickSfx" style="font-family:inherit;cursor:pointer;border:none;border-radius:8px;font-size:.85rem;font-weight:600;padding:8px 14px;color:#fff;background:var(--btn)">SFX...</button>'
        +'<span id="ciEdSfxName" style="font-size:.78rem;color:var(--muted)">'+sfxLabel+'</span>'
        +'<button id="ciEdClearSfx" style="font-family:inherit;cursor:pointer;border:1px solid var(--line);border-radius:8px;font-size:.85rem;padding:8px 14px;color:var(--muted);background:transparent">Clear</button>'
      +'</div>'
      +'<div style="display:flex;justify-content:flex-end;gap:8px">'
        +'<button id="ciEdSave" style="font-family:inherit;cursor:pointer;border:none;border-radius:8px;font-size:.85rem;font-weight:600;padding:8px 14px;color:#2b1d00;background:#ffc83d">Save</button>'
        +'<button id="ciEdCancel" style="font-family:inherit;cursor:pointer;border:1px solid var(--line);border-radius:8px;font-size:.85rem;padding:8px 14px;color:var(--muted);background:transparent">Cancel</button>'
      +'</div>'
    +'</div>';
    document.body.appendChild(modal);

    invoke('twitch_get_rewards').then(r=>{
      const sel=document.getElementById('ciEdReward'); if(!sel) return;
      sel.innerHTML='<option value="">(select reward)</option>'+(r.rewards||[]).map(rw=>'<option value="'+rw.id+'" '+(rw.id===cfg.rewardId?'selected':'')+'>'+esc(rw.title)+'</option>').join('');
    }).catch(()=>{});

    document.getElementById('ciEdPickSfx').addEventListener('click',async()=>{
      const f=await dialog.open({multiple:false,filters:[{name:'Audio',extensions:['mp3','wav','ogg','m4a']}]});
      if(f){ sfxPath=f; document.getElementById('ciEdSfxName').textContent=f.split(/[\\/]/).pop(); }
    });
    document.getElementById('ciEdClearSfx').addEventListener('click',()=>{ sfxPath=null; document.getElementById('ciEdSfxName').textContent='No file'; });
    document.getElementById('ciEdSave').addEventListener('click',()=>{
      cfg.name       = document.getElementById('ciEdName').value.trim()||cfg.name;
      cfg.rewardId   = document.getElementById('ciEdReward').value;
      cfg.anyRedeem  = document.getElementById('ciEdAny').checked;
      cfg.text       = document.getElementById('ciEdText').value;
      cfg.shape      = document.getElementById('ciEdShape').value;
      cfg.animation  = document.getElementById('ciEdAnim').value;
      cfg.entryDir   = document.getElementById('ciEdDir').value;
      cfg.pos        = document.getElementById('ciEdPos').value;
      cfg.bgColor    = document.getElementById('ciEdBg').value;
      cfg.textColor  = document.getElementById('ciEdTxt').value;
      cfg.borderColor= document.getElementById('ciEdBorder').value;
      cfg.font       = document.getElementById('ciEdFont').value||'Segoe UI';
      cfg.fontSize   = parseInt(document.getElementById('ciEdFs').value)||15;
      cfg.width      = parseInt(document.getElementById('ciEdW').value)||320;
      cfg.height     = parseInt(document.getElementById('ciEdH').value)||90;
      cfg.duration   = parseInt(document.getElementById('ciEdDur').value)||5;
      cfg.sfx        = sfxPath;
      modal.remove(); renderConfigList(); persist();
    });
    document.getElementById('ciEdClose').addEventListener('click',()=>modal.remove());
    document.getElementById('ciEdCancel').addEventListener('click',()=>modal.remove());
    modal.addEventListener('click',e=>{ if(e.target===modal) modal.remove(); });
  }catch(err){ console.error('openEditor error:',err); }
}


// ── Build UI ──────────────────────────────────────────────────────────────────
function buildLeft(){
  const el=$('checkinsLeft'); if(!el) return;
  el.innerHTML=`
  <div class="card">
    <h2>New Check-in Config</h2>
    <div class="row">
      <input type="text" id="ciNewName" placeholder="Daily Check-in" style="flex:1">
      <button class="btn-sm btn-gold" id="ciNewBtn">Create</button>
    </div>
  </div>
  <div id="ciFirstSection"></div>
  <div class="card" style="margin-bottom:60px">
    <h2>Check-in Configs</h2>
    <div id="ciConfigList"></div>
  </div>`;

  $('ciNewBtn').addEventListener('click',()=>{
    const name=$('ciNewName').value.trim()||'Check-in';
    configs.push({
      id:uid(), name, rewardId:'', anyRedeem:false,
      text:'{name} has checked in {count} times!',
      shape:'rounded', animation:'slide', entryDir:'bottom', pos:'bottom-right',
      bgColor:'var(--panel)', textColor:'#ffffff', borderColor:'#ffc83d',
      font:'Segoe UI', duration:5, sfx:null,
      width:320, height:90, counts:{},
    });
    $('ciNewName').value='';
    renderConfigList(); persist();
  });

  renderOverlayBar('ciOverlayMode','ciOverlayUrl','ciCopyUrl','checkins',store.overlayUrls);
  buildFirstSection();
  renderConfigList();
}

export async function initCheckins(){
  // Load saved data BEFORE buildLeft so the form renders with correct values
  const d=store.checkins||{};
  if(d.configs) configs=d.configs;
  if(d.firstClaim) Object.assign(firstClaim,d.firstClaim);
  firstClaim.winner=null; // never restore winner across restarts
  firstClaimedThisStream=false;
  checkedInThisStream={};
  buildLeft();
  renderConfigList();
  updateFirstPreview();
  // Load rewards now if already connected, or when connection happens
  if(store.twitch.connected) loadRewardsIntoSelects();
  window.addEventListener('spark-twitch-status', e=>{
    if(e.detail?.connected) loadRewardsIntoSelects();
  });

  // A new stream clears "already checked in" and the first claim. This fires
  // only for a genuinely new stream — app.js swallows the online event when it
  // follows a recent offline, so a dropped connection mid-broadcast does not
  // let the whole channel check in a second time.
  //
  // Lifetime totals are untouched; only the per-stream state resets.
  window.addEventListener('spark-stream-start', ()=>{
    checkedInThisStream={};
    firstClaimedThisStream=false;
    firstClaim.winner=null;
    // Same clear the manual "Clear first claim" button performs, so the overlay
    // drops the previous winner's block rather than leaving it on screen.
    invoke('checkins_overlay_event',{event:{type:'first_clear'}});
    updateFirstPreview();
  });
}
