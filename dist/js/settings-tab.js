import { store, ignoreList, saveIgnoreList, TOOL_DEFS, toolToggles, toolDefaultMsg, saveToolToggles, MASTER_TOOL_DEFS, masterTools } from './store.js';
import { refreshDisabledBanner, resetTabOrder } from './tab-chrome.js';
import { $, esc } from './utils.js';
import { setHeaderStatus, checkForUpdate } from './app.js';
import * as prof from './profiles.js';
import { THEMES, applyTheme, currentTheme } from './theme.js';
import * as fonts from './fonts.js';

const { invoke } = window.__TAURI__.core;

// SPARK's own public Twitch app, pre-filled so new users can connect with one
// click instead of creating a dev app first. Device-code flow works with a
// shared PUBLIC client. Paste the registered app's Client ID here; while it is
// '' the field stays empty and the user supplies their own ID.
const DEFAULT_TWITCH_CLIENT_ID = '';

// headerMsg lets the Settings card carry the long form while the header keeps
// something short — that top-right slot is narrow.
function setTwStatus(state, msg, headerMsg){
  const dot=$('settTwDot'), txt=$('settTwText'); if(!dot||!txt) return;
  dot.className='dot'+(state?' '+state:''); txt.textContent=msg;
  setHeaderStatus(state, headerMsg || msg);
}

// The connected message is built here rather than at each call site because
// SEVERAL events land on it: afterConnected() sets it, then immediately fires
// spark-twitch-status (so other tabs know), and EventSub's session_welcome
// fires the same event again from Rust a moment later. Whichever arrives last
// wins, so they all have to produce the same text — otherwise the detailed
// message flashes up and is instantly overwritten with a bare "Connected".
function connectedMsg(){
  return store.twitch.login
    ? `Connected as ${store.twitch.login}, listening for redeems`
    : 'Connected';
}

async function afterConnected(){
  try{
    const who=await invoke('twitch_load_saved');
    store.twitch.connected=true; store.twitch.userId=who.user_id;
    store.twitch.login=who.login; store.twitch.clientId=who.client_id;
    $('settTwAuthBox').style.display='none';
    $('settTwConnectedBox').style.display='block';
    $('settTwWho').textContent=`Connected as ${who.login}`;
    setTwStatus('on','Connected');
    // start chat listener
    await invoke('twitch_connect_chat',{ channel: who.login });
    // auto-start EventSub so redeems work across all tools immediately
    await invoke('twitch_connect_eventsub');
    setTwStatus('on', connectedMsg(), 'Connected');
    // notify all tabs
    window.dispatchEvent(new CustomEvent('spark-twitch-status',{detail:{connected:true}}));
  }catch(e){ setTwStatus('err',String(e)); }
}

