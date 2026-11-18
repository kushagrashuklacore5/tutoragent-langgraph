-- Stage 3: student self-tests on the assessment engine, exam intelligence (past papers and their questions),
-- server-side hint ladder usage, growth preferences (opt-in leaderboard, outcome consent) and chapter packages.

-- self-tests: assessments a STUDENT creates for themself (diagnostic, practice papers, mocks, post-tests).
-- Other students never see them; educators of the course can (they settle written marks that need review).
alter table education_tutor.assessments add column owner_user_id uuid;
alter table education_tutor.assessments add column purpose text check (purpose in ('diagnostic', 'practice', 'mock', 'post', 'pattern_practice'));
drop policy course_read on education_tutor.assessments;
create policy course_read on education_tutor.assessments for select using (
  tenant_id = platform.current_tenant()
  and (owner_user_id is null or owner_user_id = platform.current_user_id())
  and exists (select 1 from education_tutor.enrolments e where e.course_id = assessments.course_id and e.user_id = platform.current_user_id()));
create policy self_owner on education_tutor.assessments for all
  using (tenant_id = platform.current_tenant() and owner_user_id = platform.current_user_id())
  with check (tenant_id = platform.current_tenant() and owner_user_id = platform.current_user_id() and created_by = platform.current_user_id()
    and exists (select 1 from education_tutor.enrolments e where e.course_id = assessments.course_id and e.user_id = platform.current_user_id() and e.role = 'student'));
create index assessments_owner on education_tutor.assessments (owner_user_id) where owner_user_id is not null;

-- exam intelligence: papers (a document from the existing pipeline + provenance) and the questions extracted from them
create table education_tutor.exam_papers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  course_id uuid not null references education_tutor.courses(id) on delete cascade,
  -- null: shared by an educator with the course; otherwise private to the student who added it
  owner_user_id uuid,
  added_by uuid not null,
  document_id uuid not null,
  source_kind text not null check (source_kind in ('board_past_paper', 'board_sample_paper', 'school_paper', 'textbook_exercise', 'other')),
  board text check (length(board) <= 80),
  school text check (length(school) <= 160),
  year int check (year between 1990 and 2100),
  title text not null check (length(title) between 1 and 200),
  status text not null default 'pending' check (status in ('pending', 'extracting', 'ready', 'failed')),
  error text,
  questions int not null default 0,
  created_at timestamptz not null default now(),
  unique (course_id, document_id)
);
create table education_tutor.exam_questions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  paper_id uuid not null references education_tutor.exam_papers(id) on delete cascade,
  course_id uuid not null references education_tutor.courses(id) on delete cascade,
  owner_user_id uuid,
  concept_id uuid references education_tutor.concepts(id) on delete set null,
  number text not null check (length(number) <= 20),
  marks numeric check (marks >= 0 and marks <= 100),
  qtype text not null check (qtype in ('mcq', 'very_short', 'short', 'long', 'numerical', 'case_based', 'diagram', 'assertion_reason', 'other')),
  features text[] not null default '{}',
  page int,
  text_enc text not null,
  created_at timestamptz not null default now()
);
create index exam_questions_paper on education_tutor.exam_questions (paper_id);

-- hint ladder: the highest hint level the student has seen per item (server-side truth for hints_used)
create table education_tutor.hint_usage (
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  user_id uuid not null,
  item_id uuid not null references education_tutor.items(id) on delete cascade,
  max_level int not null check (max_level between 1 and 6),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id, item_id)
);

