import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ADMIN_TABS, renderAdminPanel } from '../src/admin-panel.js';
import { SETUP_SQL } from '../src/sql-setup.js';
import {
  blockVault,
  deleteVault,
  describeVaultAdminError,
  fetchVaultRows,
  normalizeSupabaseConfig,
} from '../src/sync-client.js';
import { pullVault, pushVault, restoreIdentityFromCode, saveIdentity } from '../src/sync-vault.js';
import { normalizeMemory } from '../src/ai-engine.js';
import { normalizeAccessCode } from '../src/sync-crypto.js';
import {
  MAX_ENTRIES,
  REGISTRY_KEY,
  countBlocked,
  findVault,
  listVaults,
  markVaultBlocked,
  maskCode,
  mergeVaultView,
  normalizeRegistry,
  registerVault,
  removeVault,
  shortSlot,
  touchVault,
} from '../src/vault-registry.js';

const CONFIG = { url: 'https://projeto-exemplo.supabase.co', anonKey: 'a'.repeat(40) };
const FAST = 1000;

/* -------------------------------------------------------------------------- */
/*                             Dublês de ambiente                             */
/* -------------------------------------------------------------------------- */

function fakeStorage() {
  const data = new Map();
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const CODE_A = 'ABCD-EFGH';
const CODE_B = 'JKLM-NPQR';

const registryOf = (storage) => normalizeRegistry(JSON.parse(storage.data.get(REGISTRY_KEY) || 'null'));

/* -------------------------------------------------------------------------- */
/*                            Registro das chaves                             */
/* -------------------------------------------------------------------------- */

describe('registro de códigos de acesso', () => {
  it('anota a chave, o slot, a origem e a data', () => {
    const storage = fakeStorage();
    const { entry } = registerVault({ code: CODE_A, slot: 'slot-a', source: 'criada' }, storage);
    assert.equal(entry.code, 'ABCDEFGH', 'a chave fica normalizada, sem hífen');
    assert.equal(entry.slot, 'slot-a');
    assert.equal(entry.source, 'criada');
    assert.ok(Date.parse(entry.createdAt));

    const stored = listVaults(storage);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].code, 'ABCDEFGH');
  });

  it('registrar de novo não perde a data de criação nem inventa bloqueio', () => {
    const storage = fakeStorage();
    registerVault({ code: CODE_A, slot: 'slot-a', source: 'criada' }, storage);
    const primeiro = listVaults(storage)[0];
    const { entry } = registerVault({ code: CODE_A, slot: 'slot-a' }, storage);
    assert.equal(entry.createdAt, primeiro.createdAt);
    assert.equal(entry.source, 'criada', 'a origem original é preservada');
    assert.equal(entry.blockedAt, null);
  });

  it('guarda o último uso e o bloqueio', () => {
    const storage = fakeStorage();
    registerVault({ code: CODE_A, slot: 'slot-a', source: 'criada' }, storage);
    touchVault('slot-a', storage, Date.parse('2026-11-11T10:00:00Z'));
    assert.equal(findVault('slot-a', storage).lastSeenAt, '2026-11-11T10:00:00.000Z');

    markVaultBlocked('slot-a', '2026-11-11T12:00:00Z', storage);
    assert.equal(findVault('slot-a', storage).blockedAt, '2026-11-11T12:00:00.000Z');
    markVaultBlocked('slot-a', null, storage);
    assert.equal(findVault('slot-a', storage).blockedAt, null);
  });

  it('remove a chave do registro', () => {
    const storage = fakeStorage();
    registerVault({ code: CODE_A, slot: 'slot-a' }, storage);
    assert.equal(removeVault('slot-a', storage), true);
    assert.equal(listVaults(storage).length, 0);
    assert.equal(removeVault('slot-a', storage), false);
  });

  it('limita a lista e ignora lixo do localStorage', () => {
    const storage = fakeStorage();
    for (let index = 0; index < MAX_ENTRIES + 5; index += 1) {
      registerVault({ code: CODE_A, slot: `slot-${index}` }, storage);
    }
    assert.equal(listVaults(storage).length, MAX_ENTRIES, 'não cresce sem fim');

    storage.setItem(REGISTRY_KEY, '{ não é json');
    assert.deepEqual(listVaults(storage), []);

    storage.setItem(
      REGISTRY_KEY,
      JSON.stringify({
        version: 1,
        entries: [
          { code: CODE_A, slot: 'ok', source: 'inventada', createdAt: 'ontem' },
          { code: 'ABCD-EFGI', slot: 'chave-invalida' },
          { slot: 'sem-chave' },
          null,
          { code: CODE_A, slot: 'ok' },
        ],
      })
    );
    const limpo = listVaults(storage);
    assert.equal(limpo.length, 1, 'só o que dá para usar sobrevive');
    assert.equal(limpo[0].source, 'colada', 'origem desconhecida vira "colada"');
    assert.equal(limpo[0].createdAt, new Date(0).toISOString());
  });

  it('mascara a chave e encurta o slot', () => {
    assert.equal(maskCode(CODE_A), 'ABCD-••••');
    assert.equal(maskCode('nada'), '—');
    assert.equal(shortSlot('0123456789abcdef'), '0123456789…');
    assert.equal(shortSlot('abc'), 'abc');
    assert.equal(shortSlot(''), '—');
  });
});

