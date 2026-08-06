import { store, toolBlocked, liveSet } from './store.js';
import { $, esc, renderOverlayBar, slog, slogDump, slogClear } from './utils.js';

const { invoke } = window.__TAURI__.core;

// ── Pear Desktop API Server ───────────────────────────────────────────────────
const PEAR = 'http://localhost:26538/api/v1';

async function pearGet(path) {
  let r;
  try { r = await fetch(PEAR + path); }
  catch (e) { slog('pear', 'GET ' + path + ' fetch-fail: ' + (e && e.message)); throw e; }
  if (!r.ok && r.status !== 204) { slog('pear', 'GET ' + path + ' HTTP ' + r.status); throw new Error(r.status + ' ' + r.statusText); }
  return r.status === 204 ? null : r.json();
}
async function pearPost(path, body) {
  const opts = { method: 'POST', headers: {} };
  if (body !== null && body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let r;
  try { r = await fetch(PEAR + path, opts); }
  catch (e) { slog('pear', 'POST ' + path + ' fetch-fail: ' + (e && e.message)); throw e; }
  if (!r.ok && r.status !== 204) { slog('pear', 'POST ' + path + ' HTTP ' + r.status); throw new Error(r.status + ' ' + r.statusText); }
  slog('pear', 'POST ' + path + ' ok (' + r.status + ')');
  return r.status === 204 ? null : r.json().catch(() => null);
}
async function pearDelete(path) {
  let r;
  try { r = await fetch(PEAR + path, { method: 'DELETE' }); }
  catch (e) { slog('pear', 'DELETE ' + path + ' fetch-fail: ' + (e && e.message)); throw e; }
  if (!r.ok && r.status !== 204) { slog('pear', 'DELETE ' + path + ' HTTP ' + r.status); throw new Error(r.status + ' ' + r.statusText); }
}

// ── State ─────────────────────────────────────────────────────────────────────
let queue = [];
let cfg = {
  rewardId: '', anyRedeem: false,
  allowSrCommand: true,
  srCmdWho: 'sub',
  maxQueueSize: 20,
  srCooldownSeconds: 300,
  cooldownIncludesRedeems: true,
  sparkRewardId: '',            // reward SPARK created and owns (refundable)
  sparkRewardTitle: 'Song Request',
  sparkRewardCost: 300,
  overlayStyle: 'card',
  noShadow: false,
  seekColor: '#ffc83d',
  maxPerUser: 2,
  showQueueOverlay: false,
  // Songs the streamer never wants played. Each entry is
  // { videoId, title, norm } — see isBlocked() for why both are kept.
  blocked: [],
  chatMsgEnabled: false,
  chatMsgSuccess:  '<<username>> your song has been added! (<<song>> by <<artist>>)',
  chatMsgBadUrl:   "@<<username>> Couldn't find that song. Try a YouTube link or song title.",
  chatMsgCooldown: "@<<username>> You're on cooldown! Try again in <<time>> minute(s).",
  chatMsgPerUser:  "@<<username>> You already have <<count>> song(s) queued (max <<max>>).",
  chatMsgBlocked:  '@<<username>> that song is blocked and cannot be requested.',
};
let currentSong      = null;
let currentRequester = '';
let localPosition    = 0;
let localDuration    = 0;
let localIsPlaying   = false;
let lastVideoId      = null;
let pollInterval     = null;
let interpInterval   = null;
let watchdogInterval = null;
let watchdogMissCount = 0;     // consecutive watchdog misses; only re-insert on the 2nd
let saveTimer        = null;
let pollErrors       = 0;
let wsStarted        = false;
let pearWs           = null;
let lastInsertedId   = null;   // videoId last inserted into Pear's queue (dedupe)
let lastWsMsg        = 0;      // timestamp of last WS message (liveness)
let reconnectTimer   = null;
let srCooldowns      = {};
let lastPollTime     = 0;
let lastPushedTitle  = '';
let lastPushedThumb  = '';
let lastPushedPlaying = null;

function uid() { return Math.random().toString(36).slice(2, 10); }
function fmt(s) { s = Math.floor(s || 0); return Math.floor(s / 60) + ':' + (s % 60).toString().padStart(2, '0'); }
function persist() {
  clearTimeout(saveTimer);
  // cooldowns ride along so a mid-stream SPARK restart can't reset every
  // viewer's request cooldown to zero.
  saveTimer = setTimeout(() => { invoke('save_songrequest', { data: { cfg, queue, cooldowns: srCooldowns } }); }, 300);
}

// ── Chat helpers ──────────────────────────────────────────────────────────────
function formatChatMsg(template, vars) {
  return (template || '')
    .replace(/<<username>>/g,    vars.username    ?? '')
    .replace(/<<song>>/g,        vars.song        ?? '')
    .replace(/<<artist>>/g,      vars.artist      ?? '')
    .replace(/<<time>>/g,        String(vars.time        ?? ''))
    .replace(/<<count>>/g,       String(vars.count       ?? ''))
    .replace(/<<max>>/g,         String(vars.max         ?? ''));
}
function sendChatMsg(template, vars) {
  if (!cfg.chatMsgEnabled || !template) return;
  const msg = formatChatMsg(template, vars).trim();
  if (!msg) return;
  invoke('twitch_send_chat_message', { message: msg }).catch(() => {});
}

// ── Connection ────────────────────────────────────────────────────────────────
function setPearStatus(kind, msg) {
  const dot = $('srDot'), txt = $('srStatusText'); if (!dot || !txt) return;
  dot.className = 'dot' + (kind ? ' ' + kind : ''); txt.textContent = msg;
}

async function tryConnect() {
  try {
    const song = await pearGet('/song');
    currentSong = song;
    if (song) {
      lastVideoId    = song.videoId;
      localPosition  = song.elapsedSeconds || 0;
      localDuration  = song.songDuration   || 0;
      localIsPlaying = !song.isPaused;
      lastPollTime   = Date.now();
      updateNowPlayingUI();
      pushOverlayState();
    }
    $('srConnectedBox').style.display = 'block';
    $('srConnectBtn').style.display   = 'none';
    setPearStatus('on', 'Connected to Pear Desktop');
    slog('pear', 'connected; nowPlaying=' + (song ? song.videoId + ' "' + (song.title || '') + '"' : 'none'));
    startTimers();
    if (!wsStarted) connectPearWs();
    loadRewards();
    return true;
  } catch (e) {
    slog('pear', 'connect failed: ' + (e && e.message));
    return false;
  }
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function startTimers() {
  if (pollInterval)     clearInterval(pollInterval);
  if (interpInterval)   clearInterval(interpInterval);
  if (watchdogInterval) clearInterval(watchdogInterval);
  pollInterval     = setInterval(healthCheck, 10000);
  watchdogInterval = setInterval(queueWatchdog, 60000);
  interpInterval = setInterval(() => {
    if (!localIsPlaying || localDuration <= 0) return;
    const elapsed = (Date.now() - lastPollTime) / 1000;
    updateProgressBar(Math.min(localPosition + elapsed, localDuration), localDuration);
  }, 100);
}

function connectPearWs() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (pearWs) { const old = pearWs; pearWs = null; try { old.close(1000, 'r'); } catch (e) { } }
  wsStarted = true;
  slog('ws', 'connecting');
  const sock = new WebSocket('ws://localhost:26538/api/v1/ws');
  pearWs = sock;
  sock.onopen    = () => {
    if (pearWs !== sock) return;
    pollErrors = 0; lastWsMsg = Date.now();
    slog('ws', 'open');
    setPearStatus('on', 'Connected to Pear Desktop');
  };
  sock.onmessage = (ev) => {
    if (pearWs !== sock) return;
    lastWsMsg = Date.now();
    try { handleWsMessage(JSON.parse(ev.data)); } catch (e) { slog('ws', 'msg parse/handle error: ' + (e && e.message)); }
  };
  sock.onerror   = () => { slog('ws', 'error event'); };
  sock.onclose   = (ev) => {
    if (pearWs !== sock) return; // stale socket from a previous connect
    pearWs = null;
    if (!wsStarted) return;
    pollErrors++;
    slog('ws', 'closed code=' + (ev && ev.code) + ' pollErrors=' + pollErrors + ' (reconnect in 3s)');
    if (pollErrors >= 3) { setPearStatus('err', 'Lost connection to Pear Desktop'); localIsPlaying = false; }
    // Always reconnect while enabled — even on a clean close (Pear restart etc.)
    if (!reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = null; if (wsStarted && !pearWs) connectPearWs(); }, 3000);
  };
}

