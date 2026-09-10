// ─────────────────────────────────────────────────────────────
// Admin panel — password-gated project management.
//
// The password is sent as the X-Admin-Password header on every admin
// request; the Worker checks it server-side (see worker/index.js). It's
// cached in sessionStorage only (cleared when the tab closes), never
// localStorage, so it doesn't linger on a shared computer.
//
// Excel parsing mirrors ExtractData.py's column layout exactly:
// Device Info sheet, rows starting at 3, columns B/C/D/E/F/H/I/J/K.
// Port Map sheets (any sheet named "Port Map | ..."), rows starting
// at 7, columns A/B/C/G/H, joined to devices by exact name match.
// If your Info Sheet format ever changes, update parseWorkbook() here
// to match — this is the one place that assumption lives.
// ─────────────────────────────────────────────────────────────

function syncConfigured(){
  return typeof SYNC_API_BASE !== 'undefined' && SYNC_API_BASE && SYNC_API_BASE.indexOf('REPLACE-WITH') === -1;
}

function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
  });
}

function showMsg(el, text, kind){
  el.innerHTML = text ? '<div class="status-msg ' + kind + '">' + esc(text) + '</div>' : '';
}

// ---------- admin auth ----------
const PW_KEY = 'pd_admin_pw';

async function adminFetch(path, options){
  const pw = sessionStorage.getItem(PW_KEY) || '';
  const res = await fetch(SYNC_API_BASE.replace(/\/$/, '') + path, Object.assign({
    headers: Object.assign({'Content-Type': 'application/json', 'X-Admin-Password': pw}, (options && options.headers) || {})
  }, options));
  if(res.status === 401){
    sessionStorage.removeItem(PW_KEY);
    showGate('Session expired or password changed — enter it again.');
    throw new Error('Unauthorized');
  }
  const data = await res.json().catch(function(){ return {}; });
  if(!res.ok){
    throw new Error(data.error || ('Request failed (' + res.status + ')'));
  }
  return data;
}

function showGate(message){
  document.getElementById('gate').hidden = false;
  document.getElementById('panel').hidden = true;
  if(message) showMsg(document.getElementById('gateMsg'), message, 'err');
}
function showPanel(){
  document.getElementById('gate').hidden = true;
  document.getElementById('panel').hidden = false;
  loadProjectList();
}

async function tryUnlock(password){
  const res = await fetch(SYNC_API_BASE.replace(/\/$/, '') + '/api/admin/verify', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Admin-Password': password}
  });
  if(res.ok){
    sessionStorage.setItem(PW_KEY, password);
    showPanel();
  }else{
    showMsg(document.getElementById('gateMsg'), 'Incorrect password.', 'err');
  }
}

document.getElementById('pwSubmit').addEventListener('click', function(){
  const pw = document.getElementById('pwInput').value;
  if(!pw) return;
  tryUnlock(pw);
});
document.getElementById('pwInput').addEventListener('keydown', function(e){
  if(e.key === 'Enter') document.getElementById('pwSubmit').click();
});

// ---------- project list ----------
async function loadProjectList(){
  const el = document.getElementById('projectList');
  el.textContent = 'Loading…';
  try{
    const url = SYNC_API_BASE.replace(/\/$/, '') + '/api/projects';
    const res = await fetch(url);
    const data = await res.json();
    const projects = data.projects || [];
    if(!projects.length){
      el.innerHTML = '<div class="field-hint">No projects yet.</div>';
      return;
    }
    el.innerHTML = projects.map(function(p){
      return '<div class="admin-row">'
        + '<div><div class="name">' + esc(p.name) + '</div>'
        + '<div class="meta">' + esc(p.id) + ' &middot; ' + p.deviceCount + ' device' + (p.deviceCount===1?'':'s') + '</div>'
        + '<div class="field-hint" data-status-for="' + esc(p.id) + '"></div></div>'
        + '<div style="display:flex;gap:8px;flex:none;">'
        + '<input type="file" accept=".xlsx" data-update-file="' + esc(p.id) + '" style="display:none;">'
        + '<input type="file" accept=".xlsx" data-import-file="' + esc(p.id) + '" style="display:none;">'
        + '<button class="btn" data-update="' + esc(p.id) + '">Update Devices</button>'
        + '<button class="btn" data-import="' + esc(p.id) + '">Import Results</button>'
        + '<button class="btn" data-delete="' + esc(p.id) + '" style="border-color:var(--fail);color:var(--fail);">Delete</button>'
        + '</div>'
        + '</div>';
    }).join('');
  }catch(e){
    el.innerHTML = '<div class="field-hint">Couldn\'t load the project list.</div>';
  }
}