/* -------------------------------------------------------------------------- */
/*                      Junção registro local + banco                         */
/* -------------------------------------------------------------------------- */

describe('lista de códigos do painel', () => {
  it('junta o que o navegador sabe com o que o banco devolveu', () => {
    const storage = fakeStorage();
    registerVault({ code: CODE_A, slot: 'slot-a', source: 'criada' }, storage);
    registerVault({ code: CODE_B, slot: 'slot-b', source: 'colada' }, storage);

    const list = mergeVaultView(
      registryOf(storage).entries,
      [
        { slot: 'slot-a', updatedAt: '2026-11-11T10:00:00Z', ownerId: null, blockedAt: '2026-11-11T12:00:00Z' },
        { slot: 'slot-z', updatedAt: '2026-11-10T10:00:00Z', ownerId: 'usuario-1', blockedAt: null },
      ],
      { currentSlot: 'slot-b' }
    );

    const a = list.find((item) => item.slot === 'slot-a');
    assert.equal(a.code, 'ABCDEFGH', 'o código só existe porque este navegador o anotou');
    assert.equal(a.inDb, true);
    assert.equal(a.blockedAt, '2026-11-11T12:00:00.000Z');
    assert.equal(a.isCurrent, false);

    const b = list.find((item) => item.slot === 'slot-b');
    assert.equal(b.inDb, false, 'chave criada aqui mas ainda não publicada');
    assert.equal(b.isCurrent, true);

    const z = list.find((item) => item.slot === 'slot-z');
    assert.equal(z.code, null, 'do banco não sai chave nenhuma');
    assert.equal(z.shortSlot, 'slot-z');
    assert.equal(z.source, 'banco');
    assert.equal(z.inDb, true);

    assert.equal(list[0].slot, 'slot-a', 'bloqueado vem primeiro');
    assert.equal(countBlocked(list), 1);
  });

  it('o bloqueio do banco apaga o bloqueio antigo do registro', () => {
    const storage = fakeStorage();
    registerVault({ code: CODE_A, slot: 'slot-a' }, storage);
    markVaultBlocked('slot-a', '2026-11-01T10:00:00Z', storage);
    const list = mergeVaultView(registryOf(storage).entries, [
      { slot: 'slot-a', updatedAt: '2026-11-11T10:00:00Z', ownerId: null, blockedAt: null },
    ]);
    assert.equal(list[0].blockedAt, null, 'desbloqueado no banco volta liberado aqui');
  });

  it('lista vazia e entradas inválidas não explodem', () => {
    assert.deepEqual(mergeVaultView([], []), []);
    assert.deepEqual(mergeVaultView(null, null), []);
    const list = mergeVaultView(undefined, [{ slot: '' }, null, { slot: 'slot-x' }]);
    assert.equal(list.length, 1);
  });
});

