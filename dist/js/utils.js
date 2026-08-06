export const $ = id => document.getElementById(id);
export const esc = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

export function el(tag, cls, html=''){
  const e = document.createElement(tag);
  if(cls) e.className = cls;
  if(html) e.innerHTML = html;
  return e;
}

export function flash(btn, msg, ms=1400){
  const old = btn.textContent;
  btn.textContent = msg;
  btn.disabled = true;
  setTimeout(()=>{ btn.textContent = old; btn.disabled = false; }, ms);
}

export function fmtTime(secs){
  const s = Math.max(0, Math.floor(secs));
  const d  = Math.floor(s/86400);
  const h  = Math.floor((s%86400)/3600);
  const m  = Math.floor((s%3600)/60);
  const ss = s%60;
  if(d>0) return `${d}:${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
  if(h>0) return `${h}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
  return `${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
}

// Every tab shows its own unique URL. Master-overlay membership is configured
// in Settings (Master Overlay card), not per-tab.
export function renderOverlayBar(modeSelId, urlInputId, copyBtnId, tool, urls){
  const inp = $(urlInputId), btn = $(copyBtnId);
  if(!inp||!btn) return;
  inp.value = urls[tool]||'';
  btn.addEventListener('click', ()=>navigator.clipboard.writeText(inp.value));
}

// ── Safe diagnostic logging ───────────────────────────────────────────────────
// In-memory ring buffer mirrored to localStorage. Every function is fully
// wrapped in try/catch and 100% synchronous — it can never throw, block, or
// break anything else. If localStorage is unavailable, logging silently
// degrades to memory-only.
const LOG_KEY = 'spark_sr_logs';
const LOG_MAX = 2000;
let _logBuf = [];
let _logDirty = false;
try {
  // Preserve the previous session's log so a crash/restart doesn't lose it
  const prev = localStorage.getItem(LOG_KEY);
  if (prev) localStorage.setItem(LOG_KEY + '_prev', prev);
  localStorage.removeItem(LOG_KEY);
} catch (e) {}
try {
  setInterval(() => {
    if (!_logDirty) return;
    _logDirty = false;
    try { localStorage.setItem(LOG_KEY, _logBuf.join('\n')); } catch (e) {}
  }, 3000);
} catch (e) {}
export function slog(tag, msg) {
  try {
    const t = new Date();
    const ts = t.toTimeString().slice(0, 8) + '.' + String(t.getMilliseconds()).padStart(3, '0');
    let m = msg;
    if (typeof m !== 'string') { try { m = JSON.stringify(m); } catch (e) { m = String(m); } }
    _logBuf.push(ts + ' [' + tag + '] ' + m);
    if (_logBuf.length > LOG_MAX) _logBuf.splice(0, _logBuf.length - LOG_MAX);
    _logDirty = true;
  } catch (e) {}
}
export function slogDump() {
  try {
    let prev = '';
    try { prev = localStorage.getItem(LOG_KEY + '_prev') || ''; } catch (e) {}
    return (prev ? '===== PREVIOUS SESSION =====\n' + prev + '\n\n' : '')
      + '===== CURRENT SESSION =====\n' + _logBuf.join('\n');
  } catch (e) { return 'log dump failed'; }
}
export function slogClear() {
  try {
    _logBuf = []; _logDirty = false;
    localStorage.removeItem(LOG_KEY);
    localStorage.removeItem(LOG_KEY + '_prev');
  } catch (e) {}
}
try { slog('log', 'session start ' + new Date().toString()); } catch (e) {}

// Drag-to-reorder (mouse-based, works in Tauri WebView)
let dragSrc = null, dragGhost = null, dragOffY = 0;
export function initDrag(container, onReorder){
  container.querySelectorAll('.drag-handle').forEach(handle=>{
    handle.addEventListener('mousedown', e=>{
      e.preventDefault();
      const row = handle.closest('[data-i]');
      dragSrc = +row.dataset.i;
      dragGhost = row.cloneNode(true);
      dragGhost.style.cssText = `position:fixed;pointer-events:none;z-index:9999;width:${row.offsetWidth}px;opacity:.85;background:var(--line);border-radius:8px;padding:4px 8px;left:${row.getBoundingClientRect().left}px;`;
      dragOffY = e.clientY - row.getBoundingClientRect().top;
      dragGhost.style.top = (e.clientY - dragOffY) + 'px';
      document.body.appendChild(dragGhost);
      row.style.opacity = '0.3';
      const onMove = ev=>{
        dragGhost.style.top = (ev.clientY - dragOffY)+'px';
        container.querySelectorAll('[data-i]').forEach(r=>{
          const rect = r.getBoundingClientRect();
          r.classList.toggle('drag-over', ev.clientY>=rect.top && ev.clientY<=rect.bottom);
        });
      };
      const onUp = ev=>{
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if(dragGhost){ dragGhost.remove(); dragGhost=null; }
        container.querySelectorAll('[data-i]').forEach(r=>{ r.style.opacity=''; r.classList.remove('drag-over'); });
        let dest = null;
        container.querySelectorAll('[data-i]').forEach(r=>{
          const rect = r.getBoundingClientRect();
          if(ev.clientY>=rect.top && ev.clientY<=rect.bottom) dest = +r.dataset.i;
        });
        if(dest!==null && dest!==dragSrc) onReorder(dragSrc, dest);
        dragSrc = null;
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}
