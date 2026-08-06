// ── Theme ─────────────────────────────────────────────────────────────────────
// Every theme is a block of CSS variables in index.html. Applying one is just
// setting data-theme on <html>, so nothing here needs to know any colours.
//
// The chosen theme is mirrored into localStorage purely so the tiny script in
// <head> can apply it synchronously on the very first paint. Without that there
// is a visible flash of the default purple while SPARK loads its data file.
// localStorage is the cache; settings is the source of truth.

export const THEME_KEY = 'spark_theme';

export const THEMES = [
  { id:'purple',   name:'Midnight Purple', swatch:['#1b1530','#262040','#ffc83d'] },
  { id:'ocean',    name:'Deep Ocean',      swatch:['#0f1826','#182437','#ffc83d'] },
  { id:'charcoal', name:'Charcoal',        swatch:['#16181c','#1f2227','#ffc83d'] },
  { id:'forest',   name:'Forest',          swatch:['#101c17','#182821','#ffc83d'] },
  { id:'ember',    name:'Ember',           swatch:['#1c1214','#28191c','#ffc83d'] },
  { id:'light',    name:'Light',           swatch:['#eceef2','#ffffff','#ffc83d'] },
];

export function isTheme(id){ return THEMES.some(t=>t.id===id); }

// 'purple' is the :root block itself, so it is applied by removing the
// attribute rather than setting one. That keeps the default working even if
// this module never runs.
export function applyTheme(id){
  const theme = isTheme(id) ? id : 'purple';
  const root = document.documentElement;
  if(theme==='purple') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  try{ localStorage.setItem(THEME_KEY, theme); }catch(e){}
  // Notifying listeners must never be able to undo the theme change itself, so
  // the dispatch is isolated. window.CustomEvent rather than the bare global:
  // they are the same class in the app, but not in every host.
  try{ window.dispatchEvent(new window.CustomEvent('spark-theme', { detail:{ theme } })); }catch(e){}
  return theme;
}

export function currentTheme(){
  const t = document.documentElement.getAttribute('data-theme');
  return t && isTheme(t) ? t : 'purple';
}
