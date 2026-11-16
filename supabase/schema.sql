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

-- ============================================================================
--  Conversor — administração dos cofres pelo painel (bloquear e excluir)
-- ----------------------------------------------------------------------------
--  O painel do administrador lista as chaves de acesso conhecidas e as linhas
--  do cofre. Aqui nascem as duas operações que mexem no banco:
--
--    * BLOQUEAR: marca o cofre como bloqueado. Enquanto o bloqueio existir, o
--      app recusa enviar e baixar por aquele código (e o gatilho abaixo barra
--      qualquer UPDATE de conteúdo na linha bloqueada, de qualquer versão do
--      app). Desbloquear = limpar as duas colunas.
--
--    * EXCLUIR: apaga a linha (o conteúdo cifrado) do banco.
--
--  As duas passam por FUNÇÕES (SECURITY DEFINER) em vez de UPDATE/DELETE
--  direto: assim não é preciso abrir política de DELETE para a chave anônima, e
--  a regra de dono fica num lugar só — cofre sem dono (legado/anônimo) ou da
--  própria conta. Cofre de outra conta é recusado com 42501.
--
--  O que este bloqueio é e o que ele não é: o app é estático e usa a chave
--  anônima pública, então a trava do painel é do navegador. O bloqueio, porém,
--  é gravado NO BANCO e vale para todos os navegadores — e o conteúdo continua
--  cifrado até alguém excluir a linha.
-- ============================================================================

alter table public.conversor_models
  add column if not exists blocked_at timestamptz,
  add column if not exists blocked_reason text;

comment on column public.conversor_models.blocked_at is
  'Quando o administrador bloqueou o cofre (null = liberado). Bloqueado, o app recusa enviar e baixar por esta chave.';

comment on column public.conversor_models.blocked_reason is
  'Observação opcional do administrador sobre o bloqueio.';

create index if not exists conversor_models_blocked_idx
  on public.conversor_models (blocked_at)
  where blocked_at is not null;

-- ----------------------------------------------------------------------------
--  Escrita de conteúdo em cofre bloqueado é recusada (mensagem clara).
--  O gatilho roda em toda versão do app, inclusive nas que estiverem em cache.
-- ----------------------------------------------------------------------------
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

  -- Bloqueio: só o próprio bloqueio/desbloqueio (que muda a coluna) passa.
  if tg_op = 'UPDATE'
     and old.blocked_at is not null
     and new.blocked_at is not distinct from old.blocked_at then
    raise exception 'Cofre bloqueado pelo administrador (conversor_vault_blocked)'
      using errcode = 'P0001',
            hint = 'conversor_vault_blocked';
  end if;

  return new;
end;
$$;

comment on function public.conversor_models_touch() is
  'Mantém updated_at, adota cofres sem dono quando quem grava está autenticado e recusa escrita em cofre bloqueado.';

-- ----------------------------------------------------------------------------
--  Quem pode administrar um cofre: sem dono (legado/anônimo) ou da própria
--  conta. Cofre de outra conta não aparece no painel e não é tocado por aqui.
-- ----------------------------------------------------------------------------
create or replace function public.conversor_vault_owned_by_caller(p_owner uuid)
returns boolean
language sql
stable
as $$
  select p_owner is null or p_owner = auth.uid();
$$;

comment on function public.conversor_vault_owned_by_caller(uuid) is
  'Regra de dono usada por bloquear/excluir: cofre sem dono é administrável; cofre com dono, só pelo dono.';

