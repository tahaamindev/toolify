/* ============================================================
   TOOLIFY — UI utilities, toast, theme & mac menubar helpers
   Split from the original app.js (behaviour preserved).
   ============================================================ */

/* ============================================================
   2. UTILITIES
   ============================================================ */
function uid(){
  return 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,9);
}
function nowISO(){ return new Date().toISOString(); }
function escapeHTML(str){
  const d = document.createElement('div');
  d.textContent = str == null ? "" : String(str);
  return d.innerHTML;
}
function debounce(fn, wait){
  let t;
  return function(...args){ clearTimeout(t); t = setTimeout(()=>fn.apply(this,args), wait); };
}

/* URL normalization & validation */
const SAFE_PROTOCOLS = ["http:", "https:"];
function normalizeURL(raw){
  if(!raw) return null;
  let s = raw.trim();
  if(!s) return null;
  // reject dangerous schemes explicitly even before URL parsing
  const lowered = s.toLowerCase();
  const dangerous = ["javascript:", "data:", "file:", "vbscript:", "about:", "blob:"];
  if(dangerous.some(p => lowered.startsWith(p))) return null;
  if(!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)){
    s = "https://" + s;
  }
  try{
    const u = new URL(s);
    if(!SAFE_PROTOCOLS.includes(u.protocol)) return null;
    if(!u.hostname || !u.hostname.includes(".")) {
      // allow localhost-like single-word hosts to fail gracefully but still permit if it has a dot or is a valid host
      if(u.hostname.length < 1) return null;
    }
    return u.href;
  }catch(e){
    return null;
  }
}
function normalizeForDupCheck(urlStr){
  try{
    const u = new URL(urlStr);
    let host = u.hostname.toLowerCase().replace(/^www\./,'');
    let path = u.pathname.replace(/\/$/,'');
    return (host + path + u.search).toLowerCase();
  }catch(e){ return urlStr.toLowerCase(); }
}
function isSafeToOpen(urlStr){
  try{
    const u = new URL(urlStr);
    return SAFE_PROTOCOLS.includes(u.protocol);
  }catch(e){ return false; }
}
function faviconURLFor(urlStr){
  try{
    const u = new URL(urlStr);
    return `https://www.google.com/s2/favicons?sz=64&domain=${u.hostname}`;
  }catch(e){ return null; }
}
function initialFor(name){
  if(!name) return "?";
  const trimmed = name.trim();
  return trimmed.length ? trimmed[0].toUpperCase() : "?";
}


/* ============================================================
   4. TOAST
   ============================================================ */
function playClickSound(){
  const pref = State.settings.clickSound || 'off';
  if(pref === 'off') return;
  try{
    const ctx = playClickSound._ctx || (playClickSound._ctx = new (window.AudioContext || window.webkitAudioContext)());
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    if(pref === 'click'){ osc.type='square'; osc.frequency.setValueAtTime(820, now); gain.gain.setValueAtTime(0.08, now); gain.gain.exponentialRampToValueAtTime(0.0001, now+0.06); osc.start(now); osc.stop(now+0.06); }
    else if(pref === 'pop'){ osc.type='sine'; osc.frequency.setValueAtTime(620, now); osc.frequency.exponentialRampToValueAtTime(280, now+0.09); gain.gain.setValueAtTime(0.1, now); gain.gain.exponentialRampToValueAtTime(0.0001, now+0.1); osc.start(now); osc.stop(now+0.1); }
    else if(pref === 'ding'){ osc.type='sine'; osc.frequency.setValueAtTime(880, now); gain.gain.setValueAtTime(0.1, now); gain.gain.exponentialRampToValueAtTime(0.0001, now+0.25); osc.start(now); osc.stop(now+0.25); }
  }catch(e){}
}
function toast(msg, type, duration=2600){
  const stack = document.getElementById('toast-stack');
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' error' : '');
  const icon = type === 'error'
    ? '<svg viewBox="0 0 24 24" fill="none"><path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="currentColor" stroke-width="1.8"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  el.innerHTML = `<span class="toast-icon">${icon}</span><span></span>`;
  el.querySelector('span:last-child').textContent = msg;
  document.getElementById('toast-stack').appendChild(el);
  setTimeout(()=>{
    el.classList.add('leaving');
    setTimeout(()=>el.remove(), 200);
  }, duration);
}

function showFeatureAnnouncement(){
  const announcement = document.getElementById('feature-announcement');
  if(announcement) announcement.hidden=false;
}

function dismissFeatureAnnouncement(){
  const announcement=document.getElementById('feature-announcement');
  if(announcement) announcement.hidden=true;
}


/* ============================================================
   18. THEME
   ============================================================ */
function applyTheme(){
  let mode = State.settings.theme;
  if(mode === 'system'){
    mode = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  const root=document.documentElement;
  root.setAttribute('data-theme', mode);
  const palette=MUSIC_THEMES[State.settings.colorTheme]?MUSIC_THEMES[State.settings.colorTheme]:MUSIC_THEMES.classic;
  root.dataset.palette=MUSIC_THEMES[State.settings.colorTheme]?State.settings.colorTheme:'classic';
  const accent=/^#[\da-f]{6}$/i.test(State.settings.customAccent||'')?State.settings.customAccent:palette.accent;
  root.style.setProperty('--accent',accent);
  root.style.setProperty('--accent-strong',accent);
  window.dispatchEvent(new CustomEvent('toolify:apply-clock-theme',{detail:{theme:State.settings.clockTheme||'emerald'}}));
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', ()=>{
  if(State.settings.theme === 'system') applyTheme();
});


function closeMobileSidebar(){
  document.getElementById('sidebar').classList.remove('mobile-open');
}

function updateMacClock(){
  const clock = document.getElementById('mac-clock');
  if(!clock) return;
  const now = new Date();
  clock.textContent = now.toLocaleString([], {
    weekday:'short', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'
  });
  clock.dateTime = now.toISOString();
}