function stopWs() {
  wsStarted = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (pearWs) { const old = pearWs; pearWs = null; try { old.close(1000, 'd'); } catch (e) { } }
}

// Insert queue[0] into Pear's queue, but never the same video twice in a row.
// lastInsertedId is cleared when that song actually plays (advanceQueue shift).
function queueNextToPear() {
  if (!queue.length) return;
  const vid = queue[0].videoId;
  if (!vid || vid === lastInsertedId) { slog('queue', 'insert SKIPPED (dedupe) vid=' + vid + ' lastInserted=' + lastInsertedId); return; }
  lastInsertedId = vid;
  slog('queue', 'inserting next vid=' + vid + ' qlen=' + queue.length);
  pearPost('/queue', { videoId: vid, insertPosition: 'INSERT_AFTER_CURRENT_VIDEO' })
    .then(() => { setTimeout(() => verifyInsert(vid), 1500); })
    .catch((e) => { slog('queue', 'insert FAILED vid=' + vid + ': ' + (e && e.message)); if (lastInsertedId === vid) lastInsertedId = null; });
}

// Diagnostic: the 204 from POST /queue says nothing about WHERE the song landed,
// and an inserted song can end up unreachable in a long Pear queue. Log its
// actual position relative to Pear's current index after every insert.
async function verifyInsert(vid) {
  try {
    const info = await pearGet('/queue');
    const { currentIndex, ids } = extractQueueState(info || {});
    const at = ids.indexOf(vid);
    if (at === -1) {
      slog('queue', 'verify: ' + vid + ' NOT in Pear queue after insert (pearQlen=' + ids.length + ' cur=' + currentIndex + ')');
    } else if (at === currentIndex + 1) {
      slog('queue', 'verify: ' + vid + ' landed at cur+1 (index ' + at + ') — correct');
    } else {
      slog('queue', 'verify: ' + vid + ' landed at index ' + at + ' (cur=' + currentIndex + ' pearQlen=' + ids.length + ') — WRONG SPOT');
    }
  } catch (e) { slog('queue', 'verify failed: ' + (e && e.message)); }
}

// Parse Pear's GET /queue response into { currentIndex, ids[] }.
// Each item wraps a playlistPanelVideoRenderer (sometimes nested inside a
// playlistPanelVideoWrapperRenderer); the currently playing item has selected=true.
function extractQueueState(info) {
  const items = (info && info.items) || [];
  let currentIndex = -1;
  const ids = items.map((item, i) => {
    const r = item.playlistPanelVideoRenderer
      || (item.playlistPanelVideoWrapperRenderer
          && item.playlistPanelVideoWrapperRenderer.primaryRenderer
          && item.playlistPanelVideoWrapperRenderer.primaryRenderer.playlistPanelVideoRenderer);
    if (r && r.selected === true) currentIndex = i;
    return r ? r.videoId : null;
  });
  return { currentIndex, ids };
}

// Every 60s: verify the next SR song actually exists in Pear's upcoming queue.
// Self-heals silent insert failures, Pear restarts, or a stuck dedupe.
async function queueWatchdog() {
  try {
    if (!queue.length) { watchdogMissCount = 0; return; }
    const vid = queue[0].videoId;
    if (!vid) return;
    const info = await pearGet('/queue');
    const { currentIndex, ids } = extractQueueState(info || {});
    if (ids[currentIndex] === vid) { watchdogMissCount = 0; return; }          // it's playing right now
    if (ids.slice(currentIndex + 1).includes(vid)) { watchdogMissCount = 0; return; } // it's queued — all good
    // Present but BEHIND the current index: either it already played or Pear's
    // selected pointer is stale. Re-inserting in this state causes backwards
    // jumps and replays — log it and leave it alone.
    const behindAt = ids.indexOf(vid);
    if (behindAt !== -1) {
      slog('watchdog', vid + ' present but BEHIND cur (at=' + behindAt + ' cur=' + currentIndex + ' pearQlen=' + ids.length + ') — not re-inserting');
      watchdogMissCount = 0;
      return;
    }
    // Genuinely missing: require two consecutive misses (2 min) before acting,
    // so a transient/stale GET /queue snapshot can't trigger a bogus re-insert.
    watchdogMissCount++;
    if (watchdogMissCount < 2) {
      slog('watchdog', vid + ' missing from Pear queue (1st strike, pearQlen=' + ids.length + ' cur=' + currentIndex + ') — rechecking next cycle');
      return;
    }
    slog('watchdog', 'next SR song ' + vid + ' MISSING from Pear queue twice (pearQlen=' + ids.length + ' cur=' + currentIndex + ' lastInserted=' + lastInsertedId + ') — re-inserting');
    watchdogMissCount = 0;
    lastInsertedId = null;
    queueNextToPear();
  } catch (e) {
    slog('watchdog', 'check failed: ' + (e && e.message));
  }
}

