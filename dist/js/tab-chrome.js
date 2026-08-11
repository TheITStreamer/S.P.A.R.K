// ── Sidebar chrome ───────────────────────────────────────────────────────────
// Everything about the navigation strip down the left of the window:
//
//   1. Tab selection.
//   2. Collapsing the sidebar to icons only.
//   3. Drag to reorder, so the tools you actually use sit at the top.
//   4. Ctrl+K to jump straight to a tab by typing.
//   5. The disabled-tool banner.
//
// This used to be a horizontal bar with an overflow menu. Fourteen tabs needed
// roughly 1800px of row and never had it, so four always collapsed into a "⋯"
// dropdown — and it was the last four in the DOM, not the four you use least.
// Stacked vertically they all fit with room to spare, and the whole overflow
// measure-and-hide pass is gone.
//
// The banner is ONE element shared by every tab rather than one per pane:
// .tab-pane is itself a flex container with a split column layout, so a child
// injected at the top of each would have to be fought into place fourteen
// separate times. A single strip above #content sidesteps all of that.

import { store, TOOL_DEFS, toolToggles, toolEnabled, saveToolToggles } from './store.js';

const { invoke } = window.__TAURI__.core;

const TOOL_LABEL = {};
TOOL_DEFS.forEach(t => { TOOL_LABEL[t.id] = t.label; });

let bar, collapseBtn, banner, bannerMsg, bannerBtn;
let jump, jumpInput, jumpList;
let tabs = [];

// ── Tab selection ────────────────────────────────────────────────────────────

export function selectTab(id){
  const tab = tabs.find(t => t.dataset.tab === id);
  const pane = document.getElementById('pane-' + id);
  if(!tab || !pane) return;

  tabs.forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  tab.classList.add('active');
  pane.classList.add('active');

  closeJump();
  refreshDisabledBanner();
}

function activeTabId(){
  const t = tabs.find(x => x.classList.contains('active'));
  return t ? t.dataset.tab : null;
}

function tabLabel(tab){
  const el = tab.querySelector('.tab-label');
  return (el ? el.textContent : tab.textContent || '').trim();
}

// ── Saved layout ─────────────────────────────────────────────────────────────
// Order and collapsed state live in settings, which is written rarely — these
// change when the user drags something, not on a timer.

function saveLayout(){
  store.settings.tabOrder     = tabs.map(t => t.dataset.tab);
  store.settings.sideCollapsed = document.body.classList.contains('side-collapsed');
  invoke('save_app_settings', { data: store.settings }).catch(()=>{});
}

// Applies a saved order to the DOM. Anything saved that no longer exists is
// skipped, and anything NEW that the saved order predates keeps its natural
// place at the end — so adding a tab in a future release never disappears just
// because someone reordered once.
function applySavedOrder(){
  const want = store.settings && store.settings.tabOrder;
  if(!Array.isArray(want) || !want.length) return;

  const byId = new Map(tabs.map(t => [t.dataset.tab, t]));
  const ordered = [];
  want.forEach(id => { const t = byId.get(id); if(t){ ordered.push(t); byId.delete(id); } });
  byId.forEach(t => ordered.push(t));   // tabs the saved order never knew about

  ordered.forEach(t => bar.insertBefore(t, collapseBtn));
  tabs = ordered;
}

// ── Collapse ─────────────────────────────────────────────────────────────────

function applyCollapsed(on){
  document.body.classList.toggle('side-collapsed', !!on);
  if(collapseBtn) collapseBtn.title = on ? 'Expand the sidebar' : 'Collapse the sidebar';
  // With labels hidden the icon alone has to say what a tab is.
  tabs.forEach(t => { t.title = on ? tabLabel(t) : ''; });
}

function toggleCollapsed(){
  applyCollapsed(!document.body.classList.contains('side-collapsed'));
  saveLayout();
}

// ── Drag to reorder ──────────────────────────────────────────────────────────
// mousedown/mousemove rather than the HTML5 drag API, which is unreliable in
// this WebView — the same reason every other drag handle in SPARK avoids it.
//
// A drag has to be distinguishable from a click, or reordering would break
// simply selecting a tab. Nothing happens until the pointer has moved a few
// pixels; below that it is still a click.

const DRAG_THRESHOLD = 4;

function initDrag(){
  tabs.forEach(t => t.addEventListener('mousedown', e => startDrag(e, t)));
}

function startDrag(e, tab){
  if(e.button !== 0) return;
  const startY = e.clientY;
  let dragging = false;
  let lastTarget = null;

  const clearMarks = () => {
    tabs.forEach(x => x.classList.remove('drop-before','drop-after'));
  };

  const move = ev => {
    if(!dragging){
      if(Math.abs(ev.clientY - startY) < DRAG_THRESHOLD) return;
      dragging = true;
      tab.classList.add('dragging');
      document.body.classList.add('tab-dragging');
    }
    ev.preventDefault();

    // Which row is the pointer over, and which half of it.
    const over = tabs.find(x => {
      if(x === tab) return false;
      const r = x.getBoundingClientRect();
      return ev.clientY >= r.top && ev.clientY <= r.bottom;
    });
    clearMarks();
    lastTarget = null;
    if(!over) return;
    const r = over.getBoundingClientRect();
    const after = ev.clientY > r.top + r.height / 2;
    over.classList.add(after ? 'drop-after' : 'drop-before');
    lastTarget = { el: over, after };
  };

  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    document.body.classList.remove('tab-dragging');
    tab.classList.remove('dragging');
    clearMarks();

    if(!dragging) return;      // it was a plain click; the click handler runs
    if(!lastTarget) return;

    if(lastTarget.after) lastTarget.el.after(tab);
    else                 lastTarget.el.before(tab);

    // Re-read from the DOM rather than splicing the array by hand: the DOM is
    // what the user just rearranged, so it is the source of truth.
    tabs = [...bar.querySelectorAll('.tab')];
    saveLayout();
  };

  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

