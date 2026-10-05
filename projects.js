// ─────────────────────────────────────────────────────────────
// Project picker - lists every project in the database and links
// into index.html?project=<id> for the one the person picks.
// Load order: config.js (defines SYNC_API_BASE, REGIONS), then this file.
// ─────────────────────────────────────────────────────────────

let allProjects = [];
let searchQuery = '';
let activeRegion = '';   // '' = all regions; resets on every page load
let statusFilter = 'active';   // 'active' | 'archived'; resets to active on every page load
const UNSPECIFIED = 'Unspecified';

// Which side of each project this session is working with - chosen at
// login (see login.js) and stored alongside the email. Projects
// themselves are shared between sides; only the device counts here,
// and everything inside a project, are scoped by it. Anything
// unrecognized falls back to AV, the original and default side.
function currentDeviceType(){
  try{
    return sessionStorage.getItem('pd_device_type') === 'lc' ? 'lc' : 'av';
  }catch(e){ return 'av'; }
}
const DEVICE_TYPE = currentDeviceType();
const DEVICE_TYPE_LABEL = DEVICE_TYPE === 'lc' ? 'LC' : 'AV';

function syncConfigured(){
  return typeof SYNC_API_BASE !== 'undefined' && SYNC_API_BASE && SYNC_API_BASE.indexOf('REPLACE-WITH') === -1;
}

function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
  });
}

function matchesSearch(text){
  if(!searchQuery) return true;
  return String(text || '').toLowerCase().indexOf(searchQuery.toLowerCase()) !== -1;
}

// Defensive against every falsy-ish region value a project might have -
// real null, JS undefined, or (seen in the wild) the literal string
// "undefined" coming back from an older row that predates this column.
// Anything that isn't a real region name from REGIONS collapses to the
// same "Unspecified" bucket instead of leaking a raw value into the UI.
function projectRegion(p){
  const r = p.region;
  if(!r || r === 'undefined' || r === 'null') return UNSPECIFIED;
  return r;
}

// Dropdown options: every region in REGIONS (config.js), in that fixed
// order, plus "Unspecified" at the end if any project actually falls
// into that bucket. Regions with zero projects still show - an empty
// region is a real state worth seeing, not something to hide.
function regionsForFilter(){
  const list = (typeof REGIONS !== 'undefined' ? REGIONS.slice() : []);
  if(allProjects.some(function(p){ return projectRegion(p) === UNSPECIFIED; })) list.push(UNSPECIFIED);
  return list;
}

function renderRegionFilter(){
  const select = document.getElementById('regionFilter');
  if(!select) return;
  const regions = regionsForFilter();
  select.innerHTML = '<option value="">All regions</option>' +
    regions.map(function(r){
      return '<option value="' + esc(r) + '"' + (activeRegion===r?' selected':'') + '>' + esc(r) + '</option>';
    }).join('');
}

// Counts reflect every project this account can see (matching the
// server's email-based filtering already applied to allProjects),
// independent of search/region - so the tab counts don't shift around
// confusingly while someone's mid-search, the same way an inbox's
// unread count doesn't change while you're searching your email.
function renderStatusFilterButtons(){
  const activeCount = allProjects.filter(function(p){ return !p.archived; }).length;
  const archivedCount = allProjects.filter(function(p){ return p.archived; }).length;
  const activeBtn = document.querySelector('[data-status-filter="active"]');
  const archivedBtn = document.querySelector('[data-status-filter="archived"]');
  if(activeBtn){
    activeBtn.textContent = 'Active (' + activeCount + ')';
    activeBtn.classList.toggle('project-filter-button-active', statusFilter === 'active');
  }
  if(archivedBtn){
    archivedBtn.textContent = 'Archived (' + archivedCount + ')';
    archivedBtn.classList.toggle('project-filter-button-active', statusFilter === 'archived');
  }
}

document.addEventListener('DOMContentLoaded', function(){
  const select = document.getElementById('regionFilter');
  if(select){
    select.addEventListener('change', function(e){
      activeRegion = e.target.value;
      render();
    });
  }
  document.querySelectorAll('[data-status-filter]').forEach(function(btn){
    btn.addEventListener('click', function(){
      statusFilter = btn.getAttribute('data-status-filter');
      renderStatusFilterButtons();
      render();
    });
  });
});

