/* ============================================================
   TOOLIFY — Supabase client
   Creates the single shared client from the CDN-loaded
   `window.supabase` library. Kept separate from the data layer
   so auth and cloud sync both use the exact same instance.
   ============================================================ */

let supabaseClient = null;
try {
  supabaseClient = window.supabase
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          storage: window.localStorage,
          storageKey: "toolify-auth",
        },
      })
    : null;
} catch (error) {
  console.error("Supabase initialization failed:", error);
  supabaseClient = null;
}
