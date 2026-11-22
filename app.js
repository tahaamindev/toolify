/* ============================================================
   TOOLIFY — Application entry point
   Loaded last from index.html. All feature modules are classic
   scripts under ./js/ so the app also works when opened directly
   from disk (file://), where ES module imports are blocked by CORS.
   ============================================================ */

/* Keep the address bar clean after a hard refresh. */
try{
  const url = new URL(window.location.href);
  if(url.searchParams.has('_hr')){
    url.searchParams.delete('_hr');
    window.history.replaceState(null, '', url.toString());
  }
}catch(error){ /* non-http contexts can be ignored */ }

/* Boot the clock / stopwatch / timer panel after every module is ready. */
startClock();