document.getElementById('projectList').addEventListener('click', async function(e){
  const delBtn = e.target.closest('[data-delete]');
  if(delBtn){
    const id = delBtn.getAttribute('data-delete');
    if(!confirm('Delete project "' + id + '"? This permanently removes its device list, checklist, and punch list. This can\'t be undone.')) return;
    delBtn.disabled = true;
    delBtn.textContent = 'Deleting…';
    try{
      await adminFetch('/api/admin/projects/delete', {method: 'POST', body: JSON.stringify({id: id})});
      loadProjectList();
    }catch(e){
      alert('Could not delete: ' + e.message);
      delBtn.disabled = false;
      delBtn.textContent = 'Delete';
    }
    return;
  }

  const updateBtn = e.target.closest('[data-update]');
  if(updateBtn){
    const id = updateBtn.getAttribute('data-update');
    const fileInput = document.querySelector('[data-update-file="' + CSS.escape(id) + '"]');
    if(fileInput) fileInput.click();
    return;
  }

  const importBtn = e.target.closest('[data-import]');
  if(importBtn){
    const id = importBtn.getAttribute('data-import');
    const fileInput = document.querySelector('[data-import-file="' + CSS.escape(id) + '"]');
    if(fileInput) fileInput.click();
    return;
  }
});

document.getElementById('projectList').addEventListener('change', async function(e){
  const importInput = e.target.closest('[data-import-file]');
  if(importInput){
    const id = importInput.getAttribute('data-import-file');
    const file = importInput.files[0];
    const statusEl = document.querySelector('[data-status-for="' + CSS.escape(id) + '"]');
    const btn = document.querySelector('[data-import="' + CSS.escape(id) + '"]');
    if(!file) return;

    if(!confirm(
      'Import results for "' + id + '" from ' + file.name + '?\n\n' +
      'This must be a "Device Report" exported from this app (or an edited copy of one). ' +
      'Every field it contains — Location, Device Name, Model, IP, IP ID, AV I/O, Note, ' +
      'and Power/Network/Function — will OVERWRITE the current values for matching devices. ' +
      'If this file is older than the live data, re-uploading it can revert newer changes.'
    )){
      importInput.value = '';
      return;
    }

    btn.disabled = true;
    const originalLabel = btn.textContent;
    if(statusEl) statusEl.textContent = 'Reading file…';
    try{
      const buf = await file.arrayBuffer();
      const workbook = XLSX.read(buf, {type: 'array'});
      const rows = parseDeviceReportForSync(workbook);
      const punchRows = parsePunchListForSync(workbook);
      if(statusEl) statusEl.textContent = 'Uploading ' + rows.length +
      ' device rows and ' + punchRows.length + ' punch rows…';
      const result = await adminFetch('/api/admin/projects/import-results', {
        method: 'POST',
        body: JSON.stringify({id: id, rows: rows, punches: punchRows})
      });
      if(statusEl) statusEl.textContent = 'Synced ' + result.devicesUpdated + ' device field' + (result.devicesUpdated===1?'':'s') + ' and ' + result.checklistUpdated + ' checklist row' + (result.checklistUpdated===1?'':'s') + '.';
      loadProjectList();
    }catch(e){
      console.error(e);
      if(statusEl) statusEl.textContent = '';
      alert('Could not import results: ' + e.message);
    }finally{
      btn.disabled = false;
      btn.textContent = originalLabel;
      importInput.value = '';
    }
    return;
  }

  const fileInput = e.target.closest('[data-update-file]');
  if(!fileInput) return;
  const id = fileInput.getAttribute('data-update-file');
  const file = fileInput.files[0];
  const statusEl = document.querySelector('[data-status-for="' + CSS.escape(id) + '"]');
  const btn = document.querySelector('[data-update="' + CSS.escape(id) + '"]');
  if(!file) return;

  if(!confirm(
    'Re-import devices for "' + id + '" from ' + file.name + '?\n\n' +
    'This adds new devices and updates matching existing ones (by device ID). ' +
    'It will NOT delete any device or touch existing checklist/punch data — ' +
    'even devices missing from this file are left as-is.'
  )){
    fileInput.value = '';
    return;
  }

  btn.disabled = true;
  const originalLabel = btn.textContent;
  if(statusEl) statusEl.textContent = 'Reading file…';
  try{
    const buf = await file.arrayBuffer();
    const workbook = XLSX.read(buf, {type: 'array'});
    const devices = parseWorkbook(workbook);
    if(statusEl) statusEl.textContent = 'Uploading ' + devices.length + ' devices…';
    const result = await adminFetch('/api/admin/projects/update-devices', {
      method: 'POST',
      body: JSON.stringify({id: id, devices: devices})
    });
    if(statusEl) statusEl.textContent = 'Updated ' + result.deviceCount + ' devices just now.';
    loadProjectList();
  }catch(e){
    console.error(e);
    if(statusEl) statusEl.textContent = '';
    alert('Could not update devices: ' + e.message);
  }finally{
    btn.disabled = false;
    btn.textContent = originalLabel;
    fileInput.value = '';
  }
});

