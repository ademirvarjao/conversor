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
