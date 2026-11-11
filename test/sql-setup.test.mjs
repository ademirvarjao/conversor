import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { SETUP_SQL, projectRefFromUrl, sqlEditorUrl } from '../src/sql-setup.js';

const MIGRATION = new URL('../supabase/migrations/20261111120000_conversor_models.sql', import.meta.url);

const normalize = (sql) => String(sql).replace(/\r\n/g, '\n').trim();

test('o SQL embarcado no app é idêntico à migração do repositório', async () => {
  const migration = await readFile(MIGRATION, 'utf8');
  assert.equal(
    normalize(SETUP_SQL),
    normalize(migration),
    'src/sql-setup.js e supabase/migrations/ divergiram: atualize os dois'
  );
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
