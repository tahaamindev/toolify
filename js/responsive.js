/* ============================================================
   TOOLIFY — Responsive behaviour controller
   Small, defensive hooks that complement responsive.css.
   It only manages transient mobile UI state and shared breakpoints.
   ============================================================ */

(function(){
  'use strict';

  const MOBILE_MAX = 860;
  window.TOOLIFY_MOBILE_MAX = MOBILE_MAX;

  const root = document.documentElement;
  const mobileQuery = window.matchMedia(`(max-width: ${MOBILE_MAX}px)`);
  const phoneQuery = window.matchMedia('(max-width: 600px)');
  const shortQuery = window.matchMedia('(max-height: 560px)');
  const touchQuery = window.matchMedia('(hover: none) and (pointer: coarse)');

  const sidebar = document.getElementById('sidebar');
  const menuButton = document.getElementById('btn-mobile-menu');
  const dock = document.querySelector('.quick-tools');
  const topbar = document.querySelector('.topbar');

  /* ---- shared state classes for CSS and other modules ---- */
  function syncStateClasses(){
    root.classList.toggle('rp-mobile', mobileQuery.matches);
    root.classList.toggle('rp-phone', phoneQuery.matches);
    root.classList.toggle('rp-short', shortQuery.matches);
    root.classList.toggle('rp-touch', touchQuery.matches);
    updateViewportHeight();
  }

  function updateViewportHeight(){
    const height = window.visualViewport?.height || window.innerHeight;
    root.style.setProperty('--app-vh', `${height}px`);
  }

  /* ---- sidebar backdrop + accessible menu state ---- */
  let backdrop = document.getElementById('sidebar-backdrop');
  if(!backdrop && sidebar){
    backdrop = document.createElement('div');
    backdrop.id = 'sidebar-backdrop';
    backdrop.setAttribute('aria-hidden', 'true');
    document.body.appendChild(backdrop);
  }

  function closeSidebar(){
    sidebar?.classList.remove('mobile-open');
    menuButton?.setAttribute('aria-expanded', 'false');
  }

  function syncSidebarState(){
    const open = !!sidebar?.classList.contains('mobile-open');
    backdrop?.classList.toggle('open', open && mobileQuery.matches);
    menuButton?.setAttribute('aria-expanded', String(open));
  }

  backdrop?.addEventListener('click', closeSidebar);

  document.addEventListener('click', event => {
    if(!mobileQuery.matches || !sidebar?.classList.contains('mobile-open')) return;
    if(event.target.closest('#sidebar') || event.target.closest('#btn-mobile-menu')) return;
    closeSidebar();
  });

  if(sidebar && 'MutationObserver' in window){
    new MutationObserver(syncSidebarState).observe(sidebar, {
      attributes:true, attributeFilter:['class']
    });
  }

  /* Navigating from the drawer should dismiss it on small screens. */
  document.getElementById('sidebar-nav')?.addEventListener('click', event => {
    if(event.target.closest('.nav-item')) closeSidebar();
  });

  /* ---- right workspace panel: dismiss when tapping outside ---- */
  function closeWorkspacePanel(){
    if(!dock || !dock.classList.contains('mobile-panel-open')) return;
    dock.classList.remove('mobile-panel-open');
    dock.querySelectorAll('.quick-tools-tab').forEach(button => {
      button.setAttribute('aria-pressed', 'false');
    });
  }

  document.addEventListener('click', event => {
    if(!mobileQuery.matches || !dock || !dock.classList.contains('mobile-panel-open')) return;
    if(event.target.closest('.quick-tools')) return;
    closeWorkspacePanel();
  });

  /* ---- breakpoint changes: never leave stale overlays behind ---- */
  function handleBreakpointChange(){
    syncStateClasses();
    if(!mobileQuery.matches){
      closeSidebar();
      closeWorkspacePanel();
      topbar?.classList.remove('scrolled');
    }
    syncSidebarState();
  }

  const listen = (query, handler) => {
    if(query.addEventListener) query.addEventListener('change', handler);
    else if(query.addListener) query.addListener(handler);
  };

  listen(mobileQuery, handleBreakpointChange);
  listen(phoneQuery, syncStateClasses);
  listen(shortQuery, syncStateClasses);
  listen(touchQuery, syncStateClasses);

  window.addEventListener('resize', syncStateClasses, { passive:true });
  window.visualViewport?.addEventListener('resize', updateViewportHeight, { passive:true });
  window.visualViewport?.addEventListener('scroll', updateViewportHeight, { passive:true });

  syncStateClasses();
  syncSidebarState();
})();
