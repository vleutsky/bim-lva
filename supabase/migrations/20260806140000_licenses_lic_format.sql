-- Приведение таблиц лицензий к формату, который уже понимают плагины LVA BIM.
-- Выполните в SQL Editor ПОСЛЕ 20260805120000_licenses.sql (она уже применена).
--
-- Что изменилось и почему: первая версия рассчитывала на компактный ключ-строку
-- без привязки к железу. Плагины же проверяют файл license.lic — JSON с полями
-- LicensePayload и подписью RSA, и лицензия в них node-locked: LicenseGate
-- сверяет HostLock с SHA-256 от UUID материнской платы. Без Machine ID выпустить
-- рабочую лицензию невозможно, поэтому он и появляется в заявке.

-- Machine ID клиента: 64 hex-символа, как их выдаёт Get-LvaMachineId.ps1.
-- Пустая строка допустима — это лицензия без привязки к машине.
alter table public.license_requests
  add column if not exists machine_id text not null default '';

alter table public.licenses
  add column if not exists machine_id text not null default '';

comment on column public.license_requests.machine_id is
  'Machine ID (SHA-256 от UUID материнской платы, 64 hex). Пусто — без привязки.';

-- В licenses.license_key теперь лежит содержимое license.lic целиком —
-- JSON вида {"Payload":{...},"Signature":"..."}. Имя колонки оставлено прежним,
-- чтобы не ломать уже применённую миграцию и код, который её читает.
comment on column public.licenses.license_key is
  'Файл license.lic целиком: JSON {Payload, Signature}. Клиент кладёт его в %ProgramData%\LVA.BIM\.';

-- Срок стал необязательным: LicenseGate считает ExpiresUtc = null бессрочной
-- лицензией, и такие вы выдавали PowerShell-скриптом.
alter table public.licenses
  alter column expires_at drop not null;

-- Продукты в заявке — это Civil / Navis / Inventor / *, а не произвольная
-- строка: именно эти значения проверяются в коде плагинов
-- (LicenseGate.Check("Civil") и т.д.). Ограничение ловит опечатку на входе,
-- пока она не превратилась в лицензию, которую плагин молча отвергнет.
alter table public.license_requests
  drop constraint if exists license_requests_product_known;
alter table public.license_requests
  add constraint license_requests_product_known
  check (product in ('Civil', 'Navis', 'Inventor', '*'));

alter table public.licenses
  drop constraint if exists licenses_product_known;
alter table public.licenses
  add constraint licenses_product_known
  check (product in ('Civil', 'Navis', 'Inventor', '*'));
