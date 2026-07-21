-- BCF-заметки Composer: общий блокнот на модель + обмен по коду (в т.ч. экспертиза).
-- Выполните в Supabase SQL Editor после миграции viewer_usage_events.

create table if not exists public.bcf_notebooks (
  id uuid primary key default gen_random_uuid(),
  share_code text not null unique default lower(encode(gen_random_bytes(4), 'hex')),
  title text not null default 'Заметки',
  owner_id uuid not null references auth.users (id) on delete cascade,
  model_key text not null,
  created_at timestamptz not null default now()
);

create index if not exists bcf_notebooks_owner_model_idx
  on public.bcf_notebooks (owner_id, model_key);

create table if not exists public.bcf_notebook_members (
  notebook_id uuid not null references public.bcf_notebooks (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'editor'
    check (role in ('owner', 'editor', 'expert', 'viewer')),
  joined_at timestamptz not null default now(),
  primary key (notebook_id, user_id)
);

create table if not exists public.bcf_notebook_topics (
  id uuid primary key default gen_random_uuid(),
  notebook_id uuid not null references public.bcf_notebooks (id) on delete cascade,
  topic_guid text not null,
  payload jsonb not null,
  author_id uuid null references auth.users (id) on delete set null,
  author_email text null,
  created_at timestamptz not null default now(),
  unique (notebook_id, topic_guid)
);

create index if not exists bcf_notebook_topics_nb_idx
  on public.bcf_notebook_topics (notebook_id, created_at);

create or replace function public.bcf_is_notebook_member(p_notebook_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.bcf_notebook_members m
    where m.notebook_id = p_notebook_id
      and m.user_id = auth.uid()
  );
$$;

create or replace function public.bcf_notebook_owner_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.bcf_notebook_members (notebook_id, user_id, role)
  values (new.id, new.owner_id, 'owner')
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists bcf_notebooks_add_owner on public.bcf_notebooks;
create trigger bcf_notebooks_add_owner
  after insert on public.bcf_notebooks
  for each row execute function public.bcf_notebook_owner_trigger();

create or replace function public.join_bcf_notebook(p_share_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  nb_id uuid;
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not_authenticated';
  end if;
  select n.id into nb_id
  from public.bcf_notebooks n
  where lower(trim(n.share_code)) = lower(trim(p_share_code));
  if nb_id is null then
    raise exception 'not_found';
  end if;
  insert into public.bcf_notebook_members (notebook_id, user_id, role)
  values (nb_id, uid, 'expert')
  on conflict (notebook_id, user_id) do nothing;
  return nb_id;
end;
$$;

grant execute on function public.join_bcf_notebook(text) to authenticated;

alter table public.bcf_notebooks enable row level security;
alter table public.bcf_notebook_members enable row level security;
alter table public.bcf_notebook_topics enable row level security;

drop policy if exists bcf_notebooks_select on public.bcf_notebooks;
create policy bcf_notebooks_select on public.bcf_notebooks
  for select to authenticated
  using (public.bcf_is_notebook_member(id) or owner_id = auth.uid());

drop policy if exists bcf_notebooks_insert on public.bcf_notebooks;
create policy bcf_notebooks_insert on public.bcf_notebooks
  for insert to authenticated
  with check (owner_id = auth.uid());

drop policy if exists bcf_notebooks_update on public.bcf_notebooks;
create policy bcf_notebooks_update on public.bcf_notebooks
  for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

drop policy if exists bcf_members_select on public.bcf_notebook_members;
create policy bcf_members_select on public.bcf_notebook_members
  for select to authenticated
  using (public.bcf_is_notebook_member(notebook_id));

drop policy if exists bcf_topics_select on public.bcf_notebook_topics;
create policy bcf_topics_select on public.bcf_notebook_topics
  for select to authenticated
  using (public.bcf_is_notebook_member(notebook_id));

drop policy if exists bcf_topics_insert on public.bcf_notebook_topics;
create policy bcf_topics_insert on public.bcf_notebook_topics
  for insert to authenticated
  with check (
    public.bcf_is_notebook_member(notebook_id)
    and exists (
      select 1 from public.bcf_notebook_members m
      where m.notebook_id = notebook_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'editor', 'expert')
    )
  );

drop policy if exists bcf_topics_delete on public.bcf_notebook_topics;
create policy bcf_topics_delete on public.bcf_notebook_topics
  for delete to authenticated
  using (
    author_id = auth.uid()
    or exists (
      select 1 from public.bcf_notebook_members m
      where m.notebook_id = notebook_id
        and m.user_id = auth.uid()
        and m.role = 'owner'
    )
  );

comment on table public.bcf_notebooks is 'Общие BCF-заметки Composer; share_code для экспертизы и коллег';