function render(){
  const content = document.getElementById('content');

  if(!syncConfigured()){
    content.innerHTML = '<div class="empty" style="padding:60px 20px;">'
      + '<div style="font-weight:800;font-size:16px;margin-bottom:6px;color:var(--ink);">Not connected</div>'
      + '<div>SYNC_API_BASE is not set in config.js, so there\'s no server to list projects from. See README.md.</div>'
      + '</div>';
    return;
  }

  let list = allProjects;
  list = list.filter(function(p){ return statusFilter === 'archived' ? !!p.archived : !p.archived; });
  if(searchQuery.trim()){
    list = list.filter(function(p){ return matchesSearch(p.name) || matchesSearch(p.shortName); });
  }
  if(activeRegion){
    list = list.filter(function(p){ return projectRegion(p) === activeRegion; });
  }

  if(!list.length){
    content.innerHTML = '<div class="empty" style="padding:60px 20px;">'
      + '<div style="font-weight:800;font-size:16px;margin-bottom:6px;color:var(--ink);">'
      + (allProjects.length ? 'No projects match your filters.' : 'No ' + DEVICE_TYPE_LABEL + ' projects yet')
      + '</div>'
      + (allProjects.length ? '' : '<div>A project shows up here once an ' + DEVICE_TYPE_LABEL + ' Info Sheet has been uploaded for it and, if the project is restricted, you have been given its ' + DEVICE_TYPE_LABEL + ' side. Ask an admin to upload one or grant you access from the <a href="admin.html" style="color:var(--accent);font-weight:700;">admin panel</a>.</div>')
      + '</div>';
    return;
  }

  const byRegion = {};
  list.forEach(function(p){
    const r = projectRegion(p);
    if(!byRegion[r]) byRegion[r] = [];
    byRegion[r].push(p);
  });

  function cardHtml(p){
    return '<a class="loc-card" href="index.html?project=' + encodeURIComponent(p.id) + '&type=' + DEVICE_TYPE + '" style="text-decoration:none;display:block;">'
      + '<div class="name">' + esc(p.name) + '</div>'
      + '<div class="meta">' + esc(p.shortName || '') + (p.shortName ? ' &middot; ' : '') + p.deviceCount + ' device' + (p.deviceCount===1?'':'s') + '</div>'
      + '</a>';
  }

  // One region selected (via dropdown, or only one region present after
  // search) → skip the heading entirely, it'd just repeat what's already
  // selected. Otherwise, a bold loc-header per region - reusing the same
  // h2 + meta styling as the location-detail page, so it reads as an
  // actual section heading rather than the small uppercase project-count
  // label used elsewhere on this page.
  const regionKeys = Object.keys(byRegion);
  let html = '';
  if(regionKeys.length <= 1){
    html += '<div class="section-label">' + list.length + ' project' + (list.length===1?'':'s') + '</div>';
    html += '<div class="loc-grid">' + list.map(cardHtml).join('') + '</div>';
  } else {
    const orderedRegions = (typeof REGIONS !== 'undefined' ? REGIONS.slice() : []).concat([UNSPECIFIED])
      .filter(function(r){ return byRegion[r]; });
    orderedRegions.forEach(function(r, idx){
      const projs = byRegion[r];
      html += '<div class="loc-header"' + (idx===0 ? '' : ' style="margin-top:26px;"') + '>'
        + '<h2>' + esc(r) + '</h2>'
        + '<div class="meta">' + projs.length + ' project' + (projs.length===1?'':'s') + '</div>'
        + '</div>';
      html += '<div class="loc-grid">' + projs.map(cardHtml).join('') + '</div>';
    });
  }
  content.innerHTML = html;
}

//The list is kept on the device after every successful load, so it can still be shown
//with no connection (for the same emails, whats visible depends on who is asking).
function listCacheKey(){ return 'pd_projects_cache' + DEVICE_TYPE; }
function saveListCache(email){
  try{ localStorage.setItem(listCacheKey(), JSON.stringify({email: email, savedAt: new Date().toISOString(), projects: allProjects})); }catch(e){}
}
function readListCache(email){
  try{
    const c = JSON.parse(localStorage.getItem(listCacheKey()) || 'null');
    return ( c && c.email ===email && Array.isArray(c.projects)) ? c : null;
  }catch(e){ return null; }
}

