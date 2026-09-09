// ─────────────────────────────────────────────────────────────
// RCRSB Commissioning — app logic
//
// Load order matters: devices.js and config.js must load before this
// file (they define PROJECT_DEVICES, SYNC_API_BASE, SYNC_POLL_MS which
// this file uses). See index.html <script> tags at the bottom of <body>.
// ─────────────────────────────────────────────────────────────
/* Multi-project scaffold: each project keeps its own device list and its own
   namespaced slice of the shared db (projects/<id>/checklist, projects/<id>/punch).
   Today there's one project; adding another is: extract its Info Sheet the same
   way, add a PROJECTS entry, republish. A project picker can go in the header
   later without touching anything below. */
const PROJECTS = {
  "rcrsb": {
    id: "rcrsb",
    name: "Ritz-Carlton Residences, Sarasota Bay",
    shortName: "RCRSB",
    devices: PROJECT_DEVICES
  }
};
let currentProject = Object.keys(PROJECTS)[0];
let DEVICES = PROJECTS[currentProject].devices;

const CHECKS = [
  {key:'power', label:'Power'},
  {key:'network', label:'Network'},
  {key:'function', label:'Function'}
];
const SEVERITIES = ['minor','major','critical'];

let checklist = {};   // deviceId -> {power,network,function}
let punches = [];     // {id, deviceId, deviceName, location, description, severity, status, reportedBy, createdAt, resolvedBy, resolvedAt}
let techName = localStorage.getItem('pd_tech_name') || '';
let view = 'locations';
let currentLocation = null;
let searchQuery = '';
let punchStatusFilter = 'open';
let punchLocationFilter = '';
let openPunchFormFor = null;
let pendingSeverity = 'major';
let punchDraftText = {};
let syncEnabled = false;
let pollTimer = null;

const LOCATIONS = (function(){
  const map = {};
  DEVICES.forEach(function(d){
    if(!map[d.location]) map[d.location] = [];
    map[d.location].push(d);
  });
  return Object.keys(map).sort().map(function(name){
    return {name: name, devices: map[name]};
  });
})();
const DEVICE_BY_ID = {};
DEVICES.forEach(function(d){ DEVICE_BY_ID[d.id] = d; });

function loadCache(){
  try{
    const raw = localStorage.getItem('pd_commissioning_cache_' + currentProject);
    if(raw){
      const parsed = JSON.parse(raw);
      checklist = parsed.checklist || {};
      punches = parsed.punches || [];
    }
  }catch(e){}
}
function saveCache(){
  try{
    localStorage.setItem('pd_commissioning_cache_' + currentProject, JSON.stringify({checklist:checklist, punches:punches}));
  }catch(e){}
}

function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
  });
}
function fmtTime(iso){
  if(!iso) return '';
  try{
    const d = new Date(iso);
    return d.toLocaleDateString(undefined,{month:'short',day:'numeric'}) + ' ' + d.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
  }catch(e){ return ''; }
}

function getCheck(deviceId){
  return checklist[deviceId] || {power:null, network:null, function:null};
}
function isTested(deviceId){
  const c = getCheck(deviceId);
  return c.power && c.network && c.function;
}
function hasFail(deviceId){
  const c = getCheck(deviceId);
  return c.power === 'fail' || c.network === 'fail' || c.function === 'fail';
}
function locationStats(devices){
  let tested = 0, fails = 0;
  devices.forEach(function(d){
    if(isTested(d.id)) tested++;
    if(hasFail(d.id)) fails++;
  });
  return {tested: tested, total: devices.length, fails: fails};
}
function openPunchCount(locationName){
  return punches.filter(function(p){ return p.status === 'open' && (!locationName || p.location === locationName); }).length;
}

// "Done" means fully tested AND every check passed — being fully tested
// with a failure still needs attention, so it gets its own badge instead
// of being lumped in with "done".
function locationBadgeHtml(st, openCt){
  if(openCt) return '<span class="badge open">' + openCt + ' open</span>';
  if(st.tested !== st.total) return '';
  if(st.fails) return '<span class="badge fail">' + st.fails + ' failed</span>';
  return '<span class="badge done">done</span>';
}

function overallStats(){
  let tested = 0, failCount = 0;
  DEVICES.forEach(function(d){
    if(isTested(d.id)) tested++;
    const c = getCheck(d.id);
    [c.power,c.network,c.function].forEach(function(v){ if(v==='fail') failCount++; });
  });
  const open = punches.filter(function(p){ return p.status==='open'; }).length;
  return {tested: tested, total: DEVICES.length, failChecks: failCount, open: open};
}

