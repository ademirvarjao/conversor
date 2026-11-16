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
