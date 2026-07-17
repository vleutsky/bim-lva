/**
 * BIM.LVA — настройки авторизации (Supabase).
 *
 * В панели Supabase проверьте:
 * Authentication → URL Configuration
 *   Site URL: https://vleutsky.github.io/bim-lva
 *   Redirect URLs: https://vleutsky.github.io/bim-lva/**
 *
 * Authentication → Providers → Email — включён.
 * Для теста можно отключить «Confirm email».
 */
window.BIMLVA_AUTH_CONFIG = {
  // 'auto' | 'local' | 'supabase'
  mode: 'supabase',

  supabaseUrl: 'https://lgpzlvdviwieqkzkhebt.supabase.co',
  // Publishable key (новый формат) — безопасен для клиента
  supabaseAnonKey: 'sb_publishable_mg64FytgDS0ZnIBYcZDmkQ_03C5Ahco',

  // Email админов (доступ к stats после входа)
  adminEmails: [
    'vladimirl1985@gmail.com'
  ],

  // Пароль к stats.html (по умолчанию: bimlva-stats)
  statsPasswordSha256: 'be2b5a8ec87fc9b08f7e30554f56993b1636267ec66cda921886134aafa4e94b',

  siteName: 'BIM.LVA'
};
