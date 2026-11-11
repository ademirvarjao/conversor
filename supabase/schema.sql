-- ============================================================================
--  Conversor — schema completo do banco compartilhado
-- ----------------------------------------------------------------------------
--  Este arquivo é a UNIÃO das migrações de `supabase/migrations/`, na ordem.
--  Serve para aplicar tudo de uma vez no SQL Editor quando a integração
--  Supabase + GitHub não estiver ativa. É idempotente (pode rodar de novo).
--
--  O teste `test/sql-setup.test.mjs` garante que este arquivo, as migrações e o
--  SQL embarcado no app (`src/sql-setup.js`) continuam idênticos.
-- ============================================================================

-- ============================================================================
--  Conversor — cofre compartilhado de MODELOS treinados
-- ----------------------------------------------------------------------------
--  Esta migração cria a tabela usada pelo app para guardar os modelos da IA
--  (pesos semânticos, perfis de layout, log e contas treinadas no conciliador).
--
--  Fluxo oficial (nenhum passo manual):
--    repositório no GitHub  ->  integração do Supabase aplica esta migração
--    quando o push chega no branch conectado (main).
--
--  Alternativa manual (só se a integração não estiver ativa):
--    Supabase -> SQL Editor -> New query -> cole este arquivo -> Run.
--
--  O que guardamos: apenas o pacote de modelos, CIFRADO no navegador
--  (AES-GCM 256, envelope "v1.<base64url>", ver src/sync-crypto.js).
--  NUNCA sobem arquivos, lançamentos financeiros ou a chave de API do LLM.
--
--  A chave anônima do Supabase é pública por natureza: quem a tiver lê apenas
--  texto cifrado. Nunca use a service_role key no app.
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
--  Recarrega o schema cache do PostgREST.
--  Sem isso, logo depois de criar a tabela o app pode receber
--  "PGRST205 — Could not find the table ... in the schema cache".
-- ----------------------------------------------------------------------------
notify pgrst, 'reload schema';

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

-- ============================================================================
--  Conversor — adoção automática de cofres antigos (dono no gatilho)
-- ----------------------------------------------------------------------------
--  O upsert do PostgREST (Prefer: resolution=merge-duplicates) só atualiza as
--  colunas que vêm no corpo do POST. Como o app não manda owner_id, a linha
--  antiga continuaria com dono nulo para sempre — ou seja, continuaria
--  "pública" mesmo depois de a conta entrar.
--
--  Este gatilho resolve o caso no banco, para qualquer versão do app (inclusive
--  navegadores com o bundle antigo em cache):
--
--    * requisição COM conta (auth.uid() preenchido)  -> a linha passa a ser
--      desse usuário, inclusive as que ainda não tinham dono;
--    * requisição anônima                            -> continua gravando linha
--      sem dono, exatamente como antes.
--
--  O WITH CHECK das políticas é avaliado depois dos gatilhos BEFORE, então o
--  RLS enxerga exatamente o valor final: ninguém consegue "adotar" um cofre
--  para outra conta.
-- ============================================================================

create or replace function public.conversor_models_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();

  -- Cofre sem dono adotado por quem grava com conta (migração das linhas
  -- criadas antes de existir o Supabase Auth no app).
  if new.owner_id is null and auth.uid() is not null then
    new.owner_id := auth.uid();
  end if;

  return new;
end;
$$;

comment on function public.conversor_models_touch() is
  'Mantém updated_at e adota cofres sem dono quando quem grava está autenticado.';

notify pgrst, 'reload schema';
