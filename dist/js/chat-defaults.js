// Shared chat overlay config: defaults, presets, deep-merge helper.
// Imported by both chat-tab.js (in-app, bundled) and chat.html (served over
// HTTP by the overlay server) so the two never drift out of sync.

export const GOOGLE_FONTS = [
  'Segoe UI','Roboto','Poppins','Montserrat','Oswald','Bebas Neue','Orbitron',
  'Rajdhani','Press Start 2P','Quicksand','Fredoka','Baloo 2','Comic Neue',
  'Playfair Display','Creepster','Courier Prime',
];

export const ROLE_KEYS = ['everyone','follower','subscriber','vip','moderator','broadcaster'];
export const ROLE_LABELS = {
  everyone:'Everyone', follower:'Follower', subscriber:'Subscriber', vip:'VIP', moderator:'Moderator', broadcaster:'Broadcaster',
};
export const SHAPES = ['rounded','pill','square','speech','hex','none'];
export const SHAPE_LABELS = { rounded:'Rounded', pill:'Pill', square:'Square', speech:'Speech Bubble', hex:'Hexagon', none:'None (text only)' };
export const ANIMS = ['slide','fade','pop','bounce','kawaii'];
export const ANIM_LABELS = { slide:'Slide', fade:'Fade', pop:'Pop', bounce:'Bounce', kawaii:'Wiggle' };
export const DIRS = ['bottom','top','left','right'];
export const BACKGROUNDS = ['transparent','solid','gradient','panel','image'];
export const BACKGROUND_LABELS = { transparent:'Transparent', solid:'Solid Colour', gradient:'Gradient', panel:'Blurred Panel', image:'Image' };

export function defaultCfg(){
  return {
    layout:{ bg:'transparent', bgColor:'#120c24', bgColor2:'#2a1f4d', bgOpacity:1, panelBlur:true,
      direction:'up', align:'left', maxMessages:20, autoFade:true, fadeAfter:20,
      gap:8, width:460, padding:10, animIn:'slide', animInDir:'bottom',
      showTimestamp:false, showBadgeIcons:true, showEmotes:true },
    roles:{
      everyone:    { usernameColor:'#ffc83d', textColor:'#ffffff', bgColor:'#1e1838', bgOpacity:.85, borderColor:'#3a315e', borderWidth:0, shape:'rounded', glow:false, glowColor:'#ffc83d', glowSize:14, font:'Segoe UI', fontSize:15, fontWeight:600, italic:false, badge:false, badgeIcon:'' },
      follower:    { usernameColor:'#8fb4ff', textColor:'#ffffff', bgColor:'#141c30', bgOpacity:.85, borderColor:'#8fb4ff', borderWidth:1, shape:'rounded', glow:false, glowColor:'#8fb4ff', glowSize:14, font:'Segoe UI', fontSize:15, fontWeight:600, italic:false, badge:true, badgeIcon:'🔔' },
      subscriber:  { usernameColor:'#3ddc97', textColor:'#ffffff', bgColor:'#122a20', bgOpacity:.85, borderColor:'#3ddc97', borderWidth:1, shape:'rounded', glow:false, glowColor:'#3ddc97', glowSize:14, font:'Segoe UI', fontSize:15, fontWeight:700, italic:false, badge:true, badgeIcon:'⭐' },
      vip:         { usernameColor:'#ff8fd6', textColor:'#ffffff', bgColor:'#2a1730', bgOpacity:.85, borderColor:'#ff8fd6', borderWidth:1, shape:'rounded', glow:false, glowColor:'#ff8fd6', glowSize:14, font:'Segoe UI', fontSize:15, fontWeight:700, italic:false, badge:true, badgeIcon:'💎' },
      moderator:   { usernameColor:'#4cc3ff', textColor:'#ffffff', bgColor:'#0f2233', bgOpacity:.85, borderColor:'#4cc3ff', borderWidth:1, shape:'rounded', glow:false, glowColor:'#4cc3ff', glowSize:14, font:'Segoe UI', fontSize:15, fontWeight:700, italic:false, badge:true, badgeIcon:'🛡️' },
      broadcaster: { usernameColor:'#ffc83d', textColor:'#ffffff', bgColor:'#2b1d00', bgOpacity:.9,  borderColor:'#ffc83d', borderWidth:2, shape:'rounded', glow:true,  glowColor:'#ffc83d', glowSize:18, font:'Segoe UI', fontSize:15, fontWeight:800, italic:false, badge:true, badgeIcon:'👑' },
    },
    alerts:{
      follow:{ enabled:true, text:'{name} just followed!', icon:'💜', bgColor:'#2a1750', textColor:'#ffffff', glow:true, glowColor:'#9146ff', glowSize:18, font:'Segoe UI', fontSize:16, fontWeight:800, shape:'pill', duration:6, animIn:'pop', animInDir:'bottom' },
      sub:   { enabled:true, text:'{name} just subscribed!', icon:'🎉', bgColor:'#3a2200', textColor:'#ffffff', glow:true, glowColor:'#ffc83d', glowSize:18, font:'Segoe UI', fontSize:16, fontWeight:800, shape:'pill', duration:6, animIn:'bounce', animInDir:'bottom' },
    },
  };
}

