// Shared Credits overlay config: defaults, presets, deep-merge helper.
// Imported by both credits-tab.js (in-app, bundled) and credits.html (served
// over HTTP by the overlay server) so the two never drift out of sync.

export const SECTION_KEYS = ['mods','vips','subs','followers','viewers','special'];
export const SECTION_LABELS = {
  mods:'Moderators', vips:'VIPs', subs:'Subscribers', followers:'Followers',
  viewers:'Viewers', special:'Special Thanks',
};
// Sections that are auto-populated from chat activity (special is manual-only)
export const AUTO_SECTION_KEYS = ['mods','vips','subs','followers','viewers'];

export const GOOGLE_FONTS = [
  'Segoe UI','Roboto','Poppins','Montserrat','Oswald','Bebas Neue','Orbitron',
  'Rajdhani','Press Start 2P','Quicksand','Fredoka','Baloo 2','Comic Neue',
  'Playfair Display','Creepster','Courier Prime',
  'Cinzel','Cormorant Garamond','Great Vibes','Dancing Script','Merriweather',
  'Lora','Abril Fatface','Archivo Black','Anton','Bangers','Righteous',
  'Permanent Marker','Pacifico','Caveat','Russo One','Inter','Nunito',
  'Rubik','Barlow','Kanit','Teko',
];

export const BACKGROUNDS = ['transparent','solid','gradient'];
export const BACKGROUND_LABELS = { transparent:'Transparent', solid:'Solid Colour', gradient:'Gradient' };

export const NAME_ORDERS = ['first-chat','alpha','shuffle'];
export const NAME_ORDER_LABELS = { 'first-chat':'Order chatted', 'alpha':'Alphabetical', 'shuffle':'Shuffled each play' };

// up/down = classic full-screen vertical roll. left/right = a horizontal
// ticker band docked to the top/middle/bottom of the screen.
export const SCROLL_DIRS = ['up','down','left','right'];
export const SCROLL_DIR_LABELS = {
  up:'Upward (classic credits)', down:'Downward',
  left:'Sideways (leftward ticker)', right:'Sideways (rightward ticker)',
};
export const DOCKS = ['top','middle','bottom'];
export const DOCK_LABELS = { top:'Top of screen', middle:'Middle of screen', bottom:'Bottom of screen' };

function defaultSection(heading, order, headingColor){
  return {
    enabled: true,
    heading,
    order,
    headingColor,
    headingSize: 22,
    nameColor: '#ffffff',
    nameSize: 20,
    divider: true,
    font: null, // null = use the global layout font
    manualAdd: [], // free-text names always included in this section
  };
}

