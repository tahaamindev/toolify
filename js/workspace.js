/* ============================================================
   TOOLIFY — Right-sidebar workspace (notes, tasks, panels)
   Split from the original app.js (behaviour preserved).
   ============================================================ */

function setRightPanel(panelName,forceOpen=false){
  const dock = document.querySelector('.quick-tools');
  const isMobile = window.matchMedia('(max-width: 860px)').matches;
  const activeTab = document.querySelector('.quick-tools-tab.active');
  const wasSamePanel = activeTab?.dataset.rightPanel === panelName;
  const mobilePanelOpen = dock.classList.contains('mobile-panel-open');
  const closeMobilePanel = !forceOpen && isMobile && wasSamePanel && mobilePanelOpen;
  dock.classList.toggle('mobile-panel-open', isMobile && !closeMobilePanel);
  document.querySelectorAll('.quick-tools-tab').forEach(button=>{
    const isActive = button.dataset.rightPanel === panelName;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-pressed', String(isActive && !closeMobilePanel));
  });
  document.getElementById('right-home-panel').hidden = panelName !== 'home' || closeMobilePanel;
  document.getElementById('music-player').hidden = panelName !== 'music' || closeMobilePanel;
  document.getElementById('notes-panel').hidden = panelName !== 'notes' || closeMobilePanel;
  document.getElementById('tasks-panel').hidden = panelName !== 'tasks' || closeMobilePanel;
  document.getElementById('clock-panel').hidden = panelName !== 'clock' || closeMobilePanel;
  const booksPanel = document.getElementById('books-panel');
  if(booksPanel) booksPanel.hidden = panelName !== 'books' || closeMobilePanel;
  if(panelName==='music'&&!closeMobilePanel) loadYouTubePlayer(true);
}

function renderWorkspaceOverview(){
  const toolCount = document.getElementById('workspace-tool-count');
  const favoriteCount = document.getElementById('workspace-favorite-count');
  if(toolCount) toolCount.textContent = String(State.tools.length);
  if(favoriteCount) favoriteCount.textContent = String(State.tools.filter(tool=>tool.favorite).length);
}

function renderQuickNotes(){
  const list = document.getElementById('quick-notes-list');
  if(!list) return;
  list.innerHTML = notesList().length
    ? notesList().slice().reverse().map(note=>`<div class="quick-note-item" role="button" tabindex="0" data-load-note="${escapeHTML(note.id)}">${escapeHTML(note.text)}<button class="quick-note-delete" type="button" data-delete-note="${escapeHTML(note.id)}" aria-label="Delete note">&times;</button></div>`).join('')
    : '<div class="quick-note-empty">No saved notes yet.</div>';
  list.querySelectorAll('[data-load-note]').forEach(item=>{
    const loadNote = ()=>{
      const note = notesList().find(savedNote=>savedNote.id === item.dataset.loadNote);
      if(!note) return;
      const input = document.getElementById('quick-note-input');
      input.value = note.text;
      input.focus();
    };
    item.addEventListener('click', loadNote);
    item.addEventListener('keydown', event=>{
      if(event.key === 'Enter' || event.key === ' '){
        event.preventDefault();
        loadNote();
      }
    });
  });
  list.querySelectorAll('[data-delete-note]').forEach(button=>{
    button.addEventListener('keydown', event=>event.stopPropagation());
    button.addEventListener('click', async (event)=>{
      event.stopPropagation();
      State.settings.notes = notesList().filter(note=>note.id !== button.dataset.deleteNote);
      renderQuickNotes();
      persistSettingsFast();
    });
  });
}
let taskFilter = 'all';
function renderQuickTasks(){
  const list = document.getElementById('quick-tasks-list');
  if(!list) return;
  const tasks = tasksList();
  const doneCount = tasks.filter(task=>task.done).length;
  const leftCount = tasks.length - doneCount;
  const progressLabel = document.getElementById('tasks-progress-label');
  const progressBar = document.getElementById('tasks-progress-bar');
  const remainingLabel = document.getElementById('tasks-remaining');
  const clearButton = document.getElementById('tasks-clear-done');
  const markAllButton = document.getElementById('tasks-mark-all');
  if(progressLabel) progressLabel.textContent = `${doneCount} of ${tasks.length} completed`;
  if(progressBar) progressBar.style.width = tasks.length ? `${(doneCount / tasks.length) * 100}%` : '0%';
  if(remainingLabel) remainingLabel.textContent = leftCount === 1 ? '1 task left' : `${leftCount} tasks left`;
  if(clearButton) clearButton.disabled = doneCount === 0;
  if(markAllButton) markAllButton.disabled = tasks.length === 0 || leftCount === 0;
  const visibleTasks = tasks.filter(task=>taskFilter === 'all' || (taskFilter === 'done' ? task.done : !task.done));
  list.innerHTML = visibleTasks.length
    ? visibleTasks.slice().reverse().map(task=>{
        const id = escapeHTML(task.id);
        return `<div class="quick-task-item${task.done ? ' done' : ''}" data-task-id="${id}">
          <button class="task-check" type="button" role="checkbox" aria-checked="${!!task.done}" aria-label="${task.done ? 'Mark as not done' : 'Mark as done'}" data-task-toggle="${id}"><svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          <span class="task-text" role="button" tabindex="0" title="Click to edit" data-task-edit="${id}">${escapeHTML(task.text)}</span>
          <button class="task-action" type="button" aria-label="Delete task" title="Delete task" data-task-delete="${id}"><svg viewBox="0 0 24 24" fill="none"><path d="M5 7h14M9 7V5h6v2M7 7l1 12h8l1-12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        </div>`;
      }).join('')
    : `<div class="quick-task-empty">${taskFilter === 'done' ? 'No completed tasks yet.' : taskFilter === 'active' ? 'No active tasks. Nice work!' : 'No tasks yet. Add one above.'}</div>`;
  document.querySelectorAll('[data-task-filter]').forEach(button=>{
    const isActive = button.dataset.taskFilter === taskFilter;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-pressed', String(isActive));
  });
}
function beginTaskEdit(id){
  const item = Array.from(document.querySelectorAll('.quick-task-item')).find(element=>element.dataset.taskId === id);
  const textElement = item?.querySelector('.task-text');
  const task = tasksList().find(entry=>entry.id === id);
  if(!textElement || !task || item.querySelector('.task-edit-input')) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'task-edit-input';
  input.maxLength = 200;
  input.value = task.text;
  textElement.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = (save)=>{
    if(finished) return;
    finished = true;
    const value = input.value.trim();
    if(save && value && value !== task.text){
      task.text = value;
      renderQuickTasks();
      persistSettingsFast();
    }else{
      renderQuickTasks();
    }
  };
  input.addEventListener('keydown', event=>{
    if(event.key === 'Enter'){ event.preventDefault(); finish(true); }
    else if(event.key === 'Escape'){ event.preventDefault(); event.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', ()=>finish(true));
}
function setTaskFilter(v){ taskFilter = v; }