export async function initSettings(){
  const el=$('settContent'); if(!el) return;
  el.innerHTML=`
  <h1 style="font-size:1rem;letter-spacing:.25em;text-transform:uppercase;color:var(--muted);font-weight:600;margin-bottom:18px">⚙ Settings</h1>
  <div class="settings-grid">
  <div class="card">
    <h2>About</h2>
    <div style="display:flex;align-items:center;gap:10px">
      <span style="font-weight:700" id="settVersion">SPARK v…</span>
      <span class="tag" style="background:var(--warn-bg);color:var(--warn-ink);border-color:var(--warn-bg)">BETA</span>
    </div>
    <div class="hint mt">This build is still in active development, not a 1.0 release. Expect rough edges, and please report anything odd.</div>
    <button class="btn-sm btn-ghost mt" id="settCheckUpd">Check for updates</button>
    <div class="hint" id="settUpdMsg" style="margin-top:6px"></div>
  </div>
  <div class="card">
    <h2>Twitch Connection</h2>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
      <span class="dot" id="settTwDot"></span><span id="settTwText">Not connected</span>
    </div>
    <div id="settTwAuthBox">
      <label for="settTwClientId">Your Twitch App Client ID</label>
      <input type="text" id="settTwClientId" placeholder="abcd1234…">
      <button class="btn-twitch full mt" id="settTwAuthBtn">Connect Twitch</button>
      <div id="settTwDeviceBox" style="display:none" class="mt">
        <div class="ok">1. Go to <span class="link" id="settTwLink"></span></div>
        <div class="ok">2. Enter code: <code id="settTwCode"></code></div>
        <div class="hint">Waiting for browser authorization…</div>
      </div>
      <details class="mt">
        <summary>How do I get a Client ID? (~2 min)</summary>
        <div class="hint">
          1. Go to <span class="link" data-url="https://dev.twitch.tv/console/apps/create">dev.twitch.tv/console/apps/create</span><br>
          2. Name: anything. OAuth Redirect URL: <code>http://localhost</code><br>
          3. Category: Broadcasting Suite. Client Type: <b>Public</b>.<br>
          4. Create, copy the <b>Client ID</b> and paste above.
        </div>
      </details>
    </div>
    <div id="settTwConnectedBox" style="display:none">
      <div class="ok" id="settTwWho"></div>
      <div class="row mt">
        <button class="btn-sm btn-twitch" id="settReconnectChat">Reconnect Chat</button>
        <button class="btn-sm btn-ghost" id="settTwLogout">Log out</button>
      </div>
      <div class="hint mt">Chat is read automatically for <code>!</code> commands. Redeems (EventSub) start automatically on connect.</div>
    </div>
  </div>
  <div class="card">
    <h2>Bot Account <span class="tag">Optional</span></h2>
    <div class="hint" style="margin-bottom:12px">
      Connect a second Twitch account and everything SPARK says in chat comes from it instead of you —
      commands, auto messages, giveaway and wheel results, song request replies, the lot.
      <br><br>
      <b>The bot must be a moderator in your channel.</b> Twitch blocks it from posting otherwise,
      and moderators get a much higher message limit.
    </div>
    <div id="settBotAuthBox">
      <button class="btn-twitch full" id="settBotAuthBtn">Connect Bot Account</button>
      <div class="hint mt">Uses the same Client ID as above. Sign in as the bot — a private browser window is easiest, so you don't get logged out of your own account.</div>
      <div id="settBotDeviceBox" style="display:none" class="mt">
        <div class="ok">1. Go to <span class="link" id="settBotLink"></span></div>
        <div class="ok">2. Enter code: <code id="settBotCode"></code></div>
        <div class="hint">Waiting for browser authorization…</div>
      </div>
    </div>
    <div id="settBotConnectedBox" style="display:none">
      <div class="ok" id="settBotWho"></div>
      <div class="row mt">
        <button class="btn-sm btn-ghost" id="settBotLogout">Disconnect Bot</button>
      </div>
    </div>
    <div class="warn mt" id="settBotWarn" style="display:none"></div>
  </div>
  <div class="card">
    <h2>Sounds</h2>
    <div class="row" style="align-items:center;gap:8px">
      <label style="margin:0">Play at most</label>
      <input type="number" id="settAudioMax" min="1" max="10" style="width:70px">
      <label style="margin:0">sounds at once</label>
    </div>
    <div class="hint mt">Applies to every tool. Extra sounds beyond this are skipped rather than queued, so a spammed sound command can't pile up a backlog. Test buttons always play.</div>
  </div>
  <div class="card">
    <h2>Master Overlay</h2>
    <div class="hint" style="margin-bottom:8px">
      One browser source that shows several tools at once. Tick the tools you want on it.
      Every tool tab still has its own unique URL, so you can mix and match.<br><br>
      To arrange the layout, open the URL in a normal browser or use <b>Interact</b> in OBS.
      Hover a panel, drag the title bar to move it, drag the corner triangle to resize.
      Panels snap to a 10px grid. Hold <b>Shift</b> to place them freely.
    </div>
    <div class="row" style="gap:6px;align-items:center;margin-bottom:10px">
      <span>URL:</span><input type="text" id="settMasterUrl" readonly style="flex:1;font-size:.8rem">
      <button class="btn-sm" id="settMasterCopy">Copy</button>
    </div>
    <div id="settMasterTools" style="display:grid;grid-template-columns:1fr 1fr;gap:2px 14px"></div>
    <div class="hint" style="margin-top:8px">The master overlay supports these 8 tools for now. Chat, Counters, Credits, Song Queue and D.I.Y widgets have their own URLs only.</div>
    <div class="row mt" style="align-items:center;gap:8px">
      <label style="margin:0">Editor border colour</label>
      <input type="color" id="settMasterBorder" value="#ffc83d" style="width:46px;height:26px;padding:0;border:none;background:none">
      <button class="btn-sm" id="settMasterBorderReset" title="Back to gold">Reset</button>
      <span class="hint" style="margin:0">for the move and resize handles. Pick whatever is easiest to see against your scene.</span>
    </div>
  </div>
  <div class="card">
    <h2>Sidebar</h2>
    <div class="hint" style="margin-bottom:10px">Drag any tab up or down the sidebar to reorder it — put the tools you use most at the top. Press <strong>Ctrl+K</strong> anywhere to jump straight to a tab by typing.</div>
    <button class="btn-sm btn-ghost" id="settResetTabs">Reset tab order</button>
    <div class="hint" style="margin-top:6px">Resetting reloads the window.</div>
  </div>
  <div class="card">
    <h2>Theme</h2>
    <div class="hint" style="margin-bottom:10px">Changes the look of SPARK itself. Your overlays are not touched, so what goes out on stream stays exactly as you designed it.</div>
    <div id="settThemeList" style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px"></div>
    <div class="hint" style="margin-top:8px">The theme is saved with the profile you are on, so each setup can have its own look.</div>
  </div>
  <div class="card">
    <h2>Profiles</h2>
    <div class="hint" style="margin-bottom:12px">A profile is a complete SPARK setup: your lists, timers, goals, overlays and which tools are switched on. Keep one for quiet streams, one for co-working, one for everything, and swap between them. The profile you are on saves as you work, so there is no separate save step.</div>
    <div id="settProfileList"></div>
    <div class="row mt">
      <input type="text" id="settProfileName" placeholder="New profile name" style="flex:1">
      <button class="btn-sm btn-gold" id="settProfileNewCopy">Add copy of current</button>
      <button class="btn-sm" id="settProfileNewBlank">Add empty</button>
    </div>
    <div class="hint" style="margin-top:8px"><strong>Add copy of current</strong> starts from how SPARK is set up right now. <strong>Add empty</strong> starts from scratch at the defaults.</div>
    <div class="hint" style="margin-top:8px">Switching restarts the SPARK window, which takes a moment. Your overlays reconnect on their own. Nothing is lost: the setup you are leaving is saved before the new one loads.</div>
    <div class="hint" style="margin-top:6px">Shared by every profile: your Twitch connection, check-in counts, credits history and the ignore list below.</div>
    <div class="warn" id="settProfileMsg" style="display:none"></div>
  </div>
  <div class="card">
    <h2>Tool Availability</h2>
    <div class="hint" style="margin-bottom:12px">Turn a tool off when you're not using it and it will stop responding to chat commands and redeems. When off, viewers who try get the message you set below. Changes save straight away. Note: channel point redeems still spend the viewer's points, so turn the reward off in Twitch if you want to stop those.</div>
    <div id="settToolList"></div>
    <span class="ok" id="settToolsOk" style="display:none">Saved!</span>
  </div>
  <div class="card">
    <h2>Bot / User Ignore List</h2>
    <div class="hint" style="margin-bottom:8px">One username per line. These users are ignored everywhere: chat overlay, credits, and any future tools. Great for bots like Nightbot or StreamElements. The Chat tab's quick-Ignore button also adds to this list.</div>
    <textarea id="settIgnoreList" style="height:90px">${esc(ignoreList().join('\n'))}</textarea>
    <button class="btn-sm mt" id="settIgnoreSave">Save Ignore List</button>
    <span class="ok" id="settIgnoreOk" style="display:none;margin-left:8px">Saved!</span>
  </div>
  <div class="card">
    <h2>Custom Fonts</h2>
    <div class="hint" style="margin-bottom:10px">Add your own font files and they appear in every font dropdown in SPARK, and on your overlays in OBS. Accepts .ttf, .otf, .woff and .woff2.</div>
    <div id="settFontList"></div>
    <div class="row mt" style="align-items:flex-end;gap:8px">
      <div style="flex:1">
        <label>Name it</label>
        <input type="text" id="settFontName" placeholder="e.g. My Stream Font">
      </div>
      <button class="btn-sm btn-gold" id="settFontAdd">Choose file…</button>
    </div>
    <div class="hint" style="margin-top:6px">The name is yours to pick — it's what shows up in the dropdowns.</div>
    <div class="warn" id="settFontMsg" style="display:none"></div>
    <div class="ok" id="settFontOk" style="display:none"></div>
  </div>
  <div class="card">
    <h2>Backup &amp; Restore</h2>
    <div class="hint" style="margin-bottom:12px">Export a backup of all your lists, goals, check-in counts, and settings. Twitch tokens are excluded. Font files are not included, but their names are — after restoring you'll be told which ones to add again. You'll reconnect on a new PC in about 30 seconds.</div>
    <div class="row">
      <button class="btn-sm btn-gold" id="settExportBtn">Export Backup</button>
      <button class="btn-sm" id="settImportBtn">Import Backup</button>
    </div>
    <div class="warn" id="settBackupMsg" style="display:none"></div>
    <div class="ok" id="settBackupOk" style="display:none"></div>
  </div>
  </div>
  <div class="hint" style="margin-top:8px;text-align:center">Data saved to %APPDATA%\\com.spark.app\\spark-data.json</div>`;

  wireSettingsEvents();
  wireProfileEvents();
  wireFontEvents();
  {
    // Says what actually happened — up to date, a new version, or the real
    // reason it could not ask. The old check reported none of those.
    const cu = $('settCheckUpd'), msg = $('settUpdMsg');
    if(cu) cu.addEventListener('click', async ()=>{
      cu.disabled = true;
      if(msg){ msg.textContent = 'Checking…'; msg.className = 'hint'; }
      const r = await checkForUpdate(true);
      if(msg){
        msg.textContent = r.message;
        msg.className = r.ok ? (r.update ? 'ok' : 'hint') : 'warn';
      }
      cu.disabled = false;
    });
  }
  {
    const rt = $('settResetTabs');
    if(rt) rt.addEventListener('click', ()=>{
      if(confirm('Put the sidebar back to its original order?\n\nSPARK will reload.')) resetTabOrder();
    });
  }
  renderThemes();
  renderToolToggles();
  renderMasterCard();
  renderFonts();
  // Existing installs have no profiles; give them one pointing at the data
  // already on disk so this feature can never look like it wiped a setup.
  prof.ensureBootstrapped().then(renderProfiles).catch(()=>renderProfiles());

  // Re-assert master state on boot — the server's visibility map and border
  // colour are runtime-only, so push the saved settings every launch.
  {
    const mt = masterTools();
    MASTER_TOOL_DEFS.forEach(t=>invoke('set_tool_visibility',{ tool:t.id, visible: mt[t.id]===true }).catch(()=>{}));
    invoke('set_master_border',{ color: store.settings.masterBorderColor || '#ffc83d' }).catch(()=>{});
  }

  invoke('get_app_version').then(v=>{
    const el2=$('settVersion'); if(el2) el2.textContent=`SPARK v${v}`;
  }).catch(()=>{});

  // restore saved client id (falling back to the bundled SPARK app if any)
  const cid = store.twitch_tokens?.client_id || DEFAULT_TWITCH_CLIENT_ID || '';
  if(cid && $('settTwClientId')) $('settTwClientId').value=cid;

  // Silent reconnect — fire-and-forget so a slow/unreachable Twitch never
  // blocks boot (all other tabs init immediately; they pick up connection
  // state via the spark-twitch-status event when it lands).
  afterConnected().catch(()=>{ /* not logged in yet, fine */ });
  refreshBotStatus().catch(()=>{ /* no bot connected, fine */ });

  window.addEventListener('spark-twitch-status',e=>{
    const d=e.detail;
    if(d.connected) setTwStatus('on', connectedMsg(), 'Connected');
    else setTwStatus('err',d.error||'Disconnected');
  });
}

