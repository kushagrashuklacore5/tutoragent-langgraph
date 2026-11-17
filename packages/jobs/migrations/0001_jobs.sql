create table platform.jobs (
  id uuid primary key,
  tenant_id uuid references platform.tenants(id) on delete cascade,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'dead')),
  attempts int not null default 0,
  max_attempts int not null default 5 check (max_attempts between 1 and 50),
  run_at timestamptz not null default now(),
  locked_by text,
  locked_until timestamptz,
  idempotency_key text,
  last_error text,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
create unique index jobs_idempotency on platform.jobs(type, idempotency_key) where idempotency_key is not null;
create index jobs_ready on platform.jobs(run_at) where status = 'queued';
create index jobs_leases on platform.jobs(locked_until) where status = 'running';

-- Effects ledger: lets a handler perform a side effect exactly once even if the job is re-run
-- after a crash (see JobContext.once).
create table platform.job_effects (
  job_id uuid not null references platform.jobs(id) on delete cascade,
  effect_key text not null,
  created_at timestamptz not null default now(),
  primary key (job_id, effect_key)
);

alter table platform.jobs enable row level security;
alter table platform.jobs force row level security;
-- tenants may enqueue and read their own jobs; the worker uses the system role
create policy tenant_jobs on platform.jobs
  using (tenant_id = platform.current_tenant()) with check (tenant_id = platform.current_tenant());

alter table platform.job_effects enable row level security;
alter table platform.job_effects force row level security;
create policy via_job on platform.job_effects using (
  exists (select 1 from platform.jobs j where j.id = job_effects.job_id and j.tenant_id = platform.current_tenant())
);
