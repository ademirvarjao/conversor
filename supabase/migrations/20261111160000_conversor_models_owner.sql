-- ============================================================================
--  Conversor — cofres por DONO (Supabase Auth + RLS por usuário)
-- ----------------------------------------------------------------------------
--  Até aqui a tabela era um cofre "anônimo": qualquer portador da chave
--  pública (que está no código do app) conseguia ler/escrever qualquer slot,
--  protegido apenas pela criptografia do payload.
--
--  Esta migração acrescenta a coluna owner_id e reescreve as políticas para
--  que o banco passe a separar os cofres por conta:
--
--    * conta autenticada (Supabase Auth)  -> vê e grava apenas os cofres dela;
--    * linhas antigas (owner_id nulo)     -> continuam legíveis/graváveis, para
--      ninguém perder o que já está no banco; o primeiro envio feito com a
--      conta já "adota" a linha (owner_id passa a ser o do usuário);
--    * cofre com dono                     -> quem não é o dono NÃO consegue
--      sobrescrever nem apagar, mesmo conhecendo o slot.
--
--  O DEFAULT auth.uid() é o pulo do gato: o app não precisa mandar o dono no
--  corpo do POST — o Postgres preenche com o usuário do token (ou nulo, quando
--  a requisição vai com a chave anônima).
--
--  Aplicação automática: a integração Supabase + GitHub executa este arquivo a
--  cada push no branch conectado (main). Manual: SQL Editor -> cole -> Run.
-- ============================================================================

alter table public.conversor_models
  add column if not exists owner_id uuid default auth.uid()
  references auth.users(id) on delete cascade;

comment on column public.conversor_models.owner_id is
  'Dono do cofre (auth.uid() do Supabase Auth). Nulo = linha antiga/anônima, adotada no primeiro envio autenticado.';

create index if not exists conversor_models_owner_idx
  on public.conversor_models (owner_id);

-- ----------------------------------------------------------------------------
--  Políticas novas: o dono manda; linha sem dono é terra de ninguém (legado)
-- ----------------------------------------------------------------------------
drop policy if exists "conversor_models_select" on public.conversor_models;
create policy "conversor_models_select"
  on public.conversor_models for select
  to anon, authenticated
  using (owner_id is null or owner_id = auth.uid());

drop policy if exists "conversor_models_insert" on public.conversor_models;
create policy "conversor_models_insert"
  on public.conversor_models for insert
  to anon, authenticated
  with check (owner_id = auth.uid() or (owner_id is null and auth.uid() is null));

drop policy if exists "conversor_models_update" on public.conversor_models;
create policy "conversor_models_update"
  on public.conversor_models for update
  to anon, authenticated
  using (owner_id is null or owner_id = auth.uid())
  with check (owner_id = auth.uid() or (owner_id is null and auth.uid() is null));

-- Upsert (POST + Prefer: resolution=merge-duplicates) passa por INSERT e por
-- UPDATE: com conta, o conflito de slot escreve no cofre da própria conta;
-- sem conta, só em cofre que ainda não tem dono.

-- ----------------------------------------------------------------------------
--  Recarrega o schema cache do PostgREST (coluna nova aparece na hora).
-- ----------------------------------------------------------------------------
notify pgrst, 'reload schema';
