// ─────────────────────────────────────────────────────────────
// Project picker — lists every project in the database and links
// into index.html?project=<id> for the one the person picks.
// Load order: config.js (defines SYNC_API_BASE, REGIONS), then this file.
// ─────────────────────────────────────────────────────────────

let allProjects = [];
let searchQuery = '';
let activeRegion = '';   // '' = all regions; resets on every page load
const UNSPECIFIED = 'Unspecified';

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

// Defensive against every falsy-ish region value a project might have —
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
// into that bucket. Regions with zero projects still show — an empty
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

document.addEventListener('DOMContentLoaded', function(){
  const select = document.getElementById('regionFilter');
  if(select){
    select.addEventListener('change', function(e){
      activeRegion = e.target.value;
      render();
    });
  }
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
  if(searchQuery.trim()){
    list = list.filter(function(p){ return matchesSearch(p.name) || matchesSearch(p.shortName); });
  }
  if(activeRegion){
    list = list.filter(function(p){ return projectRegion(p) === activeRegion; });
  }

  if(!list.length){
    content.innerHTML = '<div class="empty" style="padding:60px 20px;">'
      + '<div style="font-weight:800;font-size:16px;margin-bottom:6px;color:var(--ink);">'
      + (allProjects.length ? 'No projects match your filters.' : 'No projects yet.')
      + '</div>'
      + (allProjects.length ? '' : '<div>Ask an admin to add one from the <a href="admin.html" style="color:var(--accent);font-weight:700;">admin panel</a>.</div>')
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
    return '<a class="loc-card" href="index.html?project=' + encodeURIComponent(p.id) + '" style="text-decoration:none;display:block;">'
      + '<div class="name">' + esc(p.name) + '</div>'
      + '<div class="meta">' + esc(p.shortName || '') + (p.shortName ? ' &middot; ' : '') + p.deviceCount + ' device' + (p.deviceCount===1?'':'s') + '</div>'
      + '</a>';
  }

  // One region selected (via dropdown, or only one region present after
  // search) → skip the heading entirely, it'd just repeat what's already
  // selected. Otherwise, a bold loc-header per region — reusing the same
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
    const email = (localStorage.getItem('pd_user_email') || '').trim();
    const url = SYNC_API_BASE.replace(/\/$/, '') + '/api/projects?email=' + encodeURIComponent(email);
    const res = await fetch(url);
    if(!res.ok) throw new Error('Request failed (' + res.status + ')');
    const data = await res.json();
    allProjects = data.projects || [];
    renderRegionFilter();
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

loadProjects();