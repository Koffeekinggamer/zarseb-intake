-- Harden the ZarSeb intake backend (public.website_intake + list_website_intake).
-- NOTE: this lives in the Stride League production project (qtiydawnegefsjgndqga).
-- Scope: ONLY public.website_intake, public/private.list_website_intake,
-- private.intake_config, and new private.website_intake_* objects.
-- No existing rows in public.website_intake are modified or deleted.
-- Applied as a single migration (one transaction).

-- ---------------------------------------------------------------------------
-- (a) Size caps. A fully filled form is ~5-20 KB; the cap leaves >3x margin.
-- Replaces the old 200 KB check.
-- ---------------------------------------------------------------------------
alter table public.website_intake drop constraint if exists website_intake_answers_size;
alter table public.website_intake
  add constraint website_intake_answers_size check (octet_length(answers::text) <= 65536),
  add constraint website_intake_client_name_len check (client_name is null or char_length(client_name) <= 300),
  add constraint website_intake_source_len check (char_length(source) <= 40),
  add constraint website_intake_user_agent_len check (user_agent is null or char_length(user_agent) <= 512);

-- ---------------------------------------------------------------------------
-- (b) Insert throttle: max 20 rows per 10 minutes overall, max 50 per 24 h
-- for the form. The table holds a single form (rachel-schwartz) and has no
-- slug column, so the daily cap is per table == per form today.
-- created_at is forced to now() by website_intake_force_defaults (fires first,
-- triggers run in name order), so clients cannot backdate rows to dodge this.
-- ---------------------------------------------------------------------------
create or replace function private.website_intake_throttle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  recent_10m int;
  recent_24h int;
begin
  -- Serialize concurrent inserts so the counts are exact. Two-int key space
  -- is separate from the bigint advisory locks Stride League uses.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('zarseb_website_intake'), 1);

  select count(*) filter (where w.created_at > pg_catalog.now() - interval '10 minutes'),
         count(*)
    into recent_10m, recent_24h
    from public.website_intake w
   where w.created_at > pg_catalog.now() - interval '24 hours';

  if recent_10m >= 20 then
    raise exception 'too many submissions, try again later' using errcode = 'P0001';
  end if;
  if recent_24h >= 50 then
    raise exception 'daily submission limit reached, try again later' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function private.website_intake_throttle() from public, anon, authenticated;

drop trigger if exists website_intake_throttle on public.website_intake;
create trigger website_intake_throttle
  before insert on public.website_intake
  for each row execute function private.website_intake_throttle();

-- Pin search_path on the existing defaults trigger function too.
create or replace function private.website_intake_force_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.id := gen_random_uuid();
  new.created_at := pg_catalog.now();
  return new;
end;
$$;
revoke all on function private.website_intake_force_defaults() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- (c) anon: INSERT only (column-level, as before), nothing else. RLS on+forced.
-- ---------------------------------------------------------------------------
alter table public.website_intake enable row level security;
alter table public.website_intake force row level security;
revoke all on table public.website_intake from public, anon, authenticated;
grant insert (client_name, answers, source, is_test, user_agent) on public.website_intake to anon;
drop policy if exists website_intake_anon_insert on public.website_intake;
create policy website_intake_anon_insert on public.website_intake
  for insert to anon with check (true);

-- ---------------------------------------------------------------------------
-- (d) Viewer secret: store only a SHA-256 digest, constant-time compare,
-- failed-attempt lockout (5 failures in 15 min -> locked 15 min).
-- ---------------------------------------------------------------------------
create table if not exists private.website_intake_secret (
  id         smallint primary key default 1 check (id = 1),
  digest     bytea not null check (octet_length(digest) = 32),
  updated_at timestamptz not null default now()
);
create table if not exists private.website_intake_auth_attempts (
  id           bigint generated always as identity primary key,
  attempted_at timestamptz not null default now()
);
create index if not exists website_intake_auth_attempts_at_idx
  on private.website_intake_auth_attempts (attempted_at);
create table if not exists private.website_intake_auth_lock (
  id           smallint primary key default 1 check (id = 1),
  locked_until timestamptz not null default '-infinity'
);
insert into private.website_intake_auth_lock (id) values (1) on conflict (id) do nothing;

alter table private.website_intake_secret enable row level security;
alter table private.website_intake_auth_attempts enable row level security;
alter table private.website_intake_auth_lock enable row level security;
revoke all on table private.website_intake_secret, private.website_intake_auth_attempts,
  private.website_intake_auth_lock from public, anon, authenticated;

-- Move the existing secret to a digest, then drop the plaintext copy.
insert into private.website_intake_secret (id, digest)
select 1, pg_catalog.sha256(pg_catalog.convert_to(c.value, 'UTF8'))
  from private.intake_config c
 where c.key = 'view_secret'
on conflict (id) do update set digest = excluded.digest, updated_at = now();

do $$
begin
  if not exists (select 1 from private.website_intake_secret where id = 1) then
    raise exception 'no viewer secret digest stored; aborting';
  end if;
end $$;

delete from private.intake_config where key = 'view_secret';

create or replace function private.list_website_intake(p_secret text)
returns setof public.website_intake
language plpgsql
security definer
set search_path = ''
as $$
declare
  expected bytea;
  provided bytea;
  diff     int := 0;
  fails    int;
  lock_ts  timestamptz;
begin
  -- Serialize checks so the attempt counter cannot be raced.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('zarseb_website_intake'), 2);

  select l.locked_until into lock_ts from private.website_intake_auth_lock l where l.id = 1;
  if lock_ts is not null and lock_ts > pg_catalog.now() then
    raise exception 'too many failed attempts, try again later' using errcode = '42501';
  end if;

  select s.digest into expected from private.website_intake_secret s where s.id = 1;
  if p_secret is not null and pg_catalog.octet_length(p_secret) <= 1024 then
    provided := pg_catalog.sha256(pg_catalog.convert_to(p_secret, 'UTF8'));
  end if;

  if expected is null or provided is null then
    diff := 1;
  else
    -- Constant-time comparison over the fixed 32-byte digests.
    for i in 0..31 loop
      diff := diff | (pg_catalog.get_byte(expected, i) # pg_catalog.get_byte(provided, i));
    end loop;
  end if;

  if diff <> 0 then
    -- Record the failure and return an HTTP 401 WITHOUT raising, so the
    -- attempt row is committed (a raise would roll it back).
    delete from private.website_intake_auth_attempts a
     where a.attempted_at < pg_catalog.now() - interval '1 day';
    insert into private.website_intake_auth_attempts default values;
    select count(*) into fails from private.website_intake_auth_attempts a
     where a.attempted_at > pg_catalog.now() - interval '15 minutes';
    if fails >= 5 then
      update private.website_intake_auth_lock
         set locked_until = pg_catalog.now() + interval '15 minutes'
       where id = 1;
    end if;
    perform pg_catalog.set_config('response.status', '401', true);
    return;
  end if;

  return query
    select w.* from public.website_intake w order by w.created_at desc;
end;
$$;
revoke all on function private.list_website_intake(text) from public, anon, authenticated;

-- Public wrapper: same signature and return type as before.
create or replace function public.list_website_intake(p_secret text)
returns setof public.website_intake
language sql
security definer
set search_path = ''
as $$
  select * from private.list_website_intake(p_secret);
$$;
revoke all on function public.list_website_intake(text) from public, authenticated;
grant execute on function public.list_website_intake(text) to anon, service_role;
