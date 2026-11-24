import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * O projeto Supabase do app (`conversor`) já recebeu migrações aplicadas fora
 * deste repositório. A integração Supabase + GitHub compara as versões
 * registradas em `supabase_migrations.schema_migrations` com os arquivos de
 * `supabase/migrations/` e **falha o check** quando encontra uma versão remota
 * sem arquivo local:
 *
 *   "Remote migration versions not found in local migrations directory."
 *
 * Esse check falhava sempre que uma versão era aplicada por outro caminho. Os
 * testes abaixo travam o contrato: todo arquivo segue o padrão de nome aceito
 * pela CLI e todas as versões aplicadas em produção estão versionadas aqui.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.join(ROOT, 'supabase/migrations');

const files = readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort();

/** Versões já aplicadas no projeto remoto (fonte: schema_migrations). */
const APLICADAS_NO_REMOTO = [
  '20261111120000',
  '20261111160000',
  '20261111180000',
  '20261112100000',
  '20261116165533',
  '20261116175010',
  '20261118111202',
  '20261118111224',
  '20261118115338',
];

describe('supabase/migrations', () => {
  it('tem o config.toml do projeto (sem ele a integração nunca roda)', () => {
    assert.doesNotThrow(() => readFileSync(path.join(ROOT, 'supabase/config.toml'), 'utf8'));
  });

  it('nomeia cada migração como <timestamp>_<nome>.sql', () => {
    for (const file of files) {
      assert.match(
        file,
        /^\d{14}_[a-z0-9_]+\.sql$/,
        `nome fora do padrão da CLI do Supabase: ${file}`
      );
    }
  });

  it('não repete a mesma versão em dois arquivos', () => {
    const versoes = files.map((file) => file.slice(0, 14));
    assert.equal(new Set(versoes).size, versoes.length, 'há versões duplicadas');
  });

  it('mantém as versões em ordem crescente (ordem de aplicação)', () => {
    const versoes = files.map((file) => file.slice(0, 14));
    assert.deepEqual(versoes, [...versoes].sort(), 'as versões não estão em ordem');
  });

  it('versiona todas as migrações que já existem no banco remoto', () => {
    const locais = new Set(files.map((file) => file.slice(0, 14)));
    const faltando = APLICADAS_NO_REMOTO.filter((versao) => !locais.has(versao));

    assert.deepEqual(
      faltando,
      [],
      `faltam migrações já aplicadas no remoto (o check "Supabase Preview" falha com ` +
        `"Remote migration versions not found in local migrations directory"): ${faltando.join(', ')}`
    );
  });
});

describe('deploy do GitHub Pages', () => {
  const workflow = readFileSync(path.join(ROOT, '.github/workflows/deploy.yml'), 'utf8');

  it('repete a publicação quando a API de artefatos falha de forma transitória', () => {
    // "No artifacts named github-pages were found" é intermitente: a primeira
    // tentativa pode falhar com o artefato já enviado.
    assert.match(workflow, /uses:\s*actions\/deploy-pages@v\d+/);
    assert.match(workflow, /continue-on-error:\s*true/, 'a 1ª publicação não pode derrubar o job');
    assert.match(workflow, /deployment-retry/, 'falta a nova tentativa de publicação');
  });

  it('usa versões de actions que rodam em Node 24 (Node 20 está depreciado)', () => {
    const depreciadas = [
      ['checkout', /actions\/checkout@v[1-4]\b/],
      ['setup-node', /actions\/setup-node@v[1-6]\b/],
      ['configure-pages', /actions\/configure-pages@v[1-5]\b/],
      ['upload-pages-artifact', /actions\/upload-pages-artifact@v[1-4]\b/],
      ['deploy-pages', /actions\/deploy-pages@v[1-4]\b/],
    ];
    for (const [nome, padrao] of depreciadas) {
      assert.doesNotMatch(workflow, padrao, `${nome} está em versão que depende de Node 20`);
    }
  });
});
