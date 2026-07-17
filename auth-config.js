/**
 * BIM.LVA — настройки авторизации.
 *
 * Сейчас работает режим local (регистрация в этом браузере).
 * Чтобы пользователи были общими на всех устройствах:
 * 1) Создайте бесплатный проект на https://supabase.com
 * 2) Authentication → Providers → Email: включить
 * 3) Вставьте URL и anon key ниже
 * 4) В Authentication → URL Configuration добавьте:
 *    https://vleutsky.github.io/bim-lva
 */
window.BIMLVA_AUTH_CONFIG = {
  // 'auto' | 'local' | 'supabase'
  mode: 'auto',

  supabaseUrl: '',
  supabaseAnonKey: '',

  // Email админов (видят список пользователей / доступ к stats после входа)
  adminEmails: [
    'vladimirl1985@gmail.com'
  ],

  // Пароль к stats.html (смените!). Хэш SHA-256 от строки.
  // Текущий пароль по умолчанию: bimlva-stats
  statsPasswordSha256: 'be2b5a8ec87fc9b08f7e30554f56993b1636267ec66cda921886134aafa4e94b',

  siteName: 'BIM.LVA'
};