function wireSettingsEvents(){
  $('settTwAuthBtn').addEventListener('click',startAuth);
  $('settTwLogout').addEventListener('click',doLogout);
  $('settReconnectChat').addEventListener('click',async()=>{
    try{ await invoke('twitch_connect_chat',{channel:store.twitch.login}); setTwStatus('on','Chat reconnected'); }
    catch(e){ setTwStatus('err',String(e)); }
  });

  // ── Bot account ──
  $('settBotAuthBtn').addEventListener('click',startBotAuth);
  $('settBotLogout').addEventListener('click',()=>{
    invoke('twitch_bot_logout').catch(()=>{});
    $('settBotConnectedBox').style.display='none';
    $('settBotAuthBox').style.display='block';
    $('settBotWarn').style.display='none';
    // With no bot there is nothing to choose between, so the Broadcast tab's
    // "send as" picker has to disappear again.
    window.dispatchEvent(new CustomEvent('spark-bot-status',{detail:{connected:false}}));
  });
  // The sender thread reports a rejected bot message here rather than failing
  // silently — without this the streamer only finds out when chat goes quiet.
  window.addEventListener('spark-send-error',e=>{
    const d=e.detail||{};
    if(d.source!=='bot' && d.kind!=='rate') return;
    const w=$('settBotWarn'); if(!w) return;
    w.textContent='⚠ '+(d.reason||'A message could not be sent.');
    w.style.display='block';
  });

  // ── Sounds ──
  const am=$('settAudioMax');
  if(am){
    am.value = Number.isFinite(store.settings.audioMaxConcurrent) ? store.settings.audioMaxConcurrent : 3;
    am.addEventListener('change',()=>{
      const n=Math.max(1,Math.min(10,parseInt(am.value)||3));
      am.value=n;
      store.settings.audioMaxConcurrent=n;
      invoke('save_app_settings',{ data: store.settings }).catch(()=>{});
    });
  }

  // Tool availability. Saves the moment a box is ticked, matching the Master
  // Overlay card just above, so the list and the saved data always agree.
  wireToolToggleEvents();

  // Global ignore list
  $('settIgnoreSave').addEventListener('click',()=>{
    const lines = $('settIgnoreList').value.split('\n').map(s=>s.trim().toLowerCase()).filter(Boolean);
    store.settings.ignoreList = [...new Set(lines)];
    saveIgnoreList();
    const ok=$('settIgnoreOk'); if(ok){ ok.style.display='inline'; setTimeout(()=>ok.style.display='none',1500); }
  });
  // Keep the textarea current when another tab adds a name (chat quick-ignore)
  window.addEventListener('spark-ignorelist',()=>{
    const ta=$('settIgnoreList');
    if(ta && document.activeElement!==ta) ta.value = ignoreList().join('\n');
  });

  // Backup
  $('settExportBtn').addEventListener('click',async()=>{
    try{
      const data = await invoke('backup_data');
      const json = JSON.stringify(data,null,2);
      const date = new Date().toISOString().slice(0,10);
      const path = await window.__TAURI__.dialog.save({
        defaultPath: `SPARK-backup-${date}.json`,
        filters:[{name:'JSON',extensions:['json']}],
      });
      if(!path) return;
      // Write via a temp file approach using the filesystem API
      await window.__TAURI__.fs.writeTextFile(path, json);
      showBackupOk('Backup saved!');
    }catch(e){ showBackupMsg(String(e)); }
  });

  $('settImportBtn').addEventListener('click',async()=>{
    try{
      const path = await window.__TAURI__.dialog.open({multiple:false,filters:[{name:'JSON',extensions:['json']}]});
      if(!path) return;
      const txt = await window.__TAURI__.fs.readTextFile(path);
      const data = JSON.parse(txt);
      if(!confirm('This will overwrite all current data including check-in counts, wheel lists, goals, and settings. Twitch connection is preserved.\n\nContinue?')) return;
      await invoke('restore_data',{ data });
      // Reload the window to re-init every tab against the restored data —
      // same path profile switching already uses, no manual restart needed.
      showBackupOk('Backup restored! Reloading…');
      setTimeout(()=>window.location.reload(), 900);
    }catch(e){ showBackupMsg('Failed: '+String(e)); }
  });

  document.addEventListener('click',e=>{
    const el=e.target.closest('[data-url]'); if(!el) return;
    const url=el.dataset.url; if(!url) return;
    try{ if(window.__TAURI__.opener) window.__TAURI__.opener.openUrl(url); else window.open(url,'_blank'); }
    catch(_){ window.open(url,'_blank'); }
  });
}

