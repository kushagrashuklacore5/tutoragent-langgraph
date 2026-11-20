-- Personal (self-study) courses: a student can study ANY subject or skill. The universal agent drafts a structured
-- syllabus with AI; the course belongs to that student (owner_user_id), who is its only student. Practice items for
-- it are AI-generated and only stored when automatic checks pass (origin 'ai_verified').
alter table education_tutor.courses add column if not exists owner_user_id uuid;
create index if not exists courses_owner on education_tutor.courses (tenant_id, owner_user_id) where owner_user_id is not null;

-- the owner may write items of their own personal course (staff_write still covers educators)
create policy owner_course_items on education_tutor.items for all
  using (tenant_id = platform.current_tenant() and exists (select 1 from education_tutor.courses c where c.id = course_id and c.owner_user_id = platform.current_user_id()))
  with check (tenant_id = platform.current_tenant() and exists (select 1 from education_tutor.courses c where c.id = course_id and c.owner_user_id = platform.current_user_id()));

-- create the course, enrol the caller as its student, add the topics (with prerequisite edges by index)
create or replace function education_tutor.create_personal_course(p_title text, p_topics jsonb, p_language text default 'en')
returns uuid language plpgsql security definer set search_path = education_tutor, platform, pg_temp as $$
declare cid uuid := gen_random_uuid(); uid uuid := platform.current_user_id(); tid uuid := platform.current_tenant();
        ids uuid[] := '{}'; v uuid; t jsonb; i int := 0; pre jsonb; n int;
begin
  if uid is null or tid is null then raise exception 'no principal' using errcode = '42501'; end if;
  select count(*) into n from education_tutor.courses where tenant_id = tid and owner_user_id = uid;
  if n >= 20 then raise exception 'too many personal courses' using errcode = '54000'; end if;
  if jsonb_array_length(p_topics) < 1 or jsonb_array_length(p_topics) > 20 then raise exception 'invalid topics' using errcode = '22023'; end if;
  insert into education_tutor.courses (id, tenant_id, code, title, created_by, owner_user_id, languages)
    values (cid, tid, 'MY-' || upper(substr(replace(cid::text, '-', ''), 1, 6)), left(p_title, 160), uid, uid, array[coalesce(p_language, 'en')]);
  insert into education_tutor.enrolments (tenant_id, course_id, user_id, role) values (tid, cid, uid, 'student');
  for t in select * from jsonb_array_elements(p_topics) loop
    i := i + 1;
    insert into education_tutor.concepts (tenant_id, course_id, name, description, est_minutes, status)
      values (tid, cid, left(t->>'name', 160), left(coalesce(t->>'description', ''), 600), greatest(10, least(600, coalesce((t->>'estMinutes')::int, 45))), 'approved') returning id into v;
    ids := ids || v;
  end loop;
  i := 0;
  for t in select * from jsonb_array_elements(p_topics) loop
    i := i + 1;
    for pre in select * from jsonb_array_elements(coalesce(t->'prerequisites', '[]'::jsonb)) loop
      if jsonb_typeof(pre) = 'number' and (pre::text)::int between 1 and i - 1 then
        insert into education_tutor.concept_edges (tenant_id, from_concept, to_concept) values (tid, ids[(pre::text)::int], ids[i]) on conflict do nothing;
      end if;
    end loop;
  end loop;
  return cid;
end $$;
grant execute on function education_tutor.create_personal_course(text, jsonb, text) to platform_app;