export function defaultCfg(){
  return {
    preset: 'Custom',
    customPresets: {},
    sections: {
      mods:      defaultSection('Moderators',    0, '#4cc3ff'),
      vips:      defaultSection('VIPs',           1, '#ff8fd6'),
      subs:      defaultSection('Subscribers',    2, '#3ddc97'),
      followers: defaultSection('Followers',      3, '#8fb4ff'),
      viewers:   defaultSection('Viewers',        4, '#ffc83d'),
      special:   defaultSection('Special Thanks', 5, '#ff5d73'),
    },
    // Priority order used when a chatter qualifies for multiple sections —
    // highest wins, shown once. 'viewers' is always the catch-all and isn't
    // part of this list.
    rolePriority: ['mods','vips','subs','followers'],
    excludeList: [],     // lowercased usernames never shown (bots, manual removes)
    specialThanks: [],   // free-text lines, not tied to any username
    nameOrder: 'first-chat',
    scroll: {
      direction:'up', speed:50, loop:false, fadeEdges:true, gap:10, sectionGap:56,
      dock:'bottom', bandHeight:140, // only used when direction is left/right
      autoplay:false, // auto-run once when the overlay page first loads (e.g. OBS scene switch)
    },
    layout: {
      font:'Segoe UI', width:640, align:'center',
      bg:'transparent', bgColor:'#000000', bgColor2:'#1b1530', bgOpacity:1,
      showAvatars:false, avatarSize:44,
      music:null, musicVolume:.6,
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
// Style-only patches (colours/fonts/background/scroll feel). Never touch
// enabled/heading/order/manualAdd/excludeList/specialThanks/rolePriority —
// the tab preserves those across a preset switch.
export const PRESETS = {
  'Classic Hollywood': {
    layout:{ font:'Playfair Display', bg:'solid', bgColor:'#000000', bgOpacity:1 },
    scroll:{ direction:'up', speed:45, fadeEdges:true },
    sections:{
      mods:      { headingColor:'#d4af37', nameColor:'#f5ead0' },
      vips:      { headingColor:'#d4af37', nameColor:'#f5ead0' },
      subs:      { headingColor:'#d4af37', nameColor:'#f5ead0' },
      followers: { headingColor:'#d4af37', nameColor:'#f5ead0' },
      viewers:   { headingColor:'#d4af37', nameColor:'#f5ead0' },
      special:   { headingColor:'#ffe58a', nameColor:'#f5ead0' },
    },
  },
  'Neon Cyberpunk': {
    layout:{ font:'Orbitron', bg:'gradient', bgColor:'#05010f', bgColor2:'#0a0018', bgOpacity:.9 },
    scroll:{ direction:'up', speed:60, fadeEdges:true },
    sections:{
      mods:      { headingColor:'#7d5cff', nameColor:'#e8ffff' },
      vips:      { headingColor:'#ff2bd6', nameColor:'#e8ffff' },
      subs:      { headingColor:'#39ff14', nameColor:'#e8ffff' },
      followers: { headingColor:'#5ce1ff', nameColor:'#e8ffff' },
      viewers:   { headingColor:'#00eaff', nameColor:'#e8ffff' },
      special:   { headingColor:'#fff700', nameColor:'#fffde0' },
    },
  },
  'Retro Arcade': {
    layout:{ font:'Press Start 2P', bg:'solid', bgColor:'#1a0d2e', bgOpacity:.95 },
    scroll:{ direction:'up', speed:40, fadeEdges:false },
    sections:{
      mods:      { headingColor:'#4cc3ff', nameColor:'#ffffff', headingSize:16, nameSize:14 },
      vips:      { headingColor:'#ff5d9e', nameColor:'#ffffff', headingSize:16, nameSize:14 },
      subs:      { headingColor:'#3ddc97', nameColor:'#ffffff', headingSize:16, nameSize:14 },
      followers: { headingColor:'#8fd6ff', nameColor:'#ffffff', headingSize:16, nameSize:14 },
      viewers:   { headingColor:'#ffffff', nameColor:'#ffffff', headingSize:16, nameSize:14 },
      special:   { headingColor:'#ffc83d', nameColor:'#ffffff', headingSize:16, nameSize:14 },
    },
  },
  'Bland': {
    layout:{ font:'Segoe UI', bg:'transparent' },
    scroll:{ direction:'up', speed:50, fadeEdges:false },
    sections:{
      mods:      { headingColor:'#dddddd', nameColor:'#ffffff', divider:false },
      vips:      { headingColor:'#dddddd', nameColor:'#ffffff', divider:false },
      subs:      { headingColor:'#dddddd', nameColor:'#ffffff', divider:false },
      followers: { headingColor:'#dddddd', nameColor:'#ffffff', divider:false },
      viewers:   { headingColor:'#dddddd', nameColor:'#ffffff', divider:false },
      special:   { headingColor:'#dddddd', nameColor:'#ffffff', divider:false },
    },
  },
  'Elegant Gold': {
    layout:{ font:'Cormorant Garamond', bg:'gradient', bgColor:'#1a0e05', bgColor2:'#2e1608', bgOpacity:.85 },
    scroll:{ direction:'up', speed:42, fadeEdges:true },
    sections:{
      mods:      { headingColor:'#d4af37', nameColor:'#f5ead0' },
      vips:      { headingColor:'#e8c766', nameColor:'#f5ead0' },
      subs:      { headingColor:'#f0d98c', nameColor:'#f5ead0' },
      followers: { headingColor:'#c9b98a', nameColor:'#f5ead0' },
      viewers:   { headingColor:'#d4af37', nameColor:'#f5ead0' },
      special:   { headingColor:'#ffe58a', nameColor:'#fff7e0', font:'Great Vibes', headingSize:30, nameSize:22 },
    },
  },
  'Spooky': {
    layout:{ font:'Courier Prime', bg:'solid', bgColor:'#050208', bgOpacity:.92 },
    scroll:{ direction:'up', speed:38, fadeEdges:true },
    sections:{
      mods:      { headingColor:'#9d7bff', nameColor:'#e8e0f5' },
      vips:      { headingColor:'#39ff88', nameColor:'#e5ffe9' },
      subs:      { headingColor:'#ff8a2b', nameColor:'#fff0e0' },
      followers: { headingColor:'#a4d4ff', nameColor:'#e0f0ff' },
      viewers:   { headingColor:'#c9a4ff', nameColor:'#e8e0f5' },
      special:   { headingColor:'#ff3b3b', nameColor:'#ffe0e0', font:'Creepster', headingSize:26, nameSize:20 },
    },
  },
  'Cutesy': {
    layout:{ font:'Fredoka', bg:'gradient', bgColor:'#ffd6ec', bgColor2:'#ffe8f5', bgOpacity:.3 },
    scroll:{ direction:'up', speed:48, fadeEdges:true },
    sections:{
      mods:      { headingColor:'#4fc3d9', nameColor:'#204a52' },
      vips:      { headingColor:'#b56fff', nameColor:'#4a2b5a' },
      subs:      { headingColor:'#ff4fa3', nameColor:'#5a2b4a' },
      followers: { headingColor:'#ff8fc4', nameColor:'#5a3350' },
      viewers:   { headingColor:'#ff6fb0', nameColor:'#5a3350' },
      special:   { headingColor:'#ff9d4f', nameColor:'#5a3410', font:'Pacifico', headingSize:26, nameSize:20 },
    },
  },
  'Minimal Mono': {
    layout:{ font:'Inter', bg:'transparent' },
    scroll:{ direction:'up', speed:55, fadeEdges:false, gap:6 },
    sections:{
      mods:      { headingColor:'#ffffff', nameColor:'#cfcfcf', divider:false, headingSize:16 },
      vips:      { headingColor:'#ffffff', nameColor:'#cfcfcf', divider:false, headingSize:16 },
      subs:      { headingColor:'#ffffff', nameColor:'#cfcfcf', divider:false, headingSize:16 },
      followers: { headingColor:'#ffffff', nameColor:'#cfcfcf', divider:false, headingSize:16 },
      viewers:   { headingColor:'#ffffff', nameColor:'#cfcfcf', divider:false, headingSize:16 },
      special:   { headingColor:'#ffffff', nameColor:'#cfcfcf', divider:false, headingSize:16 },
    },
  },
  'Royal Purple': {
    layout:{ font:'Cinzel', bg:'gradient', bgColor:'#0f0620', bgColor2:'#1e0d3a', bgOpacity:.85 },
    scroll:{ direction:'up', speed:44, fadeEdges:true },
    sections:{
      mods:      { headingColor:'#b98bff', nameColor:'#ede4ff' },
      vips:      { headingColor:'#ff8fd6', nameColor:'#ffe9fb' },
      subs:      { headingColor:'#8fb4ff', nameColor:'#e4edff' },
      followers: { headingColor:'#c9a4ff', nameColor:'#ede4ff' },
      viewers:   { headingColor:'#e0c8ff', nameColor:'#ede4ff' },
      special:   { headingColor:'#ffd76a', nameColor:'#fff2d0' },
    },
  },
  'Sports Broadcast': {
    layout:{ font:'Russo One', bg:'solid', bgColor:'#0a1628', bgOpacity:.92 },
    scroll:{ direction:'left', dock:'bottom', bandHeight:120, speed:90, fadeEdges:false },
    sections:{
      mods:      { headingColor:'#4cc3ff', nameColor:'#ffffff', headingSize:18, nameSize:18 },
      vips:      { headingColor:'#ffc83d', nameColor:'#ffffff', headingSize:18, nameSize:18 },
      subs:      { headingColor:'#3ddc97', nameColor:'#ffffff', headingSize:18, nameSize:18 },
      followers: { headingColor:'#ff5d73', nameColor:'#ffffff', headingSize:18, nameSize:18 },
      viewers:   { headingColor:'#ffffff', nameColor:'#ffffff', headingSize:18, nameSize:18 },
      special:   { headingColor:'#ffc83d', nameColor:'#ffffff', headingSize:18, nameSize:18 },
    },
  },
};

export function applyPreset(name){
  const patch = PRESETS[name];
  if(!patch) return defaultCfg();
  return deepMerge(defaultCfg(), patch);
}