// Normalise a title for fuzzy comparison: lowercase, drop bracketed/parenthetical
// asides (feat, remix, official video, artist tags), collapse to alphanumeric
// tokens. Used to recognise a song across a YouTube -> YouTube Music id remap.
function normTitle(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
// True if two titles almost certainly refer to the same song. Tolerant enough
// to survive "SAINt JHN - Dangerous" vs "Dangerous", strict enough that a Pear
// autoplay track (a different song) won't collide with a queued request.
function titlesMatch(a, b) {
  a = normTitle(a); b = normTitle(b);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const ta = new Set(a.split(' ').filter(w => w.length > 2));
  const tb = b.split(' ').filter(w => w.length > 2);
  if (!ta.size || !tb.length) return false;
  const common = tb.filter(w => ta.has(w)).length;
  return common / Math.max(ta.size, tb.length) >= 0.6;
}

// The queue item most recently shifted off by advanceQueue — the caller
// settles its redemption (fulfill on play, refund on a too-long auto-skip).
let lastAdvancedItem = null;

// Shared by the WS VIDEO_CHANGED handler and the health-check watchdog.
// Returns true if the new video was our queue[0] (an SR queue item).
function advanceQueue(vid) {
  slog('queue', 'advance vid=' + vid + ' q0=' + (queue[0] ? queue[0].videoId : 'none') + ' qlen=' + queue.length + ' lastInserted=' + lastInsertedId);
  let wasQueueItem = false;
  lastAdvancedItem = null;
  if (vid && queue.length > 0 && queue[0].videoId === vid) {
    wasQueueItem = true;
    currentRequester = queue[0].requester || '';
    lastAdvancedItem = queue[0];
    queue.shift();
    if (lastInsertedId === vid) lastInsertedId = null;
    renderQueue();
    persist();
  } else if (vid && queue.length > 0 && queue[0].videoId === lastInsertedId
             && titlesMatch(queue[0].title, currentSong && currentSong.title)) {
    // ID REMAP: we inserted queue[0] right after the previous song and the
    // track that actually started is the SAME song under a different videoId
    // (YouTube Music swaps a linked youtu.be/watch id for its catalog id on
    // playback). An exact id comparison does not catch this, so match by title
    // to still attribute + dequeue. Autoplay interlopers are rejected here
    // because their title won't match the queued song.
    wasQueueItem = true;
    slog('queue', 'REMAP matched q0 vid=' + queue[0].videoId + ' -> playing vid=' + vid + ' "' + (currentSong && currentSong.title || '') + '"');
    currentRequester = queue[0].requester || '';
    lastAdvancedItem = queue[0];
    if (lastInsertedId === queue[0].videoId) lastInsertedId = null;
    queue.shift();
    renderQueue();
    persist();
  } else {
    if (vid && queue.length > 0 && queue[0].videoId === lastInsertedId) {
      // Our inserted song's slot advanced to a different id but the title
      // didn't match — log it so we can tune titlesMatch if it was a real remap.
      slog('queue', 'NO-MATCH: playing vid=' + vid + ' "' + (currentSong && currentSong.title || '') + '" != q0 vid=' + queue[0].videoId + ' "' + (queue[0].title || '') + '"');
    }
    currentRequester = '';
  }
  // Line up the next SR song (deduped — safe to call on every video change)
  queueNextToPear();
  return wasQueueItem;
}

function handleWsMessage(msg) {
  const type = msg.type;

  if (type === 'PLAYER_INFO' || type === 'VIDEO_CHANGED') {
    const prevVideoId = lastVideoId;
    currentSong    = msg.song || null;
    localPosition  = msg.position || 0;
    localDuration  = currentSong?.songDuration || 0;
    localIsPlaying = msg.isPlaying ?? (currentSong ? !currentSong.isPaused : false);
    lastPollTime   = Date.now();
    const vid = currentSong?.videoId || null;

    if (type === 'VIDEO_CHANGED' && prevVideoId !== vid) {
      slog('ws', 'VIDEO_CHANGED ' + prevVideoId + ' -> ' + vid + ' "' + (currentSong && currentSong.title || '') + '"');
      const wasQueueItem = advanceQueue(vid);
      if (wasQueueItem) {
        // The request actually played: mark it fulfilled so it clears out of
        // the dashboard's pending redemptions. NOTE this is also why !srblock
        // cannot refund the song it blocks — by the time it is playing, the
        // redemption is FULFILLED and Twitch refuses to reverse it.
        fulfillRedemption(lastAdvancedItem && lastAdvancedItem.redemptionId);
      }
      lastAdvancedItem = null;
    }

    lastVideoId = vid;
    updateNowPlayingUI();
    pushOverlayState();
    fetchQueueTitles();

  } else if (type === 'PLAYER_STATE_CHANGED') {
    localIsPlaying = msg.isPlaying ?? localIsPlaying;
    localPosition  = msg.position  ?? localPosition;
    lastPollTime   = Date.now();
    if (currentSong) { currentSong.isPaused = !localIsPlaying; currentSong.elapsedSeconds = localPosition; }
    updateNowPlayingUI();
    pushOverlayState();

  } else if (type === 'POSITION_CHANGED') {
    localPosition = msg.position ?? localPosition;
    lastPollTime  = Date.now();
    updateProgressBar(localPosition, localDuration);
    if (currentSong && localDuration > 0) {
      invoke('nowplaying_overlay_event', {
        event: { type: 'nowplaying_progress', progress: localPosition, duration: localDuration, isPlaying: localIsPlaying }
      }).catch(() => {});
    }
  }
}

async function healthCheck() {
  try {
    const song = await pearGet('/song');
    if (pollErrors >= 3) setPearStatus('on', 'Connected to Pear Desktop');
    pollErrors = 0;

    const vid = song?.videoId || null;
    if (vid && vid !== lastVideoId) {
      // REST sees a different song than our WS state — the WS missed a
      // VIDEO_CHANGED. Resync everything and run the normal advance logic.
      slog('health', 'RESYNC: REST vid=' + vid + ' != lastVideoId=' + lastVideoId + ' wsAge=' + (Date.now() - lastWsMsg) + 'ms');
      currentSong    = song;
      localPosition  = song.elapsedSeconds || 0;
      localDuration  = song.songDuration   || 0;
      localIsPlaying = !song.isPaused;
      lastPollTime   = Date.now();
      advanceQueue(vid);
      lastVideoId = vid;
      updateNowPlayingUI();
      pushOverlayState();
      fetchQueueTitles();
      // WS is clearly stale if it hasn't delivered anything recently — rebuild it
      if (wsStarted && Date.now() - lastWsMsg > 15000) connectPearWs();
    } else if (song && wsStarted && Date.now() - lastWsMsg > 30000 && !song.isPaused) {
      // Song playing but WS silent for 30s (it normally streams position
      // updates constantly) — half-open socket, rebuild it
      slog('health', 'ws silent ' + (Date.now() - lastWsMsg) + 'ms while playing — rebuilding socket');
      connectPearWs();
    }
  } catch (e) {
    pollErrors++;
    slog('health', 'poll FAILED #' + pollErrors + ': ' + (e && e.message));
    if (pollErrors >= 3) { setPearStatus('err', 'Lost connection to Pear Desktop'); localIsPlaying = false; }
  }
}

// ── Queue ─────────────────────────────────────────────────────────────────────
async function fetchQueueTitles() {
  for (const item of queue) {
    if (item.title === 'Loading...' && item.videoId && !item._fetching) {
      item._fetching = true;
      try {
        const r = await fetch('https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=' + item.videoId + '&format=json');
        if (r.ok) {
          const d = await r.json();
          item.title     = d.title       || item.videoId;
          item.author    = (d.author_name || '').replace(/\s*-\s*Topic$/i, '');
          item.thumbnail = 'https://img.youtube.com/vi/' + item.videoId + '/mqdefault.jpg';
          // Blocked check, stage 2. The title only becomes known here, so a
          // song blocked under a different video id (the YTM remap case) is
          // caught now rather than at request time. Pull it, refund, and say so.
          if (isBlocked(item.videoId, item.title)) {
            slog('sr', 'REJECTED late: blocked by title "' + item.title + '" vid=' + item.videoId);
            sendChatMsg(cfg.chatMsgBlocked, { username: item.requester, song: item.title });
            refundRedemption(item.redemptionId, 'blocked song (by title)');
            queue = queue.filter(q => q.id !== item.id);
            if (item.videoId === lastInsertedId) removeFromPearQueue(item.videoId);
            renderQueue();
            persist();
            continue;
          }
          if (item._pendingChatMsg) {
            item._pendingChatMsg = false;
            sendChatMsg(cfg.chatMsgSuccess, { username: item.requester, song: item.title, artist: item.author });
          }
          renderQueue();
          persist();
        }
      } catch (e) {}
      item._fetching = false;
    }
  }
}

async function requestSong(url, requester, userId, isHost, isRedeem, redemptionId) {
  slog('sr', 'request "' + url + '" by ' + requester + (isRedeem ? ' [redeem]' : '') + (isHost ? ' [host]' : ''));
  let videoId = extractVideoId(url);
  if (!videoId) videoId = await searchVideoId(url.trim());
  if (!videoId) {
    slog('sr', 'REJECTED: no videoId resolved');
    sendChatMsg(cfg.chatMsgBadUrl, { username: requester });
    refundRedemption(redemptionId, 'bad url');
    return;
  }
  // Blocked check, stage 1 (by id). Deliberately FIRST: a blocked song is a
  // hard no, so it must not consume the viewer's cooldown on the way out.
  // Stage 2 (by title) runs in fetchQueueTitles once the real title lands —
  // see isBlocked() for why an id check alone isn't enough.
  if (isBlocked(videoId, '')) {
    slog('sr', 'REJECTED: blocked vid=' + videoId);
    sendChatMsg(cfg.chatMsgBlocked, { username: requester, song: blockedLabel(videoId, '') });
    refundRedemption(redemptionId, 'blocked song');
    return;
  }
  if (queue.length >= cfg.maxQueueSize) {
    slog('sr', 'REJECTED: queue full (' + queue.length + '/' + cfg.maxQueueSize + ')');
    refundRedemption(redemptionId, 'queue full');
    return;
  }

  if (!isHost && cfg.maxPerUser > 0 && userId) {
    const userCount = queue.filter(q => q.userId === userId).length;
    if (userCount >= cfg.maxPerUser) {
      slog('sr', 'REJECTED: per-user limit (' + userCount + '/' + cfg.maxPerUser + ')');
      sendChatMsg(cfg.chatMsgPerUser, { username: requester, count: userCount, max: cfg.maxPerUser });
      refundRedemption(redemptionId, 'per-user limit');
      return;
    }
  }

  if (!isHost && userId && cfg.srCooldownSeconds > 0) {
    // A redeem is only exempt from the CHECK when the setting says so — but it
    // always STARTS the cooldown below. Without both, !sr and the redeem could
    // be combined to skirt the time limit in either order.
    const exempt  = isRedeem && cfg.cooldownIncludesRedeems === false;
    const last    = srCooldowns[userId] || 0;
    const elapsed = (Date.now() - last) / 1000;
    if (!exempt && elapsed < cfg.srCooldownSeconds) {
      const remaining = Math.ceil((cfg.srCooldownSeconds - elapsed) / 60);
      slog('sr', 'REJECTED: cooldown' + (isRedeem ? ' [redeem]' : '') + ', ' + Math.round(cfg.srCooldownSeconds - elapsed) + 's left');
      sendChatMsg(cfg.chatMsgCooldown, { username: requester, time: remaining });
      refundRedemption(redemptionId, 'cooldown');
      return;
    }
    // Prune expired entries so the map can't grow forever over a long session
    for (const k in srCooldowns) {
      if (Date.now() - srCooldowns[k] > cfg.srCooldownSeconds * 1000) delete srCooldowns[k];
    }
    srCooldowns[userId] = Date.now();
  }

  const wasEmpty = queue.length === 0;
  queue.push({
    id: uid(), videoId,
    title: 'Loading...', author: '', thumbnail: '',
    requester: requester || 'someone', userId: userId || '',
    redemptionId: redemptionId || '',
    _pendingChatMsg: true, _fetching: false,
  });
  renderQueue();
  persist();
  slog('sr', 'ADDED vid=' + videoId + ' qlen=' + queue.length + ' wasEmpty=' + wasEmpty + ' nowPlaying=' + (currentSong ? currentSong.videoId : 'none'));

  if (wasEmpty) {
    try {
      lastInsertedId = videoId;
      await pearPost('/queue', { videoId, insertPosition: 'INSERT_AFTER_CURRENT_VIDEO' });
      if (!currentSong) await pearPost('/next');
    } catch (e) {
      slog('sr', 'initial insert FAILED vid=' + videoId + ': ' + (e && e.message));
      if (lastInsertedId === videoId) lastInsertedId = null;
    }
  }
  fetchQueueTitles();
}

function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.searchParams.get('v')) return u.searchParams.get('v');
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('?')[0];
  } catch (e) {}
  if (/^[a-zA-Z0-9_-]{11}$/.test(url.trim())) return url.trim();
  return null;
}