function renderStats(){
  const s = overallStats();
  document.getElementById('statTested').textContent = s.tested + '/' + s.total;
  document.getElementById('statBar').style.width = (s.total? (100*s.tested/s.total):0) + '%';
  document.getElementById('statOpen').textContent = s.open;
  document.getElementById('statFail').textContent = s.failChecks;
  const chip = document.getElementById('techChip');
  chip.textContent = techName ? ('Testing as ' + techName) : 'Set your name';
}

function matchesSearch(text){
  if(!searchQuery) return true;
  return text.toLowerCase().indexOf(searchQuery.toLowerCase()) !== -1;
}

function renderLocations(){
  const q = searchQuery.trim();
  let html = '';
  if(!syncEnabled){
    html += '<div class="offline-banner"><span class="dot"></span> Working solo on this device &mdash; changes will sync to the team once a connection is available.</div>';
  }
  // If searching, also allow jumping straight to a matching device
  let locs = LOCATIONS;
  if(q){
    locs = LOCATIONS.filter(function(loc){
      if(matchesSearch(loc.name)) return true;
      return loc.devices.some(function(d){ return matchesSearch(d.name) || matchesSearch(d.model); });
    });
  }
  html += '<div class="section-label">' + locs.length + ' location' + (locs.length===1?'':'s') + '</div>';
  html += '<div class="loc-grid">';
  if(locs.length===0){
    html += '<div class="empty">No locations or devices match &ldquo;' + esc(q) + '&rdquo;.</div>';
  }
  locs.forEach(function(loc){
    const st = locationStats(loc.devices);
    const openCt = openPunchCount(loc.name);
    const pct = st.total ? Math.round(100*st.tested/st.total) : 0;
    html += '<button class="loc-card" data-loc="' + esc(loc.name) + '">'
      + '<div class="name">' + esc(loc.name) + '</div>'
      + '<div class="meta">' + loc.devices.length + ' device' + (loc.devices.length===1?'':'s') + '</div>'
      + '<div class="bar"><span style="width:' + pct + '%;background:' + (st.fails? 'var(--fail)':'var(--pass)') + '"></span></div>'
      + '<div class="footer">'
      + '<span style="color:var(--ink-soft)">' + st.tested + '/' + st.total + ' tested</span>'
      + locationBadgeHtml(st, openCt)
      + '</div>'
      + '</button>';
  });
  html += '</div>';
  document.getElementById('content').innerHTML = html;
}

function titleCase(s){
  return s.replace(/\w\S*/g, function(t){ return t.charAt(0).toUpperCase() + t.substr(1).toLowerCase(); });
}

function portSummary(dev){
  const withPort = (dev.ports||[]).filter(function(p){ return p.port || p.cable_label; });
  const list = withPort.length ? withPort : (dev.ports||[]);
  if(!list.length) return '';
  return list.map(function(p){
    let s = p.switch || '';
    if(p.port) s += ' / Port ' + p.port; else s += ' / port TBD';
    return s;
  }).join(', ');
}

function renderLocationDetail(){
  const loc = LOCATIONS.find(function(l){ return l.name === currentLocation; });
  if(!loc){ view='locations'; renderContent(); return; }
  const st = locationStats(loc.devices);
  let devices = loc.devices;
  if(searchQuery.trim()){
    devices = devices.filter(function(d){ return matchesSearch(d.name) || matchesSearch(d.model); });
  }
  let html = '';
  html += '<div class="back-row"><button class="back-btn" id="backBtn">&larr; All locations</button></div>';
  html += '<div class="loc-header"><h2>' + esc(loc.name) + '</h2>'
    + '<div class="meta">' + loc.devices.length + ' devices &middot; ' + st.tested + '/' + st.total + ' tested'
    + (st.fails ? (' &middot; <span style="color:var(--fail);font-weight:700">' + st.fails + ' failed</span>') : '')
    + '</div></div>';
  html += '<div class="device-list">';
  devices.forEach(function(d){ html += deviceCardHtml(d); });
  html += '</div>';
  document.getElementById('content').innerHTML = html;
}

