/**
 * BIM.LVA — настройки авторизации (Supabase).
 *
 * ОБЯЗАТЕЛЬНО в панели Supabase (иначе лимиты писем / «confirm email»):
 * 1) Authentication → Providers → Email
 *    - Confirm email → ВЫКЛЮЧИТЬ
 * 2) Authentication → URL Configuration
 *    - Site URL: https://vleutsky.github.io/bim-lva
 *    - Redirect URLs: https://vleutsky.github.io/bim-lva/**
 * 3) Authentication → Users → ваш пользователь → Confirm / Ban: none
 */
window.BIMLVA_AUTH_CONFIG = {
  // 'auto' | 'local' | 'supabase'
  mode: 'supabase',

  supabaseUrl: 'https://lgpzlvdviwieqkzkhebt.supabase.co',
  // Publishable key (новый формат) — безопасен для клиента
  supabaseAnonKey: 'sb_publishable_mg64FytgDS0ZnIBYcZDmkQ_03C5Ahco',

  // Email админов (stats без пароля после входа, пометки в UI)
  adminEmails: [
    'vladimirl1985@gmail.com'
  ],

  // Пароль к stats.html (по умолчанию: bimlva-stats)
  statsPasswordSha256: 'be2b5a8ec87fc9b08f7e30554f56993b1636267ec66cda921886134aafa4e94b',

  // Скачивание с Яндекс.Диска: браузер получает 403/CORS на downloader.disk.yandex.ru,
  // поэтому бинарники идут через CORS-прокси.
  // 'dokpub' — публичный getfile.dokpub.com (работает сразу)
  // 'supabase' — свой Edge Function ya-proxy (см. supabase/functions/ya-proxy)
  // 'auto' — сначала supabase (если задан), иначе dokpub
  yaDownloadProxy: 'dokpub',
  // yaProxyUrl: 'https://lgpzlvdviwieqkzkhebt.supabase.co/functions/v1/ya-proxy',

  siteName: 'BIM.LVA'
};
