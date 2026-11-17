-- Tutor Agent schema (modules/education-agents/tutor-agent/docs/DATA_MODEL.md).
-- Course content: readable within the tenant, writable by educators/tenant admins.
-- Learner data: readable and writable ONLY by the student it belongs to (educators get aggregates later, min group 10).

create table education_tutor.courses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  code text not null,
  title text not null,
  term text,
  integrity_mode text not null default 'guided' check (integrity_mode in ('open', 'guided', 'hint_only')),
  languages text[] not null default '{en}',
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, code)
);

create table education_tutor.enrolments (
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  course_id uuid not null references education_tutor.courses(id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('student', 'educator')),
  primary key (course_id, user_id)
);

create table education_tutor.concepts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  course_id uuid not null references education_tutor.courses(id) on delete cascade,
  name text not null,
  description text not null default '',
  est_minutes int not null default 60 check (est_minutes between 5 and 1200),
  exam_weight numeric not null default 1 check (exam_weight > 0),
  status text not null default 'draft' check (status in ('draft', 'approved')),
  created_at timestamptz not null default now()
);

-- from_concept is a prerequisite of to_concept
create table education_tutor.concept_edges (
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  from_concept uuid not null references education_tutor.concepts(id) on delete cascade,
  to_concept uuid not null references education_tutor.concepts(id) on delete cascade,
  primary key (from_concept, to_concept),
  check (from_concept <> to_concept)
);

create table education_tutor.misconceptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  concept_id uuid not null references education_tutor.concepts(id) on delete cascade,
  description text not null,
  refutation text not null
);

create table education_tutor.items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  course_id uuid not null references education_tutor.courses(id) on delete cascade,
  concept_id uuid not null references education_tutor.concepts(id) on delete cascade,
  type text not null check (type in ('mcq', 'numeric')),
  stem text not null,
  answer_spec jsonb not null,
  explanation text not null default '',
  origin text not null default 'educator' check (origin in ('educator', 'ai_verified')),
  difficulty numeric not null default 0.5 check (difficulty between 0 and 1),
  created_at timestamptz not null default now()
);

create table education_tutor.attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  user_id uuid not null,
  item_id uuid not null references education_tutor.items(id) on delete cascade,
  response jsonb not null,
  outcome numeric not null,
  confidence text check (confidence in ('sure', 'unsure', 'guess')),
  hints_used int not null default 0,
  created_at timestamptz not null default now()
);

create table education_tutor.evidence (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  user_id uuid not null,
  concept_id uuid not null references education_tutor.concepts(id) on delete cascade,
  kind text not null check (kind in ('practice', 'check', 'teach_back', 'diagnostic', 'delayed_check', 'self_report')),
  outcome numeric not null check (outcome between 0 and 1),
  hints_used int not null default 0,
  source_ref text,
  observed_at timestamptz not null default now()
);
create index evidence_user_concept on education_tutor.evidence (user_id, concept_id, observed_at);

create table education_tutor.cards (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  user_id uuid not null,
  course_id uuid not null references education_tutor.courses(id) on delete cascade,
  concept_id uuid references education_tutor.concepts(id) on delete set null,
  front text not null,
  back text not null,
  stability float8 not null default 0,
  difficulty float8 not null default 0,
  reps int not null default 0,
  lapses int not null default 0,
  last_review timestamptz,
  due_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index cards_due on education_tutor.cards (user_id, due_at);

create table education_tutor.goals (
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  user_id uuid not null,
  course_id uuid not null references education_tutor.courses(id) on delete cascade,
  exam_at date,
  daily_minutes int not null check (daily_minutes between 10 and 600),
  primary key (user_id, course_id)
);

create table education_tutor.plans (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  user_id uuid not null,
  course_id uuid not null references education_tutor.courses(id) on delete cascade,
  version int not null,
  plan jsonb not null,
  created_at timestamptz not null default now(),
  unique (user_id, course_id, version)
);

create table education_tutor.sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  user_id uuid not null,
  course_id uuid not null references education_tutor.courses(id) on delete cascade,
  concept_id uuid references education_tutor.concepts(id) on delete set null,
  problem text,
  graded boolean not null default false,
  language text not null default 'en' check (language in ('en', 'hi', 'hinglish')),
  state jsonb not null,
  created_at timestamptz not null default now()
);

create table education_tutor.turns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  user_id uuid not null,
  session_id uuid not null references education_tutor.sessions(id) on delete cascade,
  role text not null check (role in ('student', 'tutor')),
  content text not null,
  segments jsonb,
  move text,
  hint_level int,
  operation_id uuid,
  created_at timestamptz not null default now()
);

-- RLS
do $$
declare t text;
begin
  -- course content: tenant-readable, educator/admin-writable
  foreach t in array array['courses','concepts','concept_edges','misconceptions','items','enrolments'] loop
    execute format('alter table education_tutor.%I enable row level security', t);
    execute format('alter table education_tutor.%I force row level security', t);
    execute format($p$create policy tenant_read on education_tutor.%I for select using (tenant_id = platform.current_tenant())$p$, t);
    execute format($p$create policy staff_write on education_tutor.%I for all using (tenant_id = platform.current_tenant() and (platform.has_role('educator') or platform.has_role('tenant_admin'))) with check (tenant_id = platform.current_tenant() and (platform.has_role('educator') or platform.has_role('tenant_admin')))$p$, t);
  end loop;
  -- learner data: owner only
  foreach t in array array['attempts','evidence','cards','goals','plans','sessions','turns'] loop
    execute format('alter table education_tutor.%I enable row level security', t);
    execute format('alter table education_tutor.%I force row level security', t);
    execute format($p$create policy owner_only on education_tutor.%I using (tenant_id = platform.current_tenant() and user_id = platform.current_user_id()) with check (tenant_id = platform.current_tenant() and user_id = platform.current_user_id())$p$, t);
  end loop;
end $$;
