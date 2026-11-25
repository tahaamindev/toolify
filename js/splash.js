/* ============================================================
   TOOLIFY — Loading screen from loader.html
   Same white reveal wipe, logo float, ground shadow, progress bar
   and soft chime. The loader stays visible for a full 2 seconds
   so the first cloud sync can settle before the app is revealed.
   `window.hideLoader()` / `window.Loader.done()` kept as APIs.
   ============================================================ */

const SPLASH_MIN_MS = 2000;
const SPLASH_MAX_MS = 2000;
const SPLASH_FINISH_DELAY_MS = 30;
const SPLASH_OUT_MS = 170;
const SPLASH_SOUND = true;

let splashShownAt = 0;
let splashHideTask = null;
let splashIsBoot = false;
let splashMaxTimer = null;
let splashReady = false;
let splashFinished = false;
let splashProgress = 0;
let splashLastFrame = 0;
let splashFrame = null;
let splashAudio = null;

function splashElement(){
  return document.getElementById('splash-screen');
}

function splashBarElement(){
  return document.getElementById('splash-bar');
}

function splashExitMs(){
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : SPLASH_OUT_MS;
}

/* ---- soft chime (browser me pehle tap ke baad chalti hai) ---- */
function splashChime(){
  if(!SPLASH_SOUND) return;
  try{
    splashAudio = splashAudio || new (window.AudioContext || window.webkitAudioContext)();
    if(splashAudio.state !== 'running') return;
    [659.25, 987.77].forEach((frequency, index) => {
      const time = splashAudio.currentTime + index * .12;
      const oscillator = splashAudio.createOscillator();
      const gain = splashAudio.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(.0001, time);
      gain.gain.exponentialRampToValueAtTime(.12, time + .02);
      gain.gain.exponentialRampToValueAtTime(.0001, time + 1.3);
      oscillator.connect(gain);
      gain.connect(splashAudio.destination);
      oscillator.start(time);
      oscillator.stop(time + 1.4);
    });
  }catch(error){ /* audio is optional */ }
}

function unlockSplashAudio(){
  try{
    splashAudio = splashAudio || new (window.AudioContext || window.webkitAudioContext)();
    splashAudio.resume();
  }catch(error){ /* audio is optional */ }
}

window.addEventListener('pointerdown', unlockSplashAudio, { once:true, passive:true });
window.addEventListener('keydown', unlockSplashAudio, { once:true });

/* ---- smooth progress, copied from loader.html and sped up ---- */
function stopSplashFrame(){
  if(splashFrame){
    window.cancelAnimationFrame(splashFrame);
    splashFrame = null;
  }
}

function splashTick(now){
  const delta = Math.min((now - splashLastFrame) / 1000, .05);
  splashLastFrame = now;
  const canFinish = now - splashShownAt >= SPLASH_MIN_MS;
  const target = (splashReady && canFinish)
    ? 100
    : (splashReady ? 96 : Math.min(92, (now - splashShownAt) / 22));
  splashProgress += (target - splashProgress) * (1 - Math.exp(-delta * 20));
  if(target === 100 && splashProgress > 99.5) splashProgress = 100;

  const bar = splashBarElement();
  if(bar) bar.style.transform = `scaleX(${splashProgress / 100})`;

  if(splashProgress >= 100 && !splashFinished){
    void splashFinish();
    return;
  }
  splashFrame = window.requestAnimationFrame(splashTick);
}

function startSplashFrame(){
  stopSplashFrame();
  splashLastFrame = performance.now();
  splashFrame = window.requestAnimationFrame(splashTick);
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
    splashReady = true;
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
  stopSplashFrame();
  clearSplashCap();
  splashShownAt = 0;
  splashHideTask = null;
  splashReady = false;
  splashFinished = false;
  splashIsBoot = false;
  if(announce) window.dispatchEvent(new Event('loader:done'));
}

function showSplash(){
  const screen = splashElement();
  if(!screen) return;

  const booting = document.documentElement.classList.contains('toolify-booting');
  const bootAt = booting ? Number(window.TOOLIFY_BOOT_AT) : 0;
  splashIsBoot = booting;
  document.documentElement.classList.add('toolify-booting');
  splashShownAt = bootAt || performance.now();
  splashHideTask = null;
  splashReady = false;
  splashFinished = false;
  splashProgress = 0;

  screen.hidden = false;
  screen.classList.remove('out');
  const bar = splashBarElement();
  if(bar) bar.style.transform = 'scaleX(0)';

  scheduleSplashCap();
  startSplashFrame();
}

async function splashFinish(){
  if(splashFinished) return;
  splashFinished = true;
  stopSplashFrame();
  clearSplashCap();
  splashChime();

  const screen = splashElement();
  if(!screen || screen.hidden){
    finishSplash();
    return;
  }
  if(SPLASH_FINISH_DELAY_MS){
    await new Promise(resolve => window.setTimeout(resolve, SPLASH_FINISH_DELAY_MS));
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
    startSplashFrame();
  }
  splashReady = true;
  if(splashHideTask) return splashHideTask;

  splashHideTask = splashFinish();
  return splashHideTask;
}

function cancelSplash(){
  stopSplashFrame();
  finishSplash(false);
}

/* Start the hard cap even when auth initialization has not called us yet. */
if(document.documentElement.classList.contains('toolify-booting')){
  splashIsBoot = true;
  splashShownAt = Number(window.TOOLIFY_BOOT_AT) || performance.now();
  scheduleSplashCap();
  startSplashFrame();
}

/* Original loader.html / LOADING asset APIs, kept for existing integrations. */
window.hideLoader = () => hideSplash();
window.Loader = { done: () => hideSplash() };
