-- On-demand practice questions (decision: AI questions reach students after AUTOMATIC checks; teacher approval is
-- optional — educators can retire any of them). The app validates each item (key checks / maths engine) before
-- calling this; the function only lets an ENROLLED student add a few items to an APPROVED topic of their course.
create or replace function education_tutor.add_verified_practice(p_course uuid, p_concept uuid, p_items jsonb)
returns int language plpgsql security definer set search_path = education_tutor, platform, pg_temp as $$
declare it jsonb; n int := 0; existing int;
begin
  if not exists (select 1 from education_tutor.enrolments e where e.course_id = p_course and e.user_id = platform.current_user_id() and e.tenant_id = platform.current_tenant()) then
    raise exception 'not enrolled' using errcode = '42501';
  end if;
  if not exists (select 1 from education_tutor.concepts c where c.id = p_concept and c.course_id = p_course and c.status = 'approved') then
    raise exception 'unknown topic' using errcode = '22023';
  end if;
  select count(*) into existing from education_tutor.items where concept_id = p_concept and origin = 'ai_verified';
  if existing >= 40 or jsonb_array_length(p_items) > 8 then return 0; end if;
  for it in select * from jsonb_array_elements(p_items) loop
    if it->>'type' not in ('mcq', 'numeric') then continue; end if;
    insert into education_tutor.items (tenant_id, course_id, concept_id, type, stem, answer_spec, explanation, difficulty, origin, status, validation)
    values (platform.current_tenant(), p_course, p_concept, it->>'type', left(it->>'stem', 2000), it->'answerSpec', left(it->>'explanation', 2000),
            greatest(0, least(1, coalesce((it->>'difficulty')::numeric, 0.5))), 'ai_verified', 'approved', it->'validation');
    n := n + 1;
  end loop;
  return n;
end $$;
grant execute on function education_tutor.add_verified_practice(uuid, uuid, jsonb) to platform_app;