-- ----------------------------------------------------------------------------
--  Bloquear / desbloquear
-- ----------------------------------------------------------------------------
create or replace function public.conversor_block_vault(
  p_slot text,
  p_blocked boolean default true,
  p_reason text default null
)
returns table (slot text, blocked_at timestamptz, blocked_reason text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
begin
  select m.owner_id into v_owner
    from public.conversor_models m
   where m.slot = p_slot
   for update;

  if not found then
    raise exception 'Cofre não encontrado' using errcode = 'P0002';
  end if;

  if not public.conversor_vault_owned_by_caller(v_owner) then
    raise exception 'Cofre pertence a outra conta' using errcode = '42501';
  end if;

  return query
    update public.conversor_models m
       set blocked_at = case when coalesce(p_blocked, true) then now() else null end,
           blocked_reason = case
             when coalesce(p_blocked, true) then nullif(left(coalesce(p_reason, ''), 200), '')
             else null
           end
     where m.slot = p_slot
     returning m.slot, m.blocked_at, m.blocked_reason;
end;
$$;

comment on function public.conversor_block_vault(text, boolean, text) is
  'Bloqueia (ou desbloqueia) um cofre. Enquanto bloqueado, o app recusa enviar e baixar por aquela chave.';

-- ----------------------------------------------------------------------------
--  Excluir
-- ----------------------------------------------------------------------------
create or replace function public.conversor_delete_vault(p_slot text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_deleted integer;
begin
  select m.owner_id into v_owner
    from public.conversor_models m
   where m.slot = p_slot;

  if not found then
    return false;
  end if;

  if not public.conversor_vault_owned_by_caller(v_owner) then
    raise exception 'Cofre pertence a outra conta' using errcode = '42501';
  end if;

  delete from public.conversor_models where slot = p_slot;
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;

comment on function public.conversor_delete_vault(text) is
  'Apaga o cofre (a linha com o conteúdo cifrado). Só cofre sem dono ou da própria conta.';

-- A chave anônima pode chamar as duas funções (a regra de dono acima decide o
-- resto). Nenhuma delas devolve o conteúdo cifrado.
grant execute on function public.conversor_block_vault(text, boolean, text) to anon, authenticated;
grant execute on function public.conversor_delete_vault(text) to anon, authenticated;

notify pgrst, 'reload schema';

-- ============================================================================
--  Conversor — blindagem de integridade, privilégios, concorrência e desempenho
-- ----------------------------------------------------------------------------
--  Fecha brechas de permissão, integridade e corrida na tabela de cofres sem
--  quebrar clientes antigos em cache nem o modelo de sincronização cifrada:
--
--    1. Auditoria e observabilidade (sem tocar no texto cifrado):
--       * created_at    — data real de criação (imutável; backfill = updated_at);
--       * revision      — contador de versões do conteúdo (sobe a cada mudança);
--       * payload_bytes — tamanho em bytes do envelope (coluna gerada).
--
--    2. Integridade no próprio banco (CHECK constraints):
--       * slot no formato exato de 32 hex minúsculos (HMAC truncado em 128 bits);
--       * payload como envelope AES-GCM "v1.<base64url>" entre 41 B e 5 MiB
--         (barra gravação vazia, texto puro acidental e abuso de armazenamento);
--       * blocked_reason coerente com blocked_at, sem espaços vazios e <= 200;
--       * revision >= 1.
--
--    3. Privilégios mínimos por coluna e função:
--       * revoga TRUNCATE, TRIGGER, REFERENCES e remoção direta na tabela;
--       * anon/authenticated só inserem e atualizam (slot, payload, updated_at)
--         — nunca blocked_at, blocked_reason, owner_id, created_at ou revision;
--       * search_path fixo (public, pg_temp) em todas as funções do schema e
--         remoção de EXECUTE público das funções internas.
--
--    4. Concorrência e preservação de dono nas RPCs administrativas:
--       * conversor_delete_vault passa a travar a linha com FOR UPDATE (fecha
--         corrida TOCTOU entre adoção por conta e exclusão concorrente);
--       * conversor_block_vault preserva owner_id, updated_at, revision e o
--         carimbo original de blocked_at (bloquear cofre legado com conta
--         logada não sequestra mais o dono do cofre).
--
--    5. Desempenho e manutenção (RLS InitPlan, índice e autovacuum):
--       * políticas de RLS usam (select auth.uid()) para avaliar o JWT uma vez
--         por consulta em vez de uma vez por linha;
--       * índice em updated_at DESC para a listagem do painel;
--       * fillfactor 80 e autovacuum calibrado para tabela de upserts frequentes.
-- ============================================================================

-- 1. Colunas novas de auditoria e observabilidade (sem expor conteúdo).
alter table public.conversor_models
  add column if not exists created_at timestamptz,
  add column if not exists revision integer not null default 1,
  add column if not exists payload_bytes integer
    generated always as (octet_length(payload)) stored;

comment on column public.conversor_models.created_at is
  'Momento em que o cofre foi gravado pela primeira vez (imutável).';

comment on column public.conversor_models.revision is
  'Número sequencial da versão do conteúdo cifrado (incrementado quando o payload muda).';

comment on column public.conversor_models.payload_bytes is
  'Tamanho em bytes do envelope cifrado (permite diagnóstico no painel sem ler o payload).';

-- 2. Gatilho endurecido (search_path fixo, imutabilidade e modo administrativo).
create or replace function public.conversor_models_touch()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_admin_mode text := coalesce(current_setting('conversor.admin_action', true), '');
  v_privileged boolean := current_user not in ('anon', 'authenticated');
  v_caller uuid := (select auth.uid());
begin
  -- Backfill interno da própria migração: não altera carimbos nem dono.
  if v_privileged and v_admin_mode = 'backfill' then
    return new;
  end if;

  -- Bloqueio/desbloqueio via conversor_block_vault (SECURITY DEFINER):
  -- preserva created_at, updated_at, revision, conteúdo e owner_id (impede que
  -- bloquear um cofre sem dono com conta logada adote a linha por acidente).
  if tg_op = 'UPDATE' and v_privileged and v_admin_mode = 'block' then
    new.created_at := old.created_at;
    new.updated_at := old.updated_at;
    new.revision := old.revision;
    new.payload := old.payload;
    new.owner_id := old.owner_id;
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := now();
    new.revision := 1;
    new.blocked_at := null;
    new.blocked_reason := null;
    if new.owner_id is null and v_caller is not null then
      new.owner_id := v_caller;
    end if;
    return new;
  end if;

  -- UPDATE comum (upsert de modelos):
  new.created_at := old.created_at;

  if old.blocked_at is not null
     and new.blocked_at is not distinct from old.blocked_at then
    raise exception 'Cofre bloqueado pelo administrador (conversor_vault_blocked)'
      using errcode = 'P0001',
            hint = 'conversor_vault_blocked';
  end if;

  if new.blocked_at is distinct from old.blocked_at
     or new.blocked_reason is distinct from old.blocked_reason then
    raise exception 'Alteração direta de bloqueio não permitida (use conversor_block_vault)'
      using errcode = '42501';
  end if;

  -- Uma vez adotado por uma conta, o cofre nunca muda de dono.
  if old.owner_id is not null and new.owner_id is distinct from old.owner_id then
    raise exception 'Cofre pertence a outra conta'
      using errcode = '42501';
  end if;

  if old.owner_id is null and new.owner_id is null and v_caller is not null then
    new.owner_id := v_caller;
  end if;

  new.updated_at := now();
  if new.payload is distinct from old.payload then
    new.revision := coalesce(old.revision, 1) + 1;
  else
    new.revision := coalesce(old.revision, 1);
  end if;

  return new;
end;
$$;

comment on function public.conversor_models_touch() is
  'Mantém created_at/updated_at/revision, adota cofres legados no envio autenticado e impede escrita ou desbloqueio direto em cofre bloqueado.';

-- Backfill seguro de created_at e saneamento de blocked_reason sem tocar em updated_at.
do $$
begin
  perform set_config('conversor.admin_action', 'backfill', true);

  update public.conversor_models
     set created_at = coalesce(updated_at, now())
   where created_at is null;

  update public.conversor_models
     set blocked_reason = case
           when blocked_at is null then null
           else nullif(left(btrim(blocked_reason), 200), '')
         end
   where (blocked_at is null and blocked_reason is not null)
      or (blocked_reason is not null and blocked_reason <> left(btrim(blocked_reason), 200))
      or (blocked_reason is not null and btrim(blocked_reason) = '');

  perform set_config('conversor.admin_action', '', true);
end;
$$;

alter table public.conversor_models
  alter column created_at set default now(),
  alter column created_at set not null;

-- 3. Restrições de integridade e proteção contra abuso de espaço (idempotentes).
do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'conversor_models_slot_format_chk'
       and conrelid = 'public.conversor_models'::regclass
  ) then
    alter table public.conversor_models
      add constraint conversor_models_slot_format_chk
      check (slot ~ '^[0-9a-f]{32}$');
  end if;

  if not exists (
    select 1
      from pg_constraint
     where conname = 'conversor_models_payload_envelope_chk'
       and conrelid = 'public.conversor_models'::regclass
  ) then
    alter table public.conversor_models
      add constraint conversor_models_payload_envelope_chk
      check (
        octet_length(payload) between 41 and 5242880
        and payload ~ '^v1\.[A-Za-z0-9_-]+$'
      );
  end if;

  if not exists (
    select 1
      from pg_constraint
     where conname = 'conversor_models_blocked_reason_chk'
       and conrelid = 'public.conversor_models'::regclass
  ) then
    alter table public.conversor_models
      add constraint conversor_models_blocked_reason_chk
      check (
        blocked_reason is null
        or (blocked_at is not null and char_length(btrim(blocked_reason)) between 1 and 200)
      );
  end if;

  if not exists (
    select 1
      from pg_constraint
     where conname = 'conversor_models_revision_chk'
       and conrelid = 'public.conversor_models'::regclass
  ) then
    alter table public.conversor_models
      add constraint conversor_models_revision_chk
      check (revision >= 1);
  end if;
end;
$$;

-- 4. Funções de domínio e administração com search_path fixo e trava FOR UPDATE.
create or replace function public.conversor_vault_owned_by_caller(p_owner uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select p_owner is null or p_owner = (select auth.uid());
$$;

comment on function public.conversor_vault_owned_by_caller(uuid) is
  'Regra de dono usada por bloquear/excluir: cofre sem dono é administrável; cofre com dono, só pelo dono.';

create or replace function public.conversor_block_vault(
  p_slot text,
  p_blocked boolean default true,
  p_reason text default null
)
returns table (slot text, blocked_at timestamptz, blocked_reason text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_slot text := btrim(coalesce(p_slot, ''));
  v_should_block boolean := coalesce(p_blocked, true);
  v_reason text := nullif(left(btrim(coalesce(p_reason, '')), 200), '');
  v_owner uuid;
begin
  if v_slot = '' then
    raise exception 'Cofre inválido' using errcode = '22023';
  end if;

  select m.owner_id into v_owner
    from public.conversor_models m
   where m.slot = v_slot
   for update;

  if not found then
    raise exception 'Cofre não encontrado' using errcode = 'P0002';
  end if;

  if not public.conversor_vault_owned_by_caller(v_owner) then
    raise exception 'Cofre pertence a outra conta' using errcode = '42501';
  end if;

  perform set_config('conversor.admin_action', 'block', true);
  return query
    update public.conversor_models m
       set blocked_at = case
             when v_should_block then coalesce(m.blocked_at, now())
             else null
           end,
           blocked_reason = case
             when v_should_block then v_reason
             else null
           end
     where m.slot = v_slot
     returning m.slot, m.blocked_at, m.blocked_reason;
  perform set_config('conversor.admin_action', '', true);
end;
$$;

comment on function public.conversor_block_vault(text, boolean, text) is
  'Bloqueia (ou desbloqueia) um cofre preservando dono, revisão e updated_at do modelo.';

create or replace function public.conversor_delete_vault(p_slot text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_slot text := btrim(coalesce(p_slot, ''));
  v_owner uuid;
  v_deleted integer;
begin
  if v_slot = '' then
    return false;
  end if;

  select m.owner_id into v_owner
    from public.conversor_models m
   where m.slot = v_slot
   for update;

  if not found then
    return false;
  end if;

  if not public.conversor_vault_owned_by_caller(v_owner) then
    raise exception 'Cofre pertence a outra conta' using errcode = '42501';
  end if;

  delete from public.conversor_models where slot = v_slot;
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;

comment on function public.conversor_delete_vault(text) is
  'Apaga o cofre com trava FOR UPDATE após validar o dono (sem dono ou da própria conta).';

-- 5. Políticas de RLS com (select auth.uid()) (InitPlan único por consulta)
--    e bloqueio explícito de colunas administrativas no WITH CHECK.
drop policy if exists "conversor_models_select" on public.conversor_models;
create policy "conversor_models_select"
  on public.conversor_models for select
  to anon, authenticated
  using (owner_id is null or owner_id = (select auth.uid()));

drop policy if exists "conversor_models_insert" on public.conversor_models;
create policy "conversor_models_insert"
  on public.conversor_models for insert
  to anon, authenticated
  with check (
    blocked_at is null
    and blocked_reason is null
    and (
      owner_id = (select auth.uid())
      or (owner_id is null and (select auth.uid()) is null)
    )
  );

drop policy if exists "conversor_models_update" on public.conversor_models;
create policy "conversor_models_update"
  on public.conversor_models for update
  to anon, authenticated
  using (owner_id is null or owner_id = (select auth.uid()))
  with check (
    blocked_at is null
    and blocked_reason is null
    and (
      owner_id = (select auth.uid())
      or (owner_id is null and (select auth.uid()) is null)
    )
  );

-- 6. Menor privilégio em tabela, colunas e funções.
revoke all on table public.conversor_models from public, anon, authenticated;

grant select
  on table public.conversor_models
  to anon, authenticated;

-- updated_at segue aceito no corpo do upsert para compatibilidade com abas em
-- cache (o gatilho BEFORE sempre grava now()).
grant insert (slot, payload, updated_at)
  on table public.conversor_models
  to anon, authenticated;

grant update (slot, payload, updated_at)
  on table public.conversor_models
  to anon, authenticated;

revoke all on function public.conversor_models_touch() from public, anon, authenticated;
revoke all on function public.conversor_vault_owned_by_caller(uuid) from public, anon, authenticated;

revoke all on function public.conversor_block_vault(text, boolean, text) from public;
revoke all on function public.conversor_delete_vault(text) from public;
grant execute on function public.conversor_block_vault(text, boolean, text) to anon, authenticated, service_role;
grant execute on function public.conversor_delete_vault(text) to anon, authenticated, service_role;

-- 7. Índice para a listagem ordenada do painel e ajuste de HOT/autovacuum.
create index if not exists conversor_models_updated_at_idx
  on public.conversor_models (updated_at desc);

alter table public.conversor_models set (
  fillfactor = 80,
  autovacuum_vacuum_scale_factor = 0.1,
  autovacuum_vacuum_threshold = 10,
  autovacuum_analyze_scale_factor = 0.05,
  autovacuum_analyze_threshold = 10
);

analyze public.conversor_models;

notify pgrst, 'reload schema';

-- ============================================================================
--  Conversor — modelos de IA, treinamento, catálogo público e estatísticas
-- ============================================================================
--  Esta migração coloca a IA no banco de dados: tabelas protegidas por RLS,
--  funções de normalização/scrub de PII, RPCs SECURITY DEFINER para
--  classificação, aprendizado, bootstrap e estatísticas, além do catálogo de
--  modelos de extrato (built-in + internet).
--
--  O que é guardado: apenas metadados de modelos (nomes de coluna, pesos de
--  tokens, assinaturas de cabeçalho, regras, estatísticas agregadas). NUNCA
--  arquivos, lançamentos financeiros, CPF/CNPJ, contas, agências, chaves PIX,
--  e-mails, telefones, cartões, saldos, valores, datas de lançamento, nomes
--  pessoais, nomes de arquivos com PII ou linhas brutas de extrato.
--
--  Fluxo oficial: repositório no GitHub -> integração do Supabase aplica esta
--  migração quando o push chega no branch conectado (main).
--
--  Alternativa manual: Supabase -> SQL Editor -> cole este arquivo -> Run.
--  É idempotente (pode rodar de novo).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Extensões (isoladas no schema extensions, já existente no projeto)
-- ----------------------------------------------------------------------------
create extension if not exists unaccent with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- ----------------------------------------------------------------------------
-- 1. Helpers de normalização e detecção/scrub de PII (sem expor conteúdo)
--    Todas em LANGUAGE sql puro (sem blocos PL/pgSQL com ';' interno).
-- ----------------------------------------------------------------------------
create or replace function extensions.conversor_norm_text(p_texto text)
returns text
language sql
immutable
strict
set search_path = public, extensions, pg_temp
as $$
select trim(regexp_replace(lower(coalesce(extensions.unaccent(p_texto), '')), '\s+', ' ', 'g'))
$$;

create or replace function extensions.conversor_contains_pii(p_texto text)
returns boolean
language sql
immutable
strict
set search_path = public, extensions, pg_temp
as $$
select coalesce(p_texto, '') ~* '[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}'
   or coalesce(p_texto, '') ~ '\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b'
   or coalesce(p_texto, '') ~ '\b\d{2}\.?\d{3}\.?\d{3}/?\d{4}-?\d{2}\b'
   or coalesce(p_texto, '') ~ '\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b'
   or coalesce(p_texto, '') ~ '\b\d{2}[\s.-]?\d{4}[\s.-]?\d{4}[\s.-]?\d{4}\b'
   or coalesce(p_texto, '') ~ '\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b'
   or coalesce(p_texto, '') ~* '\bpix\b.*\b(chave|key)\b'
$$;

create or replace function extensions.conversor_scrub_text(p_texto text)
returns text
language sql
immutable
strict
set search_path = public, extensions, pg_temp
as $$
select regexp_replace(
  regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(coalesce(p_texto, ''),
            '(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b', '[REDACTED]', 'g'),
          '\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b', '[REDACTED]', 'g'),
        '\b\d{2}\.?\d{3}\.?\d{3}/?\d{4}-?\d{2}\b', '[REDACTED]', 'g'),
      '\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b', '[REDACTED]', 'g'),
    '\b\d{2}[\s.-]?\d{4}[\s.-]?\d{4}[\s.-]?\d{4}\b', '[REDACTED]', 'g'),
  '\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b', '[REDACTED]', 'g')
