// ─────────────────────────────────────────────────────────────
// RCRSB Commissioning - app logic
//
// Load order matters: config.js must load before this file (it defines
// SYNC_API_BASE, SYNC_POLL_MS). devices.js is no longer used - device
// data now lives in the database and is fetched at runtime per project
// (see fetchDevices below). See index.html <script> tags at the bottom
// of <body>.
// ─────────────────────────────────────────────────────────────

const CHECKS = [
  {key:'power', label:'Power'},
  {key:'network', label:'Network'},
  {key:'function', label:'Function'}
];
const SEVERITIES = ['minor','major','critical'];
const OWNERSHIPS = ['Field Tech/Install', 'Programming', 'Configuration'];
// Sentinel for the shared location-punch form/state below, meaning "no
// location at all - a project-wide item." Never collides with a real
// location name (those always come from actual devices/locations).
const PROJECT_WIDE_SCOPE = '__PROJECT_WIDE__';

// Which side of the project this page is showing: "av" (the original
// side) or "lc" (Local Cresnet / lighting control). Same project either
// way - the two sides just have separate devices, locations, checklist
// status, and punch items. The link that got here says which (?type=),
// falling back to the side chosen at login; whichever wins is written
// back to the session so the switcher, the projects page, and this page
// always agree about where the person is.
function resolveDeviceType(){
  let fromUrl = null, fromSession = null;
  try{ fromUrl = new URLSearchParams(window.location.search).get('type'); }catch(e){}
  try{ fromSession = sessionStorage.getItem('pd_device_type'); }catch(e){}
  const t = (fromUrl === 'lc' || fromUrl === 'av') ? fromUrl : (fromSession === 'lc' ? 'lc' : 'av');
  try{ sessionStorage.setItem('pd_device_type', t); }catch(e){}
  return t;
}
const DEVICE_TYPE = resolveDeviceType();
const DEVICE_TYPE_LABEL = DEVICE_TYPE === 'lc' ? 'LC' : 'AV';

let currentProject = null;   // set from the ?project= URL param at boot
let currentProjectMeta = { name: '', shortName: '' };
// Which sides of this project this person may open, as reported by the Worker
// with the device list. Assumed open until told otherwise (older Worker,
// offline cache) so nothing disappears by accident.
let currentAccess = {av: true, lc: true};
// How many devices each side of this project has ({av: n, lc: n}), or null when
// that isn't known (an older Worker, or offline with no saved copy). A side with
// nothing uploaded gets no "Switch" link - there would be nothing to switch to.
let currentSideCounts = null;
let DEVICES = [];
let LOCATIONS = [];
let SERVER_LOCATIONS = [];
let DEVICE_BY_ID = {};

let checklist = {};   // deviceId -> {power,network,function}
let punches = [];     // {id, deviceId, deviceName, location, description, severity, status, Ownership, reportedBy, createdAt, resolvedBy, resolvedAt}
let techName = sessionStorage.getItem('pd_tech_name') || '';
if(!techName){
  try{
    const storedEmail = sessionStorage.getItem('pd_user_email');
    if(storedEmail){
      techName = storedEmail;
      sessionStorage.setItem('pd_tech_name', techName);
    } 
  }catch(e){}
}
let view = 'locations';
let currentLocation = null;
let searchQuery = '';
let punchStatusFilter = 'open';
let punchLocationFilter = '';
let openPunchFormFor = null;
let editingPunchId = null;
let editingNotesId = null;
let addingLocation = false;
let locationDraftText = '';
let addingDeviceFor = null;
let deviceDraft = {};
let addingLocationPunchFor = null;   // location name the location-level punch form is open for, or null
let locationPunchDraft = '';
let editDraftText = {};
let editNoteText = {};
let pendingSeverity = 'major';
let pendingOwnership = 'Field Tech/Install';
let punchDraftText = {};
let syncEnabled = false;
let pollTimer = null;

