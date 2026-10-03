/* ============================ persistence ============================
   Cloudflare Worker build. Offline-first: every change lands in
   localStorage straight away so the app keeps working in a client's house
   with no signal, then goes to the Worker when there is signal. Records
   merge by `updatedAt`, newest wins per record, so two teammates can both
   be editing without clobbering each other. */

/* The Worker has D1 photo storage behind it, so the photo-attach control renders here. */
var PHOTOS_ENABLED = true;
function uploadPhoto(blob){
  return fetch("/api/photo", {
    method: "POST",
    headers: {"Content-Type": blob.type || "image/jpeg"},
    body: blob
  }).then(function(res){
    if(!res.ok) throw new Error("upload failed: " + res.status);
    return res.json();
  }).then(function(data){ return data.key; });
}

var CACHE_KEY = "jobbook.worker.v1";
var lastSync = 0;
var dirty = null;
var pushTimer = null, pullTimer = null, failures = 0, syncing = false;
var offlineSince = 0;
var POLL_MS = 9000;

function freshDirty(){
  var d = {settings: false};
  KINDS.forEach(function(k){ d[k] = {}; });
  return d;
}
dirty = freshDirty();

function setSync(s, text){
  var el = document.getElementById("sync");
  el.setAttribute("data-s", s);
  el.textContent = text;
}

function hasDirty(){
  if(dirty.settings) return true;
  for(var i=0;i<KINDS.length;i++){
    if(Object.keys(dirty[KINDS[i]]).length) return true;
  }
  return false;
}

function touch(rec, kind){
  rec.updatedAt = Date.now();
  if(kind === "settings") dirty.settings = true;
  else if(kind && dirty[kind]) dirty[kind][rec.id] = 1;
  saveCache();
}

function saveCache(){
  try{
    localStorage.setItem(CACHE_KEY, JSON.stringify({state:state, lastSync:lastSync, dirty:dirty}));
  }catch(e){}
}

function loadCache(){
  try{
    var raw = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if(raw && raw.state && raw.state.clients){
      state = raw.state;
      KINDS.forEach(function(k){ if(!state[k]) state[k] = []; });
      lastSync = raw.lastSync || 0;
      dirty = Object.assign(freshDirty(), raw.dirty || {});
      return true;
    }
  }catch(e){}
  return false;
}

function collectDirty(){
  var out = {};
  KINDS.forEach(function(k){
    out[k] = state[k].filter(function(r){ return dirty[k][r.id]; });
  });
  if(dirty.settings) out.settings = state.settings;
  return out;
}

function pendingCount(out){
  var n = dirty.settings ? 1 : 0;
  KINDS.forEach(function(k){ n += out[k].length; });
  return n;
}

/* Anything still dirty here is ours and unsent, so the server's copy must
   not overwrite it — our next push settles the difference. */
function applyRemote(data){
  var changed = false;
  KINDS.forEach(function(kind){
    (data[kind] || []).forEach(function(inc){
      if(!inc || !inc.id) return;
      var list = state[kind], found = null;
      for(var i=0;i<list.length;i++){ if(list[i].id === inc.id){ found = list[i]; break; } }
      if(!found){ list.push(inc); changed = true; }
      else if(!dirty[kind][inc.id] && (inc.updatedAt||0) > (found.updatedAt||0)){
        Object.assign(found, inc);
        changed = true;
      }
    });
  });
  if(data.settings && !dirty.settings &&
     (data.settings.updatedAt||0) > ((state.settings && state.settings.updatedAt)||0)){
    state.settings = data.settings;
    changed = true;
  }
  if(data.now) lastSync = data.now;
  return changed;
}

function isEditing(){
  var a = document.activeElement;
  return !!(a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT"));
}

function schedulePush(){
  clearTimeout(pushTimer);
  setSync("saving", "saving…");
  pushTimer = setTimeout(function(){ sync(true); }, 900);
}
function scheduleSave(){ schedulePush(); }

function sync(push){
  if(syncing) return Promise.resolve();
  syncing = true;

  var sending = push ? collectDirty() : null;
  var count = sending ? pendingCount(sending) : 0;

  var request = count
    ? fetch("/api/sync", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({since:lastSync, changes:sending})
      })
    : fetch("/api/state?since=" + lastSync);

  return request.then(function(res){
    if(res.status === 401){ location.href = "/"; return null; }
    if(!res.ok) throw new Error("http " + res.status);
    return res.json();
  }).then(function(data){
    if(!data) return;

    if(count){
      KINDS.forEach(function(k){
        sending[k].forEach(function(r){ delete dirty[k][r.id]; });
      });
      if(sending.settings) dirty.settings = false;
    }

    var changed = applyRemote(data);
    saveCache();
    failures = 0;
    var wasOffline = !!offlineSince;
    offlineSince = 0;

    setSync("saved", hasDirty() ? "saving…"
      : "synced " + new Date().toLocaleTimeString("en-AU", {hour:"numeric", minute:"2-digit"}));

    if((changed || wasOffline) && !isEditing()) render();
  }).catch(function(){
    failures++;
    if(!offlineSince){ offlineSince = Date.now(); if(!isEditing()) render(); }
    setSync("error", hasDirty() ? "saved on this phone" : "no signal");
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function(){ sync(true); }, Math.min(30000, 2500 * failures));
  }).finally(function(){
    syncing = false;
  });
}

function startPolling(){
  clearInterval(pullTimer);
  pullTimer = setInterval(function(){
    if(document.visibilityState === "visible") sync(hasDirty());
  }, POLL_MS);
}

document.addEventListener("visibilitychange", function(){
  if(document.visibilityState === "visible") sync(hasDirty());
});
window.addEventListener("online", function(){ sync(true); });

function load(){
  var cached = loadCache();
  if(cached){
    render();
    setSync("saving", "syncing…");
  }else{
    state = {v:2, settings:{nextInvoiceNo:1}, clients:[], visits:[], notes:[]};
    setSync("saving", "loading…");
  }
  return sync(hasDirty()).then(function(){
    render();
    startPolling();
  });
}