/* -------------------------------------------------------------------------- */
/*                          Chave criada/recuperada                           */
/* -------------------------------------------------------------------------- */

describe('a chave criada entra no registro do administrador', () => {
  it('saveIdentity anota a chave (é a única cópia do código)', async () => {
    const storage = fakeStorage();
    const identity = await restoreIdentityFromCode(CODE_A, { iterations: FAST, source: 'criada' });
    saveIdentity(identity, storage);

    const [entry] = listVaults(storage);
    assert.equal(entry.code, normalizeAccessCode(CODE_A));
    assert.equal(entry.masked, undefined, 'a máscara é calculada na hora de mostrar');
    assert.equal(entry.slot, identity.slot);
    assert.equal(entry.source, 'criada');
    assert.equal(findVault(identity.slot, storage).code, entry.code);
  });

  it('origem "recuperada" é aceita e o resto vira "colada"', async () => {
    const recuperada = await restoreIdentityFromCode(CODE_A, { iterations: FAST, source: 'recuperada' });
    assert.equal(recuperada.source, 'recuperada');
    const colada = await restoreIdentityFromCode(CODE_A, { iterations: FAST });
    assert.equal(colada.source, 'colada');
  });
});

/* -------------------------------------------------------------------------- */
/*                        Banco: listar, bloquear, excluir                    */
/* -------------------------------------------------------------------------- */

describe('administração dos cofres no banco', () => {
  it('lista os cofres sem trazer o conteúdo cifrado', async () => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url: new URL(url), init });
      return jsonResponse(200, [
        { slot: 'slot-a', updated_at: '2026-11-11T10:00:00Z', owner_id: null, blocked_at: null },
        { slot: 'slot-b', updated_at: '2026-11-10T10:00:00Z', owner_id: 'u1', blocked_at: '2026-11-10T12:00:00Z' },
      ]);
    };

    const { rows, schemaOutdated } = await fetchVaultRows(CONFIG, { fetchImpl, accessToken: 'token' });
    assert.equal(schemaOutdated, false);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].blockedAt, '2026-11-10T12:00:00Z');
    assert.equal(calls[0].url.pathname, '/rest/v1/conversor_models');
    assert.match(calls[0].url.search, /select=slot%2Cupdated_at%2Cblocked_at%2Cowner_id|select=slot,updated_at,blocked_at,owner_id/);
    assert.equal(calls[0].url.search.includes('payload'), false, 'nada de payload na listagem');
  });

  it('banco sem a migração avisa e lista mesmo assim', async () => {
    const fetchImpl = async (url) => {
      if (new URL(url).search.includes('blocked_at')) {
        return jsonResponse(400, { message: 'column conversor_models.blocked_at does not exist' });
      }
      return jsonResponse(200, [{ slot: 'slot-a', updated_at: '2026-11-11T10:00:00Z', owner_id: null }]);
    };
    const { rows, schemaOutdated } = await fetchVaultRows(CONFIG, { fetchImpl });
    assert.equal(schemaOutdated, true);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].blockedAt, null);
  });

  it('bloquear chama a função do banco e devolve a data', async () => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url: new URL(url), init });
      return jsonResponse(200, [{ slot: 'slot-a', blocked_at: '2026-11-11T12:00:00Z', blocked_reason: null }]);
    };

    const result = await blockVault(CONFIG, 'slot-a', true, { fetchImpl, accessToken: 'token', reason: 'teste' });
    assert.equal(result.blockedAt, '2026-11-11T12:00:00Z');
    assert.equal(calls[0].url.pathname, '/rest/v1/rpc/conversor_block_vault');
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].init.body), { p_slot: 'slot-a', p_blocked: true, p_reason: 'teste' });
    assert.equal(calls[0].init.headers.Authorization, 'Bearer token');
  });

  it('excluir chama a função do banco', async () => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url: new URL(url), init });
      return jsonResponse(200, true);
    };
    const result = await deleteVault(CONFIG, 'slot-a', { fetchImpl });
    assert.equal(result.deleted, true);
    assert.equal(calls[0].url.pathname, '/rest/v1/rpc/conversor_delete_vault');
    assert.deepEqual(JSON.parse(calls[0].init.body), { p_slot: 'slot-a' });
  });

  it('recusa operar sem banco configurado ou sem slot', async () => {
    await assert.rejects(() => fetchVaultRows({}), /não configurado/);
    await assert.rejects(() => blockVault(null, 'slot-a'), /não configurado/);
    await assert.rejects(() => blockVault(CONFIG, ''), /Cofre inválido/);
    await assert.rejects(() => deleteVault(CONFIG, ''), /Cofre inválido/);
  });

  it('traduz o erro do banco em instrução para o painel', () => {
    assert.match(
      describeVaultAdminError({ status: 404, message: 'Could not find the function public.conversor_block_vault' }),
      /SQL de instalação/
    );
    assert.match(describeVaultAdminError({ status: 400, message: 'Cofre bloqueado pelo administrador (conversor_vault_blocked)' }), /bloqueado/);
    assert.match(describeVaultAdminError({ status: 403, message: 'Cofre pertence a outra conta' }), /outra conta/);
    assert.match(describeVaultAdminError({ status: 400, message: 'Cofre não encontrado' }), /não existe mais/);
    assert.match(describeVaultAdminError(new Error('sem rede')), /sem rede/);
  });
});

