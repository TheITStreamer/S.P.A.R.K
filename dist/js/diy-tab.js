import { store } from './store.js';
import { $, esc, flash } from './utils.js';
import { fontOptionsHtml } from './fonts.js';

const { invoke } = window.__TAURI__.core;

// store.diy = { widgets: [ { id, name, type:'chat'|'alert', css, font } ] }
function widgets() {
  if (!store.diy || typeof store.diy !== 'object') store.diy = { widgets: [] };
  if (!Array.isArray(store.diy.widgets)) store.diy.widgets = [];
  return store.diy.widgets;
}
function persist() { return invoke('save_diy', { data: store.diy }); }

function overlayBase() {
  const any = (store.overlayUrls && (store.overlayUrls.chat || store.overlayUrls.counters)) || '';
  // Fall back to the fixed overlay port so copied URLs / the preview still
  // work before the overlay URLs have loaded.
  return any ? any.replace(/\/[a-z-]+$/i, '') : 'http://localhost:4747';
}
function widgetUrl(id) { return overlayBase() + '/diy?id=' + encodeURIComponent(id); }
const rid = () => 'wgt_' + Math.random().toString(36).slice(2, 9);
const fileName = (p) => String(p).split(/[\\/]/).pop();

// Font list now shared app-wide — see fonts.js.

// ── Built-in widget types + their starting CSS (users edit this) ────────────────
const TYPES = {
  chat: {
    name: 'Chat',
    font: 'Nunito',
    css:
`/* Chat widget. Edit anything below and watch the preview */
#spark-chat {
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 8px;
  padding: 16px;
  height: 100vh;
  box-sizing: border-box;
}
.msg { animation: msgin .3s ease both; }
.msg-name { font-weight: 800; font-size: 18px; margin-right: 6px; color: #ffc83d; }
.msg-text {
  color: #ffffff;
  font-size: 16px;
  background: rgba(20,18,40,.82);
  padding: 5px 10px;
  border-radius: 10px;
}
.emote { height: 1.4em; vertical-align: middle; }  /* Twitch emotes */
@keyframes msgin { from { opacity: 0; transform: translateY(12px); } }
`,
  },
  hypetrain: {
    name: 'Hype Train',
    font: 'Nunito',
    css:
`/* Hype train. Everything below is yours to change.
   SPARK adds classes you can style against:
     .hypetrain.show     visible
     .hypetrain.levelup  briefly, when a new level is reached
     .hypetrain.end      the summary after it finishes
                                                                            */
#spark-hypetrain {
  display: none;
  width: 300px;
  padding: 12px 14px;
  box-sizing: border-box;
  background: rgba(20,12,40,.92);
  border: 1px solid #ffc83d;
  border-radius: 12px;
  color: #f5f1ff;
  animation: htin .35s ease both;
}
#spark-hypetrain.show { display: block; }

.ht-head { display: flex; align-items: center; gap: 8px; margin-bottom: 2px; }
.ht-label { font-size: 11px; letter-spacing: .16em; text-transform: uppercase; color: #ffc83d; font-weight: 700; }
.ht-time { margin-left: auto; font-size: 12px; color: #a79fc7; }
.ht-level { font-size: 19px; font-weight: 700; }
.ht-bar { height: 9px; border-radius: 5px; background: rgba(255,255,255,.12); overflow: hidden; margin: 7px 0 5px; }
.ht-fill { height: 100%; background: #ffc83d; border-radius: 5px; transition: width .4s ease; }
.ht-progress { font-size: 12px; color: #a79fc7; }
.ht-top { font-size: 12px; color: #a79fc7; margin-top: 6px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,.1); }
.ht-top-name { color: #f5f1ff; font-weight: 700; }

#spark-hypetrain.levelup { animation: htpop .5s ease; }
#spark-hypetrain.end { opacity: .85; }

@keyframes htin  { from { opacity: 0; transform: translateY(10px); } }
@keyframes htpop { 50% { transform: scale(1.06); } }
`,
  },
  alert: {
    name: 'Alert',
    font: 'Poppins',
    css:
`/* Alert widget. Shows on new follows, subs, bits, raids. Edit freely. */
body { display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
.alert {
  text-align: center;
  opacity: 0;
  transform: scale(.7);
  transition: all .4s cubic-bezier(.2,.9,.3,1.3);
}
.alert.show { opacity: 1; transform: scale(1); }
.alert-title { font-weight: 900; font-size: 40px; color: #4fc3f7; }
.alert-sub .alert-title { color: #ba68c8; }    /* subs   */
.alert-cheer .alert-title { color: #ffc83d; }  /* cheers */
.alert-raid .alert-title { color: #81c784; }   /* raids  */
.alert-name {
  font-weight: 800;
  font-size: 28px;
  color: #ffffff;
  margin-top: 6px;
}
`,
  },
};

// ── Designer defaults + CSS generation ─────────────────────────────────────────
const DEFAULT_STYLE = {
  chat:  { bg: '#141228', bgOpacity: 82, text: '#ffffff', accent: '#ffc83d',
    radius: 10, pad: 8, fontSize: 16, glow: false, glowSize: 12, glowColor: '#ffc83d',
    shadow: true, gradient: false, scroll: 'up', gap: 8, maxMsg: 20, hideAfter: 0, tilt: 0, tiltAlt: true,
    oneLine: false, maxWidth: 340,
    animIn: 'slide', animInDir: 'up', animOut: 'fade', animOutDir: 'up', speed: 'normal' },
  alert: { bg: '#1b1030', bgOpacity: 92, text: '#ffffff', accent: '#4fc3f7',
    radius: 16, pad: 18, fontSize: 34, glow: true, glowSize: 22, glowColor: '#4fc3f7',
    shadow: true, duration: 5, animIn: 'stomp', animInDir: 'up', animOut: 'zoom', animOutDir: 'up', speed: 'normal' },
};
const DEFAULT_ICONS = { broadcaster: '', mod: '', vip: '', sub: '', follower: '', viewer: '' };
const DEFAULT_ROLESTYLE = {
  broadcaster: { on: false, color: '#ff5d73', glow: false },
  mod: { on: false, color: '#5cd67a', glow: false },
  vip: { on: false, color: '#f38ff3', glow: false },
  sub: { on: false, color: '#ffc83d', glow: false },
  follower: { on: false, color: '#5ce1ff', glow: false },
  viewer: { on: false, color: '#ffffff', glow: false },
};
const DEFAULT_ALERTTEXT = {
  follow: { title: 'NEW FOLLOWER',   message: '{name}' },
  sub:    { title: 'NEW SUBSCRIBER', message: '{name}' },
  cheer:  { title: '{amount} BITS',  message: '{name}' },
  raid:   { title: 'RAID x{amount}', message: '{name}' },
};
const DEFAULT_CHATEVENTTEXT = {
  follow: '⭐ {name} just followed!',
  sub: '💜 {name} subscribed!',
  cheer: '✨ {name} cheered {amount}!',
  raid: '🚀 {name} raided with {amount}!',
};
const DEFAULT_EVENTSTYLE = { bg: '#2a1750', bgOpacity: 100, text: '#ffc83d', glow: true, glowColor: '#ffc83d', radius: 8 };
const evLabel = (k) => (k === 'cheer' ? 'Bits' : k.charAt(0).toUpperCase() + k.slice(1));
const IN_OPTS = [['none', 'None'], ['fade', 'Fade'], ['slide', 'Slide (soft)'], ['hslide', 'Slide (hard)'],
  ['pop', 'Pop'], ['stomp', 'Stomp'], ['bounce', 'Bounce'], ['drop', 'Drop'], ['flip', 'Flip'], ['zoom', 'Zoom']];