// ── Theme card ────────────────────────────────────────────────────────────────
// Each swatch previews its own colours rather than the active theme's, so the
// literal hex values here are correct and must not become variables.
function renderThemes(){
  const el=$('settThemeList'); if(!el) return;
  const cur=currentTheme();
  el.innerHTML=THEMES.map(t=>{
    const on=t.id===cur;
    return `<button data-theme-id="${t.id}" title="${esc(t.name)}"
      style="padding:0;border-radius:10px;overflow:hidden;background:none;
             border:2px solid ${on?'var(--gold)':'var(--line)'};cursor:pointer">
      <span style="display:block;background:${t.swatch[0]};padding:9px 8px 8px">
        <span style="display:flex;gap:4px;margin-bottom:7px">
          <span style="flex:1;height:16px;border-radius:4px;background:${t.swatch[1]}"></span>
          <span style="width:16px;height:16px;border-radius:4px;background:${t.swatch[2]}"></span>
        </span>
        <span style="display:block;font-size:.7rem;font-weight:700;letter-spacing:.03em;
                     color:${t.id==='light'?'#1a1c22':'#f5f1ff'}">${esc(t.name)}</span>
      </span>
    </button>`;
  }).join('');
  el.querySelectorAll('button[data-theme-id]').forEach(b=>b.addEventListener('click',()=>{
    const id=applyTheme(b.dataset.themeId);
    store.settings.theme=id;
    invoke('save_app_settings',{ data: store.settings });
    renderThemes();   // move the selected outline
  }));
}