function renderFailedChecks(){
  let list = DEVICES.filter(function(d){ return hasFail(d.id); });
  if(searchQuery.trim()){
    list = list.filter(function(d){ return matchesSearch(d.name) || matchesSearch(d.model) || matchesSearch(d.location); });
  }
  let html = '';
  html += '<div class="back-row"><button class="back-btn" id="backBtn">&larr; All locations</button></div>';
  html += '<div class="loc-header"><h2>Failed Checks</h2>'
    + '<div class="meta">' + list.length + ' device' + (list.length===1?'':'s') + ' with at least one failed check, across all locations</div></div>';
  html += '<div class="device-list">';
  if(!list.length){
    html += '<div class="empty">No failed checks right now.</div>';
  } else {
    list.forEach(function(d){ html += deviceCardHtml(d, true); });
  }
  html += '</div>';
  document.getElementById('content').innerHTML = html;
}

function deviceCardHtml(d, showLocation){
  const c = getCheck(d.id);
  const ports = portSummary(d);
  let html = '<div class="device-card" data-device="' + esc(d.id) + '">';
  html += '<div class="device-top"><div>'
    + '<div class="device-name">' + esc(d.name) + '</div>'
    + '<div class="device-model">' + esc(d.model || 'Model not specified')
    + (showLocation ? ' &middot; ' + esc(d.location) : '') + '</div>'
    + '</div></div>';
  html += '<div class="device-data mono">';
  if(d.ip) html += '<span>IP <b>' + esc(d.ip) + '</b></span>';
  if(d.ipid) html += '<span>' + esc(d.ipid) + '</span>';
  if(ports) html += '<span>' + esc(ports) + '</span>';
  html += '</div>';
  if(d.avio) html += '<div class="device-note">' + esc(d.avio) + '</div>';
  if(d.note) html += '<div class="device-note">' + esc(d.note) + '</div>';
  html += '<div class="check-row">';
  CHECKS.forEach(function(chk){
    const v = c[chk.key];
    const cls = v==='pass' ? 'pass' : (v==='fail' ? 'fail' : '');
    const state = v==='pass' ? 'Pass' : (v==='fail' ? 'Fail' : 'Untested');
    html += '<button class="check-pill ' + cls + '" data-device="' + esc(d.id) + '" data-check="' + chk.key + '">'
      + '<span class="k">' + chk.label + '</span>' + state + '</button>';
  });
  html += '</div>';
  const devicePunches = punches.filter(function(p){ return p.deviceId === d.id; });
  if(devicePunches.length){
    html += '<div style="margin-top:8px;display:flex;flex-direction:column;gap:5px;">';
    devicePunches.forEach(function(p){
      html += '<div style="font-size:11.5px;display:flex;justify-content:space-between;gap:6px;align-items:center;background:'
        + (p.status==='open'?'var(--open-bg)':'var(--pass-bg)') + ';border-radius:7px;padding:5px 8px;">'
        + '<span style="color:' + (p.status==='open'?'var(--open)':'var(--pass)') + ';font-weight:600;">' + esc(p.description) + '</span>'
        + '<button class="status-btn ' + (p.status==='resolved'?'resolved':'') + '" data-punch="' + esc(p.id) + '" style="padding:3px 9px;font-size:10.5px;">' + (p.status==='open'?'Open':'Resolved') + '</button>'
        + '</div>';
    });
    html += '</div>';
  }
  if(openPunchFormFor === d.id){
    html += '<div class="punch-form">'
      + '<textarea id="punchDesc" placeholder="What needs attention? e.g. No signal on HDMI input 2">' + esc(punchDraftText[d.id] || '') + '</textarea>'
      + '<div class="sev-row">'
      + SEVERITIES.map(function(s){ return '<button class="sev-btn' + (pendingSeverity===s?' sel':'') + '" data-sev="' + s + '">' + s.charAt(0).toUpperCase()+s.slice(1) + '</button>'; }).join('')
      + '</div>'
      + '<div class="form-actions">'
      + '<button class="btn ghost" id="cancelPunch">Cancel</button>'
      + '<button class="btn primary" id="submitPunch" data-device="' + esc(d.id) + '">Log punch item</button>'
      + '</div></div>';
  } else {
    html += '<button class="punch-add-btn" data-device="' + esc(d.id) + '">+ Add punch item</button>';
  }
  html += '</div>';
  return html;
}

