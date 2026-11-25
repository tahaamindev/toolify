/* ============================================================
   TOOLIFY — Authentication & startup
   Split from the original app.js (behaviour preserved).
   ============================================================ */

/* ============================================================
   21. AUTHENTICATION + INIT
   ============================================================ */
let authMode='login';
let manualSignOut=false;
let recoveryActive=false;
function authMessage(message,isError=false){const el=document.getElementById('auth-message');el.textContent=message;el.classList.toggle('error',isError);}
function isOfflineError(error){
  if(typeof navigator!=='undefined' && navigator.onLine===false) return true;
  const message=String(error?.message||error||'').toLowerCase();
  return /failed to fetch|networkerror|network error|load failed|err_internet_disconnected|err_network|err_connection|timed? ?out|fetch failed/.test(message);
}
const OFFLINE_AUTH_MESSAGE="It looks like you don't have an internet connection. Please check your connection and try again.";
const OFFLINE_LIBRARY_MESSAGE="It looks like you're offline — showing your saved library on this device.";
function setAuthMode(mode){authMode=mode;const title=document.getElementById('auth-title'),sub=document.getElementById('auth-sub'),submit=document.getElementById('auth-submit'),toggle=document.getElementById('auth-toggle'),forgot=document.getElementById('auth-forgot');const isSignup=mode==='signup';document.getElementById('auth-confirm-wrap').style.display=isSignup?'block':'none';document.getElementById('auth-password-wrap').style.display='block';document.getElementById('auth-password').required=true;document.getElementById('auth-confirm').required=isSignup;title.textContent=isSignup?'Create your account':'Welcome back';sub.textContent=isSignup?'Create an account to keep your tools synced securely.':'Sign in to access your personal cloud-synced tool library.';submit.textContent=isSignup?'Create account':'Sign in';toggle.textContent=isSignup?'Already have an account? Sign in':'New to Toolify? Sign up';forgot.style.display=isSignup?'none':'block';authMessage('');}
async function showAuthenticatedApp(user){
  if(currentUser && currentUser.id===user.id) return;
  setCurrentUser(user);
  State.tools=[];
  State.categories=[];
  State.settings={theme:'dark',view:'grid',sort:'recent',lastBackupAt:null,landing:'auto',clickSound:'click',clockTheme:'emerald',quickTools:undefined,notes:[],tasks:[],updatedAt:0};
  showSplash('Restoring your workspace…');
  setLibraryLoading(true);
  document.getElementById('auth-screen').style.display='none';
  document.getElementById('app').style.display='flex';
  document.getElementById('mac-signout').title=user.email||'Sign out';
  render();

  /* The cached library is already on screen. Cloud data is merged in the
     background so the short splash never sits idle waiting on network. */
  const refreshFromCloud = async () => {
    const revisionBeforeSync = window.TOOLIFY_SETTINGS_REVISION || 0;
    try{
      await DB.syncForUser(user);
      if(currentUser?.id !== user.id) return;
      const [tools,categories,settingsRows,books]=await Promise.all([
        DB.getAll('tools'), DB.getAll('categories'), DB.getAll('settings'), DB.getAllBooks()
      ]);
      State.tools=tools;
      State.categories=categories;
      const saved=settingsRows.find(row=>row.key==='app');
      if(saved){
        /* If a note/task was added while the cloud snapshot was loading, keep
           the newer local state and re-save it instead of overwriting it. */
        if((window.TOOLIFY_SETTINGS_REVISION || 0) > revisionBeforeSync){
          await persistSettings();
        }else{
          Object.assign(State.settings,saved.value);
        }
      }
      bookItems=books.sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
      renderBooks();
      setLibraryLoading(false);
      applyTheme();
      render();
      try{
        await DB.syncBooksForUser(user);
        const refreshed=await DB.getAllBooks();
        if(currentUser?.id !== user.id) return;
        bookItems=refreshed.sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
        renderBooks();
      }catch(bookError){
        console.warn('Book sync unavailable:',bookError);
      }
    }catch(error){
      console.warn('Cloud sync unavailable:',error);
      setLibraryLoading(false);
      render();
      toast(isOfflineError(error)?OFFLINE_LIBRARY_MESSAGE:'Cloud sync is unavailable — showing your saved library.','error');
    }
  };

  try{
    await DB.open();
    await initAppData();
    showFeatureAnnouncement();
    setLibraryLoading(false);
    applyTheme();
    render();
    void refreshFromCloud();
    await hideSplash();
  }catch(error){
    cancelSplash();
    setLibraryLoading(false);
    render();
    console.error(error);
    if(isOfflineError(error)){
      toast(OFFLINE_LIBRARY_MESSAGE,'error');
      return;
    }
    authMessage('We couldn\'t open your library right now. Please try again.',true);
    document.getElementById('auth-screen').style.display='';
    document.getElementById('app').style.display='none';
  }
}
async function initAppData(){
  try{
    const [tools,categories,settingsRows]=await Promise.all([DB.getAll('tools'),DB.getAll('categories'),DB.getAll('settings')]);
    State.tools=tools;
    State.categories=categories;
    const saved=settingsRows.find(r=>r.key==='app');
    if(saved) Object.assign(State.settings,saved.value);
  }catch(e){ toast('Could not load saved data','error'); }
  ensureUncategorized();
  const ids=new Set(State.categories.map(c=>c.id));
  let fixed=false;
  State.tools.forEach(t=>{
    if(!ids.has(t.categoryId)){ t.categoryId=UNCATEGORIZED_ID; fixed=true; }
  });
  try{
    /* Startup repairs stay local; the first cloud sync uploads the result. */
    if(fixed) await DB.bulkPutLocal('tools',State.tools);
    if(!State.categories.length) ensureUncategorized();
    await DB.bulkPutLocal('categories',State.categories);
  }catch(e){ console.warn('Offline: local library kept, cloud update skipped:',e); }
  applyTheme();
  resetMusicSettingsRef();
  State.ui.activeNav=State.tools.some(t=>t.favorite)?'favorites':'all';
  wireEvents();
  render();
}
async function init(){
  if(!supabaseClient){
    cancelSplash();
    document.getElementById('auth-screen').style.display='';
    authMessage(navigator.onLine===false?OFFLINE_AUTH_MESSAGE:'Sign-in services are unavailable right now. Please refresh and try again.',true);
    return;
  }
  try{
    await DB.open();
  }catch(error){
    console.error('Could not open local database:',error);
    cancelSplash();
    document.getElementById('auth-screen').style.display='';
    authMessage('Local storage is unavailable. Enable site storage and refresh.',true);
    return;
  }
  const recoveryUrl = new URL(window.location.href);
  const hashParams = new URLSearchParams(recoveryUrl.hash.replace(/^#/, ''));
  const recoveryType = recoveryUrl.searchParams.get('type') === 'recovery' ||
    hashParams.get('type') === 'recovery';
  const authCallbackPending = recoveryUrl.searchParams.has('code') ||
    recoveryUrl.searchParams.has('error_code') ||
    hashParams.has('access_token') ||
    hashParams.has('code') ||
    hashParams.has('error_code');
  let authUrlProcessing = authCallbackPending;
  recoveryActive = recoveryType;
  supabaseClient.auth.onAuthStateChange(async(event,session)=>{
    if(event==='TOKEN_REFRESH_FAILED'){await supabaseClient.auth.refreshSession().catch(()=>{});return;}
    if(event==='PASSWORD_RECOVERY'){
      recoveryActive=true;
      authUrlProcessing=false;
      cancelSplash();
      document.getElementById('app').style.display='none';
      document.getElementById('auth-screen').style.display='';
      document.getElementById('password-reset-overlay').classList.add('open');
      document.getElementById('password-reset-new').focus();
      return;
    }
    if(recoveryActive || authUrlProcessing) return;
    if(event==='SIGNED_IN'||event==='INITIAL_SESSION'||event==='TOKEN_REFRESHED'){if(session?.user&&!currentUser){await showAuthenticatedApp(session.user);}return;}
    if(event==='SIGNED_OUT'){
      /* Supabase can emit SIGNED_OUT during a token refresh blip. Retry once
         before showing login, and never wipe the local library unless the
         user pressed Sign out. */
      const wasManual = manualSignOut;
      manualSignOut=false;
      cancelSplash();
      if(!wasManual){
        const retried = await supabaseClient.auth.getSession().catch(()=>({data:{session:null}}));
        if(retried.data?.session?.user && !currentUser){
          await showAuthenticatedApp(retried.data.session.user);
          return;
        }
      }
      if(currentUser){setCurrentUser(null); if(wasManual) await DB.clearLocal();}
      document.getElementById('app').style.display='none';
      document.getElementById('auth-screen').style.display='';
      setAuthMode('login');
      return;
    }
    if(session?.user&&!currentUser){await showAuthenticatedApp(session.user);}
  });
  /* Keep the saved session fresh when a tab or the device wakes up, so the
     app does not drop back to the login screen on every reopen. */
  const refreshSavedSession = ()=>{
    if(!supabaseClient) return;
    void supabaseClient.auth.refreshSession().then(({data})=>{
      if(data?.session?.user && !currentUser) return showAuthenticatedApp(data.session.user);
    }).catch(()=>{});
  };
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState==='visible') refreshSavedSession();
  });
  window.addEventListener('online',refreshSavedSession);
  const {data:{session}}=await supabaseClient.auth.getSession();
  if(authUrlProcessing){
    window.setTimeout(()=>{
      authUrlProcessing=false;
      if(!recoveryActive){
        supabaseClient.auth.getSession().then(async ({data:{session:currentSession}})=>{
          if(currentSession?.user&&!currentUser){
            await showAuthenticatedApp(currentSession.user);
            return;
          }
          if(!currentUser){
            await hideSplash();
            document.getElementById('auth-screen').style.display='';
            document.getElementById('app').style.display='none';
            setAuthMode('login');
          }
        }).catch(()=>{});
      }
    },1500);
  }
  if(session?.user){
    if(recoveryType){
      recoveryActive=true;
      cancelSplash();
      document.getElementById('app').style.display='none';
      document.getElementById('auth-screen').style.display='';
      document.getElementById('password-reset-overlay').classList.add('open');
      document.getElementById('password-reset-new').focus();
    }else{
      await showAuthenticatedApp(session.user);
    }
  }else if(!authUrlProcessing){
    await hideSplash();
    document.getElementById('auth-screen').style.display='';
    document.getElementById('app').style.display='none';
  }
}
document.getElementById('auth-form').addEventListener('submit',async e=>{
  e.preventDefault();const email=document.getElementById('auth-email').value.trim();const password=document.getElementById('auth-password').value;const submit=document.getElementById('auth-submit');submit.disabled=true;authMessage('Please wait…');
  try{
    if(authMode==='signup'){
      if(password!==document.getElementById('auth-confirm').value)throw new Error('Passwords do not match.');
      const {data,error}=await supabaseClient.auth.signUp({email,password,options:{emailRedirectTo:window.location.origin+window.location.pathname}});if(error)throw error;
      authMessage(data.session?'Account created. Loading your library…':'Account created. Check your email and verify your address before signing in.');
      if(data.session)await showAuthenticatedApp(data.user);
    }else{
      const {data,error}=await supabaseClient.auth.signInWithPassword({email,password});if(error)throw error;await showAuthenticatedApp(data.user);
    }
  }catch(err){authMessage(isOfflineError(err)?OFFLINE_AUTH_MESSAGE:(err.message||'Authentication failed.'),true);}finally{submit.disabled=false;}
});
document.getElementById('auth-toggle').addEventListener('click',()=>setAuthMode(authMode==='signup'?'login':'signup'));
document.getElementById('auth-forgot').addEventListener('click',async()=>{
  const email=document.getElementById('auth-email').value.trim();
  if(!email){authMessage('Enter your email address first.',true);document.getElementById('auth-email').focus();return;}
  const button=document.getElementById('auth-forgot');button.disabled=true;
  try{
    const {error}=await supabaseClient.auth.resetPasswordForEmail(email,{
      redirectTo:window.location.origin+window.location.pathname+'?type=recovery'
    });
    if(error)throw error;
    authMessage('Password reset link sent. Check your email.');
  }catch(err){authMessage(isOfflineError(err)?OFFLINE_AUTH_MESSAGE:(err.message||'Could not send the reset link.'),true);}
  finally{button.disabled=false;}
});

