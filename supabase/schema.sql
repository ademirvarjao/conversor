-- ============================================================================
--  Conversor — cofre compartilhado de MODELOS treinados (v1.5.0)
-- ----------------------------------------------------------------------------
--  O que guardamos aqui: apenas os modelos aprendidos pela IA
--  (tokenWeights, learnedProfiles, learningLog e stats).
--  NUNCA sobem arquivos, lançamentos financeiros ou a chave de API do LLM.
--
--  Cada linha é um "cofre" de um usuário:
--    slot    -> identificador opaco, derivado da chave de acesso (HMAC-SHA256);
--               não revela a chave e não permite correlacionar usuários.
--    payload -> conteúdo CIFRADO no navegador (AES-GCM 256), envelope texto
--               "v1.<base64url>"; quem tem a chave anônima do projeto lê apenas
--               texto cifrado.
--
--  Como aplicar (automático, preferido): este mesmo schema está em
--  `supabase/migrations/20261111120000_conversor_models.sql` — a integração
--  Supabase + GitHub aplica a migração sozinha a cada push no branch conectado.
--
--  Como aplicar à mão (só se a integração não estiver ativa): Supabase ->
--  SQL Editor -> New query -> cole tudo -> Run.
-- ============================================================================

create table if not exists public.conversor_models (
  slot       text primary key,
  payload    text not null,
  updated_at timestamptz not null default now()
);

comment on table public.conversor_models is
  'Cofres cifrados de modelos treinados do Conversor (um por chave de acesso).';

comment on column public.conversor_models.slot is
  'Identificador opaco derivado da chave de acesso (HMAC). Não é a chave.';

comment on column public.conversor_models.payload is
  'Envelope cifrado "v1.<base64url(iv|ciphertext)>" gerado no navegador (AES-GCM).';

-- Atualiza updated_at automaticamente em qualquer insert/update.
create or replace function public.conversor_models_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists conversor_models_touch on public.conversor_models;
create trigger conversor_models_touch
  before insert or update on public.conversor_models
  for each row execute function public.conversor_models_touch();

-- ----------------------------------------------------------------------------
--  Row Level Security
--  O app usa SOMENTE a chave anônima (public). O sigilo vem da criptografia no
--  navegador: sem a chave de acesso, o payload é ilegível.
-- ----------------------------------------------------------------------------
alter table public.conversor_models enable row level security;

drop policy if exists "conversor_models_select" on public.conversor_models;
create policy "conversor_models_select"
  on public.conversor_models for select
  to anon, authenticated
  using (true);

drop policy if exists "conversor_models_insert" on public.conversor_models;
create policy "conversor_models_insert"
  on public.conversor_models for insert
  to anon, authenticated
  with check (true);

drop policy if exists "conversor_models_update" on public.conversor_models;
create policy "conversor_models_update"
  on public.conversor_models for update
  to anon, authenticated
  using (true)
  with check (true);

-- O upsert (POST com Prefer: resolution=merge-duplicates) precisa de INSERT e
-- UPDATE; nenhuma das duas permite leitura em texto claro, pois o payload é
-- cifrado no navegador antes de sair.

-- ----------------------------------------------------------------------------
--  Verificação rápida (deve retornar 0 linhas, sem erro)
-- ----------------------------------------------------------------------------
select count(*) as cofres from public.conversor_models;