function renderPunchList(){
  let list = punches.slice().sort(function(a,b){ return (b.createdAt||'').localeCompare(a.createdAt||''); });
  if(punchStatusFilter !== 'all') list = list.filter(function(p){ return p.status === punchStatusFilter; });
  if(punchLocationFilter) list = list.filter(function(p){ return p.location === punchLocationFilter; });
  if(searchQuery.trim()) list = list.filter(function(p){ return matchesSearch(p.description) || matchesSearch(p.deviceName) || matchesSearch(p.location); });

  let html = '<div class="punch-toolbar">';
  ['open','resolved','all'].forEach(function(f){
    html += '<button class="chip' + (punchStatusFilter===f?' active':'') + '" data-pfilter="' + f + '">' + f.charAt(0).toUpperCase()+f.slice(1) + '</button>';
  });
  html += '<select id="punchLocFilter"><option value="">All locations</option>';
  LOCATIONS.forEach(function(l){
    html += '<option value="' + esc(l.name) + '"' + (punchLocationFilter===l.name?' selected':'') + '>' + esc(l.name) + '</option>';
  });
  html += '</select>';
  html += '<button class="export-btn" id="exportCsv">Export CSV</button>';
  html += '</div>';

  if(!list.length){
    html += '<div class="empty">No punch items here yet.</div>';
  } else {
    list.forEach(function(p){
      html += '<div class="punch-item">'
        + '<div class="sev-stripe ' + (p.severity||'minor') + '"></div>'
        + '<div class="punch-body">'
        + '<div class="top"><span class="loc-dev">' + esc(p.deviceName) + ' <span class="loc">&middot; ' + esc(p.location||'') + '</span></span></div>'
        + '<div class="desc">' + esc(p.description) + '</div>'
        + '<div class="meta"><span>' + (p.severity||'minor').toUpperCase() + '</span>'
        + (p.reportedBy ? ('<span>Reported by ' + esc(p.reportedBy) + '</span>') : '')
        + '<span>' + fmtTime(p.createdAt) + '</span></div>'
        + '</div>'
        + '<button class="status-btn ' + (p.status==='resolved'?'resolved':'') + '" data-punch="' + esc(p.id) + '">' + (p.status==='open'?'Mark resolved':'Resolved') + '</button>'
        + '</div>';
    });
  }
  document.getElementById('content').innerHTML = html;
}

function renderContent(){
  if(view === 'locations') renderLocations();
  else if(view === 'location-detail') renderLocationDetail();
  else if(view === 'failed-checks') renderFailedChecks();
  else renderPunchList();
  renderStats();
}

// ---------- sync layer (Cloudflare Worker -> Turso) ----------
// The Worker is the only thing that holds real database credentials.
// This page only ever calls a handful of narrow, whitelisted endpoints —
// it never sends raw SQL. See /worker/index.js and README.md.

function syncConfigured(){
  return SYNC_API_BASE && SYNC_API_BASE.indexOf('REPLACE-WITH') === -1;
}

async function apiCall(path, options){
  const res = await fetch(SYNC_API_BASE.replace(/\/$/, '') + path, Object.assign({
    headers: {'Content-Type': 'application/json'}
  }, options));
  if(!res.ok){
    const text = await res.text().catch(function(){ return ''; });
    throw new Error('API ' + path + ' failed (' + res.status + '): ' + text);
  }
  return res.json();
}

async function fetchRemoteState(){
  return apiCall('/api/state?project=' + encodeURIComponent(currentProject), {method: 'GET'});
}

async function pushCheck(deviceId, key, value){
  return apiCall('/api/check', {
    method: 'POST',
    body: JSON.stringify({
      project: currentProject, deviceId: deviceId, key: key, value: value,
      updatedBy: techName || 'Unnamed tech'
    })
  });
}

async function pushPunch(item){
  return apiCall('/api/punch', {
    method: 'POST',
    body: JSON.stringify({
      project: currentProject, deviceId: item.deviceId, deviceName: item.deviceName,
      location: item.location, description: item.description, severity: item.severity,
      reportedBy: item.reportedBy
    })
  });
}

async function pushToggleResolve(punchId, actorName){
  return apiCall('/api/punch/toggle', {
    method: 'POST',
    body: JSON.stringify({project: currentProject, id: punchId, actorName: actorName})
  });
}

async function syncFromRemote(){
  if(!syncConfigured()) return;
  try{
    const remote = await fetchRemoteState();
    checklist = remote.checklist || {};
    const remoteIds = {};
    (remote.punches || []).forEach(function(p){ remoteIds[p.id] = true; });
    const stillLocal = punches.filter(function(p){ return String(p.id).indexOf('local-') === 0 && !remoteIds[p.id]; });
    punches = (remote.punches || []).concat(stillLocal);
    syncEnabled = true;
    saveCache();
    renderContent();
  }catch(e){
    console.error(e);
    syncEnabled = false;
    renderStats();
  }
}