// ── Profiles card ─────────────────────────────────────────────────────────────
function profileMsg(text, bad){
  const el=$('settProfileMsg'); if(!el) return;
  el.textContent=text;
  el.style.display=text?'block':'none';
  el.style.color = bad ? '' : '#43d17a';
}

function renderProfiles(){
  const el=$('settProfileList'); if(!el) return;
  const list=prof.profiles();
  const activeId=prof.activeProfileId();
  if(!list.length){ el.innerHTML='<div class="hint">No profiles yet.</div>'; return; }
  el.innerHTML=list.map(p=>{
    const active=p.id===activeId;
    return `<div class="timer-card" style="${active?'border-left:3px solid #ffc83d':''}">
      <div class="timer-name-row">
        <span style="flex:1;font-weight:600">${esc(p.name)}</span>
        ${active?'<span class="tag" style="background:#ffc83d;color:#1a1400;font-weight:700">active</span>':`<button class="btn-sm btn-green" data-pfload="${p.id}">Switch to</button>`}
        <button class="btn-sm btn-ghost" data-pfren="${p.id}">Rename</button>
        <button class="btn-sm btn-ghost" data-pfdup="${p.id}">Duplicate</button>
        ${active?'':`<button class="btn-sm btn-ghost" data-pfdel="${p.id}">✕</button>`}
      </div>
      ${active?'<div class="hint">This is the setup you are using now. Changes you make save into it automatically.</div>':''}
    </div>`;
  }).join('');

  el.querySelectorAll('button[data-pfload]').forEach(b=>b.addEventListener('click',async()=>{
    const p=prof.profiles().find(x=>x.id===b.dataset.pfload);
    if(!p) return;
    if(!confirm(`Switch to "${p.name}"?\n\nSPARK will restart to load it. The setup you are on now is saved first.`)) return;
    // Buttons off while the swap runs: a second click mid-switch would snapshot
    // half-applied data into a profile.
    el.querySelectorAll('button').forEach(x=>x.disabled=true);
    profileMsg('Saving current setup and loading '+p.name+'…');
    try{
      const r=await prof.switchProfile(p.id);
      if(!r.ok){ profileMsg(r.reason, true); el.querySelectorAll('button').forEach(x=>x.disabled=false); return; }
      profileMsg('Loaded '+r.name+'. Restarting…');
      setTimeout(()=>window.location.reload(), 400);
    }catch(err){
      profileMsg('Could not switch: '+((err&&err.message)||err), true);
      el.querySelectorAll('button').forEach(x=>x.disabled=false);
    }
  }));

  el.querySelectorAll('button[data-pfren]').forEach(b=>b.addEventListener('click',async()=>{
    const p=prof.profiles().find(x=>x.id===b.dataset.pfren); if(!p) return;
    const name=prompt('Rename profile:', p.name);
    if(name===null) return;
    const trimmed=name.trim(); if(!trimmed) return;
    await prof.renameProfile(p.id, trimmed);
    renderProfiles(); profileMsg('Renamed.');
  }));

  el.querySelectorAll('button[data-pfdup]').forEach(b=>b.addEventListener('click',async()=>{
    const copy=await prof.duplicateProfile(b.dataset.pfdup);
    renderProfiles();
    profileMsg(copy?`Created "${copy.name}".`:'Could not duplicate that profile.', !copy);
  }));

  el.querySelectorAll('button[data-pfdel]').forEach(b=>b.addEventListener('click',async()=>{
    const p=prof.profiles().find(x=>x.id===b.dataset.pfdel); if(!p) return;
    if(!confirm(`Delete "${p.name}"?\n\nEverything saved in that profile goes with it. This cannot be undone.`)) return;
    const r=await prof.deleteProfile(p.id);
    renderProfiles();
    profileMsg(r.ok?`Deleted "${p.name}".`:r.reason, !r.ok);
  }));
}