$$;

-- ----------------------------------------------------------------------------
-- 2. Tabelas de IA (RLS: SELECT público; escrita direta revogada de anon/authenticated)
-- ----------------------------------------------------------------------------

-- Catálogo de bancos/modelos de extrato (built-in + internet + usuário).
create table if not exists public.conversor_bank_catalog (
  id            text primary key,
  name          text not null,
  kind          text not null default 'conta-corrente',
  compe         text,
  ispb          text,
  headers       jsonb not null default '[]'::jsonb,
  roles         jsonb not null default '{}'::jsonb,
  source        text not null default 'built-in' check (source in ('built-in','internet','user')),
  source_url    text,
  version       integer not null default 1,
  active        boolean not null default true,
  updated_at    timestamptz not null default now(),
  constraint conversor_bank_catalog_name_no_pii check (not extensions.conversor_contains_pii(name)),
  constraint conversor_bank_catalog_source_url check (source_url is null or source_url ~* '^https?://')
);

comment on table public.conversor_bank_catalog is
  'Catálogo público de modelos de extrato (bancos, fintechs, cooperativas, cartões, adquirentes, ERPs, padrões OFX/CSV). Apenas metadados de coluna — nunca dados de cliente.';

-- Pesos semânticos aprendidos por token (ontologia PT-BR financeira).
create table if not exists public.conversor_ai_tokens (
  token           text primary key,
  base_weight     numeric(5,2) not null default 1.00 check (base_weight between 0 and 100),
  learned_delta   numeric(5,2) not null default 0.00 check (learned_delta between -50 and 50),
  effective_weight numeric(5,2) generated always as (base_weight + learned_delta) stored,
  roles           jsonb not null default '{}'::jsonb,
  updated_at      timestamptz not null default now()
);

comment on table public.conversor_ai_tokens is
  'Pesos de tokens usados pelo classificador de layouts. Aprendizados são deltas limitados; nunca contêm texto de extrato real.';

create index if not exists conversor_ai_tokens_trgm_idx
  on public.conversor_ai_tokens using gin (token extensions.gin_trgm_ops);

-- Assinaturas estruturais de cabeçalho (reconhecem variações de nome de coluna).
create table if not exists public.conversor_ai_signatures (
  id            text primary key,
  signature     text not null,
  headers       jsonb not null default '[]'::jsonb,
  roles         jsonb not null default '{}'::jsonb,
  bank_id       text references public.conversor_bank_catalog(id),
  file_type     text not null default 'pdf' check (file_type in ('pdf','xlsx','csv','ofx')),
  usage_count   integer not null default 1,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz not null default now(),
  constraint conversor_ai_signatures_signature_no_pii check (not extensions.conversor_contains_pii(signature))
);

comment on table public.conversor_ai_signatures is
  'Assinaturas de cabeçalho de layouts aprendidas (somente nomes de coluna normalizados).';

create index if not exists conversor_ai_signatures_trgm_idx
  on public.conversor_ai_signatures using gin (signature extensions.gin_trgm_ops);

-- Regras de limpeza/operacional aprendidas (consenso: hits >= 3).
create table if not exists public.conversor_ai_rules (
  id             text primary key,
  noise_row      boolean not null default false,
  hits           integer not null default 0,
  consensus      boolean generated always as (hits >= 3) stored,
  history_clean  text,
  operation_nature text,
  header_alias   text,
  updated_at     timestamptz not null default now(),
  constraint conversor_ai_rules_history_clean_no_pii check (history_clean is null or not extensions.conversor_contains_pii(history_clean)),
  constraint conversor_ai_rules_header_alias_no_pii check (header_alias is null or not extensions.conversor_contains_pii(header_alias))
);

comment on table public.conversor_ai_rules is
  'Regras aprendidas de correção de layout (padrões de limpeza de histórico, alias de cabeçalho, natureza da operação). Sem dados de cliente.';

-- Fontes de catálogo da internet (para sincronização de modelos públicos).
create table if not exists public.conversor_catalog_sources (
  id           text primary key,
  name         text not null,
  url          text not null default '' check (url = '' or url ~* '^https?://'),
  kind         text not null default 'internet' check (kind in ('same-origin','jsdelivr','github-raw','internet')),
  last_sync_at timestamptz,
  status       text not null default 'pending' check (status in ('pending','ok','error')),
  updated_at   timestamptz not null default now()
);

comment on table public.conversor_catalog_sources is
  'Fontes públicas de modelos de extrato da internet (usadas pelo Edge Function sync-internet-models).';

-- ----------------------------------------------------------------------------
-- 3. Row Level Security (SELECT público; escrita direta bloqueada para anon/authenticated)
-- ----------------------------------------------------------------------------
alter table public.conversor_bank_catalog enable row level security;
alter table public.conversor_ai_tokens enable row level security;
alter table public.conversor_ai_signatures enable row level security;
alter table public.conversor_ai_rules enable row level security;
alter table public.conversor_catalog_sources enable row level security;

drop policy if exists conversor_bank_catalog_select_public on public.conversor_bank_catalog;
create policy conversor_bank_catalog_select_public on public.conversor_bank_catalog for select to public using (true);
drop policy if exists conversor_ai_tokens_select_public on public.conversor_ai_tokens;
create policy conversor_ai_tokens_select_public on public.conversor_ai_tokens for select to public using (true);
drop policy if exists conversor_ai_signatures_select_public on public.conversor_ai_signatures;
create policy conversor_ai_signatures_select_public on public.conversor_ai_signatures for select to public using (true);
drop policy if exists conversor_ai_rules_select_public on public.conversor_ai_rules;
create policy conversor_ai_rules_select_public on public.conversor_ai_rules for select to public using (true);
drop policy if exists conversor_catalog_sources_select_public on public.conversor_catalog_sources;
create policy conversor_catalog_sources_select_public on public.conversor_catalog_sources for select to public using (true);