const OUT_OPTS = [['none', 'None'], ['fade', 'Fade'], ['slide', 'Slide (soft)'], ['hslide', 'Slide (hard)'],
  ['shrink', 'Shrink'], ['fall', 'Fall'], ['zoom', 'Zoom']];
const DIR_OPTS = [['up', 'Up'], ['down', 'Down'], ['left', 'Left'], ['right', 'Right']];
const SPEED_OPTS = [['slow', 'Slow'], ['normal', 'Normal'], ['fast', 'Fast']];
const SCROLL_OPTS = [['up', 'Scroll up (new at bottom)'], ['down', 'Scroll down (new at top)'],
  ['left', 'Scroll left (new at right)'], ['right', 'Scroll right (new at left)']];
const ICON_ROLES = [['broadcaster', 'Broadcaster'], ['mod', 'Moderators'], ['vip', 'VIPs'], ['sub', 'Subscribers'], ['follower', 'Followers'], ['viewer', 'Viewers']];

// Keep in sync with the speed map in build_diy_page() (src-tauri/src/overlay.rs).
function speedDur(s) { return s === 'slow' ? 0.8 : s === 'fast' ? 0.3 : 0.5; }
// Easing per entrance type: springy overshoot for scale-based, smooth
// decelerate for slides/fade; stomp/bounce/drop carry their own shape.
function inEase(name) {
  if (name === 'pop' || name === 'zoom' || name === 'flip') return 'cubic-bezier(.22,.9,.32,1.2)';
  if (name === 'stomp' || name === 'bounce' || name === 'drop') return 'ease';
  return 'cubic-bezier(.22,.7,.3,1)';
}
const OUT_EASE = 'cubic-bezier(.4,0,.7,.2)'; // accelerate away
function hexRgba(hex, op) {
  hex = String(hex || '#000000').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const r = parseInt(hex.substr(0, 2), 16) || 0, g = parseInt(hex.substr(2, 2), 16) || 0, b = parseInt(hex.substr(4, 2), 16) || 0;
  return 'rgba(' + r + ',' + g + ',' + b + ',' + ((op == null ? 100 : op) / 100) + ')';
}
function inKf(name, dir) {
  if (!name || name === 'none') return '';
  if (name === 'slide') return 'spk-in-slide-' + (dir || 'up');
  if (name === 'hslide') return 'spk-in-hslide-' + (dir || 'up');
  return 'spk-in-' + name;
}
function outKf(name, dir) {
  if (!name || name === 'none') return '';
  if (name === 'slide') return 'spk-out-slide-' + (dir || 'up');
  if (name === 'hslide') return 'spk-out-hslide-' + (dir || 'up');
  return 'spk-out-' + name;
}

// Turn the style settings into the CSS that drives the widget (designer mode).
function generateStyleCss(type, s, eventStyle) {
  s = Object.assign({}, DEFAULT_STYLE[type] || DEFAULT_STYLE.chat, s || {});
  const shadow = [];
  if (s.glow) shadow.push('0 0 ' + s.glowSize + 'px ' + s.glowColor);
  if (s.shadow) shadow.push('0 6px 16px rgba(0,0,0,.45)');
  const shadowCss = shadow.length ? 'box-shadow:' + shadow.join(',') + ';' : '';
  const dur = speedDur(s.speed);
  const inName = inKf(s.animIn, s.animInDir);
  const outName = outKf(s.animOut, s.animOutDir);
  let out = '';
  if (type === 'alert') {
    out += 'body{display:flex;align-items:center;justify-content:center;height:100vh}\n';
    out += '#spark-alert{text-align:center;display:inline-block;background:' + hexRgba(s.bg, s.bgOpacity)
        + ';border-radius:' + s.radius + 'px;padding:' + s.pad + 'px ' + Math.round(s.pad * 1.6) + 'px;' + shadowCss + '}\n';
    out += '.alert{opacity:0}\n';
    out += '.alert.show{opacity:1;' + (inName ? 'animation:' + inName + ' ' + dur + 's ' + inEase(s.animIn) + ' both;' : '') + '}\n';
    if (outName) out += '.alert.spk-out{animation:' + outName + ' ' + dur + 's ' + OUT_EASE + ' forwards;}\n';
    out += '.alert-title{color:' + s.accent + ';font-size:' + s.fontSize + 'px;font-weight:900}\n';
    out += '.alert-name{color:' + s.text + ';font-size:' + Math.round(s.fontSize * 0.62) + 'px;font-weight:800;margin-top:4px}\n';
  } else {
    const scroll = s.scroll || 'up';
    let flow;
    if (scroll === 'down') flow = 'flex-direction:column;justify-content:flex-start;';
    else if (scroll === 'left') flow = 'flex-direction:row;justify-content:flex-end;align-items:flex-end;flex-wrap:nowrap;';
    else if (scroll === 'right') flow = 'flex-direction:row;justify-content:flex-start;align-items:flex-end;flex-wrap:nowrap;';
    else flow = 'flex-direction:column;justify-content:flex-end;';
    const gap = s.gap == null ? 8 : s.gap;
    out += '#spark-chat{display:flex;' + flow + 'gap:' + gap + 'px;padding:14px;height:100vh;box-sizing:border-box;overflow:hidden}\n';
    // Messages keep their natural width (no squishing in side-scrolling chat).
    // --spk-gap feeds the grow/collapse keyframes (host template) so the stack
    // slides smoothly as rows enter/leave instead of jumping.
    out += '.msg{flex-shrink:0;--spk-gap:' + gap + 'px}\n';
    out += '.msg-name{color:' + s.accent + ';font-size:' + (s.fontSize + 2) + 'px;font-weight:800;margin-right:6px}\n';
    const bgVal = s.gradient
      ? 'linear-gradient(90deg,transparent 0%,' + hexRgba(s.bg, s.bgOpacity) + ' 14%,' + hexRgba(s.bg, s.bgOpacity) + ' 86%,transparent 100%)'
      : hexRgba(s.bg, s.bgOpacity);
    // Single-line mode truncates with an ellipsis instead of wrapping.
    const maxW = s.maxWidth == null ? 340 : s.maxWidth;
    const wrapCss = s.oneLine
      ? 'max-width:' + maxW + 'px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;vertical-align:bottom;'
      : 'max-width:' + maxW + 'px;word-break:break-word;';
    out += '.msg-text{display:inline-block;color:' + s.text + ';font-size:' + s.fontSize + 'px;background:' + bgVal
        + ';border-radius:' + s.radius + 'px;padding:' + s.pad + 'px ' + Math.round(s.pad * 1.4) + 'px;' + wrapCss + shadowCss + '}\n';
    if (s.oneLine) out += '.msg-inner{white-space:nowrap}\n';
    // Smooth stack: the row itself animates its occupied space (grow/collapse,
    // using --spk-h/--spk-w set by the runtime); the visual entrance/exit
    // plays on .msg-inner so the two never fight over `animation`.
    const horiz = scroll === 'left' || scroll === 'right';
    out += '.msg{animation:' + (horiz ? 'spk-grow-x' : 'spk-grow') + ' ' + dur + 's cubic-bezier(.22,.7,.3,1) both}\n';
    if (inName) out += '.msg-inner{animation:' + inName + ' ' + dur + 's ' + inEase(s.animIn) + ' both;}\n';
    if (outName) {
      out += '.msg.spk-out{animation:' + (horiz ? 'spk-collapse-x' : 'spk-collapse') + ' ' + dur + 's ' + OUT_EASE + ' forwards}\n';
      out += '.msg.spk-out .msg-inner{animation:' + outName + ' ' + dur + 's ' + OUT_EASE + ' forwards;}\n';
    }
    // Askew / tilt
    const tilt = s.tilt || 0;
    if (tilt > 0) {
      if (s.tiltAlt !== false) {
        out += '.msg:nth-child(odd) .msg-inner{transform:rotate(' + tilt + 'deg)}\n';
        out += '.msg:nth-child(even) .msg-inner{transform:rotate(-' + tilt + 'deg)}\n';
      } else {
        out += '.msg-inner{transform:rotate(' + tilt + 'deg)}\n';
      }
    }
    // In-chat event highlight
    const es = eventStyle || DEFAULT_EVENTSTYLE;
    const eShadow = es.glow ? 'box-shadow:0 0 12px ' + es.glowColor + ';' : '';
    out += '.chat-event .msg-inner{background:' + hexRgba(es.bg, es.bgOpacity) + ';color:' + es.text
        + ';border-radius:' + es.radius + 'px;padding:5px 12px;font-weight:800;' + eShadow + '}\n';
    out += '.chat-event .chat-event-text{color:' + es.text + '}\n';
  }
  return out;
}

