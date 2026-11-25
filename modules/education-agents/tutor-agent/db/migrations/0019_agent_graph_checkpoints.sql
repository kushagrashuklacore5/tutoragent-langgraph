-- LangGraph checkpoints for the companion graph (durable workflow state, interrupts, resume after restarts).
-- Same tables as @langchain/langgraph-checkpoint-postgres 1.1.x creates in setup(); created here so the platform's
-- migration owner manages them and the runtime saver never needs DDL rights. Versions 0..5 are recorded so a later
-- saver.setup() is a no-op.
-- SECURITY: no RLS here (the saver connects as platform_system). Threads are only ever opened by the companion
-- runner AFTER the conversation row was read under RLS as its owner; a thread id is never an authorization.
-- Checkpoints carry structural state only (ids, phases, decisions, cards): student text and replies stay encrypted
-- in agent_messages / agent_profiles.
create schema if not exists agent_graph;
create table if not exists agent_graph.checkpoint_migrations (v integer primary key);
create table if not exists agent_graph.checkpoints (
  thread_id text not null, checkpoint_ns text not null default '', checkpoint_id text not null, parent_checkpoint_id text, type text,
  checkpoint jsonb not null, metadata jsonb not null default '{}', primary key (thread_id, checkpoint_ns, checkpoint_id));
create table if not exists agent_graph.checkpoint_blobs (
  thread_id text not null, checkpoint_ns text not null default '', channel text not null, version text not null, type text not null, blob bytea,
  primary key (thread_id, checkpoint_ns, channel, version));
create table if not exists agent_graph.checkpoint_writes (
  thread_id text not null, checkpoint_ns text not null default '', checkpoint_id text not null, task_id text not null, idx integer not null,
  channel text not null, type text, blob bytea not null, task_path text not null default '',
  primary key (thread_id, checkpoint_ns, checkpoint_id, task_id, idx));
insert into agent_graph.checkpoint_migrations (v) values (0), (1), (2), (3), (4), (5) on conflict do nothing;
grant usage on schema agent_graph to platform_system;
grant select, insert, update, delete on all tables in schema agent_graph to platform_system;
