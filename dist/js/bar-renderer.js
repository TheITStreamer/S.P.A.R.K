// Bar renderer.
// Theme applies to the entire container (bg, border, text, fill).
// Text outside: label + value sit in a header row above/beside the track.
// Text inside: label + value drawn over the track area.
// Vertical bars are drawn natively on a portrait canvas (w=narrow, h=tall).

export function drawGoalBar(ctx, w, h, bar) {
  const ms  = bar.milestones?.[bar.currentMilestone] || { target:100, label:'' };
  const pct = Math.min(1, (bar.current||0) / (ms.target||1));
  const isV = bar.orientation === 'v';

  ctx.clearRect(0,0,w,h);

  // ── Theme colours ──────────────────────────────────────────────────────────
  const bgCol     = bar.bgColor     || '#1a1230';
  const borderCol = bar.borderColor || '#3a315e';
  const fillCol   = bar.fillColor   || '#ffc83d';
  const fill2Col  = bar.fillColor2  || '#ff9f43';
  const textCol   = bar.textColor   || '#ffffff';
  const font      = bar.font        || 'Segoe UI';

  // ── Container ──────────────────────────────────────────────────────────────
  const cr = Math.min(12, Math.min(w,h)*0.18);
  ctx.fillStyle = bgCol;
  rr(ctx,0,0,w,h,cr); ctx.fill();
  ctx.strokeStyle = borderCol;
  ctx.lineWidth = 2;
  rr(ctx,0,0,w,h,cr); ctx.stroke();

  if (isV) drawV(ctx,w,h,pct,bar,ms,fillCol,fill2Col,textCol,borderCol,font);
  else      drawH(ctx,w,h,pct,bar,ms,fillCol,fill2Col,textCol,font);
}

// ── HORIZONTAL ────────────────────────────────────────────────────────────────
function drawH(ctx,w,h,pct,bar,ms,fc,fc2,tc,font) {
  const outside = bar.textOutside !== false;
  const pad = 10;

  if (outside) {
    // Header: label left, value right  (top 40% of height)
    const headerH = Math.round(h * 0.42);
    const trackH  = Math.max(8, h - headerH - pad * 1.5);
    const trackY  = headerH;
    const trackX  = pad;
    const trackW  = w - pad*2;

    if (bar.showLabel && bar.name) {
      const fs = clamp(headerH*0.55, 9, 18);
      ctx.font = `700 ${fs}px '${font}',sans-serif`;
      ctx.fillStyle = tc;
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(bar.name.toUpperCase(), pad, headerH/2);
    }
    const val = buildVal(bar,ms,pct);
    if (val) {
      const fs = clamp(headerH*0.45, 8, 15);
      ctx.font = `600 ${fs}px '${font}',sans-serif`;
      ctx.fillStyle = rgba(tc, 0.65);
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(val, w-pad, headerH/2);
    }
    drawTrackH(ctx, trackX, trackY, trackW, trackH, pct, bar, fc, fc2);

  } else {
    // Text inside the bar container
    const trackH = Math.max(8, h - pad*2);
    const trackY = pad;
    drawTrackH(ctx, pad, trackY, w-pad*2, trackH, pct, bar, fc, fc2);
    if (bar.showLabel && bar.name) {
      const fs = clamp(h*0.28, 9, 16);
      ctx.font = `700 ${fs}px '${font}',sans-serif`;
      ctx.fillStyle = tc;
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.shadowColor='rgba(0,0,0,0.6)'; ctx.shadowBlur=4;
      ctx.fillText(bar.name.toUpperCase(), pad+6, h/2);
      ctx.shadowBlur=0;
    }
    const val = buildVal(bar,ms,pct);
    if (val) {
      const fs = clamp(h*0.24, 8, 14);
      ctx.font = `600 ${fs}px '${font}',sans-serif`;
      ctx.fillStyle = rgba(tc, 0.8);
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.shadowColor='rgba(0,0,0,0.6)'; ctx.shadowBlur=4;
      ctx.fillText(val, w-pad-6, h/2);
      ctx.shadowBlur=0;
    }
  }
}