// ── State ──────────────────────────────────────────────────────────────────────
let editingId = null;
let previewTimer = null;
let nameTimer = null;


// ── Starting looks ────────────────────────────────────────────────────────────
// Each widget type ships a few ready-made styles. The CSS editor underneath is
// still the real control — a preset just replaces what is in it, which is why
// the preset handler asks first when the CSS has been edited.
//
// Keyed by type so a preset can never be applied to the wrong widget.
const CSS_PRESETS = {
  chat: [
    { name: 'Default', css: null },   // null = that type's base CSS in TYPES
    { name: 'Minimal', css:
`/* Chat — no bubbles, just names and text. */
#spark-chat { display:flex; flex-direction:column; justify-content:flex-end; gap:4px; padding:16px; height:100vh; box-sizing:border-box; }
.msg { animation: msgin .25s ease both; }
.msg-name { font-weight:800; font-size:17px; margin-right:6px; color:#ffc83d; }
.msg-text { color:#fff; font-size:16px; text-shadow:0 2px 6px rgba(0,0,0,.9); }
.emote { height:1.4em; vertical-align:middle; }
@keyframes msgin { from { opacity:0; } }
` },
    { name: 'Card', css:
`/* Chat — each message on its own solid card. */
#spark-chat { display:flex; flex-direction:column; justify-content:flex-end; gap:8px; padding:16px; height:100vh; box-sizing:border-box; }
.msg { background:#1b1530; border-left:3px solid #ffc83d; border-radius:8px; padding:8px 12px; animation: msgin .3s ease both; }
.msg-name { display:block; font-weight:800; font-size:13px; color:#ffc83d; letter-spacing:.06em; text-transform:uppercase; }
.msg-text { color:#f5f1ff; font-size:16px; }
.emote { height:1.4em; vertical-align:middle; }
@keyframes msgin { from { opacity:0; transform:translateX(-14px); } }
` },
  ],
  alert: [
    { name: 'Default', css: null },
    { name: 'Bar', css:
`/* Alert — a full-width band rather than a box. */
#spark-alert { display:none; width:100vw; padding:18px 0; text-align:center; background:linear-gradient(90deg,rgba(255,200,61,0),rgba(255,200,61,.25),rgba(255,200,61,0)); animation: albar .4s ease both; }
#spark-alert.show { display:block; }
.alert-title { font-size:15px; letter-spacing:.28em; text-transform:uppercase; color:#ffc83d; font-weight:800; }
.alert-name { font-size:34px; font-weight:800; color:#fff; text-shadow:0 3px 12px rgba(0,0,0,.8); }
@keyframes albar { from { opacity:0; transform:scaleX(.9); } }
` },
  ],
  hypetrain: [
    { name: 'Default', css: null },
    { name: 'Bar only', css:
`/* Hype train — just a bar and a level, nothing else. */
#spark-hypetrain { display:none; width:340px; }
#spark-hypetrain.show { display:block; }
.ht-head { display:flex; align-items:center; gap:8px; }
.ht-label { display:none; }
.ht-time { margin-left:auto; font-size:13px; color:#fff; text-shadow:0 2px 6px #000; }
.ht-level { font-size:15px; font-weight:800; color:#ffc83d; text-shadow:0 2px 6px #000; letter-spacing:.1em; text-transform:uppercase; }
.ht-bar { height:14px; border-radius:7px; background:rgba(0,0,0,.55); overflow:hidden; margin:6px 0 0; }
.ht-fill { height:100%; background:#ffc83d; border-radius:7px; transition:width .4s ease; }
.ht-progress, .ht-top { display:none; }
` },
    { name: 'Big and loud', css:
`/* Hype train — large, centred, made to be noticed. */
#spark-hypetrain { display:none; width:460px; padding:20px 24px; text-align:center; background:rgba(10,6,22,.9); border:2px solid #ffc83d; border-radius:18px; color:#fff; }
#spark-hypetrain.show { display:block; animation: htin .4s ease both; }
.ht-label { font-size:13px; letter-spacing:.3em; text-transform:uppercase; color:#ffc83d; font-weight:800; }
.ht-time { display:block; font-size:13px; color:#a79fc7; margin-top:2px; }
.ht-head { display:block; }
.ht-level { font-size:40px; font-weight:900; color:#ffc83d; line-height:1.1; margin:6px 0; }
.ht-bar { height:16px; border-radius:8px; background:rgba(255,255,255,.12); overflow:hidden; }
.ht-fill { height:100%; background:linear-gradient(90deg,#ffc83d,#ff9f43); transition:width .4s ease; }
.ht-progress { font-size:14px; color:#a79fc7; margin-top:6px; }
.ht-top { font-size:14px; margin-top:8px; }
.ht-top-name { color:#ffc83d; font-weight:800; }
#spark-hypetrain.levelup { animation: htpop .55s ease; }
@keyframes htin  { from { opacity:0; transform:translateY(16px) scale(.96); } }
@keyframes htpop { 50% { transform:scale(1.08); } }
` },
  ],
};

// The CSS a preset called "Default" means, per type.
function baseCss(type){ return (TYPES[type] || TYPES.chat).css; }

function presetCssFor(type, name){
  const list = CSS_PRESETS[type] || [];
  const p = list.find(x => x.name === name);
  if (!p) return null;
  return p.css == null ? baseCss(type) : p.css;
}

