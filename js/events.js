/* ============================================================
   TOOLIFY — Global event wiring
   Split from the original app.js (behaviour preserved).
   ============================================================ */

function wireEvents(){
  updateMacClock();
  if(!wireEvents.clockTimer){
    wireEvents.clockTimer = window.setInterval(updateMacClock, 30000);
  }
  // Add tool
  document.getElementById('btn-add-tool-sidebar').addEventListener('click', ()=>openToolModal());
  document.getElementById('tool-modal-close').addEventListener('click', closeToolModal);
  document.getElementById('tool-cancel').addEventListener('click', closeToolModal);
  document.getElementById('tool-save').addEventListener('click', saveTool);
  document.getElementById('tool-overlay').addEventListener('click', (e)=>{ if(e.target.id==='tool-overlay') closeToolModal(); });
  ['f-name','f-url'].forEach(id=>{
    document.getElementById(id).addEventListener('input', ()=>{ setPendingDuplicateOK(false); document.getElementById('dup-warning').style.display='none'; });
  });

  // Confirm delete
  document.getElementById('confirm-close').addEventListener('click', closeConfirm);
  document.getElementById('confirm-cancel').addEventListener('click', closeConfirm);
  document.getElementById('confirm-ok').addEventListener('click', doDeleteTool);
  document.getElementById('confirm-overlay').addEventListener('click', (e)=>{ if(e.target.id==='confirm-overlay') closeConfirm(); });

  // Reset
  document.getElementById('reset-close').addEventListener('click', ()=>document.getElementById('reset-overlay').classList.remove('open'));
  document.getElementById('reset-cancel').addEventListener('click', ()=>document.getElementById('reset-overlay').classList.remove('open'));
  document.getElementById('reset-input').addEventListener('input', (e)=>{
    document.getElementById('reset-ok').disabled = e.target.value.trim() !== 'RESET';
  });
  document.getElementById('reset-ok').addEventListener('click', resetApp);

  // Import
  document.getElementById('import-close').addEventListener('click', ()=>{document.getElementById('import-overlay').classList.remove('open'); setPendingImport(null);});
  document.getElementById('import-cancel').addEventListener('click', ()=>{document.getElementById('import-overlay').classList.remove('open'); setPendingImport(null);});
  document.getElementById('import-confirm').addEventListener('click', applyImport);
  document.getElementById('import-file-input').addEventListener('change', (e)=>{
    const file = e.target.files[0];
    if(file) handleImportFile(file);
    e.target.value = '';
  });

  // Settings
  document.getElementById('btn-open-settings')?.addEventListener('click', ()=>openSettings('general'));
  document.getElementById('mac-settings').addEventListener('click', ()=>openSettings('general'));
  document.getElementById('mac-about').addEventListener('click', showPublicAbout);
  document.getElementById('mac-contact').addEventListener('click', showPublicContact);
  document.querySelectorAll('.quick-tools-tab').forEach(button=>{
    button.addEventListener('click', ()=>setRightPanel(button.dataset.rightPanel));
  });
  /* T Music owns all player markup and shortcuts (js/tmusic/*). */
  if(window.TM && TM.events) TM.events.wire();
  document.getElementById('settings-close').addEventListener('click', ()=>document.getElementById('settings-overlay').classList.remove('open'));
  document.getElementById('settings-overlay').addEventListener('click', (e)=>{ if(e.target.id==='settings-overlay') document.getElementById('settings-overlay').classList.remove('open'); });
  document.querySelectorAll('.settings-nav-item').forEach(b=>b.addEventListener('click', ()=>renderSettingsPanel(b.dataset.panel)));

  document.getElementById('tool-context-menu').addEventListener('click', async (event)=>{
    const action = event.target.closest('[data-context-action]')?.dataset.contextAction;
    if(!action || !contextMenuTarget) return;
    const tool = contextMenuTarget;
    hideToolContextMenu();
    if(action === 'open') openTool(tool);
    if(action === 'edit') openToolModal(tool.id);
    if(action === 'favorite'){ tool.favorite = !tool.favorite; render(); toast(tool.favorite ? 'Added to Favorites.' : 'Removed from Favorites.'); persistTool(tool).catch(()=>toast('Could not save favorite state','error')); }
    if(action === 'delete') confirmDeleteTool(tool.id);
  });
  document.addEventListener('click', (event)=>{
    if(!event.target.closest('#tool-context-menu')) hideToolContextMenu();
  });
  if(!wireEvents.contextMenuWired){
    document.addEventListener('contextmenu', event=>{
      const card = event.target.closest('.tool-card');
      if(!card){
        hideToolContextMenu();
        return;
      }
      event.preventDefault();
      const tool = State.tools.find(item=>item.id === card.dataset.id);
      if(tool) showToolContextMenu(event.clientX, event.clientY, tool);
    });
    wireEvents.contextMenuWired = true;
  }

  // Search
  const searchInput = document.getElementById('mac-search-input');
  const legacySearchClear = document.getElementById('search-clear');
  const doSearch = debounce((val)=>{
    State.ui.search = val;
    legacySearchClear?.classList.toggle('show', !!val);
    renderGrid();
  }, 70);
  searchInput.addEventListener('input', (e)=>doSearch(e.target.value));
  legacySearchClear?.addEventListener('click', ()=>{
    searchInput.value=''; State.ui.search=''; legacySearchClear.classList.remove('show'); renderGrid(); searchInput.focus();
  });
  document.getElementById('mac-signout')?.addEventListener('click', ()=>signOut());

  document.getElementById('quick-note-add')?.addEventListener('click', async ()=>{
    const input = document.getElementById('quick-note-input');
    const text = input.value.trim();
    if(!text) return;
    notesList().push({id:uid(), text, createdAt:Date.now()});
    input.value='';
    renderQuickNotes();
    await persistSettings();
  });
  renderQuickNotes();

  // Tasks
  const taskInput = document.getElementById('quick-task-input');
  const taskList = document.getElementById('quick-tasks-list');
  document.getElementById('tasks-add-form').addEventListener('submit', async (event)=>{
    event.preventDefault();
    const text = taskInput.value.trim();
    if(!text) return;
    tasksList().push({id:uid(), text, done:false, createdAt:Date.now(), completedAt:null});
    taskInput.value = '';
    renderQuickTasks();
    taskInput.focus();
    await persistSettings();
  });
  taskList.addEventListener('click', async (event)=>{
    const toggle = event.target.closest('[data-task-toggle]');
    const remove = event.target.closest('[data-task-delete]');
    const edit = event.target.closest('[data-task-edit]');
    if(toggle){
      const task = tasksList().find(entry=>entry.id === toggle.dataset.taskToggle);
      if(!task) return;
      task.done = !task.done;
      task.completedAt = task.done ? Date.now() : null;
      renderQuickTasks();
      await persistSettings();
    }else if(remove){
      State.settings.tasks = tasksList().filter(entry=>entry.id !== remove.dataset.taskDelete);
      renderQuickTasks();
      await persistSettings();
    }else if(edit && !taskList.querySelector('.task-edit-input')){
      beginTaskEdit(edit.dataset.taskEdit);
    }
  });
  taskList.addEventListener('keydown', (event)=>{
    const edit = event.target.closest('[data-task-edit]');
    if(edit && (event.key === 'Enter' || event.key === ' ')){
      event.preventDefault();
      beginTaskEdit(edit.dataset.taskEdit);
    }
  });
  document.querySelectorAll('[data-task-filter]').forEach(button=>{
    button.addEventListener('click', ()=>{
      setTaskFilter(button.dataset.taskFilter);
      renderQuickTasks();
    });
  });
  document.getElementById('tasks-mark-all').addEventListener('click', async ()=>{
    const tasks = tasksList();
    if(!tasks.length || tasks.every(task=>task.done)) return;
    const now = Date.now();
    tasks.forEach(task=>{ if(!task.done){ task.done = true; task.completedAt = now; } });
    renderQuickTasks();
    await persistSettings();
  });
  document.getElementById('tasks-clear-done').addEventListener('click', async ()=>{
    if(!tasksList().some(task=>task.done)) return;
    State.settings.tasks = tasksList().filter(task=>!task.done);
    renderQuickTasks();
    await persistSettings();
  });
  renderQuickTasks();

  // Sort
  const sortBtn = document.getElementById('sort-btn');
  const sortMenu = document.getElementById('sort-menu');
  sortBtn.addEventListener('click', (e)=>{ e.stopPropagation(); sortMenu.classList.toggle('open'); });
  document.addEventListener('click', ()=>sortMenu.classList.remove('open'));
  document.querySelectorAll('.sort-option').forEach(o=>{
    o.addEventListener('click', async (e)=>{
      e.stopPropagation();
      State.settings.sort = o.dataset.sort;
      sortMenu.classList.remove('open');
      render();
      persistSettingsFast();
    });
  });

  // View toggle
  document.querySelectorAll('.view-btn').forEach(b=>{
    b.addEventListener('click', ()=>{
      State.settings.view = b.dataset.view;
      render();
      persistSettingsFast();
    });
  });

  // Sidebar collapse
  const mobileMax = ()=> window.TOOLIFY_MOBILE_MAX || 860;
  document.getElementById('btn-collapse').addEventListener('click', ()=>{
    if(window.innerWidth <= mobileMax()){ closeMobileSidebar(); return; }
    document.getElementById('sidebar').classList.toggle('collapsed');
  });
  document.getElementById('btn-mobile-menu').addEventListener('click', ()=>{
    document.getElementById('sidebar').classList.add('mobile-open');
  });

  // Swipe gestures (mobile): right swipe opens sidebar, left swipe closes
  let _swipeStartX = 0, _swipeStartY = 0;
  document.addEventListener('touchstart', (e)=>{
    if(window.innerWidth > mobileMax()) return;
    if(!e.touches || e.touches.length !== 1) return;
    _swipeStartX = e.touches[0].clientX;
    _swipeStartY = e.touches[0].clientY;
  }, {passive:true});
  document.addEventListener('touchend', (e)=>{
    if(window.innerWidth > mobileMax()) return;
    if(!e.changedTouches || e.changedTouches.length !== 1) return;
    if(e.target.closest?.('input, textarea, select, [contenteditable], .quick-tools-panel, .overlay.open')) return;
    const dx = e.changedTouches[0].clientX - _swipeStartX;
    const dy = e.changedTouches[0].clientY - _swipeStartY;
    if(Math.abs(dx) < 60 || Math.abs(dy) > 60) return;
    const sidebar = document.getElementById('sidebar');
    if(dx > 0) sidebar.classList.add('mobile-open');
    else sidebar.classList.remove('mobile-open');
  }, {passive:true});

  // Mobile: collapse topbar to search-only while scrolling down the tool list
  const contentScroll = document.querySelector('.content-scroll');
  const topbar = document.querySelector('.topbar');
  if(contentScroll && topbar){
    let lastScrollTop = 0;
    const onScroll = ()=>{
      if(window.innerWidth > mobileMax()){ topbar.classList.remove('scrolled'); return; }
      const st = contentScroll.scrollTop;
      if(st > 40 && st > lastScrollTop){
        topbar.classList.add('scrolled');
      } else if(st <= 40){
        topbar.classList.remove('scrolled');
      }
      // show again when scrolling up
      if(st < lastScrollTop){
        topbar.classList.remove('scrolled');
      }
      lastScrollTop = st <= 0 ? 0 : st;
    };
    contentScroll.addEventListener('scroll', onScroll, {passive:true});
    window.addEventListener('resize', ()=>{ if(window.innerWidth > mobileMax()) topbar.classList.remove('scrolled'); });
  }

  // Keyboard shortcuts
  document.addEventListener('keydown', (e)=>{
    const target = e.target;
    const typing = !!(target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable));

    // Escape always works
    if(e.key === 'Escape'){
      let closed = false;
      ['tool-overlay','confirm-overlay','reset-overlay','import-overlay','settings-overlay'].forEach(id=>{
        const el = document.getElementById(id);
        if(el && el.classList.contains('open')){ el.classList.remove('open'); closed = true; }
      });
      closeMobileSidebar();
      if(!closed){
        const si = document.getElementById('mac-search-input');
        if(si && si.value){ si.value = ''; State.ui.search = ''; document.getElementById('search-clear')?.classList.remove('show'); renderGrid(); }
        si?.blur();
      }
      return;
    }

    if(typing) return;
    const anyOpen = !!document.querySelector('.overlay.open');
    if(anyOpen) return;

    switch(e.key){
      case '/':
        e.preventDefault();
        document.getElementById('mac-search-input')?.focus();
        break;
      case 'n':
      case 'N':
        e.preventDefault();
        openToolModal();
        break;
      case ',':
        e.preventDefault();
        openSettings('general');
        break;
      case '?':
        e.preventDefault();
        openSettings('general');
        break;
      case 'f':
      case 'F':
        e.preventDefault();
        State.ui.activeNav = 'favorites';
        State.ui.search = '';
        const siF = document.getElementById('mac-search-input'); if(siF) siF.value = '';
        document.getElementById('search-clear')?.classList.remove('show');
        closeMobileSidebar();
        render();
        break;
      case 'a':
      case 'A':
        e.preventDefault();
        State.ui.activeNav = 'all';
        State.ui.search = '';
        const siA = document.getElementById('mac-search-input'); if(siA) siA.value = '';
        document.getElementById('search-clear')?.classList.remove('show');
        closeMobileSidebar();
        render();
        break;
    }
  });

  // Favorite toggle & double-click alt path from card (long-press not needed; use small affordance via keyboard 'f' when focused)
  document.getElementById('tool-grid').addEventListener('dblclick', (e)=>{
    const card = e.target.closest('.tool-card');
    if(card) toggleFavorite(card.dataset.id);
  });
}
