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