// ---------- id auto-slug ----------
function slugify(s){
  return String(s || '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
}
let idManuallyEdited = false;
document.getElementById('newId').addEventListener('input', function(){ idManuallyEdited = true; });
document.getElementById('newName').addEventListener('input', function(e){
  if(!idManuallyEdited){
    document.getElementById('newId').value = slugify(e.target.value);
  }
});

// ---------- Excel parsing (mirrors ExtractData.py) ----------
function cellVal(ws, row1, col1){
  const addr = XLSX.utils.encode_cell({r: row1 - 1, c: col1 - 1});
  const cell = ws[addr];
  return cell ? cell.v : null;
}
function cleanStr(v){
  if(v === null || v === undefined) return '';
  return String(v).trim();
}
function normalizeLocation(s){
  return String(s || '').replace(/\s+/g, ' ').trim().toUpperCase();
}

// Parses this app's OWN "Device Report" export (or a hand-edited copy of
// one) for the "Import Results" action. Columns are matched by header
// text — normalized by stripping spaces/pipes/slashes and lowercasing —
// rather than fixed positions, so it tolerates someone reordering or
// inserting a column. Requires a "Device ID" column, which only exists
// in files this app produced (or someone manually added).
function normalizeHeader(h){
  return String(h || '').replace(/[\s|/]+/g, '').toLowerCase();
}
function parseCheckLabelXlsx(v){
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if(s === 'pass') return 'pass';
  if(s === 'fail') return 'fail';
  return null; // "Untested", blank, or anything unrecognized
}
function parseDeviceReportForSync(workbook){
  const sheetName = workbook.SheetNames.find(function(n){ return n.trim().toLowerCase() === 'device report'; });
  if(!sheetName){
    throw new Error('No "Device Report" sheet found. Sheet names in this file: ' + workbook.SheetNames.join(', '));
  }
  const ws = workbook.Sheets[sheetName];
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');

  let headerRow = null, cols = {};
  for(let r = range.s.r; r <= Math.min(range.e.r, range.s.r + 15); r++){
    const found = {};
    for(let c = range.s.c; c <= range.e.c; c++){
      const cell = ws[XLSX.utils.encode_cell({r, c})];
      const h = normalizeHeader(cell ? cell.v : '');
      if(h === 'deviceid') found.deviceId = c;
      else if(h === 'location') found.location = c;
      else if(h === 'devicename') found.name = c;
      else if(h.indexOf('model') !== -1) found.model = c;
      else if(h === 'ipaddress') found.ip = c;
      else if(h === 'ipid') found.ipid = c;
      else if(h === 'avio') found.avio = c;
      else if(h === 'power') found.power = c;
      else if(h === 'network') found.network = c;
      else if(h === 'function') found.function = c;
      else if(h === 'note') found.note = c;
    }
    if(found.deviceId !== undefined){ headerRow = r; cols = found; break; }
  }
  if(headerRow === null){
    throw new Error('Couldn\'t find a "Device ID" column in the "Device Report" sheet. Was this file exported from this app?');
  }

  const cellStr = function(r, c){
    if(c === undefined) return '';
    const cell = ws[XLSX.utils.encode_cell({r, c})];
    return cell && cell.v != null ? String(cell.v).trim() : '';
  };

  const rows = [];
  for(let r = headerRow + 1; r <= range.e.r; r++){
    const deviceId = cellStr(r, cols.deviceId);
    if(!deviceId) continue;
    rows.push({
      deviceId: deviceId,
      location: cellStr(r, cols.location),
      name: cellStr(r, cols.name),
      model: cellStr(r, cols.model),
      ip: cellStr(r, cols.ip),
      ipid: cellStr(r, cols.ipid),
      avio: cellStr(r, cols.avio),
      note: cellStr(r, cols.note),
      power: parseCheckLabelXlsx(cellStr(r, cols.power)),
      network: parseCheckLabelXlsx(cellStr(r, cols.network)),
      function: parseCheckLabelXlsx(cellStr(r, cols.function))
    });
  }
  if(!rows.length) throw new Error('No device rows found below the header.');
  return rows;
}

// Parses the "Punch List" sheet from the same exported Device Report file.
// Same header-matching approach as parseDeviceReportForSync. A row with
// "Punch ID" filled in updates that existing item; a row with a blank
// Punch ID but a valid Device ID is a brand-new item soomeone typed by hand
// and it gets created on import. This sheet is optional, if it's missing or
// can't be parsed, the caller just gets an empty array back so the Device
//Report sync can sill procees on its own.
function parsePunchListForSync(workbook){
  const sheetName = workbook.SheetNames.find(function(n){ return n.trim().toLowerCase() === 'punch list'});
  if (!sheetName) return [];
  const ws = workbook.Sheets[sheetName];
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');

  let headerRow = null, cols = {};
  for(let r = range.s; r <= Math.min(range.e.r, range.s.r + 15); r++){
    const found = {};
    for(let c = range.s.c; c <= range.e.c; c++){
      const cell = ws[XLSX.utils.encode_cell({r, c})];
      const h = normalizeHeader(cell ? cell.v : '');
      if(h === 'punchid') found.punchId = c;
      else if(h === 'deviceid') found.deviceId = c;
      else if(h === 'location') found.location = c;
      else if(h === 'devicename') found.deviceName = c;
      else if(h === 'description') found.description = c;
      else if(h === 'severity') found.severity = c;
      else if(h === 'status') found.status = c;
      else if(h === 'reportedby') found.reportedBy = c;
      else if(h === 'created') found.created = c;
      else if(h === 'resolvedby') found.resolvedBy = c;
      else if(h === 'resolvedat') found.resolvedAt = c;
    }
    if(found.punchId !== undefined){ headerRow = r; cols = found; break; }
  }
  if(headerRow === null) return [];

  const cellStr = function(r, c){
    if(c === undefined) return '';
    const cell = ws[XLSX.utils.encode_cell({r, c})];
    return cell && cell.v != null ? String(cell.v).trim() : '';
  };

  const punches = [];
  for(let r = headerRow + 1; r <= range.e.r; r++){
    const id = cellStr(r, cols.punchId);
    const deviceId = cellStr(r, cols.deviceId);
    const description = cellStr(r, cols.description);
    if(!id && !deviceId && !description) continue; //blank trailing row
    punches.push({
      id: id,
      deviceId: deviceId,
      deviceName: cellStr(r, cols.deviceName),
      location: cellStr(r, cols.location),
      description: description,
      severity: cellStr(r, cols.severity),
      status: cellStr(r, cols.status),
      reportedBy: cellStr(r, cols.reportedBy),
      resolvedBy: cellStr(r, cols.resolvedBy),
      resolvedAt: cellStr(r, cols.resolvedAt),
    });
  }
  return punches;
}

function parseWorkbook(workbook){
  // Tolerates spacing variants ("Device Info", "DeviceInfo", "Device  Info")
  // but not typos or renamed sheets — those get a clear error listing what
  // sheet names actually exist, instead of a silent wrong match.
  const normalize = function(n){ return n.replace(/\s+/g, '').toLowerCase(); };
  const diName = workbook.SheetNames.find(function(n){ return normalize(n) === 'deviceinfo'; });
  if(!diName){
    throw new Error(
      'No "Device Info" sheet found. Sheet names in this file: ' +
      (workbook.SheetNames.length ? workbook.SheetNames.join(', ') : '(none found — is this a valid .xlsx file?)')
    );
  }
  const di = workbook.Sheets[diName];

  const devices = [];
  const MAX_ROW = 3200;
  for(let r = 3; r <= MAX_ROW; r++){
    const name = cleanStr(cellVal(di, r, 3));
    if(!name) continue;
    devices.push({
      name: name,
      status: cleanStr(cellVal(di, r, 2)),
      level: cleanStr(cellVal(di, r, 4)),
      location: cleanStr(cellVal(di, r, 5)),
      model: cleanStr(cellVal(di, r, 6)),
      ip: cleanStr(cellVal(di, r, 8)),
      ipid: cleanStr(cellVal(di, r, 9)),
      avio: cleanStr(cellVal(di, r, 10)),
      note: cleanStr(cellVal(di, r, 11)),
      ports: []
    });
  }
  if(!devices.length){
    throw new Error('No devices found in "Device Info" (expected names starting row 3, column C).');
  }

  const byName = {};
  devices.forEach(function(d){ byName[d.name] = d; });

  const portSheetNames = workbook.SheetNames.filter(function(n){
    return normalize(n).indexOf('portmap') === 0;
  });
  portSheetNames.forEach(function(sheetName){
    const ws = workbook.Sheets[sheetName];
    let switchName = cleanStr(cellVal(ws, 4, 1));
    if(!switchName){
      const parts = sheetName.split('|');
      switchName = cleanStr(parts[parts.length - 1]) || sheetName;
    }
    const MAX_PORT_ROW = 1200;
    for(let r = 7; r <= MAX_PORT_ROW; r++){
      const devname = cleanStr(cellVal(ws, r, 3));
      if(!devname) continue;
      const d = byName[devname];
      if(!d) continue;
      const portNum = cellVal(ws, r, 1);
      const cable = cellVal(ws, r, 2);
      const mode = cellVal(ws, r, 7);
      const vlans = cellVal(ws, r, 8);
      d.ports.push({
        switch: switchName,
        port: (portNum !== null && portNum !== '') ? portNum : null,
        cable_label: cable ? cleanStr(cable) : null,
        mode: mode ? cleanStr(mode) : null,
        vlans: vlans ? cleanStr(vlans) : null
      });
    }
  });

  const seen = {};
  devices.forEach(function(d){
    const base = slugify(d.name) || 'device';
    const n = seen[base] || 0;
    seen[base] = n + 1;
    d.id = n === 0 ? base : (base + '-' + (n + 1));
  });

  devices.forEach(function(d){ d.location = normalizeLocation(d.location); });

  return devices;
}

// ---------- create project ----------
document.getElementById('createBtn').addEventListener('click', async function(){
  const msgEl = document.getElementById('createMsg');
  const name = document.getElementById('newName').value.trim();
  const shortName = document.getElementById('newShort').value.trim();
  const id = document.getElementById('newId').value.trim().toLowerCase();
  const fileInput = document.getElementById('newFile');
  const file = fileInput.files[0];

  if(!name){ showMsg(msgEl, 'Project name is required.', 'err'); return; }
  if(!/^[a-z0-9-]{1,80}$/.test(id)){ showMsg(msgEl, 'Project ID must be lowercase letters, numbers, and hyphens only.', 'err'); return; }
  if(!file){ showMsg(msgEl, 'Choose an .xlsx file.', 'err'); return; }
  if(typeof XLSX === 'undefined'){ showMsg(msgEl, 'The Excel-parsing library didn\'t load — check your connection and reload this page.', 'err'); return; }

  const btn = document.getElementById('createBtn');
  btn.disabled = true;

  try{
    showMsg(msgEl, 'Reading file…', 'info');
    const buf = await file.arrayBuffer();
    const workbook = XLSX.read(buf, {type: 'array'});

    showMsg(msgEl, 'Parsing devices…', 'info');
    const devices = parseWorkbook(workbook);

    showMsg(msgEl, 'Uploading ' + devices.length + ' devices…', 'info');
    const result = await adminFetch('/api/admin/projects', {
      method: 'POST',
      body: JSON.stringify({id: id, name: name, shortName: shortName, devices: devices})
    });

    showMsg(msgEl, 'Created "' + name + '" with ' + result.deviceCount + ' devices.', 'ok');
    document.getElementById('newName').value = '';
    document.getElementById('newShort').value = '';
    document.getElementById('newId').value = '';
    idManuallyEdited = false;
    fileInput.value = '';
    loadProjectList();
  }catch(e){
    console.error(e);
    showMsg(msgEl, e.message || 'Something went wrong.', 'err');
  }finally{
    btn.disabled = false;
  }
});

// ---------- boot ----------
(function(){
  if(!syncConfigured()){
    document.getElementById('gate').innerHTML = '<div class="field-hint">SYNC_API_BASE is not set in config.js — the admin panel needs a configured Worker to do anything. See README.md.</div>';
    return;
  }
  const cached = sessionStorage.getItem(PW_KEY);
  if(cached){
    // Verify silently; if it's stale (e.g. password rotated) this falls
    // back to the gate via the 401 handling in adminFetch.
    adminFetch('/api/admin/verify', {method: 'POST'}).then(function(){
      showPanel();
    }).catch(function(){ /* showGate already called by adminFetch on 401 */ });
  }
})();