import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { renderAdminPanel } from '../src/admin-panel.js';
import {
  SESSION_KEY,
  consumeAuthRedirect,
  currentAccessToken,
  loadSession,
  normalizeSession,
  saveSession,
  signUp,
} from '../src/cloud-auth.js';
import { normalizeMemory } from '../src/ai-engine.js';
import {
  MAX_PAYLOAD_BYTES,
  blockVault,
  fetchRemoteVault,
  fetchVaultRows,
  isSecretSupabaseKey,
  normalizeSupabaseConfig,
  pingDatabase,
  saveRemoteVault,
} from '../src/sync-client.js';
import { deriveAccessKeys, encryptPayload } from '../src/sync-crypto.js';
import { pullVault, pushVault, restoreIdentityFromCode, saveIdentity } from '../src/sync-vault.js';
import { findVault, mergeVaultView } from '../src/vault-registry.js';

const CONFIG = { url: 'https://projeto-exemplo.supabase.co', anonKey: 'sb_publishable_' + 'a'.repeat(30) };
const FAST = 1000;

function fakeStorage() {
  const data = new Map();
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

function makeJwt(payload) {
  const b64 = (obj) =>
    Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.assinatura`;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/* -------------------------------------------------------------------------- */
/*                  1. Migração de blindagem do banco (SQL)                   */
/* -------------------------------------------------------------------------- */

describe('migração de blindagem do banco (20261116165533)', () => {
  const migration = readFileSync(
    new URL('../supabase/migrations/20261116165533_conversor_models_hardening.sql', import.meta.url),
    'utf8'
  );
  const toml = readFileSync(new URL('../supabase/config.toml', import.meta.url), 'utf8');

  it('cria colunas de auditoria e observabilidade sem expor o conteúdo', () => {
    assert.match(migration, /add column if not exists created_at timestamptz/i);
    assert.match(migration, /add column if not exists revision integer not null default 1/i);
    assert.match(migration, /add column if not exists payload_bytes integer\s+generated always as \(octet_length\(payload\)\) stored/i);
    assert.match(migration, /alter column created_at set not null/i);
  });

  it('impõe CHECK constraints para slot, envelope cifrado, motivo e revisão', () => {
    assert.match(migration, /conversor_models_slot_format_chk/);
    assert.match(migration, /\^\[0-9a-f\]\{32\}\$/);
    assert.match(migration, /conversor_models_payload_envelope_chk/);
    assert.match(migration, /between 41 and 5242880/);
    assert.match(migration, /\^v1\\\.\[A-Za-z0-9_-\]\+\$/);
    assert.match(migration, /conversor_models_blocked_reason_chk/);
    assert.match(migration, /conversor_models_revision_chk/);
  });

  it('restringe privilégios por coluna e remove escrita direta em blocked_at/owner_id', () => {
    assert.match(migration, /revoke all on table public\.conversor_models from public, anon, authenticated/i);
    assert.match(migration, /grant insert \(slot, payload, updated_at\)\s+on table public\.conversor_models\s+to anon, authenticated/i);
    assert.match(migration, /grant update \(slot, payload, updated_at\)\s+on table public\.conversor_models\s+to anon, authenticated/i);
    assert.match(migration, /revoke all on function public\.conversor_models_touch\(\) from public, anon, authenticated/i);
    assert.match(migration, /revoke all on function public\.conversor_vault_owned_by_caller\(uuid\) from public, anon, authenticated/i);
  });

  it('fixa search_path em todas as funções, trava DELETE com FOR UPDATE e preserva dono no bloqueio', () => {
    const searchPaths = migration.match(/set search_path = public, pg_temp/gi) || [];
    assert.equal(searchPaths.length, 4, 'as 4 funções do schema têm search_path fixo');

    const deleteFn = migration.slice(migration.indexOf('function public.conversor_delete_vault('));
    assert.match(deleteFn, /for update/i, 'exclusão trava a linha contra corrida TOCTOU');

    assert.match(migration, /new\.owner_id := old\.owner_id/, 'bloqueio não sequestra owner_id de cofre legado');
    assert.match(migration, /current_user not in \('anon', 'authenticated'\)/);
  });

  it('usa InitPlan (select auth.uid()) nas políticas, índice em updated_at e ajuste de autovacuum', () => {
    assert.match(migration, /owner_id = \(select auth\.uid\(\)\)/i);
    assert.match(migration, /create index if not exists conversor_models_updated_at_idx\s+on public\.conversor_models \(updated_at desc\)/i);
    assert.match(migration, /fillfactor = 80/i);
    assert.match(migration, /autovacuum_vacuum_threshold = 10/i);
    assert.match(migration, /analyze public\.conversor_models;/i);
    assert.match(migration, /notify pgrst, 'reload schema';/i);
  });

  it('config.toml aponta site_url para o Pages oficial mantendo localhost nos redirects', () => {
    assert.match(toml, /site_url = "https:\/\/ademirvarjao\.github\.io\/conversor\/"/);
    assert.match(toml, /http:\/\/localhost:3000\/\*\*/);
  });

  it('slot e envelope gerados pelo cliente obedecem exatamente às CHECK constraints do banco', async () => {
    const { slot, aesKey } = await deriveAccessKeys('ABCDEFGH', { iterations: FAST });
    const envelope = await encryptPayload(aesKey, {});
    assert.match(slot, /^[0-9a-f]{32}$/);
    assert.match(envelope, /^v1\.[A-Za-z0-9_-]+$/);
    assert.ok(envelope.length >= 41 && envelope.length <= MAX_PAYLOAD_BYTES);
  });
});

/* -------------------------------------------------------------------------- */
/*            2. Proteção da configuração e resiliência do cliente            */
/* -------------------------------------------------------------------------- */

describe('cliente Supabase: segurança, erros e resiliência', () => {
  it('detecta e recusa chaves secretas (sb_secret_ e JWT service_role)', async () => {
    const serviceJwt = makeJwt({ iss: 'supabase', role: 'service_role', exp: 9999999999 });
    const anonJwt = makeJwt({ iss: 'supabase', role: 'anon', exp: 9999999999 });

    assert.equal(isSecretSupabaseKey('sb_secret_' + 'x'.repeat(30)), true);
    assert.equal(isSecretSupabaseKey(serviceJwt), true);
    assert.equal(isSecretSupabaseKey('sb_publishable_' + 'x'.repeat(30)), false);
    assert.equal(isSecretSupabaseKey(anonJwt), false);

    assert.equal(normalizeSupabaseConfig({ url: CONFIG.url, anonKey: serviceJwt }), null);
    assert.equal(normalizeSupabaseConfig({ url: CONFIG.url, anonKey: 'sb_secret_' + 'x'.repeat(30) }), null);
    assert.ok(normalizeSupabaseConfig({ url: CONFIG.url, anonKey: anonJwt }));

    await assert.rejects(
      () => pingDatabase({ url: CONFIG.url, anonKey: serviceJwt }),
      /service_role|sb_secret_/i
    );
  });

  it('exige HTTPS fora de localhost, limpa /rest/v1 e bloqueia credenciais na URL', () => {
    assert.equal(
      normalizeSupabaseConfig({ url: 'http://projeto-exemplo.supabase.co', anonKey: CONFIG.anonKey }),
      null,
      'HTTP remoto é recusado'
    );
    assert.equal(
      normalizeSupabaseConfig({ url: 'http://localhost:54321/rest/v1/', anonKey: CONFIG.anonKey })?.url,
      'http://localhost:54321',
      'localhost de desenvolvimento continua permitido e sem /rest/v1'
    );
    assert.equal(
      normalizeSupabaseConfig({ url: 'https://projeto-exemplo.supabase.co/rest/v1/', anonKey: CONFIG.anonKey })?.url,
      'https://projeto-exemplo.supabase.co'
    );
    assert.equal(
      normalizeSupabaseConfig({ url: 'https://user:senha@projeto-exemplo.supabase.co', anonKey: CONFIG.anonKey }),
      null
    );
  });

  it('diferencia cofre de conta (RLS 403) de chave anônima inválida (401)', async () => {
    const rlsDenied = async () =>
      jsonResponse(403, { code: '42501', message: 'new row violates row-level security policy for table "conversor_models"' });

    await assert.rejects(
      () => saveRemoteVault(CONFIG, 'a'.repeat(32), 'v1.' + 'A'.repeat(44), { fetchImpl: rlsDenied }),
      (error) => {
        assert.equal(error.code, 'RLS_DENIED');
        assert.match(error.message, /pertence a uma conta na nuvem/i);
        return true;
      }
    );
  });

  it('diferencia função RPC ausente (FUNCTION_MISSING) de tabela ausente (TABLE_MISSING)', async () => {
    const rpcMissing = async () =>
      jsonResponse(404, { code: 'PGRST202', message: 'Could not find the function public.conversor_block_vault' });

    await assert.rejects(
      () => blockVault(CONFIG, 'a'.repeat(32), true, { fetchImpl: rpcMissing }),
      (error) => {
        assert.equal(error.code, 'FUNCTION_MISSING');
        assert.equal(error.status, 404);
        return true;
      }
    );
  });

  it('repete uma vez automaticamente em falha transitória 502/503/504', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) return jsonResponse(503, { message: 'upstream unavailable' });
      return jsonResponse(200, [{ slot: 'a'.repeat(32) }]);
    };

    assert.equal(await pingDatabase(CONFIG, { fetchImpl, retryDelayMs: 0 }), true);
    assert.equal(calls, 2);
  });

  it('barra pacote acima de 5 MiB antes de gastar rede e não envia updated_at do relógio local', async () => {
    let called = false;
    await assert.rejects(
      () =>
        saveRemoteVault(CONFIG, 'a'.repeat(32), 'v1.' + 'A'.repeat(MAX_PAYLOAD_BYTES), {
          fetchImpl: async () => {
            called = true;
            return jsonResponse(201, []);
          },
        }),
      (error) => error.code === 'PAYLOAD_TOO_LARGE'
    );
    assert.equal(called, false);

    let sentBody = null;
    await saveRemoteVault(CONFIG, 'a'.repeat(32), 'v1.' + 'A'.repeat(48), {
      fetchImpl: async (_url, init) => {
        sentBody = JSON.parse(init.body);
        return jsonResponse(201, []);
      },
    });
    assert.deepEqual(Object.keys(sentBody[0]).sort(), ['payload', 'slot']);
  });

  it('faz fallback gracioso em projetos Supabase próprios sem as colunas novas', async () => {
    const fetchV1 = async (url) => {
      const search = new URL(url).search;
      if (search.includes('payload_bytes')) {
        return jsonResponse(400, { message: 'column conversor_models.payload_bytes does not exist' });
      }
      return jsonResponse(200, [
        { slot: 'a'.repeat(32), updated_at: '2026-11-12T10:00:00Z', blocked_at: null, owner_id: null },
      ]);
    };
    const v1 = await fetchVaultRows(CONFIG, { fetchImpl: fetchV1 });
    assert.equal(v1.schemaOutdated, false);
    assert.equal(v1.rows.length, 1);
    assert.equal(v1.rows[0].payloadBytes, null);

    const fetchRemoteV1 = async (url) => {
      if (new URL(url).search.includes('blocked_reason')) {
        return jsonResponse(400, { message: 'column conversor_models.blocked_reason does not exist' });
      }
      return jsonResponse(200, [{ payload: 'v1.abc', updated_at: '2026-11-12T10:00:00Z', blocked_at: null }]);
    };
    const remote = await fetchRemoteVault(CONFIG, 'a'.repeat(32), { fetchImpl: fetchRemoteV1 });
    assert.equal(remote.payload, 'v1.abc');
    assert.equal(remote.blockedReason, null);
  });
});

/* -------------------------------------------------------------------------- */
/*          3. Bloqueio com motivo, auditoria no painel e Auth callback       */
/* -------------------------------------------------------------------------- */

describe('bloqueio, auditoria e retorno de confirmação do Supabase Auth', () => {
  it('envio recusado por bloqueio marca o registro local; download inclui motivo do administrador', async () => {
    const storage = fakeStorage();
    const identity = await restoreIdentityFromCode('ABCDEFGH', { iterations: FAST });
    saveIdentity(identity, storage);

    await assert.rejects(
      () =>
        pushVault({
          config: CONFIG,
          identity,
          memory: normalizeMemory({}),
          storage,
          iterations: FAST,
          now: '2026-11-16T12:00:00.000Z',
          fetchImpl: async () =>
            jsonResponse(400, { message: 'Cofre bloqueado pelo administrador (conversor_vault_blocked)' }),
        }),
      (error) => error.code === 'VAULT_BLOCKED'
    );
    assert.equal(findVault(identity.slot, storage).blockedAt, '2026-11-16T12:00:00.000Z');

    await assert.rejects(
      () =>
        pullVault({
          config: CONFIG,
          identity,
          storage,
          iterations: FAST,
          fetchImpl: async () =>
            jsonResponse(200, [
              {
                payload: '',
                updated_at: '2026-11-16T10:00:00Z',
                blocked_at: '2026-11-16T12:00:00Z',
                blocked_reason: 'Chave substituída pela equipe',
              },
            ]),
        }),
      (error) => {
        assert.equal(error.code, 'VAULT_BLOCKED');
        assert.equal(error.blockedReason, 'Chave substituída pela equipe');
        assert.match(error.message, /Chave substituída pela equipe/);
        return true;
      }
    );
  });

  it('painel usa created_at real do banco e mostra tamanho, revisão e motivo do bloqueio', () => {
    const list = mergeVaultView(
      [],
      [
        {
          slot: 'a'.repeat(32),
          createdAt: '2026-11-11T10:00:00Z',
          updatedAt: '2026-11-16T15:00:00Z',
          ownerId: null,
          blockedAt: '2026-11-16T16:00:00Z',
          blockedReason: 'Auditoria interna',
          revision: 7,
          payloadBytes: 61775,
        },
      ]
    );
    assert.equal(list[0].createdAt, '2026-11-11T10:00:00.000Z', 'created_at imutável em vez de updated_at');
    assert.equal(list[0].revision, 7);
    assert.equal(list[0].payloadBytes, 61775);

    const html = renderAdminPanel({
      tab: 'vaults',
      usage: { counters: {}, events: [] },
      memory: {},
      device: { rows: [] },
      cloud: {},
      now: Date.parse('2026-11-16T17:00:00Z'),
      vaults: { list, configured: true, localCount: 0 },
    });
    assert.match(html, /60,3 KB/);
    assert.match(html, /rev\. 7/);
    assert.match(html, /motivo: Auditoria interna/);
  });

  it('consumeAuthRedirect salva a sessão confirmada por e-mail e limpa o token da URL', () => {
    const storage = fakeStorage();
    const jwt = makeJwt({ sub: 'user-uuid-1', email: 'ana@empresa.com.br', role: 'authenticated' });
    let replacedUrl = null;

    const result = consumeAuthRedirect({
      location: {
        pathname: '/conversor/',
        search: '',
        hash: `#access_token=${jwt}&refresh_token=ref-xyz&expires_in=3600&type=signup`,
      },
      history: {
        replaceState: (_state, _title, url) => {
          replacedUrl = url;
        },
      },
      storage,
      now: 10_000,
    });

    assert.ok(result);
    assert.equal(result.type, 'signup');
    assert.equal(result.session.userId, 'user-uuid-1');
    assert.equal(result.session.email, 'ana@empresa.com.br');
    assert.equal(replacedUrl, '/conversor/', 'token removido da barra de endereços');
    assert.equal(loadSession(storage)?.refreshToken, 'ref-xyz');
    assert.ok(storage.data.has(SESSION_KEY));

    // Âncoras normais da página não são tocadas.
    assert.equal(consumeAuthRedirect({ location: { hash: '#secao-manual' }, storage }), null);
  });

  it('signUp envia redirect_to HTTPS quando informado e ignora HTTP inseguro', async () => {
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(url);
      return jsonResponse(200, { id: 'u1', email: 'a@b.com' });
    };

    await signUp(CONFIG, 'a@b.com', 'senha12345', {
      fetchImpl,
      storage: fakeStorage(),
      redirectTo: 'https://ademirvarjao.github.io/conversor/index.html#ignorar',
    });
    await signUp(CONFIG, 'a@b.com', 'senha12345', {
      fetchImpl,
      storage: fakeStorage(),
      redirectTo: 'http://site-inseguro.exemplo.com/',
    });

    assert.equal(
      urls[0],
      'https://projeto-exemplo.supabase.co/auth/v1/signup?redirect_to=https%3A%2F%2Fademirvarjao.github.io%2Fconversor%2Findex.html'
    );
    assert.equal(urls[1], 'https://projeto-exemplo.supabase.co/auth/v1/signup');
  });

  it('deduplica renovações paralelas de refresh token (protege contra rotação/reuso)', async () => {
    const storage = fakeStorage();
    saveSession(
      normalizeSession({ access_token: 'velho', refresh_token: 'ref-unico', expires_at: 1_000 }, 0),
      storage
    );

    let refreshCalls = 0;
    const fetchImpl = async () => {
      refreshCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return jsonResponse(200, {
        access_token: 'novo-token',
        refresh_token: 'ref-novo',
        expires_in: 3600,
        user: { id: 'u1', email: 'a@b.com' },
      });
    };

    const [t1, t2, t3] = await Promise.all([
      currentAccessToken(CONFIG, { storage, fetchImpl, now: 5_000 }),
      currentAccessToken(CONFIG, { storage, fetchImpl, now: 5_000 }),
      currentAccessToken(CONFIG, { storage, fetchImpl, now: 5_000 }),
    ]);

    assert.equal(refreshCalls, 1, 'uma única chamada ao GoTrue para três pedidos simultâneos');
    assert.deepEqual([t1, t2, t3], ['novo-token', 'novo-token', 'novo-token']);
  });
});
