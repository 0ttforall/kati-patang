-- ============================================================
-- Adobe Express Automator — Supabase schema
-- Paste the whole file into Supabase → SQL Editor → Run.
-- Safe to re-run (uses IF NOT EXISTS / OR REPLACE).
-- ============================================================

create table if not exists accounts (
  id              bigserial primary key,
  email           text not null unique,
  password        text not null,
  status          text not null default 'pending'
                    check (status in ('pending', 'claimed', 'done', 'failed')),
  claimed_by      uuid references auth.users(id) on delete set null,
  claimed_at      timestamptz,
  completed_at    timestamptz,
  attempts        int not null default 0,
  duration_seconds numeric,
  failure_stage   text,
  last_error      text,
  created_at      timestamptz not null default now()
);

create index if not exists accounts_status_claim_idx on accounts (status, claimed_at);
create index if not exists accounts_claimed_by_idx   on accounts (claimed_by);

-- ============================================================
-- claim_next_account: atomic claim with stale-TTL recovery AND
-- bounded retry on failed rows.
--
-- A row is eligible if any of:
--   - status = 'pending'                          (never tried)
--   - status = 'failed'  and attempts < max_attempts  (transient fail)
--   - status = 'claimed' and claimed_at older than stale_minutes
--                                                 (worker crashed)
--
-- Rows that fail max_attempts times are parked in 'failed' for
-- human review (check last_error / failure_stage). Bump max_attempts
-- or reset rows manually if you want them retried again.
-- ============================================================
create or replace function claim_next_account()
returns accounts
language plpgsql
security definer
set search_path = public
as $$
declare
  result accounts;
  stale_minutes constant int := 5;
  max_attempts  constant int := 5;
begin
  if auth.uid() is null then
    raise exception 'must be authenticated';
  end if;

  update accounts
  set    status     = 'claimed',
         claimed_by = auth.uid(),
         claimed_at = now(),
         attempts   = attempts + 1
  where  id = (
    select id from accounts
    where  status = 'pending'
       or (status = 'failed'  and attempts < max_attempts)
       or (status = 'claimed' and claimed_at < now() - (stale_minutes || ' minutes')::interval)
    order  by claimed_at nulls first, created_at
    limit  1
    for update skip locked
  )
  returning * into result;

  return result;
end;
$$;

create or replace function mark_account_done(p_id bigint, p_duration numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'must be authenticated';
  end if;

  update accounts
  set    status           = 'done',
         completed_at     = now(),
         duration_seconds = p_duration,
         last_error       = null,
         failure_stage    = null
  where  id = p_id and claimed_by = auth.uid();
end;
$$;

create or replace function mark_account_failed(
  p_id bigint,
  p_stage text,
  p_error text,
  p_duration numeric
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'must be authenticated';
  end if;

  -- Only transition from 'claimed' to 'failed'. Never overwrite a row
  -- that already reached 'done' — a stale worker context after logout
  -- redirect can otherwise clobber a successful run.
  update accounts
  set    status           = 'failed',
         completed_at     = now(),
         failure_stage    = p_stage,
         last_error       = p_error,
         duration_seconds = p_duration
  where  id = p_id and claimed_by = auth.uid() and status = 'claimed';
end;
$$;

-- ============================================================
-- Row-Level Security
-- Authenticated workers can READ all rows (so the panel can
-- show live totals) but cannot directly INSERT/UPDATE/DELETE.
-- All writes go through the SECURITY DEFINER functions above.
-- ============================================================
alter table accounts enable row level security;

drop policy if exists "auth read accounts" on accounts;
create policy "auth read accounts"
  on accounts for select
  to authenticated
  using (true);

-- ============================================================
-- Per-worker stats view
-- ============================================================
create or replace view worker_stats as
select
  u.id                                              as user_id,
  u.email                                           as user_email,
  count(*) filter (where a.status = 'done')         as completed,
  count(*) filter (where a.status = 'failed')       as failed,
  count(*) filter (where a.status = 'claimed')      as in_progress,
  sum(a.duration_seconds) filter (where a.status = 'done') as total_seconds
from   auth.users u
left join accounts a on a.claimed_by = u.id
group by u.id, u.email;

grant select  on worker_stats to authenticated;
grant execute on function claim_next_account()                                 to authenticated;
grant execute on function mark_account_done(bigint, numeric)                   to authenticated;
grant execute on function mark_account_failed(bigint, text, text, numeric)     to authenticated;

-- ============================================================
-- Admin convenience: load accounts.csv into this table.
-- After uploading via Supabase Studio's Table editor → Import,
-- or run something like:
--
--   insert into accounts (email, password) values
--     ('vivan11372@nv.aeedu.in', 'stud@2025'),
--     ('another@nv.aeedu.in',    'stud@2025');
--
-- To recycle failed rows for another pass:
--   update accounts set status='pending', claimed_by=null,
--          claimed_at=null, attempts=0 where status='failed';
-- ============================================================
