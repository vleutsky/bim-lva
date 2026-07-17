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
    if (cfg.supabaseUrl && cfg.supabaseAnonKey) return 'supabase';
    return 'local';
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

  async function ensureSupabase() {
    if (supabaseClient) return supabaseClient;
    if (mode() !== 'supabase') return null;
    if (!global.supabase?.createClient) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.1/dist/umd/supabase.min.js';
        s.async = true;
        s.onload = resolve;
        s.onerror = () => reject(new Error('Не удалось загрузить Supabase SDK'));
        document.head.appendChild(s);
      });
    }
    supabaseClient = global.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    return supabaseClient;
  }

  async function init() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      if (mode() === 'supabase') {
        const client = await ensureSupabase();
        const { data } = await client.auth.getSession();
        const s = data?.session?.user;
        if (s) {
          writeSession({
            id: s.id,
            email: s.email,
            name: s.user_metadata?.name || '',
            telegram: s.user_metadata?.telegram || '',
            createdAt: s.created_at,
            provider: 'supabase'
          });
        }
        client.auth.onAuthStateChange((_event, session) => {
          const u = session?.user;
          if (u) {
            writeSession({
              id: u.id,
              email: u.email,
              name: u.user_metadata?.name || '',
              telegram: u.user_metadata?.telegram || '',
              createdAt: u.created_at,
              provider: 'supabase'
            });
          } else {
            writeSession(null);
          }
          emit();
        });
      }
      emit();
      return getUser();
    })();
    return initPromise;
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
        options: { data: { name, telegram } }
      });
      if (error) throw new Error(error.message);
      const u = data.user;
      if (data.session && u) {
        writeSession({
          id: u.id,
          email: u.email,
          name,
          telegram,
          createdAt: u.created_at,
          provider: 'supabase'
        });
      }
      try { global.BimLvaStats?.track?.('user_register', { provider: 'supabase' }); } catch (_) {}
      emit();
      return {
        user: getUser(),
        needsEmailConfirm: !data.session
      };
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
      if (error) throw new Error(error.message);
      const u = data.user;
      writeSession({
        id: u.id,
        email: u.email,
        name: u.user_metadata?.name || '',
        telegram: u.user_metadata?.telegram || '',
        createdAt: u.created_at,
        provider: 'supabase'
      });
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

  global.BimLvaAuth = {
    init,
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
