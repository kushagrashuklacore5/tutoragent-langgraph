-- Intelligent assessment engine.
-- Items gain review status, provenance and rubric fields (existing items stay approved/educator-authored);
-- assessments, attempts and per-question responses are new. Every table is RLS-forced; students see only
-- their own attempts/responses; educators of the course read them (course_educator_read pattern of 0004).

-- items: new types, AI provenance and review workflow
alter table education_tutor.items drop constraint if exists items_type_check;
alter table education_tutor.items add constraint items_type_check check (type in ('mcq', 'numeric', 'expression', 'short', 'descriptive'));
alter table education_tutor.items drop constraint if exists items_origin_check;
alter table education_tutor.items add constraint items_origin_check check (origin in ('educator', 'ai_verified', 'ai_generated'));
alter table education_tutor.items add column status text not null default 'approved' check (status in ('draft', 'approved'));
alter table education_tutor.items add column learning_objective text not null default '';
alter table education_tutor.items add column cognitive text not null default 'recall' check (cognitive in ('recall', 'understand', 'apply', 'transfer', 'explain'));
-- [{chunkId, documentId, filename, pageStart, pageEnd}] — the material the item was generated from
alter table education_tutor.items add column source_refs jsonb not null default '[]';
-- generator's validation report (checks run, warnings) shown to the reviewing educator
alter table education_tutor.items add column validation jsonb;
alter table education_tutor.items add column approved_by uuid;
alter table education_tutor.items add column approved_at timestamptz;
create index items_status_concept on education_tutor.items (concept_id) where retired_at is null and status = 'approved';

-- revision cards created from assessment mistakes are de-duplicated by their source
alter table education_tutor.cards add column source_ref text;
create unique index cards_user_source on education_tutor.cards (user_id, source_ref) where source_ref is not null;

create table education_tutor.assessments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  course_id uuid not null references education_tutor.courses(id) on delete cascade,
  title text not null check (length(title) between 1 and 200),
  description text not null default '',
  mode text not null default 'practice' check (mode in ('practice', 'exam', 'diagnostic')),
  time_limit_minutes int check (time_limit_minutes between 1 and 600),
  -- { adaptive: bool, sections: [{ title, conceptIds[], count, types[], difficulty: 'adaptive'|'mixed'|'easy'|'hard' }] }
  settings jsonb not null,
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  max_attempts int check (max_attempts between 1 and 50),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create table education_tutor.assessment_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  user_id uuid not null,
  assessment_id uuid not null references education_tutor.assessments(id) on delete cascade,
  course_id uuid not null references education_tutor.courses(id) on delete cascade,
  status text not null default 'in_progress' check (status in ('in_progress', 'grading', 'graded', 'needs_review')),
  -- [{ itemId, section, points }] in served order, fixed at start (evidence-based assembly)
  plan jsonb not null,
  assembly jsonb not null default '{}',
  -- autosaved answers: { itemId: { response, confidence, savedAt } }
  drafts jsonb not null default '{}',
  started_at timestamptz not null default now(),
  deadline_at timestamptz,
  submitted_at timestamptz,
  score numeric,
  max_score numeric,
  summary jsonb
);
create index assessment_attempts_user on education_tutor.assessment_attempts (user_id, assessment_id, started_at desc);
create unique index assessment_attempts_one_open on education_tutor.assessment_attempts (user_id, assessment_id) where status = 'in_progress';

create table education_tutor.assessment_responses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  user_id uuid not null,
  attempt_id uuid not null references education_tutor.assessment_attempts(id) on delete cascade,
  item_id uuid not null references education_tutor.items(id) on delete cascade,
  concept_id uuid not null references education_tutor.concepts(id) on delete cascade,
  item_attempt_id uuid references education_tutor.attempts(id) on delete set null,
  response jsonb,
  confidence text check (confidence in ('sure', 'unsure', 'guess')),
  points numeric not null default 0,
  max_points numeric not null,
  -- auto (deterministic), ai (validated rubric marking), educator (override/review)
  graded_by text not null check (graded_by in ('auto', 'ai', 'educator', 'none')),
  -- criterion marks, feedback, validation and agreement details
  grading jsonb not null default '{}',
  needs_review boolean not null default false,
  review_reason text,
  override jsonb,
  evidence_recorded boolean not null default false,
  created_at timestamptz not null default now(),
  unique (attempt_id, item_id)
);
create index assessment_responses_review on education_tutor.assessment_responses (attempt_id) where needs_review;

