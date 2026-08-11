// Shared overlay long-poll client.
// Each overlay page imports this and registers handlers for event types.

// Imported fonts. Every overlay that polls also gets the user's custom fonts,
// so a font chosen in SPARK renders the same in OBS without each overlay page
// having to know anything about it. The stylesheet is generated per request and
// sent no-store; the font files it points at are content-hashed and cached
// hard, which is what keeps OBS from serving a stale copy.
(function attachFontCss(){
  if(typeof document === 'undefined') return;
  if(document.getElementById('spark-fonts-css')) return;
  const l = document.createElement('link');
  l.id  = 'spark-fonts-css';
  l.rel = 'stylesheet';
  l.href = '/fonts.css';
  document.head.appendChild(l);
})();

const handlers = {};
let since = 0;
let toolFilter = null; // set before calling startPolling()

export function setTool(tool){ toolFilter = tool; }

export function on(type, fn){ handlers[type] = fn; }

export function startPolling(){
  poll();
}

async function poll(){
  // master gets unfiltered; per-tool pages filter by tool name
  const toolParam = toolFilter && toolFilter !== 'master' ? '&tool=' + toolFilter : '';
  const url = '/events?since=' + since + toolParam;
  try{
    const res = await fetch(url, { cache:'no-store' });
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if(data.snapshot && since === 0 && handlers['_snapshot']){
      handlers['_snapshot'](data.snapshot);
    }
    (data.events||[]).forEach(ev=>{
      // Long-poll is at-least-once: if a response is lost client-side after the
      // server sent it, the retry re-delivers the same events. Skip anything we
      // already processed so one-shot events (wheel spins etc.) never replay.
      if(ev._id){
        if(ev._id <= since) return;
        since = ev._id;
      }
      const h = handlers[ev.type];
      if(h) h(ev);
    });
    if((!data.events || data.events.length === 0) && typeof data.latest === 'number'){
      since = Math.max(since, data.latest);
    }
    setTimeout(poll, 0);
  }catch(e){
    console.warn('overlay poll error:', e);
    setTimeout(poll, 800);
  }
}
