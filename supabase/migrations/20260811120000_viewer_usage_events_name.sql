-- ФИО рядом с email в статистике (stats.html → «Composer — пользователи»).
-- Имя берётся из user_metadata.name (то же поле, что в личном кабинете при
-- регистрации) — клиент подставляет его сам при записи события, отдельный
-- сервер тут не нужен: insert для anon/authenticated уже разрешён политикой
-- viewer_usage_insert из 20260720120000_viewer_usage_events.sql.

alter table public.viewer_usage_events
  add column if not exists name text null;