async function searchVideoId(query) {
  // Try Pear Desktop search first. NOTE: 'params' must be a string or absent —
  // Pear's schema rejects null with HTTP 400, so never send params: null.
  try {
    const result = await pearPost('/search', { query });
    if (result) {
      const str = JSON.stringify(result);
      // Match "videoId" only — generic "id" keys can be channel/playlist junk.
      const m = str.match(/"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/);
      if (m) { slog('sr', 'search resolved via pear: ' + m[1]); return m[1]; }
      const m2 = str.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
      if (m2) { slog('sr', 'search resolved via pear (url): ' + m2[1]); return m2[1]; }
    }
    slog('sr', 'pear search returned no match');
  } catch (e) { slog('sr', 'pear search failed: ' + (e && e.message)); }
  // Fallback: public YouTube search APIs, tried in order — individual
  // Piped/Invidious instances come and go, so don't depend on just one.
  const FALLBACK_APIS = [
    'https://pipedapi.kavin.rocks/search?filter=videos&q=',
    'https://piped.video/api/search?filter=videos&q=',
    'https://inv.nadeko.net/api/v1/search?type=video&q=',
  ];
  for (const base of FALLBACK_APIS) {
    try {
      const r = await fetch(base + encodeURIComponent(query), { signal: AbortSignal.timeout(4000) });
      if (!r.ok) continue;
      const str = JSON.stringify(await r.json());
      const m = str.match(/"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/) || str.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
      if (m) { slog('sr', 'search resolved via fallback API: ' + m[1]); return m[1]; }
    } catch (e) {}
  }
  slog('sr', 'search FAILED (all sources) for: ' + query);
  return null;
}

// ── Blocked songs ─────────────────────────────────────────────────────────────
// Two identities are stored per blocked song, and either one matching is enough.
// A video id alone is not sufficient: YouTube Music hands the same track a
// different id depending on whether it arrived as a youtu.be link or came from
// its own catalogue (the remap advanceQueue() already copes with). Titles are
// compared as EXACT normalised strings rather than through titlesMatch(), whose
// fuzzy 60% overlap is right for "is this the song I just queued" but would
// eventually block an innocent track with a similar name.

function blockedList() {
  if (!Array.isArray(cfg.blocked)) cfg.blocked = [];
  return cfg.blocked;
}

// Do two normalised titles refer to the same track? Exact match, or one fully
// contained in the other ON WORD BOUNDARIES.
//
// Containment is required, not optional: the remap case this exists for is
// precisely a title mismatch. Blocking while a song plays stores YTM's title
// ("In the End"), while a later request resolves through oEmbed to YouTube's
// ("Linkin Park - In the End"). Exact comparison misses every one of those.
//
// The length guard stops short titles over-blocking: "Numb" must not block
// "Numb Encore", but "Dangerous" should still catch "SAINt JHN - Dangerous".
// Padding both sides with spaces makes it word-wise, so "Numb" also cannot
// match "Numbers".
//
// Accepted trade: a title that genuinely contains another ("In the End" vs
// "In the End of Time") blocks both. Rare, visible, and one click to undo —
// judged better than a block that silently fails to hold.
function titleBlockMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.split(' ').length < 2 && short.length < 8) return false;
  return (' ' + long + ' ').includes(' ' + short + ' ');
}

function isBlocked(videoId, title) {
  const n = normTitle(title);
  return blockedList().some(b =>
    (videoId && b.videoId === videoId) || titleBlockMatch(n, b.norm));
}

// What to call the song in a chat reply — prefer the blocked entry's stored
// title, since at request time we usually only have an id.
function blockedLabel(videoId, title) {
  const n = normTitle(title);
  const hit = blockedList().find(b =>
    (videoId && b.videoId === videoId) || titleBlockMatch(n, b.norm));
  return (hit && hit.title) || title || videoId || 'that song';
}

// Adds to the block list and clears any copies already waiting in the queue,
// refunding those requesters. Returns false if it was already blocked.
function addBlocked(videoId, title) {
  if (!videoId && !title) return false;
  if (isBlocked(videoId, title)) return false;
  blockedList().push({ videoId: videoId || '', title: title || '', norm: normTitle(title), at: Date.now() });
  slog('block', 'blocked vid=' + videoId + ' "' + (title || '') + '"');

  // Sweep the queue: every matching entry goes, and each requester gets their
  // points back (these never played, so the redemption is still refundable).
  const doomed = queue.filter(q => isBlocked(q.videoId, q.title));
  if (doomed.length) {
    doomed.forEach(q => refundRedemption(q.redemptionId, 'song blocked'));
    queue = queue.filter(q => !isBlocked(q.videoId, q.title));
    renderQueue();
    // If one of them had already been pushed into Pear, pull it back out.
    doomed.forEach(q => { if (q.videoId && q.videoId === lastInsertedId) removeFromPearQueue(q.videoId); });
    slog('block', 'removed ' + doomed.length + ' queued cop' + (doomed.length === 1 ? 'y' : 'ies'));
  }
  persist();
  renderBlocked();
  return true;
}

function unblock(idx) {
  const list = blockedList();
  if (idx < 0 || idx >= list.length) return;
  const gone = list.splice(idx, 1)[0];
  slog('block', 'unblocked "' + ((gone && gone.title) || (gone && gone.videoId) || '?') + '"');
  persist();
  renderBlocked();
}

// ── Twitch ────────────────────────────────────────────────────────────────────
// Refund / fulfill only work for the reward SPARK created itself — Twitch
// blocks redemption updates on rewards made anywhere else.
function refundRedemption(redemptionId, why) {
  if (!redemptionId || !cfg.sparkRewardId) return;
  invoke('twitch_update_redemption', { rewardId: cfg.sparkRewardId, redemptionId, status: 'CANCELED' })
    .then(() => slog('sr', 'REFUNDED redemption ' + redemptionId + ' (' + why + ')'))
    .catch(e => slog('sr', 'refund FAILED (' + why + '): ' + e));
}
function fulfillRedemption(redemptionId) {
  if (!redemptionId || !cfg.sparkRewardId) return;
  invoke('twitch_update_redemption', { rewardId: cfg.sparkRewardId, redemptionId, status: 'FULFILLED' })
    .catch(e => slog('sr', 'fulfill failed: ' + e));
}

