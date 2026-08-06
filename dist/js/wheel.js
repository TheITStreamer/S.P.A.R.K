// Shared wheel renderer — used by both the app preview and the OBS overlay so
// they always look identical. Pure canvas; no dependencies.

export const THEMES = {
  "Neon":        ['#ff5d73','#ffc83d','#3ddc97','#4cc3ff','#b285ff','#ff9f43','#ff6fb5','#7ee8a2'],
  "Pastel":      ['#ffadad','#ffd6a5','#fdffb6','#caffbf','#9bf6ff','#a0c4ff','#bdb2ff','#ffc6ff'],
  "Twitch Purple":['#9146FF','#772ce8','#bf94ff','#5c16c5','#a970ff','#e0d4ff','#7d5bbe','#c8a2ff'],
  "Ocean":       ['#05668d','#028090','#00a896','#02c39a','#48cae4','#0096c7','#0077b6','#90e0ef'],
  "Sunset":      ['#ff6b6b','#ee5253','#feca57','#ff9f43','#ff6f91','#ff9671','#ffc75f','#f9f871'],
  "Mono Gold":   ['#ffc83d','#e0a800','#fff0c2','#d4a017','#ffdb70','#c89200','#ffe9a8','#b8860b'],
};

export function defaultThemeNames(){ return Object.keys(THEMES); }

// Draw a wheel.
// ctx: 2d context, size: square px, items: [{name, weight}], colors: [hex],
// angle: rotation radians.
export function drawWheel(ctx, size, items, colors, angle){
  const c = size/2;
  const margin = Math.max(56, size*0.16);
  const r = c - margin;
  ctx.clearRect(0,0,size,size);
  if(!items || items.length === 0) return;

  ctx.beginPath(); ctx.arc(c,c,r+10,0,2*Math.PI); ctx.fillStyle = '#110d24'; ctx.fill();
  ctx.beginPath(); ctx.arc(c,c,r+10,0,2*Math.PI); ctx.strokeStyle = '#ffc83d'; ctx.lineWidth = 3; ctx.stroke();

  const tw = items.reduce((s,it)=>s+(it.weight||1),0);
  let start = angle;
  const callouts = [];
  items.forEach((item,i)=>{
    const seg = ((item.weight||1)/tw) * 2*Math.PI;
    const col = colors[i % colors.length];
    ctx.beginPath(); ctx.moveTo(c,c); ctx.arc(c,c,r,start,start+seg); ctx.closePath();
    ctx.fillStyle = col; ctx.fill();
    ctx.strokeStyle = '#110d24'; ctx.lineWidth = 2; ctx.stroke();

    let placed = false;
    let label = item.name.length > 24 ? item.name.slice(0,23)+'…' : item.name;
    const innerEdge = r*0.12 + 10;
    const maxLen = r - 14 - innerEdge;
    for(let fs = 18; fs >= 9; fs--){
      ctx.font = 'bold ' + fs + 'px Georgia';
      const w = ctx.measureText(label).width;
      if(w > maxLen) continue;
      const thickness = 2 * (r - 14 - w) * Math.tan(seg/2);
      if(fs * 1.15 <= thickness){
        ctx.save(); ctx.translate(c,c); ctx.rotate(start + seg/2);
        ctx.textAlign = 'right'; ctx.fillStyle = pickInk(col);
        ctx.fillText(label, r - 14, fs*0.35);
        ctx.restore();
        placed = true; break;
      }
    }
    if(!placed) callouts.push({ mid: start + seg/2, item, col });
    start += seg;
  });

  ctx.font = 'bold 11px Georgia';
  callouts.forEach(co=>{
    const cos = Math.cos(co.mid), sin = Math.sin(co.mid);
    const x1 = c + cos*(r+12), y1 = c + sin*(r+12);
    const x2 = c + cos*(r+26), y2 = c + sin*(r+26);
    ctx.strokeStyle = co.col; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
    const ah = 6;
    ctx.fillStyle = co.col;
    ctx.beginPath();
    ctx.moveTo(x1,y1);
    ctx.lineTo(x1 + cos*ah - sin*ah*0.7, y1 + sin*ah + cos*ah*0.7);
    ctx.lineTo(x1 + cos*ah + sin*ah*0.7, y1 + sin*ah - cos*ah*0.7);
    ctx.closePath(); ctx.fill();

    const lines = wrapLabel(co.item.name, 13, 3);
    const lineH = 13;
    let ty0 = c + sin*(r+30) + 4 - (lines.length-1)*lineH/2;
    ty0 = Math.min(Math.max(ty0, 12), size - 4 - (lines.length-1)*lineH);
    ctx.textAlign = cos >= 0 ? 'left' : 'right';
    lines.forEach((line, li)=>{
      const lw = ctx.measureText(line).width;
      let tx = c + cos*(r+30);
      tx = cos >= 0 ? Math.min(tx, size - lw - 4) : Math.max(tx, lw + 4);
      ctx.fillText(line, tx, ty0 + li*lineH);
    });
  });

  ctx.beginPath(); ctx.arc(c,c,r*0.12,0,2*Math.PI);
  ctx.fillStyle = '#ffc83d'; ctx.fill();
  ctx.strokeStyle = '#110d24'; ctx.lineWidth = 3; ctx.stroke();
}

// Given the final resting angle, which item index sits under the top pointer.
export function winningIndex(items, angle){
  const tw = items.reduce((s,it)=>s+(it.weight||1),0);
  const pointerAngle = -Math.PI/2;
  let rel = (pointerAngle - angle) % (2*Math.PI);
  if(rel < 0) rel += 2*Math.PI;
  let acc = 0;
  for(let i=0;i<items.length;i++){
    acc += ((items[i].weight||1)/tw)*2*Math.PI;
    if(rel < acc) return i;
  }
  return items.length-1;
}

// Compute a target resting angle that lands the pointer on a given index.
export function angleForIndex(items, index, randomWithin=true){
  const tw = items.reduce((s,it)=>s+(it.weight||1),0);
  let startFrac = 0;
  for(let i=0;i<index;i++) startFrac += (items[i].weight||1)/tw;
  const segFrac = (items[index].weight||1)/tw;
  const within = randomWithin ? (0.15 + Math.random()*0.7) : 0.5;
  const targetMid = (startFrac + segFrac*within) * 2*Math.PI; // position within segment from 0
  // We want: ( -PI/2 - angle ) mod 2PI  == targetMid  =>  angle = -PI/2 - targetMid
  let a = -Math.PI/2 - targetMid;
  return a;
}

export function pickInk(hex){
  // dark text on light fills, light text on dark fills
  const c = hex.replace('#','');
  const r = parseInt(c.substr(0,2),16), g = parseInt(c.substr(2,2),16), b = parseInt(c.substr(4,2),16);
  const lum = (0.299*r + 0.587*g + 0.114*b);
  return lum > 140 ? '#1b1530' : '#ffffff';
}

export function wrapLabel(name, maxChars, maxLines){
  const words = name.split(' ');
  const lines = [];
  let cur = '';
  for(let i = 0; i < words.length; i++){
    let w = words[i];
    if(w.length > maxChars) w = w.slice(0, maxChars-1) + '…';
    const test = cur ? cur + ' ' + w : w;
    if(test.length <= maxChars){ cur = test; }
    else {
      lines.push(cur); cur = w;
      if(lines.length === maxLines){
        lines[maxLines-1] = lines[maxLines-1].slice(0, maxChars-1) + '…';
        return lines;
      }
    }
  }
  if(cur) lines.push(cur);
  return lines.slice(0, maxLines);
}