// True when the widget's CSS is not any of its presets — i.e. hand-edited, and
// worth asking about before a preset overwrites it.
function cssIsCustom(w){
  const list = CSS_PRESETS[w.type] || [];
  const cur = String(w.css || '').trim();
  return !list.some(p => String(p.css == null ? baseCss(w.type) : p.css).trim() === cur);
}

function addWidget(type) {
  const t = TYPES[type] || TYPES.chat;
  const existing = widgets().filter((w) => w.type === type).length;
  const style = JSON.parse(JSON.stringify(DEFAULT_STYLE[type] || DEFAULT_STYLE.chat));
  const eventStyle = JSON.parse(JSON.stringify(DEFAULT_EVENTSTYLE));
  const w = { id: rid(), type, name: t.name + (existing ? ' ' + (existing + 1) : ''),
    css: t.css, font: t.font,
    events: { follow: true, sub: true, cheer: true, raid: true }, sound: '',
    icons: JSON.parse(JSON.stringify(DEFAULT_ICONS)),
    roleStyle: JSON.parse(JSON.stringify(DEFAULT_ROLESTYLE)),
    alertText: JSON.parse(JSON.stringify(DEFAULT_ALERTTEXT)),
    chatEventText: JSON.parse(JSON.stringify(DEFAULT_CHATEVENTTEXT)),
    eventStyle, showEvents: false,
    showTop: false,
    // The visual designer builds CSS from chat/alert-shaped options, so the
    // hype train widget starts straight in the CSS editor. Presets give it the
    // ready-made looks instead.
    mode: type === 'hypetrain' ? 'css' : 'designer',
    style, styleCss: generateStyleCss(type, style, eventStyle) };
  widgets().push(w);
  persist();
  editingId = w.id;
  render();
}

// ── Preview ────────────────────────────────────────────────────────────────────
let lastPreviewId = null;
function reloadPreview(id) {
  if (id) lastPreviewId = id;
  const frame = $('diyPreviewFrame');
  const urlBox = $('diyOverlayUrl');
  if (!id) { if (frame) frame.src = 'about:blank'; if (urlBox) urlBox.value = ''; return; }
  if (urlBox) urlBox.value = widgetUrl(id);
  if (frame) frame.src = widgetUrl(id) + '&demo=1&_=' + Date.now();
}
let refreshTimer = null;
// Tell live OBS overlays to reload themselves, throttled so rapid edits don't spam.
function pushObsRefresh(id) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { invoke('diy_overlay_refresh', { id }).catch(() => {}); }, 700);
}
async function saveAndPreview(id) { await persist(); reloadPreview(id); pushObsRefresh(id); }
// Persist + tell OBS, but leave the preview iframe alone (livePreview already
// pushed the change into it — no reload, so on-screen messages don't reset).
async function saveLive(id) { await persist(); pushObsRefresh(id); }

// Push style/text into the running preview instantly (no reload) so changes
// reflect immediately and the on-screen messages/alerts don't reset.
function livePreview(w) {
  const frame = $('diyPreviewFrame');
  if (!frame || !frame.contentWindow) return;
  const css = w.mode === 'designer' ? generateStyleCss(w.type, w.style, w.eventStyle) : (w.css || '');
  const outMs = w.mode === 'designer'
    ? ((w.style && w.style.animOut && w.style.animOut !== 'none') ? Math.round(speedDur(w.style.speed) * 1000) : 0)
    : (w.cssOutMs || 0);
  try {
    frame.contentWindow.postMessage({
      sparkCss: css, sparkOutMs: outMs,
      sparkAlertText: w.alertText, sparkChatEventText: w.chatEventText, sparkRoleStyle: w.roleStyle,
      sparkShowTop: !!w.showTop,
    }, '*');
  } catch (e) {}
}

// Fire a real test event onto SPARK's overlay bus so it shows up in the preview
// AND on any live OBS browser source — the only way to try alerts on demand.
// Runs a short but complete hype train on the bus: starts, climbs, levels up,
// finishes. Goes to the live OBS source as well as the preview, which is the
// only way to check placement without waiting for a real one.
let htTestTimer = null;
function fireHypeTrainTest() {
  clearInterval(htTestTimer);
  let level = 1, total = 0;
  const goalFor = (l) => 1600 + (l - 1) * 1400;

  const send = (phase) => {
    invoke('chat_overlay_alert', { event: {
      type: 'hypetrain', _phase: phase,
      level, total, goal: goalFor(level),
      expires_at: new Date(Date.now() + 60000).toISOString(),
      top_contributions: [{ user_name: 'TestViewer', type: 'subscription', total: 1500 }],
    } }).catch(() => {});
  };

  send('begin');
  htTestTimer = setInterval(() => {
    total += 700;
    if (total >= goalFor(level)) {
      if (level >= 3) { clearInterval(htTestTimer); send('end'); return; }
      level++; total = 0;
    }
    send('progress');
  }, 900);
}

function fireTest(w, kind) {
  if (w.type === 'hypetrain') {
    fireHypeTrainTest();
    return;
  }
  if (w.type === 'alert') {
    const ev = { type: 'alert', kind: kind };
    if (kind === 'sub') ev.name = 'TestSubscriber';
    else if (kind === 'cheer') { ev.name = 'TestCheerer'; ev.amount = 500; }
    else if (kind === 'raid') { ev.name = 'TestRaider'; ev.amount = 27; }
    else ev.name = 'TestFollower';
    invoke('chat_overlay_alert', { event: ev }).catch(() => {});
  } else {
    invoke('chat_overlay_message', { event: {
      type: 'message', username: 'TestViewer', display: 'TestViewer',
      message: 'This is a test message', color: '#ffc83d',
    } }).catch(() => {});
  }
}

// ── Render: list or editor ─────────────────────────────────────────────────────
function render() {
  const root = $('diyLeft');
  if (!root) return;
  if (editingId && widgets().some((w) => w.id === editingId)) renderEditor(root);
  else { editingId = null; renderList(root); }
}

