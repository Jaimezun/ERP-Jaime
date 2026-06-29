/* =====================================================================
   supabase-data.js — capa de datos compartida (Supabase) para el ERP
   Incluir en cada HTML, DESPUÉS del cliente oficial de Supabase:

     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
     <script src="supabase-data.js"></script>

   Expone window.DB con: login, logout, getSession, nextId,
   selectAll, upsert, remove, subscribe.
   ===================================================================== */
(function () {
  // ▼▼▼ CREDENCIALES (Project Settings → API) ▼▼▼
  const SUPABASE_URL = 'https://arabqxnrjqszpbkwrcyu.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_JFM3XuaTZRyHImPskXn15Q_hG_ZUHgo';
  // ▲▲▲ la publishable key es pública a propósito; lo que protege es la RLS ▲▲▲

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true }
  });

  // ── AUTH ────────────────────────────────────────────────
  async function login(email, password) {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    const profile = await loadProfile();
    return { user: data.user, profile };
  }

  async function logout() { await sb.auth.signOut(); }

  // Carga el perfil (rol + cliente_id) del usuario autenticado.
  async function loadProfile() {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return null;
    const { data, error } = await sb
      .from('profiles').select('*').eq('user_id', user.id).single();
    if (error) return null;
    return data; // { user_id, role, cliente_id, nombre }
  }

  // Devuelve { user, profile } o null. Úsalo como "gate" de cada página.
  async function getSession() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return null;
    const profile = await loadProfile();
    if (!profile) return null;
    return { user: session.user, profile };
  }

  // ── IDs ATÓMICOS (reemplaza el contador nextId del navegador) ──
  async function nextId(prefix) {
    const { data, error } = await sb.rpc('next_id', { p: prefix });
    if (error) throw error;
    return data; // ej. 'l8'
  }

  // Entero secuencial atómico, para números visibles tipo A-0000008, L-…, SO-…
  // Requiere la función SQL next_num (ver instrucciones de migración).
  async function nextNum(prefix) {
    const { data, error } = await sb.rpc('next_num', { p: prefix });
    if (error) throw error;
    return data; // ej. 8
  }

  // ── CRUD GENÉRICO ───────────────────────────────────────
  async function selectAll(table, filters) {
    let q = sb.from(table).select('*');
    if (filters) for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }

  async function upsert(table, row) {
    const { data, error } = await sb.from(table).upsert(row).select();
    if (error) throw error;
    return data;
  }

  async function remove(table, col, val) {
    const { error } = await sb.from(table).delete().eq(col, val);
    if (error) throw error;
  }

  // ── REALTIME (reemplaza el evento 'storage' entre pestañas) ──
  // subscribe(['lotes','cierres'], payload => { ... })
  function subscribe(tables, cb) {
    const ch = sb.channel('rt_' + Math.random().toString(36).slice(2));
    tables.forEach(t =>
      ch.on('postgres_changes', { event: '*', schema: 'public', table: t }, cb));
    ch.subscribe();
    return ch; // ch.unsubscribe() para cancelar
  }

  window.DB = { sb, login, logout, getSession, loadProfile, nextId, nextNum, selectAll, upsert, remove, subscribe };
})();
