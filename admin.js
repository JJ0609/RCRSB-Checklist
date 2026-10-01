// ─────────────────────────────────────────────────────────────
// Admin panel - password-gated project management.
//
// The password is sent as the X-Admin-Password header on every admin
// request; the Worker checks it server-side (see worker/index.js). It's
// cached in sessionStorage only (cleared when the tab closes), never
// localStorage, so it doesn't linger on a shared computer.
//
// Excel parsing mirrors the real Info Sheet layout:
// Device Info sheet, rows starting at 3, columns B/C/D/E/F/G/I/K/L
// (F = combined "Zone # + Amp Channel", split in code; H = Mac Address
// and J = VLAN are skipped, same as the original Info Sheet skipped a
// MAC column). Port Map sheets (any sheet named "Port Map | ..."), rows
// starting at 7, columns A/B/C/G/H, joined to devices by exact name
// match. If your Info Sheet format ever changes, update parseWorkbook()
// here to match - this is the one place that assumption lives.
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
    showGate('Session expired or password changed - enter it again.');
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
  loadAccessList();
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
  el.textContent = 'Loading...';
  try{
    // Device counts are per side now (one project can have AV devices, LC
    // devices, or both), so fetch both and show each - otherwise a project
    // that only has LC gear would read "0 devices" right after an LC upload.
    const sides = await Promise.all([
      adminFetch('/api/projects?deviceType=av', {method: 'GET'}),
      adminFetch('/api/projects?deviceType=lc', {method: 'GET'})
    ]);
    const projects = sides[0].projects || [];
    const lcCounts = {};
    (sides[1].projects || []).forEach(function(p){ lcCounts[p.id] = p.deviceCount; });
    window._pdProjects = projects; // stashed for the access-grant dropdown
    populateGrantProjectDropdown(projects);
    if(!projects.length){
      el.innerHTML = '<div class="field-hint">No projects yet.</div>';
      return;
    }
    el.innerHTML = projects.map(function(p){
      const emails = Array.isArray(p.allowedEmails) ? p.allowedEmails : [];
      const accessSummary = emails.length ? ('Visible to ' + emails.length + ' email' + (emails.length===1?'':'s')) : 'Visible to everyone';
      return '<div class="admin-row">'
        + '<div><div class="name">' + esc(p.name) + (p.archived ? ' <span style="font-weight:600;color:var(--ink-soft);font-size:12px;">(Archived)</span>' : '') + '</div>'
        + '<div class="meta">' + esc(p.id) + ' &middot; ' + p.deviceCount + ' AV &middot; ' + (lcCounts[p.id] || 0) + ' LC' + ' &middot; ' + esc(accessSummary) + '</div>'
        + '<div class="field-hint" data-status-for="' + esc(p.id) + '"></div></div>'
        + '<div style="display:flex;gap:8px;flex-wrap:wrap">'
        + '<input type="file" accept=".xlsx" data-update-file="' + esc(p.id) + '" style="display:none;">'
        + '<input type="file" accept=".xlsx" data-import-file="' + esc(p.id) + '" style="display:none;">'
        + '<input type="file" accept=".xlsx" data-sync-file="' + esc(p.id) + '" style="display:none;">'
        + '<div style="flex-wrap:wrap">'
        + '<button class="btn" data-update="' + esc(p.id) + '" title="Detects AV or LC automatically from the sheet the file contains">Update Devices</button>'
        + '<button class="btn" data-import="' + esc(p.id) + '">Import Results</button>'
        + '<button class="btn" data-sync="' + esc(p.id) + '" style="border-color:var(--open);color:var(--open);" title="Detects AV or LC automatically. Adds/updates devices AND removes any device or location missing from the file">Sync Devices (removes missing)</button>'
        + '<button class="btn" data-archive="' + esc(p.id) + '" data-currently-archived="' + (p.archived ? '1' : '0') + '">' + (p.archived ? 'Unarchive' : 'Archive') + '</button>'
        + '<button class="btn" data-delete="' + esc(p.id) + '" style="border-color:var(--fail);color:var(--fail);">Delete</button>'
        + '</div>'
        + '</div>'
        + '</div>';
    }).join('');
  }catch(e){

    el.innerHTML = '<div class="field-hint">Couldn\'t load the project list.</div>';
  }
}

function populateGrantProjectDropdown(projects){
  const sel = document.getElementById('grantProject');
  if(!sel) return;
  sel.innerHTML = '<option value="__ALL_PROJECTS__">All Projects</option>' + projects.map(function(p){
    return '<option value="' + esc(p.id) + '">' + esc(p.name) + ' (' + esc(p.id) + ')</option>';
  }).join('');
}