function wireProfileEvents(){
  const add=async copyCurrent=>{
    const box=$('settProfileName');
    const name=(box.value||'').trim();
    if(!name){ profileMsg('Give the profile a name first.', true); box.focus(); return; }
    const p=await prof.createProfile(name, copyCurrent);
    box.value='';
    renderProfiles();
    profileMsg(`Created "${p.name}". Switch to it when you want to use it.`);
  };
  $('settProfileNewCopy')?.addEventListener('click',()=>add(true));
  $('settProfileNewBlank')?.addEventListener('click',()=>add(false));
}

function renderMasterCard(){
  const url = store.overlayUrls?.master || '';
  const urlEl=$('settMasterUrl'); if(urlEl) urlEl.value = url;
  $('settMasterCopy')?.addEventListener('click', ()=>navigator.clipboard.writeText(url));

  const list=$('settMasterTools');
  if(list){
    const mt = masterTools();
    list.innerHTML = MASTER_TOOL_DEFS.map(t=>
      '<label class="checkrow" style="margin:4px 0"><input type="checkbox" class="master-en" data-id="'+t.id+'" '+(mt[t.id]===true?'checked':'')+'> '+esc(t.label)+'</label>'
    ).join('');
    list.querySelectorAll('input.master-en').forEach(cb=>{
      cb.addEventListener('change', ()=>{
        masterTools()[cb.dataset.id] = cb.checked;
        invoke('save_app_settings',{ data: store.settings });
        invoke('set_tool_visibility',{ tool: cb.dataset.id, visible: cb.checked }); // master updates live
      });
    });
  }

  const border=$('settMasterBorder');
  if(border){
    border.value = store.settings.masterBorderColor || '#ffc83d';
    border.addEventListener('input', e=>{
      store.settings.masterBorderColor = e.target.value;
      invoke('save_app_settings',{ data: store.settings });
      invoke('set_master_border',{ color: e.target.value });
    });
    $('settMasterBorderReset')?.addEventListener('click', ()=>{
      border.value = '#ffc83d';
      store.settings.masterBorderColor = '#ffc83d';
      invoke('save_app_settings',{ data: store.settings });
      invoke('set_master_border',{ color: '#ffc83d' });
    });
  }
}

// Delegated from the container, which already exists in the card markup, so
// this works no matter when the rows themselves get rendered or re-rendered.
let toolMsgTimer=null;
function wireToolToggleEvents(){
  const list=$('settToolList'); if(!list) return;

  const writeRow=id=>{
    const tg=toolToggles();
    const cb=list.querySelector('input.tool-en[data-id="'+id+'"]');
    const box=list.querySelector('input.tool-msg[data-id="'+id+'"]');
    if(!tg[id]) tg[id]={};
    if(cb)  tg[id].enabled = cb.checked;
    if(box) tg[id].msg     = box.value;
  };
  const flash=()=>{
    const ok=$('settToolsOk');
    if(ok){ ok.style.display='inline'; clearTimeout(ok._t); ok._t=setTimeout(()=>ok.style.display='none',1200); }
  };

  list.addEventListener('change',e=>{
    const cb=e.target.closest('input.tool-en'); if(!cb) return;
    writeRow(cb.dataset.id);
    saveToolToggles();
    syncToolRowPill(cb.dataset.id);
    refreshDisabledBanner(); // the strip above #content reads the same toggles
    flash();
  });

  // The banner's "Turn on" button writes the same toggles from the other side.
  window.addEventListener('spark-tools-changed', ()=>renderToolToggles());

  // Typing a message saves too, debounced so it is not a write per keystroke.
  list.addEventListener('input',e=>{
    const box=e.target.closest('input.tool-msg'); if(!box) return;
    const id=box.dataset.id;
    clearTimeout(toolMsgTimer);
    toolMsgTimer=setTimeout(()=>{ writeRow(id); saveToolToggles(); flash(); },600);
  });
}

function renderToolToggles(){
  const el=$('settToolList'); if(!el) return;
  const tg=toolToggles();
  el.innerHTML = TOOL_DEFS.map(t=>{
    const cur = tg[t.id] || {};
    const on  = cur.enabled !== false;
    const msg = (typeof cur.msg === 'string' && cur.msg) ? cur.msg : toolDefaultMsg(t.id);
    return '<div style="padding:10px 0;border-bottom:1px solid var(--row-line)" data-tool-row="'+t.id+'">'
      + '<label class="checkrow" style="margin:0;font-weight:600"><input type="checkbox" class="tool-en" data-id="'+t.id+'" '+(on?'checked':'')+'> '+esc(t.label)
      + '<span class="tool-off-pill" style="'+(on?'display:none':'')+'">OFF</span></label>'
      + '<input type="text" class="tool-msg" data-id="'+t.id+'" value="'+esc(msg)+'" placeholder="Message shown in chat when off" style="width:100%;font-size:.82rem;margin-top:6px">'
      + '</div>';
  }).join('');
}

