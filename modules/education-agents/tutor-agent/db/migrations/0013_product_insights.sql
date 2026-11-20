-- Developer product intelligence: tenant-wide AGGREGATES of how the learning system behaves (tool failures,
-- where conversations stall, quick-check outcomes, AI errors). Counts only: no ids, no text, and any row
-- describing fewer than 5 distinct students is suppressed. Callers are gated by the tenant_admin-only route.
create or replace function education_tutor.product_signals(p_days int default 30)
returns table (area text, key text, events bigint, failures bigint, users bigint)
language sql stable security definer set search_path = education_tutor, platform, pg_temp as $$
  with since as (select now() - make_interval(days => greatest(1, least(p_days, 365))) as t),
  rows as (
    select 'tool'::text as area, c.tool as key, count(*) as events, count(*) filter (where c.status <> 'ok') as failures, count(distinct c.user_id) as users
      from education_tutor.agent_tool_calls c, since where c.tenant_id = platform.current_tenant() and c.created_at >= since.t group by c.tool
    union all
    -- conversations whose last activity was > 2 days ago, by the phase they stopped in
    select 'stalled', coalesce(v.state->>'phase', 'unknown'), count(*), count(*), count(distinct v.user_id)
      from education_tutor.agent_conversations v, since
     where v.tenant_id = platform.current_tenant() and v.updated_at >= since.t and v.updated_at < now() - interval '2 days'
     group by v.state->>'phase'
    union all
    select 'conversations', 'all', count(*), 0, count(distinct v.user_id)
      from education_tutor.agent_conversations v, since where v.tenant_id = platform.current_tenant() and v.updated_at >= since.t
    union all
    select 'studio', e.kind, count(*), count(*) filter (where e.kind = 'activity' and e.detail->>'verdict' is distinct from 'correct'), count(distinct e.user_id)
      from education_tutor.studio_events e, since where e.tenant_id = platform.current_tenant() and e.created_at >= since.t group by e.kind
    union all
    select 'ai', o.task_id, count(*), count(*) filter (where o.status = 'error'), count(distinct o.id) -- AI calls are not per-student
      from platform.ai_operations o, since where o.tenant_id = platform.current_tenant() and o.module_id = 'education.tutor' and o.created_at >= since.t group by o.task_id
    union all
    select 'ai_error', o.error_kind, count(*), count(*), count(distinct o.id)
      from platform.ai_operations o, since where o.tenant_id = platform.current_tenant() and o.module_id = 'education.tutor' and o.status = 'error' and o.created_at >= since.t group by o.error_kind
  )
  select area, key, events, failures, users from rows where area in ('ai', 'ai_error') or users >= 5
$$;
grant execute on function education_tutor.product_signals(int) to platform_app;