document.getElementById('projectList').addEventListener('click', async function(e){
  const archiveBtn = e.target.closest('[data-archive]');
  if(archiveBtn){
    const id = archiveBtn.getAttribute('data-archive');
    const currentlyArchived = archiveBtn.getAttribute('data-currently-archived') === '1';
    const nextArchived = !currentlyArchived;
    archiveBtn.disabled = true;
    archiveBtn.textContent = nextArchived ? 'Archiving...' : 'Unarchiving...';
    try{
      await adminFetch('/api/admin/projects/archive', {method: 'POST', body: JSON.stringify({id: id, archived: nextArchived, actorName: (sessionStorage.getItem('pd_user_email') || 'Admin')})});
      loadProjectList();
    }catch(e){
      alert('Could not update: ' + e.message);
      archiveBtn.disabled = false;
      archiveBtn.textContent = currentlyArchived ? 'Unarchive' : 'Archive';
    }
    return;
  }

  const delBtn = e.target.closest('[data-delete]');
  if(delBtn){
    const id = delBtn.getAttribute('data-delete');
    if(!confirm('Delete project "' + id + '"? This permanently removes its device list, checklist, and punch list. This can\'t be undone.')) return;
    delBtn.disabled = true;
    delBtn.textContent = 'Deleting...';
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

  const syncBtn = e.target.closest('[data-sync]');
  if(syncBtn){
    const id = syncBtn.getAttribute('data-sync');
    const fileInput = document.querySelector('[data-sync-file="' + CSS.escape(id) + '"]');
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
      'Every field it contains - Location, Device Name, Model, IP, IP ID, AV I/O, Note, ' +
      'Power/Network/Function, and the Punch List sheet - will OVERWRITE the current values ' +
      'for matching rows (matched by Device ID / Punch ID, not by name). New rows with a blank ' +
      'Punch ID are created as new punch items. If this file is older than the live data, ' +
      're-uploading it can revert newer changes.'
    )){
      importInput.value = '';
      return;
    }

    btn.disabled = true;
    const originalLabel = btn.textContent;
    if(statusEl) statusEl.textContent = 'Reading file...';
    try{
      const buf = await file.arrayBuffer();
      const workbook = XLSX.read(buf, {type: 'array'});
      const rows = parseDeviceReportForSync(workbook);
      const punchRows = parsePunchListForSync(workbook);
      if(statusEl) statusEl.textContent = 'Uploading ' + rows.length + ' device rows and ' + punchRows.length + ' punch rows...';
      const result = await adminFetch('/api/admin/projects/import-results', {
        method: 'POST',
        body: JSON.stringify({id: id, rows: rows, punches: punchRows})
      });
      if(statusEl) statusEl.textContent =
        'Synced ' + result.devicesUpdated + ' device field' + (result.devicesUpdated===1?'':'s') +
        ', ' + result.checklistUpdated + ' checklist row' + (result.checklistUpdated===1?'':'s') +
        ', ' + result.punchesUpdated + ' punch update' + (result.punchesUpdated===1?'':'s') +
        ', ' + result.punchesCreated + ' new punch item' + (result.punchesCreated===1?'':'s') + '.';
      setTimeout(loadProjectList, 5000);
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

  const syncFileInput = e.target.closest('[data-sync-file]');
  if(syncFileInput){
    const id = syncFileInput.getAttribute('data-sync-file');
    const file = syncFileInput.files[0];
    const statusEl = document.querySelector('[data-status-for="' + CSS.escape(id) + '"]');
    const btn = document.querySelector('[data-sync="' + CSS.escape(id) + '"]');
    if(!file) return;

    btn.disabled = true;
    const originalLabel = btn.textContent;
    if(statusEl) statusEl.textContent = 'Reading file...';
    try{
      const buf = await file.arrayBuffer();
      const workbook = XLSX.read(buf, {type: 'array'});
      const deviceType = detectDeviceType(workbook);
      const newDevices = deviceType === 'lc' ? parseLcsWorkbook(workbook) : parseWorkbook(workbook);
      const typeLabel = deviceType === 'lc' ? 'LC' : 'AV';

      // Preview what would actually be deleted before committing to
      // anything - computed the same way the server will, so the
      // confirmation reflects reality rather than a guess. The server
      // still independently recomputes this itself; nothing here is
      // trusted as the source of truth for the actual deletion.
      if(statusEl) statusEl.textContent = 'Checking what would change...';
      const current = await adminFetch('/api/devices?project=' + encodeURIComponent(id) + '&deviceType=' + deviceType, {method: 'GET'});
      const currentDevices = current.devices || [];

      const newIds = new Set(newDevices.map(function(d){ return d.id; }));
      const newLocations = new Set(newDevices.map(function(d){ return d.location; }).filter(Boolean));

      const toDelete = currentDevices.filter(function(d){ return !newIds.has(d.id); });

      const currentCountByLoc = {};
      currentDevices.forEach(function(d){
        if(!d.location) return;
        currentCountByLoc[d.location] = (currentCountByLoc[d.location] || 0) + 1;
      });
      const locsToRemove = Object.keys(currentCountByLoc).filter(function(loc){
        return currentCountByLoc[loc] > 0 && !newLocations.has(loc);
      });

      let confirmMsg = 'Detected ' + typeLabel + ' devices. Sync ' + typeLabel + ' devices for "' + id + '" from ' + file.name + '?\n\n' +
        'This adds/updates ' + newDevices.length + ' ' + typeLabel + ' device' + (newDevices.length===1?'':'s') + ' from the file.' +
        (typeLabel === 'LC' ? ' AV devices in this project are never affected.' : ' LC devices in this project are never affected.') + '\n\n';

      if(toDelete.length){
        const preview = toDelete.slice(0, 15).map(function(d){ return d.name || d.id; }).join(', ') + (toDelete.length > 15 ? ', ...' : '');
        confirmMsg += 'It will DELETE ' + toDelete.length + ' ' + typeLabel + ' device' + (toDelete.length===1?'':'s') + ' not in the file: ' + preview + '\n\n';
      } else {
        confirmMsg += 'No devices will be deleted - everything currently in this project is also in the file.\n\n';
      }

      if(locsToRemove.length){
        confirmMsg += 'It will also remove ' + locsToRemove.length + ' location' + (locsToRemove.length===1?'':'s') + ' no longer used: ' + locsToRemove.join(', ') + '\n\n';
      }

      confirmMsg += 'Punch list history is never deleted, even for a removed device. This can\'t be undone otherwise.';

      if(!confirm(confirmMsg)){
        syncFileInput.value = '';
        btn.disabled = false;
        return;
      }

      if(statusEl) statusEl.textContent = 'Syncing...';
      const result = await adminFetch('/api/admin/projects/sync-devices', {
        method: 'POST',
        body: JSON.stringify({id: id, devices: newDevices, deviceType: deviceType})
      });
      if(statusEl) statusEl.textContent =
        'Synced ' + typeLabel + ': ' + result.deviceCount + ' device' + (result.deviceCount===1?'':'s') + ' added/updated, ' +
        result.devicesDeleted + ' removed, ' + result.locationsDeleted + ' location' + (result.locationsDeleted===1?'':'s') + ' removed.';
      setTimeout(loadProjectList, 5000);
    }catch(e){
      console.error(e);
      if(statusEl) statusEl.textContent = '';
      alert('Could not sync devices: ' + e.message);
    }finally{
      btn.disabled = false;
      btn.textContent = originalLabel;
      syncFileInput.value = '';
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

  btn.disabled = true;
  const originalLabel = btn.textContent;
  if(statusEl) statusEl.textContent = 'Reading file...';
  try{
    const buf = await file.arrayBuffer();
    const workbook = XLSX.read(buf, {type: 'array'});
    const deviceType = detectDeviceType(workbook);
    const typeLabel = deviceType === 'lc' ? 'LC' : 'AV';
    const devices = deviceType === 'lc' ? parseLcsWorkbook(workbook) : parseWorkbook(workbook);

    if(!confirm(
      'Detected ' + typeLabel + ' devices. Re-import ' + typeLabel + ' devices for "' + id + '" from ' + file.name + '?\n\n' +
      'This adds new devices and updates matching existing ones (by device ID). ' +
      'It will NOT delete any device or touch existing checklist/punch data - ' +
      'even devices missing from this file are left as-is. ' +
      (typeLabel === 'LC' ? 'AV devices in this project are never affected.' : 'LC devices in this project are never affected.')
    )){
      fileInput.value = '';
      btn.disabled = false;
      btn.textContent = originalLabel;
      if(statusEl) statusEl.textContent = '';
      return;
    }

    if(statusEl) statusEl.textContent = 'Uploading ' + devices.length + ' ' + typeLabel + ' devices...';
    const result = await adminFetch('/api/admin/projects/update-devices', {
      method: 'POST',
      body: JSON.stringify({id: id, devices: devices, deviceType: deviceType})
    });
    if(statusEl) statusEl.textContent = 'Updated ' + result.deviceCount + ' ' + typeLabel + ' devices just now.';
    setTimeout(loadProjectList, 5000);
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
// ---------- project access (who sees what) ----------
let accessRows = [];             // raw grants from the server, cached client-side
let accessGroupBy = 'project';   // 'project' | 'email' - resets to project on page load
let expandedAccessGroup = null;  // key of the one open accordion card, or null

// Each side of a project is open to everyone until someone is granted it;
// after that only the people granted it see it. So the first grant on a
// side RESTRICTS it, and revoking the last grant OPENS it up again - the
// two helpers below are what the confirmations warn about.
function sideHasGrants(projectId, side){
  return accessRows.some(function(r){ return r.projectId === projectId && (r.sides === side || r.sides === 'both'); });
}
function sidesOfGrant(projectId, email){
  const r = accessRows.find(function(x){ return x.projectId === projectId && x.email === email; });
  return !r ? [] : (r.sides === 'av' ? ['av'] : r.sides === 'lc' ? ['lc'] : ['av', 'lc']);
}
// Of the sides being revoked from this person, the ones nobody ELSE covers -
// i.e. that would become visible to everyone.
function sidesThatWouldOpen(projectId, email, revokedSides){
  return revokedSides.filter(function(side){
    return !accessRows.some(function(r){
      return r.projectId === projectId && r.email !== email && (r.sides === side || r.sides === 'both');
    });
  });
}
function sideList(sides){ return sides.map(function(s){ return s.toUpperCase(); }).join(' and '); }

async function loadAccessList(){
  const el = document.getElementById('accessList');
  el.textContent = 'Loading...';
  try{
    const data = await adminFetch('/api/admin/access', {method: 'GET'});
    accessRows = data.access || [];
    renderAccessList();
  }catch(e){
    el.innerHTML = '<div class="field-hint">Couldn\'t load the access list.</div>';
  }
}

// Grouped by project or by person, shown as a one-open-at-a-time
// accordion rather than everything expanded flat - stays scannable
// even with many grants. Both the grouping and the order within each
// group are alphabetical, not chronological; addedAt still shows per
// row but no longer drives the structure.
function renderAccessList(){
  const el = document.getElementById('accessList');
  let html = '<div style="display:flex;gap:8px;margin-bottom:14px;">'
    + '<button class="chip' + (accessGroupBy==='project'?' active':'') + '" data-access-group="project">Group by Project</button>'
    + '<button class="chip' + (accessGroupBy==='email'?' active':'') + '" data-access-group="email">Group by Email</button>'
    + '</div>';

  if(!accessRows.length){
    html += '<div class="field-hint">No grants yet - every project is visible to everyone.</div>';
    el.innerHTML = html;
    return;
  }

  // Each group is its own card: a clickable header row plus, only for
  // whichever one key currently matches expandedAccessGroup, the list
  // of rows underneath. Clicking a header toggles it - opening one
  // closes whatever else was open, since expandedAccessGroup can only
  // ever hold a single key at a time. Clicking the already-open header
  // again collapses it (handled in the click listener, not here).
  function groupCard(key, title, sub, count, singular, plural, rowsHtml){
    const isOpen = expandedAccessGroup === key;
    return '<div style="border:1px solid var(--border);border-radius:10px;margin-bottom:8px;overflow:hidden;">'
      + '<button data-group-key="' + esc(key) + '" style="width:100%;display:flex;align-items:baseline;gap:8px;padding:11px 14px;background:' + (isOpen ? 'var(--surface-2)' : 'var(--surface)') + ';border:none;cursor:pointer;text-align:left;font:inherit;color:inherit;">'
      + '<span style="font-size:10px;color:var(--ink-soft);display:inline-block;transition:transform .15s ease;transform:rotate(' + (isOpen ? '90deg' : '0deg') + ');">&#9656;</span>'
      + '<span style="font-weight:800;font-size:13.5px;">' + esc(title) + '</span>'
      + (sub ? '<span style="font-size:11px;color:var(--ink-soft);">' + esc(sub) + '</span>' : '')
      + '<span style="font-size:11px;color:var(--ink-soft);margin-left:auto;">' + count + ' ' + (count===1?singular:plural) + '</span>'
      + '</button>'
      + (isOpen ? '<div style="padding:2px 14px 8px;border-top:1px solid var(--border);">' + rowsHtml + '</div>' : '')
      + '</div>';
  }
  // Per person, one button per side: "Revoke AV" when they have it, "Add AV"
  // when they don't (same for LC), plus "Revoke all" when they have both.
  // Revoking a person's only side removes the grant.
  function sideButtons(projectId, email, sides){
    const has = {av: sides === 'av' || sides === 'both', lc: sides === 'lc' || sides === 'both'};
    const ids = 'data-project="' + esc(projectId) + '" data-email="' + esc(email) + '"';
    const small = 'padding:5px 11px;font-size:12px;';
    const red = 'border-color:var(--fail);color:var(--fail);';
    const one = function(side){
      const L = side.toUpperCase();
      return has[side]
        ? '<button class="btn" data-revoke-side="' + side + '" ' + ids + ' style="' + red + small + '">Revoke ' + L + '</button>'
        : '<button class="btn" data-add-side="' + side + '" ' + ids + ' style="' + small + '">Add ' + L + '</button>';
    };
    const all = (has.av && has.lc)
      ? '<button class="btn" data-revoke-project="' + esc(projectId) + '" data-revoke-email="' + esc(email) + '" style="' + red + small + '">Revoke all</button>'
      : '';
    return one('av') + one('lc') + all;
  }
  function grantRow(primaryText, secondaryText, projectId, email, sides){
    return '<div class="admin-row" style="padding:7px 0;">'
      + '<div><div class="name" style="font-size:13px;">' + esc(primaryText) + '</div>'
      + '<div class="meta">' + esc(secondaryText) + '</div></div>'
      + '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end;">'
      + sideButtons(projectId, email, sides)
      + '</div>'
      + '</div>';
  }

  if(accessGroupBy === 'project'){
    const groups = {};
    accessRows.forEach(function(r){
      if(!groups[r.projectId]) groups[r.projectId] = {name: r.projectName, rows: []};
      groups[r.projectId].rows.push(r);
    });
    Object.keys(groups).sort(function(a,b){ return groups[a].name.localeCompare(groups[b].name); }).forEach(function(pid){
      const g = groups[pid];
      const rows = g.rows.slice().sort(function(a,b){ return a.email.localeCompare(b.email); });
      const rowsHtml = rows.map(function(r){ return grantRow(r.email, 'added by ' + (r.addedBy || ''), r.projectId, r.email, r.sides); }).join('');
      const covered = function(side){
        const n = rows.filter(function(r){ return r.sides === side || r.sides === 'both'; }).length;
        return side.toUpperCase() + ': ' + (n ? n + (n === 1 ? ' person' : ' people') : 'open to everyone');
      };
      html += groupCard(pid, g.name, pid + ' - ' + covered('av') + ' - ' + covered('lc'), rows.length, 'person', 'people', rowsHtml);
    });
  } else {
    const groups = {};
    accessRows.forEach(function(r){
      if(!groups[r.email]) groups[r.email] = [];
      groups[r.email].push(r);
    });
    Object.keys(groups).sort().forEach(function(email){
      const rows = groups[email].slice().sort(function(a,b){ return a.projectName.localeCompare(b.projectName); });
      const rowsHtml = rows.map(function(r){ return grantRow(r.projectName, r.projectId + ' - added by ' + (r.addedBy || ''), r.projectId, r.email, r.sides); }).join('');
      html += groupCard(email, email, '', rows.length, 'project', 'projects', rowsHtml);
    });
  }

  el.innerHTML = html;
}
document.getElementById('grantBtn').addEventListener('click', async function(){
  const emailInput = document.getElementById('grantEmail');
  const projectSel = document.getElementById('grantProject');
  const email = emailInput.value.trim().toLowerCase();
  const projectId = projectSel.value;
  const msgEl = document.getElementById('accessMsg');
  const actorName = sessionStorage.getItem('pd_user_email') || 'Admin';
  const sides = (document.getElementById('grantSides') || {}).value || 'both';
  const addLabel = sides === 'av' ? 'AV' : sides === 'lc' ? 'LC' : 'AV and LC';
  const grantedSides = sides === 'both' ? ['av', 'lc'] : [sides];
  if(!email){ showMsg(msgEl, 'Enter an email or *@domain.com wildcard.', 'err'); return; }
  if(!projectId){ showMsg(msgEl, 'No project selected.', 'err'); return; }
  this.disabled = true;
  try{
    if(projectId === '__ALL_PROJECTS__'){
      const result = await adminFetch('/api/admin/access/grant-all', {
        method: 'POST',
        body: JSON.stringify({email: email, sides: sides, actorName: actorName})
      });
      showMsg(msgEl, 'Added ' + addLabel + ' access on all ' + result.granted + ' project' + (result.granted===1?'':'s') + '.', 'ok');
    } else {
      // Sides with no grants yet are open to everyone; this grant is what
      // limits them to the people granted - say so.
      const newlyLimited = grantedSides.filter(function(s){ return !sideHasGrants(projectId, s); });
      const result = await adminFetch('/api/admin/access/grant', {
        method: 'POST',
        body: JSON.stringify({projectId: projectId, email: email, sides: sides, actorName: actorName})
      });
      const now = result && result.sides ? result.sides : sides;
      const nowLabel = now === 'av' ? 'AV only' : now === 'lc' ? 'LC only' : 'both sides';
      showMsg(msgEl, 'Saved - ' + email + ' can now see ' + nowLabel + '.' +
        (newlyLimited.length ? ' ' + sideList(newlyLimited) + ' was open to everyone and is now limited to the people granted.' : ''), 'ok');
    }
    emailInput.value = '';
    loadAccessList();
    loadProjectList();
  }catch(e){
    showMsg(msgEl, e.message || 'Could not grant access.', 'err');
  }finally{
    this.disabled = false;
  }
});
document.getElementById('accessList').addEventListener('click', async function(e){
  const groupBtn = e.target.closest('[data-access-group]');
  if(groupBtn){
    accessGroupBy = groupBtn.getAttribute('data-access-group');
    expandedAccessGroup = null; // project ids and emails aren't the same key space
    renderAccessList();
    return;
  }

  const cardToggle = e.target.closest('[data-group-key]');
  if(cardToggle){
    const key = cardToggle.getAttribute('data-group-key');
    expandedAccessGroup = (expandedAccessGroup === key) ? null : key;
    renderAccessList();
    return;
  }

  // Revoke or add ONE side of a person's access to a project.
  const sideBtn = e.target.closest('[data-revoke-side], [data-add-side]');
  if(sideBtn){
    const projectId = sideBtn.getAttribute('data-project');
    const email = sideBtn.getAttribute('data-email');
    const revoking = sideBtn.hasAttribute('data-revoke-side');
    const side = sideBtn.getAttribute(revoking ? 'data-revoke-side' : 'data-add-side');
    const L = side.toUpperCase(), otherL = side === 'av' ? 'LC' : 'AV';
    const pname = (accessRows.find(function(r){ return r.projectId === projectId; }) || {}).projectName || projectId;
    const actorName = sessionStorage.getItem('pd_user_email') || 'Admin';
    if(revoking){
      let msg = 'Revoke ' + L + ' access for ' + email + ' on "' + pname + '"?' +
        (sidesOfGrant(projectId, email).length > 1 ? ' They keep ' + otherL + '.' : ' That is their only side, so their grant is removed entirely.');
      if(sidesThatWouldOpen(projectId, email, [side]).length){
        msg += '\n\nNo one else has a grant for ' + L + ' on this project, so ' + L + ' will become visible to everyone.';
      }
      if(!confirm(msg)) return;
    } else if(!sideHasGrants(projectId, side)){
      if(!confirm(L + ' on "' + pname + '" is currently visible to everyone. Adding ' + email + ' limits ' + L + ' to the people who have a grant for it.\n\nContinue?')) return;
    }
    sideBtn.disabled = true;
    try{
      await adminFetch(revoking ? '/api/admin/access/revoke' : '/api/admin/access/grant', {
        method: 'POST',
        body: JSON.stringify({projectId: projectId, email: email, sides: side, actorName: actorName})
      });
      loadAccessList();
      loadProjectList();
    }catch(err){
      alert('Could not ' + (revoking ? 'revoke' : 'add') + ': ' + err.message);
      sideBtn.disabled = false;
    }
    return;
  }

  const btn = e.target.closest('[data-revoke-project]');
  if(!btn) return;
  const projectId = btn.getAttribute('data-revoke-project');
  const email = btn.getAttribute('data-revoke-email');
  let msg = 'Revoke ' + email + '\'s access to "' + projectId + '"?';
  const opening = sidesThatWouldOpen(projectId, email, sidesOfGrant(projectId, email));
  if(opening.length){
    msg += '\n\nNo one else has a grant for ' + sideList(opening) + ' on this project, so ' + sideList(opening) + ' will become visible to everyone.';
  }
  if(!confirm(msg)) return;
  btn.disabled = true;
  try{
    await adminFetch('/api/admin/access/revoke', {method: 'POST', body: JSON.stringify({projectId: projectId, email: email, actorName: sessionStorage.getItem('pd_user_email') || 'Admin'})});
    loadAccessList();
    loadProjectList();
  }catch(e){
    alert('Could not revoke: ' + e.message);
    btn.disabled = false;
  }
});

// "AV only", "lc", "Both", "AV + LC" ... -> av / lc / both. Blank stays blank
// (the server treats that as "both for someone new, leave an existing grant
// alone"). Anything unrecognisable is passed through so the server can count
// the row as skipped rather than guess.
function normalizeSidesCell(v){
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if(!s) return '';
  const hasAv = /\bav\b/.test(s), hasLc = /\blc\b/.test(s);
  if(hasAv && hasLc) return 'both';
  if(s === 'both' || s === 'all') return 'both';
  const rest = s.replace(/\bonly\b/g, '').replace(/\s+/g, '');
  if(hasAv && rest === 'av') return 'av';
  if(hasLc && rest === 'lc') return 'lc';
  return s;
}

// Reads a CSV or xlsx with "email" and "project id" columns (matched by
// header text, same approach as everywhere else in this file - tolerant
// of column order, not of a missing/differently-worded header).
function parseAccessSheet(workbook){
  const sheetName = workbook.SheetNames[0];
  if(!sheetName) throw new Error('No sheet found in this file.');
  const ws = workbook.Sheets[sheetName];
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  let headerRow = null, cols = {};
  for(let r = range.s.r; r <= Math.min(range.e.r, range.s.r + 5); r++){
    const found = {};
    for(let c = range.s.c; c <= range.e.c; c++){
      const cell = ws[XLSX.utils.encode_cell({r, c})];
      const h = normalizeHeader(cell ? cell.v : '');
      if(h === 'email' || h === 'emailaddress') found.email = c;
      else if(h === 'projectid' || h === 'project' || h === 'id') found.projectId = c;
      else if(h === 'sides' || h === 'side') found.sides = c;
    }
    if(found.email !== undefined && found.projectId !== undefined){ headerRow = r; cols = found; break; }
  }
  if(headerRow === null){
    throw new Error('Couldn\'t find both an "email" and a "project id" column. Sheet names in this file: ' + workbook.SheetNames.join(', '));
  }
  const cellStr = function(r, c){
    const cell = ws[XLSX.utils.encode_cell({r, c})];
    return cell && cell.v != null ? String(cell.v).trim() : '';
  };
  const rows = [];
  for(let r = headerRow + 1; r <= range.e.r; r++){
    const email = cellStr(r, cols.email);
    const projectId = cellStr(r, cols.projectId);
    if(!email && !projectId) continue;
    rows.push({email: email.toLowerCase(), projectId: projectId.toLowerCase(), sides: cols.sides !== undefined ? normalizeSidesCell(cellStr(r, cols.sides)) : ''});
  }
  if(!rows.length) throw new Error('No rows found below the header.');
  return rows;
}
document.getElementById('accessFile').addEventListener('change', async function(e){
  const file = e.target.files[0];
  const msgEl = document.getElementById('accessMsg');
  if(!file) return;
  if(typeof XLSX === 'undefined'){ showMsg(msgEl, 'The file-parsing library didn\'t load - check your connection and reload this page.', 'err'); e.target.value=''; return; }
  try{
    showMsg(msgEl, 'Reading file...', 'info');
    const buf = await file.arrayBuffer();
    const workbook = XLSX.read(buf, {type: 'array'});
    const rows = parseAccessSheet(workbook);
    showMsg(msgEl, 'Uploading ' + rows.length + ' grants...', 'info');
    const result = await adminFetch('/api/admin/access/import', {
      method: 'POST',
      body: JSON.stringify({rows: rows, actorName: 'Admin'})
    });
    showMsg(msgEl,
      'Granted ' + result.granted + ' new access row' + (result.granted===1?'':'s') +
      (result.skippedUnknownProject ? ' - skipped ' + result.skippedUnknownProject + ' row(s) with an unrecognized project id' : '') +
      (result.skippedBadEmail ? ' - skipped ' + result.skippedBadEmail + ' row(s) with a bad email' : '') +
      (result.skippedBadSides ? ' - skipped ' + result.skippedBadSides + ' row(s) whose side isn\'t AV, LC or both' : '') + '.',
      'ok'
    );
    loadAccessList();
    loadProjectList();
  }catch(err){
    console.error(err);
    showMsg(msgEl, err.message || 'Could not import.', 'err');
  }finally{
    e.target.value = '';
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
// text - normalized by stripping spaces/pipes/slashes and lowercasing -
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
      else if(h === 'zone') found.zone = c;
      else if(h === 'ampchannel' || h === 'channel') found.channel = c;
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
      zone: cellStr(r, cols.zone),
      channel: cellStr(r, cols.channel),
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
// Punch ID but a valid Device ID is a brand-new item someone typed by
// hand - it gets created on import. This sheet is optional: if it's
// missing or can't be parsed, the caller just gets an empty array back
// so the Device Report sync can still proceed on its own.
function parsePunchListForSync(workbook){
  const sheetName = workbook.SheetNames.find(function(n){ return n.trim().toLowerCase() === 'punch list'; });
  if(!sheetName) return [];
  const ws = workbook.Sheets[sheetName];
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');

  let headerRow = null, cols = {};
  for(let r = range.s.r; r <= Math.min(range.e.r, range.s.r + 15); r++){
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
      else if(h === 'ownership') found.ownership = c;
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
    if(!id && !deviceId && !description) continue; // blank trailing row
    punches.push({
      id: id,
      deviceId: deviceId,
      deviceName: cellStr(r, cols.deviceName),
      location: cellStr(r, cols.location),
      description: description,
      severity: cellStr(r, cols.severity),
      ownership: cellStr(r, cols.ownership),
      status: cellStr(r, cols.status),
      reportedBy: cellStr(r, cols.reportedBy),
      resolvedBy: cellStr(r, cols.resolvedBy),
      resolvedAt: cellStr(r, cols.resolvedAt)
    });
  }
  return punches;
}

function parseWorkbook(workbook){
  // Tolerates spacing variants ("Device Info", "DeviceInfo", "Device  Info")
  // but not typos or renamed sheets - those get a clear error listing what
  // sheet names actually exist, instead of a silent wrong match.
  const normalize = function(n){ return n.replace(/\s+/g, '').toLowerCase(); };
  const diNames = workbook.SheetNames.filter(function(n){ return normalize(n) === 'deviceinfo' || normalize(n) === 'componentinfo' || normalize(n) === 'devicereport'; });
  if(!diNames.length){
    throw new Error(
      'No "Device Info" sheet found. Sheet names in this file: ' +
      (workbook.SheetNames.length ? workbook.SheetNames.join(', ') : '(none found - is this a valid .xlsx file?)')
    );
  }

  // Columns are matched by header text, not fixed position - the real
  // template is still evolving (columns get added, split, reordered),
  // so this adapts automatically instead of needing a code edit every
  // time the layout changes. Zone and Amp Channel are detected as either
  // one combined column ("Zone # + Amp Channel") or two separate ones,
  // whichever the file actually has. MAC Address, VLAN, USERNAME, and
  // PASSWORD are recognized but intentionally never stored - no field
  // for MAC/VLAN yet, and credentials shouldn't go into a login-free app.
  const normHeader = function(h){ return String(h || '').replace(/[\s#+|/]+/g, '').toLowerCase(); };

  // Splits a combined "Zone # + Amp Channel" cell like "Zone 7 Channel 3"
  // into separate zone/channel values ("7" and "3" - the display already
  // adds its own "Zone"/"Ch" labels). Falls back to keeping the whole raw
  // text in zone (with channel left blank) if it doesn't match the
  // expected pattern, so nothing silently disappears on an unusual row.
  function splitZoneChannel(raw){
    const s = cleanStr(raw);
    if(!s) return {zone: '', channel: ''};
    const m = s.match(/^zone\s*(\S+)\s+channel\s*(\S+)$/i);
    if(m) return {zone: m[1], channel: m[2]};
    return {zone: s, channel: ''};
  }

  // Parses ONE Device Info-like sheet into an array of device objects.
  // Multiple sheets matching "Device Info" are treated as intentional -
  // e.g. one per building on a multi-building project - and every
  // matching sheet gets merged into a single device list below, rather
  // than only reading the first one and silently ignoring the rest.
  // Header detection runs independently per sheet, so sheets with
  // slightly different column layouts still work correctly.
  function parseOneDeviceInfoSheet(diName){
    const di = workbook.Sheets[diName];
    let headerRow = null, cols = {}, zoneChannelCombined = false;
    const MAX_HEADER_SCAN = 10;
    for(let r = 1; r <= MAX_HEADER_SCAN; r++){
      const found = {};
      let combined = false;
      for(let c = 1; c <= 40; c++){
        const h = normHeader(cellVal(di, r, c));
        if(!h) continue;
        if(h === 'componentname' || h === 'devicename') found.name = c;
        else if(h === 'status') found.status = c;
        else if(h === 'level') found.level = c;
        else if(h === 'location') found.location = c;
        else if(h.indexOf('zone') !== -1 && h.indexOf('channel') !== -1){ found.zone = c; combined = true; }
        else if(h === 'zone') found.zone = c;
        else if(h === 'ampchannel' || h === 'channel') found.channel = c;
        else if(h.indexOf('model') !== -1) found.model = c;
        else if(h === 'ipaddress') found.ip = c;
        else if(h === 'id') found.ipid = c;
        else if(h === 'avio' || h === 'av') found.avio = c;
        else if(h === 'note') found.note = c;
      }
      if(found.name !== undefined){ headerRow = r; cols = found; zoneChannelCombined = combined; break; }
    }
    if(headerRow === null){
      throw new Error('Couldn\'t find a "Component Name" or "Device Name" column in "' + diName + '" - check the header row is present and spelled recognizably.');
    }

    const sheetDevices = [];
    const MAX_ROW = 3200;
    for(let r = headerRow + 1; r <= MAX_ROW; r++){
      const name = cleanStr(cellVal(di, r, cols.name));
      if(!name) continue;
      let zone = '', channel = '';
      if(zoneChannelCombined){
        const zc = splitZoneChannel(cellVal(di, r, cols.zone));
        zone = zc.zone; channel = zc.channel;
      } else {
        zone = cleanStr(cellVal(di, r, cols.zone));
        channel = cleanStr(cellVal(di, r, cols.channel));
      }
      sheetDevices.push({
        name: name,
        status: cleanStr(cellVal(di, r, cols.status)),
        level: cleanStr(cellVal(di, r, cols.level)),
        location: cleanStr(cellVal(di, r, cols.location)),
        zone: zone,
        channel: channel,
        model: cleanStr(cellVal(di, r, cols.model)),
        ip: cleanStr(cellVal(di, r, cols.ip)),
        ipid: cleanStr(cellVal(di, r, cols.ipid)),
        avio: cleanStr(cellVal(di, r, cols.avio)),
        note: cleanStr(cellVal(di, r, cols.note)),
        ports: []
      });
    }
    return sheetDevices;
  }

  let devices = [];
  diNames.forEach(function(diName){
    devices = devices.concat(parseOneDeviceInfoSheet(diName));
  });

  if(!devices.length){
    throw new Error(
      'No devices found across ' + diNames.length + ' "Device Info" sheet' + (diNames.length===1?'':'s') +
      ' (' + diNames.join(', ') + ').'
    );
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

// Parses a raw "LCS Devices" Info Sheet. That sheet is hierarchical: a
// "Device" (a controller / panel - the one carrying the IP Address and
// IP ID) followed by the Local Cresnet Devices wired to it, one per row,
// each with its own Cresnet ID, Installed Location, DIN Rail, Model #
// and Connection. The Cresnet devices are what actually get
// commissioned, so THEY are the records: the "Local Cresnet Devices"
// name is the identity (the "primary key"); the Device column is only a
// group heading, blank on every row but the first of its group.
//
// What each record carries:
//   name        <- Local Cresnet Devices
//   cresnetId   <- Cresnet ID, as displayed ("03" stays "03", "0A" stays "0A")
//   location    <- the row's own Installed Location (usually the panel the
//                  module sits in); falls back to the controller's name
//   controller  <- the Device it belongs to, plus where that controller
//                  lives when its own row says so ("LCP-DPC1 @ BOH Corridor 129")
//   ip / ipid   <- the controller's IP Address / IP ID. The sheet lists them
//                  once per group, so every child inherits them - even a
//                  child that sits above the row they happen to be typed on
//   dinRail, connection, model, note <- straight from the row
// A Cresnet device name that appears in more than one group gets its
// controller appended to the id - for every occurrence, not by row
// order - so ids stay stable when the sheet is re-uploaded.
function parseLcsWorkbook(workbook){
  const sheetName = workbook.SheetNames.find(function(n){ return n.trim().toLowerCase() === 'lcs devices'; });
  if(!sheetName){
    throw new Error('No "LCS Devices" sheet found. Sheet names in this file: ' + workbook.SheetNames.join(', '));
  }
  const ws = workbook.Sheets[sheetName];
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');

  // Displayed text (cell.w) rather than the raw value, so an ID that is
  // really the number 7 formatted as "07" comes through as it looks in Excel.
  const cellText = function(r, c){
    if(c === undefined) return '';
    const cell = ws[XLSX.utils.encode_cell({r, c})];
    if(!cell) return '';
    if(cell.w != null && String(cell.w).trim() !== '') return String(cell.w).trim();
    return cell.v != null ? String(cell.v).trim() : '';
  };

  let headerRow = null, cols = {};
  for(let r = range.s.r; r <= Math.min(range.e.r, range.s.r + 15); r++){
    const found = {};
    for(let c = range.s.c; c <= range.e.c; c++){
      const h = normalizeHeader(cellText(r, c));
      if(!h) continue;
      if(h === 'device') found.device = c;
      else if(h === 'localcresnetdevices') found.child = c;
      else if(h === 'cresnetid') found.cresnetId = c;
      else if(h === 'ipaddress') found.ip = c;
      else if(h === 'ipid') found.ipid = c;
      else if(h === 'installedlocation') found.location = c;
      else if(h === 'dinrail') found.dinRail = c;
      else if(h === 'connection') found.connection = c;
      else if(h === 'note' || h === 'notes') found.note = c;
      else if(h.indexOf('model') !== -1) found.model = c;
    }
    if(found.child !== undefined){ headerRow = r; cols = found; break; }
  }
  if(headerRow === null){
    throw new Error('Couldn\'t find a "Local Cresnet Devices" column in the "LCS Devices" sheet - check the header row is present and spelled recognizably.');
  }

  // The sheet's last column (values like "Z-MT2-13") can come with no
  // header at all. With no Note column, and an unlabeled column right
  // after the last recognized one that actually holds data, take it as
  // the note rather than silently dropping it.
  if(cols.note === undefined){
    const lastRecognized = Math.max.apply(null, Object.keys(cols).map(function(k){ return cols[k]; }));
    const candidate = lastRecognized + 1;
    if(candidate <= range.e.c && !normalizeHeader(cellText(headerRow, candidate))){
      for(let r = headerRow + 1; r <= range.e.r; r++){
        if(cellText(r, candidate)){ cols.note = candidate; break; }
      }
    }
  }

  // Walk the rows once, grouping children under their controller. A
  // controller name starts (or re-enters) a group; IP / IP ID are taken
  // from whichever row of the group carries them first.
  const groups = [], groupByName = {};
  let group = null;
  const enterGroup = function(name){
    if(!groupByName[name]){
      groupByName[name] = {name: name, room: '', ip: '', ipid: '', children: []};
      groups.push(groupByName[name]);
    }
    group = groupByName[name];
  };

  for(let r = headerRow + 1; r <= range.e.r; r++){
    const dev = cellText(r, cols.device);
    const child = cellText(r, cols.child);
    const ip = cellText(r, cols.ip);
    const ipid = cellText(r, cols.ipid);
    const loc = cellText(r, cols.location);
    if(!dev && !child && !ip && !ipid && !loc) continue;                      // blank row
    if(normalizeHeader(child) === 'localcresnetdevices' || normalizeHeader(dev) === 'device') continue; // a repeated header row
    if(dev || !group) enterGroup(dev);
    if(ip && !group.ip) group.ip = ip;
    if(ipid && !group.ipid) group.ipid = ipid;
    if(child){
      group.children.push({
        name: child,
        cresnetId: cellText(r, cols.cresnetId),
        location: loc,
        model: cellText(r, cols.model),
        dinRail: cellText(r, cols.dinRail),
        connection: cellText(r, cols.connection),
        note: cellText(r, cols.note)
      });
    } else if(dev && loc){
      group.room = loc;   // the controller's own row: Installed Location is where the controller lives
    }
  }

  const devices = [];
  groups.forEach(function(g){
    const controller = g.name ? (g.room ? g.name + ' @ ' + g.room : g.name) : '';
    g.children.forEach(function(ch){
      devices.push({
        name: ch.name,
        status: '', level: '', zone: '', channel: '', avio: '',
        location: ch.location || g.name || '',
        model: ch.model, ip: g.ip, ipid: g.ipid, note: ch.note,
        cresnetId: ch.cresnetId, controller: controller,
        dinRail: ch.dinRail, connection: ch.connection,
        ports: [], _group: g.name
      });
    });
  });
  if(!devices.length){
    throw new Error('No Cresnet devices found in "LCS Devices" - each device needs a name in the "Local Cresnet Devices" column.');
  }

  const nameCounts = {};
  devices.forEach(function(d){ const s = slugify(d.name) || 'device'; nameCounts[s] = (nameCounts[s] || 0) + 1; });
  const seen = {};
  devices.forEach(function(d){
    const base = slugify(d.name) || 'device';
    const id = nameCounts[base] > 1 ? base + '-' + (slugify(d._group) || 'x') : base;
    const n = seen[id] || 0;
    seen[id] = n + 1;
    d.id = n === 0 ? id : id + '-' + (n + 1);
    delete d._group;
  });
  devices.forEach(function(d){ d.location = normalizeLocation(d.location); });

  return devices;
}

// AV and LC files are distinguished purely by which sheet they contain
// - "Device Info"/"Component Info"/"Device Report" for AV, "LCS
// Devices" for LC - so the person never has to say which one they're
// uploading; the file already says so. Both present in one file is
// treated as a mistake rather than a guess, since silently picking one
// side could mean the other type's devices go completely unnoticed.
function detectDeviceType(workbook){
  const normalize = function(n){ return n.replace(/\s+/g, '').toLowerCase(); };
  const hasAv = workbook.SheetNames.some(function(n){ return normalize(n) === 'deviceinfo' || normalize(n) === 'componentinfo' || normalize(n) === 'devicereport'; });
  const hasLc = workbook.SheetNames.some(function(n){ return n.trim().toLowerCase() === 'lcs devices'; });
  if(hasAv && hasLc){
    throw new Error('This file has both a "Device Info"-style sheet and an "LCS Devices" sheet - upload one file per type so it\'s clear which set of devices this is.');
  }
  if(hasAv) return 'av';
  if(hasLc) return 'lc';
  throw new Error(
    'Couldn\'t find a "Device Info" or "LCS Devices" sheet in this file. Sheet names found: ' +
    (workbook.SheetNames.length ? workbook.SheetNames.join(', ') : '(none)')
  );
}

// ---------- create project ----------
document.getElementById('createBtn').addEventListener('click', async function(){
  const msgEl = document.getElementById('createMsg');
  const name = document.getElementById('newName').value.trim();
  const shortName = document.getElementById('newShort').value.trim();
  const id = document.getElementById('newId').value.trim().toLowerCase();
  const region = document.getElementById('newRegion').value.trim();
  const fileInput = document.getElementById('newFile');
  const file = fileInput.files[0];

  if(!name){ showMsg(msgEl, 'Project name is required.', 'err'); return; }
  if(!/^[a-z0-9-]{1,80}$/.test(id)){ showMsg(msgEl, 'Project ID must be lowercase letters, numbers, and hyphens only.', 'err'); return; }
  if(!file){ showMsg(msgEl, 'Choose an .xlsx file.', 'err'); return; }
  if(typeof XLSX === 'undefined'){ showMsg(msgEl, 'The Excel-parsing library didn\'t load - check your connection and reload this page.', 'err'); return; }

  const btn = document.getElementById('createBtn');
  btn.disabled = true;

  try{
    showMsg(msgEl, 'Reading file...', 'info');
    const buf = await file.arrayBuffer();
    const workbook = XLSX.read(buf, {type: 'array'});

    showMsg(msgEl, 'Parsing devices...', 'info');
    const deviceType = detectDeviceType(workbook);
    const typeLabel = deviceType === 'lc' ? 'LC' : 'AV';
    const devices = deviceType === 'lc' ? parseLcsWorkbook(workbook) : parseWorkbook(workbook);

    showMsg(msgEl, 'Uploading ' + devices.length + ' devices...', 'info');
    const result = await adminFetch('/api/admin/projects', {
      method: 'POST',
      body: JSON.stringify({id: id, name: name, shortName: shortName, region: region, devices: devices, deviceType: deviceType})
    });

    showMsg(msgEl, 'Created "' + name + '" with ' + result.deviceCount + ' ' + typeLabel + ' devices.', 'ok');
    document.getElementById('newName').value = '';
    document.getElementById('newShort').value = '';
    document.getElementById('newId').value = '';
    document.getElementById('newRegion').value = '';
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
    document.getElementById('gate').innerHTML = '<div class="field-hint">SYNC_API_BASE is not set in config.js - the admin panel needs a configured Worker to do anything. See README.md.</div>';
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
  document.getElementById('newRegion').innerHTML = '<option value="" disabled selected>Select a region...</option>' +
  REGIONS.map(function(r){ return '<option value="' + esc(r) + '">' + esc(r) + '</option>';}).join('');
})();