window.addEventListener('spark-redeem', e => {
  const d = e.detail;
  const match = cfg.anyRedeem || d.reward_id === cfg.rewardId;
  slog('twitch', 'redeem by ' + d.user_name + ' reward=' + d.reward_id + ' match=' + match + ' hasInput=' + !!d.user_input);
  if (!match) return;
  // Redemptions of the SPARK-owned reward are refundable on any rejection
  const redemptionId = (cfg.sparkRewardId && d.reward_id === cfg.sparkRewardId) ? d.redemption_id : null;
  if (toolBlocked('songrequest', d.user_name)) { refundRedemption(redemptionId, 'tool off'); return; }
  if (d.user_input) requestSong(d.user_input, d.user_name, d.user_id, false, true, redemptionId);
  else refundRedemption(redemptionId, 'no text entered');
});
async function srCmdAllowed(d) {
  if (d.is_broadcaster) return true;
  if (cfg.srCmdWho === 'broadcaster') return false;
  if (d.is_mod) return true;
  if (cfg.srCmdWho === 'mod') return false;
  if (d.is_sub) return true;
  if (cfg.srCmdWho === 'sub') return false;
  if (cfg.srCmdWho === 'follower') {
    try { return await invoke('twitch_check_follower', { userId: d.user_id, broadcasterId: store.twitch.userId }); }
    catch(e) { return false; }
  }
  return true; // viewer = everyone
}
window.addEventListener('spark-chat', async e => {
  const d = e.detail;
  if (!cfg.allowSrCommand) return;
  const msg = (d.message || '').trim();
  if (!msg.toLowerCase().startsWith('!sr ')) return;
  if (toolBlocked('songrequest', d.display || d.username)) return;
  const allowed = await srCmdAllowed(d);
  slog('twitch', '!sr from ' + (d.display || d.username) + ' allowed=' + allowed);
  if (!allowed) return;
  requestSong(msg.slice(4).trim(), d.display || d.username, d.user_id, d.is_broadcaster);
});

// !srblock — blocks whatever is playing right now and skips to the next song.
// Broadcaster and mods only; anyone else is ignored with no reply, matching how
// the Timers tab treats its mod commands so viewers can't probe for them.
// Deliberately a separate listener from !sr above: that one gates on
// cfg.allowSrCommand and the "who can use !sr" tier, neither of which should
// govern a moderator control. Note "!sr " requires a trailing space, so these
// two can never match the same message.
window.addEventListener('spark-chat', e => {
  const d = e.detail;
  if ((d.message || '').trim().toLowerCase() !== '!srblock') return;
  if (!(d.is_broadcaster || d.is_mod)) return;
  if (toolBlocked('songrequest', d.display || d.username)) return;

  const vid   = (currentSong && currentSong.videoId) || '';
  const title = (currentSong && currentSong.title)   || '';
  if (!vid && !title) { slog('block', '!srblock ignored — nothing is playing'); return; }

  const added = addBlocked(vid, title);
  slog('block', '!srblock by ' + (d.display || d.username) + ' vid=' + vid + ' "' + title + '" new=' + added);
  sendChatMsg(added ? 'Blocked <<song>> — it will not play again.'
                    : '<<song>> is already blocked.', { song: title || vid });
  // Skip it. Nothing to refund: a song that is playing has already had its
  // redemption marked FULFILLED, and Twitch will not reverse that.
  pearPost('/next').catch(() => {});
});

// ── SPARK-managed reward (create / update / remove) ──────────────────────────
function sparkStatus(msg) { const s = $('srSparkStatus'); if (s) s.textContent = msg; }

function updateSparkRewardUI() {
  const btns = $('srSparkBtns'); if (!btns) return;
  if (cfg.sparkRewardId) {
    btns.innerHTML = '<button class="btn-sm" id="srSparkUpdate">Update name/cost</button>'
      + '<button class="btn-sm btn-ghost" id="srSparkRemove">Remove reward</button>';
    sparkStatus('Active. Redeems of this reward refund automatically when rejected.');
    $('srSparkUpdate').addEventListener('click', async () => {
      const title = $('srSparkTitle').value.trim() || 'Song Request';
      const cost  = Math.max(1, parseInt($('srSparkCost').value) || 300);
      try {
        await invoke('twitch_update_reward', { rewardId: cfg.sparkRewardId, title, cost });
        cfg.sparkRewardTitle = title; cfg.sparkRewardCost = cost;
        persist(); loadRewards();
        sparkStatus('Updated on Twitch.');
      } catch (e) { sparkStatus('Update failed: ' + e); }
    });
    $('srSparkRemove').addEventListener('click', async () => {
      if (!confirm('Remove the SPARK reward from Twitch? Viewers will no longer see it.')) return;
      try {
        await invoke('twitch_delete_reward', { rewardId: cfg.sparkRewardId });
        if (cfg.rewardId === cfg.sparkRewardId) cfg.rewardId = '';
        cfg.sparkRewardId = '';
        persist(); loadRewards(); updateSparkRewardUI();
      } catch (e) { sparkStatus('Remove failed: ' + e); }
    });
  } else {
    btns.innerHTML = '<button class="btn-sm btn-gold" id="srSparkCreate">Create reward on Twitch</button>';
    sparkStatus('');
    $('srSparkCreate').addEventListener('click', async () => {
      const title = $('srSparkTitle').value.trim() || 'Song Request';
      const cost  = Math.max(1, parseInt($('srSparkCost').value) || 300);
      sparkStatus('Creating…');
      try {
        const r = await invoke('twitch_create_reward', { title, cost, prompt: 'Paste a YouTube link or type a song name' });
        cfg.sparkRewardId = r.id; cfg.sparkRewardTitle = title; cfg.sparkRewardCost = cost;
        cfg.rewardId = r.id; // becomes the trigger reward
        persist(); loadRewards(); updateSparkRewardUI();
        sparkStatus('Created and selected as the trigger reward. If you have an old dashboard-made reward, pause or delete it in Twitch.');
      } catch (e) {
        sparkStatus('Create failed: ' + e + '. If this mentions permissions or scope, log out and reconnect Twitch in Settings first, then try again.');
      }
    });
  }
}

async function sendPearCmd(cmd) { try { await pearPost('/' + cmd); } catch (e) {} }
window.ytmCmd = (cmd) => sendPearCmd(cmd);

// ── Queue overlay ─────────────────────────────────────────────────────────────
function pushQueueOverlay() {
  if (!cfg.showQueueOverlay) {
    invoke('srqueue_overlay_event', { event: { type: 'srqueue_hide' } }).catch(() => {});
    return;
  }
  const songs = queue.map(item => ({
    videoId:   item.videoId,
    title:     item.title === 'Loading...' ? '' : (item.title || ''),
    author:    item.author    || '',
    thumbnail: item.thumbnail || '',
    requester: item.requester || '',
  }));
  invoke('srqueue_overlay_event', { event: { type: 'srqueue', songs } }).catch(() => {});
}

// ── Now Playing overlay ───────────────────────────────────────────────────────
function pushOverlayState() {
  const song = currentSong;
  if (!song) {
    if (lastPushedTitle !== '') {
      lastPushedTitle = ''; lastPushedThumb = ''; lastPushedPlaying = null;
      invoke('nowplaying_overlay_event', { event: { type: 'nowplaying_stop' } }).catch(() => {});
    }
    return;
  }
  const thumb     = song.imageSrc || '';
  const thumbBase = thumb.split('?')[0];
  const playing   = localIsPlaying;
  if (song.title === lastPushedTitle && thumbBase === lastPushedThumb && playing === lastPushedPlaying) return;
  lastPushedTitle = song.title || ''; lastPushedThumb = thumbBase; lastPushedPlaying = playing;
  invoke('nowplaying_overlay_event', {
    event: {
      type:      'nowplaying',
      title:     song.title  || '',
      author:    song.artist || '',
      album:     song.album  || '',
      thumbnail: thumb,
      videoId:   song.videoId || '',
      progress:  localPosition,
      duration:  localDuration,
      isPlaying: playing,
      style:     cfg.overlayStyle || 'card',
      noShadow:  !!cfg.noShadow,
      seekColor: cfg.seekColor || '#ffc83d',
      requester: currentRequester || '',
    }
  }).catch(() => {});
}

// Forces the overlay to re-render immediately (bypassing the title/thumb/
// playing dedupe above) — used when a style/appearance setting changes so
// OBS updates right away instead of waiting for the next song change.
function forceOverlayRepush() {
  lastPushedTitle = null;
  pushOverlayState();
}