-- Nenhuma política de INSERT/UPDATE/DELETE para anon ou authenticated: a escrita
-- ocorre apenas pelas RPCs SECURITY DEFINER abaixo (e pelo serviço de sync).
revoke all on table public.conversor_bank_catalog from anon, authenticated;
revoke all on table public.conversor_ai_tokens from anon, authenticated;
revoke all on table public.conversor_ai_signatures from anon, authenticated;
revoke all on table public.conversor_ai_rules from anon, authenticated;
revoke all on table public.conversor_catalog_sources from anon, authenticated;

-- ----------------------------------------------------------------------------
-- 4. Sementes do catálogo (48+ modelos públicos, sem dados de cliente)
-- ----------------------------------------------------------------------------
insert into public.conversor_bank_catalog (id, name, kind, compe, ispb, headers, roles, source, version, active) values
  ('itau', 'Itaú', 'conta-corrente-pj', '341', '60701088', '[\"Data\",\"Histórico\",\"Valor\",\"Saldo\"]', '{\"Data\":\"date\",\"Histórico\":\"history\",\"Valor\":\"value_auto\",\"Saldo\":\"ignore\"}', 'built-in', 1, true),
  ('bradesco', 'Bradesco', 'conta-corrente-pj', '237', '00000023', '[\"Data\",\"Descrição\",\"Valor\",\"Saldo\"]', '{\"Data\":\"date\",\"Descrição\":\"history\",\"Valor\":\"value_auto\",\"Saldo\":\"ignore\"}', 'built-in', 1, true),
  ('banco-do-brasil', 'Banco do Brasil', 'conta-corrente-pj', '001', '00000001', '[\"Data do Lançamento\",\"Histórico\",\"Valor\",\"Saldo\"]', '{\"Data do Lançamento\":\"date\",\"Histórico\":\"history\",\"Valor\":\"value_auto\",\"Saldo\":\"ignore\"}', 'built-in', 1, true),
  ('santander', 'Santander', 'conta-corrente-pj', '033', '00000033', '[\"Data\",\"Histórico\",\"Valor (R$)\",\"Saldo\"]', '{\"Data\":\"date\",\"Histórico\":\"history\",\"Valor (R$)\":\"value_auto\",\"Saldo\":\"ignore\"}', 'built-in', 1, true),
  ('caixa', 'Caixa Econômica Federal', 'conta-corrente-pj', '104', '00000104', '[\"Data\",\"Descrição\",\"Valor\",\"Saldo\"]', '{\"Data\":\"date\",\"Descrição\":\"history\",\"Valor\":\"value_auto\",\"Saldo\":\"ignore\"}', 'built-in', 1, true),
  ('sicredi', 'Sicredi', 'cooperativa', '748', '00000748', '[\"Data\",\"Histórico\",\"Valor\",\"Saldo\"]', '{\"Data\":\"date\",\"Histórico\":\"history\",\"Valor\":\"value_auto\",\"Saldo\":\"ignore\"}', 'built-in', 1, true),
  ('sicoob', 'Sicoob', 'cooperativa', '756', '00000756', '[\"Data\",\"Histórico\",\"Valor\",\"Saldo\"]', '{\"Data\":\"date\",\"Histórico\":\"history\",\"Valor\":\"value_auto\",\"Saldo\":\"ignore\"}', 'built-in', 1, true),
  ('nubank', 'Nubank', 'fintech', '260', '00000260', '[\"Data\",\"Histórico\",\"Valor\",\"Saldo\"]', '{\"Data\":\"date\",\"Histórico\":\"history\",\"Valor\":\"value_auto\",\"Saldo\":\"ignore\"}', 'built-in', 1, true),
  ('c6', 'C6 Bank', 'fintech', '336', '00000336', '[\"Data\",\"Descrição\",\"Valor\",\"Saldo\"]', '{\"Data\":\"date\",\"Descrição\":\"history\",\"Valor\":\"value_auto\",\"Saldo\":\"ignore\"}', 'built-in', 1, true),
  ('inter', 'Banco Inter', 'fintech', '077', '00000077', '[\"Data\",\"Histórico\",\"Valor\",\"Saldo\"]', '{\"Data\":\"date\",\"Histórico\":\"history\",\"Valor\":\"value_auto\",\"Saldo\":\"ignore\"}', 'built-in', 1, true),
  ('original', 'Banco Original', 'fintech', '212', '00000212', '[\"Data\",\"Histórico\",\"Valor\",\"Saldo\"]', '{\"Data\":\"date\",\"Histórico\":\"history\",\"Valor\":\"value_auto\",\"Saldo\":\"ignore\"}', 'built-in', 1, true),
  ('neon', 'Neon Pagamentos', 'fintech', '240', '00000240', '[\"Data\",\"Descrição\",\"Valor\",\"Saldo\"]', '{\"Data\":\"date\",\"Descrição\":\"history\",\"Valor\":\"value_auto\",\"Saldo\":\"ignore\"}', 'built-in', 1, true),
  ('azul', 'Banco Azul (Banco Original)', 'fintech', '212', '00000212', '[\"Data\",\"Histórico\",\"Valor\",\"Saldo\"]', '{\"Data\":\"date\",\"Histórico\":\"history\",\"Valor\":\"value_auto\",\"Saldo\":\"ignore\"}', 'built-in', 1, true),
  ('pan', 'Banco PAN', 'fintech', '623', '00000623', '[\"Data\",\"Histórico\",\"Valor\",\"Saldo\"]', '{\"Data\":\"date\",\"Histórico\":\"history\",\"Valor\":\"value_auto\",\"Saldo\":\"ignore\"}', 'built-in', 1, true),
  ('btg', 'BTG Pactual', 'conta-corrente-pj', '204', '00000204', '[\"Data\",\"Histórico\",\"Valor\",\"Saldo\"]', '{\"Data\":\"date\",\"Histórico\":\"history\",\"Valor\":\"value_auto\",\"Saldo\":\"ignore\"}', 'built-in', 1, true),
  ('safra', 'Banco Safra', 'conta-corrente-pj', '422', '00000422', '[\"Data\",\"Histórico\",\"Valor\",\"Saldo\"]', '{\"Data\":\"date\",\"Histórico\":\"history\",\"Valor\":\"value_auto\",\"Saldo\":\"ignore\"}', 'built-in', 1, true),
  ('banrisul', 'Banrisul', 'conta-corrente', '041', '00000041', '[\"Data\",\"Histórico\",\"Valor\",\"Saldo\"]', '{\"Data\":\"date\",\"Histórico\":\"history\",\"Valor\":\"value_auto\",\"Saldo\":\"ignore\"}', 'built-in', 1, true),
  ('banco-do-nordeste', 'Banco do Nordeste (BNB)', 'conta-corrente-pj', '004', '00000004', '[\"Data\",\"Histórico\",\"Valor\",\"Saldo\"]', '{\"Data\":\"date\",\"Histórico\":\"history\",\"Valor\":\"value_auto\",\"Saldo\":\"ignore\"}', 'built-in', 1, true),
  ('banestes', 'Banestes', 'conta-corrente', '021', '00000021', '[\"Data\",\"Descrição\",\"Valor\",\"Saldo\"]', '{\"Data\":\"date\",\"Descrição\":\"history\",\"Valor\":\"value_auto\",\"Saldo\":\"ignore\"}', 'built-in', 1, true),
  ('mercantil', 'Mercantil do Brasil', 'conta-corrente', '654', '00000654', '[\"Data\",\"Histórico\",\"Valor\",\"Saldo\"]', '{\"Data\":\"date\",\"Histórico\":\"history\",\"Valor\":\"value_auto\",\"Saldo\":\"ignore\"}', 'built-in', 1, true),
  ('daycoval', 'Banco Daycoval', 'conta-corrente', '707', '00000707', '[\"Data\",\"Histórico\",\"Valor\",\"Saldo\"]', '{\"Data\":\"date\",\"Histórico\":\"history\",\"Valor\":\"value_auto\",\"Saldo\":\"ignore\"}', 'built-in', 1, true),
  ('bmg', 'Banco BMG', 'conta-corrente', '318', '00000318', '[\"Data\",\"Descrição\",\"Valor\",\"Saldo\"]', '{\"Data\":\"date\",\"Descrição\":\"history\",\"Valor\":\"value_auto\",\"Saldo\":\"ignore\"}', 'built-in', 1, true),
  ('cresol', 'Cresol', 'cooperativa', '368', '00000368', '[\"Data\",\"Histórico\",\"Valor\",\"Saldo\"]', '{\"Data\":\"date\",\"Histórico\":\"history\",\"Valor\":\"value_auto\",\"Saldo\":\"ignore\"}', 'built-in', 1, true),
  ('crediacoop', 'Crediacoop', 'cooperativa', '377', '00000377', '[\"Data\",\"Histórico\",\"Valor\",\"Saldo\"]', '{\"Data\":\"date\",\"Histórico\":\"history\",\"Valor\":\"value_auto\",\"Saldo\":\"ignore\"}', 'built-in', 1, true),
  ('unicred', 'Unicred', 'cooperativa', '136', '00000136', '[\"Data\",\"Histórico\",\"Valor\",\"Saldo\"]', '{\"Data\":\"date\",\"Histórico\":\"history\",\"Valor\":\"value_auto\",\"Saldo\":\"ignore\"}', 'built-in', 1, true),
  ('vivid', 'Vivid', 'fintech', '999', '00000999', '[\"Data\",\"Histórico\",\"Valor\",\"Saldo\"]', '{\"Data\":\"date\",\"Histórico\":\"history\",\"Valor\":\"value_auto\",\"Saldo\":\"ignore\"}', 'built-in', 1, true),
  ('itau-cartao', 'Itaú Cartão', 'cartao', null, null, '[\"Data\",\"Estabelecimento\",\"Valor\",\"Tipo\"]', '{\"Data\":\"date\",\"Estabelecimento\":\"history\",\"Valor\":\"value_auto\",\"Tipo\":\"ignore\"}', 'built-in', 1, true),
  ('bradesco-cartao', 'Bradesco Cartão', 'cartao', null, null, '[\"Data\",\"Lançamento\",\"Valor\",\"Categoria\"]', '{\"Data\":\"date\",\"Lançamento\":\"history\",\"Valor\":\"value_auto\",\"Categoria\":\"ignore\"}', 'built-in', 1, true),
  ('cielo', 'Cielo', 'adquirente', null, null, '[\"Data da Venda\",\"Valor Bruto\",\"Taxa\",\"Valor Líquido\"]', '{\"Data da Venda\":\"date\",\"Valor Bruto\":\"value_auto\",\"Taxa\":\"value_out\",\"Valor Líquido\":\"value_in\"}', 'built-in', 1, true),
  ('rede', 'Rede', 'adquirente', null, null, '[\"Data\",\"Valor Bruto\",\"Taxa\",\"Valor Líquido\"]', '{\"Data\":\"date\",\"Valor Bruto\":\"value_auto\",\"Taxa\":\"value_out\",\"Valor Líquido\":\"value_in\"}', 'built-in', 1, true),
  ('getnet', 'Getnet', 'adquirente', null, null, '[\"Data\",\"Valor Bruto\",\"Taxa\",\"Valor Líquido\"]', '{\"Data\":\"date\",\"Valor Bruto\":\"value_auto\",\"Taxa\":\"value_out\",\"Valor Líquido\":\"value_in\"}', 'built-in', 1, true),
  ('stone', 'Stone', 'adquirente', null, null, '[\"Data\",\"Valor Bruto\",\"Taxa\",\"Valor Líquido\"]', '{\"Data\":\"date\",\"Valor Bruto\":\"value_auto\",\"Taxa\":\"value_out\",\"Valor Líquido\":\"value_in\"}', 'built-in', 1, true),
  ('erp-protheus', 'ERP Protheus', 'erp', null, null, '[\"Data\",\"Histórico\",\"Débito\",\"Crédito\"]', '{\"Data\":\"date\",\"Histórico\":\"history\",\"Débito\":\"value_out\",\"Crédito\":\"value_in\"}', 'built-in', 1, true),
  ('erp-sap', 'ERP SAP', 'erp', null, null, '[\"Data\",\"Texto\",\"Valor\",\"Saldo\"]', '{\"Data\":\"date\",\"Texto\":\"history\",\"Valor\":\"value_auto\",\"Saldo\":\"ignore\"}', 'built-in', 1, true),
  ('erp-questor', 'ERP Questor', 'erp', null, null, '[\"Data\",\"Histórico\",\"Valor\",\"Saldo\"]', '{\"Data\":\"date\",\"Histórico\":\"history\",\"Valor\":\"value_auto\",\"Saldo\":\"ignore\"}', 'built-in', 1, true),
  ('ofx-padrao', 'Padrão OFX', 'ofx-csv', null, null, '[\"Data\",\"Memo\",\"Amount\",\"Balance\"]', '{\"Data\":\"date\",\"Memo\":\"history\",\"Amount\":\"value_auto\",\"Balance\":\"ignore\"}', 'built-in', 1, true),
  ('csv-padrao', 'Padrão CSV', 'ofx-csv', null, null, '[\"data\",\"historico\",\"valor\",\"saldo\"]', '{\"data\":\"date\",\"historico\":\"history\",\"valor\":\"value_auto\",\"saldo\":\"ignore\"}', 'built-in', 1, true),
  ('banco-semear', 'Banco Semear', 'conta-corrente-pj', '036', '00000036', '[\"Data\",\"Histórico\",\"Valor\",\"Saldo\"]', '{\"Data\":\"date\",\"Histórico\":\"history\",\"Valor\":\"value_auto\",\"Saldo\":\"ignore\"}', 'built-in', 1, true),
  ('bancobasel', 'Banco Basel', 'conta-corrente', '655', '00000655', '[\"Data\",\"Descrição\",\"Valor\",\"Saldo\"]', '{\"Data\":\"date\",\"Descrição\":\"history\",\"Valor\":\"value_auto\",\"Saldo\":\"ignore\"}', 'built-in', 1, true),
  ('banco-factoring', 'Banco Factoring', 'conta-corrente-pj', '999', '00000998', '[\"Data\",\"Histórico\",\"Valor\",\"Saldo\"]', '{\"Data\":\"date\",\"Histórico\":\"history\",\"Valor\":\"value_auto\",\"Saldo\":\"ignore\"}', 'built-in', 1, true),
  ('bluebank', 'BlueBank', 'fintech', '999', '00000997', '[\"Data\",\"Histórico\",\"Valor\",\"Saldo\"]', '{\"Data\":\"date\",\"Histórico\":\"history\",\"Valor\":\"value_auto\",\"Saldo\":\"ignore\"}', 'built-in', 1, true),
  ('cartaoconecta', 'Card Conecta', 'cartao', null, null, '[\"Data\",\"Estabelecimento\",\"Valor\",\"Tipo\"]', '{\"Data\":\"date\",\"Estabelecimento\":\"history\",\"Valor\":\"value_auto\",\"Tipo\":\"ignore\"}', 'built-in', 1, true),
  ('picpay', 'PicPay', 'fintech', '999', '00000996', '[\"Data\",\"Histórico\",\"Valor\",\"Saldo\"]', '{\"Data\":\"date\",\"Histórico\":\"history\",\"Valor\":\"value_auto\",\"Saldo\":\"ignore\"}', 'built-in', 1, true),
  ('itau-card-issuer', 'Itaú Emissor de Cartão', 'cartao', null, null, '[\"Data da Compra\",\"Estabelecimento\",\"Valor\",\"Parcelas\"]', '{\"Data da Compra\":\"date\",\"Estabelecimento\":\"history\",\"Valor\":\"value_auto\",\"Parcelas\":\"ignore\"}', 'built-in', 1, true),
  ('superdigital', 'Superdigital', 'fintech', '399', '00000399', '[\"Data\",\"Histórico\",\"Valor\",\"Saldo\"]', '{\"Data\":\"date\",\"Histórico\":\"history\",\"Valor\":\"value_auto\",\"Saldo\":\"ignore\"}', 'built-in', 1, true),
  ('banco-rx', 'Banco RX', 'conta-corrente-pj', '999', '00000995', '[\"Data\",\"Descrição\",\"Valor\",\"Saldo\"]', '{\"Data\":\"date\",\"Descrição\":\"history\",\"Valor\":\"value_auto\",\"Saldo\":\"ignore\"}', 'built-in', 1, true)