async function signOut(){
  manualSignOut=true;
  cancelSplash();
  setCurrentUser(null);
  document.getElementById('app').style.display='none';
  document.getElementById('auth-screen').style.display='';
  setAuthMode('login');
  const signOutPromise=supabaseClient.auth.signOut({scope:'global'});
  DB.clearLocal().catch(()=>{});
  const {error}=await signOutPromise;
  if(error){
    manualSignOut=false;
    console.error('Sign out error:',error);
    authMessage('Signed out locally. '+(error.message||''),true);
  }
}

function closePasswordReset(){
  document.getElementById('password-reset-overlay').classList.remove('open');
  document.getElementById('password-reset-new').value='';
  document.getElementById('password-reset-confirm').value='';
  document.getElementById('password-reset-error').textContent='';
  if(recoveryActive){
    recoveryActive=false;
    history.replaceState({},document.title,window.location.pathname);
    supabaseClient.auth.signOut({scope:'global'}).catch(()=>{});
  }
}
document.getElementById('password-reset-close').addEventListener('click',closePasswordReset);
document.getElementById('password-reset-cancel').addEventListener('click',closePasswordReset);
document.getElementById('password-reset-save').addEventListener('click',async()=>{
  const password=document.getElementById('password-reset-new').value;
  const confirm=document.getElementById('password-reset-confirm').value;
  const error=document.getElementById('password-reset-error');
  if(password.length<6){error.textContent='Password must be at least 6 characters.';return;}
  if(password!==confirm){error.textContent='Passwords do not match.';return;}
  const button=document.getElementById('password-reset-save');button.disabled=true;error.textContent='';
  try{
    const {error:updateError}=await supabaseClient.auth.updateUser({password});
    if(updateError)throw updateError;
    closePasswordReset();
    await signOut();
    recoveryActive=false;
    authMessage('Password updated successfully. Please sign in.');
  }catch(err){error.textContent=err.message||'Could not update password.';}
  finally{button.disabled=false;}
});
const authPage = document.getElementById('auth-screen');
const publicPage = document.getElementById('public-page');
const publicPageContent = document.getElementById('public-page-content');

