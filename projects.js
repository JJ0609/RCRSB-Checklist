// ─────────────────────────────────────────────────────────────
// Project picker — lists every project in the database and links
// into index.html?project=<id> for the one the person picks.
// Load order: config.js, then this file.
// ─────────────────────────────────────────────────────────────

let allProjects = [];
let searchQuery = '';

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

  if(!list.length){
    content.innerHTML = '<div class="empty" style="padding:60px 20px;">'
      + '<div style="font-weight:800;font-size:16px;margin-bottom:6px;color:var(--ink);">'
      + (allProjects.length ? 'No projects match your search.' : 'No projects yet.')
      + '</div>'
      + (allProjects.length ? '' : '<div>Ask an admin to add one from the <a href="admin.html" style="color:var(--accent);font-weight:700;">admin panel</a>.</div>')
      + '</div>';
    return;
  }

  let html = '<div class="section-label">' + list.length + ' project' + (list.length===1?'':'s') + '</div>';
  html += '<div class="loc-grid">';
  list.forEach(function(p){
    html += '<a class="loc-card" href="index.html?project=' + encodeURIComponent(p.id) + '" style="text-decoration:none;display:block;">'
      + '<div class="name">' + esc(p.name) + '</div>'
      + '<div class="meta">' + esc(p.shortName || '') + (p.shortName ? ' &middot; ' : '') + p.deviceCount + ' device' + (p.deviceCount===1?'':'s') + '</div>'
      + '</a>';
  });
  html += '</div>';
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