// ---------- writes ----------
function persistChecklist(deviceId){
  saveCache();
}
function toggleCheck(deviceId, key){
  const cur = getCheck(deviceId);
  const next = Object.assign({}, cur);
  next[key] = (cur[key] === null || cur[key] === undefined) ? 'pass' : (cur[key] === 'pass' ? 'fail' : null);
  checklist[deviceId] = next;
  persistChecklist(deviceId);
  renderContent();
  if(syncConfigured()){
    pushCheck(deviceId, key, next[key]).catch(function(e){ console.error(e); /* will reconcile on next poll */ });
  }
}
function submitPunch(deviceId){
  const dev = DEVICE_BY_ID[deviceId];
  const desc = (punchDraftText[deviceId] || document.getElementById('punchDesc').value || '').trim();
  if(!desc) return;
  const tempId = 'local-' + Date.now();
  const item = {
    id: tempId, deviceId: deviceId, deviceName: dev.name, location: dev.location,
    description: desc, severity: pendingSeverity, status: 'open',
    reportedBy: techName || 'Unnamed tech', createdAt: new Date().toISOString()
  };
  punches.push(item);
  openPunchFormFor = null;
  delete punchDraftText[deviceId];
  saveCache();
  renderContent();
  if(syncConfigured()){
    pushPunch(item).then(function(res){
      item.id = res.id;
      saveCache();
    }).catch(function(e){ console.error(e); /* stays local-only; flushPendingPunches retries */ });
  }
}
function toggleResolve(punchId){
  const p = punches.find(function(x){ return x.id === punchId; });
  if(!p) return;
  p.status = p.status === 'open' ? 'resolved' : 'open';
  if(p.status === 'resolved'){ p.resolvedBy = techName || 'Unnamed tech'; p.resolvedAt = new Date().toISOString(); }
  else { delete p.resolvedBy; delete p.resolvedAt; }
  saveCache();
  renderContent();
  if(syncConfigured() && String(p.id).indexOf('local-') !== 0){
    pushToggleResolve(p.id, techName || 'Unnamed tech').catch(function(e){ console.error(e); });
  }
}

