/**
 * BIM.LVA Auth — регистрация / вход.
 * local: аккаунты в localStorage (сразу работает)
 * supabase: общая база (после заполнения auth-config.js)
 */
(function (global) {
  'use strict';

  const cfg = global.BIMLVA_AUTH_CONFIG || {};
  const USERS_KEY = 'bimlva_auth_users_v1';
  const SESSION_KEY = 'bimlva_auth_session_v1';
  const STATS_GATE_KEY = 'bimlva_stats_unlocked_v1';

  let supabaseClient = null;
  let initPromise = null;
  const listeners = new Set();

  function emit() {
    const user = getUser();
    listeners.forEach((fn) => {
      try { fn(user); } catch (_) {}
    });
    try {
      global.dispatchEvent(new CustomEvent('bimlva:auth', { detail: { user } }));
    } catch (_) {}
  }

  function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
  }

  function mode() {
    const m = cfg.mode || 'auto';
    if (m === 'local' || m === 'supabase') return m;
    if (cfg.supabaseUrl && supabaseKey()) return 'supabase';
    return 'local';
  }

  function supabaseKey() {
    return cfg.supabaseAnonKey || cfg.supabasePublishableKey || '';
  }

  function isAdminEmail(email) {
    const list = (cfg.adminEmails || []).map(normalizeEmail);
    return list.includes(normalizeEmail(email));
  }

  async function sha256Hex(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function hashPassword(password, salt) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: enc.encode(salt), iterations: 120000, hash: 'SHA-256' },
      keyMaterial,
      256
    );
    return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function readUsers() {
    try {
      return JSON.parse(localStorage.getItem(USERS_KEY) || '[]');
    } catch (_) {
      return [];
    }
  }

  function writeUsers(users) {
    localStorage.setItem(USERS_KEY, JSON.stringify(users));
  }

  function readSession() {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    } catch (_) {
      return null;
    }
  }

  function writeSession(session) {
    if (!session) localStorage.removeItem(SESSION_KEY);
    else localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }

  function publicUser(raw) {
    if (!raw) return null;
    return {
      id: raw.id,
      email: raw.email,
      name: raw.name || '',
      telegram: raw.telegram || '',
      createdAt: raw.createdAt || null,
      provider: raw.provider || mode(),
      isAdmin: isAdminEmail(raw.email)
    };
  }

  function getUser() {
    return publicUser(readSession());
  }

  function sessionFromUser(u) {
    if (!u) return null;
    return {
      id: u.id,
      email: u.email,
      name: u.user_metadata?.name || '',
      telegram: u.user_metadata?.telegram || '',
      createdAt: u.created_at,
      provider: 'supabase'
    };
  }

  async function ensureSupabase() {
    if (supabaseClient) return supabaseClient;
    if (mode() !== 'supabase') return null;
    const key = supabaseKey();
    if (!cfg.supabaseUrl || !key) {
      throw new Error('Supabase не настроен: укажите URL и ключ в auth-config.js');
    }
    if (!global.supabase?.createClient) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.7/dist/umd/supabase.js';
        s.async = true;
        s.onload = resolve;
        s.onerror = () => reject(new Error('Не удалось загрузить Supabase SDK (CDN)'));
        document.head.appendChild(s);
      });
    }
    if (!global.supabase?.createClient) {
      throw new Error('Supabase SDK загружен, но createClient недоступен');
    }

    // Не парсим hash Composer (#view=...) как OAuth-callback
    supabaseClient = global.supabase.createClient(cfg.supabaseUrl, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storage: global.localStorage
      }
    });
    return supabaseClient;
  }

  async function syncFromSupabaseSession(client) {
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    const u = data?.session?.user;
    if (u) {
      writeSession(sessionFromUser(u));
      return getUser();
    }
    return null;
  }

  async function init() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      if (mode() === 'supabase') {
        try {
          const client = await ensureSupabase();
          await syncFromSupabaseSession(client);

          // Если зеркало пустое — пробуем refresh (после перехода index→composer)
          if (!getUser()) {
            try {
              const { data } = await client.auth.refreshSession();
              if (data?.session?.user) writeSession(sessionFromUser(data.session.user));
            } catch (_) {}
          }

          client.auth.onAuthStateChange((_event, session) => {
            const u = session?.user;
            writeSession(u ? sessionFromUser(u) : null);
            emit();
          });
        } catch (e) {
          console.error('BimLvaAuth init:', e);
          global.__bimlvaAuthInitError = e?.message || String(e);
          // Не затираем уже сохранённую сессию — UI на Composer останется в аккаунте
        }
      }
      emit();
      return getUser();
    })();
    return initPromise;
  }

  async function refresh() {
    if (mode() !== 'supabase') {
      emit();
      return getUser();
    }
    try {
      const client = await ensureSupabase();
      await syncFromSupabaseSession(client);
      if (!getUser()) {
        const { data } = await client.auth.refreshSession();
        if (data?.session?.user) writeSession(sessionFromUser(data.session.user));
      }
    } catch (e) {
      console.warn('BimLvaAuth refresh:', e);
    }
    emit();
    return getUser();
  }

  async function register({ email, password, name, telegram }) {
    email = normalizeEmail(email);
    name = String(name || '').trim();
    telegram = String(telegram || '').trim();
    password = String(password || '');

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error('Укажите корректный email');
    }
    if (password.length < 6) throw new Error('Пароль не короче 6 символов');
    if (!name) throw new Error('Укажите имя');

    if (mode() === 'supabase') {
      const client = await ensureSupabase();
      const { data, error } = await client.auth.signUp({
        email,
        password,
        options: {
          data: { name, telegram },
          emailRedirectTo: 'https://vleutsky.github.io/bim-lva/'
        }
      });
      if (error) {
        // Уже есть аккаунт — сразу пробуем войти тем же паролем
        if (/already registered|User already registered/i.test(error.message || '')) {
          return login({ email, password });
        }
        throw new Error(mapAuthError(error.message, { isAdmin: isAdminEmail(email) }));
      }
      const u = data.user;
      if (data.session && u) {
        writeSession(sessionFromUser(u));
        // имя/telegram из формы приоритетнее пустых metadata
        const cur = readSession();
        if (cur) {
          writeSession({
            ...cur,
            name: name || cur.name,
            telegram: telegram || cur.telegram
          });
        }
        try { global.BimLvaStats?.track?.('user_register', { provider: 'supabase' }); } catch (_) {}
        emit();
        return { user: getUser(), needsEmailConfirm: false };
      }
      try { global.BimLvaStats?.track?.('user_register', { provider: 'supabase' }); } catch (_) {}
      emit();
      // Если confirm email включён в Supabase — сессии не будет
      if (isAdminEmail(email)) {
        return {
          user: null,
          needsEmailConfirm: true,
          adminHint: true
        };
      }
      return { user: getUser(), needsEmailConfirm: true };
    }

    const users = readUsers();
    if (users.some((u) => u.email === email)) {
      throw new Error('Этот email уже зарегистрирован');
    }
    const salt = crypto.randomUUID();
    const passHash = await hashPassword(password, salt);
    const row = {
      id: crypto.randomUUID(),
      email,
      name,
      telegram,
      salt,
      passHash,
      createdAt: new Date().toISOString(),
      provider: 'local'
    };
    users.push(row);
    writeUsers(users);
    writeSession({
      id: row.id,
      email: row.email,
      name: row.name,
      telegram: row.telegram,
      createdAt: row.createdAt,
      provider: 'local'
    });
    try { global.BimLvaStats?.track?.('user_register', { provider: 'local' }); } catch (_) {}
    emit();
    return { user: getUser(), needsEmailConfirm: false };
  }

  async function login({ email, password }) {
    email = normalizeEmail(email);
    password = String(password || '');
    if (!email || !password) throw new Error('Введите email и пароль');

    if (mode() === 'supabase') {
      const client = await ensureSupabase();
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw new Error(mapAuthError(error.message, { isAdmin: isAdminEmail(email) }));
      const u = data.user;
      writeSession(sessionFromUser(u));
      try { global.BimLvaStats?.track?.('user_login', { provider: 'supabase' }); } catch (_) {}
      emit();
      return getUser();
    }

    const user = readUsers().find((u) => u.email === email);
    if (!user) throw new Error('Неверный email или пароль');
    const passHash = await hashPassword(password, user.salt);
    if (passHash !== user.passHash) throw new Error('Неверный email или пароль');
    writeSession({
      id: user.id,
      email: user.email,
      name: user.name,
      telegram: user.telegram,
      createdAt: user.createdAt,
      provider: 'local'
    });
    try { global.BimLvaStats?.track?.('user_login', { provider: 'local' }); } catch (_) {}
    emit();
    return getUser();
  }

  async function logout() {
    if (mode() === 'supabase' && supabaseClient) {
      try { await supabaseClient.auth.signOut(); } catch (_) {}
    }
    writeSession(null);
    emit();
  }

  function listLocalUsers() {
    return readUsers().map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      telegram: u.telegram,
      createdAt: u.createdAt
    })).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async function unlockStats(password) {
    const hash = await sha256Hex(String(password || ''));
    const expected = String(cfg.statsPasswordSha256 || '');
    if (!expected || hash !== expected) throw new Error('Неверный пароль');
    try { sessionStorage.setItem(STATS_GATE_KEY, '1'); } catch (_) {}
    return true;
  }

  function isStatsUnlocked() {
    const user = getUser();
    if (user?.isAdmin) return true;
    try { return sessionStorage.getItem(STATS_GATE_KEY) === '1'; } catch (_) { return false; }
  }

  function lockStats() {
    try { sessionStorage.removeItem(STATS_GATE_KEY); } catch (_) {}
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function mapAuthError(msg, opts = {}) {
    const m = String(msg || '');
    const admin = !!opts.isAdmin;
    if (/Invalid login credentials/i.test(m)) {
      return admin
        ? 'Неверный пароль или аккаунт ещё не создан. Если регистрировались с Confirm email — в Supabase: Authentication → Users → Confirm user, либо отключите Confirm email.'
        : 'Неверный email или пароль';
    }
    if (/Email not confirmed/i.test(m)) {
      return 'Email не подтверждён. В Supabase: Authentication → Providers → Email → выключите Confirm email (или Confirm user в Users).';
    }
    if (/User already registered/i.test(m)) return 'Этот email уже зарегистрирован — войдите';
    if (/rate limit|over_email_send_rate_limit/i.test(m)) {
      return 'Лимит писем Supabase. Отключите Confirm email: Authentication → Providers → Email → Confirm email = OFF, подождите 1–2 мин.';
    }
    if (/Password/i.test(m) && /least/i.test(m)) return 'Пароль слишком короткий';
    return m || 'Ошибка авторизации';
  }

  global.BimLvaAuth = {
    init,
    refresh,
    mode,
    getUser,
    register,
    login,
    logout,
    listLocalUsers,
    unlockStats,
    isStatsUnlocked,
    lockStats,
    isAdminEmail,
    onChange,
    config: cfg
  };
})(typeof window !== 'undefined' ? window : globalThis);
