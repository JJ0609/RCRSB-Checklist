// Offline support shared by the project list: saving projects on the device, and
// sending changes that were made offline in a project the person hasn't reopened.
//
// What's kept on the device (app.js reads and writes the same keys - keep them in step):
//   pd_devices_cache_<project>_<side>        {meta, devices, locations, cachedAt}
//   pd_commissioning_cache_<project>_<side>  {checklist, punches}   (punch items still waiting have ids starting "local-")
//   pd_pending_checks_<project>_<side>       {"<deviceId>|<key>": {deviceId, key, value, by}}
//   pd_pending_ops_<project>_<side>          {"<kind>|<id>": {kind, id, data}}    kind: resolve | edit | note
// Project ids are lowercase letters, digits and hyphens, so "_" is a safe separator.
var PDOffline = (function(){
  var LS = window.localStorage;

  function api(path, options, timeoutMs){
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = ctl ? setTimeout(function(){ ctl.abort(); }, timeoutMs || 12000) : null;
    var init = Object.assign({headers: {'Content-Type': 'application/json'}}, options || {}, ctl ? {signal: ctl.signal} : {});
    return fetch(SYNC_API_BASE.replace(/\/$/, '') + path, init).then(function(res){
      if(timer) clearTimeout(timer);
      if(!res.ok){ var err = new Error('HTTP ' + res.status); err.status = res.status; throw err; }
      return res.json();
    }, function(e){ if(timer) clearTimeout(timer); throw e; });
  }
  // The server understood and refused: sending it again can never help. Anything else is worth retrying.
  function isPermanent(e){ return !!(e && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429); }

  function read(key){ try{ var raw = LS.getItem(key); return raw ? JSON.parse(raw) : null; }catch(e){ return null; } }
  // false when the device refuses (storage full / private mode)
  function write(key, value){
    try{
      if(value && !Array.isArray(value) && typeof value === 'object' && !Object.keys(value).length) LS.removeItem(key);
      else LS.setItem(key, JSON.stringify(value));
      return true;
    }catch(e){ return false; }
  }
  function keysWith(prefix){
    var out = [];
    for(var i = 0; i < LS.length; i++){ var k = LS.key(i); if(k && k.indexOf(prefix) === 0) out.push(k); }
    return out;
  }
  function splitKey(prefix, key){
    var rest = key.slice(prefix.length), i = rest.lastIndexOf('_');
    return {project: rest.slice(0, i), side: rest.slice(i + 1)};
  }

  // ---- saving projects for offline use ----
  // Downloads one project's devices and current results for one side and keeps them on
  // this device: exactly what opening the project online would have saved.
  function saveProject(id, side, email){
    var q = '?project=' + encodeURIComponent(id) + '&deviceType=' + side;
    return Promise.all([
      api('/api/devices' + q + '&email=' + encodeURIComponent(email || ''), {method: 'GET'}),
      api('/api/state' + q, {method: 'GET'})
    ]).then(function(r){
      var data = r[0], state = r[1];
      var meta = Object.assign({}, data.project || {name: id, shortName: id}, {deviceCounts: data.deviceCounts || null});
      var ok1 = write('pd_devices_cache_' + id + '_' + side, {meta: meta, devices: data.devices || [], locations: data.locations || [], cachedAt: new Date().toISOString()});
      // punch items still waiting to be sent exist only on this device - never overwrite them
      var key = 'pd_commissioning_cache_' + id + '_' + side;
      var waiting = ((read(key) || {}).punches || []).filter(function(p){ return String(p.id).indexOf('local-') === 0; });
      var ok2 = write(key, {checklist: state.checklist || {}, punches: (state.punches || []).concat(waiting)});
      if(!ok1 || !ok2) throw new Error('not enough storage on this device');
      return (data.devices || []).length;
    });
  }

  // Every active project on both sides, one after another.
  function saveAll(email, onProgress){
    return Promise.all(['av', 'lc'].map(function(side){
      return api('/api/projects?email=' + encodeURIComponent(email) + '&deviceType=' + side, {method: 'GET'}).then(function(d){ return {side: side, projects: d.projects || []}; });
    })).then(function(lists){
      var jobs = [];
      lists.forEach(function(l){ l.projects.filter(function(p){ return !p.archived; }).forEach(function(p){ jobs.push({id: p.id, name: p.name, side: l.side}); }); });
      var failed = [], done = 0;
      return jobs.reduce(function(chain, job){
        return chain.then(function(){
          if(onProgress) onProgress(done, jobs.length, job);
          return saveProject(job.id, job.side, email).catch(function(e){ failed.push({job: job, error: e.message}); }).then(function(){ done++; });
        });
      }, Promise.resolve()).then(function(){
        if(onProgress) onProgress(done, jobs.length, null);
        var names = {}; jobs.forEach(function(j){ names[j.id] = true; });
        write('pd_offline_saved', {at: new Date().toISOString(), projects: Object.keys(names).length, email: email});
        return {total: jobs.length, saved: jobs.length - failed.length, failed: failed};
      });
    });
  }
  function lastSaved(){ return read('pd_offline_saved'); }

  // ---- changes made offline, waiting to be sent ----
  function nameOf(project, side){
    var c = read('pd_devices_cache_' + project + '_' + side);
    return ((c && c.meta && (c.meta.shortName || c.meta.name)) || project) + ' ' + side.toUpperCase();
  }
  function pendingSummary(){
    var by = {};
    function slot(project, side){ var k = project + '|' + side; return by[k] || (by[k] = {project: project, side: side, checks: 0, ops: 0, punches: 0}); }
    keysWith('pd_pending_checks_').forEach(function(k){ var s = splitKey('pd_pending_checks_', k); slot(s.project, s.side).checks = Object.keys(read(k) || {}).length; });
    keysWith('pd_pending_ops_').forEach(function(k){ var s = splitKey('pd_pending_ops_', k); slot(s.project, s.side).ops = Object.keys(read(k) || {}).length; });
    keysWith('pd_commissioning_cache_').forEach(function(k){
      var s = splitKey('pd_commissioning_cache_', k);
      var n = ((read(k) || {}).punches || []).filter(function(p){ return String(p.id).indexOf('local-') === 0 && !p.syncError; }).length;
      if(n) slot(s.project, s.side).punches = n;
    });
    var list = Object.keys(by).map(function(k){ return by[k]; }).filter(function(x){ return x.checks + x.ops + x.punches > 0; });
    list.forEach(function(x){ x.name = nameOf(x.project, x.side); x.count = x.checks + x.ops + x.punches; });
    return {list: list, total: list.reduce(function(n, x){ return n + x.count; }, 0)};
  }

  // Sends one thing. 'ok' = accepted, 'drop' = the server refused it (give up on it), 'retry' = couldn't reach the server.
  function attempt(path, body){
    return api(path, {method: 'POST', body: JSON.stringify(body)}).then(function(r){ return {r: 'ok', data: r}; }, function(e){ return {r: isPermanent(e) ? 'drop' : 'retry'}; });
  }

  // Sends everything saved on this device while offline. Safe to run more than once, even alongside an open
  // project page: every kind of change here SETS a value or carries its own id, so a repeat changes nothing.
  function syncPending(){
    var sum = pendingSummary(), sent = 0, stop = false;
    function step(items, fn){
      return items.reduce(function(chain, it){ return chain.then(function(){ if(stop) return; return fn(it); }); }, Promise.resolve());
    }
    return step(sum.list, function(item){
      var project = item.project, side = item.side;
      var ckKey = 'pd_pending_checks_' + project + '_' + side, opKey = 'pd_pending_ops_' + project + '_' + side, stKey = 'pd_commissioning_cache_' + project + '_' + side;
      var checks = read(ckKey) || {}, ops = read(opKey) || {};
      return step(Object.keys(checks), function(k){
        var c = checks[k];
        return attempt('/api/check', {project: project, deviceId: c.deviceId, key: c.key, value: c.value, updatedBy: c.by || 'Unnamed tech'}).then(function(o){
          if(o.r === 'retry'){ stop = true; return; }
          if(o.r === 'ok') sent++;
          var cur = read(ckKey) || {}; delete cur[k]; write(ckKey, cur);
        });
      }).then(function(){
        return step(Object.keys(ops), function(k){
          var op = ops[k], d = op.data || {}, path, body;
          if(op.kind === 'resolve'){ path = '/api/punch/toggle'; body = {project: project, id: op.id, status: d.status, actorName: d.by}; }
          else if(op.kind === 'edit'){ path = '/api/punch/edit'; body = {project: project, id: op.id, description: d.description, severity: d.severity, ownership: d.ownership, actorName: d.by}; }
          else{ path = '/api/device/note'; body = {project: project, deviceId: op.id, note: d.note, actorName: d.by}; }
          return attempt(path, body).then(function(o){
            if(o.r === 'retry'){ stop = true; return; }
            if(o.r === 'ok') sent++;
            var cur = read(opKey) || {}; delete cur[k]; write(opKey, cur);
          });
        });
      }).then(function(){
        var punchList = ((read(stKey) || {}).punches || []).filter(function(p){ return String(p.id).indexOf('local-') === 0 && !p.syncError; });
        return step(punchList, function(p){
          var localId = p.id;
          return attempt('/api/punch', {project: project, deviceId: p.deviceId, deviceName: p.deviceName, location: p.location, description: p.description,
            severity: p.severity, ownership: p.ownership, reportedBy: p.reportedBy, deviceType: side, clientId: p.clientId || String(p.id).replace(/^local-/, '')}).then(function(o){
            if(o.r === 'retry'){ stop = true; return; }
            var st = read(stKey) || {punches: [], checklist: {}}, mine = (st.punches || []).filter(function(x){ return x.id === localId; })[0];
            if(o.r === 'drop'){ if(mine) mine.syncError = 'refused by the server'; write(stKey, st); return; }
            sent++;
            if(mine){ mine.id = o.data.id; delete mine.clientId; }
            write(stKey, st);
            if(p.status === 'resolved') return attempt('/api/punch/toggle', {project: project, id: o.data.id, status: 'resolved', actorName: p.resolvedBy || p.reportedBy}).then(function(o2){ if(o2.r === 'ok') sent++; });
          });
        });
      });
    }).then(function(){ return {sent: sent, remaining: pendingSummary().total}; });
  }

  return {saveProject: saveProject, saveAll: saveAll, lastSaved: lastSaved, pendingSummary: pendingSummary, syncPending: syncPending};
})();