// ── Now Playing UI ────────────────────────────────────────────────────────────
function updateNowPlayingUI() {
  // Publish for the Commands tab's {song} / {songartist} / {songrequester} /
  // {queuelength} variables. Done here because this runs on every change of
  // what's playing, which is exactly when those values move.
  liveSet('song',          (currentSong && currentSong.title)  || '');
  liveSet('songArtist',    (currentSong && currentSong.artist) || '');
  liveSet('songRequester', currentRequester || '');
  liveSet('nextSong',      (queue[0] && queue[0].title) || '');
  liveSet('queueLength',   queue.length);

  const el = $('srNowPlaying'); if (!el) return;
  const song = currentSong;
  if (!song) { el.innerHTML = '<div style="color:var(--muted);text-align:center;padding:20px">Nothing playing</div>'; return; }
  const thumb    = song.imageSrc || '';
  const progress = localPosition, duration = localDuration || 1, isPlaying = localIsPlaying;
  const pct      = Math.min(100, (progress / duration) * 100);
  el.innerHTML = '<div style="display:flex;gap:14px;align-items:center">'
    + (thumb ? '<img src="' + esc(thumb) + '" style="width:72px;height:72px;border-radius:8px;object-fit:cover;flex-shrink:0">' : '<div style="width:72px;height:72px;border-radius:8px;background:var(--line);flex-shrink:0"></div>')
    + '<div style="flex:1;min-width:0">'
    + '<div style="font-weight:700;font-size:.95rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(song.title || '') + '</div>'
    + '<div style="color:var(--muted);font-size:.82rem;margin-top:2px">' + esc(song.artist || '') + '</div>'
    + (currentRequester ? '<div style="color:var(--muted);font-size:.75rem;margin-top:1px;opacity:.7">Req: @' + esc(currentRequester) + '</div>' : '')
    + '</div></div>'
    + '<div style="margin-top:12px">'
    + '<div style="height:4px;background:rgba(255,255,255,.15);border-radius:2px;overflow:hidden">'
    + '<div id="srProgressFill" style="height:100%;width:' + pct + '%;background:var(--gold);border-radius:2px;transition:width .1s linear"></div>'
    + '</div>'
    + '<div style="display:flex;justify-content:space-between;font-size:.75rem;color:var(--muted);margin-top:4px">'
    + '<span id="srProgressTime">' + fmt(progress) + '</span><span>' + fmt(duration) + '</span>'
    + '</div></div>'
    + '<div class="row mt" style="justify-content:center;gap:10px">'
    + '<button class="btn-sm btn-ghost" onclick="window.ytmCmd(\'previous\')">&#9198;</button>'
    + '<button class="btn-sm" style="background:var(--accent);min-width:60px" onclick="window.ytmCmd(\'' + (isPlaying ? 'pause' : 'play') + '\')">' + (isPlaying ? '&#9208; Pause' : '&#9654; Play') + '</button>'
    + '<button class="btn-sm btn-ghost" onclick="window.ytmCmd(\'next\')">&#9197;</button>'
    + '</div>';
}

function updateProgressBar(progress, duration) {
  const f = $('srProgressFill'), t = $('srProgressTime');
  if (f) f.style.width = Math.min(100, (progress / (duration || 1)) * 100) + '%';
  if (t) t.textContent = fmt(progress);
}

function renderBlocked() {
  const el = $('srBlocked'); if (!el) return;
  const list = blockedList();
  if (!list.length) { el.innerHTML = '<div class="hint">Nothing blocked. Use the Block button on a queued song, or <code>!srblock</code> to block whatever is playing.</div>'; return; }
  el.innerHTML = list.map((b, i) =>
    '<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--row-line)">'
    + '<div style="flex:1;min-width:0">'
    + '<div style="font-size:.85rem;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(b.title || b.videoId || 'Unknown song') + '</div>'
    + (b.videoId ? '<div style="font-size:.72rem;color:var(--muted)">' + esc(b.videoId) + '</div>' : '')
    + '</div>'
    + '<button class="btn-sm del" data-unblock="' + i + '" title="Unblock">&times;</button>'
    + '</div>'
  ).join('');
  el.querySelectorAll('button[data-unblock]').forEach(btn => {
    btn.addEventListener('click', () => unblock(parseInt(btn.dataset.unblock, 10)));
  });
}

function renderQueue() {
  pushQueueOverlay();
  const el = $('srQueue'); if (!el) return;
  if (!queue.length) { el.innerHTML = '<div class="hint">Queue is empty.</div>'; return; }
  el.innerHTML = queue.map((item, i) =>
    '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--row-line)">'
    + '<span style="color:var(--muted);font-size:.78rem;width:18px;flex-shrink:0">' + (i + 1) + '</span>'
    + (item.thumbnail ? '<img src="' + esc(item.thumbnail) + '" style="width:40px;height:40px;border-radius:6px;object-fit:cover;flex-shrink:0">' : '<div style="width:40px;height:40px;border-radius:6px;background:var(--line);flex-shrink:0"></div>')
    + '<div style="flex:1;min-width:0">'
    + '<div style="font-size:.85rem;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(item.title || item.videoId) + '</div>'
    + '<div style="font-size:.75rem;color:var(--muted)">@' + esc(item.requester) + (item.author ? ' &middot; ' + esc(item.author) : '') + '</div>'
    + '</div>'
    + (i === 0 ? '<span class="tag" style="background:var(--ok-bg);color:var(--ok-ink);flex-shrink:0">Next</span>' : '')
    + '<button class="btn-sm btn-ghost" data-blockid="' + item.id + '" title="Block this song — it can never be requested again">Block</button>'
    + '<button class="btn-sm del" data-qid="' + item.id + '" title="Remove from queue">&times;</button>'
    + '</div>'
  ).join('');
  // Block: adds to the block list, which itself sweeps this song out of the
  // queue and refunds the requester — so there is no removal to do here.
  el.querySelectorAll('button[data-blockid]').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = queue.find(q => q.id === btn.dataset.blockid);
      if (!item) return;
      addBlocked(item.videoId, item.title === 'Loading...' ? '' : item.title);
    });
  });
  el.querySelectorAll('button[data-qid]').forEach(btn => {
    btn.addEventListener('click', () => {
      const removed = queue.find(q => q.id === btn.dataset.qid);
      queue = queue.filter(q => q.id !== btn.dataset.qid);
      renderQueue(); persist();
      slog('queue', 'user removed vid=' + (removed && removed.videoId) + ' lastInserted=' + lastInsertedId);
      // Streamer pulled the song: give the viewer their points back
      refundRedemption(removed && removed.redemptionId, 'removed by host');
      // If this song was already pushed into Pear's queue, pull it back out
      // and immediately line up the new front item. Fire-and-forget — a
      // failure just means Pear plays it anyway.
      if (removed && removed.videoId && removed.videoId === lastInsertedId) {
        removeFromPearQueue(removed.videoId);
      }
    });
  });
}

// Remove a videoId from Pear's upcoming queue (searches after the current
// song only, so it can't touch the playing track), then queue the next SR song.
async function removeFromPearQueue(vid) {
  try {
    const info = await pearGet('/queue');
    const { currentIndex, ids } = extractQueueState(info || {});
    let idx = -1;
    for (let i = currentIndex + 1; i < ids.length; i++) {
      if (ids[i] === vid) { idx = i; break; }
    }
    if (idx >= 0) {
      await pearDelete('/queue/' + idx);
      slog('queue', 'removed vid=' + vid + ' from Pear queue at index ' + idx);
    } else {
      slog('queue', 'vid=' + vid + ' not found in Pear upcoming queue (nothing to remove)');
    }
  } catch (e) {
    slog('queue', 'Pear removal failed for vid=' + vid + ': ' + (e && e.message));
  }
  if (lastInsertedId === vid) lastInsertedId = null;
  queueNextToPear();
}

async function loadRewards() {
  try {
    const r   = await invoke('twitch_get_rewards');
    const sel = $('srRewardSelect'); if (!sel) return;
    sel.innerHTML = '<option value="">(select reward)</option>'
      + (r.rewards || []).map(rw => '<option value="' + rw.id + '" ' + (rw.id === cfg.rewardId ? 'selected' : '') + '>' + esc(rw.title) + '</option>').join('');
  } catch (e) {}
}