// Toggling a row does not re-render the list (that would blow away whatever the
// streamer is mid-way through typing in the message box), so the pill is moved
// on its own.
function syncToolRowPill(id){
  const list=$('settToolList'); if(!list) return;
  const row=list.querySelector('[data-tool-row="'+id+'"]'); if(!row) return;
  const cb=row.querySelector('input.tool-en');
  const pill=row.querySelector('.tool-off-pill');
  if(pill) pill.style.display = (cb && cb.checked) ? 'none' : '';
}

// ── Custom fonts ──────────────────────────────────────────────────────────────

function showFontMsg(msg){ const e=$('settFontMsg'); if(e){ e.textContent=msg; e.style.display='block'; } const o=$('settFontOk'); if(o) o.style.display='none'; }
function showFontOk(msg){ const e=$('settFontOk'); if(e){ e.textContent=msg; e.style.display='block'; } const w=$('settFontMsg'); if(w) w.style.display='none'; }

async function renderFonts(){
  const host=$('settFontList'); if(!host) return;
  const list=fonts.customFonts();
  if(!list.length){
    host.innerHTML='<div class="hint">No custom fonts yet.</div>';
    return;
  }
  // A font whose file is gone still shows, greyed, with a "missing" tag —
  // silently dropping it would leave overlays using a family name that no
  // longer resolves with nothing on screen to explain why.
  let missing=[];
  try{ missing=await fonts.missingFonts(); }catch(e){}

  // Backups carry font NAMES but not the files, so this is the normal state
  // after restoring onto a different PC. Say so rather than leaving the user
  // to work out why their overlay went back to a default font.
  const banner = missing.length
    ? `<div class="warn" style="margin-bottom:10px">${missing.length === 1 ? 'One font is' : missing.length + ' fonts are'} listed here but the file is not on this PC — most likely this setup came from a backup. Import the file again under the same name and everything that used it goes back to normal.</div>`
    : '';

  host.innerHTML=banner+list.map(f=>{
    const gone=missing.includes(f.family);
    const preview=gone
      ? '<span class="hint">file missing — import it again</span>'
      : `<span style="font-family:'${esc(f.family)}';font-size:1.05rem">Aa Bb Cc 123</span>`;
    return `<div class="row" style="align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--row-line)">
      <div style="flex:1;min-width:0">
        <div style="font-weight:600${gone?';opacity:.5':''}">${esc(f.family)}</div>
        <div style="margin-top:2px">${preview}</div>
      </div>
      <button class="btn-sm btn-ghost" data-font-del="${esc(f.family)}">Remove</button>
    </div>`;
  }).join('');

  host.querySelectorAll('[data-font-del]').forEach(b=>{
    b.addEventListener('click',async()=>{
      const fam=b.getAttribute('data-font-del');
      try{ await fonts.removeFont(fam); showFontOk(`Removed ${fam}.`); }
      catch(e){ showFontMsg(String(e)); }
      renderFonts();
    });
  });
}

function wireFontEvents(){
  const btn=$('settFontAdd'); if(!btn) return;
  btn.addEventListener('click',async()=>{
    const name=($('settFontName').value||'').trim();
    if(!name){ showFontMsg('Give the font a name first — that name is what you pick in the dropdowns.'); return; }
    try{
      const path=await window.__TAURI__.dialog.open({ multiple:false,
        filters:[{ name:'Fonts', extensions:['ttf','otf','woff','woff2'] }] });
      if(!path) return;
      await fonts.importFont(path, name);
      $('settFontName').value='';
      showFontOk(`Added ${name}. It's in every font dropdown now — refresh your OBS browser sources to pick it up.`);
      renderFonts();
    }catch(e){ showFontMsg(String(e)); }
  });
}

function showBackupMsg(msg){ const e=$('settBackupMsg'); if(e){ e.textContent=msg; e.style.display='block'; } const o=$('settBackupOk'); if(o) o.style.display='none'; }
function showBackupOk(msg){ const e=$('settBackupOk'); if(e){ e.textContent=msg; e.style.display='block'; } const w=$('settBackupMsg'); if(w) w.style.display='none'; }

function doLogout(){
  invoke('twitch_logout'); // stops sockets AND clears saved tokens
  store.twitch.connected=false;
  store.twitch_tokens={};
  $('settTwConnectedBox').style.display='none';
  $('settTwAuthBox').style.display='block';
  setTwStatus('','Not connected');
}

// Called by the re-auth popup's "Reconnect now" button. A refresh grant never
// widens scopes, so the ONLY way to pick up a new permission is a full logout
// followed by a fresh device-code auth — doing them together here means the
// user never has to find the two buttons themselves.
export function beginReauth(){
  doLogout();
  startAuth();
}

