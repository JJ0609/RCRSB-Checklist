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
        + '<div class="meta">' + esc(p.id) + ' &middot; ' + p.deviceCount + ' device' + (p.deviceCount===1?'':'s') + '</div></div>'
        + '<button class="btn" data-delete="' + esc(p.id) + '" style="border-color:var(--fail);color:var(--fail);">Delete</button>'
        + '</div>';
    }).join('');
  }catch(e){
    el.innerHTML = '<div class="field-hint">Couldn\'t load the project list.</div>';
  }
}

document.getElementById('projectList').addEventListener('click', async function(e){
  const btn = e.target.closest('[data-delete]');
  if(!btn) return;
  const id = btn.getAttribute('data-delete');
  if(!confirm('Delete project "' + id + '"? This permanently removes its device list, checklist, and punch list. This can\'t be undone.')) return;
  btn.disabled = true;
  btn.textContent = 'Deleting…';
  try{
    await adminFetch('/api/admin/projects/delete', {method: 'POST', body: JSON.stringify({id: id})});
    loadProjectList();
  }catch(e){
    alert('Could not delete: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'Delete';
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

function parseWorkbook(workbook){
  const diName = workbook.SheetNames.find(function(n){ return n.trim().toLowerCase() === 'device info'; });
  if(!diName) throw new Error('No "Device Info" sheet found in this file.');
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
    return n.trim().toLowerCase().indexOf('port map') === 0;
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
