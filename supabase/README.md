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
| **Todas** | São idempotentes e aplicadas em ordem pela integração a cada push na `main`. |
| `schema.sql` | O mesmo SQL, para colar no SQL Editor em emergência. |

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
| Nenhum deploy aparece no histórico da integração | *Working directory* apontando para `supabase` em vez de `.` | corrija para `.` e faça um push na `main` |
| Integração falhou com "already exists" | migração rodada à mão antes | o SQL atual é idempotente; se precisar registrar: `supabase migration repair --status applied 20261111120000` |
| `401 Invalid API key` no app | chave publicada errada/expirada | atualize `DEFAULT_CLOUD_CONFIG` em `src/sync-config.js` |

## Segurança

- A Project URL e a chave **publishable/anon** são públicas por natureza e ficam versionadas em
  `src/sync-config.js`; o sigilo vem da criptografia feita no navegador (chave de acesso do usuário).
- A RLS está ligada com políticas de `select`, `insert` e `update` para `anon` — o suficiente para o
  upsert do app. **Nunca** use a `service_role`/secret key em código de cliente.