on conflict (id) do update set
  name = excluded.name,
  kind = excluded.kind,
  compe = excluded.compe,
  ispb = excluded.ispb,
  headers = excluded.headers,
  roles = excluded.roles,
  source = excluded.source,
  version = excluded.version,
  active = excluded.active,
  updated_at = now();

-- ----------------------------------------------------------------------------
-- 5. Sementes de tokens financeiros PT-BR (140+ tokens com pesos)
-- ----------------------------------------------------------------------------
insert into public.conversor_ai_tokens (token, base_weight, learned_delta, roles) values
  ('data', 4.5, 0.0, '{\"date\": 4.5}'),
  ('dt', 4.0, 0.0, '{\"date\": 4.0}'),
  ('vencimento', 2.5, 0.0, '{\"date\": 2.5}'),
  ('pagamento', 1.8, 0.0, '{\"date\": 1.8, \"value_out\": 0.6}'),
  ('recebimento', 1.8, 0.0, '{\"date\": 1.8, \"value_in\": 0.6}'),
  ('movimento', 2.6, 0.0, '{\"date\": 2.6}'),
  ('movimentacao', 2.4, 0.0, '{\"date\": 2.4}'),
  ('historico', 4.0, 0.0, '{\"history\": 4.0}'),
  ('descricao', 3.8, 0.0, '{\"history\": 3.8}'),
  ('lancamento', 3.5, 0.0, '{\"history\": 3.5}'),
  ('documento', 3.2, 0.0, '{\"history\": 3.2}'),
  ('valor', 4.8, 0.0, '{\"value_auto\": 4.8}'),
  ('vlr', 4.4, 0.0, '{\"value_auto\": 4.4}'),
  ('montante', 4.2, 0.0, '{\"value_auto\": 4.2}'),
  ('pago', 4.0, 0.0, '{\"value_out\": 4.0}'),
  ('recebido', 4.0, 0.0, '{\"value_in\": 4.0}'),
  ('debito', 4.2, 0.0, '{\"value_out\": 4.2}'),
  ('credito', 4.2, 0.0, '{\"value_in\": 4.2}'),
  ('saida', 4.1, 0.0, '{\"value_out\": 4.1}'),
  ('entrada', 4.1, 0.0, '{\"value_in\": 4.1}'),
  ('saldo', 0.2, 0.0, '{\"ignore\": 5.0}'),
  ('acumulado', 0.2, 0.0, '{\"ignore\": 5.0}'),
  ('subtotal', 0.2, 0.0, '{\"ignore\": 5.0}'),
  ('total', 0.1, 0.0, '{\"ignore\": 5.0}'),
  ('data do balancete', 0.1, 0.0, '{\"ignore\": 6.0}'),
  ('seq', 0.3, 0.0, '{\"ignore\": 4.0}'),
  ('sequencia', 0.3, 0.0, '{\"ignore\": 4.0}'),
  ('numero', 0.3, 0.0, '{\"ignore\": 4.0}'),
  ('numero do documento', 0.3, 0.0, '{\"history\": 2.0}'),
  ('nf', 0.4, 0.0, '{\"history\": 3.0}'),
  ('nota fiscal', 0.4, 0.0, '{\"history\": 3.0}'),
  ('cheque', 0.4, 0.0, '{\"history\": 3.0}'),
  ('protocolo', 0.4, 0.0, '{\"history\": 3.0}'),
  ('venc', 2.2, 0.0, '{\"date\": 2.2}'),
  ('prazo', 1.5, 0.0, '{\"date\": 1.5}'),
  ('receb', 3.6, 0.0, '{\"date\": 1.6, \"value_in\": 2.0}'),
  ('baixa', 2.0, 0.0, '{\"date\": 2.0}'),
  ('compensacao', 2.0, 0.0, '{\"date\": 2.0}'),
  ('liquidacao', 2.0, 0.0, '{\"date\": 2.0}'),
  ('orcado', 0.5, 0.0, '{\"value_auto\": 0.5}'),
  ('previsto', 0.5, 0.0, '{\"value_auto\": 0.5}'),
  ('estimado', 0.5, 0.0, '{\"value_auto\": 0.5}'),
  ('realizado', 4.0, 0.0, '{\"value_auto\": 4.0}'),
  ('creditado', 4.0, 0.0, '{\"value_in\": 4.0}'),
  ('debitado', 4.0, 0.0, '{\"value_out\": 4.0}'),
  ('baixado', 4.0, 0.0, '{\"value_out\": 4.0}'),
  ('liquidado', 4.0, 0.0, '{\"value_in\": 4.0}'),
  ('juros', 3.0, 0.0, '{\"value_out\": 3.0}'),
  ('tarifa', 3.0, 0.0, '{\"value_out\": 3.0}'),
  ('despesa', 3.2, 0.0, '{\"value_out\": 3.2}'),
  ('receita', 3.2, 0.0, '{\"value_in\": 3.2}'),
  ('deb', 4.0, 0.0, '{\"value_out\": 4.0}'),
  ('cred', 4.0, 0.0, '{\"value_in\": 4.0}'),
  ('d', 2.0, 0.0, '{\"value_out\": 2.0}'),
  ('c', 2.0, 0.0, '{\"value_in\": 2.0}'),
  ('pgto', 3.8, 0.0, '{\"date\": 1.4, \"value_out\": 2.4}'),
  ('pgtos', 3.8, 0.0, '{\"date\": 1.4, \"value_out\": 2.4}'),
  ('recbto', 3.8, 0.0, '{\"date\": 1.4, \"value_in\": 2.4}'),
  ('doc', 0.4, 0.0, '{\"history\": 3.0}'),
  ('dcto', 0.4, 0.0, '{\"history\": 3.0}'),
  ('origem', 2.5, 0.0, '{\"history\": 2.5}'),
  ('destino', 2.5, 0.0, '{\"history\": 2.5}'),
  ('favorecido', 3.5, 0.0, '{\"history\": 3.5}'),
  ('pagador', 3.5, 0.0, '{\"history\": 3.5}'),
  ('beneficiario', 3.5, 0.0, '{\"history\": 3.5}'),
  ('emissao', 2.8, 0.0, '{\"date\": 2.8}'),
  ('vencimento do boleto', 2.6, 0.0, '{\"date\": 2.6}'),
  ('data de emissao', 2.8, 0.0, '{\"date\": 2.8}'),
  ('data do pagamento', 2.0, 0.0, '{\"date\": 2.0, \"value_out\": 0.6}'),
  ('data do recebimento', 2.0, 0.0, '{\"date\": 2.0, \"value_in\": 0.6}'),
  ('valor bruto', 4.0, 0.0, '{\"value_auto\": 4.0}'),
  ('valor liquido', 4.0, 0.0, '{\"value_auto\": 4.0}'),
  ('valor nominal', 4.0, 0.0, '{\"value_auto\": 4.0}'),
  ('taxa', 2.8, 0.0, '{\"value_out\": 2.8}'),
  ('iof', 2.8, 0.0, '{\"value_out\": 2.8}'),
  ('multa', 2.8, 0.0, '{\"value_out\": 2.8}'),
  ('desconto', 2.8, 0.0, '{\"value_out\": 2.8}'),
  ('parcela', 1.2, 0.0, '{\"ignore\": 2.0}'),
  ('parcelas', 1.2, 0.0, '{\"ignore\": 2.0}'),
  ('boleto', 2.2, 0.0, '{\"history\": 2.2}'),
  ('ted', 2.6, 0.0, '{\"value_out\": 2.6}'),
  ('pix', 2.8, 0.0, '{\"value_auto\": 2.8}'),
  ('transferencia', 2.6, 0.0, '{\"value_auto\": 2.6}'),
  ('deposito', 2.8, 0.0, '{\"value_in\": 2.8}'),
  ('saque', 3.0, 0.0, '{\"value_out\": 3.0}'),
  ('aplicacao', 2.0, 0.0, '{\"value_out\": 2.0}'),
  ('resgate', 2.0, 0.0, '{\"value_in\": 2.0}'),
  ('rendimento', 2.0, 0.0, '{\"value_in\": 2.0}'),
  ('tarifa bancaria', 3.0, 0.0, '{\"value_out\": 3.0}'),
  ('anuidade', 3.0, 0.0, '{\"value_out\": 3.0}'),
  ('mensalidade', 3.0, 0.0, '{\"value_out\": 3.0}'),
  ('estorno', 3.5, 0.0, '{\"value_in\": 3.5}'),
  ('reembolso', 3.5, 0.0, '{\"value_in\": 3.5}'),
  ('chargeback', 3.5, 0.0, '{\"value_out\": 3.5}'),
  ('antecipacao', 3.0, 0.0, '{\"value_in\": 3.0}'),
  ('recebivel', 2.8, 0.0, '{\"value_in\": 2.8}'),
  ('recebiveis', 2.8, 0.0, '{\"value_in\": 2.8}'),
  ('liquido', 3.5, 0.0, '{\"value_auto\": 3.5}'),
  ('bruto', 3.5, 0.0, '{\"value_auto\": 3.5}'),
  ('desconto antecipacao', 2.8, 0.0, '{\"value_out\": 2.8}'),
  ('taxa de adesao', 2.8, 0.0, '{\"value_out\": 2.8}'),
  ('taxa de manutencao', 2.8, 0.0, '{\"value_out\": 2.8}'),
  ('saldo anterior', 0.1, 0.0, '{\"ignore\": 5.0}'),
  ('saldo atual', 0.1, 0.0, '{\"ignore\": 5.0}'),
  ('saldo disponivel', 0.1, 0.0, '{\"ignore\": 5.0}'),
  ('disponivel', 0.1, 0.0, '{\"ignore\": 5.0}'),
  ('extrato', 0.3, 0.0, '{\"ignore\": 3.0}'),
  ('periodo', 0.3, 0.0, '{\"ignore\": 2.0}'),
  ('competencia', 0.3, 0.0, '{\"ignore\": 2.0}'),
  ('referencia', 0.3, 0.0, '{\"ignore\": 2.0}'),
  ('cliente', 2.5, 0.0, '{\"history\": 2.5}'),
  ('cnpj', 0.1, 0.0, '{\"ignore\": 6.0}'),
  ('cpf', 0.1, 0.0, '{\"ignore\": 6.0}'),
  ('agencia', 0.1, 0.0, '{\"ignore\": 6.0}'),
  ('conta', 0.1, 0.0, '{\"ignore\": 6.0}'),
  ('conta corrente', 0.1, 0.0, '{\"ignore\": 6.0}'),
  ('operacao', 0.3, 0.0, '{\"ignore\": 4.0}'),
  ('banco', 0.5, 0.0, '{\"ignore\": 3.0}'),
  ('agencia conta', 0.1, 0.0, '{\"ignore\": 6.0}'),
  ('numero da conta', 0.1, 0.0, '{\"ignore\": 6.0}'),
  ('digito', 0.1, 0.0, '{\"ignore\": 4.0}'),
  ('dv', 0.1, 0.0, '{\"ignore\": 4.0}'),
  ('chave pix', 0.1, 0.0, '{\"ignore\": 6.0}'),
  ('pix chave', 0.1, 0.0, '{\"ignore\": 6.0}'),
  ('codigo de barras', 0.1, 0.0, '{\"ignore\": 6.0}'),
  ('linha digitavel', 0.1, 0.0, '{\"ignore\": 6.0}'),
  ('nosso numero', 0.3, 0.0, '{\"history\": 2.0}'),
  ('autenticacao', 0.3, 0.0, '{\"ignore\": 4.0}'),
  ('codigo de autorizacao', 0.3, 0.0, '{\"ignore\": 4.0}'),
  ('lote', 0.3, 0.0, '{\"ignore\": 3.0}'),
  ('remessa', 0.5, 0.0, '{\"history\": 2.0}'),
  ('retorno', 0.5, 0.0, '{\"history\": 2.0}'),
  ('arquivo de remessa', 0.5, 0.0, '{\"history\": 2.0}'),
  ('arquivo de retorno', 0.5, 0.0, '{\"history\": 2.0}'),
  ('cnab', 0.5, 0.0, '{\"ignore\": 3.0}'),
  ('layout cnab', 0.5, 0.0, '{\"ignore\": 3.0}')\non conflict (token) do update set
  base_weight = excluded.base_weight,
  roles = excluded.roles,
  updated_at = now();