export function deepMerge(base, patch){
  if(Array.isArray(base) || typeof base !== 'object' || base===null) return patch===undefined?base:patch;
  const out = {...base};
  for(const k in (patch||{})){
    out[k] = deepMerge(base[k], patch[k]);
  }
  return out;
}

// ── Presets ─────────────────────────────────────────────────────────────────
// Each is a partial cfg deep-merged over defaultCfg(). Spans the full range
// from buttoned-up serious through plain/bland to full cutesy chaos.
export const PRESETS = {
  'Serious': {
    layout:{ bg:'solid', bgColor:'#0c1018', bgOpacity:.88, direction:'up', align:'left', animIn:'fade', showBadgeIcons:false, panelBlur:false },
    roles:{
      everyone:    { usernameColor:'#9fb0c8', textColor:'#e8edf4', bgColor:'#131a26', bgOpacity:.9, borderColor:'#2a3b52', borderWidth:0, shape:'square', glow:false, font:'Montserrat', fontWeight:600, badge:false, badgeIcon:'' },
      follower:    { usernameColor:'#b8c6d8', textColor:'#e8edf4', bgColor:'#131a26', bgOpacity:.9, borderColor:'#3a5a80', borderWidth:0, shape:'square', glow:false, font:'Montserrat', fontWeight:600, badge:false, badgeIcon:'' },
      subscriber:  { usernameColor:'#6fa8dc', textColor:'#e8edf4', bgColor:'#131a26', bgOpacity:.9, borderColor:'#3a5a80', borderWidth:1, shape:'square', glow:false, font:'Montserrat', fontWeight:700, badge:false, badgeIcon:'' },
      vip:         { usernameColor:'#8f9ec7', textColor:'#e8edf4', bgColor:'#161426', bgOpacity:.9, borderColor:'#4a4a80', borderWidth:1, shape:'square', glow:false, font:'Montserrat', fontWeight:700, badge:false, badgeIcon:'' },
      moderator:   { usernameColor:'#5fc4a0', textColor:'#e8edf4', bgColor:'#0f1f1a', bgOpacity:.9, borderColor:'#2f6b52', borderWidth:1, shape:'square', glow:false, font:'Montserrat', fontWeight:700, badge:false, badgeIcon:'' },
      broadcaster: { usernameColor:'#d4af37', textColor:'#f5f1e6', bgColor:'#1a1608', bgOpacity:.92, borderColor:'#d4af37', borderWidth:1, shape:'square', glow:false, font:'Montserrat', fontWeight:800, badge:false, badgeIcon:'' },
    },
    alerts:{
      follow:{ text:'New follower: {name}', icon:'', bgColor:'#131a26', textColor:'#e8edf4', glow:false, font:'Montserrat', fontWeight:700, shape:'square', animIn:'fade' },
      sub:   { text:'New subscriber: {name}', icon:'', bgColor:'#1a1608', textColor:'#f5f1e6', glow:false, font:'Montserrat', fontWeight:700, shape:'square', animIn:'fade' },
    },
  },
  'Bland': {
    layout:{ bg:'transparent', direction:'up', align:'left', animIn:'fade', showBadgeIcons:false, gap:4 },
    roles:{
      everyone:    { usernameColor:'#dddddd', textColor:'#ffffff', shape:'none', glow:false, font:'Segoe UI', fontWeight:400, badge:false, badgeIcon:'' },
      follower:    { usernameColor:'#eeeeee', textColor:'#ffffff', shape:'none', glow:false, font:'Segoe UI', fontWeight:400, badge:false, badgeIcon:'' },
      subscriber:  { usernameColor:'#ffffff', textColor:'#ffffff', shape:'none', glow:false, font:'Segoe UI', fontWeight:600, badge:false, badgeIcon:'' },
      vip:         { usernameColor:'#ffffff', textColor:'#ffffff', shape:'none', glow:false, font:'Segoe UI', fontWeight:600, badge:false, badgeIcon:'' },
      moderator:   { usernameColor:'#ffffff', textColor:'#ffffff', shape:'none', glow:false, font:'Segoe UI', fontWeight:600, badge:false, badgeIcon:'' },
      broadcaster: { usernameColor:'#ffffff', textColor:'#ffffff', shape:'none', glow:false, font:'Segoe UI', fontWeight:700, badge:false, badgeIcon:'' },
    },
    alerts:{
      follow:{ text:'{name} followed.', icon:'', bgColor:'transparent', textColor:'#ffffff', glow:false, font:'Segoe UI', fontWeight:600, shape:'none', animIn:'fade' },
      sub:   { text:'{name} subscribed.', icon:'', bgColor:'transparent', textColor:'#ffffff', glow:false, font:'Segoe UI', fontWeight:600, shape:'none', animIn:'fade' },
    },
  },
  'Neon Cyberpunk': {
    layout:{ bg:'panel', bgColor:'#05010f', bgOpacity:.5, panelBlur:true, direction:'up', align:'left', animIn:'slide', animInDir:'right', showBadgeIcons:true },
    roles:{
      everyone:    { usernameColor:'#00eaff', textColor:'#e8ffff', bgColor:'#0a0018', bgOpacity:.75, borderColor:'#00eaff', borderWidth:1, shape:'pill', glow:true, glowColor:'#00eaff', glowSize:10, font:'Rajdhani', fontWeight:600, badge:false, badgeIcon:'' },
      follower:    { usernameColor:'#5ce1ff', textColor:'#e8ffff', bgColor:'#040c18', bgOpacity:.76, borderColor:'#5ce1ff', borderWidth:1, shape:'pill', glow:true, glowColor:'#5ce1ff', glowSize:12, font:'Rajdhani', fontWeight:600, badge:true, badgeIcon:'▽' },
      subscriber:  { usernameColor:'#39ff14', textColor:'#eaffea', bgColor:'#04140a', bgOpacity:.78, borderColor:'#39ff14', borderWidth:1, shape:'pill', glow:true, glowColor:'#39ff14', glowSize:14, font:'Rajdhani', fontWeight:700, badge:true, badgeIcon:'◆' },
      vip:         { usernameColor:'#ff2bd6', textColor:'#ffe9fb', bgColor:'#180014', bgOpacity:.78, borderColor:'#ff2bd6', borderWidth:1, shape:'pill', glow:true, glowColor:'#ff2bd6', glowSize:14, font:'Rajdhani', fontWeight:700, badge:true, badgeIcon:'▲' },
      moderator:   { usernameColor:'#7d5cff', textColor:'#f0edff', bgColor:'#0e0620', bgOpacity:.78, borderColor:'#7d5cff', borderWidth:1, shape:'pill', glow:true, glowColor:'#7d5cff', glowSize:14, font:'Rajdhani', fontWeight:700, badge:true, badgeIcon:'■' },
      broadcaster: { usernameColor:'#fff700', textColor:'#fffde0', bgColor:'#1a1400', bgOpacity:.82, borderColor:'#fff700', borderWidth:2, shape:'pill', glow:true, glowColor:'#fff700', glowSize:20, font:'Orbitron', fontWeight:800, badge:true, badgeIcon:'★' },
    },
    alerts:{
      follow:{ text:'>> {name} connected <<', icon:'⚡', bgColor:'#0a0018', textColor:'#00eaff', glow:true, glowColor:'#00eaff', glowSize:20, font:'Orbitron', fontWeight:700, shape:'pill', animIn:'slide', animInDir:'right' },
      sub:   { text:'>> {name} upgraded <<', icon:'⚡', bgColor:'#180014', textColor:'#ff2bd6', glow:true, glowColor:'#ff2bd6', glowSize:20, font:'Orbitron', fontWeight:700, shape:'pill', animIn:'slide', animInDir:'right' },
    },
  },
  'Retro Arcade': {
    layout:{ bg:'solid', bgColor:'#1a0d2e', bgOpacity:.9, direction:'up', align:'left', animIn:'bounce', showBadgeIcons:true },
    roles:{
      everyone:    { usernameColor:'#ffffff', textColor:'#f0f0f0', bgColor:'#241442', bgOpacity:.92, borderColor:'#ffffff', borderWidth:2, shape:'square', glow:false, font:'Press Start 2P', fontSize:11, fontWeight:400, badge:false, badgeIcon:'' },
      follower:    { usernameColor:'#8fd6ff', textColor:'#f0f0f0', bgColor:'#0f1e32', bgOpacity:.92, borderColor:'#8fd6ff', borderWidth:2, shape:'square', glow:false, font:'Press Start 2P', fontSize:11, badge:true, badgeIcon:'▶' },
      subscriber:  { usernameColor:'#3ddc97', textColor:'#f0f0f0', bgColor:'#0f2a1c', bgOpacity:.92, borderColor:'#3ddc97', borderWidth:2, shape:'square', glow:false, font:'Press Start 2P', fontSize:11, badge:true, badgeIcon:'★' },
      vip:         { usernameColor:'#ff5d9e', textColor:'#f0f0f0', bgColor:'#2a0f22', bgOpacity:.92, borderColor:'#ff5d9e', borderWidth:2, shape:'square', glow:false, font:'Press Start 2P', fontSize:11, badge:true, badgeIcon:'♦' },
      moderator:   { usernameColor:'#4cc3ff', textColor:'#f0f0f0', bgColor:'#0f1e2a', bgOpacity:.92, borderColor:'#4cc3ff', borderWidth:2, shape:'square', glow:false, font:'Press Start 2P', fontSize:11, badge:true, badgeIcon:'▲' },
      broadcaster: { usernameColor:'#ffc83d', textColor:'#fff7e0', bgColor:'#2a1d00', bgOpacity:.95, borderColor:'#ffc83d', borderWidth:3, shape:'square', glow:true, glowColor:'#ffc83d', glowSize:10, font:'Press Start 2P', fontSize:11, badge:true, badgeIcon:'♛' },
    },
    alerts:{
      follow:{ text:'{name} JOINED THE GAME', icon:'🕹️', bgColor:'#241442', textColor:'#ffffff', glow:true, glowColor:'#ffffff', glowSize:8, font:'Press Start 2P', fontSize:12, shape:'square', animIn:'bounce' },
      sub:   { text:'{name} LEVELED UP', icon:'⭐', bgColor:'#2a1d00', textColor:'#ffc83d', glow:true, glowColor:'#ffc83d', glowSize:10, font:'Press Start 2P', fontSize:12, shape:'square', animIn:'bounce' },
    },
  },
  'Elegant Gold': {
    layout:{ bg:'gradient', bgColor:'#1a0e05', bgColor2:'#2e1608', bgOpacity:.55, panelBlur:true, direction:'up', align:'left', animIn:'fade' },
    roles:{
      everyone:    { usernameColor:'#d4af37', textColor:'#f5ead0', bgColor:'#170f06', bgOpacity:.8, borderColor:'#7a5a24', borderWidth:1, shape:'rounded', glow:false, font:'Playfair Display', fontWeight:600, badge:false, badgeIcon:'' },
      follower:    { usernameColor:'#c9b98a', textColor:'#f5ead0', bgColor:'#191206', bgOpacity:.82, borderColor:'#9a8552', borderWidth:1, shape:'rounded', glow:false, font:'Playfair Display', fontWeight:600, badge:true, badgeIcon:'❁' },
      subscriber:  { usernameColor:'#e8c766', textColor:'#f5ead0', bgColor:'#1c1408', bgOpacity:.82, borderColor:'#d4af37', borderWidth:1, shape:'rounded', glow:false, font:'Playfair Display', fontWeight:700, badge:true, badgeIcon:'✦' },
      vip:         { usernameColor:'#f0d98c', textColor:'#f5ead0', bgColor:'#1c1408', bgOpacity:.82, borderColor:'#e8c766', borderWidth:1, shape:'rounded', glow:false, font:'Playfair Display', fontWeight:700, badge:true, badgeIcon:'❖' },
      moderator:   { usernameColor:'#cfe0d4', textColor:'#f5ead0', bgColor:'#141c17', bgOpacity:.82, borderColor:'#7fae8f', borderWidth:1, shape:'rounded', glow:false, font:'Playfair Display', fontWeight:700, badge:true, badgeIcon:'⚜' },
      broadcaster: { usernameColor:'#ffe58a', textColor:'#fff7e0', bgColor:'#231604', bgOpacity:.9, borderColor:'#ffd76a', borderWidth:2, shape:'rounded', glow:true, glowColor:'#ffd76a', glowSize:16, font:'Playfair Display', fontWeight:800, badge:true, badgeIcon:'♛' },
    },
    alerts:{
      follow:{ text:'{name} has joined the court', icon:'✦', bgColor:'#1c1408', textColor:'#e8c766', glow:true, glowColor:'#d4af37', glowSize:16, font:'Playfair Display', fontWeight:700, shape:'rounded', animIn:'fade' },
      sub:   { text:'{name} has pledged their support', icon:'♛', bgColor:'#231604', textColor:'#ffe58a', glow:true, glowColor:'#ffd76a', glowSize:18, font:'Playfair Display', fontWeight:800, shape:'rounded', animIn:'fade' },
    },
  },
  'Spooky': {
    layout:{ bg:'panel', bgColor:'#050208', bgOpacity:.55, panelBlur:true, direction:'up', align:'left', animIn:'pop' },
    roles:{
      everyone:    { usernameColor:'#c9a4ff', textColor:'#e8e0f5', bgColor:'#0d0714', bgOpacity:.85, borderColor:'#5a3a8a', borderWidth:1, shape:'speech', glow:false, font:'Courier Prime', fontWeight:600, badge:false, badgeIcon:'' },
      follower:    { usernameColor:'#a4d4ff', textColor:'#e0f0ff', bgColor:'#04101c', bgOpacity:.85, borderColor:'#5a8aff', borderWidth:1, shape:'speech', glow:false, font:'Courier Prime', fontWeight:600, badge:true, badgeIcon:'👁️' },
      subscriber:  { usernameColor:'#ff8a2b', textColor:'#fff0e0', bgColor:'#170a02', bgOpacity:.88, borderColor:'#ff8a2b', borderWidth:1, shape:'speech', glow:true, glowColor:'#ff8a2b', glowSize:12, font:'Courier Prime', fontWeight:700, badge:true, badgeIcon:'🎃' },
      vip:         { usernameColor:'#39ff88', textColor:'#e5ffe9', bgColor:'#031707', bgOpacity:.88, borderColor:'#39ff88', borderWidth:1, shape:'speech', glow:true, glowColor:'#39ff88', glowSize:12, font:'Courier Prime', fontWeight:700, badge:true, badgeIcon:'🕷️' },
      moderator:   { usernameColor:'#9d7bff', textColor:'#eee5ff', bgColor:'#0d0518', bgOpacity:.88, borderColor:'#9d7bff', borderWidth:1, shape:'speech', glow:true, glowColor:'#9d7bff', glowSize:12, font:'Courier Prime', fontWeight:700, badge:true, badgeIcon:'🦇' },
      broadcaster: { usernameColor:'#ff3b3b', textColor:'#ffe0e0', bgColor:'#170202', bgOpacity:.92, borderColor:'#ff3b3b', borderWidth:2, shape:'speech', glow:true, glowColor:'#ff3b3b', glowSize:18, font:'Creepster', fontSize:18, fontWeight:400, badge:true, badgeIcon:'👻' },
    },
    alerts:{
      follow:{ text:'{name} entered the crypt', icon:'🦇', bgColor:'#0d0714', textColor:'#c9a4ff', glow:true, glowColor:'#9d7bff', glowSize:18, font:'Creepster', fontSize:18, shape:'speech', animIn:'pop' },
      sub:   { text:'{name} joined the coven', icon:'🎃', bgColor:'#170202', textColor:'#ff8a2b', glow:true, glowColor:'#ff3b3b', glowSize:20, font:'Creepster', fontSize:18, shape:'speech', animIn:'pop' },
    },
  },
  'Cutesy': {
    layout:{ bg:'panel', bgColor:'#ffd6ec', bgOpacity:.35, panelBlur:true, direction:'up', align:'left', animIn:'kawaii', gap:10 },
    roles:{
      everyone:    { usernameColor:'#ff6fb0', textColor:'#5a3350', bgColor:'#fff0f7', bgOpacity:.92, borderColor:'#ffb3d9', borderWidth:2, shape:'pill', glow:true, glowColor:'#ffb3d9', glowSize:10, font:'Fredoka', fontWeight:600, badge:true, badgeIcon:'🌸' },
      follower:    { usernameColor:'#ff8fc4', textColor:'#5a3350', bgColor:'#fff5fa', bgOpacity:.93, borderColor:'#ffc2e3', borderWidth:2, shape:'pill', glow:true, glowColor:'#ffc2e3', glowSize:12, font:'Fredoka', fontWeight:600, badge:true, badgeIcon:'💫' },
      subscriber:  { usernameColor:'#ff4fa3', textColor:'#5a2b4a', bgColor:'#ffe3f2', bgOpacity:.94, borderColor:'#ff8fd6', borderWidth:2, shape:'pill', glow:true, glowColor:'#ff8fd6', glowSize:14, font:'Fredoka', fontWeight:700, badge:true, badgeIcon:'🍬' },
      vip:         { usernameColor:'#b56fff', textColor:'#4a2b5a', bgColor:'#f2e6ff', bgOpacity:.94, borderColor:'#c99bff', borderWidth:2, shape:'pill', glow:true, glowColor:'#c99bff', glowSize:14, font:'Fredoka', fontWeight:700, badge:true, badgeIcon:'🦄' },
      moderator:   { usernameColor:'#4fc3d9', textColor:'#204a52', bgColor:'#e0f7fa', bgOpacity:.94, borderColor:'#8fe0ee', borderWidth:2, shape:'pill', glow:true, glowColor:'#8fe0ee', glowSize:14, font:'Fredoka', fontWeight:700, badge:true, badgeIcon:'🌟' },
      broadcaster: { usernameColor:'#ff9d4f', textColor:'#5a3410', bgColor:'#fff2e0', bgOpacity:.96, borderColor:'#ffc370', borderWidth:3, shape:'pill', glow:true, glowColor:'#ffc370', glowSize:18, font:'Fredoka', fontWeight:800, badge:true, badgeIcon:'👑' },
    },
    alerts:{
      follow:{ text:'{name} joined the fan club!! ✨', icon:'💖', bgColor:'#ffe3f2', textColor:'#ff4fa3', glow:true, glowColor:'#ffb3d9', glowSize:20, font:'Fredoka', fontWeight:700, shape:'pill', animIn:'kawaii' },
      sub:   { text:'{name} became a bestie!! 🎀', icon:'🎉', bgColor:'#fff2e0', textColor:'#ff9d4f', glow:true, glowColor:'#ffc370', glowSize:22, font:'Fredoka', fontWeight:800, shape:'pill', animIn:'kawaii' },
    },
  },
};

export function applyPreset(name){
  const patch = PRESETS[name];
  if(!patch) return defaultCfg();
  return deepMerge(defaultCfg(), patch);
}