/* -------------------------------------------------------------------------- */
/*                     O app respeita o bloqueio do banco                     */
/* -------------------------------------------------------------------------- */

describe('cofre bloqueado', () => {
  const memory = normalizeMemory({ learnedProfiles: [{ signature: 'a', keywords: ['x'] }] });

  it('o envio é recusado com mensagem própria', async () => {
    const identity = await restoreIdentityFromCode(CODE_A, { iterations: FAST });
    const fetchImpl = async () =>
      jsonResponse(400, { message: 'Cofre bloqueado pelo administrador (conversor_vault_blocked)' });

    await assert.rejects(
      () => pushVault({ config: CONFIG, identity, memory, fetchImpl, iterations: FAST }),
      (error) => {
        assert.equal(error.code, 'VAULT_BLOCKED');
        assert.match(error.message, /bloqueada pelo administrador/);
        return true;
      }
    );
  });

  it('o download não entrega o conteúdo e marca a chave como bloqueada', async () => {
    const storage = fakeStorage();
    const identity = await restoreIdentityFromCode(CODE_A, { iterations: FAST });
    saveIdentity(identity, storage);

    const fetchImpl = async () =>
      jsonResponse(200, [
        { payload: 'envelope-cifrado', updated_at: '2026-11-11T10:00:00Z', blocked_at: '2026-11-11T12:00:00Z' },
      ]);

    await assert.rejects(
      () => pullVault({ config: CONFIG, identity, fetchImpl, iterations: FAST, storage }),
      (error) => {
        assert.equal(error.code, 'VAULT_BLOCKED');
        return true;
      }
    );
    assert.equal(findVault(identity.slot, storage).blockedAt, '2026-11-11T12:00:00.000Z');
  });

  it('cofre liberado limpa o bloqueio antigo do registro', async () => {
    const storage = fakeStorage();
    const identity = await restoreIdentityFromCode(CODE_A, { iterations: FAST });
    saveIdentity(identity, storage);
    markVaultBlocked(identity.slot, '2026-11-01T10:00:00Z', storage);

    const fetchImpl = async () => jsonResponse(200, []);
    assert.equal(await pullVault({ config: CONFIG, identity, fetchImpl, iterations: FAST, storage }), null);
    // Sem linha no banco não há o que sincronizar; o bloqueio local continua
    // até o banco responder de novo com a linha liberada.
    assert.equal(findVault(identity.slot, storage).blockedAt, '2026-11-01T10:00:00.000Z');
  });
});