async function startAuth(){
  const clientId=$('settTwClientId').value.trim();
  if(!clientId){ alert('Paste your Client ID first.'); return; }
  setTwStatus('wait','Requesting device code…');
  try{
    const dev=await invoke('twitch_start_device_auth',{clientId});
    $('settTwDeviceBox').style.display='block';
    $('settTwCode').textContent=dev.user_code;
    const uri=dev.verification_uri||'https://www.twitch.tv/activate';
    const link=$('settTwLink'); link.textContent=uri; link.dataset.url=uri;
    setTwStatus('wait','Waiting for browser authorization…');
    pollDevice(clientId,dev.device_code,dev.interval||5,dev.expires_in||1800);
  }catch(e){ setTwStatus('err',String(e)); }
}

// ── Bot account auth ─────────────────────────────────────────────────────────
// Same device-code flow, same Client ID — the difference is the scope list and
// which token slot it lands in.

async function startBotAuth(){
  const clientId=($('settTwClientId').value||'').trim() || (store.twitch_tokens||{}).client_id || store.twitch.clientId;
  if(!clientId){ alert('Connect your own Twitch account first — the bot uses the same Client ID.'); return; }
  const warn=$('settBotWarn');
  try{
    const dev=await invoke('twitch_start_bot_auth',{clientId});
    $('settBotDeviceBox').style.display='block';
    $('settBotCode').textContent=dev.user_code;
    const uri=dev.verification_uri||'https://www.twitch.tv/activate';
    const link=$('settBotLink'); link.textContent=uri; link.dataset.url=uri;
    warn.style.display='none';
    pollBotDevice(clientId,dev.device_code,dev.interval||5,dev.expires_in||1800);
  }catch(e){
    warn.textContent='⚠ '+String(e);
    warn.style.display='block';
  }
}

let botAuthGen=0;
async function pollBotDevice(clientId,deviceCode,interval,expiresIn){
  const myGen=++botAuthGen;
  const deadline=Date.now()+expiresIn*1000;
  const fail=(msg)=>{
    $('settBotDeviceBox').style.display='none';
    const w=$('settBotWarn'); w.textContent='⚠ '+msg; w.style.display='block';
  };
  const tick=async()=>{
    if(myGen!==botAuthGen) return;
    if(Date.now()>deadline){ fail('Code expired. Click Connect Bot Account to get a new one.'); return; }
    try{
      const r=await invoke('twitch_poll_bot_auth',{clientId,deviceCode});
      if(myGen!==botAuthGen) return;
      if(r.status==='authorized'){
        $('settBotDeviceBox').style.display='none';
        await refreshBotStatus();
        return;
      }
      const m=String(r.message||'').toLowerCase();
      if(m.includes('expired')||m.includes('invalid device code')){ fail('Code expired. Click Connect Bot Account to get a new one.'); return; }
    }catch(e){}
    setTimeout(tick,Math.max(interval,3)*1000);
  };
  setTimeout(tick,Math.max(interval,3)*1000);
}

export async function refreshBotStatus(){
  if(!$('settBotAuthBox')) return;
  try{
    const s=await invoke('twitch_bot_status');
    if(s.connected){
      $('settBotAuthBox').style.display='none';
      $('settBotConnectedBox').style.display='block';
      $('settBotWho').textContent='Sending chat as '+(s.login||'bot account');
    }else{
      $('settBotAuthBox').style.display='block';
      $('settBotConnectedBox').style.display='none';
    }
    const w=$('settBotWarn');
    if(s.error){ w.textContent='⚠ '+s.error; w.style.display='block'; }
    // The Broadcast tab's "send as" picker only exists when a bot does, so it
    // has to know the moment one is connected or removed.
    window.dispatchEvent(new CustomEvent('spark-bot-status',{detail:{connected:!!s.connected, login:s.login||''}}));
  }catch(e){ /* not connected yet — leave the card in its default state */ }
}

// Each Connect click supersedes any previous polling loop (authGen), and the
// loop stops itself when the device code expires instead of polling forever.
let authGen=0;
async function pollDevice(clientId,deviceCode,interval,expiresIn){
  const myGen=++authGen;
  const deadline=Date.now()+expiresIn*1000;
  const expired=()=>{
    $('settTwDeviceBox').style.display='none';
    setTwStatus('err','Code expired. Click Connect Twitch to get a new one.');
  };
  const tick=async()=>{
    if(myGen!==authGen) return;               // a newer Connect attempt took over
    if(Date.now()>deadline){ expired(); return; }
    try{
      const r=await invoke('twitch_poll_device_auth',{clientId,deviceCode});
      if(myGen!==authGen) return;
      if(r.status==='authorized'){
        $('settTwDeviceBox').style.display='none';
        await afterConnected(); return;
      }
      const m=String(r.message||'').toLowerCase();
      if(m.includes('expired')||m.includes('invalid device code')){ expired(); return; }
    }catch(e){}
    setTimeout(tick,Math.max(interval,3)*1000);
  };
  setTimeout(tick,Math.max(interval,3)*1000);
}