function renderList(root) {
  const list = widgets();
  let html = ''
    + '<div class="card">'
    + '<h3 style="margin:0 0 8px">D.I.Y Widgets</h3>'
    + '<p style="color:var(--muted);font-size:.85rem;margin:0 0 10px">Add a widget, then style it your own way with CSS and a Google Font. Driven by your live Twitch chat and events. Copy its URL into OBS as a Browser Source.</p>'
    + '<div style="display:flex;gap:6px">'
    + '<button class="btn-sm" data-add="chat">+ Chat widget</button>'
    + '<button class="btn-sm" data-add="alert">+ Alert widget</button>'
    + '<button class="btn-sm" data-add="hypetrain">+ Hype train widget</button>'
    + '</div></div>';

  if (!list.length) {
    html += '<div class="card" style="color:var(--muted)">No widgets yet. Add a Chat or Alert widget above.</div>';
  } else {
    list.forEach((w) => {
      html += ''
        + '<div class="card">'
        + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">'
        + '<strong style="flex:1">' + esc(w.name) + '</strong>'
        + '<span class="tag">' + esc((TYPES[w.type] || {}).name || w.type) + '</span>'
        + '</div>'
        + '<div style="display:flex;gap:6px;align-items:center;margin-bottom:8px">'
        + '<input type="text" readonly value="' + esc(widgetUrl(w.id)) + '" style="flex:1;font-size:.76rem">'
        + '<button class="btn-sm" data-copy="' + esc(w.id) + '">Copy</button>'
        + '</div>'
        + '<div style="display:flex;gap:6px">'
        + '<button class="btn-sm" data-edit="' + esc(w.id) + '">Edit style</button>'
        + '<button class="btn-sm" data-prev="' + esc(w.id) + '">Preview</button>'
        + '<button class="btn-sm" data-dup="' + esc(w.id) + '">Duplicate</button>'
        + '<button class="btn-sm" data-del="' + esc(w.id) + '" style="margin-left:auto">Delete</button>'
        + '</div>'
        + '</div>';
    });
  }
  root.innerHTML = html;

  root.querySelectorAll('[data-add]').forEach((el) => el.addEventListener('click', (e) => addWidget(e.target.dataset.add)));
  root.querySelectorAll('[data-copy]').forEach((el) => el.addEventListener('click', (e) => navigator.clipboard?.writeText(widgetUrl(e.target.dataset.copy)).catch(() => {})));
  root.querySelectorAll('[data-edit]').forEach((el) => el.addEventListener('click', (e) => { editingId = e.target.dataset.edit; render(); }));
  // Show a widget in the preview without opening its editor — with three types
  // now, there is no sensible "default" one to show.
  root.querySelectorAll('[data-prev]').forEach((el) => el.addEventListener('click', (e) => {
    reloadPreview(e.target.dataset.prev);
    flash(e.target, 'Showing');
  }));
  root.querySelectorAll('[data-dup]').forEach((el) => el.addEventListener('click', (e) => {
    const src = widgets().find((x) => x.id === e.target.dataset.dup);
    if (!src) return;
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = rid();
    copy.name = src.name + ' copy';
    widgets().push(copy);
    persist(); render();
  }));
  root.querySelectorAll('[data-del]').forEach((el) => el.addEventListener('click', (e) => {
    const id = e.target.dataset.del;
    const i = widgets().findIndex((x) => x.id === id);
    if (i >= 0) { widgets().splice(i, 1); persist(); reloadPreview(null); render(); }
  }));

  // Preview whatever you last had open, falling back to the first widget.
  // Previewing list[0] unconditionally meant coming back from editing a hype
  // train showed you a chat widget instead — fine when there were two types,
  // confusing now.
  const stillThere = lastPreviewId && list.some((x) => x.id === lastPreviewId);
  if (stillThere) reloadPreview(lastPreviewId);
  else if (list.length) reloadPreview(list[0].id);
  else reloadPreview(null);
}