async function loadProjects(){
  const content = document.getElementById('content');
  content.innerHTML = '<div class="empty" style="padding:60px 20px;">Loading projects&hellip;</div>';
  const email = (sessionStorage.getItem('pd_user_email') || '').trim();
  let fromCache = null, loadedOk = false;
  try{
    const url = SYNC_API_BASE.replace(/\/$/, '') + '/api/projects?email=' + encodeURIComponent(email) + '&deviceType=' + DEVICE_TYPE;
//On a weak connection, give up after a few seconds and use the saved list rather than waiting.
    const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = ctl ? setTimeout(function(){ ctl.abort(); }, 8000) : null;
    let res;
    try{ res = await fetch(url, ctl ? {signal: ctl.signal} : undefined); } finally { if(timer) clearTimeout(timer); }
    if(!res.ok) throw new Error('Request failed (' + res.status + ')');
    const data = await res.json();
    allProjects = data.projects || [];
    loadedOk = true;
    saveListCache(email);
  }catch(e){
    console.error(e);
    fromCache = readListCache(email);
    if(fromCache) allProjects = fromCache.projects;
  }
  renderListNote(fromCache);
  if(!loadedOk && !fromCache){
    content.innerHTML = '<div class="empty" style="padding:60px 20px;">'
      + '<div style="font-weight:800;font-size:16px;margin-bottom:6px;color:var(--ink);">Couldn\'t load the project list</div>'
      + '<div>Check your connection and try reloading the page.</div>'
      + '</div>';
      return;
  }
  renderRegionFilter();
  renderStatusFilterButtons();
  render();
}

document.getElementById('searchInput').addEventListener('input', function(e){
  searchQuery = e.target.value;
  render();
});

// Heading + the two session controls. Switching sides just flips the
// stored side and reloads - the person is already identified by email,
// so nothing is bypassed; it's the same login viewed from the other
// side. Log out clears everything (including a cached admin password,
// which would otherwise linger on a shared computer) and returns to login.
(function setupHeader(){
  const title = document.getElementById('pageTitle');
  if(title) title.textContent = DEVICE_TYPE_LABEL + ' Projects';
  document.title = DEVICE_TYPE_LABEL + ' Projects \u2014 Power Design Commissioning';

  const other = DEVICE_TYPE === 'lc' ? 'av' : 'lc';
  const switchLink = document.getElementById('switchSideLink');
  if(switchLink){
    switchLink.textContent = 'Switch to ' + other.toUpperCase();
    switchLink.addEventListener('click', function(e){
      e.preventDefault();
      try{ sessionStorage.setItem('pd_device_type', other); }catch(err){}
      window.location.reload();
    });
  }

  const logoutLink = document.getElementById('logoutLink');
  if(logoutLink){
    logoutLink.addEventListener('click', function(e){
      e.preventDefault();
      if(!confirm('Are you sure you want to log out?')) return;
      try{
        sessionStorage.removeItem('pd_user_email');
        sessionStorage.removeItem('pd_tech_name');
        sessionStorage.removeItem('pd_device_type');
        sessionStorage.removeItem('pd_admin_pw');
      }catch(err){}
      window.location.replace('login.html');
    });
  }
})();

loadProjects();

// ----------- Working Offline ----------- 
// Three things sit between the header and the list:
//   a note when the list on screen is the copy saved on this device
//   a banner for changes made offline that are still waiting to be sent
//   a button that saves every project on this device, for jobsites with no signal
function bar(id, className){
  let el = document.getElementById(id);
  if(!el){
    const content = document.getElementById('content');
    el = document.createElement('div');
    el.id = id;
    el.className = className || '';
    el.style.margin = '10px 16px 0';
    content.parentNode.insertBefore(el, content);
  }
  return el;
}
function when(iso){
  try{ return new Date(iso).toLocaleString(undefined, {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}); }catch(e){ return ''; }
}