do $$
declare t text;
begin
  foreach t in array array['assessments', 'assessment_attempts', 'assessment_responses'] loop
    execute format('alter table education_tutor.%I enable row level security', t);
    execute format('alter table education_tutor.%I force row level security', t);
  end loop;
end $$;

-- assessments: readable by members of the course; written by educators of the course
create policy course_read on education_tutor.assessments for select using (
  tenant_id = platform.current_tenant() and exists (
    select 1 from education_tutor.enrolments e where e.course_id = assessments.course_id and e.user_id = platform.current_user_id()))
;
create policy course_educator_write on education_tutor.assessments for all
  using (tenant_id = platform.current_tenant() and education_tutor.teaches(course_id))
  with check (tenant_id = platform.current_tenant() and education_tutor.teaches(course_id));

-- attempts/responses: the student owns them; educators of the course may read them and resolve reviews
create policy owner_only on education_tutor.assessment_attempts
  using (tenant_id = platform.current_tenant() and user_id = platform.current_user_id())
  with check (tenant_id = platform.current_tenant() and user_id = platform.current_user_id());
create policy course_educator_read on education_tutor.assessment_attempts for select using (tenant_id = platform.current_tenant() and education_tutor.teaches(course_id));
create policy course_educator_review on education_tutor.assessment_attempts for update
  using (tenant_id = platform.current_tenant() and education_tutor.teaches(course_id))
  with check (tenant_id = platform.current_tenant() and education_tutor.teaches(course_id));

create policy owner_only on education_tutor.assessment_responses
  using (tenant_id = platform.current_tenant() and user_id = platform.current_user_id())
  with check (tenant_id = platform.current_tenant() and user_id = platform.current_user_id());
create policy course_educator_read on education_tutor.assessment_responses for select using (
  tenant_id = platform.current_tenant()
  and education_tutor.teaches((select c.course_id from education_tutor.concepts c where c.id = assessment_responses.concept_id)));
create policy course_educator_review on education_tutor.assessment_responses for update
  using (tenant_id = platform.current_tenant() and education_tutor.teaches((select c.course_id from education_tutor.concepts c where c.id = assessment_responses.concept_id)))
  with check (tenant_id = platform.current_tenant() and education_tutor.teaches((select c.course_id from education_tutor.concepts c where c.id = assessment_responses.concept_id)));

-- Evidence on a student's record after an educator resolves a review. Students own their evidence
-- (owner-only RLS), so this narrowly-scoped definer function is the only way an educator's decision
-- reaches it: caller must teach the course, the response must be reviewed (not pending), and evidence
-- is written at most once per response.
create or replace function education_tutor.record_reviewed_evidence(response_id uuid) returns boolean
  language plpgsql security definer set search_path = pg_catalog, platform, education_tutor as $$
declare r record;
begin
  select ar.id, ar.tenant_id, ar.user_id, ar.concept_id, ar.points, ar.max_points, ar.attempt_id, ar.item_id, ar.needs_review, ar.evidence_recorded, c.course_id
    into r from education_tutor.assessment_responses ar join education_tutor.concepts c on c.id = ar.concept_id
   where ar.id = response_id and ar.tenant_id = platform.current_tenant();
  if not found then return false; end if;
  if not education_tutor.teaches(r.course_id) then raise exception 'not an educator of this course' using errcode = '42501'; end if;
  if r.needs_review or r.evidence_recorded or r.max_points <= 0 then return false; end if;
  insert into education_tutor.evidence (tenant_id, user_id, concept_id, kind, outcome, hints_used, source_ref)
    values (r.tenant_id, r.user_id, r.concept_id, 'diagnostic', least(1, greatest(0, r.points / r.max_points)), 0, 'assessment:' || r.attempt_id || ':' || r.item_id);
  update education_tutor.assessment_responses set evidence_recorded = true where id = r.id;
  return true;
end $$;
revoke all on function education_tutor.record_reviewed_evidence(uuid) from public;
grant execute on function education_tutor.record_reviewed_evidence(uuid) to platform_app;