/* -------------------------------------------------------------------------- */
/*                              A aba do painel                               */
/* -------------------------------------------------------------------------- */

describe('aba "Códigos de acesso" no painel', () => {
  const ctx = (vaults) => ({
    tab: 'vaults',
    usage: { counters: {}, events: [] },
    memory: {},
    device: { rows: [] },
    cloud: {},
    now: Date.parse('2026-11-11T12:00:00Z'),
    ...(vaults ? { vaults } : {}),
  });

  const item = {
    slot: 'slot-a',
    code: 'ABCDEFGH',
    masked: maskCode(CODE_A),
    shortSlot: 'slot-a',
    createdAt: '2026-11-01T10:00:00Z',
    lastSeenAt: '2026-11-11T09:00:00Z',
    source: 'criada',
    label: '',
    blockedAt: null,
    inDb: true,
    ownerId: null,
    dbUpdatedAt: '2026-11-11T10:00:00Z',
    isCurrent: true,
  };

  it('é uma aba de verdade, com o rótulo pedido', () => {
    assert.equal(ADMIN_TABS.find((tab) => tab.id === 'vaults').label, 'Códigos de acesso');
  });

  it('mostra a chave mascarada, as datas e os controles', () => {
    const body = renderAdminPanel(ctx({ list: [item], configured: true, localCount: 1 }));
    assert.match(body, /Códigos de acesso gerados/);
    assert.match(body, /ABCD-••••/, 'mostra a chave mascarada');
    assert.equal(body.includes(CODE_A), false, 'a chave completa não aparece de cara');
    assert.match(body, /data-cp-vault-reveal="slot-a"/);
    assert.match(body, /data-cp-vault-block="slot-a"/);
    assert.match(body, /data-cp-vault-ask="slot-a"/);
    assert.match(body, /Bloquear/);
    assert.match(body, /Excluir do banco/);
    assert.match(body, /Em uso agora/);
    assert.equal(/undefined|NaN|\[object Object\]/.test(body), false);
  });

  it('revelar mostra a chave; bloquear vira desbloquear', () => {
    const body = renderAdminPanel(
      ctx({ list: [{ ...item, blockedAt: '2026-11-11T12:00:00Z' }], configured: true, revealed: ['slot-a'] })
    );
    assert.match(body, /ABCD-EFGH/, 'revelada mostra o código inteiro');
    assert.match(body, /Desbloquear/);
    assert.match(body, /data-cp-vault-target="open"/, 'o botão pede para abrir o cofre');
    assert.match(body, /Bloqueado/);
    assert.match(body, /is-blocked/);
  });

  it('pede confirmação antes de excluir', () => {
    const body = renderAdminPanel(ctx({ list: [item], configured: true, confirmDelete: 'slot-a' }));
    assert.match(body, /Confirmar exclusão/);
    assert.match(body, /data-cp-vault-cancel/);
    assert.match(body, /não volta/, 'o aviso aparece junto do botão de confirmar');
  });

  it('sem banco configurado explica e desliga bloquear/excluir', () => {
    const body = renderAdminPanel(ctx({ list: [item], configured: false }));
    assert.match(body, /Banco compartilhado não configurado/);
    assert.match(body, /data-cp-vault-block="slot-a"[^>]*disabled/);
    assert.match(body, /data-cp-vault-ask="slot-a"[^>]*disabled/);
  });

  it('banco sem a migração pede o SQL de instalação', () => {
    const body = renderAdminPanel(ctx({ list: [], configured: true, schemaOutdated: true }));
    assert.match(body, /sem a migração de bloqueio/);
    assert.match(body, /SQL de instalação/);
  });

  it('lista vazia e erro viram recado, não tela quebrada', () => {
    assert.match(renderAdminPanel(ctx({ list: [] })), /Nenhum código de acesso ainda/);
    assert.match(renderAdminPanel(ctx({ list: [], error: 'sem conexão' })), /sem conexão/);
    assert.match(renderAdminPanel(ctx()), /Nenhum código de acesso ainda/, 'sem estado não quebra');
  });

  it('chave vista só no banco não finge ter código', () => {
    const body = renderAdminPanel(
      ctx({ list: [{ ...item, code: null, masked: 'slot-a', source: 'banco', inDb: true }], configured: true })
    );
    assert.match(body, /<button[^>]*disabled[^>]*>Ver código/);
    assert.match(body, /Só vista no banco/);
    assert.equal(body.includes('data-cp-vault-reveal'), false, 'sem chave não há o que revelar');
  });
});

