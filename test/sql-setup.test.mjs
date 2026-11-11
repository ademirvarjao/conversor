import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { SETUP_SQL, projectRefFromUrl, sqlEditorUrl } from '../src/sql-setup.js';

const MIGRATIONS_DIR = new URL('../supabase/migrations/', import.meta.url);

const normalize = (sql) => String(sql).replace(/\r\n/g, '\n').trim();

/** Todas as migrações, na ordem em que o Supabase aplica (nome = timestamp). */
async function readMigrations() {
  const { readdir } = await import('node:fs/promises');
  const names = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql')).sort();
  const parts = [];
  for (const name of names) {
    parts.push(normalize(await readFile(new URL(name, MIGRATIONS_DIR), 'utf8')));
  }
  return parts;
}

test('o SQL embarcado no app é idêntico às migrações do repositório', async () => {
  const parts = await readMigrations();
  assert.ok(parts.length >= 1);
  assert.equal(
    normalize(SETUP_SQL),
    parts.join('\n\n'),
    'src/sql-setup.js e supabase/migrations/ divergiram: atualize os dois'
  );
});

test('supabase/schema.sql é a união das migrações (sem drift)', async () => {
  const parts = await readMigrations();
  const schema = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
  // Ignora o cabeçalho de comentário do schema.sql.
  const start = schema.indexOf('alter table public.conversor_models');
  assert.ok(start > 0, 'cabeçalho esperado no schema.sql');
  assert.equal(
    normalize(schema.slice(start)),
    parts.join('\n\n').slice(parts[0].indexOf('alter table public.conversor_models')),
    'supabase/schema.sql ficou para trás: refaça a união das migrações'
  );
});

test('as migrações mantêm o cofre por dono (Auth + RLS)', async () => {
  const parts = await readMigrations();
  const all = parts.join('\n');
  assert.match(all, /add column if not exists owner_id uuid/i);
  assert.match(all, /references auth\.users\(id\)/i);
  assert.match(all, /owner_id = auth\.uid\(\)/i);
  assert.match(SETUP_SQL, /create index if not exists conversor_models_owner_idx/i);
  // O upsert não reescreve owner_id: quem adota a linha antiga é o gatilho.
  assert.match(all, /new\.owner_id is null and auth\.uid\(\) is not null/i);
  assert.match(all, /new\.owner_id := auth\.uid\(\);/i);
});

test('o SQL é idempotente e cria tabela, gatilho e políticas de RLS', () => {
  assert.match(SETUP_SQL, /create table if not exists public\.conversor_models/i);
  assert.match(SETUP_SQL, /create or replace function public\.conversor_models_touch/i);
  assert.match(SETUP_SQL, /drop trigger if exists conversor_models_touch/i);
  assert.match(SETUP_SQL, /enable row level security/i);
  assert.match(SETUP_SQL, /drop policy if exists "conversor_models_select"/i);
  assert.match(SETUP_SQL, /for insert/i);
  assert.match(SETUP_SQL, /for update/i);
  // Sem isso, a tabela recém-criada pode demorar a aparecer no PostgREST.
  assert.match(SETUP_SQL, /notify pgrst, 'reload schema';/i);
});

test('o SQL embarcado não carrega a chave anônima nem segredos', () => {
  assert.doesNotMatch(SETUP_SQL, /sb_publishable_[A-Za-z0-9_-]{10,}/);
  assert.doesNotMatch(SETUP_SQL, /eyJhbGciOi/);
});

test('o link do SQL Editor é montado a partir da Project URL', () => {
  assert.equal(projectRefFromUrl('https://byqhiewzkbqvvmldnwky.supabase.co'), 'byqhiewzkbqvvmldnwky');
  assert.equal(
    projectRefFromUrl('https://byqhiewzkbqvvmldnwky.supabase.co/rest/v1/'),
    'byqhiewzkbqvvmldnwky'
  );
  assert.equal(projectRefFromUrl(''), '');
  assert.equal(projectRefFromUrl('https://exemplo.com'), '');
  assert.equal(
    sqlEditorUrl({ url: 'https://byqhiewzkbqvvmldnwky.supabase.co' }),
    'https://supabase.com/dashboard/project/byqhiewzkbqvvmldnwky/sql/new'
  );
  assert.equal(sqlEditorUrl({}), 'https://supabase.com/dashboard');
});