// ── Build UI ──────────────────────────────────────────────────────────────────
function buildLeft() {
  const el = $('songrequestLeft'); if (!el) return;
  const mkOpt = (v, label) => '<option value="' + v + '" ' + (cfg.overlayStyle === v ? 'selected' : '') + '>' + label + '</option>';
  const styleOpts    = mkOpt('card','Card') + mkOpt('minimal','Minimal') + mkOpt('banner','Banner') + mkOpt('blend','Blend');
  const cooldownMins = Math.round((cfg.srCooldownSeconds  || 300) / 60);

  el.innerHTML = ''
  + '<div class="card">'
  +   '<h2>Pear Desktop Connection</h2>'
  +   '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px"><span class="dot" id="srDot"></span><span id="srStatusText">Not connected</span></div>'
  +   '<div id="srConnectedBox" style="display:none"><div class="ok">Connected to Pear Desktop</div><button class="btn-sm btn-ghost mt" id="srDisconnectBtn">Disconnect</button></div>'
  +   '<button class="btn-sm full" id="srConnectBtn" style="background:var(--gold);color:#1a1030">Connect Pear Desktop</button>'
  +   '<div class="hint mt">Make sure Pear Desktop is open with API Server enabled and auth set to <strong>None</strong>.</div>'
  + '</div>'
  + '<div class="card">'
  +   '<h2>Song Request Settings</h2>'
  +   '<label>Channel point reward</label>'
  +   '<div class="row mb"><select id="srRewardSelect" style="flex:1"></select><button class="btn-sm" id="srRefreshRewards">&#8635;</button></div>'
  +   '<div style="border:1px solid var(--line);border-radius:10px;padding:10px;margin:10px 0">'
  +     '<div style="font-weight:700;font-size:.85rem;margin-bottom:4px">SPARK-managed reward <span class="tag">auto refund</span></div>'
  +     '<div class="hint">Twitch only lets an app refund channel points on rewards that app created itself, so rewards made in the Twitch dashboard can never refund. Create the reward here instead and SPARK owns it: any rejected redeem (cooldown, full queue, over the limit, song too long, bad link) hands the points straight back, and requests that play get marked fulfilled. Edit the name and cost here in SPARK. Twitch locks the dashboard out of rewards an app creates.</div>'
  +     '<div class="row mt"><input type="text" id="srSparkTitle" value="' + esc(cfg.sparkRewardTitle || 'Song Request') + '" placeholder="Reward name" style="flex:1"><input type="number" id="srSparkCost" value="' + (cfg.sparkRewardCost || 300) + '" min="1" max="1000000" style="width:100px" title="Cost in channel points"></div>'
  +     '<div class="row mt" id="srSparkBtns"></div>'
  +     '<div class="hint" id="srSparkStatus" style="min-height:14px"></div>'
  +   '</div>'
  +   '<label class="checkrow"><input type="checkbox" id="srAnyRedeem" ' + (cfg.anyRedeem ? 'checked' : '') + '> Any redeem = song request</label>'
  +   '<label class="checkrow mt"><input type="checkbox" id="srAllowCmd" ' + (cfg.allowSrCommand ? 'checked' : '') + '> Allow <code>!sr</code> command</label>'
  +   '<label class="mt">Who can use !sr</label>'
  +   '<select id="srCmdWho">'
  +   '<option value="viewer" '      + (cfg.srCmdWho==='viewer'      ?'selected':'') + '>Everyone</option>'
  +   '<option value="follower" '    + (cfg.srCmdWho==='follower'    ?'selected':'') + '>Followers</option>'
  +   '<option value="sub" '         + (cfg.srCmdWho==='sub'         ?'selected':'') + '>Subscribers</option>'
  +   '<option value="mod" '         + (cfg.srCmdWho==='mod'         ?'selected':'') + '>Mods only</option>'
  +   '<option value="broadcaster" ' + (cfg.srCmdWho==='broadcaster' ?'selected':'') + '>Broadcaster only</option>'
  +   '</select>'
  +   '<label class="mt">Request cooldown (minutes per user)</label>'
  +   '<input type="number" id="srCooldown" value="' + cooldownMins + '" min="0" max="60" style="width:80px">'
  +   '<div class="hint">0 = no cooldown. Applies to !sr, and redeems always start the timer so the two can\'t be combined to skip it.</div>'
  +   '<label class="checkrow mt"><input type="checkbox" id="srCooldownRedeems" ' + (cfg.cooldownIncludesRedeems !== false ? 'checked' : '') + '> Redeems must wait out the cooldown too</label>'
  +   '<div class="hint">With the SPARK-managed reward above, a redeem rejected by the cooldown is refunded automatically. On a dashboard-made reward the points are still spent, so untick this if you\'d rather those redeems always go through.</div>'
  +   '<label class="mt">Max queue size</label>'
  +   '<input type="number" id="srMaxQueue" value="' + cfg.maxQueueSize + '" min="1" max="100" style="width:80px">'
  +   '<label class="mt">Per-user queue limit</label>'
  +   '<input type="number" id="srMaxPerUser" value="' + cfg.maxPerUser + '" min="0" max="20" style="width:80px">'
  +   '<div class="hint">0 = unlimited. Applies to both !sr and redeems.</div>'
  +   '<label class="mt">Overlay style</label>'
  +   '<select id="srOverlayStyle">' + styleOpts + '</select>'
  +   '<label class="checkrow mt"><input type="checkbox" id="srNoShadow" ' + (cfg.noShadow ? 'checked' : '') + '> Disable card shadow</label>'
  +   '<div class="row mt" style="align-items:center;gap:8px"><label style="margin:0">Seek bar colour</label>'
  +   '<input type="color" id="srSeekColor" value="' + esc(cfg.seekColor || '#ffc83d') + '" style="width:46px;height:26px;padding:0;border:none;background:none">'
  +   '<button class="btn-sm" id="srSeekColorReset" title="Back to default">Reset</button></div>'
  +   '<label class="checkrow mt"><input type="checkbox" id="srShowQueueOverlay" ' + (cfg.showQueueOverlay ? 'checked' : '') + '> Show queue overlay</label>'
  +   '<div class="hint">Add <code>http://localhost:4747/srqueue</code> as a browser source in OBS.</div>'
  +   '<button class="btn-sm btn-gold full mt" id="srSaveSettings">Save Settings</button>'
  + '</div>'
  + '<div class="card">'
  +   '<h2>Chat Responses</h2>'
  +   '<label class="checkrow"><input type="checkbox" id="srChatEnabled" ' + (cfg.chatMsgEnabled ? 'checked' : '') + '> Send chat messages</label>'
  +   '<div class="hint mt">Tokens: <code>&lt;&lt;username&gt;&gt;</code> <code>&lt;&lt;song&gt;&gt;</code> <code>&lt;&lt;artist&gt;&gt;</code> <code>&lt;&lt;time&gt;&gt;</code> <code>&lt;&lt;count&gt;&gt;</code> <code>&lt;&lt;max&gt;&gt;</code></div>'
  +   '<label class="mt">Song added</label><input type="text" id="srChatSuccess" value="' + esc(cfg.chatMsgSuccess) + '" style="width:100%;font-size:.82rem">'
  +   '<label class="mt">Bad URL</label><input type="text" id="srChatBadUrl" value="' + esc(cfg.chatMsgBadUrl) + '" style="width:100%;font-size:.82rem">'
  +   '<label class="mt">On cooldown</label><input type="text" id="srChatCooldown" value="' + esc(cfg.chatMsgCooldown) + '" style="width:100%;font-size:.82rem">'
  +   '<label class="mt">Per-user limit hit</label><input type="text" id="srChatPerUser" value="' + esc(cfg.chatMsgPerUser) + '" style="width:100%;font-size:.82rem">'
  +   '<label class="mt">Song is blocked</label><input type="text" id="srChatBlocked" value="' + esc(cfg.chatMsgBlocked) + '" style="width:100%;font-size:.82rem">'
  +   '<button class="btn-sm btn-gold full mt" id="srSaveChatSettings">Save Chat Settings</button>'
  + '</div>'
  + '<div class="card">'
  +   '<h2>Blocked Songs</h2>'
  +   '<div class="hint">Songs here can never be requested again, by anyone — including you. Block one with the <strong>Block</strong> button on a queued song, or type <code>!srblock</code> in chat to block whatever is playing right now and skip it. <code>!srblock</code> is broadcaster and mods only.</div>'
  +   '<div id="srBlocked" class="mt"></div>'
  + '</div>'
  + '<div class="card">'
  +   '<h2>Manual Request</h2>'
  +   '<div class="hint">Queue a song without a redeem.</div>'
  +   '<div class="row mt"><input type="text" id="srManualUrl" placeholder="YouTube URL or video ID" style="flex:1"><button class="btn-sm btn-gold" id="srManualAdd">Queue</button></div>'
  +   '<button class="btn-sm btn-ghost full mt" id="srClearQueue">Clear entire queue</button>'
  + '</div>'
  + '<div class="card">'
  +   '<h2>Diagnostics</h2>'
  +   '<div class="hint">Debug log for song requests. Kept in memory + saved every few seconds, survives an app restart.</div>'
  +   '<div class="row mt"><button class="btn-sm btn-gold" id="srCopyLogs">Copy Logs</button><button class="btn-sm btn-ghost" id="srClearLogs">Clear Logs</button></div>'
  +   '<textarea id="srLogBox" readonly style="display:none;width:100%;height:180px;margin-top:8px;font-size:.68rem;font-family:monospace;background:rgba(0,0,0,.35);color:#cfc8f0;border:1px solid var(--line);border-radius:8px;padding:8px;resize:vertical"></textarea>'
  + '</div>'
  + '<div class="card" style="margin-bottom:60px">'
  +   '<h2>Queue</h2>'
  +   '<div id="srQueue"><div class="hint">Queue is empty.</div></div>'
  + '</div>';

  $('srConnectBtn').addEventListener('click', async () => {
    setPearStatus('wait', 'Connecting...');
    const ok = await tryConnect();
    if (!ok) setPearStatus('err', 'Cannot reach Pear Desktop. Is it running with API Server enabled (auth: None)?');
  });
  $('srDisconnectBtn').addEventListener('click', () => {
    if (pollInterval)     { clearInterval(pollInterval);     pollInterval     = null; }
    if (interpInterval)   { clearInterval(interpInterval);   interpInterval   = null; }
    if (watchdogInterval) { clearInterval(watchdogInterval); watchdogInterval = null; }
    stopWs(); currentSong = null;
    slog('pear', 'user disconnected');
    $('srConnectedBox').style.display = 'none'; $('srConnectBtn').style.display = 'block';
    setPearStatus('', 'Not connected');
  });

  $('srRefreshRewards').addEventListener('click', loadRewards);
  updateSparkRewardUI();
  $('srRewardSelect').addEventListener('change',      e => { cfg.rewardId         = e.target.value;   persist(); });
  $('srAnyRedeem').addEventListener('change',         e => { cfg.anyRedeem        = e.target.checked; persist(); });
  $('srAllowCmd').addEventListener('change',          e => { cfg.allowSrCommand   = e.target.checked; persist(); });
  $('srCmdWho').addEventListener('change',            e => { cfg.srCmdWho         = e.target.value;   persist(); });
  $('srOverlayStyle').addEventListener('change',      e => { cfg.overlayStyle     = e.target.value;   persist(); forceOverlayRepush(); });
  $('srNoShadow').addEventListener('change',          e => { cfg.noShadow         = e.target.checked; persist(); forceOverlayRepush(); });
  $('srSeekColor').addEventListener('input',          e => { cfg.seekColor        = e.target.value;   persist(); forceOverlayRepush(); });
  $('srSeekColorReset').addEventListener('click',     () => { cfg.seekColor = '#ffc83d'; $('srSeekColor').value = '#ffc83d'; persist(); forceOverlayRepush(); });
  $('srShowQueueOverlay').addEventListener('change',  e => { cfg.showQueueOverlay = e.target.checked; persist(); pushQueueOverlay(); });
  $('srSaveSettings').addEventListener('click', () => {
    cfg.rewardId           = $('srRewardSelect').value;
    cfg.anyRedeem          = $('srAnyRedeem').checked;
    cfg.allowSrCommand     = $('srAllowCmd').checked;
    cfg.srCmdWho           = $('srCmdWho').value;
    cfg.srCooldownSeconds  = Math.max(0, parseInt($('srCooldown').value)  || 0) * 60;
    cfg.cooldownIncludesRedeems = $('srCooldownRedeems').checked;
    cfg.maxQueueSize       = parseInt($('srMaxQueue').value)   || 20;
    cfg.maxPerUser         = Math.max(0, parseInt($('srMaxPerUser').value) || 0);
    cfg.overlayStyle       = $('srOverlayStyle').value;
    cfg.noShadow           = $('srNoShadow').checked;
    cfg.seekColor          = $('srSeekColor').value || '#ffc83d';
    cfg.showQueueOverlay   = $('srShowQueueOverlay').checked;
    persist(); pushQueueOverlay(); forceOverlayRepush();
    const btn = $('srSaveSettings'), o = btn.textContent;
    btn.textContent = 'Saved!'; setTimeout(() => btn.textContent = o, 1200);
  });

  $('srChatEnabled').addEventListener('change', e => { cfg.chatMsgEnabled = e.target.checked; persist(); });
  $('srSaveChatSettings').addEventListener('click', () => {
    cfg.chatMsgEnabled  = $('srChatEnabled').checked;
    cfg.chatMsgSuccess  = $('srChatSuccess').value;
    cfg.chatMsgBadUrl   = $('srChatBadUrl').value;
    cfg.chatMsgCooldown = $('srChatCooldown').value;
    cfg.chatMsgPerUser  = $('srChatPerUser').value;
    cfg.chatMsgBlocked  = $('srChatBlocked').value;
    persist();
    const btn = $('srSaveChatSettings'), o = btn.textContent;
    btn.textContent = 'Saved!'; setTimeout(() => btn.textContent = o, 1200);
  });

  $('srManualAdd').addEventListener('click', () => {
    const url = $('srManualUrl').value.trim(); if (!url) return;
    requestSong(url, 'Host', null, true); $('srManualUrl').value = '';
  });
  $('srManualUrl').addEventListener('keydown', e => {
    if (e.key === 'Enter') { const url = $('srManualUrl').value.trim(); if (url) { requestSong(url, 'Host', null, true); $('srManualUrl').value = ''; } }
  });
  $('srClearQueue').addEventListener('click', async () => {
    if (confirm('Clear the entire queue?')) {
      // Refund every redeemed request that never got played
      queue.forEach(q => refundRedemption(q.redemptionId, 'queue cleared'));
      queue = []; lastInsertedId = null; renderQueue(); persist();
      try { await pearDelete('/queue'); } catch (e) {}
    }
  });

  $('srCopyLogs').addEventListener('click', () => {
    try {
      const txt = slogDump();
      const box = $('srLogBox');
      box.style.display = 'block'; box.value = txt;
      const btn = $('srCopyLogs'), o = btn.textContent;
      navigator.clipboard.writeText(txt)
        .then(() => { btn.textContent = 'Copied!'; })
        .catch(() => { box.select(); btn.textContent = 'Select & copy from box'; });
      setTimeout(() => { btn.textContent = o; }, 1800);
    } catch (e) {}
  });
  $('srClearLogs').addEventListener('click', () => {
    try {
      slogClear(); slog('log', 'logs cleared by user');
      const box = $('srLogBox'); if (box) { box.value = ''; box.style.display = 'none'; }
    } catch (e) {}
  });

  renderOverlayBar('srOverlayMode', 'srOverlayUrl', 'srCopyUrl', 'nowplaying', store.overlayUrls);
  renderQueue();
  renderBlocked();
}

