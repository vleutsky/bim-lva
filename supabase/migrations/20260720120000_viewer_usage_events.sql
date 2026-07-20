-- Журнал использования Composer / сайта (без имён файлов).
-- Выполните в Supabase SQL Editor, затем добавьте admin-email в site_admins.

create table if not exists public.viewer_usage_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id uuid null,
  email text null,
  client_id text not null,
  event text not null,
  props jsonb not null default '{}'::jsonb,
  page text null
);

create index if not exists viewer_usage_events_created_at_idx
  on public.viewer_usage_events (created_at desc);
create index if not exists viewer_usage_events_email_idx
  on public.viewer_usage_events (lower(email));
create index if not exists viewer_usage_events_client_idx
  on public.viewer_usage_events (client_id);

create table if not exists public.site_admins (
  email text primary key
);

comment on table public.site_admins is 'Кто может читать viewer_usage_events (совпадает с adminEmails в auth-config.js)';

alter table public.viewer_usage_events enable row level security;
alter table public.site_admins enable row level security;

drop policy if exists viewer_usage_insert on public.viewer_usage_events;
create policy viewer_usage_insert on public.viewer_usage_events
  for insert to anon, authenticated
  with check (true);

drop policy if exists viewer_usage_select_admin on public.viewer_usage_events;
create policy viewer_usage_select_admin on public.viewer_usage_events
  for select to authenticated
  using (
    exists (
      select 1 from public.site_admins a
      where lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    )
  );

drop policy if exists site_admins_select on public.site_admins;
create policy site_admins_select on public.site_admins
  for select to authenticated
  using (
    lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