-- growth: opt-in leaderboard (pseudonymous, improvement-based) and consent for cohort outcome analytics
create table education_tutor.growth_prefs (
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  user_id uuid not null,
  leaderboard boolean not null default false,
  pseudonym text check (length(pseudonym) between 2 and 40),
  outcomes_consent boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

-- chapter learning packages (versioned, encrypted)
create table education_tutor.chapter_packages (
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  user_id uuid not null,
  book_id uuid not null references education_tutor.studio_books(id) on delete cascade,
  version int not null,
  doc_enc text not null,
  created_at timestamptz not null default now(),
  primary key (book_id, version)
);

do $$
declare t text;
begin
  foreach t in array array['hint_usage','growth_prefs','chapter_packages'] loop
    execute format('alter table education_tutor.%I enable row level security', t);
    execute format('alter table education_tutor.%I force row level security', t);
    execute format($p$create policy owner_only on education_tutor.%I using (tenant_id = platform.current_tenant() and user_id = platform.current_user_id()) with check (tenant_id = platform.current_tenant() and user_id = platform.current_user_id())$p$, t);
  end loop;
  foreach t in array array['exam_papers','exam_questions'] loop
    execute format('alter table education_tutor.%I enable row level security', t);
    execute format('alter table education_tutor.%I force row level security', t);
    -- private papers: their owner; shared papers: members of the course; writes: the owner, or an educator for shared ones
    execute format($p$create policy paper_read on education_tutor.%I for select using (tenant_id = platform.current_tenant() and (owner_user_id = platform.current_user_id()
      or (owner_user_id is null and exists (select 1 from education_tutor.enrolments e where e.course_id = %I.course_id and e.user_id = platform.current_user_id()))))$p$, t, t);
    execute format($p$create policy paper_write on education_tutor.%I for all using (tenant_id = platform.current_tenant() and (owner_user_id = platform.current_user_id() or (owner_user_id is null and education_tutor.teaches(course_id))))
      with check (tenant_id = platform.current_tenant() and (owner_user_id = platform.current_user_id() or (owner_user_id is null and education_tutor.teaches(course_id))))$p$, t);
  end loop;
end $$;

-- cohort outcome analytics for educators: aggregates only, consenting students only, never fewer than 5
create or replace function education_tutor.cohort_outcomes(p_course uuid, min_group int default 5)
returns table (students int, diagnostic_avg numeric, post_avg numeric, delayed_avg numeric)
language plpgsql security definer set search_path = education_tutor, platform, pg_temp as $$
declare n int;
begin
  if not education_tutor.teaches(p_course) then raise exception 'not an educator of this course' using errcode = '42501'; end if;
  select count(distinct g.user_id) into n from education_tutor.growth_prefs g
    join education_tutor.enrolments e on e.user_id = g.user_id and e.course_id = p_course and e.role = 'student'
   where g.tenant_id = platform.current_tenant() and g.outcomes_consent;
  if n < greatest(min_group, 5) then return query select n, null::numeric, null::numeric, null::numeric; return; end if;
  return query
  with consenting as (
    select g.user_id from education_tutor.growth_prefs g join education_tutor.enrolments e on e.user_id = g.user_id and e.course_id = p_course and e.role = 'student'
     where g.tenant_id = platform.current_tenant() and g.outcomes_consent),
  firsts as (
    select distinct on (x.user_id, a.purpose) x.user_id, a.purpose, x.score / nullif(x.max_score, 0) as frac
      from education_tutor.assessment_attempts x join education_tutor.assessments a on a.id = x.assessment_id
     where x.course_id = p_course and x.status = 'graded' and a.purpose in ('diagnostic', 'post') and x.user_id in (select user_id from consenting)
     order by x.user_id, a.purpose, x.submitted_at),
  delayed as (
    select ev.user_id, avg(ev.outcome) as frac from education_tutor.evidence ev join education_tutor.concepts c on c.id = ev.concept_id
     where c.course_id = p_course and ev.kind = 'delayed_check' and ev.user_id in (select user_id from consenting) group by ev.user_id)
  select n, round(avg(frac) filter (where purpose = 'diagnostic')::numeric, 3), round(avg(frac) filter (where purpose = 'post')::numeric, 3), (select round(avg(frac)::numeric, 3) from delayed)
    from firsts;
end $$;
grant execute on function education_tutor.cohort_outcomes(uuid, int) to platform_app;

-- opt-in leaderboard: pseudonyms and IMPROVEMENT points only (gains over each student's own previous best),
-- visible only to participants and only when at least 5 students of the course have opted in
create or replace function education_tutor.improvement_board(p_course uuid)
returns table (pseudonym text, points int, me boolean)
language plpgsql stable security definer set search_path = education_tutor, platform, pg_temp as $$
declare n int;
begin
  if not exists (select 1 from education_tutor.growth_prefs g where g.tenant_id = platform.current_tenant() and g.user_id = platform.current_user_id() and g.leaderboard) then return; end if;
  if not exists (select 1 from education_tutor.enrolments e where e.course_id = p_course and e.user_id = platform.current_user_id()) then return; end if;
  select count(*) into n from education_tutor.growth_prefs g join education_tutor.enrolments e on e.user_id = g.user_id and e.course_id = p_course and e.role = 'student'
   where g.tenant_id = platform.current_tenant() and g.leaderboard and g.pseudonym is not null;
  if n < 5 then return; end if;
  return query
  with opted as (
    select g.user_id, g.pseudonym from education_tutor.growth_prefs g join education_tutor.enrolments e on e.user_id = g.user_id and e.course_id = p_course and e.role = 'student'
     where g.tenant_id = platform.current_tenant() and g.leaderboard and g.pseudonym is not null),
  scored as (
    select x.user_id, x.score / nullif(x.max_score, 0) as f,
           max(x.score / nullif(x.max_score, 0)) over (partition by x.user_id, x.assessment_id order by x.submitted_at rows between unbounded preceding and 1 preceding) as prev_best
      from education_tutor.assessment_attempts x where x.course_id = p_course and x.status = 'graded' and x.user_id in (select user_id from opted))
  select o.pseudonym, coalesce(round(sum(greatest(0, s.f - s.prev_best)) * 100)::int, 0), o.user_id = platform.current_user_id()
    from opted o left join scored s on s.user_id = o.user_id and s.prev_best is not null
   group by o.user_id, o.pseudonym;
end $$;
grant execute on function education_tutor.improvement_board(uuid) to platform_app;
