// ── Fonts ─────────────────────────────────────────────────────────────────────
// One font list for the whole app. Before this, seven tabs each carried their
// own hardcoded array and they had drifted apart — Goals offered 8 fonts,
// Credits offered 36, and Timers and Check-ins were free-text boxes where a
// typo silently fell back to the browser default.
//
// Two kinds of font live here:
//   built-in — Google Fonts (plus Segoe UI, which Windows already has)
//   custom   — files the user imported, kept in %APPDATA%\com.spark.app\fonts\
//
// Custom fonts reach OVERLAYS through /fonts.css, which the overlay server
// generates from the same saved list. They reach THIS window through a <link>
// to that same stylesheet, so both sides can never disagree about what a family
// name means.

import { store } from './store.js';

const { invoke } = window.__TAURI__.core;

// Union of every list the tabs used to carry separately. Sorted, so a tab that
// previously showed 8 fonts now shows the same menu as everywhere else.
export const BUILTIN_FONTS = [
  'Abril Fatface','Anton','Archivo Black','Baloo 2','Bangers','Barlow',
  'Bebas Neue','Caveat','Cinzel','Comfortaa','Comic Neue','Cormorant Garamond',
  'Courier Prime','Creepster','Dancing Script','Fredoka','Great Vibes','Inter',
  'Kanit','Lora','Luckiest Guy','Merriweather','Montserrat','Nunito',
  'Open Sans','Orbitron','Oswald','Pacifico','Permanent Marker',
  'Playfair Display','Poppins','Press Start 2P','Quicksand','Raleway',
  'Rajdhani','Righteous','Roboto','Roboto Mono','Rubik','Russo One',
  'Segoe UI','Teko',
];

// Segoe UI ships with Windows and Google has no copy of it — asking for it
// would 400. Anything else in the list above is a real Google family.
const NOT_ON_GOOGLE = new Set(['Segoe UI']);

// ── The user's imported fonts ─────────────────────────────────────────────────
// Stored as settings.fonts = [{family, file}]. Kept in settings deliberately:
// that puts the NAMES in the backup export while leaving the files themselves
// out of it, which is what makes a restore able to tell you what is missing.

export function customFonts(){
  const list = store.settings && store.settings.fonts;
  return Array.isArray(list) ? list.filter(f => f && f.family && f.file) : [];
}

export function customFontNames(){
  return customFonts().map(f => f.family);
}

export function isCustomFont(name){
  return customFontNames().includes(name);
}

// Built-ins plus imports, imports first so a font the user went to the trouble
// of adding is not buried under forty Google families.
export function allFontNames(){
  const custom = customFontNames();
  return custom.concat(BUILTIN_FONTS.filter(f => !custom.includes(f)));
}

// ── Building dropdowns ────────────────────────────────────────────────────────
// Every font picker in the app goes through this, so adding a font anywhere
// adds it everywhere.
//
// selected      — currently saved value
// opts.blank    — label for an empty-value first option, omit for no blank row
// opts.preview  — set each option's own font-family so the menu previews itself

export function fontOptionsHtml(selected, opts){
  const o = opts || {};
  const sel = selected == null ? '' : String(selected);
  const custom = customFontNames();
  const rows = [];

  if(o.blank) rows.push(`<option value=""${sel === '' ? ' selected' : ''}>${o.blank}</option>`);

  const opt = (name, label) => {
    const style = o.preview === false ? '' : ` style="font-family:'${name.replace(/'/g,'')}'"`;
    return `<option value="${name.replace(/"/g,'&quot;')}"${style}${sel === name ? ' selected' : ''}>${label || name}</option>`;
  };

  if(custom.length){
    rows.push('<optgroup label="Your fonts">');
    custom.forEach(n => rows.push(opt(n)));
    rows.push('</optgroup>');
    rows.push('<optgroup label="Built in">');
    BUILTIN_FONTS.filter(f => !custom.includes(f)).forEach(n => rows.push(opt(n)));
    rows.push('</optgroup>');
  } else {
    BUILTIN_FONTS.forEach(n => rows.push(opt(n)));
  }

  // A value saved before this font existed — a font the user has since deleted,
  // or something typed into one of the old free-text boxes. Keep it selectable
  // so opening a tab never silently changes a setting the user had made.
  if(sel && !custom.includes(sel) && !BUILTIN_FONTS.includes(sel)){
    rows.push(`<option value="${sel.replace(/"/g,'&quot;')}" selected>${sel} (not installed)</option>`);
  }

  return rows.join('');
}