let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  deferredInstallPrompt = event;
  document.querySelectorAll('[data-download-app]').forEach(button => button.textContent = 'Install Toolify');
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  document.querySelectorAll('[data-download-app]').forEach(button => button.textContent = 'Toolify Installed');
  const platformLabel = document.getElementById('auth-platform-label');
  if(platformLabel) platformLabel.textContent = 'Installed successfully';
});

async function downloadToolify() {
  if(deferredInstallPrompt){
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    return;
  }

  if(window.matchMedia('(display-mode: standalone)').matches || navigator.standalone){
    toast('Toolify is already installed.');
    return;
  }

  const isChrome = /Chrome|Chromium|EdgA|Edg/i.test(navigator.userAgent) && !/OPR|Opera/i.test(navigator.userAgent);
  if(isChrome){
    toast('Open Chrome menu and select "Install Toolify" or "Add to Home screen".');
  }else{
    toast('Open Toolify in Chrome to install the app.');
  }
}

function showPublicAbout() {
  publicPageContent.innerHTML = `
    <div class="about-block">
      <img class="about-mark" src="logo.png?v=3" alt="Toolify">
      <h1>About Toolify</h1>
      <h4>Your Tools. Your Workspace. Your Productivity.</h4>
      <p>Toolify is a personal tool management and productivity platform that brings your essential digital tools into one organized workspace.</p>
      <div class="about-section">
        <h5>What Makes Toolify Special</h5>
        <ul class="about-list">
          <li><strong>Personal Tool Library</strong> — Save and organize frequently used tools.</li>
          <li><strong>Smart Categories</strong> — Keep your workspace clean and structured.</li>
          <li><strong>Cloud Sync</strong> — Access your tools across your devices.</li>
          <li><strong>Private Accounts</strong> — Keep your workspace secure and personal.</li>
          <li><strong>Backup &amp; Recovery</strong> — Export and restore your library whenever needed.</li>
        </ul>
      </div>
      <div class="about-section">
        <h5>Developer</h5>
        <p>Designed and developed by <strong>TAHA AMIN</strong>, with a focus on practical, accessible, and modern productivity software.</p>
        <div class="about-links">
          <a class="about-link" href="https://github.com/tahaamindev" target="_blank" rel="noopener noreferrer">GitHub</a>
          <a class="about-link" href="https://tahaamindev.github.io/TAHA/" target="_blank" rel="noopener noreferrer">Portfolio</a>
        </div>
      </div>
      <div class="about-section">
        <h5>Contact</h5>
        <p><a class="about-link" href="mailto:tahaamin.dev@gmail.com">tahaamin.dev@gmail.com</a></p>
      </div>
      <div class="about-meta">Version ${typeof APP_VERSION !== 'undefined' ? APP_VERSION : '1.1.0'} · Web Application · Backend: Supabase · Hosting: GitHub Pages</div>
    </div>`;
  authPage.setAttribute('aria-hidden', 'true');
  publicPage.classList.add('open');
  publicPage.setAttribute('aria-hidden', 'false');
  publicPage.scrollTop = 0;
}

