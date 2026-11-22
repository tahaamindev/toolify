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
function setAuthMode(mode){authMode=mode;const title=document.getElementById('auth-title'),sub=document.getElementById('auth-sub'),submit=document.getElementById('auth-submit'),toggle=document.getElementById('auth-toggle'),forgot=document.getElementById('auth-forgot');const isSignup=mode==='signup';document.getElementById('auth-confirm-wrap').style.display=isSignup?'block':'none';document.getElementById('auth-password-wrap').style.display='block';document.getElementById('auth-password').required=true;document.getElementById('auth-confirm').required=isSignup;title.textContent=isSignup?'Create your account':'Welcome back';sub.textContent=isSignup?'Create an account to keep your tools synced securely.':'Sign in to access your personal cloud-synced tool library.';submit.textContent=isSignup?'Create account':'Sign in';toggle.textContent=isSignup?'Already have an account? Sign in':'New to Toolify? Sign up';forgot.style.display=isSignup?'none':'block';authMessage('');}
async function showAuthenticatedApp(user){
  if(currentUser && currentUser.id===user.id) return;
  setCurrentUser(user);
  State.tools=[];
  State.categories=[];
  State.settings={theme:'dark',view:'grid',sort:'recent',lastBackupAt:null,landing:'auto',clickSound:'click',clockTheme:'emerald',quickTools:undefined,notes:[],tasks:[]};
  setLibraryLoading(true);
  document.getElementById('auth-screen').style.display='none';
  document.getElementById('app').style.display='flex';
  document.getElementById('mac-signout').title=user.email||'Sign out';
  render();
  try{
    await DB.open();
    await initAppData();
    showFeatureAnnouncement();
    try{
      await DB.syncForUser(user);
      const [tools,categories,settingsRows]=await Promise.all([DB.getAll('tools'),DB.getAll('categories'),DB.getAll('settings')]);
      State.tools=tools;
      State.categories=categories;
      const saved=settingsRows.find(row=>row.key==='app');
      if(saved) Object.assign(State.settings,saved.value);
      setLibraryLoading(false);
      applyTheme();
      render();
    }catch(error){
      console.error('Cloud sync failed:',error);
      setLibraryLoading(false);
      render();
      toast('Offline: showing saved library','error');
    }
  }catch(error){
    setLibraryLoading(false);
    render();
    console.error(error);
    authMessage('Could not open your library: '+(error.message||'Please try again.'),true);
    document.getElementById('auth-screen').style.display='flex';
    document.getElementById('app').style.display='none';
  }
}
async function initAppData(){try{const [tools,categories,settingsRows]=await Promise.all([DB.getAll('tools'),DB.getAll('categories'),DB.getAll('settings')]);State.tools=tools;State.categories=categories;const saved=settingsRows.find(r=>r.key==='app');if(saved)Object.assign(State.settings,saved.value);}catch(e){toast('Could not load saved data','error');}ensureUncategorized();const ids=new Set(State.categories.map(c=>c.id));let fixed=false;State.tools.forEach(t=>{if(!ids.has(t.categoryId)){t.categoryId=UNCATEGORIZED_ID;fixed=true;}});if(fixed)await DB.bulkPut('tools',State.tools);if(!State.categories.length)ensureUncategorized();await DB.bulkPut('categories',State.categories);applyTheme();resetMusicSettingsRef();State.ui.activeNav=State.tools.some(t=>t.favorite)?'favorites':'all';wireEvents();render();}
async function init(){
  if(!supabaseClient){
    document.getElementById('auth-screen').style.display='flex';
    authMessage('Could not load sign-in services. Check your connection and refresh.',true);
    return;
  }
  try{
    await DB.open();
  }catch(error){
    console.error('Could not open local database:',error);
    document.getElementById('auth-screen').style.display='flex';
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
      document.getElementById('app').style.display='none';
      document.getElementById('auth-screen').style.display='flex';
      document.getElementById('password-reset-overlay').classList.add('open');
      document.getElementById('password-reset-new').focus();
      return;
    }
    if(recoveryActive || authUrlProcessing) return;
    if(event==='SIGNED_IN'||event==='INITIAL_SESSION'||event==='TOKEN_REFRESHED'){if(session?.user&&!currentUser){await showAuthenticatedApp(session.user);}return;}
    if(event==='SIGNED_OUT'){
      manualSignOut=false;
      if(currentUser){setCurrentUser(null);await DB.clearLocal();}
      document.getElementById('app').style.display='none';
      document.getElementById('auth-screen').style.display='flex';
      setAuthMode('login');
      return;
    }
    if(session?.user&&!currentUser){await showAuthenticatedApp(session.user);}
  });
  const {data:{session}}=await supabaseClient.auth.getSession();
  if(authUrlProcessing){
    window.setTimeout(()=>{
      authUrlProcessing=false;
      if(!recoveryActive){
        supabaseClient.auth.getSession().then(({data:{session:currentSession}})=>{
          if(currentSession?.user&&!currentUser) showAuthenticatedApp(currentSession.user);
        }).catch(()=>{});
      }
    },1500);
  }
  if(session?.user){
    if(recoveryType){
      recoveryActive=true;
      document.getElementById('app').style.display='none';
      document.getElementById('auth-screen').style.display='flex';
      document.getElementById('password-reset-overlay').classList.add('open');
      document.getElementById('password-reset-new').focus();
    }else{
      await showAuthenticatedApp(session.user);
    }
  }else if(!authUrlProcessing){
    document.getElementById('auth-screen').style.display='flex';
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
  }catch(err){authMessage(err.message||'Authentication failed.',true);}finally{submit.disabled=false;}
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
  }catch(err){authMessage(err.message||'Could not send the reset link.',true);}
  finally{button.disabled=false;}
});

async function signOut(){
  manualSignOut=true;
  setCurrentUser(null);
  document.getElementById('app').style.display='none';
  document.getElementById('auth-screen').style.display='flex';
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
  document.getElementById('auth-screen').style.display='flex';
  authMessage(error?.message || 'Could not start Toolify.',true);
});
