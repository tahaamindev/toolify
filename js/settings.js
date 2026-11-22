/* ============================================================
   TOOLIFY — Settings panel
   Split from the original app.js (behaviour preserved).
   ============================================================ */

/* ============================================================
   19. SETTINGS PANEL RENDERING
   ============================================================ */
const SHORTCUTS = [
  { keys: '/', action: 'Focus the search bar' },
  { keys: 'Esc', action: 'Close open dialog or clear search' },
  { keys: 'N', action: 'Add a new tool' },
  { keys: ',', action: 'Open Settings' },
  { keys: '?', action: 'Open Settings → General (shortcuts)' },
  { keys: 'F', action: 'Go to Favorites' },
  { keys: 'A', action: 'Go to All Tools' }
];

let currentSettingsPanel = 'general';

function daysSince(iso){
  if(!iso) return null;
  const diff = Date.now() - new Date(iso).getTime();
  return Math.floor(diff / 86400000);
}

function renderSettingsPanel(panelName){
  currentSettingsPanel = panelName;
  document.querySelectorAll('.settings-nav-item').forEach(b=>b.classList.toggle('active', b.dataset.panel===panelName));
  const panel = document.getElementById('settings-panel');

  if(panelName === 'account'){
    const email = currentUser?.email || 'Not signed in';
    panel.innerHTML = `
      <h3>Accounts</h3>
      <div class="panel-sub">Manage the email address and password connected to your Toolify account.</div>
      <div class="settings-block">
        <div class="settings-row">
          <div><div class="settings-row-label">Current email</div><div class="settings-row-desc">${escapeHTML(email)}</div></div>
          <span class="tool-badge"><span class="dot"></span>Signed in</span>
        </div>
        <div class="backup-card" style="margin-top:12px;">
          <h4>Change email address</h4>
          <p>Supabase will send a confirmation link to verify the new email address. Your account data will stay attached to this account.</p>
          <div class="field"><label class="field-label" for="account-new-email">New email address</label><input class="field-input" id="account-new-email" type="email" autocomplete="email" placeholder="new@example.com"></div>
          <button class="btn btn-solid" id="account-change-email">Send verification email</button>
        </div>
      </div>
      <div class="settings-block">
        <div class="backup-card">
          <h4>Change password</h4>
          <p>Enter your current password first, then choose a new one (at least 6 characters).</p>
          <div class="field"><label class="field-label" for="account-current-password">Current password</label><input class="field-input" id="account-current-password" type="password" autocomplete="current-password" placeholder="Current password"></div>
          <div class="field"><label class="field-label" for="account-new-password">New password</label><input class="field-input" id="account-new-password" type="password" autocomplete="new-password" minlength="6" placeholder="At least 6 characters"></div>
          <div class="field"><label class="field-label" for="account-confirm-password">Confirm new password</label><input class="field-input" id="account-confirm-password" type="password" autocomplete="new-password" minlength="6" placeholder="Repeat new password"></div>
          <button class="btn btn-solid" id="account-change-password">Update password</button>
        </div>
      </div>
      <div class="settings-row">
        <div><div class="settings-row-label">Sign out</div><div class="settings-row-desc">Sign out of Toolify on this browser.</div></div>
        <button class="btn btn-danger" id="account-panel-signout">Sign out</button>
      </div>
    `;
    document.getElementById('account-change-email').addEventListener('click', async ()=>{
      const nextEmail = document.getElementById('account-new-email').value.trim();
      if(!nextEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)){toast('Enter a valid email address.','error');return;}
      const btn = document.getElementById('account-change-email'); btn.disabled = true; btn.textContent = 'Sending…';
      try{
        const {error} = await supabaseClient.auth.updateUser({email:nextEmail},{emailRedirectTo:window.location.origin+window.location.pathname});
        if(error) throw error;
        toast('Verification email sent. Confirm the new address to finish the change.');
        document.getElementById('account-new-email').value = '';
      }catch(err){toast(err.message || 'Could not update email.','error');}
      finally{btn.disabled=false;btn.textContent='Send verification email';}
    });
    document.getElementById('account-change-password').addEventListener('click', async ()=>{
      const oldPass = document.getElementById('account-current-password').value;
      const nextPass = document.getElementById('account-new-password').value;
      const confirmPass = document.getElementById('account-confirm-password').value;
      if(!oldPass || !nextPass){toast('Complete all password fields.','error');return;}
      if(nextPass.length < 6){toast('New password must be at least 6 characters.','error');return;}
      if(nextPass !== confirmPass){toast('New passwords do not match.','error');return;}
      if(nextPass === oldPass){toast('Choose a password different from your current one.','error');return;}
      const btn = document.getElementById('account-change-password'); btn.disabled=true; btn.textContent='Updating…';
      try{
        const {error:verifyError} = await supabaseClient.auth.signInWithPassword({email:currentUser.email,password:oldPass});
        if(verifyError) throw new Error('Current password is incorrect.');
        const {error} = await supabaseClient.auth.updateUser({password:nextPass});
        if(error) throw error;
        document.getElementById('account-current-password').value='';
        document.getElementById('account-new-password').value='';
        document.getElementById('account-confirm-password').value='';
        toast('Password updated successfully.');
      }catch(err){toast(err.message || 'Could not update password.','error');}
      finally{btn.disabled=false;btn.textContent='Update password';}
    });
    document.getElementById('account-panel-signout').addEventListener('click', () => signOut());
  }

  if(panelName === 'general'){
    panel.innerHTML = `
      <h3>General</h3>
      <div class="panel-sub">Basic preferences for how Toolify behaves.</div>
      <div class="settings-row update-check-row">
        <div>
          <div class="settings-row-label">Check for update</div>
          <div class="settings-row-desc">Clear cached files and reload the newest version of Toolify.</div>
        </div>
        <button class="btn btn-solid" id="btn-check-update" type="button">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span>Check now</span>
        </button>
      </div>
      <div class="settings-row">
        <div><div class="settings-row-label">Default landing view</div><div class="settings-row-desc">Favorites is shown automatically when you have at least one favorite.</div></div>
        <div style="font-size:12.5px; color:var(--text-tertiary);">Automatic</div>
      </div>
      <div class="settings-row">
        <div><div class="settings-row-label">Backup reminders</div><div class="settings-row-desc">Get a gentle nudge to export a backup periodically.</div></div>
        <div style="font-size:12.5px; color:var(--text-tertiary);">Enabled</div>
      </div>
      <div class="settings-row">
        <div><div class="settings-row-label">Click sound</div><div class="settings-row-desc">Play a sound when opening a tool. Choose a sound or turn it off.</div></div>
        <select class="field-select" id="click-sound-select" style="width:auto; min-width:120px;">
          <option value="off">Off</option>
          <option value="click">Click</option>
          <option value="pop">Pop</option>
          <option value="ding">Ding</option>
        </select>
      </div>
      <div class="settings-block" style="margin-top:14px;">
        <div class="settings-row-label">Keyboard shortcuts</div>
        <div class="panel-sub" style="margin-bottom:8px;">Shortcuts that work anywhere in the app. Press the key to trigger the action.</div>
        <div class="shortcut-list">
          ${SHORTCUTS.map(s=>`<div class="shortcut-row"><kbd>${escapeHTML(s.keys)}</kbd><span>${escapeHTML(s.action)}</span></div>`).join('')}
        </div>
      </div>
    `;
    const soundSel = document.getElementById('click-sound-select');
    if(soundSel){
      soundSel.value = State.settings.clickSound || 'off';
      soundSel.addEventListener('change', async ()=>{
        State.settings.clickSound = soundSel.value;
        await persistSettings();
        if(soundSel.value !== 'off') playClickSound();
      });
    }
    document.getElementById('btn-check-update')?.addEventListener('click', async (event)=>{
      const btn = event.currentTarget;
      if(btn.disabled) return;
      btn.disabled = true;
      const label = btn.querySelector('span');
      if(label) label.textContent = 'Checking…';
      else btn.textContent = 'Checking…';
      try{
        if('caches' in window){
          const keys = await caches.keys();
          await Promise.all(keys.map(key=>caches.delete(key)));
        }
        if('serviceWorker' in navigator){
          const registrations = await navigator.serviceWorker.getRegistrations();
          await Promise.all(registrations.map(reg=>reg.unregister()));
        }
      }catch(error){
        console.warn('Could not clear cached files:', error);
      }
      toast('Fetching the latest version…');
      const url = new URL(window.location.href);
      url.searchParams.set('_hr', Date.now().toString());
      window.location.replace(url.toString());
    });
  }

  else if(panelName === 'tools'){
    panel.innerHTML = `
      <h3>Manage Tools</h3>
      <div class="panel-sub">Edit or delete tools in your library.</div>
      <div class="manage-search">
        <svg class="search-icon" viewBox="0 0 24 24" fill="none" style="left:11px; top:9px;"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="M21 21l-4.3-4.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        <input class="field-input" id="manage-search-input" style="padding-left:32px;" placeholder="Search your tools…">
      </div>
      <div class="manage-list" id="manage-tools-list"></div>
    `;
    renderManageToolsList('');
    document.getElementById('manage-search-input').addEventListener('input', (e)=>renderManageToolsList(e.target.value));
  }

  else if(panelName === 'sidebar'){
    panel.innerHTML = `
      <h3>Sidebar</h3>
      <div class="panel-sub">Use the right sidebar to check your workspace, play music from files or folders, add YouTube links, and open your saved notes.</div>
    `;
  }

  else if(panelName === 'categories'){
    const userCats = State.categories.filter(c=>c.id!==UNCATEGORIZED_ID).sort((a,b)=>a.name.localeCompare(b.name));
    const uncat = State.categories.find(c=>c.id===UNCATEGORIZED_ID);
    panel.innerHTML = `
      <h3>Categories</h3>
      <div class="panel-sub">Create, rename, or delete categories. Deleting a category moves its tools to Uncategorized — nothing is ever deleted.</div>
      <div id="cat-list">
        ${userCats.map(c=>`
          <div class="cat-row" data-id="${c.id}">
            <input class="cat-name-input" value="${escapeHTML(c.name)}" data-id="${c.id}">
            <span class="cat-count">${categoryToolCount(c.id)} tool${categoryToolCount(c.id)===1?'':'s'}</span>
            <button class="icon-btn danger" data-del-cat="${c.id}" aria-label="Delete category"><svg viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>
          </div>`).join('')}
        <div class="cat-row system">
          <span class="cat-name-input" style="cursor:default;">Uncategorized</span>
          <span class="cat-count">${categoryToolCount(UNCATEGORIZED_ID)} tools · system</span>
        </div>
      </div>
      <div class="new-cat-row">
        <input class="field-input" id="new-cat-input" placeholder="New category name" maxlength="40">
        <button class="btn btn-solid" id="new-cat-btn">Create</button>
      </div>
    `;
    panel.querySelectorAll('.cat-name-input[data-id]').forEach(inp=>{
      inp.addEventListener('change', ()=>renameCategory(inp.dataset.id, inp.value));
    });
    panel.querySelectorAll('[data-del-cat]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const id = btn.dataset.delCat;
        const c = State.categories.find(x=>x.id===id);
        setPendingDeleteId(null);
        document.getElementById('confirm-title').textContent = 'Delete this category?';
        document.getElementById('confirm-msg').textContent = `“${c.name}” will be deleted. Its tools will move to Uncategorized — they will not be removed.`;
        document.getElementById('confirm-overlay').classList.add('open');
        document.getElementById('confirm-ok').onclick = async ()=>{
          await deleteCategory(id);
          closeConfirm();
          document.getElementById('confirm-ok').onclick = doDeleteTool;
        };
      });
    });
    document.getElementById('new-cat-btn').addEventListener('click', async ()=>{
      const inp = document.getElementById('new-cat-input');
      await createCategory(inp.value);
      inp.value = '';
      renderSettingsPanel('categories');
    });
    document.getElementById('new-cat-input').addEventListener('keydown', (e)=>{
      if(e.key === 'Enter'){ document.getElementById('new-cat-btn').click(); }
    });
  }

  else if(panelName === 'backup'){
    const d = daysSince(State.settings.lastBackupAt);
    panel.innerHTML = `
      <h3>Backup &amp; Restore</h3>
      <div class="panel-sub">Everything in your workspace — tools, categories, notes, tasks, music and automatic snapshots — is stored securely in Supabase and synced across your signed-in devices. A local cache keeps the app fast offline; exporting a backup is still available.</div>
      <div class="reminder-pill" style="margin-bottom:18px;">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M12 7v5l3 3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        ${State.settings.lastBackupAt ? `Last backup: ${d===0?'today':d+' day'+(d===1?'':'s')+' ago'}` : 'No backup created yet'}
      </div>
      <div class="backup-card">
        <h4>Export Backup</h4>
        <p>Download a portable JSON file containing all your tools, categories and preferences.</p>
        <button class="btn btn-solid" id="btn-export-backup">Create Backup Now</button>
      </div>
      <div class="backup-card">
        <h4>Import / Restore</h4>
        <p>Select a Toolify backup file. Your current library is protected — the import merges new items in and never deletes existing data.</p>
        <button class="btn btn-ghost" id="btn-import-backup">Choose Backup File…</button>
      </div>
    `;
    document.getElementById('btn-export-backup').addEventListener('click', exportBackup);
    document.getElementById('btn-import-backup').addEventListener('click', ()=>document.getElementById('import-file-input').click());
  }

  else if(panelName === 'appearance'){
    panel.innerHTML = `
      <h3>Appearance</h3>
      <div class="panel-sub">Choose a mode and color palette for the whole app.</div>
      <div class="settings-row">
        <div><div class="settings-row-label">Theme</div><div class="settings-row-desc">System follows your OS preference.</div></div>
        <div class="theme-picker" id="theme-picker">
          <button class="theme-opt" data-theme="dark">Dark</button>
          <button class="theme-opt" data-theme="light">Light</button>
          <button class="theme-opt" data-theme="system">System</button>
        </div>
      </div>
      <div class="settings-block">
        <div class="settings-row-label">Color palette</div>
        <div class="panel-sub">Changes the colors across the entire Toolify interface.</div>
        <div class="app-palette-picker" id="app-palette-picker">
          ${Object.entries(MUSIC_THEMES).map(([name,palette])=>`<button type="button" class="app-palette-option" data-palette="${name}" aria-label="${name} palette" title="${name}"><span style="--palette-swatch:${palette.accent}"></span><small>${name}</small></button>`).join('')}
        </div>
        <label class="app-custom-accent">Custom accent <input type="color" id="app-custom-accent" aria-label="Custom accent color"></label>
      </div>
      <div class="settings-row">
        <div><div class="settings-row-label">Default view</div><div class="settings-row-desc">Grid, list, or compact icon layout for your library.</div></div>
        <div class="theme-picker" id="view-picker">
          <button class="theme-opt" data-view="grid">Grid</button>
          <button class="theme-opt" data-view="list">List</button>
          <button class="theme-opt" data-view="compact">Compact</button>
        </div>
      </div>
    `;
    panel.querySelectorAll('#theme-picker .theme-opt').forEach(b=>{
      b.classList.toggle('active', b.dataset.theme === State.settings.theme);
      b.addEventListener('click', async ()=>{
        State.settings.theme = b.dataset.theme;
        applyTheme();
        await persistSettings();
        renderSettingsPanel('appearance');
      });
    });
    const accentInput=document.getElementById('app-custom-accent');
    accentInput.value=/^#[\da-f]{6}$/i.test(State.settings.customAccent||'')?State.settings.customAccent:MUSIC_THEMES[State.settings.colorTheme||'classic'].accent;
    panel.querySelectorAll('.app-palette-option').forEach(button=>{
      button.classList.toggle('active',button.dataset.palette===(State.settings.colorTheme||'classic')&&!State.settings.customAccent);
      button.addEventListener('click',async()=>{
        State.settings.colorTheme=button.dataset.palette;
        State.settings.customAccent='';
        applyTheme();
        await persistSettings();
        renderSettingsPanel('appearance');
      });
    });
    accentInput.addEventListener('input',()=>{
      State.settings.customAccent=accentInput.value;
      applyTheme();
    });
    accentInput.addEventListener('change',()=>persistSettings().catch(error=>{
      console.error('Could not save appearance settings:',error);
      toast('Could not save appearance settings.','error');
    }));
    panel.querySelectorAll('#view-picker .theme-opt').forEach(b=>{
      b.classList.toggle('active', b.dataset.view === State.settings.view);
      b.addEventListener('click', async ()=>{
        State.settings.view = b.dataset.view;
        await persistSettings();
        render();
        renderSettingsPanel('appearance');
      });
    });
  }

  else if(panelName === 'data'){
    const fav = State.tools.filter(t=>t.favorite).length;
    panel.innerHTML = `
      <h3>Data</h3>
      <div class="panel-sub">A snapshot of what's stored locally in this browser.</div>
      <div class="stat-grid">
        <div class="stat-box"><div class="stat-num">${State.tools.length}</div><div class="stat-label">Total tools</div></div>
        <div class="stat-box"><div class="stat-num">${State.categories.length-1}</div><div class="stat-label">Categories</div></div>
        <div class="stat-box"><div class="stat-num">${fav}</div><div class="stat-label">Favorites</div></div>
      </div>
      <div class="backup-card" style="border-color:rgba(226,104,92,.3);">
        <h4 style="color:var(--danger);">Reset App</h4>
        <p>Permanently remove all locally stored tools, categories, and preferences from this browser. Export a backup first if you might want this data again.</p>
        <button class="btn btn-danger" id="btn-open-reset">Reset App…</button>
      </div>
    `;
    document.getElementById('btn-open-reset').addEventListener('click', ()=>{
      document.getElementById('reset-input').value = '';
      document.getElementById('reset-ok').disabled = true;
      document.getElementById('reset-overlay').classList.add('open');
    });
  }

  else if(panelName === 'report'){
    panel.innerHTML = `
      <h3>Report a Bug</h3>
      <div class="panel-sub">Tell us what went wrong so we can improve Toolify.</div>
      <form class="report-form" id="bug-report-form">
        <div class="field">
          <label class="field-label" for="bug-name">Name</label>
          <input class="field-input" id="bug-name" name="name" autocomplete="name" value="${escapeHTML(currentUser?.user_metadata?.full_name || '')}" placeholder="Your name">
        </div>
        <div class="field">
          <label class="field-label" for="bug-email">Email</label>
          <input class="field-input" id="bug-email" name="email" type="email" autocomplete="email" value="${escapeHTML(currentUser?.email || '')}" required placeholder="you@example.com">
        </div>
        <div class="field">
          <label class="field-label" for="bug-type">Issue type</label>
          <select class="field-select" id="bug-type" name="issue_type">
            <option value="Bug">Bug</option>
            <option value="Interface problem">Interface problem</option>
            <option value="Feature request">Feature request</option>
            <option value="Other">Other</option>
          </select>
        </div>
        <div class="field">
          <label class="field-label" for="bug-message">What happened?</label>
          <textarea class="field-textarea" id="bug-message" name="message" required minlength="10" maxlength="3000" placeholder="Describe the problem, what you expected, and the steps to reproduce it..."></textarea>
        </div>
        <input type="hidden" name="_subject" value="Toolify Bug Report">
        <input type="hidden" name="_template" value="table">
        <input type="hidden" name="_captcha" value="false">
        <input type="hidden" name="app_version" value="${escapeHTML(APP_VERSION)}">
        <button class="btn btn-solid" id="bug-report-submit" type="submit">Send Report</button>
      </form>
    `;

    document.getElementById('bug-report-form').addEventListener('submit', async event=>{
      event.preventDefault();
      const form = event.currentTarget;
      if(!form.reportValidity()) return;
      const button = document.getElementById('bug-report-submit');
      const originalText = button.textContent;
      button.disabled = true;
      button.textContent = 'Sending…';
      try{
        const response = await fetch('https://formsubmit.co/ajax/tahaamin.dev@gmail.com',{
          method:'POST',
          headers:{'Content-Type':'application/json','Accept':'application/json'},
          body:JSON.stringify(Object.fromEntries(new FormData(form).entries()))
        });
        const result = await response.json().catch(()=>null);
        if(!response.ok || result?.success === false) throw new Error(result?.message || 'Could not send the report.');
        form.reset();
        if(currentUser?.email) document.getElementById('bug-email').value = currentUser.email;
        toast('Bug report sent successfully.');
      }catch(error){
        toast(error.message || 'Could not send the report.', 'error');
      }finally{
        button.disabled = false;
        button.textContent = originalText;
      }
    });
  }

  else if(panelName === 'about'){
    panel.innerHTML = `
      <div class="about-block">
        <img class="about-mark" src="logo.png?v=3" alt="Toolify">
        <h4>Toolify</h4>
        <p>Your Tools. Your Workspace. Your Productivity.</p>
        <p>Toolify is a personal tool management and productivity platform designed to help you organize, manage, and access all your essential digital tools in one centralized workspace.</p>

        <div class="about-section">
          <h5>What Makes Toolify Special</h5>
          <p>Toolify is built around simplicity, organization, accessibility, and personalization.</p>
          <ul class="about-list">
            <li><strong>Personal Tool Library</strong> — Save and manage all your frequently used tools in one place.</li>
            <li><strong>Smart Categorization</strong> — Organize your tools into custom categories for a cleaner, structured workspace.</li>
            <li><strong>Cloud Synchronization</strong> — Keep your tools, categories, and settings synchronized across devices.</li>
            <li><strong>Personal Accounts</strong> — Create your own account using your email address and maintain a private workspace.</li>
            <li><strong>Secure Data Management</strong> — Your personal data is protected through user-specific database access and Row Level Security (RLS).</li>
            <li><strong>Backup &amp; Recovery</strong> — Export your data, restore previous backups, and recover your personal tool library when needed.</li>
            <li><strong>Cross-Device Accessibility</strong> — Access your workspace from different devices without manually transferring your data.</li>
          </ul>
        </div>

        <div class="about-section">
          <h5>Available Features — Version 1.1.2</h5>
          <p>Toolify is currently in its initial release, introducing the foundation of a personalized tool management ecosystem.</p>
          <div>
            <span class="about-tag">Account &amp; Authentication</span>
            <span class="about-tag">Cloud Sync &amp; Database</span>
            <span class="about-tag">Tool Management</span>
            <span class="about-tag">Data Security</span>
            <span class="about-tag">Deployment &amp; Data Recovery</span>
            <span class="about-tag">Mobile-Optimized Interface</span>
          </div>
          <ul class="about-list">
            <li>User Registration, Email Verification, Email &amp; Password Login</li>
            <li>Forgot Password, Change Email, Change Password, Sign Out, Persistent Sessions</li>
            <li>Supabase Backend Integration, Secure Cloud Storage, Multi-User Accounts</li>
            <li>Private User Data, User-Specific Data Access, Cross-Device Synchronization</li>
            <li>Tools, Categories &amp; Settings Synchronization, Database Snapshots</li>
            <li>Save Personal Tools, Access Saved Tools, Custom Categories</li>
            <li>Row Level Security (RLS), User-Based Database Permissions</li>
            <li>GitHub Pages Hosting, Online Web App, Multi-Device Accessibility</li>
            <li>Manual Backup Export, Backup Import &amp; Restore, Advanced Recovery System</li>
          </ul>
        </div>

        <div class="about-section">
          <h5>The Future of Toolify</h5>
          <p>Toolify is not just a tool-saving application. It is evolving into a comprehensive personal productivity ecosystem — bringing multiple everyday utilities, productivity tools, management systems, and intelligent features together in one unified platform.</p>
          <details>
            <summary style="cursor:pointer; font-size:12.5px; color:var(--accent); margin-bottom:6px;">Show planned features roadmap</summary>
            <ul class="about-list">
              <li><strong>Productivity &amp; Organization:</strong> Smart Dashboard, Personal To-Do Manager, Daily Planner, Calendar &amp; Event Manager, Habit Tracker, Goal Tracker, Focus Timer (Pomodoro), Quick Notes, Sticky Notes</li>
              <li><strong>Knowledge &amp; Digital Management:</strong> Smart Bookmark Manager, Reading List, Watch Later Manager, Prompt Library, Secure Vault, File Manager, Document Organizer, Cloud Storage Integration</li>
              <li><strong>Planning &amp; Project Management:</strong> Mind Map Maker, Expense Tracker, Budget Planner, Project Manager, Workflow Automation, Email Organizer, Meeting Notes, Contact Manager</li>
              <li><strong>Personal Life Management:</strong> Birthday &amp; Anniversary Reminders, Shopping List, Fitness Tracker, Travel Planner, Important Dates Countdown, Expense Manager</li>
              <li><strong>Developer &amp; Utility Tools:</strong> Code Playground, Screenshot Tool, QR Code Generator, Password Generator, Quick Calculator, Currency Converter, Unit Converter, Image Compressor, Image Converter, PDF Toolkit, File Converter</li>
              <li><strong>Creative &amp; Design Tools:</strong> Color Palette Manager, Font Library, Design Inspiration Board</li>
              <li><strong>Advanced Productivity &amp; Intelligence:</strong> Social Media Planner, Content Calendar, Daily Inspiration, Global Notifications, Smart Reminders, Focus Mode, Distraction Blocker, Personal Automation Hub, AI Personal Assistant, Universal Search Across Everything</li>
            </ul>
          </details>
        </div>
        <div class="about-section">
          <h5>Our Mission</h5>
          <p>Our mission is to simplify digital life by creating one organized environment for the tools, resources, and utilities people use every day. Instead of switching between multiple platforms or trying to remember where everything is saved, Toolify aims to become your personal digital workspace — accessible, organized, and always evolving.</p>
        </div>

        <hr class="about-hr">

        <div class="about-section">
          <h5>Developer</h5>
          <p>Designed &amp; Developed by TAHA AMIN. Toolify is independently developed with a focus on building practical, user-friendly, and modern web applications.</p>
          <div class="about-links">
            <a class="about-link" href="https://github.com/tahaamindev" target="_blank" rel="noopener noreferrer">GitHub</a>
            <a class="about-link" href="https://tahaamindev.github.io/TAHA/" target="_blank" rel="noopener noreferrer">Portfolio</a>
          </div>
        </div>

        <div class="about-meta">Version ${APP_VERSION} · Web Application · Backend: Supabase · Hosting: GitHub Pages</div>
      </div>
    `;
  }

}