function renderListNote(fromCache){
  const el = bar('listNote', 'offline-banner');
  el.hidden = !fromCache;
  el.innerHTML = fromCache ? '<span class="dot"></span> Offline - showing the project list saved on this device (' + esc(when(fromCache.savedAt)) + ').' : '';
}

let syncingPending = false;
function renderPendingBanner(state, detail){
  const el = bar('pendingBanner', 'offline-banner');
  const sum = window.PDOffline ? PDOffline.pendingSummary() : {list: [], total: 0};
  let msg = '';
  if(state === 'synced') msg = detail + ' change' + (detail === 1 ? '' : 's') + ' made offline ' + (detail === 1 ? 'was' : 'were') + ' sent to the server.';
  else if(sum.total && state === 'syncing') msg = 'Sending ' + sum.total + ' change' + (sum.total === 1 ? '' : 's') + ' made offline...';
  else if(sum.total) msg = sum.total + ' change' + (sum.total === 1 ? '' : 's') + ' made offline ' + (sum.total === 1 ? 'is' : 'are') + ' saved on this device, waiting to sync (' + sum.list.map(function(x){ return x.name; }).join(', ') + '). They send automatically once you are online.';
  el.hidden = !msg;
  el.innerHTML = msg ? '<span class="dot"></span> ' + esc(msg) : '';
}

// Sends changes made offline in any project - including ones that haven't been reopened.
async function sendPendingChanges(){
  if(syncingPending || !window.PDOffline || !syncConfigured()) return;
  if(!PDOffline.pendingSummary().total){ renderPendingBanner(); return; }
  syncingPending = true;
  renderPendingBanner('syncing');
  try{
    const r = await PDOffline.syncPending();
    if(!r.remaining && r.sent){ renderPendingBanner('synced', r.sent); setTimeout(function(){ renderPendingBanner(); }, 8000); }
    else renderPendingBanner();
  }catch(e){ console.error(e); renderPendingBanner(); }
  finally{ syncingPending = false; }
}

function renderSaveBar(state){
  const el = bar('offlineBar');
  el.style.cssText = 'margin:10px 16px 0;display:flex;flex-wrap:wrap;gap:10px;align-items:center;';
  const saved = window.PDOffline ? PDOffline.lastSaved() : null;
  let text = saved ? 'Saved for offline use: ' + saved.projects + ' project' + (saved.projects === 1 ? '' : 's') + ', ' + when(saved.at) + '.' : 'Not saved yet - tap before heading to a site with no signal.';
  if(state && state.text) text = state.text;
  el.innerHTML = '<button class="btn" id="saveOfflineBtn" type="button"' + (state && state.busy ? ' disabled' : '') + '>Save all projects for offline use</button>'
    + '<span class="field-hint" id="saveOfflineText" style="margin:0;">' + esc(text) + '</span>';
}

document.addEventListener('click', async function(e){
  if(!e.target.closest('#saveOfflineBtn')) return;
  const email = (sessionStorage.getItem('pd_user_email') || '').trim();
  renderSaveBar({busy: true, text: 'Saving...'});
  try{
    const r = await PDOffline.saveAll(email, function(done, total, job){
      renderSaveBar({busy: true, text: job ? 'Saving ' + (done + 1) + ' of ' + total + ': ' + job.name + ' (' + job.side.toUpperCase() + ')...' : 'Finishing...'});
    });
    if(r.failed.length) renderSaveBar({text: 'Saved ' + r.saved + ' of ' + r.total + '. Could not save: ' + r.failed.map(function(f){ return f.job.name + ' ' + f.job.side.toUpperCase() + ' (' + f.error + ')'; }).join(', ') + '.'});
    else renderSaveBar();
  }catch(err){
    console.error(err);
    renderSaveBar({text: 'No connection - connect to the internet and try again.'});
  }
});

renderSaveBar();
renderPendingBanner();
sendPendingChanges();
window.addEventListener('online', sendPendingChanges);
document.addEventListener('visibilitychange', function(){ if(document.visibilityState === 'visible') sendPendingChanges(); });
setInterval(sendPendingChanges, 15000);