function closePublicPage() {
  publicPage.classList.remove('open');
  publicPage.setAttribute('aria-hidden', 'true');
  const appVisible = document.getElementById('app').style.display !== 'none';
  authPage.setAttribute('aria-hidden', appVisible ? 'true' : 'false');
}

function showPublicContact() {
  publicPageContent.innerHTML = `
    <div class="contact-page">
      <div class="contact-heading">
        <span class="auth-kicker">Get in touch</span>
        <h1>Contact Taha Amin.</h1>
      </div>
      <div class="contact-info-card contact-info-only">
        <h2>Direct contact</h2>
        <div class="contact-actions">
          <a class="primary" href="tel:+923255581504">+92325 5581504</a>
          <a href="https://tahaamindev.github.io/TAHA/" target="_blank" rel="noopener noreferrer">Portfolio</a>
          <a href="https://github.com/tahaamindev" target="_blank" rel="noopener noreferrer">GitHub Profile</a>
        </div>
      </div>
    </div>`;
  authPage.setAttribute('aria-hidden', 'true');
  publicPage.classList.add('open');
  publicPage.setAttribute('aria-hidden', 'false');
  publicPage.scrollTop = 0;
}

document.querySelectorAll('[data-public-page="about"]').forEach(button => button.addEventListener('click', showPublicAbout));
document.querySelectorAll('[data-public-page="contact"]').forEach(button => button.addEventListener('click', showPublicContact));
document.querySelectorAll('[data-close-public-page]').forEach(button => button.addEventListener('click', closePublicPage));
document.querySelectorAll('[data-download-app]').forEach(button => button.addEventListener('click', downloadToolify));

