-- Лицензии BIM.LVA: заявки из личного кабинета и выданные ключи.
-- Выполните в Supabase SQL Editor после миграции viewer_usage_events.
--
-- Модель доверия: пользователь может создать заявку и читать только свои
-- строки. Выдать лицензию из браузера нельзя ни при каких правах — вставка и
-- изменение в public.licenses закрыты для всех клиентских ролей, и делает это
-- только Edge Function `license-issue` под service_role, где лежит ключ подписи.

-- ---------------------------------------------------------------- админы ---
-- Список админов держим в базе, а не в auth-config.js: тот файл открыт всем,
-- и подставить туда свой email может кто угодно. Здесь это делает только
-- владелец проекта через SQL Editor.
create table if not exists public.license_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  added_at timestamptz not null default now()
);

alter table public.license_admins enable row level security;

-- Видно только свою строку: страница админки должна понимать, показывать ли
-- инструменты, а весь список админов браузеру знать незачем. Полномочия это
-- не даёт — их всё равно проверяет Edge Function.
drop policy if exists license_admins_select_self on public.license_admins;
create policy license_admins_select_self on public.license_admins
  for select using (user_id = auth.uid());

create or replace function public.is_license_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.license_admins a where a.user_id = auth.uid()
  );
$$;

-- --------------------------------------------------------------- заявки ----
create table if not exists public.license_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  email text not null,
  product text not null,
  org text not null default '',
  full_name text not null default '',
  comment text not null default '',
  status text not null default 'new'
    check (status in ('new', 'approved', 'rejected')),
  decided_at timestamptz null,
  decided_by uuid null references auth.users (id) on delete set null,
  decision_note text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists license_requests_user_idx
  on public.license_requests (user_id, created_at desc);
create index if not exists license_requests_status_idx
  on public.license_requests (status, created_at desc);

-- Одна открытая заявка на продукт: без этого кнопка «Отправить», нажатая
-- трижды, превращается в три заявки в списке у админа.
create unique index if not exists license_requests_one_open_idx
  on public.license_requests (user_id, product)
  where status = 'new';

alter table public.license_requests enable row level security;

drop policy if exists license_requests_select_own on public.license_requests;
create policy license_requests_select_own on public.license_requests
  for select using (user_id = auth.uid() or public.is_license_admin());

drop policy if exists license_requests_insert_own on public.license_requests;
create policy license_requests_insert_own on public.license_requests
  for insert with check (
    user_id = auth.uid()
    -- Статус заявки ставит только сервер: иначе можно было бы создать
    -- сразу «approved» и ждать, что этого никто не заметит.
    and status = 'new'
    and decided_at is null
    and decided_by is null
  );

-- Изменять и удалять заявки клиент не может: решение принимает Edge Function.

-- ------------------------------------------------------------- лицензии ----
create table if not exists public.licenses (
  id uuid primary key default gen_random_uuid(),
  request_id uuid null references public.license_requests (id) on delete set null,
  user_id uuid not null references auth.users (id) on delete cascade,
  email text not null,
  org text not null default '',
  product text not null,
  -- Подписанный ключ целиком, как его копирует пользователь.
  license_key text not null,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  issued_by uuid null references auth.users (id) on delete set null,
  revoked_at timestamptz null,
  revoke_reason text not null default ''
);

create index if not exists licenses_user_idx on public.licenses (user_id, issued_at desc);

alter table public.licenses enable row level security;

drop policy if exists licenses_select_own on public.licenses;
create policy licenses_select_own on public.licenses
  for select using (user_id = auth.uid() or public.is_license_admin());

-- Ни insert, ни update, ни delete из браузера: ключи выпускает только
-- Edge Function под service_role. Права на выпуск в клиенте не существует —
-- поэтому и красть из него нечего.

-- ------------------------------------------------------------------ ---------
-- Назначить себя админом (подставьте свой email):
--
--   insert into public.license_admins (user_id, email)
--   select id, email from auth.users where email = 'вы@пример.ru'
--   on conflict (user_id) do nothing;