function renderEditor(root) {
  const w = widgets().find((x) => x.id === editingId);
  if (!w) { editingId = null; renderList(root); return; }

  const fontOpts = "<option value='System default'" + (w.font === 'System default' ? ' selected' : '') + ">System default</option>" + fontOptionsHtml(w.font);
  const ev = w.events || (w.events = { follow: true, sub: true, cheer: true, raid: true });
  const mode = w.mode || 'css';
  // Style always exists — CSS mode uses it too (maxMsg / hideAfter / scroll).
  if (!w.style) {
    w.style = JSON.parse(JSON.stringify(DEFAULT_STYLE[w.type] || DEFAULT_STYLE.chat));
    w.styleCss = generateStyleCss(w.type, w.style, w.eventStyle);
  }
  const s = w.style;

  // Little control builders for the designer.
  const row = (inner) => '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin:7px 0">' + inner + '</div>';
  const cColor = (k, label) => row('<label style="font-size:.8rem">' + label + '</label><input type="color" data-s="' + k + '" value="' + esc(s[k] || '#000000') + '" style="width:46px;height:26px;padding:0;border:none;background:none">');
  const cRange = (k, label, min, max) => row('<label style="font-size:.8rem;flex:1">' + label + ' <span data-v="' + k + '" style="color:var(--muted)">' + s[k] + '</span></label><input type="range" data-s="' + k + '" min="' + min + '" max="' + max + '" value="' + s[k] + '" style="flex:1">');
  const cCheck = (k, label) => '<label class="checkrow" style="margin:7px 0"><input type="checkbox" data-s="' + k + '"' + (s[k] ? ' checked' : '') + '> ' + label + '</label>';
  const cSelect = (k, label, opts) => row('<label style="font-size:.8rem;flex:1">' + label + '</label><select data-s="' + k + '" style="flex:1">' + opts.map((o) => '<option value="' + o[0] + '"' + (o[0] === s[k] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select>');
  const activeBtn = (on) => on ? ' style="background:#6b5bd0;color:#fff"' : '';

  // Event-highlight style builders (chat) → w.eventStyle via data-es.
  const es = w.eventStyle || (w.eventStyle = JSON.parse(JSON.stringify(DEFAULT_EVENTSTYLE)));
  const eColor = (k, label) => row('<label style="font-size:.8rem">' + label + '</label><input type="color" data-es="' + k + '" value="' + esc(es[k] || '#000000') + '" style="width:46px;height:26px;padding:0;border:none;background:none">');
  const eRange = (k, label, min, max) => row('<label style="font-size:.8rem;flex:1">' + label + ' <span data-ev2="' + k + '" style="color:var(--muted)">' + es[k] + '</span></label><input type="range" data-es="' + k + '" min="' + min + '" max="' + max + '" value="' + es[k] + '" style="flex:1">');
  const eCheck = (k, label) => '<label class="checkrow" style="margin:7px 0"><input type="checkbox" data-es="' + k + '"' + (es[k] ? ' checked' : '') + '> ' + label + '</label>';

  const chatDesignerExtras = w.type !== 'chat' ? '' :
      '<div style="border-top:1px dashed var(--line);margin:10px 0 4px;padding-top:8px;font-size:.78rem;color:var(--muted)">Chat layout</div>'
    + cRange('gap', 'Gap between messages', 0, 40)
    + cRange('maxMsg', 'Max messages kept', 3, 60)
    + cRange('hideAfter', 'Hide after (seconds, 0 = never)', 0, 120)
    + cCheck('oneLine', 'Single-line messages (cut off with … instead of wrapping)')
    + cRange('maxWidth', 'Max message width', 120, 800)
    + '<div style="border-top:1px dashed var(--line);margin:10px 0 4px;padding-top:8px;font-size:.78rem;color:var(--muted)">Askew / tilt</div>'
    + cRange('tilt', 'Tilt angle', 0, 30) + cCheck('tiltAlt', 'Alternate each message')
    + (w.showEvents
        ? '<div style="border-top:1px dashed var(--line);margin:10px 0 4px;padding-top:8px;font-size:.78rem;color:var(--muted)">Event highlight look</div>'
          + eColor('bg', 'Background') + eRange('bgOpacity', 'Opacity %', 0, 100) + eColor('text', 'Text colour')
          + eCheck('glow', 'Glow') + eColor('glowColor', 'Glow colour') + eRange('radius', 'Corner radius', 0, 30)
        : '');

  const designerPanel =
      cColor('bg', 'Background') + cRange('bgOpacity', 'Opacity %', 0, 100)
    + cColor('text', 'Text colour') + cColor('accent', 'Accent (name/title)')
    + cRange('radius', 'Corner radius', 0, 40) + cRange('pad', 'Padding', 2, 36) + cRange('fontSize', 'Font size', 10, 72)
    + cCheck('glow', 'Glow') + cRange('glowSize', 'Glow size', 0, 50) + cColor('glowColor', 'Glow colour')
    + cCheck('shadow', 'Drop shadow')
    + (w.type === 'chat' ? cCheck('gradient', 'Gradient background (fades the sides)') : '')
    + (w.type === 'alert' ? cRange('duration', 'On screen (seconds)', 2, 15) : '')
    + '<div style="border-top:1px dashed var(--line);margin:10px 0 4px;padding-top:8px;font-size:.78rem;color:var(--muted)">Animation</div>'
    + cSelect('animIn', 'Appears with', IN_OPTS) + cSelect('animInDir', 'Slide direction', DIR_OPTS)
    + cSelect('animOut', 'Disappears with', OUT_OPTS) + cSelect('animOutDir', 'Slide direction', DIR_OPTS)
    + cSelect('speed', 'Speed', SPEED_OPTS)
    + chatDesignerExtras
    + '<button class="btn-sm" id="diyCopyCss" style="margin-top:12px">Copy my design as CSS</button>';

  const presetList = CSS_PRESETS[w.type] || [];
  const presetPanel = !presetList.length ? '' :
      '<label style="font-size:.8rem;color:var(--muted)">Starting looks</label>'
    + '<div class="row" style="gap:6px;flex-wrap:wrap;margin:4px 0 12px">'
    + presetList.map(pz =>
        '<button class="btn-sm btn-ghost" data-preset="' + esc(pz.name) + '">' + esc(pz.name) + '</button>').join('')
    + '</div>';

  const cssPanel =
      presetPanel
    + '<label style="font-size:.8rem;color:var(--muted)">CSS. Edit it and the preview updates as you type</label>'
    + '<textarea id="diyCss" spellcheck="false" style="width:100%;height:320px;margin-top:4px;font-family:ui-monospace,Consolas,monospace;font-size:.8rem;line-height:1.45;white-space:pre;tab-size:2">' + esc(w.css) + '</textarea>'
    + '<p style="font-size:.72rem;color:var(--muted);margin:8px 0 0">Style hooks: '
    + (w.type === 'chat'
        ? '<code>#spark-chat</code>, <code>.msg</code>, <code>.msg-name</code>, <code>.msg-text</code>. Per chatter level: <code>.msg.role-broadcaster</code>, <code>.role-mod</code>, <code>.role-vip</code>, <code>.role-sub</code>, <code>.role-follower</code>, <code>.role-viewer</code>. In-chat events: <code>.chat-event</code>.'
        : '<code>#spark-alert</code>, <code>.alert.show</code>, <code>.alert-title</code>, <code>.alert-name</code> (subs add <code>.alert-sub</code>)')
    + '</p>'
    + (w.type === 'hypetrain'
        ? '<div style="border-top:1px dashed var(--line);margin:10px 0 4px;padding-top:8px;font-size:.78rem;color:var(--muted)">Hype train</div>'
          + '<label class="checkrow" style="margin:8px 0"><input type="checkbox" id="diyShowTop"' + (w.showTop ? ' checked' : '') + '> Show the top contributor\'s name</label>'
          + '<div class="hint" style="margin:0 0 8px">Off by default — not everyone wants their name on stream. The bar, level and countdown show either way.</div>'
        : '')
    + (w.type === 'chat'
        ? '<div style="border-top:1px dashed var(--line);margin:10px 0 4px;padding-top:8px;font-size:.78rem;color:var(--muted)">Chat behaviour</div>'
          + cRange('maxMsg', 'Max messages kept', 3, 60)
          + cRange('hideAfter', 'Hide after (seconds, 0 = never)', 0, 120)
        : '')
    + row('<label style="font-size:.8rem;flex:1">Exit animation time (ms). How long your <code>.spk-out</code> rules run (0 = remove instantly)</label>'
        + '<input type="number" id="diyCssOutMs" min="0" max="5000" step="50" value="' + (w.cssOutMs || 0) + '" style="width:90px">');

  // Alert text templates (per shown event) — content, works in both modes.
  const at = w.alertText || (w.alertText = JSON.parse(JSON.stringify(DEFAULT_ALERTTEXT)));
  const alertTextHtml = w.type !== 'alert' ? '' :
      '<label style="font-size:.8rem;color:var(--muted)">Alert text. Use {name} and {amount}</label>'
    + ['follow', 'sub', 'cheer', 'raid'].map((k) => {
        const t = at[k] || DEFAULT_ALERTTEXT[k];
        return '<div style="margin:5px 0 9px">'
          + '<div style="font-size:.72rem;color:var(--muted);margin-bottom:3px">' + evLabel(k) + '</div>'
          + '<input type="text" data-at="' + k + '" data-atf="title" value="' + esc(t.title) + '" placeholder="Title" style="width:100%;font-size:.8rem;margin-bottom:4px">'
          + '<input type="text" data-at="' + k + '" data-atf="message" value="' + esc(t.message) + '" placeholder="Message" style="width:100%;font-size:.8rem">'
          + '</div>';
      }).join('')
    + '<div style="height:6px"></div>';

  // Chat behaviour (scroll direction + role icons) — works in both modes.
  const ic = w.icons || (w.icons = JSON.parse(JSON.stringify(DEFAULT_ICONS)));
  const rst = w.roleStyle || (w.roleStyle = JSON.parse(JSON.stringify(DEFAULT_ROLESTYLE)));
  const cet = w.chatEventText || (w.chatEventText = JSON.parse(JSON.stringify(DEFAULT_CHATEVENTTEXT)));
  const scrollVal = (w.style && w.style.scroll) || 'up';
  const chatBehaviourHtml = w.type !== 'chat' ? '' :
      '<label style="font-size:.8rem;color:var(--muted)">Scroll direction</label>'
    + '<select id="diyScroll" style="width:100%;margin:4px 0 12px">'
    + SCROLL_OPTS.map((o) => '<option value="' + o[0] + '"' + (o[0] === scrollVal ? ' selected' : '') + '>' + o[1] + '</option>').join('')
    + '</select>'
    + '<label style="font-size:.8rem;color:var(--muted)">Name styling: icon, colour and glow per role</label>'
    + '<div style="margin:6px 0 12px">'
    + ICON_ROLES.map(([role, label]) => {
        const val = ic[role] || '';
        const isImg = /[\\/]/.test(val) || /\.(png|jpe?g|gif|webp|svg)$/i.test(val);
        const rs = rst[role] || {};
        return '<div style="display:flex;gap:5px;align-items:center;margin:5px 0;flex-wrap:wrap">'
          + '<span style="width:80px;font-size:.74rem">' + label + '</span>'
          + (isImg
              ? '<span style="flex:1;min-width:56px;font-size:.72rem;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">🖼 ' + esc(fileName(val)) + '</span>'
              : '<input type="text" data-icon="' + role + '" value="' + esc(val) + '" placeholder="emoji" style="flex:1;min-width:42px;font-size:.9rem">')
          + '<button class="btn-sm" data-iconimg="' + role + '">Img</button>'
          + (val ? '<button class="btn-sm" data-iconclear="' + role + '">✕</button>' : '')
          + '<label style="font-size:.68rem;display:flex;align-items:center;gap:2px"><input type="checkbox" data-roleon="' + role + '"' + (rs.on ? ' checked' : '') + '>CC</label>'
          + '<input type="color" data-rolecolor="' + role + '" value="' + esc(rs.color || '#ffffff') + '" style="width:28px;height:22px;padding:0;border:none;background:none">'
          + '<label style="font-size:.68rem;display:flex;align-items:center;gap:2px"><input type="checkbox" data-roleglow="' + role + '"' + (rs.glow ? ' checked' : '') + '>glow</label>'
          + '</div>';
      }).join('')
    + '</div>'
    + '<label class="checkrow" style="margin:8px 0"><input type="checkbox" id="diyShowEvents"' + (w.showEvents ? ' checked' : '') + '> Show follows / subs / raids in chat</label>'
    + (w.showEvents
        ? '<label style="font-size:.8rem;color:var(--muted)">Event text. Use {name} and {amount}</label>'
          + ['follow', 'sub', 'cheer', 'raid'].map((k) =>
              '<div style="margin:4px 0"><div style="font-size:.72rem;color:var(--muted);margin-bottom:2px">' + evLabel(k) + '</div>'
              + '<input type="text" data-cet="' + k + '" value="' + esc(cet[k] != null ? cet[k] : (DEFAULT_CHATEVENTTEXT[k] || '')) + '" style="width:100%;font-size:.8rem"></div>').join('')
          + '<div style="height:6px"></div>'
        : '');

  root.innerHTML = ''
    + '<div class="card">'
    + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">'
    + '<button class="btn-sm" id="diyBack">← Back</button>'
    + '<strong style="flex:1">Editing: ' + esc(w.name) + '</strong>'
    + '</div>'
    + '<label style="font-size:.8rem;color:var(--muted)">Name</label>'
    + '<input type="text" id="diyName" value="' + esc(w.name) + '" style="width:100%;margin:4px 0 12px">'
    + '<label style="font-size:.8rem;color:var(--muted)">Font</label>'
    + '<select id="diyFont" style="width:100%;margin:4px 0 12px">' + fontOpts + '</select>'
    + (w.type === 'alert'
        ? '<label style="font-size:.8rem;color:var(--muted)">Show these alerts</label>'
          + '<div style="display:flex;flex-wrap:wrap;gap:14px;margin:6px 0 12px">'
          + ['follow', 'sub', 'cheer', 'raid'].map((k) =>
              '<label class="checkrow" style="margin:0"><input type="checkbox" data-ev="' + k + '"'
              + (ev[k] !== false ? ' checked' : '') + '> ' + evLabel(k) + '</label>').join('')
          + '</div>'
          + '<label style="font-size:.8rem;color:var(--muted)">Sound (plays when the alert fires, any length)</label>'
          + '<div style="display:flex;gap:6px;align-items:center;margin:6px 0 12px">'
          + '<button class="btn-sm" id="diySoundPick">Choose sound…</button>'
          + '<span style="flex:1;font-size:.78rem;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'
          + (w.sound ? esc(fileName(w.sound)) : 'None') + '</span>'
          + (w.sound ? '<button class="btn-sm" id="diySoundClear">Clear</button>' : '')
          + '</div>'
        : '')
    + '<label style="font-size:.8rem;color:var(--muted)">Test. Fires on the preview and any live OBS source</label>'
    + '<div style="display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 12px">'
    + (w.type === 'alert'
        ? '<button class="btn-sm" data-test="follow">Test Follow</button>'
          + '<button class="btn-sm" data-test="sub">Test Sub</button>'
          + '<button class="btn-sm" data-test="cheer">Test Bits</button>'
          + '<button class="btn-sm" data-test="raid">Test Raid</button>'
        : w.type === 'hypetrain'
        ? '<button class="btn-sm" data-test="normal">Test Hype Train</button>'
        : '<button class="btn-sm" data-test="message">Test Message</button>')
    + '</div>'
    + alertTextHtml
    + chatBehaviourHtml
    + '<div style="border-top:1px solid var(--line);padding-top:10px">'
    // The visual Designer builds CSS from chat/alert-shaped options and knows
    // nothing about a hype train, so offering it there would hand you chat
    // styling for a progress bar. Presets + CSS are that type's controls.
    + (w.type === 'hypetrain' ? '' :
        '<div style="display:flex;gap:6px;margin-bottom:12px">'
      + '<button class="btn-sm" data-mode="designer"' + activeBtn(mode === 'designer') + '>🎛 Designer</button>'
      + '<button class="btn-sm" data-mode="css"' + activeBtn(mode === 'css') + '>&lt;/&gt; Custom CSS</button>'
      + '</div>')
    + (mode === 'designer' && w.type !== 'hypetrain' ? designerPanel : cssPanel)
    + '</div>'
    + '</div>';

  root.querySelectorAll('[data-test]').forEach((el) => el.addEventListener('click', (e) => fireTest(w, e.target.dataset.test)));
  $('diyBack').addEventListener('click', () => { editingId = null; render(); });
  $('diyName').addEventListener('input', (e) => {
    w.name = e.target.value;
    clearTimeout(nameTimer);
    nameTimer = setTimeout(persist, 500); // don't write the whole file per keystroke
  });
  $('diyFont').addEventListener('change', (e) => { w.font = e.target.value; saveAndPreview(w.id); });
  root.querySelectorAll('[data-ev]').forEach((el) => el.addEventListener('change', (e) => {
    (w.events = w.events || {})[e.target.dataset.ev] = e.target.checked;
    saveAndPreview(w.id);
  }));
  $('diySoundPick')?.addEventListener('click', async () => {
    try {
      const p = await window.__TAURI__.dialog.open({ multiple: false,
        filters: [{ name: 'Audio', extensions: ['mp3', 'ogg', 'wav', 'm4a', 'aac', 'flac', 'webm'] }] });
      if (p) { w.sound = p; await persist(); pushObsRefresh(w.id); render(); }
    } catch (e) {}
  });
  $('diySoundClear')?.addEventListener('click', async () => { w.sound = ''; await persist(); pushObsRefresh(w.id); render(); });

  // Mode toggle
  root.querySelectorAll('[data-mode]').forEach((el) => el.addEventListener('click', (e) => {
    w.mode = e.target.dataset.mode;
    if (w.mode === 'designer' && !w.style) {
      w.style = JSON.parse(JSON.stringify(DEFAULT_STYLE[w.type] || DEFAULT_STYLE.chat));
      w.styleCss = generateStyleCss(w.type, w.style, w.eventStyle);
    }
    persist(); pushObsRefresh(w.id); render();
  }));

  // Designer controls. Style changes go straight into the running preview via
  // postMessage (no reload, nothing on screen resets); the save + OBS nudge is
  // debounced behind it. Keys the runtime only reads at page load still reload.
  const RELOAD_KEYS = { maxMsg: 1, hideAfter: 1, duration: 1 };
  root.querySelectorAll('[data-s]').forEach((el) => el.addEventListener('input', (e) => {
    const k = e.target.dataset.s;
    let val;
    if (e.target.type === 'checkbox') val = e.target.checked;
    else if (e.target.type === 'range') { val = parseInt(e.target.value, 10); const vs = root.querySelector('[data-v="' + k + '"]'); if (vs) vs.textContent = val; }
    else val = e.target.value;
    (w.style = w.style || {})[k] = val;
    w.styleCss = generateStyleCss(w.type, w.style, w.eventStyle);
    clearTimeout(previewTimer);
    if (RELOAD_KEYS[k]) {
      previewTimer = setTimeout(() => saveAndPreview(w.id), 220);
    } else {
      livePreview(w);
      previewTimer = setTimeout(() => saveLive(w.id), 400);
    }
  }));
  $('diyCopyCss')?.addEventListener('click', () => {
    w.css = generateStyleCss(w.type, w.style, w.eventStyle);
    w.mode = 'css';
    persist(); pushObsRefresh(w.id); render();
  });

  // Custom CSS box — pushed into the preview on every keystroke, saved behind.
  $('diyCss')?.addEventListener('input', (e) => {
    w.css = e.target.value;
    livePreview(w);
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => saveLive(w.id), 400);
  });

  // Exit-animation duration for custom CSS mode (runtime OUTMS).
  $('diyCssOutMs')?.addEventListener('input', (e) => {
    w.cssOutMs = Math.max(0, parseInt(e.target.value, 10) || 0);
    livePreview(w);
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => saveLive(w.id), 400);
  });

  // Alert text (live)
  root.querySelectorAll('[data-at]').forEach((el) => el.addEventListener('input', (e) => {
    const k = e.target.dataset.at, f = e.target.dataset.atf;
    w.alertText = w.alertText || JSON.parse(JSON.stringify(DEFAULT_ALERTTEXT));
    (w.alertText[k] = w.alertText[k] || {})[f] = e.target.value;
    livePreview(w);
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => saveLive(w.id), 400);
  }));

  // Chat scroll direction (reloads — changes the runtime insert direction)
  $('diyScroll')?.addEventListener('change', (e) => {
    w.style = w.style || JSON.parse(JSON.stringify(DEFAULT_STYLE[w.type] || DEFAULT_STYLE.chat));
    w.style.scroll = e.target.value;
    w.styleCss = generateStyleCss(w.type, w.style, w.eventStyle);
    saveAndPreview(w.id);
  });

  // Role icons — emoji typed, image picked, or cleared (reload to re-read)
  root.querySelectorAll('[data-icon]').forEach((el) => el.addEventListener('input', (e) => {
    (w.icons = w.icons || {})[e.target.dataset.icon] = e.target.value;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => saveAndPreview(w.id), 400);
  }));
  root.querySelectorAll('[data-iconimg]').forEach((el) => el.addEventListener('click', async (e) => {
    try {
      const p = await window.__TAURI__.dialog.open({ multiple: false,
        filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }] });
      if (p) { (w.icons = w.icons || {})[e.target.dataset.iconimg] = p; await persist(); pushObsRefresh(w.id); render(); }
    } catch (err) {}
  }));
  root.querySelectorAll('[data-iconclear]').forEach((el) => el.addEventListener('click', async (e) => {
    (w.icons = w.icons || {})[e.target.dataset.iconclear] = ''; await persist(); pushObsRefresh(w.id); render();
  }));

  // Per-role name colour / glow (live)
  const roleLive = (e) => {
    const role = e.target.dataset.roleon || e.target.dataset.rolecolor || e.target.dataset.roleglow;
    w.roleStyle = w.roleStyle || JSON.parse(JSON.stringify(DEFAULT_ROLESTYLE));
    const rs = (w.roleStyle[role] = w.roleStyle[role] || { on: false, color: '#ffffff', glow: false });
    if (e.target.dataset.roleon != null) rs.on = e.target.checked;
    else if (e.target.dataset.roleglow != null) rs.glow = e.target.checked;
    else rs.color = e.target.value;
    livePreview(w);
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => saveLive(w.id), 400);
  };
  root.querySelectorAll('[data-roleon],[data-rolecolor],[data-roleglow]').forEach((el) => el.addEventListener('input', roleLive));

  // Show-events toggle (reload — changes the runtime and reveals event controls)
  $('diyShowEvents')?.addEventListener('change', async (e) => { w.showEvents = e.target.checked; await persist(); pushObsRefresh(w.id); render(); });

  // Hype train: name the top contributor, or don't.
  $('diyShowTop')?.addEventListener('change', async (e) => {
    w.showTop = e.target.checked;
    await persist();
    // The live preview picks it up without a reload; the OBS source needs one.
    livePreview(w);   // preview updates instantly; OBS needs the refresh below
    pushObsRefresh(w.id);
  });

  // Starting looks. Replacing hand-edited CSS asks first — one stray click
  // would otherwise throw away an evening's work with no undo.
  root.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.preset;
      const css = presetCssFor(w.type, name);
      if (css == null) return;
      if (String(css).trim() === String(w.css || '').trim()) return;  // already on it
      if (cssIsCustom(w) && !confirm('Replace your CSS with the "' + name + '" look?\n\nYour current CSS will be lost.')) return;
      w.css = css;
      w.mode = 'css';
      await persist();
      render();
      pushObsRefresh(w.id);
    });
  });

  // In-chat event text (live)
  root.querySelectorAll('[data-cet]').forEach((el) => el.addEventListener('input', (e) => {
    (w.chatEventText = w.chatEventText || {})[e.target.dataset.cet] = e.target.value;
    livePreview(w);
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => saveLive(w.id), 400);
  }));

  // Event-highlight style (live)
  root.querySelectorAll('[data-es]').forEach((el) => el.addEventListener('input', (e) => {
    const k = e.target.dataset.es;
    let val;
    if (e.target.type === 'checkbox') val = e.target.checked;
    else if (e.target.type === 'range') { val = parseInt(e.target.value, 10); const vs = root.querySelector('[data-ev2="' + k + '"]'); if (vs) vs.textContent = val; }
    else val = e.target.value;
    (w.eventStyle = w.eventStyle || {})[k] = val;
    w.styleCss = generateStyleCss(w.type, w.style, w.eventStyle);
    livePreview(w);
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => saveLive(w.id), 400);
  }));

  reloadPreview(w.id);
}

// ── Init ───────────────────────────────────────────────────────────────────────
export async function initDiy() {
  if (!store.diy || typeof store.diy !== 'object') store.diy = { widgets: [] };
  editingId = null;
  // Regenerate stored designer CSS so every widget matches the current
  // generateStyleCss output without needing to be re-edited.
  let regen = false;
  widgets().forEach((w) => {
    if ((w.mode || 'css') === 'designer' && w.style) {
      const cssNow = generateStyleCss(w.type, w.style, w.eventStyle);
      if (w.styleCss !== cssNow) { w.styleCss = cssNow; regen = true; }
    }
  });
  if (regen) persist();
  $('diyCopyUrl')?.addEventListener('click', () => {
    const v = $('diyOverlayUrl')?.value;
    if (v) navigator.clipboard?.writeText(v).catch(() => {});
  });
  render();
}