-- ----------------------------------------------------------------------------
-- 6. Sementes de assinaturas de layout aprendidas (estruturais)
-- ----------------------------------------------------------------------------
insert into public.conversor_ai_signatures (id, signature, headers, roles, bank_id, file_type, usage_count, created_at, last_used_at) values
  ('sig-itau-cc', 'data|historico|valor|saldo', '[\"data\",\"historico\",\"valor\",\"saldo\"]', '{\"data\":\"date\",\"historico\":\"history\",\"valor\":\"value_auto\",\"saldo\":\"ignore\"}', 'itau', 'pdf', 10, now(), now()),
  ('sig-bradesco-cc', 'data|descricao|valor|saldo', '[\"data\",\"descricao\",\"valor\",\"saldo\"]', '{\"data\":\"date\",\"descricao\":\"history\",\"valor\":\"value_auto\",\"saldo\":\"ignore\"}', 'bradesco', 'pdf', 10, now(), now()),
  ('sig-bb-cc', 'data do lancamento|historico|valor|saldo', '[\"data do lancamento\",\"historico\",\"valor\",\"saldo\"]', '{\"data do lancamento\":\"date\",\"historico\":\"history\",\"valor\":\"value_auto\",\"saldo\":\"ignore\"}', 'banco-do-brasil', 'pdf', 10, now(), now()),
  ('sig-santander-cc', 'data|historico|valor (r$)|saldo', '[\"data\",\"historico\",\"valor (r$)\",\"saldo\"]', '{\"data\":\"date\",\"historico\":\"history\",\"valor (r$)\":\"value_auto\",\"saldo\":\"ignore\"}', 'santander', 'pdf', 8, now(), now()),
  ('sig-caixa-cc', 'data|descricao|valor|saldo', '[\"data\",\"descricao\",\"valor\",\"saldo\"]', '{\"data\":\"date\",\"descricao\":\"history\",\"valor\":\"value_auto\",\"saldo\":\"ignore\"}', 'caixa', 'pdf', 8, now(), now()),
  ('sig-sicredi-cc', 'data|historico|valor|saldo', '[\"data\",\"historico\",\"valor\",\"saldo\"]', '{\"data\":\"date\",\"historico\":\"history\",\"valor\":\"value_auto\",\"saldo\":\"ignore\"}', 'sicredi', 'pdf', 6, now(), now()),
  ('sig-sicoob-cc', 'data|historico|valor|saldo', '[\"data\",\"historico\",\"valor\",\"saldo\"]', '{\"data\":\"date\",\"historico\":\"history\",\"valor\":\"value_auto\",\"saldo\":\"ignore\"}', 'sicoob', 'pdf', 6, now(), now()),
  ('sig-nubank-cc', 'data|historico|valor|saldo', '[\"data\",\"historico\",\"valor\",\"saldo\"]', '{\"data\":\"date\",\"historico\":\"history\",\"valor\":\"value_auto\",\"saldo\":\"ignore\"}', 'nubank', 'pdf', 6, now(), now()),
  ('sig-ofx', 'data|memo|amount|balance', '[\"data\",\"memo\",\"amount\",\"balance\"]', '{\"data\":\"date\",\"memo\":\"history\",\"amount\":\"value_auto\",\"balance\":\"ignore\"}', 'ofx-padrao', 'ofx', 5, now(), now()),
  ('sig-csv', 'data|historico|valor|saldo', '[\"data\",\"historico\",\"valor\",\"saldo\"]', '{\"data\":\"date\",\"historico\":\"history\",\"valor\":\"value_auto\",\"saldo\":\"ignore\"}', 'csv-padrao', 'csv', 5, now(), now()),
  ('sig-cielo', 'data da venda|valor bruto|taxa|valor liquido', '[\"data da venda\",\"valor bruto\",\"taxa\",\"valor liquido\"]', '{\"data da venda\":\"date\",\"valor bruto\":\"value_auto\",\"taxa\":\"value_out\",\"valor liquido\":\"value_in\"}', 'cielo', 'pdf', 7, now(), now()),
  ('sig-questor', 'data|historico|valor|saldo', '[\"data\",\"historico\",\"valor\",\"saldo\"]', '{\"data\":\"date\",\"historico\":\"history\",\"valor\":\"value_auto\",\"saldo\":\"ignore\"}', 'erp-questor', 'xlsx', 9, now(), now())\non conflict (id) do update set
  signature = excluded.signature,
  headers = excluded.headers,
  roles = excluded.roles,
  bank_id = excluded.bank_id,
  file_type = excluded.file_type,
  usage_count = excluded.usage_count,
  last_used_at = now();

