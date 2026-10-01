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

async function loadProjects(){
  const content = document.getElementById('content');
  content.innerHTML = '<div class="empty" style="padding:60px 20px;">Loading projects&hellip;</div>';
  try{
    const email = (sessionStorage.getItem('pd_user_email') || '').trim();
    const url = SYNC_API_BASE.replace(/\/$/, '') + '/api/projects?email=' + encodeURIComponent(email) + '&deviceType=' + DEVICE_TYPE;
    const res = await fetch(url);
    if(!res.ok) throw new Error('Request failed (' + res.status + ')');
    const data = await res.json();
    allProjects = data.projects || [];
    renderRegionFilter();
    renderStatusFilterButtons();
    render();
  }catch(e){
    console.error(e);
    content.innerHTML = '<div class="empty" style="padding:60px 20px;">'
      + '<div style="font-weight:800;font-size:16px;margin-bottom:6px;color:var(--ink);">Couldn\'t load the project list</div>'
      + '<div>Check your connection and try reloading the page.</div>'
      + '</div>';
  }
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