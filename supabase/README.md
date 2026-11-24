# Banco compartilhado do Conversor (Supabase)

Esta pasta é o "projeto Supabase" do repositório: a tabela `conversor_models` guarda os
modelos da IA **cifrados no navegador** (AES-GCM 256). Nada de arquivos, lançamentos ou
chaves de LLM passa por aqui.

| Arquivo | Para que serve |
| --- | --- |
| `config.toml` | Marca a pasta como projeto Supabase. **Sem ele a integração GitHub nunca aplica as migrações** (a tabela não existe e o app mostra "tabela ausente"). |
| `migrations/20261111120000_conversor_models.sql` | Tabela `conversor_models` + RLS do cofre. Idempotente. |
| `migrations/20261111160000_conversor_models_owner.sql` | Dono do cofre (`owner_id`) e políticas por conta. |
| `migrations/20261111180000_conversor_models_adopt.sql` | Adoção das linhas antigas sem dono. |
| `migrations/20261112100000_conversor_models_block.sql` | Bloqueio (`blocked_at`) e as funções `conversor_block_vault` / `conversor_delete_vault` usadas pelo painel do administrador. |
| `migrations/20261116165533_conversor_models_hardening.sql` | Blindagem de integridade (`CHECK` em `slot`, envelope `payload` até 5 MiB, `blocked_reason`, `revision`), auditoria (`created_at`, `revision`, `payload_bytes`), privilégios mínimos por coluna, `search_path` fixo, trava `FOR UPDATE` em exclusão, preservação de `owner_id` no bloqueio, RLS com InitPlan `(select auth.uid())`, índice `updated_at DESC` e ajuste de HOT/autovacuum. |
| `migrations/20261118111202_eleao_workspace.sql` | Tabelas `eleao_*` (perfis, operações, artigos, feedback, cota) com RLS. **Não faz parte do Conversor** — ver nota abaixo. |
| `migrations/20261118111224_eleao_guides.sql` | Conteúdo inicial de `eleao_articles`. **Não faz parte do Conversor**. |
| `migrations/20261118115338_eleao_owner_claim.sql` | Função `eleao_claim_owner()` que promove o dono verificado a administrador. **Não faz parte do Conversor**. |
| **Todas** | São idempotentes e aplicadas em ordem pela integração a cada push na `main`. |
| `schema.sql` | O mesmo SQL do Conversor, para colar no SQL Editor em emergência. |

### Por que há migrações do e-Leão aqui

Este projeto Supabase (`byqhiewzkbqvvmldnwky`) é compartilhado com o aplicativo **e-Leão**, cujas
migrações foram aplicadas direto no banco antes de existirem neste repositório. A integração
Supabase + GitHub compara `supabase_migrations.schema_migrations` com `supabase/migrations/` e
**falha o check** com `Remote migration versions not found in local migrations directory` quando
uma versão remota não tem arquivo local.

Por isso as três migrações já aplicadas foram versionadas aqui com a **mesma versão de timestamp**
(`20261118111202`, `20261118111224`, `20261118115338`): assim a integração as reconhece como
aplicadas e não tenta rodá-las de novo. Consequências práticas:

- Elas **não** entram em `src/sql-setup.js` nem em `supabase/schema.sql` — o SQL embarcado do app
  continua sendo apenas o do Conversor (o teste `test/sql-setup.test.mjs` garante isso pelo nome
  do arquivo: só `*_conversor_*.sql` compõem o SQL embarcado).
- Não as edite: mudar o conteúdo de uma versão já registrada gera divergência de checksum.
  Mudanças no e-Leão entram como **nova** migração.
- `test/supabase-migrations.test.mjs` falha se uma versão aplicada no remoto sumir do repositório.

## Três formas de aplicar (todas idempotentes)

1. **Integração Supabase + GitHub (padrão).** Painel → *Project Settings → Integrations → GitHub*:
   repositório `ademirvarjao/conversor`, **Working directory `.`** (a raiz do repo, não `supabase`),
   **Deploy to production** ligado, **Production branch** `main`. A integração roda as migrações
   ainda não aplicadas no próximo push da `main` (inclusive as que já estavam no repositório).
2. **App (2 cliques).** Aba **Memória da IA → Nuvem (Equipe)** → *Copiar SQL de instalação* →
   *Abrir SQL Editor* → colar → **Run**. Depois use *Verificar de novo* na mesma tela.
3. **CLI.** `npx supabase link --project-ref <ref>` e `npx supabase db push`.

## Diagnóstico rápido

| Sintoma | Causa provável | O que fazer |
| --- | --- | --- |
| `PGRST205 — Could not find the table 'public.conversor_models' in the schema cache` | migração não aplicada **ou** cache do PostgREST desatualizado | rode o SQL (`schema.sql`) e, se a tabela já existir no *Table Editor*, `notify pgrst, 'reload schema';` |
| Check **Supabase Preview** falha com `Remote migration versions not found in local migrations directory` | existe versão em `schema_migrations` sem arquivo em `supabase/migrations/` (migração aplicada por fora, ou pelo e-Leão) | versione a migração usando **o mesmo timestamp** da versão remota. Para listar as que faltam: `select version, name from supabase_migrations.schema_migrations order by version;` |
| Nenhum deploy aparece no histórico da integração | *Working directory* apontando para `supabase` em vez de `.` | corrija para `.` e faça um push na `main` |
| Integração falhou com "already exists" | migração rodada à mão antes | o SQL atual é idempotente; se precisar registrar: `supabase migration repair --status applied 20261111120000` |
| `401 Invalid API key` no app | chave publicada errada/expirada | atualize `DEFAULT_CLOUD_CONFIG` em `src/sync-config.js` |

## Segurança

- A Project URL e a chave **publishable/anon** são públicas por natureza e ficam versionadas em
  `src/sync-config.js`; o sigilo vem da criptografia feita no navegador (chave de acesso do usuário).
- A RLS separa cofres por conta (`owner_id = (select auth.uid())`) e os privilégios de coluna
  restringem `insert`/`update` de `anon` e `authenticated` apenas a `(slot, payload, updated_at)`:
  colunas de controle (`owner_id`, `created_at`, `revision`, `blocked_at`, `blocked_reason`) e
  exclusões só passam pelo gatilho ou pelas RPCs `SECURITY DEFINER` com `search_path` fixo.
- O próprio banco valida formato do `slot` (32 hex) e do envelope `v1.<base64url>` (limite de 5 MiB),
  impedindo gravação acidental em texto claro e abuso de espaço.
- No Supabase Auth, mantenha `Site URL` apontando para o endereço publicado
  (`https://ademirvarjao.github.io/conversor/`) e `localhost:3000` na lista de redirecionamento.
- **Nunca** use a `service_role`/secret key em código de cliente (o próprio app recusa salvá-la).
