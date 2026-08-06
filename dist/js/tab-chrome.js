// ── Tab bar chrome ───────────────────────────────────────────────────────────
// Two things that both live on the strip above #content, so they share a file:
//
//   1. Overflow menu. The tab row is a fixed set of twelve non-wrapping items.
//      When the window is narrowed past what they need, the ones on the right
//      collapse into a "⋯" dropdown instead of spilling out of the window.
//
//   2. Disabled-tool banner. Settings can switch a tool's chat commands and
//      redeems off. Without a cue, that tab looks completely normal and the
//      streamer is left wondering why nothing responds in chat.
//
// The banner is ONE element shared by every tab rather than one per pane:
// .tab-pane is itself a flex container with a split column layout, so a child
// injected at the top of each would have to be fought into place twelve
// separate times. A single strip outside #content sidesteps all of that.

import { TOOL_DEFS, toolToggles, toolEnabled, saveToolToggles } from './store.js';

// Tabs that must never collapse into the overflow menu. Settings is last in the
// DOM, so it would otherwise be the very first thing to disappear — and it is
// the one tab you need when something is misconfigured.
const PINNED = new Set(['settings']);

const TOOL_LABEL = {};
TOOL_DEFS.forEach(t => { TOOL_LABEL[t.id] = t.label; });

let bar, wrap, btn, btnLabel, menu, banner, bannerMsg, bannerBtn;
let tabs = [];
let hidden = new Set();
let reflowQueued = false;

// ── Tab selection ────────────────────────────────────────────────────────────

export function selectTab(id){
  const tab = tabs.find(t => t.dataset.tab === id);
  const pane = document.getElementById('pane-' + id);
  if(!tab || !pane) return;

  tabs.forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  tab.classList.add('active');
  pane.classList.add('active');

  closeMenu();
  syncOverflowBtn();
  refreshDisabledBanner();
}

function activeTabId(){
  const t = tabs.find(x => x.classList.contains('active'));
  return t ? t.dataset.tab : null;
}

function tabLabel(tab){
  return (tab.textContent || '').trim();
}

// ── Overflow ────────────────────────────────────────────────────────────────

// Measure with every tab visible, then hide from the right until the row fits.
// Widths are read fresh each pass rather than cached: theme and font changes
// both move them, and reading twelve offsetWidths is cheap next to the risk of
// laying out against stale numbers.
function reflow(){
  if(!bar || !tabs.length) return;

  // Reset to the natural row. No paint happens between here and the end of
  // this function, so the brief overflow is never visible.
  tabs.forEach(t => t.classList.remove('tab-overflowed'));
  wrap.classList.remove('on');
  btnLabel.textContent = '';
  hidden = new Set();

  const avail = bar.clientWidth;
  if(!avail) return; // window not laid out yet

  const width = new Map();
  tabs.forEach(t => width.set(t, t.offsetWidth));

  let running = 0;
  width.forEach(v => { running += v; });

  if(running <= avail){
    renderMenu();
    syncOverflowBtn();
    return;
  }

  // Something has to go. The button now takes part in layout, so its own width
  // counts against the budget from here on.
  wrap.classList.add('on');

  const flexible = tabs.filter(t => !PINNED.has(t.dataset.tab));

  // Rightmost first, so the row keeps reading left to right.
  for(let i = flexible.length - 1; i >= 0; i--){
    if(running + wrap.offsetWidth <= avail) break;
    const t = flexible[i];
    t.classList.add('tab-overflowed');
    hidden.add(t);
    running -= width.get(t);
  }

  renderMenu();
  syncOverflowBtn();

  // Naming the active tab on the button makes it wider, which can push the row
  // back over the edge. Give up one more tab at a time until it settles; the
  // guard is only there so a pathological width can never spin forever.
  let guard = 0;
  while(guard++ < 16 && running + wrap.offsetWidth > avail){
    const next = [...flexible].reverse().find(t => !hidden.has(t));
    if(!next) break;
    next.classList.add('tab-overflowed');
    hidden.add(next);
    running -= width.get(next);
    renderMenu();
    syncOverflowBtn();
  }
}