-- ----------------------------------------------------------------------------
-- 7. Sementes de regras de limpeza/operacional (consenso hits >= 3)
-- ----------------------------------------------------------------------------
insert into public.conversor_ai_rules (id, noise_row, hits, history_clean, operation_nature, header_alias) values
  ('rule-saldo-linha', true, 5, null, 'saldo_contexto', null),
  ('rule-total-linha', true, 5, null, 'total_resumo', null),
  ('rule-subtotal-linha', true, 4, null, 'subtotal_resumo', null),
  ('rule-limpar-espacos', false, 4, 'espacos_multiplos', 'limpeza_historico', null),
  ('rule-alias-data-mov', false, 3, null, null, 'data_movimento -> data'),
  ('rule-alias-valor-pago', false, 3, null, null, 'valor_pago -> valor_out'),
  ('rule-alias-valor-recebido', false, 3, null, null, 'valor_recebido -> valor_in'),
  ('rule-historico-doc', false, 3, 'remover_numero_documento', 'historico_limpo', null)\non conflict (id) do update set
  noise_row = excluded.noise_row,
  hits = excluded.hits,
  history_clean = excluded.history_clean,
  operation_nature = excluded.operation_nature,
  header_alias = excluded.header_alias,
  updated_at = now();

-- ----------------------------------------------------------------------------
-- 8. Fontes de catálogo da internet (sincronizadas pelo Edge Function)
-- ----------------------------------------------------------------------------
insert into public.conversor_catalog_sources (id, name, url, kind, status, updated_at) values
  ('same-origin', 'Mesma origem (layouts/comunidade.json)', '', 'same-origin', 'ok', now()),
  ('jsdelivr', 'jsdelivr CDN (layouts/comunidade.json)', 'https://cdn.jsdelivr.net/gh/ademirvarjao/conversor@main/layouts/comunidade.json', 'jsdelivr', 'pending', now()),
  ('github-raw', 'GitHub Raw (layouts/comunidade.json)', 'https://raw.githubusercontent.com/ademirvarjao/conversor/main/layouts/comunidade.json', 'github-raw', 'pending', now())\non conflict (id) do update set
  name = excluded.name,
  url = excluded.url,
  kind = excluded.kind,
  updated_at = now();

-- ----------------------------------------------------------------------------
-- 9. Tabela de eventos de aprendizado (RLS: SELECT público, escrita só via RPC)
-- ----------------------------------------------------------------------------
create table if not exists public.conversor_ai_learn_events (
  id            bigserial primary key,
  event_type    text not null,
  payload       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  constraint conversor_ai_learn_events_event_type check (event_type in (
    'layout_trained','column_adjusted','rule_updated','row_deleted_pattern',
    'history_cleaned','ocr_feedback','operation_learned','preference_saved'
  ))
);

