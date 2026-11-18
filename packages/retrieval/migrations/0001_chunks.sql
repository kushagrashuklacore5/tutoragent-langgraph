-- Retrieval chunks (KNOWLEDGE_AND_RAG_DESIGN § 2–3). Embeddings are stored L2-normalised as real[]
-- so cosine similarity = dot product. Where the pgvector extension is available an ANN index can be
-- added (0002, optional set); exact search is always available and is the reference behaviour.
create table platform.chunks (
  id uuid primary key,
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  document_id uuid not null references platform.documents(id) on delete cascade,
  document_version int not null,
  owner_module text not null,
  owner_user_id uuid not null,
  scope text not null,
  visibility text not null check (visibility in ('private', 'scope')),
  trust text not null,
  locator_kind text not null,
  page_start int not null,
  page_end int not null,
  char_start int not null,
  char_end int not null,
  ordinal int not null,
  text text not null,
  tsv tsvector generated always as (to_tsvector('simple', text) || to_tsvector('english', text)) stored,
  embedding real[],
  embedding_model text,
  embedding_dims int,
  created_at timestamptz not null default now()
);
create index chunks_scope on platform.chunks (tenant_id, owner_module, scope);
create index chunks_document on platform.chunks (document_id);
create index chunks_tsv on platform.chunks using gin (tsv);

-- dot product of two equal-length real arrays (vectors are normalised at write time)
create function platform.dot(a real[], b real[]) returns double precision
  language sql immutable parallel safe strict
  as $$ select sum(x::double precision * y::double precision) from unnest(a, b) as t(x, y) $$;

alter table platform.chunks enable row level security;
alter table platform.chunks force row level security;
create policy visible on platform.chunks for select using (
  tenant_id = platform.current_tenant() and (visibility = 'scope' or owner_user_id = platform.current_user_id()));
create policy no_app_write on platform.chunks for insert with check (false);