const authPlatformLabel = document.getElementById('auth-platform-label');
if(authPlatformLabel) authPlatformLabel.textContent = 'Install with Chrome';

document.querySelectorAll('.password-toggle').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    const input = document.getElementById(btn.dataset.target);
    if(!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    btn.innerHTML = show
      ? '<svg viewBox="0 0 24 24" fill="none"><path d="M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8M9.9 5.1A10.5 10.5 0 0112 5c6.5 0 10 7 10 7a17 17 0 01-3.2 4.4M6.2 6.2C3.6 8.1 2 12 2 12s3.5 7 10 7c1.3 0 2.5-.2 3.6-.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.8"/></svg>';
  });
});

// Service Worker registration (offline + auto-update)
if('serviceWorker' in navigator){
  navigator.serviceWorker.register('./sw.js').then((reg)=>{
    reg.update();
    reg.addEventListener('updatefound',()=>{
      const newWorker=reg.installing;
      if(!newWorker)return;
      newWorker.addEventListener('statechange',()=>{
        if(newWorker.state==='installed'&&navigator.serviceWorker.controller){
          // New version available — prompt reload on next load
          console.log('New Toolify version available. Refresh to update.');
        }
      });
    });
  }).catch((err)=>console.log('SW registration failed:',err));
}

init().catch(error=>{
  console.error('Toolify startup failed:',error);
  cancelSplash();
  document.getElementById('auth-screen').style.display='';
  authMessage(isOfflineError(error)?OFFLINE_AUTH_MESSAGE:(error?.message || 'Could not start Toolify.'),true);
});
