// Registers the service worker (so the app opens with no connection) and, on an
// iPad / iPhone, explains how to install it - iOS has no install prompt.
(function(){
  if('serviceWorker' in navigator){
    window.addEventListener('load', function(){
      navigator.serviceWorker.register('sw.js').catch(function(e){ console.error('service worker', e); });
    });
  }
  // Ask the browser not to throw this site's saved data away under storage pressure.
  try{ if(navigator.storage && navigator.storage.persist) navigator.storage.persist(); }catch(e){}

  // One-time tip for iOS Safari, until the app is installed (or the tip is dismissed).
  try{
    var ua = navigator.userAgent || '';
    var isIos = /iPad|iPhone|iPod/.test(ua) || (ua.indexOf('Mac') !== -1 && navigator.maxTouchPoints > 1);
    var standalone = window.navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    var page = window.location.pathname.split('/').pop();
    if(isIos && !standalone && (page === 'projects.html' || page === 'login.html') && !localStorage.getItem('pd_install_tip_dismissed')){
      window.addEventListener('DOMContentLoaded', function(){
        var tip = document.createElement('div');
        tip.setAttribute('role', 'note');
        tip.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom, 0px));z-index:90;background:#f4f0ea;color:#17140f;border-radius:14px;padding:12px 14px;font:600 14px/1.35 system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.45);display:flex;gap:12px;align-items:flex-start;';
        tip.innerHTML = '<div style="flex:1"><b>Use this without a signal:</b> tap the Share button, then <b>Add to Home Screen</b>. Open it from the new icon, not from Safari.</div>';
        var x = document.createElement('button'); x.textContent = 'Got it'; x.type = 'button';
        x.style.cssText = 'flex:none;border:0;background:#17140f;color:#fff;border-radius:9px;padding:7px 12px;font:700 13px system-ui,sans-serif;';
        x.addEventListener('click', function(){ try{ localStorage.setItem('pd_install_tip_dismissed', '1'); }catch(e){} tip.remove(); });
        tip.appendChild(x); document.body.appendChild(tip);
      });
    }
  }catch(e){}
})();