function buildRight() {
  const el = $('songrequestRight'); if (!el) return;
  const overlayBar = el.querySelector('.overlay-bar');
  const np = document.createElement('div');
  np.innerHTML = '<div class="preview-header">Now Playing</div>'
    + '<div id="srNowPlaying" style="width:100%;max-width:420px;background:rgba(0,0,0,.3);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:12px">'
    + '<div style="color:var(--muted);text-align:center;padding:20px">Nothing playing</div></div>';
  if (overlayBar) el.insertBefore(np, overlayBar); else el.appendChild(np);
}

export function initSongRequest() {
  // Load saved data BEFORE buildLeft so the form renders with correct values
  const d = store.songrequest || {};
  if (d.cfg)   Object.assign(cfg, d.cfg);
  if (d.queue) queue = d.queue;
  // Restore saved cooldowns; stale entries age out via the existing pruning
  // in requestSong, so nothing extra to clean here.
  if (d.cooldowns && typeof d.cooldowns === 'object') srCooldowns = d.cooldowns;
  slog('boot', 'songrequest init qlen=' + queue.length + ' reward=' + (cfg.rewardId || 'none') + ' anyRedeem=' + cfg.anyRedeem + ' allowCmd=' + cfg.allowSrCommand + ' who=' + cfg.srCmdWho);

  buildLeft();
  buildRight();
  renderQueue();
  if (store.twitch.connected) loadRewards();
  window.addEventListener('spark-twitch-status', e => { if (e.detail?.connected) loadRewards(); });
  tryConnect().catch(() => {});
}