// ---------- CSV export ----------
function csvEscape(v){
  const s = String(v==null?'':v);
  if(/[",\n]/.test(s)) return '"' + s.replace(/"/g,'""') + '"';
  return s;
}
async function exportCsv(){
  let list = punches.slice().sort(function(a,b){ return (b.createdAt||'').localeCompare(a.createdAt||''); });
  const rows = [['Location','Device','Description','Severity','Status','Reported By','Created','Resolved By','Resolved At']];
  list.forEach(function(p){
    rows.push([(p.location||''), p.deviceName, p.description, p.severity, p.status, p.reportedBy||'', p.createdAt||'', p.resolvedBy||'', p.resolvedAt||'']);
  });
  const csv = rows.map(function(r){ return r.map(csvEscape).join(','); }).join('\r\n');
  try{
    const blob = new Blob([csv], {type: 'text/csv;charset=utf-8;'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'rcrsb-punch-list.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
  }catch(e){
    console.error(e);
    alert('Could not export right now. Please try again.');
  }
}

function flushPendingPunches(){
  if(!syncConfigured()) return;
  punches.filter(function(p){ return String(p.id).indexOf('local-') === 0; }).forEach(function(item){
    pushPunch(item).then(function(res){
      item.id = res.id;
      saveCache();
      renderContent();
    }).catch(function(){ /* still offline-ish, will retry on next interval */ });
  });
}
setInterval(flushPendingPunches, 20000);

// ---------- events ----------
document.getElementById('content').addEventListener('click', function(e){
  const locCard = e.target.closest('[data-loc]');
  if(locCard){ currentLocation = locCard.getAttribute('data-loc'); view = 'location-detail'; searchQuery=''; document.getElementById('searchInput').value=''; renderContent(); return; }

  const backBtn = e.target.closest('#backBtn');
  if(backBtn){ view = 'locations'; renderContent(); return; }

  const checkPill = e.target.closest('.check-pill');
  if(checkPill){ toggleCheck(checkPill.getAttribute('data-device'), checkPill.getAttribute('data-check')); return; }

  const addBtn = e.target.closest('.punch-add-btn');
  if(addBtn){ openPunchFormFor = addBtn.getAttribute('data-device'); pendingSeverity='major'; renderContent();
    setTimeout(function(){ const ta = document.getElementById('punchDesc'); if(ta) ta.focus(); }, 0); return; }

  const cancelBtn = e.target.closest('#cancelPunch');
  if(cancelBtn){ delete punchDraftText[openPunchFormFor]; openPunchFormFor = null; renderContent(); return; }

  const sevBtn = e.target.closest('.sev-btn');
  if(sevBtn){
    pendingSeverity = sevBtn.getAttribute('data-sev');
    renderContent();
    const ta = document.getElementById('punchDesc');
    if(ta){ ta.focus(); const v = ta.value; ta.setSelectionRange(v.length, v.length); }
    return;
  }

  const submitBtn = e.target.closest('#submitPunch');
  if(submitBtn){ submitPunch(submitBtn.getAttribute('data-device')); return; }

  const statusBtn = e.target.closest('.status-btn');
  if(statusBtn){ toggleResolve(statusBtn.getAttribute('data-punch')); return; }

  const pfilter = e.target.closest('[data-pfilter]');
  if(pfilter){ punchStatusFilter = pfilter.getAttribute('data-pfilter'); renderContent(); return; }

  const exportBtn = e.target.closest('#exportCsv');
  if(exportBtn){ exportCsv(); return; }
});
document.getElementById('content').addEventListener('change', function(e){
  if(e.target.id === 'punchLocFilter'){ punchLocationFilter = e.target.value; renderContent(); }
});
document.getElementById('content').addEventListener('input', function(e){
  if(e.target.id === 'punchDesc' && openPunchFormFor){ punchDraftText[openPunchFormFor] = e.target.value; }
});

document.getElementById('searchInput').addEventListener('input', function(e){
  searchQuery = e.target.value;
  if(view === 'location-detail') renderLocationDetail();
  else if(view === 'locations') renderLocations();
  else if(view === 'failed-checks') renderFailedChecks();
  else renderPunchList();
});
function activateTab(name){
  const locBtn = document.getElementById('tabLocations');
  const punchBtn = document.getElementById('tabPunch');
  if(name === 'punch'){ punchBtn.classList.add('active'); locBtn.classList.remove('active'); }
  else { locBtn.classList.add('active'); punchBtn.classList.remove('active'); }
}
document.getElementById('tabLocations').addEventListener('click', function(){
  view='locations'; currentLocation=null;
  activateTab('locations');
  renderContent();
});
document.getElementById('tabPunch').addEventListener('click', function(){
  view='punch';
  activateTab('punch');
  renderContent();
});
document.getElementById('statOpenCard').addEventListener('click', function(){
  view = 'punch';
  punchStatusFilter = 'open';
  activateTab('punch');
  renderContent();
});
document.getElementById('statFailCard').addEventListener('click', function(){
  view = 'failed-checks';
  searchQuery = '';
  document.getElementById('searchInput').value = '';
  renderContent();
});
document.querySelectorAll('.stat.clickable').forEach(function(el){
  el.addEventListener('keydown', function(e){
    if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); el.click(); }
  });
});
document.getElementById('techChip').addEventListener('click', function(){
  const name = prompt('Your name (shown on checklist updates and punch items):', techName || '');
  if(name !== null){
    techName = name.trim();
    localStorage.setItem('pd_tech_name', techName);
    renderStats();
  }
});

// ---------- theme (light/dark) ----------
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
  // Icon shown = the mode a click will switch you TO.
  btn.innerHTML = theme === 'dark' ? SUN_ICON : MOON_ICON;
  const label = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  btn.setAttribute('aria-label', label);
  btn.title = label;
}
document.getElementById('themeToggle').addEventListener('click', function(){
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  try{ localStorage.setItem(THEME_KEY, next); }catch(e){}
  applyTheme(next);
});
applyTheme(effectiveTheme());

// ---------- boot ----------
(function(){
  const proj = PROJECTS[currentProject];
  document.getElementById('projSub').textContent = proj.shortName + ' · ' + proj.name;
})();
loadCache();
renderContent();

// Real-time push (onSnapshot) isn't available with this backend, so instead
// we do an immediate sync on load, then poll on an interval. Every write
// still applies to the local copy immediately (optimistic UI) before the
// network call goes out, so the app feels instant even on a slow connection.
if(syncConfigured()){
  syncFromRemote();
  pollTimer = setInterval(syncFromRemote, SYNC_POLL_MS);
} else {
  console.warn('SYNC_API_BASE is not configured — running in local-only (single device) mode. See README.md.');
}
