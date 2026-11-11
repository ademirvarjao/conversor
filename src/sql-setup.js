/**
 * Conversor — SQL de instalação do banco compartilhado
 *
 * Mesmo conteúdo de `supabase/migrations/20261111120000_conversor_models.sql`,
 * embarcado no app para o plano B de quem não usa a integração Supabase+GitHub:
 * a tela "Nuvem" copia este SQL para a área de transferência e abre o SQL
 * Editor do projeto — dois cliques, sem caçar arquivo no repositório.
 *
 * O teste `test/sql-setup.test.mjs` garante que este texto e a migração do
 * repositório continuam idênticos.
 */

export const SETUP_SQL = String.raw`-- ============================================================================
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
`;

/**
 * Ref do projeto Supabase a partir da Project URL
 * (`https://abcdefgh.supabase.co` → `abcdefgh`).
 * @param {string} url
 * @returns {string}
 */
export function projectRefFromUrl(url) {
  const host = String(url || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .split('/')[0];
  const ref = host.split('.')[0] || '';
  return /^[a-z0-9]{16,}$/i.test(ref) ? ref : '';
}

/**
 * Link direto para o SQL Editor do projeto (onde o SQL é colado).
 * @param {{url?: string}|string} config Project URL ou configuração
 * @returns {string}
 */
export function sqlEditorUrl(config) {
  const url = typeof config === 'string' ? config : config?.url;
  const ref = projectRefFromUrl(url);
  return ref ? `https://supabase.com/dashboard/project/${ref}/sql/new` : 'https://supabase.com/dashboard';
}