// Same list as fontOptionsHtml, as {v,l} pairs, for the tabs that build their
// selects through a shared helper instead of raw HTML. No optgroups are
// possible there, so imported fonts are marked in the label instead.
export function fontChoices(opts){
  const o = opts || {};
  const custom = customFontNames();
  const rows = [];
  if(o.blank) rows.push({ v:'', l:o.blank });
  custom.forEach(n => rows.push({ v:n, l:n + ' (yours)' }));
  BUILTIN_FONTS.filter(f => !custom.includes(f)).forEach(n => rows.push({ v:n, l:n }));
  return rows;
}

// ── Loading the fonts into this window ────────────────────────────────────────

let googleLinked = false;

// One Google stylesheet for the whole app rather than one per tab. Called on
// boot; the request is cached by the webview after the first launch.
export function loadGoogleFonts(){
  if(googleLinked) return;
  googleLinked = true;
  const families = BUILTIN_FONTS
    .filter(f => !NOT_ON_GOOGLE.has(f))
    .map(f => 'family=' + encodeURIComponent(f).replace(/%20/g, '+'))
    .join('&');
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?${families}&display=swap`;
  document.head.appendChild(link);
}

// Imported fonts come from the overlay server, which is also what serves them
// to OBS. Re-pointed (not just re-fetched) after an import so the browser
// treats it as a new request rather than reusing the response it already has.
let customLink = null;

export function refreshCustomFontCss(){
  const base = (store.overlayUrls && store.overlayUrls.master) || '';
  if(!base) return;
  const href = base.replace(/\/$/, '') + '/fonts.css?t=' + Date.now();
  if(!customLink){
    customLink = document.createElement('link');
    customLink.rel = 'stylesheet';
    document.head.appendChild(customLink);
  }
  customLink.href = href;
}

// ── Import / remove ───────────────────────────────────────────────────────────

async function persist(){
  await invoke('save_app_settings', { data: store.settings });
}

// Returns the new entry. Throws with a message worth showing the user.
export async function importFont(path, family){
  const entry = await invoke('import_font', { path, family });
  if(!Array.isArray(store.settings.fonts)) store.settings.fonts = [];
  // Re-importing under a name already in use replaces it rather than leaving
  // two entries that both claim the same family — CSS would pick one at random.
  const i = store.settings.fonts.findIndex(f => f && f.family === entry.family);
  if(i >= 0) store.settings.fonts[i] = entry;
  else store.settings.fonts.push(entry);
  await persist();
  refreshCustomFontCss();
  notifyChanged();
  return entry;
}

export async function removeFont(family){
  const list = customFonts();
  const entry = list.find(f => f.family === family);
  if(!entry) return;
  // Drop it from the list first: if the file delete fails (locked, already
  // gone), the user still gets the result they asked for and the orphan file
  // is harmless.
  store.settings.fonts = list.filter(f => f.family !== family);
  await persist();
  try{ await invoke('delete_font', { file: entry.file }); }catch(e){}
  refreshCustomFontCss();
  notifyChanged();
}

// Which saved fonts no longer have their file on disk. Backups carry the names
// but not the files, so after restoring onto another PC this is what tells the
// user which ones to re-import.
export async function missingFonts(){
  let onDisk = [];
  try{ onDisk = await invoke('list_fonts'); }catch(e){ return []; }
  const have = new Set(onDisk);
  return customFonts().filter(f => !have.has(f.file)).map(f => f.family);
}

// Tabs redraw their pickers on this rather than polling — a font imported in
// Settings should appear in the Timers dropdown without a restart.
function notifyChanged(){
  window.dispatchEvent(new CustomEvent('spark-fonts-changed'));
}

export async function initFonts(){
  loadGoogleFonts();
  refreshCustomFontCss();
}