//Text Validation for Add Location and Add Devices
//Letters, numbers, spaces, and a few basic symbols are allowed, anything else, emojis,
// < >, etc. is removed as it is typed or pasted. To allow another symbol, add it inside the
// brackets below (a "-" or "/" needs the backslash in front, as shown).
const NOT_ALLOWED = /[^A-Za-z0-9 \-_\/.,:;'"()#&+@|]/g;

// First turns what a phone keyboard or a copy-and-paste brings in into its plain equivalent, so
// nothing useful is lost ("Dan’s Office" stays "Dan's Office", "Café" becomes "Cafe"), then removes
// whatever is still not allowed.
function cleanText(s){
  return String( s == null ? '' : s)
    .replace(/[\u2018\u2019\u201B]/g, "'")        // curly single quotes
    .replace(/[\u201C\u201D]/g, '"')              // curly double quotes
    .replace(/[\u2010-\u2015\u2212]/g, '-')       // en dash, em dash, minus sign
    .replace(/\u2026/g, '...')                    // the single "..." character
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // accents: é -> e, ñ -> n
    .replace(/[^\S ]+/g, ' ')                     // tabs, new lines, non-breaking spaces -> a plain space
    .replace(NOT_ALLOWED, '');
}
//Cleaned with repeated spaces collapased and the ends trimmed, what is actually sent.
function tidyText(s){ return cleanText(s).replace(/ {2,}/g, ' ').trim(); }

//Cleans a box in place while keeping the cursor where it was.
function cleanInputBox(el){
  const before = el.value, after = cleanText(before);
  if(after === before) return;
  const caret = el.selectionStart == null ? after.length : cleanText(before.slice(0, el.selectionStart)).length;
  el.value = after;
  try { el.setSelectionRange(caret, caret); }catch(e){}
}
function isPlainTextBox(el){
  return !!el && (el.id === 'newLocationName' || (typeof el.id === 'string' && el.id.indexOf('newDevice_') === 0));
}

function rebuildDeviceIndexes(){
  const map = {};
  SERVER_LOCATIONS.forEach(function(name){ map[name] = map[name] || []; });
  DEVICES.forEach(function(d){
    if(!map[d.location]) map[d.location] = [];
    map[d.location].push(d);
  });
  LOCATIONS = Object.keys(map).sort().map(function(name){
    return {name: name, devices: map[name]};
  });
  DEVICE_BY_ID = {};
  DEVICES.forEach(function(d){ DEVICE_BY_ID[d.id] = d; });
}

function loadCache(){
  try{
    const raw = localStorage.getItem('pd_commissioning_cache_' + currentProject + '_' + DEVICE_TYPE);
    if(raw){
      const parsed = JSON.parse(raw);
      checklist = parsed.checklist || {};
      punches = parsed.punches || [];
      punches.forEach(function(p){ delete p.syncError; delete p.syncedClock; });
    }
  }catch(e){}
}
function saveCache(){
  try{
    localStorage.setItem('pd_commissioning_cache_' + currentProject + '_' + DEVICE_TYPE, JSON.stringify({checklist:checklist, punches:punches}));
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

// "Done" means fully tested AND every check passed - being fully tested
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
  renderSyncStatus();
}

function matchesSearch(text){
  if(!searchQuery) return true;
  return text.toLowerCase().indexOf(searchQuery.toLowerCase()) !== -1;
}

function renderLocations(){
  const q = searchQuery.trim();
  let html = '';
  // If searching, also allow jumping straight to a matching device
  let locs = LOCATIONS;
  if(q){
    locs = LOCATIONS.filter(function(loc){
      if(matchesSearch(loc.name)) return true;
      return loc.devices.some(function(d){ return matchesSearch(d.name) || matchesSearch(d.model) || matchesSearch(d.cresnetId || '') || matchesSearch(d.controller || ''); });
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
  if(addingLocation){
    html += '<div class="punch-form" style="margin-top:12px;">'
      + '<input id="newLocationName" type="text" placeholder="e.g. Elec 309 | AV Rack 2" value="' + esc(locationDraftText) + '" style="width:100%;border:1px solid var(--border);border-radius:8px;padding:8px;font-family:inherit;font-size:13px;background:var(--surface);color:var(--ink);">'
      + '<div class="form-actions">'
      + '<button class="btn ghost" id="cancelAddLocation">Cancel</button>'
      + '<button class="btn primary" id="submitAddLocation">Add location</button>'
      + '</div></div>';
  } else {
    html += '<button class="punch-add-btn" id="addLocationBtn" style="margin-top:12px;">+ Add location</button>';
  }
  document.getElementById('content').innerHTML = html;
  if(addingLocation){
    const inp = document.getElementById('newLocationName');
    if(inp){ inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
  }
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
    devices = devices.filter(function(d){ return matchesSearch(d.name) || matchesSearch(d.model) || matchesSearch(d.cresnetId || '') || matchesSearch(d.controller || ''); });
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

  if(addingLocationPunchFor === loc.name){
    html += locationPunchFormHtml();
  } else {
    html += '<button class="punch-add-btn" id="addLocationPunchBtn" style="margin-top:10px;">+ Add punch item</button>';
  }

  if(addingDeviceFor === loc.name){
    html += addDeviceFormHtml();
  } else{
    html +='<button class="punch-add-btn" id="addDeviceBtn" style="margin-top:10px;"> + Add Device</button>';
  }
  document.getElementById('content').innerHTML = html;
  if(addingLocationPunchFor === loc.name){
    const ta = document.getElementById('locationPunchDesc');
    if(ta) ta.focus();
  }
  if(addingDeviceFor === loc.name){
    const nameInput = document.getElementById('newDeviceName');
    if(nameInput) nameInput.focus();
  }
  if(editingNotesId){
    const ta = document.getElementById('editNoteText');
    if(ta){ ta.focus(); const v = ta.value; ta.setSelectionRange(v.length, v.length); }
  }
}

// A punch item with no device - reported against a specific location,
// or (with PROJECT_WIDE_SCOPE) against the project as a whole, for
// things that aren't tied to any one place: waiting on client drawings,
// a contractor scheduling issue, anything that would otherwise become
// orphaned if the location it was filed under ever got renamed or
// removed. Shares SEVERITIES/OWNERSHIPS and the same
// pendingSeverity/pendingOwnership state as every other punch form -
// only one of these is ever open at a time in practice.
function locationPunchFormHtml(){
  const isProjectWide = addingLocationPunchFor === PROJECT_WIDE_SCOPE;
  const placeholder = isProjectWide
    ? 'What needs attention on this project overall? e.g. Waiting on client for final AV drawings'
    : 'What needs attention in this location? e.g. Missing floor box cover';
  return '<div class="punch-form" style="margin-top:10px;">'
    + '<textarea id="locationPunchDesc" placeholder="' + esc(placeholder) + '">' + esc(locationPunchDraft) + '</textarea>'
    + '<div class="sev-row">'
    + SEVERITIES.map(function(s){ return '<button class="sev-btn' + (pendingSeverity===s?' sel':'') + '" data-sev="' + s + '">' + s.charAt(0).toUpperCase()+s.slice(1) + '</button>'; }).join('')
    + '</div>'
    + '<div class="sev-row">'
    + OWNERSHIPS.map(function(s){ return '<button class="own-btn' + (pendingOwnership===s?' sel':'') + '" data-own="' + s + '">' + s.charAt(0).toUpperCase()+s.slice(1) + '</button>'; }).join('')
    + '</div>'
    + '<div class="form-actions">'
    + '<button class="btn ghost" id="cancelLocationPunch">Cancel</button>'
    + '<button class="btn primary" id="submitLocationPunch">Log punch item</button>'
    + '</div></div>';
}

//All fields are available, but only device name is required
function deviceDraftField(id, label, placeholder, maxlength){
  const val = deviceDraft[id] || '';
  return '<div style="margin-bottom:8px;">'
    + '<label style="display:block;font-size:11px;font-weight:700;color:var(--ink-soft);margin-bottom:3px;">' + esc(label) + '</label>'
    + '<input id="newDevice_' + id + '" type="text" placeholder="' + esc(placeholder || '') + '"' + (maxlength ? ' maxlength="' + maxlength + '"' : '') + ' value="' + esc(val) + '" style="width:100%;border:1px solid var(--border);border-radius:8px;padding:7px 8px;font-family:inherit;font-size:13px;background:var(--surface);color:var(--ink);">'
    + '</div>';
}

function addDeviceFormHtml(){
  let html = '<div class="punch-form" style="margin-top:10px;">';
  html += deviceDraftField('name', DEVICE_TYPE === 'lc' ? 'Cresnet Device Name (Required)' : 'Device Name (Required)', DEVICE_TYPE === 'lc' ? 'e.g. ZC-1-3A' : 'e.g. R1-TV1-01');
  html += deviceDraftField('model', DEVICE_TYPE === 'lc' ? 'Model #' : 'Manufacturer | Model', DEVICE_TYPE === 'lc' ? 'e.g. CLW-DIMEX-P' : 'e.g. Sony | XR-65X90L');
  html += deviceDraftField('ip', DEVICE_TYPE === 'lc' ? 'Controller IP Address' : 'IP Address', 'e.g. 10.0.1.20');
  html += deviceDraftField('ipid', DEVICE_TYPE === 'lc' ? 'Controller IP ID' : 'IP ID');
  if(DEVICE_TYPE === 'lc'){
    html += deviceDraftField('cresnetId', 'Cresnet ID', 'e.g. 03');
    html += deviceDraftField('controller', 'Controller', 'e.g. LCP-DPC1');
    html += deviceDraftField('dinRail', 'DIN Rail', 'e.g. Rail 1');
    html += deviceDraftField('connection', 'Connection', 'e.g. Cresnet');
  } else {
    html += deviceDraftField('zone', 'Zone');
  }
  if(DEVICE_TYPE !== 'lc') html += deviceDraftField('channel', 'Amp Channel');
  html += deviceDraftField('status', 'Status');
  html += deviceDraftField('level', 'Level');
  if(DEVICE_TYPE !== 'lc') html += deviceDraftField('avio', 'AV I/O');
  html += deviceDraftField('note', 'Note');
  html += '<div class="form-actions">' 
  + '<button class="btn ghost" id="cancelAddDevice">Cancel</button>' 
  + '<button class="btn primary" id="submitAddDevice">Add Device</button>'
  + '</div></div>';
  return html;
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

// Notes are the one device field editable in place (see
// handleEditDeviceNote in the Worker) - a plain block when there's a
// note and nothing's being edited, an inline edit form when this device
// is the one currently being edited, or a small "+ Add note" affordance
// when there's no note yet at all.
function deviceNoteHtml(d){
  if(editingNotesId === d.id){
    return '<div class="punch-form" style="margin-top:6px;padding:8px;">'
      + '<textarea id="editNoteText" placeholder="Add a note for this device">' + esc(editNoteText[d.id] !== undefined ? editNoteText[d.id] : (d.note || '')) + '</textarea>'
      + '<div class="form-actions">'
      + '<button class="btn ghost" id="cancelEditNote" data-device="' + esc(d.id) + '">Cancel</button>'
      + '<button class="btn primary" id="saveEditNote" data-device="' + esc(d.id) + '">Save note</button>'
      + '</div></div>';
  }
  if(d.note){
    return '<div class="device-note" style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">'
      + '<span>' + esc(d.note) + '</span>'
      + '<button class="btn ghost" style="padding:2px 8px;font-size:10.5px;flex:none;" data-editnote="' + esc(d.id) + '">Edit</button>'
      + '</div>';
  }
  return '<button class="btn ghost" style="margin-top:6px;padding:3px 9px;font-size:11px;" data-editnote="' + esc(d.id) + '">+ Add note</button>';
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
  if(d.cresnetId) html += '<span>Cresnet ID <b>' + esc(d.cresnetId) + '</b></span>';
  if(d.controller) html += '<span>Ctrl <b>' + esc(d.controller) + '</b></span>';
  // On an LC device the IP / IP ID belong to its controller, not to the device itself
  if(d.ip) html += '<span>' + (d.controller ? 'Ctrl IP' : 'IP') + ' <b>' + esc(d.ip) + '</b></span>';
  if(d.ipid) html += '<span>' + (d.controller ? 'Ctrl ID' : 'ID') + ' <b>' + esc(d.ipid) + '</b></span>';
  if(d.zone) html += '<span>Zone <b>' + esc(d.zone) + '</b></span>';
  if(d.channel) html += '<span>Ch <b>' + esc(d.channel) + '</b></span>';
  if(d.dinRail) html += '<span>DIN <b>' + esc(d.dinRail) + '</b></span>';
  if(d.connection) html += '<span>Conn <b>' + esc(d.connection) + '</b></span>';
  if(ports) html += '<span>' + esc(ports) + '</span>';
  html += '</div>';
  if(d.avio) html += '<div class="device-note">' + esc(d.avio) + '</div>';
  html += deviceNoteHtml(d);
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
      const st = p.status === 'resolved' ? {bg:'var(--pass-bg)', txt:'var(--pass)'}
        : p.severity === 'critical' ? {bg:'var(--fail-bg)', txt:'var(--fail)'}
        : p.severity === 'major' ? {bg:'var(--major-bg)', txt:'var(--major)'}
        : {bg:'var(--pending-bg)', txt:'var(--pending)'};
      html += '<div style="font-size:11.5px;display:flex;justify-content:space-between;gap:6px;align-items:center;background:'
        + st.bg + ';border-radius:7px;padding:5px 8px;">'
        + '<span style="color:' + st.txt + ';font-weight:600;">' + esc(p.description) + '</span>'
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
      + '<div class="sev-row">'
      + OWNERSHIPS.map(function(s){ return '<button class="own-btn' + (pendingOwnership===s?' sel':'') + '" data-own="' + s + '">' + s.charAt(0).toUpperCase()+s.slice(1) + '</button>'; }).join('')
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
  if(punchLocationFilter === PROJECT_WIDE_SCOPE) list= list.filter(function(p){ return !p.location; });
  else if(punchLocationFilter) list = list.filter(function(p){ return p.location === punchLocationFilter; });
  if(searchQuery.trim()) list = list.filter(function(p){ return matchesSearch(p.description) || matchesSearch(p.deviceName) || matchesSearch(p.location); });

  let html = '<div class="punch-toolbar">';
  ['open','resolved','all'].forEach(function(f){
    html += '<button class="chip' + (punchStatusFilter===f?' active':'') + '" data-pfilter="' + f + '">' + f.charAt(0).toUpperCase()+f.slice(1) + '</button>';
  });
  html += '<select id="punchLocFilter"><option value="">All locations</option>';
  html += '<option value="' + PROJECT_WIDE_SCOPE + '"' + (punchLocationFilter===PROJECT_WIDE_SCOPE?' selected': '') + '>General</option>';
  LOCATIONS.forEach(function(l){
    html += '<option value="' + esc(l.name) + '"' + (punchLocationFilter===l.name?' selected':'') + '>' + esc(l.name) + '</option>';
  });
  html += '</select>';
  html += '<button class="export-btn" id="exportCsv">Export CSV</button>';
  html += '</div>';

  if(addingLocationPunchFor === PROJECT_WIDE_SCOPE){
    html += locationPunchFormHtml();
  } else {
    html += '<button class="punch-add-btn" id="addProjectPunchBtn" style="margin-bottom:12px;">+ Add punch item</button>';
  }

  if(!list.length){
    html += '<div class="empty">No punch items here yet.</div>';
  } else {
    list.forEach(function(p){
      if(editingPunchId === p.id){
        html += '<div class="punch-item">'
          + '<div class="sev-stripe ' + pendingSeverity + '"></div>'
          + '<div class="punch-body" style="width:100%;">'
          + '<div class="top"><span class="loc-dev">' + esc(p.deviceName || 'General') + (p.location ? ' <span class="loc">&middot; ' + esc(p.location) + '</span>' : '') + '</span></div>'
          + '<div class="punch-form" style="margin-top:8px;padding:0;background:none;">'
          + '<textarea id="editPunchDesc">' + esc(editDraftText[p.id] !== undefined ? editDraftText[p.id] : p.description) + '</textarea>'
          + '<div class="sev-row">'
          + SEVERITIES.map(function(s){ return '<button class="sev-btn' + (pendingSeverity===s?' sel':'') + '" data-sev="' + s + '">' + s.charAt(0).toUpperCase()+s.slice(1) + '</button>'; }).join('')
          + '</div>'
          + '<div class="sev-row">'
          + OWNERSHIPS.map(function(s){ return '<button class="own-btn' + (pendingOwnership===s?' sel':'') + '" data-own="' + s + '">' + s.charAt(0).toUpperCase()+s.slice(1) + '</button>'; }).join('')
          + '</div>'
          + '<div class="form-actions">'
          + '<button class="btn ghost" id="cancelEditPunch">Cancel</button>'
          + '<button class="btn primary" id="saveEditPunch" data-punch="' + esc(p.id) + '">Save changes</button>'
          + '</div></div>'
          + '</div>'
          + '</div>';
        return;
      }
      html += '<div class="punch-item">'
        + '<div class="sev-stripe ' + (p.severity||'minor') + '"></div>'
        + '<div class="punch-body">'
        + '<div class="top"><span class="loc-dev">' + esc(p.deviceName || 'General') + (p.location ? ' <span class="loc" data-loc="' + esc(p.location) + '" style="cursor:pointer;">&middot; ' + esc(p.location) + '</span>' : '') + '</span></div>'
        + '<div class="desc">' + esc(p.description) + '</div>'
        + '<div class="meta"><span>' + (p.severity||'minor').toUpperCase() + '</span>'
        + '<span>' + (p.ownership||'Field Tech/Install').toUpperCase() + '</span>'
        + (p.reportedBy ? ('<span>Reported by ' + esc(p.reportedBy) + '</span>') : '')
        + '<span>' + fmtTime(p.createdAt) + '</span></div>'
        + '</div>'
        + '<div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;flex:none;">'
        + '<button class="status-btn ' + (p.status==='resolved'?'resolved':'') + '" data-punch="' + esc(p.id) + '">' + (p.status==='open'?'Mark resolved':'Resolved') + '</button>'
        + '<button class="btn ghost" style="padding:4px 10px;font-size:11px;" data-editpunch="' + esc(p.id) + '">Edit</button>'
        + '</div>'
        + '</div>';
    });
  }
  document.getElementById('content').innerHTML = html;
  if(addingLocationPunchFor === PROJECT_WIDE_SCOPE){
    const ta = document.getElementById('locationPunchDesc');
    if(ta) ta.focus();
  }
}

function renderContent(){
  if(view === 'locations') renderLocations();
  else if(view === 'location-detail') renderLocationDetail();
  else if(view === 'failed-checks') renderFailedChecks();
  else renderPunchList();
  renderStats();
  persistDraft();
}

// ---------- sync layer (Cloudflare Worker -> Turso) ----------
// The Worker is the only thing that holds real database credentials.
// This page only ever calls a handful of narrow, whitelisted endpoints -
// it never sends raw SQL. See /worker/index.js and README.md.

function syncConfigured(){
  return SYNC_API_BASE && SYNC_API_BASE.indexOf('REPLACE-WITH') === -1;
}

async function apiCall(path, options){
  const opts = options || {};
  // Optional per-call timeout. Check writes go out one at a time per field
  // (see queueCheckWrite), so a request that hangs on a bad connection has
  // to eventually fail and be retried rather than hold that field up forever.
  let timer = null, signal;
  if(opts.timeoutMs && typeof AbortController !== 'undefined'){
    const ctl = new AbortController();
    timer = setTimeout(function(){ ctl.abort(); }, opts.timeoutMs);
    signal = ctl.signal;
  }
  try{
    const res = await fetch(SYNC_API_BASE.replace(/\/$/, '') + path, Object.assign({
      headers: {'Content-Type': 'application/json'}
    }, opts, signal ? {signal: signal} : {}));
    if(!res.ok){
      const text = await res.text().catch(function(){ return ''; });
      const err = new Error('API ' + path + ' failed (' + res.status + '): ' + text);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  }finally{
    if(timer) clearTimeout(timer);
  }
}

async function fetchRemoteState(){
  return apiCall('/api/state?project=' + encodeURIComponent(currentProject) + '&deviceType=' + DEVICE_TYPE, {method: 'GET', timeoutMs: 10000});
}

function callerEmail(){
  try{ return sessionStorage.getItem('pd_user_email') || ''; }catch(e){ return ''; }
}

async function fetchDevicesAndMeta(){
  return apiCall('/api/devices?project=' + encodeURIComponent(currentProject) + '&deviceType=' + DEVICE_TYPE + '&email=' + encodeURIComponent(callerEmail()), {method: 'GET', timeoutMs: 8000});
}

function deviceCacheKey(){
  return 'pd_devices_cache_' + currentProject + '_' + DEVICE_TYPE;
}
function saveDeviceCache(meta, devices, locations){
  try{
    localStorage.setItem(deviceCacheKey(), JSON.stringify({meta: meta, devices: devices, locations: locations || [], cachedAt: new Date().toISOString()}));
  }catch(e){}
}
function loadDeviceCache(){
  try{
    const raw = localStorage.getItem(deviceCacheKey());
    if(!raw) return null;
    return JSON.parse(raw);
  }catch(e){ return null; }
}

async function pushCheck(deviceId, key, value, by){
  return apiCall('/api/check', {
    timeoutMs: 12000,
    method: 'POST',
    body: JSON.stringify({
      project: currentProject, deviceId: deviceId, key: key, value: value,
      updatedBy: by || techName || 'Unnamed tech'
    })
  });
}

async function pushPunch(item){
  return apiCall('/api/punch', {
    method: 'POST',
    body: JSON.stringify({
      project: currentProject, deviceId: item.deviceId, deviceName: item.deviceName,
      location: item.location, description: item.description, severity: item.severity, ownership: item.ownership,
      reportedBy: item.reportedBy,
      clientId: item.clientId || String(item.id).replace(/^local-/, ''),   // lets the server ignore a repeat of the same request
      deviceType: item.deviceType || DEVICE_TYPE
    })
  });
}

async function pushAddLocation(name){
  return apiCall('/api/location', {
    method: 'POST',
    body: JSON.stringify({project: currentProject, name: name, actorName: techName || 'Unnamed tech', deviceType: DEVICE_TYPE})
  });
}

async function pushAddDevice(fields){
  return apiCall('/api/device', {
    method: 'POST',
    body: JSON.stringify(Object.assign({project: currentProject, actorName: techName || 'Unnamed tech', deviceType: DEVICE_TYPE},
      fields))
  });
}

async function pushEditNote(deviceId, note){
  return apiCall('/api/device/note', {
    method: 'POST',
    body: JSON.stringify({project: currentProject, deviceId: deviceId, note: note, actorName: techName || 'Unnamed tech'})
  });
}

async function pushToggleResolve(punchId, actorName){
  return apiCall('/api/punch/toggle', {
    method: 'POST',
    body: JSON.stringify({project: currentProject, id: punchId, actorName: actorName})
  });
}

// Sets the status (rather than flipping it), so sending the same request twice is harmless.
async function pushSetPunchStatus(punchId, status, actorName){
  return apiCall('/api/punch/toggle', {
    method: 'POST',
    body: JSON.stringify({project: currentProject, id: punchId, status: status, actorName: actorName})
  });
}

async function pushEditPunch(punchId, description, severity, ownership, actorName){
  return apiCall('/api/punch/edit', {
    method: 'POST',
    body: JSON.stringify({project: currentProject, id: punchId, description: description, severity: severity, ownership: ownership, actorName: actorName})
  });
}

// While someone is actively typing a punch description, a background
// re-render would tear down and rebuild that textarea's DOM node,
// silently kicking focus out of it every poll cycle (every 5 seconds).
// Skip the render in that case - the underlying data still updates
// (nothing is lost), the visible screen just catches up next time the
// person does something that naturally re-renders (submit, cancel,
// toggle a check, switch tabs).
function isComposingPunch(){
  const el = document.activeElement;
  if(!el || !el.id) return false;
  return el.id === 'punchDesc' || el.id === 'editPunchDesc' || el.id === 'newLocationName' || el.id === 'locationPunchDesc' || el.id === 'editNoteText' || el.id.indexOf('newDevice_') === 0;
}

// Three different punch-entry forms share the same severity/ownership
// buttons and pendingSeverity/pendingOwnership state - this picks
// whichever textarea is actually the open one, so clicking a severity
// button re-focuses the right field regardless of which form is open.
function activePunchTextareaId(){
  if(editingPunchId) return 'editPunchDesc';
  if(addingLocationPunchFor) return 'locationPunchDesc';
  return 'punchDesc';
}

// ---------- check taps vs. the poll ----------
// A tap on Power / Network / Function shows on screen immediately and is
// sent to the server afterwards. The poll below replaces local state with
// the server's - so a poll that was already in flight when you tapped (its
// answer describes the server from BEFORE your tap landed) used to snap the
// pill back a step, and the next tap then started from the wrong place.
// Every tapped field is therefore tracked here until the server has provably
// caught up, and the poll leaves it alone until then:
//   - one write in flight per field; rapid taps coalesce into the latest
//     value, so writes can't land out of order and strand the server on a
//     stale value
//   - the field stays protected while its write is in flight, while it is
//     failing and being retried (offline), and against any poll that STARTED
//     before the write was confirmed (that poll's answer predates it)
//   - only a poll that began after the write was confirmed may overwrite it,
//     which also ends the protection - so other people's later changes to
//     the same field still come through
// Other fields and other devices are never held back: they take the
// server's values on every poll as before.
const localCheckEdits = {};   // 'deviceId|field' -> {deviceId, key, value, status, sentValue, settledAt}
let checkClock = 0;           // ticks whenever a write is confirmed or a poll starts

function queueCheckWrite(deviceId, key, value){
  const k = deviceId + '|' + key;
  const by = techName || 'Unnamed tech';
  let e = localCheckEdits[k];
  if(!e){
    e = localCheckEdits[k] = {deviceId: deviceId, key: key, value: value, by: by, status: 'idle', sentValue: undefined, settledAt: null};
  }else{
    e.value = value;
    e.by = by;
    e.settledAt = null;
    if(e.status === 'settled') e.status = 'idle';
  }
  persistPendingChecks();
  sendCheckEdit(e);
}

function sendCheckEdit(e){
  if(e.status === 'sending') return;    // its completion below re-checks for a newer value
  e.status = 'sending';
  const sent = e.value;
  e.sentValue = sent;
  pushCheck(e.deviceId, e.key, sent, e.by).then(function(){
    e.settledAt = ++checkClock;
    if(e.value !== sent){               // tapped again meanwhile - send the latest
      e.status = 'idle';
      sendCheckEdit(e);
    }else{
      e.status = 'settled';
    }
    persistPendingChecks();
    renderSyncStatus();
  }).catch(function(err){
    console.error(err);
    if(isPermanentFailure(err)){
      delete localCheckEdits[e.deviceId + '|' + e.key];   // the server refused it; retrying can't help, and the next poll shows the real value
    }else{
      e.status = 'failed';              // stays protected AND saved on the device; retried on the next poll
    }
    persistPendingChecks();
    renderSyncStatus();
  });
}

function flushPendingChecks(){
  Object.keys(localCheckEdits).forEach(function(k){
    const e = localCheckEdits[k];
    if(e.status === 'failed' || e.status === 'idle') sendCheckEdit(e);
  });
}

// The server's checklist, with this person's still-protected taps laid over it.
function mergeRemoteChecklist(remoteChecklist, pollStartedAt){
  const merged = {};
  Object.keys(remoteChecklist).forEach(function(id){ merged[id] = Object.assign({}, remoteChecklist[id]); });
  Object.keys(localCheckEdits).forEach(function(k){
    const e = localCheckEdits[k];
    if(e.status === 'settled' && e.settledAt < pollStartedAt){
      delete localCheckEdits[k];        // this poll began after the write landed: the server has caught up
      return;
    }
    if(!merged[e.deviceId]) merged[e.deviceId] = {power: null, network: null, function: null};
    merged[e.deviceId][e.key] = e.value;
  });
  return merged;
}

// What's visible on screen, boiled down - used to tell whether a poll
// actually changed anything worth redrawing.
function stateSignature(cl, pu){
  const c = Object.keys(cl).sort().map(function(id){
    const v = cl[id] || {};
    return id + ':' + (v.power || '') + '/' + (v.network || '') + '/' + (v.function || '');
  }).join(',');
  const p = pu.map(function(x){
    return [x.id, x.status, x.severity, x.ownership, x.description, x.location, x.deviceName, x.resolvedBy, x.reportedBy].join('~');
  }).join('|');
  return c + '#' + p;
}

async function syncFromRemote(){
  if(!syncConfigured()) return;
  flushAllPending();
  const pollStartedAt = ++checkClock;
  try{
    const remote = await fetchRemoteState();
    const wasEnabled = syncEnabled;
    const before = stateSignature(checklist, punches);
    checklist = mergeRemoteChecklist(remote.checklist || {}, pollStartedAt);
    const remoteIds = {};
    (remote.punches || []).forEach(function(p){ remoteIds[p.id] = true; });
    // keep punch items that haven't reached the server yet, and ones that did just now (this poll may predate them)
    const stillLocal = punches.filter(function(p){
      return !remoteIds[p.id] && (String(p.id).indexOf('local-') === 0 || (p.syncedClock && p.syncedClock > pollStartedAt));
    });
    punches = (remote.punches || []).concat(stillLocal);
    Object.keys(pendingOps).forEach(function(k){
      const o = pendingOps[k];
      if(o.status === 'settled' && o.settledAt < pollStartedAt) delete pendingOps[k];   // this poll began after it landed: the server has it
    });
    applyPendingOps();
    syncEnabled = true;
    saveCache();
    // Only rebuild the screen when something visible actually changed (or the
    // connection just came back, which clears the offline banner). Rebuilding
    // on every poll is what made the page flicker - and swapping buttons out
    // from under a finger mid-tap can swallow that tap.
    const changed = !wasEnabled || before !== stateSignature(checklist, punches);
    if(!changed || isComposingPunch()){
      renderStats();
    }else{
      renderContent();
    }
  }catch(e){
    console.error(e);
    syncEnabled = false;
    renderStats();
  }
}

// ---------- writes ----------
async function submitAddLocation(){
  const input = document.getElementById('newLocationName');
  const name = tidyText(input ? input.value : locationDraftText);
  if(!name) return;
  const btn = document.getElementById('submitAddLocation');
  if(btn){ btn.disabled = true; btn.textContent = 'Adding...'; }
  try{
    const result = await pushAddLocation(name);
    if(!SERVER_LOCATIONS.includes(result.name)) SERVER_LOCATIONS.push(result.name);
    addingLocation = false;
    locationDraftText = '';
    rebuildDeviceIndexes();
    renderContent();
  }catch(e){
    alert(failureText('add location', e));
    if(btn){ btn.disabled = false; btn.textContent = 'Add location'; }
  }
}

async function submitAddDevice(){
  const location = addingDeviceFor;
  const getVal = function(id){ const el = document.getElementById('newDevice_' + id); return el ? tidyText(el.value) : ''; };
  const fields = {
    location: location,
    name: getVal('name'), model: getVal('model'), ip: getVal('ip'), ipid: getVal('ipid'),
    zone: getVal('zone'), channel: getVal('channel'), status: getVal('status'), level: getVal('level'),
    avio: getVal('avio'), note: getVal('note'),
    dinRail: getVal('dinRail'), connection: getVal('connection'), cresnetId: getVal('cresnetId'), controller: getVal('controller')
  };
  if(!fields.name){ alert('Device name is required.'); return; }
  const btn = document.getElementById('submitAddDevice');
  if(btn){ btn.disabled = true; btn.textContent = 'Adding...'; }
  try{
    const result = await pushAddDevice(fields);
    DEVICES.push({
      id: result.id, name: fields.name, status: fields.status, level: fields.level, location: location,
      zone: fields.zone, channel: fields.channel, model: fields.model, ip: fields.ip, ipid: fields.ipid,
      avio: fields.avio, note: fields.note, dinRail: fields.dinRail, connection: fields.connection, cresnetId: fields.cresnetId, controller: fields.controller, ports: []
    });
    addingDeviceFor = null;
    deviceDraft = {};
    rebuildDeviceIndexes();
    renderContent();
  }catch(e){
    alert(failureText('add device', e));
    if(btn){ btn.disabled = false; btn.textContent = 'Add device'; }
  }
}

function submitNoteEdit(deviceId){
  const dev = DEVICE_BY_ID[deviceId];
  if(!dev) return;
  const ta = document.getElementById('editNoteText');
  const note = (editNoteText[deviceId] !== undefined ? editNoteText[deviceId] : (ta ? ta.value : '')).trim();
  const by = techName || 'Unnamed tech';
  const at = new Date().toISOString();
  // Applied here straight away and saved on the device; the server gets it when it can.
  dev.note = note;
  dev.noteUpdatedBy = by;
  dev.noteUpdatedAt = at;
  editingNotesId = null;
  delete editNoteText[deviceId];
  saveDeviceCache(Object.assign({}, currentProjectMeta, {deviceCounts: currentSideCounts}), DEVICES, SERVER_LOCATIONS);
  renderContent();
  queueOp('note', deviceId, {note: note, by: by, at: at});
}

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
    queueCheckWrite(deviceId, key, next[key]);
  }
}
function submitPunch(deviceId){
  const dev = DEVICE_BY_ID[deviceId];
  const desc = (punchDraftText[deviceId] || document.getElementById('punchDesc').value || '').trim();
  if(!desc) return;
  const cid = newClientId();
  const tempId = 'local-' + cid;
  const item = {
    id: tempId, clientId: cid, deviceId: deviceId, deviceName: dev.name, location: dev.location, deviceType: DEVICE_TYPE,
    description: desc, severity: pendingSeverity, ownership: pendingOwnership, status: 'open',
    reportedBy: techName || 'Unnamed tech', createdAt: new Date().toISOString()
  };
  punches.push(item);
  openPunchFormFor = null;
  delete punchDraftText[deviceId];
  saveCache();
  renderContent();
  sendPunch(item);
}
function submitLocationPunch(){
  const desc = (locationPunchDraft || (document.getElementById('locationPunchDesc') || {}).value || '').trim();
  if(!desc) return;
  const cid = newClientId();
  const tempId = 'local-' + cid;
  const isProjectWide = addingLocationPunchFor === PROJECT_WIDE_SCOPE;
  const item = {
    id: tempId, clientId: cid, deviceId: null, deviceName: '', location: isProjectWide ? '' : addingLocationPunchFor, deviceType: DEVICE_TYPE,
    description: desc, severity: pendingSeverity, ownership: pendingOwnership, status: 'open',
    reportedBy: techName || 'Unnamed tech', createdAt: new Date().toISOString()
  };
  punches.push(item);
  addingLocationPunchFor = null;
  locationPunchDraft = '';
  saveCache();
  renderContent();
  sendPunch(item);
}
function toggleResolve(punchId){
  const p = punches.find(function(x){ return x.id === punchId; });
  if(!p) return;
  p.status = p.status === 'open' ? 'resolved' : 'open';
  if(p.status === 'resolved'){ p.resolvedBy = techName || 'Unnamed tech'; p.resolvedAt = new Date().toISOString(); }
  else { delete p.resolvedBy; delete p.resolvedAt; }
  saveCache();
  renderContent();
  if(String(p.id).indexOf('local-') !== 0){
    queueOp('resolve', p.id, {status: p.status, by: techName || 'Unnamed tech', at: p.resolvedAt || null});
  }   // (a punch item that hasn't reached the server yet carries its status up with it - see sendPunch)
}

function submitPunchEdit(punchId){
  const p = punches.find(function(x){ return x.id === punchId; });
  if(!p) return;
  const desc = (editDraftText[punchId] !== undefined ? editDraftText[punchId] : (document.getElementById('editPunchDesc') || {}).value || '').trim();
  if(!desc) return;
  p.description = desc;
  p.severity = pendingSeverity;
  p.ownership = pendingOwnership;
  editingPunchId = null;
  delete editDraftText[punchId];
  saveCache();
  renderContent();
  if(String(p.id).indexOf('local-') !== 0){
    queueOp('edit', p.id, {description: desc, severity: p.severity, ownership: p.ownership, by: techName || 'Unnamed tech'});
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
  const rows = [['Location','Device','Description','Severity','Ownership','Status','Reported By','Created','Resolved By','Resolved At']];
  list.forEach(function(p){
    rows.push([(p.location||''), p.deviceName, p.description, p.severity, p.ownership, p.status, p.reportedBy||'', p.createdAt||'', p.resolvedBy||'', p.resolvedAt||'']);
  });
  const csv = rows.map(function(r){ return r.map(csvEscape).join(','); }).join('\r\n');
  try{
    const blob = new Blob([csv], {type: 'text/csv;charset=utf-8;'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'rcrsb-punch-list' + (DEVICE_TYPE === 'lc' ? '-lc' : '') + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
  }catch(e){
    console.error(e);
    alert('Could not export right now. Please try again.');
  }
}

// ---------- device report export (updated Info Sheet, styled .xlsx) ----------
const XL_COLORS = {
  POWER_RED: 'FFC8102E', BLACK: 'FF000000', WHITE: 'FFFFFFFF', STEEL: 'FFE6E6E6',
  GRAVEL_BG: 'FFEDEDED', GRAVEL_TXT: 'FF53565A',
  PASS_BG: 'FFDCEFE1', PASS_TXT: 'FF1F7A4D',
  FAIL_BG: 'FFF9DADF', FAIL_TXT: 'FFC8102E',
  OPEN_BG: 'FFFCEEDD', OPEN_TXT: 'FFB5620A',
  RESOLVED_BG: 'FFDCEFE1', RESOLVED_TXT: 'FF1F7A4D',
  MINOR_BG: 'FFEDEDED', MINOR_TXT: 'FF53565A',
  MAJOR_BG: 'FFFCEEDD', MAJOR_TXT: 'FFB5620A',
  CRITICAL_BG: 'FFF9DADF', CRITICAL_TXT: 'FFC8102E',
  // Ownership colors are deliberately a different hue family (teal/violet/gold)
  // than severity's red/amber/gray - Severity and Ownership sit side by side
  // in the same row, so reusing that palette would make it look like
  // Ownership was also signaling urgency.
  OWN_FIELD_BG: 'FFDFF5F2', OWN_FIELD_TXT: 'FF0E7C71',
  OWN_PROGRAMMING_BG: 'FFEFE6FB', OWN_PROGRAMMING_TXT: 'FF6B3FC2',
  OWN_CONFIG_BG: 'FFFBF1D2', OWN_CONFIG_TXT: 'FF8A6D14'
};
function xlFill(argb){ return {type:'pattern', pattern:'solid', fgColor:{argb: argb}}; }

// Every timestamp is stored as UTC (new Date().toISOString() in the
// Worker) - correct for storage, but not what anyone wants to read in a
// spreadsheet. This converts to US Eastern time for display in the
// export only; the underlying stored data stays UTC. Uses the real
// America/New_York timezone rules (not a fixed -5), so it correctly
// shows EDT in summer and EST in winter instead of being an hour off
// half the year.
function formatEasternTime(iso){
  if(!iso) return '';
  try{
    const d = new Date(iso);
    if(isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
      timeZoneName: 'short'
    }).format(d);
  }catch(e){ return iso; }
}
function checkCellStyle(v){
  if(v === 'pass') return {label:'Pass', bg: XL_COLORS.PASS_BG, txt: XL_COLORS.PASS_TXT};
  if(v === 'fail') return {label:'Fail', bg: XL_COLORS.FAIL_BG, txt: XL_COLORS.FAIL_TXT};
  return {label:'Untested', bg: XL_COLORS.GRAVEL_BG, txt: XL_COLORS.GRAVEL_TXT};
}
function severityCellStyle(sev){
  if(sev === 'critical') return {bg: XL_COLORS.CRITICAL_BG, txt: XL_COLORS.CRITICAL_TXT};
  if(sev === 'major') return {bg: XL_COLORS.MAJOR_BG, txt: XL_COLORS.MAJOR_TXT};
  return {bg: XL_COLORS.MINOR_BG, txt: XL_COLORS.MINOR_TXT};
}
function ownershipCellStyle(own){
  if(own === 'Field Tech/Install') return {bg: XL_COLORS.OWN_FIELD_BG, txt: XL_COLORS.OWN_FIELD_TXT};
  if(own === 'Programming') return {bg: XL_COLORS.OWN_PROGRAMMING_BG, txt: XL_COLORS.OWN_PROGRAMMING_TXT};
  if(own === 'Configuration') return {bg: XL_COLORS.OWN_CONFIG_BG, txt: XL_COLORS.OWN_CONFIG_TXT};
  return {bg: XL_COLORS.GRAVEL_BG, txt: XL_COLORS.GRAVEL_TXT};
}
function statusCellStyle(status){
  return status === 'resolved'
    ? {bg: XL_COLORS.RESOLVED_BG, txt: XL_COLORS.RESOLVED_TXT}
    : {bg: XL_COLORS.OPEN_BG, txt: XL_COLORS.OPEN_TXT};
}
function styleHeaderRow(row, count){
  for(let i = 1; i <= count; i++){
    const c = row.getCell(i);
    c.font = {name:'Arial', size:12, bold:true, color:{argb: XL_COLORS.WHITE}};
    c.fill = xlFill(XL_COLORS.BLACK);
    c.alignment = {vertical:'middle', wrapText:true};
  }
  row.height = 22;
}
function sanitizeFilenamePart(s){
  return String(s || '').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim();
}

async function exportDeviceReport(){
  if(typeof ExcelJS === 'undefined'){
    alert('The Excel export library didn\'t load - check your connection and reload the page.');
    return;
  }
  const btn = document.getElementById('exportReportBtn');
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Building…';

  try{
    const wb = new ExcelJS.Workbook();
    const projectDisplayName = currentProjectMeta.name || currentProject;

    // ---- Sheet 1: Device Report ----
    const ws = wb.addWorksheet('Device Report');
    ws.mergeCells('A1:' + (DEVICE_TYPE === 'lc' ? 'V' : 'R') + '1');
    const title = ws.getCell('A1');
    title.value = projectDisplayName + ' - ' + (DEVICE_TYPE === 'lc' ? 'LC ' : '') + 'Device Report';
    title.font = {name:'Arial', size:18, bold:true, color:{argb: XL_COLORS.POWER_RED}};
    ws.getRow(1).height = 32;

    // "Device ID" is the stable join key for re-importing this file later
    // (see importChecklistResults) - device Name alone isn't reliable
    // since some projects reuse the same name across different rooms.
    let deviceHeaders = '';
    const avDeviceHeaders = ['Device ID','Location','Level','Device Name','Zone','Amp Channel','Manufacturer | Model','IP Address','IP ID','AV I/O','Power','Network','Function','Updated By','Updated At','Note','Note Updated By','Note Updated At'];
    const lcDeviceHeaders = ['Device ID','Location','Device Name','Model','Cresnet ID','DIN Rail','Processor','IP Address','IP ID', 'Connection','Power','Network','Function','Updated By','Updated At','Note','Note Updated By','Note Updated At'];
    if(DEVICE_TYPE === 'av'){
      deviceHeaders = avDeviceHeaders;
    }
    else if(DEVICE_TYPE === 'lc'){
      deviceHeaders = lcDeviceHeaders
    }
    const deviceHeaderRow = ws.getRow(3);
    deviceHeaders.forEach(function(h, i){ deviceHeaderRow.getCell(i+1).value = h; });
    styleHeaderRow(deviceHeaderRow, deviceHeaders.length);

    const sortedDevices = DEVICES.slice().sort(function(a,b){
      if(a.location !== b.location) return a.location < b.location ? -1 : 1;
      return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    });
    if(DEVICE_TYPE === 'av'){
    let r = 4;
    sortedDevices.forEach(function(d, idx){
      const c = getCheck(d.id);
      const row = ws.getRow(r);
      const band = (idx % 2 === 1) ? XL_COLORS.STEEL : XL_COLORS.WHITE;
      const idCell = row.getCell(1);
      idCell.value = d.id;
      idCell.fill = xlFill(band);
      idCell.font = {color:{argb: XL_COLORS.GRAVEL_TXT}, italic:true};
      const plainVals = [d.location, d.level, d.name, d.zone, d.channel, d.model, d.ip, d.ipid, d.avio];
      plainVals.forEach(function(v, i){
        const cell = row.getCell(i+2);
        cell.value = v || '';
        cell.fill = xlFill(band);
      });
      [c.power, c.network, c.function].forEach(function(v, i){
        const st = checkCellStyle(v);
        const cell = row.getCell(11+i);
        cell.value = st.label;
        cell.fill = xlFill(st.bg);
        cell.font = {bold:true, color:{argb: st.txt}};
      });
      // Audit trail: who last touched a Power/Network/Function check on
      // this device, and when, this is the accountability record for
      // the exported sheet, not just a snapshot of the current status.
      const updByCell = row.getCell(14);
      updByCell.value = c.updatedBy || '';
      updByCell.fill = xlFill(band);
      const updAtCell = row.getCell(15);
      updAtCell.value = formatEasternTime(c.updatedAt);
      updAtCell.fill = xlFill(band);
      const noteCell = row.getCell(16);
      noteCell.value = d.note || '';
      noteCell.fill = xlFill(band);
      const noteByCell = row.getCell(17);
      noteByCell.value = d.noteUpdatedBy || '';
      noteByCell.fill = xlFill(band);
      const noteAtCell = row.getCell(18);
      noteAtCell.value = formatEasternTime(d.noteUpdatedAt);
      noteAtCell.fill = xlFill(band);
      if(DEVICE_TYPE === 'lc'){
        [d.cresnetId, d.controller, d.dinRail, d.connection].forEach(function(v, i){
          const cell = row.getCell(19 + i);
          cell.value = v || '';
          cell.fill = xlFill(band);
        });
      }
      r++;
    });

    const devWidths = [{width:20},{width:26},{width:12},{width:20},{width:12},{width:14},{width:26},{width:15},{width:12},{width:20},{width:11},{width:11},{width:11},{width:16},{width:19},{width:30},{width:16},{width:19}];
    if(DEVICE_TYPE === 'lc') devWidths.push({width:12},{width:28},{width:14},{width:16});
    ws.columns = devWidths;
    ws.views = [{state:'frozen', ySplit:3}];
  }
  else if(DEVICE_TYPE === 'lc'){
    let r = 4;
    sortedDevices.forEach(function(d, idx){
      const c = getCheck(d.id);
      const row = ws.getRow(r);
      const band = (idx % 2 === 1) ? XL_COLORS.STEEL : XL_COLORS.WHITE;
      const idCell = row.getCell(1);
      idCell.value = d.id;
      idCell.fill = xlFill(band);
      idCell.font = {color:{argb: XL_COLORS.GRAVEL_TXT}, italic:true};
      const plainVals = [d.location, d.name, d.model, d.cresnetId, d.dinRail, d.controller, d.ip, d.ipid, d.connection];
      plainVals.forEach(function(v, i){
        const cell = row.getCell(i+2);
        cell.value = v || '';
        cell.fill = xlFill(band);
      });
      [c.power, c.network, c.function].forEach(function(v, i){
        const st = checkCellStyle(v);
        const cell = row.getCell(11+i);
        cell.value = st.label;
        cell.fill = xlFill(st.bg);
        cell.font = {bold:true, color:{argb: st.txt}};
      });
      // Audit trail: who last touched a Power/Network/Function check on
      // this device, and when, this is the accountability record for
      // the exported sheet, not just a snapshot of the current status.
      const updByCell = row.getCell(14);
      updByCell.value = c.updatedBy || '';
      updByCell.fill = xlFill(band);
      const updAtCell = row.getCell(15);
      updAtCell.value = formatEasternTime(c.updatedAt);
      updAtCell.fill = xlFill(band);
      const noteCell = row.getCell(16);
      noteCell.value = d.note || '';
      noteCell.fill = xlFill(band);
      const noteByCell = row.getCell(17);
      noteByCell.value = d.noteUpdatedBy || '';
      noteByCell.fill = xlFill(band);
      const noteAtCell = row.getCell(18);
      noteAtCell.value = formatEasternTime(d.noteUpdatedAt);
      noteAtCell.fill = xlFill(band);
      r++;
    });

    const devWidths = [{width:20},{width:26},{width:20},{width:26},{width:15},{width:12},{width:20},{width:20},{width:11},{width:16},{width:19},{width:19},{width:25},{width:25},{width:25},{width:25},{width:25},{width:25}];
    ws.columns = devWidths;
    ws.views = [{state:'frozen', ySplit:3}];
  }

    // ---- Sheet 2: Punch List ----
    const pl = wb.addWorksheet('Punch List');
    pl.mergeCells('A1:M1');
    const plTitle = pl.getCell('A1');
    plTitle.value = projectDisplayName + ' - Punch List';
    plTitle.font = {name:'Arial', size:18, bold:true, color:{argb: XL_COLORS.POWER_RED}};
    pl.getRow(1).height = 32;

    // "Punch ID" and "Device ID" are the join keys re-import uses (see
    // Import Results in admin.html). Leave "Punch ID" blank on a new row
    // you type by hand to log a new issue offline - it'll be created as
    // new on import. Leave it filled in on an existing row to update it.
    // "Level" isn't stored on a punch item directly (only devices have
    // one) - looked up from the device this punch is against instead.
    const punchHeaders = ['Punch ID','Device ID','Location','Level','Device Name','Description','Severity','Ownership','Status','Reported By','Created','Resolved By','Resolved At'];
    const punchHeaderRow = pl.getRow(3);
    punchHeaders.forEach(function(h, i){ punchHeaderRow.getCell(i+1).value = h; });
    styleHeaderRow(punchHeaderRow, punchHeaders.length);

    const sortedPunches = punches.slice().sort(function(a,b){ return (b.createdAt||'').localeCompare(a.createdAt||''); });

    let pr = 4;
    sortedPunches.forEach(function(p, idx){
      const row = pl.getRow(pr);
      const band = (idx % 2 === 1) ? XL_COLORS.STEEL : XL_COLORS.WHITE;

      const idCell = row.getCell(1);
      idCell.value = p.id || '';
      idCell.fill = xlFill(band);
      idCell.font = {color:{argb: XL_COLORS.GRAVEL_TXT}, italic:true};
      const devIdCell = row.getCell(2);
      devIdCell.value = p.deviceId || '';
      devIdCell.fill = xlFill(band);
      devIdCell.font = {color:{argb: XL_COLORS.GRAVEL_TXT}, italic:true};

      const dev = DEVICE_BY_ID[p.deviceId];
      const plainVals = [p.location || '', (dev && dev.level) || '', p.deviceName || '', p.description || ''];
      plainVals.forEach(function(v, i){
        const cell = row.getCell(i+3);
        cell.value = v;
        cell.fill = xlFill(band);
      });
      const sevStyle = severityCellStyle(p.severity);
      const sevCell = row.getCell(7);
      sevCell.value = (p.severity || '').charAt(0).toUpperCase() + (p.severity || '').slice(1);
      sevCell.fill = xlFill(sevStyle.bg);
      sevCell.font = {bold:true, color:{argb: sevStyle.txt}};

      const ownStyle = ownershipCellStyle(p.ownership);
      const ownCell = row.getCell(8);
      ownCell.value = p.ownership || '';
      ownCell.fill = xlFill(ownStyle.bg);
      ownCell.font = {bold:true, color:{argb: ownStyle.txt}};

      const statStyle = statusCellStyle(p.status);
      const statCell = row.getCell(9);
      statCell.value = p.status === 'resolved' ? 'Resolved' : 'Open';
      statCell.fill = xlFill(statStyle.bg);
      statCell.font = {bold:true, color:{argb: statStyle.txt}};

      // reportedBy: the tech who submitted this punch item
      const tailVals = [p.reportedBy || '', formatEasternTime(p.createdAt), p.resolvedBy || '', formatEasternTime(p.resolvedAt)];
      tailVals.forEach(function(v, i){
        const cell = row.getCell(10+i);
        cell.value = v;
        cell.fill = xlFill(band);
      });
      pr++;
    });

    pl.columns = [{width:20},{width:20},{width:22},{width:12},{width:18},{width:38},{width:11},{width:16},{width:11},{width:16},{width:19},{width:16},{width:19}];
    pl.views = [{state:'frozen', ySplit:3}];

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], {type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
    const url = URL.createObjectURL(blob);
    const dateStr = new Date().toISOString().slice(0,10);
    const filename = sanitizeFilenamePart(projectDisplayName) + (DEVICE_TYPE === 'lc' ? '_LC' : '') + '_InfoSheet_' + dateStr + '.xlsx';
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
  }catch(e){
    console.error(e);
    alert('Could not build the export right now. Please try again.');
  }finally{
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}
document.getElementById('exportReportBtn').addEventListener('click', exportDeviceReport);

// ---------- changes waiting to reach the server ----------
// Every change is applied on screen and saved ON THE DEVICE first, and only forgotten
// once the server has confirmed it - so closing the app, losing the signal, or the
// iPad restarting never loses work. They are sent whenever the app is open and can
// reach the server (iOS has no background sync, so a closed app can't send). Each
// kind of change is safe to send twice, which is what makes retrying safe:
//   Pass/Fail taps, resolve, edit punch, edit note: they SET a value
//   a new punch item: carries its own id, which the server uses to ignore a repeat
function newClientId(){
  try{ if(window.crypto && crypto.randomUUID) return crypto.randomUUID(); }catch(e){}
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

// The server understood and refused (unknown id, invalid value...): sending it again can never help.
// Anything else - no connection, a timeout, a server hiccup - is worth retrying.
function isPermanentFailure(e){
  return !!(e && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429);
}

function failureText(what, e){
  if(e && e.status) return 'Could not ' + what + ': ' + e.message;
  return 'No connection - this needs the server (' + what + '). What you typed is still on screen; try again when you are back online.';
}

function pendingKey(kind){ return 'pd_pending_' + kind + '_' + currentProject + '_' + DEVICE_TYPE; }

function persistPendingChecks(){
  try{
    const out = {};
    Object.keys(localCheckEdits).forEach(function(k){
      const e = localCheckEdits[k];
      if(e.status !== 'settled') out[k] = {deviceId: e.deviceId, key: e.key, value: e.value, by: e.by};
    });
    if(Object.keys(out).length) localStorage.setItem(pendingKey('checks'), JSON.stringify(out));
    else localStorage.removeItem(pendingKey('checks'));
  }catch(e){}
}

function restorePendingChecks(){
  try{
    const raw = localStorage.getItem(pendingKey('checks'));
    if(!raw) return;
    const saved = JSON.parse(raw);
    Object.keys(saved).forEach(function(k){
      const s = saved[k];
      if(!s || !s.deviceId || !s.key) return;
      const value = s.value === undefined ? null : s.value;
      localCheckEdits[k] = {deviceId: s.deviceId, key: s.key, value: value, by: s.by, status: 'idle', sentValue: undefined, settledAt: null};
      const cur = Object.assign({power: null, network: null, function: null}, checklist[s.deviceId]);
      cur[s.key] = value;
      checklist[s.deviceId] = cur;
    });
  }catch(e){}
}

// Resolve / edit punch / edit note. One waiting change per item and kind (the latest wins).
const pendingOps = {};   // 'kind|id' -> {kind, id, data, status, settledAt}

function persistPendingOps(){
  try{
    const out = {};
    Object.keys(pendingOps).forEach(function(k){
      const e = pendingOps[k];
      if(e.status !== 'settled') out[k] = {kind: e.kind, id: e.id, data: e.data};
    });
    if(Object.keys(out).length) localStorage.setItem(pendingKey('ops'), JSON.stringify(out));
    else localStorage.removeItem(pendingKey('ops'));
  }catch(e){}
}

function restorePendingOps(){
  try{
    const raw = localStorage.getItem(pendingKey('ops'));
    if(!raw) return;
    const saved = JSON.parse(raw);
    Object.keys(saved).forEach(function(k){
      const s = saved[k];
      if(s && s.kind && s.id && s.data) pendingOps[k] = {kind: s.kind, id: s.id, data: s.data, status: 'idle', settledAt: null};
    });
  }catch(e){}
}

function queueOp(kind, id, data){
  const k = kind + '|' + id;
  let e = pendingOps[k];
  if(!e){
    e = pendingOps[k] = {kind: kind, id: id, data: data, status: 'idle', settledAt: null};
  }else{
    e.data = data;
    e.settledAt = null;
    if(e.status === 'settled') e.status = 'idle';
  }
  persistPendingOps();
  renderSyncStatus();
  sendOp(e);
}

function sendOp(e){
  if(e.status === 'sending' || !syncConfigured()) return;
  e.status = 'sending';
  const sig = JSON.stringify(e.data);
  let req;
  if(e.kind === 'resolve') req = pushSetPunchStatus(e.id, e.data.status, e.data.by);
  else if(e.kind === 'edit') req = pushEditPunch(e.id, e.data.description, e.data.severity, e.data.ownership, e.data.by);
  else req = pushEditNote(e.id, e.data.note);
  req.then(function(result){
    e.settledAt = ++checkClock;
    if(JSON.stringify(e.data) !== sig){ e.status = 'idle'; sendOp(e); }
    else{
      e.status = 'settled';
      const dev = (e.kind === 'note' && result) ? DEVICE_BY_ID[e.id] : null;
      if(dev && result.noteUpdatedAt){ dev.noteUpdatedBy = result.noteUpdatedBy; dev.noteUpdatedAt = result.noteUpdatedAt; }
    }
    persistPendingOps();
    renderSyncStatus();
  }).catch(function(err){
    console.error(err);
    if(isPermanentFailure(err)) delete pendingOps[e.kind + '|' + e.id];
    else e.status = 'failed';
    persistPendingOps();
    renderSyncStatus();
  });
}

function flushPendingOps(){
  Object.keys(pendingOps).forEach(function(k){
    const e = pendingOps[k];
    if(e.status === 'failed' || e.status === 'idle') sendOp(e);
  });
}

// What the server says + the changes still waiting to reach it = what's shown.
function applyPendingOps(){
  Object.keys(pendingOps).forEach(function(k){
    const e = pendingOps[k];
    if(e.kind === 'note'){
      const d = DEVICE_BY_ID[e.id];
      if(d){ d.note = e.data.note; d.noteUpdatedBy = e.data.by; d.noteUpdatedAt = e.data.at; }
      return;
    }
    const p = punches.find(function(x){ return x.id === e.id; });
    if(!p) return;
    if(e.kind === 'resolve'){
      p.status = e.data.status;
      if(p.status === 'resolved'){ p.resolvedBy = e.data.by; p.resolvedAt = e.data.at; }
      else{ delete p.resolvedBy; delete p.resolvedAt; }
    }else{
      p.description = e.data.description;
      p.severity = e.data.severity;
      p.ownership = e.data.ownership;
    }
  });
}

// New punch items. Safe to retry (they carry their own id), but never two requests for one item at once.
const punchesInFlight = {};
function sendPunch(item){
  if(!syncConfigured()) return;
  if(String(item.id).indexOf('local-') !== 0 || punchesInFlight[item.id] || item.syncError) return;
  const localId = item.id;
  punchesInFlight[localId] = true;
  pushPunch(item).then(function(res){
    item.id = res.id;
    delete item.clientId;
    item.syncedClock = ++checkClock;     // lets a poll that started before this keep the item instead of dropping it
    // resolved while it was still waiting to go up: the status follows it
    if(item.status === 'resolved') queueOp('resolve', item.id, {status: 'resolved', by: item.resolvedBy || techName || 'Unnamed tech', at: item.resolvedAt || null});
    saveCache();
    if(isComposingPunch()) renderStats(); else renderContent();
  }).catch(function(err){
    console.error(err);
    if(isPermanentFailure(err)){ item.syncError = err.message; saveCache(); }   // kept on the device, tried again next launch
    renderSyncStatus();
  }).then(function(){ delete punchesInFlight[localId]; });
}

function flushPendingPunches(){
  punches.filter(function(p){ return String(p.id).indexOf('local-') === 0; }).forEach(sendPunch);
}

function flushAllPending(){
  flushPendingChecks();
  flushPendingOps();
  flushPendingPunches();
}

function pendingCount(){
  let n = 0;
  Object.keys(localCheckEdits).forEach(function(k){ if(localCheckEdits[k].status !== 'settled') n++; });
  Object.keys(pendingOps).forEach(function(k){ if(pendingOps[k].status !== 'settled') n++; });
  punches.forEach(function(p){ if(String(p.id).indexOf('local-') === 0 && !p.syncError) n++; });
  return n;
}

// One line, always in the same place, saying what state the data is in.
function renderSyncStatus(){
  let el = document.getElementById('syncStatus');
  if(!el){
    const content = document.getElementById('content');
    if(!content || !content.parentNode) return;
    el = document.createElement('div');
    el.id = 'syncStatus';
    el.className = 'offline-banner';
    el.setAttribute('role', 'status');
    el.style.margin = '10px 16px 0';
    content.parentNode.insertBefore(el, content);
  }
  const n = pendingCount();
  const bad = punches.filter(function(p){ return p.syncError; }).length;
  const s = function(count, word){ return count + ' ' + word + (count === 1 ? '' : 's'); };
  let msg = '';
  if(!syncEnabled){
    msg = n
      ? 'Offline - ' + s(n, 'change') + ' saved on this device. They will sync when you are back online.'
      : 'Offline - working from the copy saved on this device. Changes you make are kept and will sync when you are back online.';
  }else if(n){
    msg = 'Syncing ' + s(n, 'change') + '...';
  }
  if(bad) msg += (msg ? ' ' : '') + s(bad, 'punch item') + ' could not be saved to the server (kept on this device).';
  el.hidden = !msg;
  el.innerHTML = msg ? '<span class="dot"></span> ' + esc(msg) : '';
}

setInterval(flushPendingPunches, 20000);

// Coming back to the app, or the connection returning, is the moment to send what's waiting.
window.addEventListener('online', function(){ if(currentProject) syncFromRemote(); });
document.addEventListener('visibilitychange', function(){ if(document.visibilityState === 'visible' && currentProject) syncFromRemote(); });
window.addEventListener('pageshow', function(e){ if(e.persisted && currentProject) syncFromRemote(); });

// ---------- events ----------
document.getElementById('content').addEventListener('click', function(e){
  const locCard = e.target.closest('[data-loc]');
  if(locCard){ currentLocation = locCard.getAttribute('data-loc'); view = 'location-detail'; searchQuery=''; document.getElementById('searchInput').value=''; renderContent(); return; }

  const addLocationBtn = e.target.closest('#addLocationBtn');
  if(addLocationBtn){ addingLocation = true; locationDraftText = ''; renderContent(); return; }
  const cancelAddLocationBtn = e.target.closest('#cancelAddLocation');
  if(cancelAddLocationBtn){ addingLocation = false; locationDraftText = ''; renderContent(); return; }
  const submitAddLocationBtn = e.target.closest('#submitAddLocation');
  if(submitAddLocationBtn){ submitAddLocation(); return; }
  const addDeviceBtn = e.target.closest('#addDeviceBtn');
  if(addDeviceBtn){ addingDeviceFor = currentLocation; deviceDraft = {}; renderContent(); return; }
  const cancelAddDeviceBtn = e.target.closest('#cancelAddDevice');
  if(cancelAddDeviceBtn){ addingDeviceFor = null; deviceDraft = {}; renderContent(); return; }
  const submitAddDeviceBtn = e.target.closest('#submitAddDevice');
  if(submitAddDeviceBtn){ submitAddDevice(); return; }

  const addLocationPunchBtn = e.target.closest('#addLocationPunchBtn');
  if(addLocationPunchBtn){
    addingLocationPunchFor = currentLocation; locationPunchDraft = '';
    pendingSeverity = 'major'; pendingOwnership = 'Field Tech/Install';
    renderContent();
    setTimeout(function(){ const ta = document.getElementById('locationPunchDesc'); if(ta) ta.focus(); }, 0);
    return;
  }
  const addProjectPunchBtn = e.target.closest('#addProjectPunchBtn');
  if(addProjectPunchBtn){
    addingLocationPunchFor = PROJECT_WIDE_SCOPE; locationPunchDraft = '';
    pendingSeverity = 'major'; pendingOwnership = 'Field Tech/Install';
    renderContent();
    setTimeout(function(){ const ta = document.getElementById('locationPunchDesc'); if(ta) ta.focus(); }, 0);
    return;
  }
  const cancelLocationPunchBtn = e.target.closest('#cancelLocationPunch');
  if(cancelLocationPunchBtn){ addingLocationPunchFor = null; locationPunchDraft = ''; renderContent(); return; }
  const submitLocationPunchBtn = e.target.closest('#submitLocationPunch');
  if(submitLocationPunchBtn){ submitLocationPunch(); return; }

  const editNoteBtn = e.target.closest('[data-editnote]');
  if(editNoteBtn){
    const id = editNoteBtn.getAttribute('data-editnote');
    editingNotesId = id;
    renderContent();
    return;
  }
  const cancelEditNoteBtn = e.target.closest('#cancelEditNote');
  if(cancelEditNoteBtn){
    const id = cancelEditNoteBtn.getAttribute('data-device');
    delete editNoteText[id];
    editingNotesId = null;
    renderContent();
    return;
  }
  const saveEditNoteBtn = e.target.closest('#saveEditNote');
  if(saveEditNoteBtn){ submitNoteEdit(saveEditNoteBtn.getAttribute('data-device')); return; }

  const backBtn = e.target.closest('#backBtn');
  if(backBtn){ view = 'locations'; renderContent(); return; }

  const checkPill = e.target.closest('.check-pill');
  if(checkPill){ toggleCheck(checkPill.getAttribute('data-device'), checkPill.getAttribute('data-check')); return; }

  const addBtn = e.target.closest('.punch-add-btn');
  if(addBtn){ openPunchFormFor = addBtn.getAttribute('data-device'); pendingSeverity='major'; pendingOwnership='Field Tech/Install'; renderContent();
    setTimeout(function(){ const ta = document.getElementById('punchDesc'); if(ta) ta.focus(); }, 0); return; }

  const cancelBtn = e.target.closest('#cancelPunch');
  if(cancelBtn){ delete punchDraftText[openPunchFormFor]; openPunchFormFor = null; renderContent(); return; }

  const cancelEditBtn = e.target.closest('#cancelEditPunch');
  if(cancelEditBtn){ delete editDraftText[editingPunchId]; editingPunchId = null; renderContent(); return; }

  const sevBtn = e.target.closest('.sev-btn');
  if(sevBtn){
    pendingSeverity = sevBtn.getAttribute('data-sev');
    renderContent();
    const ta = document.getElementById(activePunchTextareaId());
    if(ta){ ta.focus(); const v = ta.value; ta.setSelectionRange(v.length, v.length); }
    return;
  }

  const ownBtn = e.target.closest('.own-btn');
  if(ownBtn){
    pendingOwnership = ownBtn.getAttribute('data-own');
    renderContent();
    const ta = document.getElementById(activePunchTextareaId());
    if(ta){ ta.focus(); const v = ta.value; ta.setSelectionRange(v.length, v.length); }
    return;
  }

  const submitBtn = e.target.closest('#submitPunch');
  if(submitBtn){ submitPunch(submitBtn.getAttribute('data-device')); return; }

  const editPunchBtn = e.target.closest('[data-editpunch]');
  if(editPunchBtn){
    const id = editPunchBtn.getAttribute('data-editpunch');
    const p = punches.find(function(x){ return x.id === id; });
    if(p){
      editingPunchId = id;
      pendingSeverity = p.severity || 'minor';
      pendingOwnership = p.ownership || 'Field Tech/Install';
      renderContent();
      setTimeout(function(){ const ta = document.getElementById('editPunchDesc'); if(ta){ ta.focus(); const v = ta.value; ta.setSelectionRange(v.length, v.length); } }, 0);
    }
    return;
  }

  const saveEditBtn = e.target.closest('#saveEditPunch');
  if(saveEditBtn){ submitPunchEdit(saveEditBtn.getAttribute('data-punch')); return; }

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
  if(isPlainTextBox(e.target) && !e.isComposing) cleanInputBox(e.target);
  if(e.target.id === 'punchDesc' && openPunchFormFor){ punchDraftText[openPunchFormFor] = e.target.value; }
  if(e.target.id === 'editPunchDesc' && editingPunchId){ editDraftText[editingPunchId] = e.target.value; }
  if(e.target.id === 'newLocationName' && addingLocation){ locationDraftText = e.target.value; }
  if(e.target.id === 'locationPunchDesc' && addingLocationPunchFor){ locationPunchDraft = e.target.value; }
  if(e.target.id === 'editNoteText' && editingNotesId){ editNoteText[editingNotesId] = e.target.value; }
  if(e.target.id === 'punchDesc' || e.target.id === 'locationPunchDesc') persistDraft();
  if(e.target.id && e.target.id.indexOf('newDevice_') === 0 && addingDeviceFor){
    deviceDraft[e.target.id.slice('newDevice_'.length)] = e.target.value;
  }
});

//A composed word (some keyboards build one before ommitting it) is cleaned once it is finished.
document.getElementById('content').addEventListener('compositionend', function(e){
  if(!isPlainTextBox(e.target)) return;
  cleanInputBox(e.target);
  e.target.dispatchEvent(new Event('input', {bubbles: true})); //So the draft picks up the cleaned text
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
  const failBtn = document.getElementById("statFailCard");
  if(name === 'punch'){ punchBtn.classList.add('active'); locBtn.classList.remove('active'); failBtn.classList.remove('active'); }
  else if(name === 'failed-checks'){ failBtn.classList.add('active'); locBtn.classList.remove('active'); punchBtn.classList.remove('active'); }
  else { locBtn.classList.add('active'); punchBtn.classList.remove('active'); failBtn.classList.remove('active'); }
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
  activateTab('failed-checks')
  document.getElementById('searchInput').value = '';
  renderContent();
});
document.querySelectorAll('.stat.clickable').forEach(function(el){
  el.addEventListener('keydown', function(e){
    if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); el.click(); }
  });
});

// ---------- unsent punch drafts ----------
// A half-written punch item is protected two ways, because the browser's
// "leave this page?" warning (beforeunload) can't be relied on everywhere:
// iOS Safari never shows it, and nothing at all fires when a tab or the app is
// swiped away. So the draft is ALSO saved on this device as it is typed (and
// again whenever the page is hidden - the one event iOS does fire) and put
// back the next time this project + side is opened. The app's own ways out
// (Switch side, All Projects, Log out) ask with a normal confirm(), which does
// work on iOS. The browser warning stays for desktop.
const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;   // an older draft is dropped rather than resurfacing days later
let skipUnloadWarning = false;                   // set once a leave has been confirmed, so the browser doesn't ask a second time
let draftSavingOff = false;                      // set at log out, so nothing writes a draft back on the way out
let lastDraftSig = null;

function draftKey(){ return 'pd_draft_' + currentProject + '_' + DEVICE_TYPE; }

// Belt and braces: pick up text the input handler may not have seen yet.
function pullDraftTextFromScreen(){
  const a = document.getElementById('punchDesc');
  if(a && openPunchFormFor) punchDraftText[openPunchFormFor] = a.value;
  const b = document.getElementById('locationPunchDesc');
  if(b && addingLocationPunchFor) locationPunchDraft = b.value;
}

// What counts as unsent: a punch box that is open AND has text in it.
function currentDraft(){
  const dev = (openPunchFormFor && (punchDraftText[openPunchFormFor] || '').trim())
    ? {deviceId: openPunchFormFor, text: punchDraftText[openPunchFormFor]} : null;
  const loc = (addingLocationPunchFor && (locationPunchDraft || '').trim())
    ? {scope: addingLocationPunchFor, text: locationPunchDraft} : null;
  return (dev || loc) ? {dev: dev, loc: loc} : null;
}

function hasUnsentDraft(){
  pullDraftTextFromScreen();
  return !!currentDraft();
}

function persistDraft(){
  if(draftSavingOff || !currentProject) return;
  try{
    pullDraftTextFromScreen();
    const d = currentDraft();
    if(!d){
      if(lastDraftSig !== null){ localStorage.removeItem(draftKey()); lastDraftSig = null; }   // submitted or cancelled
      return;
    }
    const body = {dev: d.dev, loc: d.loc, severity: pendingSeverity, ownership: pendingOwnership};
    const sig = JSON.stringify(body);
    if(sig === lastDraftSig) return;
    localStorage.setItem(draftKey(), JSON.stringify(Object.assign({v: 1, email: callerEmail().toLowerCase(), savedAt: Date.now()}, body)));
    lastDraftSig = sig;
  }catch(e){ /* storage unavailable (private mode, full): the draft just isn't kept */ }
}

// Logging out must not leave someone's half-written punch item on a shared phone.
function discardAllDrafts(){
  draftSavingOff = true;
  try{
    for(let i = localStorage.length - 1; i >= 0; i--){
      const k = localStorage.key(i);
      if(k && k.indexOf('pd_draft_') === 0) localStorage.removeItem(k);
    }
  }catch(e){}
}

function showToast(msg){
  const el = document.createElement('div');
  el.setAttribute('role', 'status');
  el.style.cssText = 'position:fixed;left:50%;bottom:calc(20px + env(safe-area-inset-bottom, 0px));transform:translateX(-50%);width:max-content;max-width:calc(100vw - 32px);background:var(--ink);color:var(--bg);padding:10px 16px;border-radius:12px;font-size:13.5px;font-weight:600;box-shadow:var(--shadow);z-index:100;text-align:center;text-wrap:balance;';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(function(){ el.remove(); }, 5000);
}

// Put a saved draft back: reopen the right form, with the text, severity and
// ownership it had. Only for the same person, only if it's recent, and only if
// the device / location it was for still exists - otherwise it's dropped.
function restoreDraft(){
  const discard = function(){ try{ localStorage.removeItem(draftKey()); }catch(e){} };
  let d = null;
  try{ const raw = localStorage.getItem(draftKey()); d = raw ? JSON.parse(raw) : null; }catch(e){ d = null; }
  if(!d) return;
  if(d.v !== 1 || !d.savedAt || (Date.now() - d.savedAt) > DRAFT_MAX_AGE_MS || (d.email || '') !== callerEmail().toLowerCase()){ discard(); return; }

  const dev = (d.dev && d.dev.text && DEVICE_BY_ID[d.dev.deviceId]) ? DEVICE_BY_ID[d.dev.deviceId] : null;
  const scopeOk = d.loc && d.loc.text && (d.loc.scope === PROJECT_WIDE_SCOPE || LOCATIONS.some(function(l){ return l.name === d.loc.scope; }));
  if(!dev && !scopeOk){ discard(); return; }

  if(dev){ openPunchFormFor = dev.id; punchDraftText[dev.id] = d.dev.text; }
  if(scopeOk){ addingLocationPunchFor = d.loc.scope; locationPunchDraft = d.loc.text; }
  if(['minor', 'major', 'critical'].indexOf(d.severity) !== -1) pendingSeverity = d.severity;
  if(['Field Tech/Install', 'Programming', 'Configuration'].indexOf(d.ownership) !== -1) pendingOwnership = d.ownership;

  // Show where the draft lives (a device draft wins if there are two).
  searchQuery = '';
  const searchBox = document.getElementById('searchInput'); if(searchBox) searchBox.value = '';
  if(dev){ currentLocation = dev.location; view = 'location-detail'; activateTab('locations'); }
  else if(d.loc.scope === PROJECT_WIDE_SCOPE){ view = 'punch'; activateTab('punch'); }
  else { currentLocation = d.loc.scope; view = 'location-detail'; activateTab('locations'); }
  renderContent();

  const where = dev ? 'for ' + (dev.name || dev.id) : (d.loc.scope === PROJECT_WIDE_SCOPE ? 'for the whole project' : 'for ' + d.loc.scope);
  showToast(dev && scopeOk ? 'Restored 2 unsent punch items you were writing' : 'Restored your unsent punch item ' + where);
  setTimeout(function(){ const ta = document.getElementById(dev ? 'punchDesc' : 'locationPunchDesc'); if(ta && ta.scrollIntoView) ta.scrollIntoView({block: 'center'}); }, 0);
}

// The browser's own warning - desktop only in practice. Skipped once a leave
// has been confirmed through the app's own dialog, so nobody is asked twice.
window.addEventListener('beforeunload', function(e){
  if(skipUnloadWarning) return;
  if(hasUnsentDraft()){
    e.preventDefault();
    e.returnValue = '';
  }
});

// The reliable moments on a phone: the page going to the background, or away.
document.addEventListener('visibilitychange', function(){ if(document.visibilityState === 'hidden') persistDraft(); });
window.addEventListener('pagehide', persistDraft);

// For leaving through the app's own buttons. confirm() works on iOS.
function confirmLeaveWithDraft(discarding){
  if(!hasUnsentDraft()) return true;
  const msg = discarding
    ? 'You have an unsent punch item, and logging out will discard it. Log out anyway?'
    : 'You have an unsent punch item. It stays saved on this device and will be here when you come back to this project. Leave now?';
  if(!confirm(msg)) return false;
  skipUnloadWarning = true;
  return true;
}

//Tries to send an update notification when page is closed
//Falls back to a single daily update if this fails
function signalSessionEnd(){
  if(!syncConfigured()) return;
  try{
    navigator.sendBeacon(SYNC_API_BASE.replace(/\/$/, '') + '/api/notify/session-end');
  }catch(e){
    //Best effort attempt
  }
}
window.addEventListener('pagehide', signalSessionEnd);

// ---------- boot ----------
function renderFatalError(title, message){
  document.getElementById('content').innerHTML =
    '<div class="empty" style="padding:60px 20px;">'
    + '<div style="font-weight:800;font-size:16px;margin-bottom:6px;color:var(--ink);">' + esc(title) + '</div>'
    + '<div>' + esc(message) + '</div>'
    + '<div style="margin-top:14px;"><a href="projects.html" style="color:var(--accent);font-weight:700;">&larr; Back to projects</a></div>'
    + '</div>';
}

async function boot(){
  const params = new URLSearchParams(window.location.search);
  const projectId = params.get('project');

  if(!projectId){
    window.location.href = 'projects.html';
    return;
  }
  currentProject = projectId;

  if(!syncConfigured()){
    renderFatalError(
      'Not connected',
      'SYNC_API_BASE is not set in config.js. Device data now lives in the database, so this app can\'t run without a configured Worker. See README.md.'
    );
    return;
  }

  let loaded = false;
  try{
    const data = await fetchDevicesAndMeta();
    DEVICES = data.devices || [];
    SERVER_LOCATIONS = data.locations || [];
    currentProjectMeta = data.project || {name: projectId, shortName: projectId};
    currentAccess = data.access || currentAccess;
    currentSideCounts = data.deviceCounts || currentSideCounts;
    updateSwitchAvailability();
    // the counts ride along in the saved copy, so the header is right offline too
    saveDeviceCache(Object.assign({}, currentProjectMeta, {deviceCounts: currentSideCounts}), DEVICES, SERVER_LOCATIONS);
    syncEnabled = true;
    loaded = true;
  }catch(e){
    console.error(e);
    const cached = loadDeviceCache();
    if(cached && cached.devices && cached.devices.length){
      DEVICES = cached.devices;
      SERVER_LOCATIONS = cached.locations || [];
      currentProjectMeta = cached.meta || {name: projectId, shortName: projectId};
      currentSideCounts = (cached.meta && cached.meta.deviceCounts) || null;
      updateSwitchAvailability();
      syncEnabled = false;
      loaded = true;
    }
  }

  if(!loaded){
    renderFatalError(
      'Couldn\'t load this project',
      'No connection to the server and no offline copy saved on this device yet. Check your connection and try again.'
    );
    return;
  }

  rebuildDeviceIndexes();
  document.getElementById('projTitle').textContent = DEVICE_TYPE_LABEL + ' Commissioning';
  document.getElementById('projSub').textContent =
    (currentProjectMeta.shortName || currentProjectMeta.name) + ' · ' + currentProjectMeta.name;
  document.title = (currentProjectMeta.shortName || currentProjectMeta.name) + ' ' + DEVICE_TYPE_LABEL + ' Commissioning';

  loadCache();
  restorePendingChecks();
  restorePendingOps();
  applyPendingOps();
  renderContent();
  restoreDraft();

  // Real-time push (onSnapshot) isn't available with this backend, so instead
  // we do an immediate sync on load, then poll on an interval. Every write
  // still applies to the local copy immediately (optimistic UI) before the
  // network call goes out, so the app feels instant even on a slow connection.
  syncFromRemote();
  pollTimer = setInterval(syncFromRemote, SYNC_POLL_MS);
}

// Side switcher + logout. Switching stays in the SAME project - it just
// opens the project's other side - and the person is already identified
// by email, so nothing is bypassed. An unsent punch draft still gets the
// existing beforeunload warning, same as any other way of leaving this
// page. Log out clears everything, including a cached admin password
// that would otherwise linger on a shared computer.
// "Switch to LC/AV" only shows when this person was granted the other side of
// this project - otherwise it would just open a side they weren't given.
function updateSwitchAvailability(){
  const other = DEVICE_TYPE === 'lc' ? 'av' : 'lc';
  const noAccess = currentAccess[other] === false;
  const nothingThere = !!currentSideCounts && currentSideCounts[other] === 0;
  const hide = noAccess || nothingThere;
  // the link and the "·" between it and Log out go together
  ['switchSideLink', 'switchSideSep'].forEach(function(id){
    const el = document.getElementById(id);
    if(el) el.hidden = hide;
  });
}

(function setupSessionControls(){
  const other = DEVICE_TYPE === 'lc' ? 'av' : 'lc';
  const switchLink = document.getElementById('switchSideLink');
  if(switchLink){
    switchLink.textContent = 'Switch to ' + other.toUpperCase();
    switchLink.addEventListener('click', function(e){
      e.preventDefault();
      if(!confirmLeaveWithDraft(false)) return;
      try{ sessionStorage.setItem('pd_device_type', other); }catch(err){}
      window.location.href = 'index.html?project=' + encodeURIComponent(currentProject || '') + '&type=' + other;
    });
  }
  const logoutLink = document.getElementById('logoutLink');
  if(logoutLink){
    logoutLink.addEventListener('click', function(e){
      e.preventDefault();
      if(hasUnsentDraft()){
        if(!confirmLeaveWithDraft(true)) return;
      }else if(!confirm(pendingCount() ? 'You have changes that have not synced yet. They stay saved on this device and will sync the next time the app is open with a connection. Log out anyway?' : 'Are you sure you want to log out?')) return;
      discardAllDrafts();
      try{
        sessionStorage.removeItem('pd_user_email');
        sessionStorage.removeItem('pd_tech_name');
        sessionStorage.removeItem('pd_device_type');
        sessionStorage.removeItem('pd_admin_pw');
      }catch(err){}
      window.location.replace('login.html');
    });
  }
  document.querySelectorAll('a[href="projects.html"]').forEach(function(a){
    a.addEventListener('click', function(e){ if(!confirmLeaveWithDraft(false)) e.preventDefault(); });
  });
})();

boot();