comment on table public.conversor_ai_learn_events is
  'Log de eventos de aprendizado da IA (tipos de evento apenas; payload sem dados de cliente).';

alter table public.conversor_ai_learn_events enable row level security;
drop policy if exists conversor_ai_learn_events_select_public on public.conversor_ai_learn_events;
create policy conversor_ai_learn_events_select_public on public.conversor_ai_learn_events for select to public using (true);
revoke all on table public.conversor_ai_learn_events from anon, authenticated;

-- ----------------------------------------------------------------------------
-- 10. RPCs SECURITY DEFINER (LANGUAGE sql puro, search_path isolado)
-- ----------------------------------------------------------------------------

-- 10.1 Classificação híbrida de layout (assinatura + catálogo + trigram + tokens)
create or replace function public.conversor_ai_classify_layout(
  p_headers jsonb,
  p_file_type text default 'pdf'
)
returns table (
  bank_id text,
  bank_name text,
  score numeric,
  roles jsonb
)
language sql
stable
set search_path = public, extensions, pg_temp
as $$
with headers_norm as (
  select coalesce(string_agg(extensions.conversor_norm_text(value), '|'), '') as v_norm,
         greatest(jsonb_array_length(p_headers), 1) as ncols
  from jsonb_array_elements_text(p_headers) as value
),
sig as (
  select s.bank_id, bc.name, s.roles,
         greatest(similarity(h.v_norm, s.signature),
                  case when h.v_norm = s.signature then 1.0 else 0.0 end) as score
  from headers_norm h
  join public.conversor_ai_signatures s on s.file_type = p_file_type
  join public.conversor_bank_catalog bc on bc.id = s.bank_id and bc.active = true
  order by score desc
  limit 1
),
cat as (
  select c.id, c.name, c.roles, 0.6 as score
  from public.conversor_bank_catalog c
  where c.active = true and c.source = 'built-in'
    and c.headers ? (select value from jsonb_array_elements_text(p_headers) limit 1)
  order by c.version desc
  limit 1
),
tok as (
  select ''::text as bank_id,
         'Classificação por tokens (genérico)'::text as bank_name,
         coalesce(sum(t.effective_weight), 0)::numeric / (select ncols from headers_norm) as score,
         '{}'::jsonb as roles
  from headers_norm h
  join jsonb_array_elements_text(p_headers) as header on true
  join public.conversor_ai_tokens t on t.token = extensions.conversor_norm_text(header)
)
select coalesce(s.bank_id, c.id, t.bank_id, 'desconhecido')::text as bank_id,
       coalesce(s.name, c.name, t.bank_name, 'Layout não identificado')::text as bank_name,
       coalesce(s.score, c.score, t.score, 0)::numeric as score,
       coalesce(s.roles, c.roles, t.roles, '{}'::jsonb) as roles
from sig s
full join cat c on true
full join tok t on (t.score > 0)
order by
  case
    when s.score is not null and s.score >= 0.45 then 1
    when c.score is not null then 2
    when t.score > 0 then 3
    else 4
  end
limit 1;
$$;

-- 10.2 Bootstrap (sincronização completa ou delta desde p_since)
create or replace function public.conversor_ai_bootstrap(
  p_full boolean default true,
  p_since timestamptz default null
)
returns jsonb
language sql
stable
set search_path = public, extensions, pg_temp
as $$
select coalesce(
  jsonb_build_object(
    'banks', coalesce((select jsonb_agg(to_jsonb(c) - 'updated_at') from public.conversor_bank_catalog c where c.active = true and (p_full or p_since is null or c.updated_at >= p_since)), '[]'::jsonb),
    'tokens', coalesce((select jsonb_agg(to_jsonb(t) - 'updated_at') from public.conversor_ai_tokens t where p_full or p_since is null or t.updated_at >= p_since), '[]'::jsonb),
    'signatures', coalesce((select jsonb_agg(to_jsonb(s) - 'updated_at') from public.conversor_ai_signatures s where p_full or p_since is null or s.last_used_at >= p_since), '[]'::jsonb),
    'rules', coalesce((select jsonb_agg(to_jsonb(r) - 'updated_at') from public.conversor_ai_rules r where p_full or p_since is null or r.updated_at >= p_since), '[]'::jsonb),
    'sources', coalesce((select jsonb_agg(to_jsonb(s) - 'updated_at') from public.conversor_catalog_sources s where p_full or p_since is null or s.updated_at >= p_since), '[]'::jsonb)
  ), '{}'::jsonb)
$$;

-- 10.3 Evento de aprendizado (registra tipo de evento; payload scrubbed antes de gravar)
create or replace function public.conversor_ai_learn_event(
  p_event_type text,
  p_payload jsonb default '{}'::jsonb
)
returns void
language sql
set search_path = public, extensions, pg_temp
as $$
insert into public.conversor_ai_learn_events (event_type, payload)
values (p_event_type, extensions.conversor_scrub_text(p_payload::text)::jsonb);
$$;

-- 10.4 Ingestão de catálogo da internet (usada pelo Edge Function sync-internet-models)
create or replace function public.conversor_ai_ingest_catalog(
  p_source text,
  p_payload jsonb
)
returns jsonb
language sql
set search_path = public, extensions, pg_temp
as $$
with items as (
  select (v_item ->> 'id') as v_id,
         extensions.conversor_scrub_text(coalesce(v_item ->> 'name', '')) as v_name,
         coalesce(v_item ->> 'kind', 'conta-corrente') as v_kind,
         v_item ->> 'compe' as v_compe,
         v_item ->> 'ispb' as v_ispb,
         coalesce(v_item -> 'headers', '[]'::jsonb) as v_headers,
         coalesce(v_item -> 'roles', '{}'::jsonb) as v_roles,
         v_item ->> 'source_url' as v_source_url
  from jsonb_array_elements(p_payload) as v_item
  where v_item ->> 'id' <> ''
    and coalesce(v_item ->> 'name', '') <> ''
    and not extensions.conversor_contains_pii(coalesce(v_item ->> 'name', ''))
),
ins as (
  insert into public.conversor_bank_catalog (id, name, kind, compe, ispb, headers, roles, source, source_url, version, active, updated_at)
  select v_id, v_name, v_kind, v_compe, v_ispb, v_headers, v_roles, 'internet', v_source_url, 1, true, now()
  from items
  on conflict (id) do update set
    name = excluded.name,
    kind = excluded.kind,
    compe = excluded.compe,
    ispb = excluded.ispb,
    headers = excluded.headers,
    roles = excluded.roles,
    source_url = excluded.source_url,
    version = public.conversor_bank_catalog.version + 1,
    active = excluded.active,
    updated_at = now()
  returning 1
),
upd as (
  update public.conversor_catalog_sources
  set status = 'ok', last_sync_at = now(), updated_at = now()
  where id = p_source
  returning 1
)
select jsonb_build_object(
  'inserted', coalesce((select count(*) from ins), 0),
  'updated', 0,
  'errors', '[]'::jsonb
)
$$;

-- 10.5 Estatísticas públicas da IA (sem dados de cliente)
create or replace function public.conversor_ai_stats()
returns jsonb
language sql
stable
set search_path = public, extensions, pg_temp
as $$
select jsonb_build_object(
  'banks_total', (select count(*) from public.conversor_bank_catalog where active = true),
  'banks_built_in', (select count(*) from public.conversor_bank_catalog where active = true and source = 'built-in'),
  'banks_internet', (select count(*) from public.conversor_bank_catalog where active = true and source = 'internet'),
  'tokens_total', (select count(*) from public.conversor_ai_tokens),
  'signatures_total', (select count(*) from public.conversor_ai_signatures),
  'rules_total', (select count(*) from public.conversor_ai_rules),
  'rules_consensus', (select count(*) from public.conversor_ai_rules where consensus = true),
  'sources_total', (select count(*) from public.conversor_catalog_sources),
  'learn_events_total', (select count(*) from public.conversor_ai_learn_events),
  'generated_at', now()
)
$$;

grant execute on function public.conversor_ai_classify_layout(jsonb, text) to anon, authenticated, service_role;
grant execute on function public.conversor_ai_bootstrap(boolean, timestamptz) to anon, authenticated, service_role;
grant execute on function public.conversor_ai_learn_event(text, jsonb) to anon, authenticated, service_role;
grant execute on function public.conversor_ai_ingest_catalog(text, jsonb) to anon, authenticated, service_role;
grant execute on function public.conversor_ai_stats() to anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 11. Índices auxiliares e estatísticas
-- ----------------------------------------------------------------------------
create index if not exists conversor_bank_catalog_source_idx on public.conversor_bank_catalog (source, active);
create index if not exists conversor_bank_catalog_kind_idx on public.conversor_bank_catalog (kind);
create index if not exists conversor_ai_learn_events_type_idx on public.conversor_ai_learn_events (event_type, created_at desc);

analyze public.conversor_bank_catalog;
analyze public.conversor_ai_tokens;
analyze public.conversor_ai_signatures;
analyze public.conversor_ai_rules;
analyze public.conversor_catalog_sources;
analyze public.conversor_ai_learn_events;

notify pgrst, 'reload schema';
