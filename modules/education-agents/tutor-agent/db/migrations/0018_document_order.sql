-- Document courses keep the document's order: consecutive sections are linked as prerequisites.
create or replace function education_tutor.set_personal_course_topics(p_course uuid, p_title text, p_topics jsonb)
returns int language plpgsql security definer set search_path = education_tutor, platform, pg_temp as $$
declare uid uuid := platform.current_user_id(); tid uuid := platform.current_tenant(); t jsonb; n int := 0; v uuid; prev uuid := null;
begin
  if not exists (select 1 from education_tutor.courses c where c.id = p_course and c.tenant_id = tid and c.owner_user_id = uid) then
    raise exception 'not your personal course' using errcode = '42501';
  end if;
  if exists (select 1 from education_tutor.attempts a join education_tutor.items i on i.id = a.item_id where i.course_id = p_course) then
    raise exception 'course already has practice history' using errcode = '55000';
  end if;
  if jsonb_array_length(p_topics) < 1 or jsonb_array_length(p_topics) > 20 then raise exception 'invalid topics' using errcode = '22023'; end if;
  delete from education_tutor.concepts where course_id = p_course;
  update education_tutor.courses set title = left(p_title, 160) where id = p_course;
  for t in select * from jsonb_array_elements(p_topics) loop
    insert into education_tutor.concepts (tenant_id, course_id, name, description, est_minutes, status)
      values (tid, p_course, left(t->>'name', 160), left(coalesce(t->>'description', ''), 600), greatest(10, least(600, coalesce((t->>'estMinutes')::int, 30))), 'approved') returning id into v;
    -- the document's order is the learning order: each section builds on the one before it
    if prev is not null then insert into education_tutor.concept_edges (tenant_id, from_concept, to_concept) values (tid, prev, v) on conflict do nothing; end if;
    prev := v;
    n := n + 1;
  end loop;
  return n;
end $$;
grant execute on function education_tutor.set_personal_course_topics(uuid, text, jsonb) to platform_app;