// ── VERTICAL ──────────────────────────────────────────────────────────────────
// Canvas is portrait: w=narrow side, h=tall side.
function drawV(ctx,w,h,pct,bar,ms,fc,fc2,tc,bc,font) {
  const outside = bar.textOutside !== false;
  const pad = 8;

  if (outside) {
    // Layout: label column on left, track column on right, value at top spanning full width
    const valH   = clamp(h * 0.1, 14, 24);
    const labelW = clamp(w * 0.42, 16, 36);
    const trackW = clamp(w * 0.3, 8, 24);
    const trackX = w - pad - trackW;
    const trackY = pad + valH + 6;
    const trackH = h - trackY - pad;

    // value at top spanning full width — keep font small enough to fit
    const val = buildVal(bar,ms,pct);
    if (val) {
      let fs = clamp(w * 0.17, 6, 12);
      ctx.font = `600 ${fs}px '${font}',sans-serif`;
      // shrink until it fits width
      while(fs > 5 && ctx.measureText(val).width > w - pad*2){ fs -= 0.5; ctx.font=`600 ${fs}px '${font}',sans-serif`; }
      ctx.fillStyle = rgba(tc, 0.7);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(val, w/2, pad + valH/2);
    }

    // fill track
    drawTrackV(ctx, trackX, trackY, trackW, trackH, pct, bar, fc, fc2);

    // label rotated on left — translate to centre of label column, rotate
    if (bar.showLabel && bar.name) {
      const availH = trackH - 8;
      let fs = clamp(w * 0.18, 7, 14);
      ctx.save();
      ctx.translate(labelW / 2, trackY + trackH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.font = `700 ${fs}px '${font}',sans-serif`;
      while(fs > 6 && ctx.measureText(bar.name.toUpperCase()).width > availH){ fs -= 0.5; ctx.font=`700 ${fs}px '${font}',sans-serif`; }
      ctx.fillStyle = tc;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(bar.name.toUpperCase(), 0, 0);
      ctx.restore();
    }

  } else {
    // Text inside: value at top, label rotated over the track
    const trackW = clamp(w*0.38, 10, 32);
    const trackX = (w-trackW)/2;
    const trackY = pad + 20;
    const trackH = h - trackY - pad - 20;

    const val = buildVal(bar,ms,pct);
    if (val) {
      const fs = clamp(w*0.18, 7, 12);
      ctx.font = `600 ${fs}px '${font}',sans-serif`;
      ctx.fillStyle = rgba(tc,0.65);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(val, w/2, pad+10);
    }

    drawTrackV(ctx, trackX, trackY, trackW, trackH, pct, bar, fc, fc2);

    if (bar.showLabel && bar.name) {
      const availH = trackH - 16;
      let fs = clamp(w*0.22, 8, 14);
      ctx.save();
      ctx.translate(w/2, trackY+trackH/2);
      ctx.rotate(-Math.PI/2);
      ctx.font = `700 ${fs}px '${font}',sans-serif`;
      while (fs > 7 && ctx.measureText(bar.name.toUpperCase()).width > availH) {
        fs -= 0.5;
        ctx.font = `700 ${fs}px '${font}',sans-serif`;
      }
      ctx.fillStyle = tc;
      ctx.shadowColor='rgba(0,0,0,0.7)'; ctx.shadowBlur=4;
      ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText(bar.name.toUpperCase(), 0, 0);
      ctx.shadowBlur=0; ctx.restore();
    }
  }
}

// ── Track helpers ─────────────────────────────────────────────────────────────
function drawTrackH(ctx, x, y, w, h, pct, bar, fc, fc2) {
  const r = Math.min(h/2, 6);
  // track bg (slightly lighter than container bg)
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  rr(ctx,x,y,w,h,r); ctx.fill();
  // fill
  if (pct > 0.001) {
    const fw = Math.max(r*2, w*pct);
    ctx.save();
    ctx.beginPath(); rr(ctx,x,y,fw,h,r); ctx.clip();
    ctx.fillStyle = fillStyle(ctx, bar, fc, fc2, x, 0, x+w, 0);
    ctx.fillRect(x,y,fw,h);
    if (bar.style==='neon') { ctx.shadowColor=fc; ctx.shadowBlur=12; ctx.fillRect(x,y,fw,h); }
    ctx.shadowBlur=0; ctx.restore();
  }
}

function drawTrackV(ctx, x, y, w, h, pct, bar, fc, fc2) {
  const r = Math.min(w/2, 6);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  rr(ctx,x,y,w,h,r); ctx.fill();
  if (pct > 0.001) {
    const fh = Math.max(r*2, h*pct);
    const fy = y+h-fh;
    ctx.save();
    ctx.beginPath(); rr(ctx,x,fy,w,fh,r); ctx.clip();
    ctx.fillStyle = fillStyle(ctx, bar, fc, fc2, x, y+h, x, y);
    ctx.fillRect(x,fy,w,fh);
    if (bar.style==='neon') { ctx.shadowColor=fc; ctx.shadowBlur=12; ctx.fillRect(x,fy,w,fh); }
    ctx.shadowBlur=0; ctx.restore();
  }
}

function fillStyle(ctx, bar, fc, fc2, x0,y0,x1,y1) {
  if (bar.style==='gradient') {
    const g=ctx.createLinearGradient(x0,y0,x1,y1);
    g.addColorStop(0,fc); g.addColorStop(1,fc2); return g;
  }
  return fc;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildVal(bar,ms,pct) {
  const p=[];
  if (bar.showCurrent) p.push(fmt(bar.current));
  if (bar.showTarget)  p.push(fmt(ms.target));
  if (bar.showPct)     p.push(Math.floor(pct*100)+'%');
  return p.join(' / ');
}
function fmt(n){ n=Math.floor(n||0); return n>=1000?(n/1000).toFixed(1)+'K':String(n); }
function clamp(v,mn,mx){ return Math.max(mn,Math.min(mx,v)); }
function rgba(hex,a){
  const c=hex.replace('#','');
  const r=parseInt(c.substr(0,2),16), g=parseInt(c.substr(2,2),16), b=parseInt(c.substr(4,2),16);
  return `rgba(${r},${g},${b},${a})`;
}
function rr(ctx,x,y,w,h,r){
  ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r);
  ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r);
  ctx.arcTo(x,y,x+w,y,r); ctx.closePath();
}
export function roundRect(ctx,x,y,w,h,r){ rr(ctx,x,y,w,h,r); }
export function loadGoogleFont(font){
  if(!font) return;
  const id='gf-'+font.replace(/\s/g,'-');
  if(document.getElementById(id)) return;
  const l=document.createElement('link');
  l.id=id; l.rel='stylesheet';
  l.href=`https://fonts.googleapis.com/css2?family=${encodeURIComponent(font)}&display=swap`;
  document.head.appendChild(l);
}
