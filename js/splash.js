/* ============================================================
   TOOLIFY — Pill loading screen
   Sliding TOOLIFY bar. No image, sound or layout shift. The loader
   stays for at least 2 seconds and hides only after the app is ready.
   `window.hideLoader()` / `window.Loader.done()` kept as APIs.
   ============================================================ */

const SPLASH_MIN_MS = 2000;
const SPLASH_MAX_MS = 10000; /* safety cap if a cloud call hangs */
const SPLASH_OUT_MS = 120;

let splashShownAt = 0;
let splashHideTask = null;
let splashIsBoot = false;
let splashMaxTimer = null;
let splashFinished = false;
let splashTaskId = 0;

function splashElement(){
  return document.getElementById('splash-screen');
}

function splashExitMs(){
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : SPLASH_OUT_MS;
}

function clearSplashCap(){
  if(splashMaxTimer){
    window.clearTimeout(splashMaxTimer);
    splashMaxTimer = null;
  }
}

function scheduleSplashCap(){
  clearSplashCap();
  /* A page open is capped from navigation start; an in-app login is capped
     from the moment the loader was shown. */
  const elapsed = splashIsBoot
    ? performance.now()
    : (splashShownAt ? performance.now() - splashShownAt : 0);
  splashMaxTimer = window.setTimeout(() => {
    void hideSplash();
  }, Math.max(0, SPLASH_MAX_MS - elapsed));
}

function finishSplash(announce = true){
  const screen = splashElement();
  if(screen){
    screen.hidden = true;
    screen.classList.remove('out');
  }
  document.documentElement.classList.remove('toolify-booting');
  clearSplashCap();
  splashShownAt = 0;
  splashHideTask = null;
  splashFinished = false;
  splashIsBoot = false;
  if(announce) window.dispatchEvent(new Event('loader:done'));
}

async function splashFinish(){
  if(splashFinished) return;
  splashFinished = true;
  clearSplashCap();

  const screen = splashElement();
  if(!screen || screen.hidden){
    finishSplash();
    return;
  }
  const exitMs = splashExitMs();
  if(exitMs){
    screen.classList.add('out');
    await new Promise(resolve => window.setTimeout(resolve, exitMs));
  }
  finishSplash();
}

async function hideSplash(){
  if(!splashShownAt){
    if(!document.documentElement.classList.contains('toolify-booting')) return;
    splashIsBoot = true;
    splashShownAt = Number(window.TOOLIFY_BOOT_AT) || performance.now();
  }
  if(splashHideTask) return splashHideTask;

  const taskId = splashTaskId;
  const waitMs = Math.max(0, SPLASH_MIN_MS - (performance.now() - splashShownAt));
  splashHideTask = (async () => {
    if(waitMs) await new Promise(resolve => window.setTimeout(resolve, waitMs));
    if(taskId !== splashTaskId) return;
    await splashFinish();
  })();
  return splashHideTask;
}

function showSplash(){
  const screen = splashElement();
  if(!screen) return;

  const booting = document.documentElement.classList.contains('toolify-booting');
  const bootAt = booting ? Number(window.TOOLIFY_BOOT_AT) : 0;
  splashTaskId++;
  splashIsBoot = booting;
  document.documentElement.classList.add('toolify-booting');
  splashShownAt = bootAt || performance.now();
  splashHideTask = null;
  splashFinished = false;

  screen.hidden = false;
  screen.classList.remove('out');
  scheduleSplashCap();
}

function cancelSplash(){
  splashTaskId++;
  finishSplash(false);
}

/* Start the safety cap even when auth initialization has not called us yet. */
if(document.documentElement.classList.contains('toolify-booting')){
  splashIsBoot = true;
  splashShownAt = Number(window.TOOLIFY_BOOT_AT) || performance.now();
  scheduleSplashCap();
}

/* Original loader.html / LOADING asset APIs, kept for existing integrations. */
window.hideLoader = () => hideSplash();
window.Loader = { done: () => hideSplash() };