function renderMenu(){
  if(!menu) return;
  menu.innerHTML = '';
  // DOM order, not hide order, so the menu reads the same way the bar does.
  tabs.filter(t => hidden.has(t)).forEach(t => {
    const item = document.createElement('div');
    item.className = 'tab-of-item' + (t.classList.contains('active') ? ' active' : '');
    item.setAttribute('role', 'menuitem');
    item.dataset.tab = t.dataset.tab;
    const svg = t.querySelector('svg');
    if(svg) item.appendChild(svg.cloneNode(true));
    item.appendChild(document.createTextNode(tabLabel(t)));
    item.addEventListener('click', () => selectTab(t.dataset.tab));
    menu.appendChild(item);
  });
}

// When the selected tab is inside the menu it has no visible marker in the bar,
// so the button borrows its name and its gold underline.
function syncOverflowBtn(){
  if(!btn) return;
  const active = tabs.find(t => t.classList.contains('active'));
  const buried = !!active && hidden.has(active);
  btn.classList.toggle('active', buried);
  btnLabel.textContent = buried ? tabLabel(active) : '';
  btn.title = buried ? tabLabel(active) + ' — more tabs' : 'More tabs';
}

function openMenu(){
  if(!menu || !hidden.size) return;
  menu.classList.add('open');
  btn.setAttribute('aria-expanded', 'true');
}

function closeMenu(){
  if(!menu) return;
  menu.classList.remove('open');
  btn?.setAttribute('aria-expanded', 'false');
}

function queueReflow(){
  if(reflowQueued) return;
  reflowQueued = true;
  requestAnimationFrame(() => { reflowQueued = false; reflow(); });
}

// ── Disabled banner ─────────────────────────────────────────────────────────

export function refreshDisabledBanner(){
  if(!banner) return;
  const id = activeTabId();

  // Only the eight command/redeem tools have a toggle. Chat, Credits, D.I.Y
  // and Settings are always on and never show the strip.
  if(!id || !TOOL_LABEL[id] || toolEnabled(id)){
    banner.classList.remove('on');
    banner.dataset.tool = '';
    return;
  }

  bannerMsg.innerHTML = '<b>' + TOOL_LABEL[id] + '</b> is disabled in Settings — '
    + 'chat commands and channel point redeems for this tool are being ignored.';
  banner.dataset.tool = id;
  banner.classList.add('on');
}

function turnActiveToolOn(){
  const id = banner?.dataset.tool;
  if(!id) return;
  const tg = toolToggles();
  if(!tg[id]) tg[id] = {};
  tg[id].enabled = true;
  saveToolToggles();
  refreshDisabledBanner();
  // Settings may already have rendered its checkbox list; tell it to redraw so
  // the two views cannot disagree.
  window.dispatchEvent(new CustomEvent('spark-tools-changed'));
}

// ── Init ────────────────────────────────────────────────────────────────────

export function initTabChrome(){
  bar       = document.getElementById('tabs');
  wrap      = document.getElementById('tabOverflowWrap');
  btn       = document.getElementById('tabOverflowBtn');
  btnLabel  = document.getElementById('tabOverflowLabel');
  menu      = document.getElementById('tabOverflowMenu');
  banner    = document.getElementById('tabDisabledBanner');
  bannerMsg = banner ? banner.querySelector('.msg') : null;
  bannerBtn = document.getElementById('tabDisabledBannerOn');
  if(!bar) return;

  tabs = [...bar.querySelectorAll('.tab')];
  tabs.forEach(t => t.addEventListener('click', () => selectTab(t.dataset.tab)));

  bannerBtn?.addEventListener('click', turnActiveToolOn);

  btn?.addEventListener('click', e => {
    e.stopPropagation();
    menu.classList.contains('open') ? closeMenu() : openMenu();
  });
  document.addEventListener('click', e => {
    if(!wrap?.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', e => {
    if(e.key === 'Escape') closeMenu();
  });

  // ResizeObserver rather than window.resize: it also catches the initial
  // layout pass, which fires before any resize event ever would.
  if(window.ResizeObserver) new ResizeObserver(queueReflow).observe(bar);
  else window.addEventListener('resize', queueReflow);

  // Segoe UI is normally there instantly, but if it swaps in late every tab
  // width shifts, so measure again once the fonts have settled.
  document.fonts?.ready?.then(queueReflow).catch(() => {});

  queueReflow();
  refreshDisabledBanner();
}