/* -------------------------------------------------------------------------- */
/*                                  O SQL                                     */
/* -------------------------------------------------------------------------- */

describe('SQL do bloqueio e da exclusão', () => {
  const schema = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
  const migrations = [
    '20261111120000_conversor_models.sql',
    '20261111160000_conversor_models_owner.sql',
    '20261111180000_conversor_models_adopt.sql',
    '20261112100000_conversor_models_block.sql',
  ];

  it('o schema.sql é a união exata das migrações', () => {
    const joined = migrations
      .map((name) => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8').trim())
      .join('\n\n');
    const start = schema.indexOf('alter table public.conversor_models');
    const expectedStart = joined.indexOf('alter table public.conversor_models');
    assert.ok(start > 0 && expectedStart > 0);
    assert.equal(schema.slice(start).trimEnd(), joined.slice(expectedStart).trimEnd());
  });

  it('o SETUP_SQL copiado no painel é o mesmo SQL', () => {
    const marker = 'alter table public.conversor_models';
    assert.equal(SETUP_SQL.slice(SETUP_SQL.indexOf(marker)).trimEnd(), schema.slice(schema.indexOf(marker)).trimEnd());
  });

  it('cria o bloqueio e as funções de administrar', () => {
    assert.match(schema, /add column if not exists blocked_at timestamptz/);
    assert.match(schema, /add column if not exists blocked_reason text/);
    assert.match(schema, /create or replace function public\.conversor_block_vault\(/);
    assert.match(schema, /create or replace function public\.conversor_delete_vault\(/);
    assert.match(schema, /security definer/);
    assert.match(schema, /grant execute on function public\.conversor_block_vault\(text, boolean, text\) to anon, authenticated/);
    assert.match(schema, /grant execute on function public\.conversor_delete_vault\(text\) to anon, authenticated/);
  });

  it('a regra de dono vale para bloquear e excluir', () => {
    assert.match(schema, /conversor_vault_owned_by_caller/);
    assert.match(schema, /raise exception 'Cofre pertence a outra conta' using errcode = '42501'/);
  });

  it('o gatilho barra escrita em cofre bloqueado', () => {
    assert.match(schema, /Cofre bloqueado pelo administrador \(conversor_vault_blocked\)/);
    assert.match(schema, /old\.blocked_at is not null/);
    // O bloqueio em si (que muda a coluna) continua podendo passar.
    assert.match(schema, /new\.blocked_at is not distinct from old\.blocked_at/);
  });

  it('nenhuma função devolve o conteúdo cifrado', () => {
    const fn = schema.slice(schema.indexOf('function public.conversor_block_vault('));
    const corpo = fn.slice(0, fn.indexOf('comment on function'));
    assert.equal(/payload/.test(corpo), false);
  });

  it('a chave anônima continua sem poder apagar direto pela tabela', () => {
    assert.equal(/for delete/i.test(schema), false, 'a exclusão passa pela função, não por policy de DELETE');
  });
});

/* -------------------------------------------------------------------------- */
/*                        Sanidade do módulo do painel                        */
/* -------------------------------------------------------------------------- */

test('normalizeSupabaseConfig segue exigindo url e chave', () => {
  assert.equal(normalizeSupabaseConfig({ url: '', anonKey: 'a'.repeat(40) }), null);
  assert.equal(normalizeSupabaseConfig({ url: 'https://x.supabase.co', anonKey: 'curta' }), null);
});
