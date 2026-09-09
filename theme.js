// ─────────────────────────────────────────────────────────────
// Light/dark theme toggle — shared by index.html, projects.html, and
// admin.html. Each of those pages needs a #themeToggle button in its
// markup and a small inline script in <head> (see index.html) that
// applies the saved theme before first paint, to avoid a flash.
// ─────────────────────────────────────────────────────────────

const THEME_KEY = 'pd_theme';
const SUN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"></circle><line x1="12" y1="2" x2="12" y2="4"></line><line x1="12" y1="20" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="6.34" y2="6.34"></line><line x1="17.66" y1="17.66" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="4" y2="12"></line><line x1="20" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="6.34" y2="17.66"></line><line x1="17.66" y1="6.34" x2="19.07" y2="4.93"></line></svg>';
const MOON_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>';

function effectiveTheme(){
  let stored = null;
  try{ stored = localStorage.getItem(THEME_KEY); }catch(e){}
  if(stored === 'light' || stored === 'dark') return stored;
  return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
}
function applyTheme(theme){
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('themeToggle');
  if(!btn) return;
  // Icon shown = the mode a click will switch you TO.
  btn.innerHTML = theme === 'dark' ? SUN_ICON : MOON_ICON;
  const label = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  btn.setAttribute('aria-label', label);
  btn.title = label;
}
document.addEventListener('DOMContentLoaded', function(){
  const btn = document.getElementById('themeToggle');
  if(btn){
    btn.addEventListener('click', function(){
      const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
      try{ localStorage.setItem(THEME_KEY, next); }catch(e){}
      applyTheme(next);
    });
  }
  applyTheme(effectiveTheme());
});
