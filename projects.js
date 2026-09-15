// ─────────────────────────────────────────────────────────────
// Project picker — lists every project in the database and links
// into index.html?project=<id> for the one the person picks.
// Load order: config.js, then this file.
// ─────────────────────────────────────────────────────────────

let allProjects = [];
let searchQuery = '';
let activeRegions =[];
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

function projectRegion(p){
  return p.region || UNSPECIFIED;
}

// Chip list: every region in REGIONS (config.js), in that fixed order,
// plus "Unspecified" at the end if any project actually lacks a refion.
// Regions with zero projects still show, an empty region is worth seeing
function regionsForChips(){
  const list = (typeof REGIONS !== 'undefined' ? REGIONS.slice() : []);
  if(allProjects.some(function(p){ return !p.region; }))
    list.push(UNSPECIFIED);
  return list;
}

function renderRegionChips(){
  const row = document.getElementById('regionFilterRow');
  if(!row) return;
  const regions = regionsForChips();
  let html = '<button class="chip' + (activeRegions.length===0 ? ' active' : '') + '" data-region="">All</button>';
  regions.forEach(function(r){
    const isActive = activeRegions.indexOf(r) !== -1;
    html += '<button class="chip' + (isActive ? ' active' : '') + '" data-region="' + esc(r) + '">' + esc(r) + '</button>';
  });
  row.innerHTML = html;
}

document.addEventListener('DOMContentLoaded', function(){
  const row = document.getElementById('regionFilterRow');
  if(row){
    row.addEventListener('click', function(e){
      const chip = e.target.closest('[data-region]');
      if(!chip) return;
      const region = chip.getAttribute('data-region');
      if(region === ''){
        activeRegions = [];
      } else {
        const idx = activeRegions.indexOf(region);
        if(idx === -1) activeRegions.push(region); else activeRegions.splice(idx, 1);
      }
      renderRegionChips();
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
  if(activeRegions.length){
    list = list.filter(function(p){ return activeRegions.indexOf(projectRegion(p)) !== -1; });
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

  // Group by region only when more than one region is actually present
  // in the filtered setm a single-region view (or a fully filtered-down
  // one) doesn't need a redundant header repeating whatr the chips already say
const byRegion = {};
  list.forEach(function(p){
    const r = projectRegion(p);
    if(!byRegion[r]) byRegion[r] = [];
    byRegion[r].push(p);
  });
  const regionKeys = Object.keys(byRegion);
  const showHeaders = regionKeys.length > 1;

  function cardHtml(p){
    return '<a class="loc-card" href="index.html?project=' + encodeURIComponent(p.id) + '" style="text-decoration:none;display:block;">'
      + '<div class="name">' + esc(p.name) + '</div>'
      + '<div class="meta">' + esc(p.shortName || '') + (p.shortName ? ' &middot; ' : '') + p.deviceCount + ' device' + (p.deviceCount===1?'':'s') + '</div>'
      + '</a>';
  }

  let html = '';
  if(!showHeaders){
    html += '<div class="section-label">' + list.lenth + ' project' + (list.length===1?'':'s') + '</div>';
    html += '<div class="loc-grid">' + list.map(cardHtml).join('') + '</div>';
  } else {
    const orderedRegions = (typeof REGIONS !== 'undefined' ? REGIONS.slice() : []).concat([UNSPECIFIED]).filter(function(r){ return byRegion[r]; });
    orderedRegions.forEach(function(r){
      const projs = byRegion[r];
      html += '<div class="section-label">' + esc(r) + ' &middot; ' + projs.length + ' project' + (projs.length===1?'':'s') + '</div>';
      html += '<div class="loc-grid">' + projs.map(cardHtml).join('') + '</div>';
    });
  }
  content.innerHTML = html;
}

async function loadProjects(){
  const content = document.getElementById('content');
  content.innerHTML = '<div class="empty" style="padding:60px 20px;">Loading projects&hellip;</div>';
  try{
    const url = SYNC_API_BASE.replace(/\/$/, '') + '/api/projects';
    const res = await fetch(url);
    if(!res.ok) throw new Error('Request failed (' + res.status + ')');
    const data = await res.json();
    allProjects = data.projects || [];
    renderRegionChips();
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
