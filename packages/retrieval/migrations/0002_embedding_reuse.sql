-- Content hash per chunk so identical text (re-processing, new versions) reuses its embedding
-- instead of being re-embedded. Reuse is limited to the same tenant AND the same embedding model.
alter table platform.chunks add column text_sha256 text;
update platform.chunks set text_sha256 = encode(sha256(convert_to(text, 'UTF8')), 'hex') where text_sha256 is null;
create index chunks_reuse on platform.chunks (tenant_id, embedding_model, text_sha256) where embedding is not null;