// Offered in Settings, for when a drag has left things in a mess.
export function resetTabOrder(){
  delete store.settings.tabOrder;
  invoke('save_app_settings', { data: store.settings }).catch(()=>{});
  window.location.reload();
}

// ── Ctrl+K switcher ──────────────────────────────────────────────────────────

let jumpMatches = [];
let jumpSel = 0;

// Subsequence match, so "sr" finds Song Request and "bc" finds Broadcast
// without needing the letters adjacent.
function fuzzy(needle, hay){
  const n = needle.toLowerCase(), h = hay.toLowerCase();
  if(!n) return true;
  let i = 0;
  for(const ch of h){ if(ch === n[i]) i++; if(i === n.length) return true; }
  return false;
}

function renderJump(){
  if(!jumpList) return;
  const q = (jumpInput.value || '').trim();
  jumpMatches = tabs.filter(t => fuzzy(q, tabLabel(t)));
  if(jumpSel >= jumpMatches.length) jumpSel = 0;

  if(!jumpMatches.length){
    jumpList.innerHTML = '<div class="tj-empty">Nothing matches that.</div>';
    return;
  }
  jumpList.innerHTML = '';
  jumpMatches.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'tj-item' + (i === jumpSel ? ' sel' : '');
    const svg = t.querySelector('svg');
    if(svg) row.appendChild(svg.cloneNode(true));
    row.appendChild(document.createTextNode(tabLabel(t)));
    row.addEventListener('mouseenter', () => { jumpSel = i; paintJumpSel(); });
    row.addEventListener('click', () => selectTab(t.dataset.tab));
    jumpList.appendChild(row);
  });
}

// Only the highlight moves on arrow keys, so the list is not rebuilt per press.
function paintJumpSel(){
  if(!jumpList) return;
  [...jumpList.children].forEach((el, i) => el.classList.toggle('sel', i === jumpSel));
  const cur = jumpList.children[jumpSel];
  if(cur && cur.scrollIntoView) cur.scrollIntoView({ block:'nearest' });
}

function openJump(){
  if(!jump) return;
  jump.classList.add('open');
  jumpInput.value = '';
  jumpSel = 0;
  renderJump();
  jumpInput.focus();
}

function closeJump(){
  if(jump) jump.classList.remove('open');
}

function initJump(){
  if(!jump) return;

  jumpInput.addEventListener('input', () => { jumpSel = 0; renderJump(); });

  jumpInput.addEventListener('keydown', e => {
    if(e.key === 'ArrowDown'){ e.preventDefault(); jumpSel = Math.min(jumpSel+1, jumpMatches.length-1); paintJumpSel(); }
    else if(e.key === 'ArrowUp'){ e.preventDefault(); jumpSel = Math.max(jumpSel-1, 0); paintJumpSel(); }
    else if(e.key === 'Enter'){
      e.preventDefault();
      const t = jumpMatches[jumpSel];
      if(t) selectTab(t.dataset.tab);
    }
    else if(e.key === 'Escape'){ e.preventDefault(); closeJump(); }
  });

  // Clicking the backdrop closes; clicking the box does not.
  jump.addEventListener('mousedown', e => { if(e.target === jump) closeJump(); });

  document.addEventListener('keydown', e => {
    if((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')){
      e.preventDefault();
      jump.classList.contains('open') ? closeJump() : openJump();
      return;
    }
    // Escape closes it from anywhere, not only while the input has focus.
    if(e.key === 'Escape' && jump.classList.contains('open')) closeJump();
  });
}

// ── Disabled banner ─────────────────────────────────────────────────────────

export function refreshDisabledBanner(){
  if(!banner) return;
  const id = activeTabId();

  // Only the command/redeem tools have a toggle. Chat, Credits, D.I.Y,
  // Broadcast and Settings are always on and never show the strip.
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
  bar         = document.getElementById('tabs');
  collapseBtn = document.getElementById('sideCollapse');
  banner      = document.getElementById('tabDisabledBanner');
  bannerMsg   = banner ? banner.querySelector('.msg') : null;
  bannerBtn   = document.getElementById('tabDisabledBannerOn');
  jump        = document.getElementById('tabJump');
  jumpInput   = document.getElementById('tabJumpInput');
  jumpList    = document.getElementById('tabJumpList');
  if(!bar) return;

  tabs = [...bar.querySelectorAll('.tab')];
  tabs.forEach(t => t.addEventListener('click', () => selectTab(t.dataset.tab)));

  bannerBtn?.addEventListener('click', turnActiveToolOn);
  collapseBtn?.addEventListener('click', toggleCollapsed);

  initDrag();
  initJump();
  refreshDisabledBanner();
}

// Order and collapsed state come from settings, which is not loaded when
// initTabChrome() runs (that happens before the data file is read, so the tab
// row exists from the first paint). app.js calls this once the store is filled.
export function applySavedTabLayout(){
  if(!bar) return;
  applySavedOrder();
  applyCollapsed(store.settings && store.settings.sideCollapsed);
}
