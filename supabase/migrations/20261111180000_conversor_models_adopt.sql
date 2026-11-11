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
