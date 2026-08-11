/* SPARK native widget runtime.
 *
 * Renders one built-in widget (chat or alert) that the streamer styles with
 * their own CSS. Fed directly by SPARK's live Twitch events (the same bus the
 * Chat tab already fills), or by demo traffic when the URL ends with ?demo=1.
 *
 * No StreamElements emulation — these are SPARK's own widgets, so the event
 * shapes are SPARK's own and nothing external can break them.
 *
 * The page sets window.SPARK_WIDGET_TYPE ('chat' | 'alert'). Styling hooks:
 *   chat  -> #spark-chat .msg .msg-name .msg-text
 *   alert -> #spark-alert.alert.show (+ .alert-follow / .alert-sub) .alert-title .alert-name
 */
(function () {
  'use strict';
  var TYPE = window.SPARK_WIDGET_TYPE || 'chat';
  var demo = /[?&]demo=1/.test(location.search);

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'); // also safe inside attributes
  }

  // Render message text with Twitch emotes spliced in as <img>. SPARK passes the
  // raw Twitch emote tag ("id:start-end,start-end/id:...", codepoint indices).
  // Unicode emoji just render as text (with an emoji-font fallback in the page).
  function renderMessage(text, emotesTag) {
    var chars = Array.from(String(text == null ? '' : text));
    if (!emotesTag) return esc(chars.join(''));
    var ranges = [];
    String(emotesTag).split('/').forEach(function (part) {
      var c = part.indexOf(':');
      if (c < 0) return;
      var id = part.slice(0, c), pos = part.slice(c + 1);
      pos.split(',').forEach(function (r) {
        var d = r.split('-'), s = parseInt(d[0], 10), e = parseInt(d[1], 10);
        if (!isNaN(s) && !isNaN(e)) ranges.push({ s: s, e: e, id: id });
      });
    });
    if (!ranges.length) return esc(chars.join(''));
    ranges.sort(function (a, b) { return a.s - b.s; });
    var out = '', i = 0;
    ranges.forEach(function (rg) {
      if (rg.s < i) return;
      if (rg.s > i) out += esc(chars.slice(i, rg.s).join(''));
      var name = chars.slice(rg.s, rg.e + 1).join('');
      out += '<img class="emote" src="https://static-cdn.jtvnw.net/emoticons/v2/'
           + esc(rg.id) + '/default/dark/2.0" alt="' + esc(name) + '">';
      i = rg.e + 1;
    });
    if (i < chars.length) out += esc(chars.slice(i).join(''));
    return out;
  }

  // ── Renderers ───────────────────────────────────────────────────────────────
  var renderers = {
    chat: function () {
      var box = document.getElementById('spark-chat');
      var MAX = MAXMSG;
      var newTop = (SCROLL === 'down' || SCROLL === 'right'); // insert new at the start

      function roleOf(d) {
        return d.is_broadcaster ? 'broadcaster' : d.is_mod ? 'mod' : d.is_vip ? 'vip'
             : d.is_sub ? 'sub' : d.is_follower ? 'follower' : 'viewer';
      }
      function iconHtml(d) {
        var role = roleOf(d);
        var ic = ICONS[role];
        if (!ic) return '';
        // onerror removes a missing/broken image instead of showing the broken glyph.
        if (ic.t === 'img') return '<img class="badge-icon" onerror="this.remove()" src="/diy/icon?id=' + encodeURIComponent(WID) + '&role=' + role + '">';
        return '<span class="badge-icon">' + esc(ic.v) + '</span>';
      }
      // Name colour/glow: a set role colour wins over the chatter's Twitch colour.
      function nameStyle(d) {
        var rs = ROLESTYLE[roleOf(d)] || {};
        var col = rs.color || (d.tags && d.tags.color) || d.color || '';
        var css = '';
        if (col) css += 'color:' + col + ';';
        if (rs.glow && col) css += 'text-shadow:0 0 8px ' + col + ';';
        return css;
      }
      function fill(t, name, amount) {
        return String(t == null ? '' : t)
          .replace(/\{name\}/g, name == null ? '' : name)
          .replace(/\{amount\}/g, amount == null ? '' : amount);
      }
      function removeRow(row) {
        if (!row.parentNode || row.dataset.leaving) return;
        row.dataset.leaving = '1';
        if (OUTMS > 0) {
          row.classList.add('spk-out');
          setTimeout(function () { if (row.parentNode) row.parentNode.removeChild(row); }, OUTMS + 40);
        } else if (row.parentNode) { row.parentNode.removeChild(row); }
      }
      function insert(row) {
        if (newTop) box.insertBefore(row, box.firstChild); else box.appendChild(row);
        // Measure the row for the grow/collapse keyframes (host template):
        // the margin animation makes neighbours slide smoothly into place
        // instead of jumping when a message appears or leaves.
        row.style.setProperty('--spk-h', row.offsetHeight + 'px');
        row.style.setProperty('--spk-w', row.offsetWidth + 'px');
        enforce();
        if (HIDEMS > 0) setTimeout(function () { removeRow(row); }, HIDEMS);
      }
      // Remove overflow rows from the far end, animating out if an exit is set.
      function enforce() {
        var kids = [].slice.call(box.children).filter(function (k) { return !k.dataset.leaving; });
        while (kids.length > MAX) {
          var old = newTop ? kids.pop() : kids.shift();
          old.dataset.leaving = '1';
          if (OUTMS > 0) {
            old.classList.add('spk-out');
            (function (el) { setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, OUTMS + 40); })(old);
          } else if (old.parentNode) {
            box.removeChild(old);
          }
        }
      }
      function addEvent(kind, name, amount) {
        if (!box) return;
        var tpl = CHATEVENTTEXT[kind] != null ? CHATEVENTTEXT[kind] : (name + ' ' + kind);
        var row = document.createElement('div');
        row.className = 'msg chat-event chat-event-' + kind;
        row.innerHTML = '<div class="msg-inner"><span class="chat-event-text">' + esc(fill(tpl, name, amount)) + '</span></div>';
        insert(row);
      }
      return {
        message: function (d) {
          if (!box) return;
          var row = document.createElement('div');
          row.className = 'msg role-' + roleOf(d);
          var ns = nameStyle(d);
          row.innerHTML = '<div class="msg-inner">' + iconHtml(d)
            + '<span class="msg-name"' + (ns ? ' style="' + esc(ns) + '"' : '') + '>'
            + esc(d.display || d.username) + '</span>'
            + '<span class="msg-text">' + renderMessage(d.message, d.emotes) + '</span></div>';
          insert(row);
        },
        follow: function (name)         { addEvent('follow', name); },
        sub:    function (name)         { addEvent('sub', name); },
        cheer:  function (name, amount) { addEvent('cheer', name, amount); },
        raid:   function (name, amount) { addEvent('raid', name, amount); },
      };
    },
    hypetrain: function () {
      var el = document.getElementById('spark-hypetrain');
      var hideTimer = null, tick = null;

      // Field names are read DEFENSIVELY on purpose. Hype train v2 describes
      // Rust forwards the whole payload untouched, so anything Twitch sends is
      // available here even if SPARK was never taught its name.
      function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }

      function topName(d) {
        var list = d.top_contributions || d.top_contributors;
        if (!list || !list.length) return '';
        var t = list[0] || {};
        return t.user_name || t.user_login || t.user || '';
      }

      function fmtLeft(iso) {
        if (!iso) return '';
        var ms = new Date(iso).getTime() - Date.now();
        if (!isFinite(ms) || ms < 0) ms = 0;
        var s = Math.round(ms / 1000);
        return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
      }

      function render(d, phase) {
        var level = num(d.level, 1);
        var total = num(d.total, 0);
        var goal  = num(d.goal, 0);
        var pct   = goal > 0 ? Math.max(0, Math.min(100, (total / goal) * 100)) : 0;
        var top   = SHOWTOP ? topName(d) : '';

        el.className = 'hypetrain show ' + phase;
        el.innerHTML =
            '<div class="ht-head">'
          +   '<span class="ht-label">' + (phase === 'end' ? 'Hype train over' : 'Hype train') + '</span>'
          +   (phase === 'end' ? '' : '<span class="ht-time">' + esc(fmtLeft(d.expires_at)) + '</span>')
          + '</div>'
          + '<div class="ht-level">Level ' + esc(level) + '</div>'
          + (phase === 'end' ? '' :
              '<div class="ht-bar"><div class="ht-fill" style="width:' + pct.toFixed(1) + '%"></div></div>'
            + '<div class="ht-progress">' + esc(total.toLocaleString()) + ' / ' + esc(goal.toLocaleString()) + '</div>')
          + (top ? '<div class="ht-top">Top: <span class="ht-top-name">' + esc(top) + '</span></div>' : '');

        // Countdown ticks locally rather than waiting for the next event —
        // progress events only arrive when someone contributes, which can be
        // a long quiet minute while the clock is visibly running out.
        clearInterval(tick);
        if (phase !== 'end' && d.expires_at) {
          tick = setInterval(function () {
            var t = el.querySelector('.ht-time');
            if (t) t.textContent = fmtLeft(d.expires_at);
          }, 1000);
        }
      }

      return {
        hypetrain: function (d) {
          var phase = d._phase || 'progress';
          clearTimeout(hideTimer);

          if (phase === 'begin' || phase === 'progress') {
            var was = el.getAttribute('data-level');
            render(d, phase);
            // Level up is the moment worth celebrating. A class rather than a
            // hardcoded animation, so a preset decides what it looks like.
            var lvl = String(num(d.level, 1));
            if (was && was !== lvl) {
              el.classList.add('levelup');
              setTimeout(function () { el.classList.remove('levelup'); }, 2600);
            }
            el.setAttribute('data-level', lvl);
            return;
          }

          // Ended: hold the summary briefly, then clear out.
          render(d, 'end');
          el.removeAttribute('data-level');
          hideTimer = setTimeout(function () {
            el.className = 'hypetrain';
            el.innerHTML = '';
          }, Math.max(3000, DURMS));
        }
      };
    },

    alert: function () {
      var el = document.getElementById('spark-alert');
      var q = [], busy = false;
      function fill(t, name, amount) {
        return String(t == null ? '' : t)
          .replace(/\{name\}/g, name == null ? '' : name)
          .replace(/\{amount\}/g, amount == null ? '' : amount);
      }
      function textFor(kind, name, amount) {
        var t = ALERTTEXT[kind] || {};
        var defTitle = kind === 'cheer' ? (amount || 0) + ' BITS'
                     : kind === 'raid' ? 'RAID x' + (amount || 0)
                     : 'NEW ' + kind.toUpperCase();
        return {
          title: t.title != null ? fill(t.title, name, amount) : defTitle,
          message: t.message != null ? fill(t.message, name, amount) : (name || ''),
        };
      }
      function run() {
        if (busy || !el) return;
        var a = q.shift();
        if (!a) return;
        busy = true;
        var txt = textFor(a.kind, a.name, a.amount);
        el.className = 'alert show alert-' + a.kind;
        el.innerHTML = '<div class="alert-title">' + esc(txt.title) + '</div>'
                     + '<div class="alert-name">' + esc(txt.message) + '</div>';
        setTimeout(function () {
          if (OUTMS > 0) {
            // Keep it visible while the exit animation plays, then clear.
            el.className = 'alert show spk-out alert-' + a.kind;
            setTimeout(function () { el.className = 'alert'; busy = false; run(); }, OUTMS + 40);
          } else {
            el.className = 'alert';
            setTimeout(function () { busy = false; run(); }, 400);
          }
        }, DURMS);
      }
      // Generous cap — a sub bomb / raid burst shouldn't silently drop alerts.
      function push(a) { q.push(a); while (q.length > 20) q.shift(); run(); }
      return {
        follow: function (name)         { push({ kind: 'follow', name: name }); },
        sub:    function (name)         { push({ kind: 'sub',    name: name }); },
        cheer:  function (name, amount) { push({ kind: 'cheer',  name: name, amount: amount }); },
        raid:   function (name, amount) { push({ kind: 'raid',   name: name, amount: amount }); },
      };
    },
  };

  var EVENTS = window.SPARK_WIDGET_EVENTS || null;  // which alert kinds this box shows
  var OUTMS = window.SPARK_WIDGET_OUTMS || 0;       // exit-animation duration (0 = instant)
  var SCROLL = window.SPARK_WIDGET_SCROLL || 'up';  // chat scroll direction
  var ICONS = window.SPARK_WIDGET_ICONS || {};      // per-role name icons
  var ALERTTEXT = window.SPARK_WIDGET_ALERTTEXT || {}; // editable alert templates
  var ROLESTYLE = window.SPARK_WIDGET_ROLESTYLE || {}; // per-role name colour/glow
  var IGNORE = window.SPARK_WIDGET_IGNORE || [];    // bot / ignore list (lowercased)
  var SHOWEVENTS = !!window.SPARK_WIDGET_SHOWEVENTS; // show follows/subs/raids in chat
  var CHATEVENTTEXT = window.SPARK_WIDGET_CHATEVENTTEXT || {}; // in-chat event templates
  var MAXMSG = window.SPARK_WIDGET_MAXMSG || 20;    // chat: max messages kept in the DOM
  var HIDEMS = window.SPARK_WIDGET_HIDEMS || 0;     // chat: remove a message after this long (0 = never)
  var DURMS = window.SPARK_WIDGET_DURMS || 5000;    // alert: on-screen time
  var SHOWTOP = !!window.SPARK_WIDGET_SHOWTOP;      // hype train: name the top contributor
  var WID = window.SPARK_WIDGET_ID || '';
  var api = renderers[TYPE] ? renderers[TYPE]() : null;
  var sfx = null;

  // Live restyle from the designer: the editor posts the current CSS so the
  // preview updates instantly, no reload (keeps the on-screen messages/alerts).
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || typeof d !== 'object') return;
    if (typeof d.sparkCss === 'string') {
      var st = document.getElementById('spark-live-style');
      if (!st) { st = document.createElement('style'); st.id = 'spark-live-style'; document.head.appendChild(st); }
      st.textContent = d.sparkCss;
    }
    if (typeof d.sparkOutMs === 'number') OUTMS = d.sparkOutMs;
    if (d.sparkAlertText) ALERTTEXT = d.sparkAlertText;
    if (d.sparkChatEventText) CHATEVENTTEXT = d.sparkChatEventText;
    if (d.sparkRoleStyle) ROLESTYLE = d.sparkRoleStyle;
    if (typeof d.sparkShowTop === 'boolean') SHOWTOP = d.sparkShowTop;
  });

  function playSfx() {
    if (!sfx) sfx = document.getElementById('spark-sfx');
    if (!sfx) return;
    try {
      sfx.currentTime = 0;
      var p = sfx.play();                       // returns a promise; autoplay
      if (p && p.catch) p.catch(function () {}); // block would reject it
    } catch (e) {}
  }

  function isIgnored(name) {
    return IGNORE.length ? IGNORE.indexOf(String(name || '').toLowerCase()) !== -1 : false;
  }

  // Route one SPARK event to the active widget. fromDemo events stay silent so
  // the preview doesn't spam the sound while you're styling.
  function handle(ev, fromDemo) {
    if (!api) return;
    if (ev.type === 'message' && api.message) {
      if (isIgnored(ev.username || ev.display)) return;   // skip bots / ignore list
      api.message(ev);
      return;
    }
    if (ev.type === 'hypetrain' && api.hypetrain) {
      api.hypetrain(ev);
      // The sound belongs to a level up, not to every point scored.
      if (!fromDemo && ev._phase === 'begin') playSfx();
      return;
    }
    if (ev.type === 'alert' && api[ev.kind]) {
      if (TYPE === 'chat') { if (!SHOWEVENTS) return; }    // chat only shows events if enabled
      else if (EVENTS && EVENTS[ev.kind] === false) return;
      api[ev.kind](ev.name, ev.amount);
      if (!fromDemo && TYPE === 'alert') playSfx();        // sound is the alert widget's job
    }
  }

  // ── Live feed (SPARK's chat/event bus) ──────────────────────────────────────
  var since = 0;
  var primed = false;
  async function poll() {
    try {
      var res = await fetch('/events?since=' + since + '&tool=chat', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      if (!primed) {
        // Start from "now" so we never replay old chat or an old refresh signal
        // (which would cause a reload loop). Live events after connect flow in.
        if (typeof data.latest === 'number') since = data.latest;
        primed = true;
        setTimeout(poll, 0);
        return;
      }
      (data.events || []).forEach(function (ev) {
        if (ev._id) { if (ev._id <= since) return; since = ev._id; }
        // Design changed in the app: reload so OBS shows it without a manual refresh.
        if (ev.type === 'diy-refresh') { if (ev.widget === WID) location.reload(); return; }
        try { handle(ev); } catch (e) {}
      });
      if ((!data.events || !data.events.length) && typeof data.latest === 'number') {
        since = Math.max(since, data.latest);
      }
      setTimeout(poll, 0);
    } catch (e) {
      setTimeout(poll, 800);
    }
  }

  // ── Demo traffic (preview only) ─────────────────────────────────────────────
  var names = ['PixelPenguin', 'NovaStreams', 'RetroRacc', 'ModSquadKai', 'BitBard', 'LoffiBeats'];
  var colors = ['#4fc3f7', '#ba68c8', '#ffb74d', '#81c784', '#e57373', '#f06292'];
  var msgs = ['this looks so clean', 'first time here, loving it', 'GG that was wild',
              'what game is this?', 'the styling is sick', 'hi chat o/'];
  function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

  var demoRoles = [{}, { is_sub: true }, { is_vip: true }, { is_mod: true }, { is_follower: true }, {}];
  function demoChat() {
    var who = pick(names), msg = pick(msgs), emotes = '';
    if (Math.random() < 0.45) {            // sometimes tack a Kappa on, to show emotes
      var prefix = msg + ' ';
      var start = Array.from(prefix).length;
      msg = prefix + 'Kappa';
      emotes = '25:' + start + '-' + (start + 4);
    }
    var ev = { type: 'message', username: who, display: who, message: msg, color: pick(colors), emotes: emotes };
    var role = pick(demoRoles);
    for (var k in role) ev[k] = role[k];
    handle(ev, true);
  }
  function demoFollow() { handle({ type: 'alert', kind: 'follow', name: pick(names) }, true); }
  function demoSub()    { handle({ type: 'alert', kind: 'sub',    name: pick(names) }, true); }
  function demoCheer()  { handle({ type: 'alert', kind: 'cheer', name: pick(names), amount: (1 + Math.floor(Math.random() * 20)) * 100 }, true); }
  function demoRaid()   { handle({ type: 'alert', kind: 'raid',  name: pick(names), amount: 5 + Math.floor(Math.random() * 60) }, true); }

  function boot() {
    if (demo) {
      if (TYPE === 'chat') {
        for (var i = 0; i < 6; i++) setTimeout(demoChat, i * 250); // burst-fill so it's not empty
        setInterval(demoChat, 2200);
        if (SHOWEVENTS) {
          setTimeout(function () { handle({ type: 'alert', kind: 'follow', name: pick(names) }, true); }, 1800);
          setInterval(function () {
            var k = pick(['follow', 'sub', 'raid']);
            handle({ type: 'alert', kind: k, name: pick(names), amount: k === 'raid' ? 5 + Math.floor(Math.random() * 40) : 0 }, true);
          }, 5000);
        }
      } else if (TYPE === 'hypetrain') {
        // A fake train, because real ones happen a couple of times a MONTH.
        // Without this you would tweak a colour and then wait weeks to see it.
        // Runs the whole arc — start, climb, level up, finish — then loops,
        // so the styling can actually be looked at.
        var lvl = 1, tot = 0, goalFor = function (l) { return 1600 + (l - 1) * 1400; };
        var htTick = null;

        function htSend(phase) {
          handle({
            type: 'hypetrain', _phase: phase,
            level: lvl, total: tot, goal: goalFor(lvl),
            expires_at: new Date(Date.now() + 90000).toISOString(),
            top_contributions: [{ user_name: pick(names), type: 'subscription', total: 1500 }]
          }, true);
        }

        function htStart() {
          lvl = 1; tot = 0;
          htSend('begin');
          clearInterval(htTick);
          htTick = setInterval(function () {
            tot += 260 + Math.floor(Math.random() * 380);
            if (tot >= goalFor(lvl)) {
              if (lvl >= 5) {                 // finish, pause, run it again
                clearInterval(htTick);
                htSend('end');
                setTimeout(htStart, 5200);
                return;
              }
              lvl++; tot = 0;                 // level up
            }
            htSend('progress');
            // 2.5s, not 1.1s. The old rate rebuilt the widget faster than it
            // could settle, which read as constant flicker in a small preview.
          }, 2500);
        }
        setTimeout(htStart, 400);

      } else {
        // Cycle one alert at a time, spaced by the on-screen duration, so the
        // preview never piles up. Disabled kinds are skipped by handle().
        var kinds = ['follow', 'sub', 'cheer', 'raid'], di = 0;
        function demoAlertCycle() {
          var k = kinds[di++ % kinds.length];
          var amt = k === 'cheer' ? (1 + Math.floor(Math.random() * 20)) * 100 : (k === 'raid' ? 5 + Math.floor(Math.random() * 40) : 0);
          handle({ type: 'alert', kind: k, name: pick(names), amount: amt }, true);
        }
        setTimeout(demoAlertCycle, 500);
        setInterval(demoAlertCycle, Math.max(DURMS + 1400, 3500));
      }
    }
    poll(); // live events flow even during a preview
  }

  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot);
})();