function renderManageToolsList(query){
  const q = (query||'').trim().toLowerCase();
  const list = State.tools
    .filter(t => !q || t.name.toLowerCase().includes(q) || (getCategory(t.categoryId)?.name.toLowerCase().includes(q)))
    .slice().sort((a,b)=>a.name.localeCompare(b.name));
  const wrap = document.getElementById('manage-tools-list');
  if(!wrap) return;
  if(list.length === 0){
    wrap.innerHTML = `<div style="padding:20px 4px; font-size:12.5px; color:var(--text-tertiary); text-align:center;">No tools found.</div>`;
    return;
  }
  wrap.innerHTML = list.map(t=>{
    const cat = getCategory(t.categoryId);
    return `<div class="manage-row">
      <div class="tool-icon">${faviconMarkup(t)}</div>
      <div class="m-name">${escapeHTML(t.name)}</div>
      <div class="m-cat">${escapeHTML(cat?cat.name:'Uncategorized')}</div>
      <button class="icon-btn" data-edit="${t.id}" aria-label="Edit tool"><svg viewBox="0 0 24 24" fill="none"><path d="M11 4H6a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2v-5" stroke="currentColor" stroke-width="1.7"/><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg></button>
      <button class="icon-btn danger" data-del="${t.id}" aria-label="Delete tool"><svg viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></button>
    </div>`;
  }).join('');
  wrap.querySelectorAll('[data-edit]').forEach(b=>b.addEventListener('click', ()=>{
    document.getElementById('settings-overlay').classList.remove('open');
    openToolModal(b.dataset.edit);
  }));
  wrap.querySelectorAll('[data-del]').forEach(b=>b.addEventListener('click', ()=>confirmDeleteTool(b.dataset.del)));
}
function refreshManagePanelIfOpen(){
  if(document.getElementById('settings-overlay').classList.contains('open') && currentSettingsPanel === 'tools'){
    renderManageToolsList(document.getElementById('manage-search-input')?.value || '');
  }
  if(document.getElementById('settings-overlay').classList.contains('open') && currentSettingsPanel === 'data'){
    renderSettingsPanel('data');
  }
}

function openSettings(panel){
  renderSettingsPanel(panel || 'general');
  document.getElementById('settings-overlay').classList.add('open');
}
