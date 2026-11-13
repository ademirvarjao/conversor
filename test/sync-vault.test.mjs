import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeMemory } from '../src/ai-engine.js';
import { DEFAULT_CLOUD_CONFIG } from '../src/sync-config.js';
import { normalizeSupabaseConfig } from '../src/sync-client.js';
import {
  CONFIG_KEY,
  IDENTITY_KEY,
  applyVaultPayload,
  buildVaultPayload,
  clearCloudConfig,
  clearIdentity,
  hasBuiltInCloudConfig,
  isPayloadNewer,
  loadCloudConfig,
  loadIdentity,
  mergeVaultPayload,
  pullVault,
  pushVault,
  restoreIdentityFromCode,
  saveCloudConfig,
  saveIdentity,
  touchIdentitySync,
} from '../src/sync-vault.js';

/** Iterações baixas: o teste valida o fluxo, não o custo do PBKDF2. */
const FAST = 1000;
const CONFIG = { url: 'https://projeto-exemplo.supabase.co', anonKey: 'a'.repeat(40) };

/* -------------------------------------------------------------------------- */
/*                       Dublês de localStorage e fetch                       */
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

/**
 * PostgREST falso: guarda linhas em memória e entende os dois verbos usados
 * pelo app (GET com filtro `slot=eq.` e POST com upsert).
 */
function fakeBackend() {
  const rows = new Map();
  const calls = [];

  const fetchImpl = async (url, init = {}) => {
    const url_ = new URL(url);
    calls.push({ url: url_, method: init.method || 'GET', body: init.body });

    if (url_.pathname !== '/rest/v1/conversor_models') {
      return jsonResponse(404, { message: 'not found' });
    }

    if ((init.method || 'GET') === 'GET') {
      const filter = url_.searchParams.get('slot') || '';
      const slot = filter.startsWith('eq.') ? decodeURIComponent(filter.slice(3)) : '';
      if (!slot) {
        return jsonResponse(
          200,
          [...rows.entries()].map(([slot, row]) => ({ slot, payload: row.payload, updated_at: row.updated_at }))
        );
      }
      const row = rows.get(slot);
      return jsonResponse(200, row ? [{ payload: row.payload, updated_at: row.updated_at }] : []);
    }

    const body = JSON.parse(init.body || '[]');
    for (const item of body) {
      rows.set(item.slot, { payload: item.payload, updated_at: item.updated_at });
    }
    return { ok: true, status: 201, json: async () => [] };
  };

  return { rows, calls, fetchImpl };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** Memória de exemplo com um perfil treinado e uma chave de LLM local. */
function memoryWithProfile(nome = 'Itaú — Recebimentos') {
  const memory = normalizeMemory({});
  memory.learnedProfiles = [
    {
      id: 'prof-teste',
      name: nome,
      fileType: 'pdf',
      headers: ['data', 'valor'],
      mappings: [
        { header: 'data', role: 'date', historyOrder: 1 },
        { header: 'valor', role: 'amount', historyOrder: 2 },
      ],
      rules: { defaultSign: 'auto' },
    },
  ];
  memory.tokenWeights = { recebimento: { date: 0.9 }, credito: { amount: 0.7 } };
  memory.stats = { totalFilesProcessed: 7, correctionsLearned: 3 };
  memory.learningLog = [
    {
      id: 'log-1',
      timestamp: '2026-11-01T10:00:00.000Z',
      type: 'train',
      message: `layout treinado: ${nome}`,
      details: '',
    },
  ];
  memory.optionalLlm = { provider: 'openai', apiKey: 'sk-segredo-do-usuario', model: 'gpt-4o-mini' };
  return normalizeMemory(memory);
}

/* -------------------------------------------------------------------------- */
/*                              Identidade local                              */
/* -------------------------------------------------------------------------- */

test('identidade é gravada, lida e apagada do armazenamento local', async () => {
  const storage = fakeStorage();
  const identity = await restoreIdentityFromCode('ABCDEFGH', { iterations: FAST });

  assert.equal(loadIdentity(storage), null);
  assert.equal(saveIdentity(identity, storage), true);

  const loaded = loadIdentity(storage);
  assert.equal(loaded.code, 'ABCDEFGH');
  assert.equal(loaded.slot, identity.slot);
  assert.equal(loaded.lastSyncAt, null);
  assert.ok(storage.data.has(IDENTITY_KEY));

  const touched = touchIdentitySync({ ...loaded }, '2026-11-11T12:00:00.000Z', storage);
  assert.equal(touched.lastSyncAt, '2026-11-11T12:00:00.000Z');
  assert.equal(loadIdentity(storage).lastSyncAt, '2026-11-11T12:00:00.000Z');

  assert.equal(clearIdentity(storage), true);
  assert.equal(loadIdentity(storage), null);
  assert.equal(storage.data.has(IDENTITY_KEY), false);
});

test('identidade só é aceita com chave e slot (nada de meio registro)', () => {
  const storage = fakeStorage();
  assert.equal(saveIdentity({ code: 'ABCDEFGH' }, storage), false);
  assert.equal(saveIdentity({ slot: 'abc' }, storage), false);
  storage.setItem(IDENTITY_KEY, '{ quebrado');
  assert.equal(loadIdentity(storage), null);
});

test('configuração do banco é validada antes de ser salva', () => {
  const storage = fakeStorage();
  // `{}` isola o teste do banco embutido no app (que é usado como padrão).
  assert.equal(saveCloudConfig({ url: '', anonKey: '' }, storage), false);
  assert.equal(saveCloudConfig({ url: 'nao-e-url', anonKey: 'b'.repeat(40) }, storage), false);
  assert.equal(saveCloudConfig({ url: CONFIG.url, anonKey: 'curta' }, storage), false);
  assert.equal(loadCloudConfig(storage, {}), null);

  assert.equal(saveCloudConfig({ url: `${CONFIG.url}/`, anonKey: CONFIG.anonKey }, storage), true);
  const loaded = loadCloudConfig(storage, {});
  assert.equal(loaded.url, CONFIG.url, 'barra final é removida');
  assert.ok(storage.data.has(CONFIG_KEY));

  clearCloudConfig(storage);
  assert.equal(loadCloudConfig(storage, {}), null);
});

test('o banco embutido no app, quando preenchido, é válido', () => {
  const builtIn = normalizeSupabaseConfig(DEFAULT_CLOUD_CONFIG);

  if (!builtIn) {
    // Modo manual: sem banco embutido, o app pede URL + chave anônima na tela.
    assert.equal(hasBuiltInCloudConfig(), false);
    assert.equal(loadCloudConfig(fakeStorage()), null);
    return;
  }

  assert.equal(hasBuiltInCloudConfig(), true);
  assert.match(builtIn.url, /^https:\/\/[a-z0-9-]+\.supabase\.co$/i);
  // Aceita tanto a chave anônima legada (JWT `eyJ...`) quanto a publishable
  // key dos projetos novos (`sb_publishable_...`).
  assert.match(builtIn.anonKey, /^(eyJ|sb_publishable_)/, 'chave pública do Supabase');
  // Sem conexão salva neste navegador, o app usa o banco embutido.
  assert.deepEqual(loadCloudConfig(fakeStorage()), builtIn);
});

test('sem conexão salva, vale o banco embutido; a conexão salva tem prioridade', () => {
  const storage = fakeStorage();
  const builtIn = { url: 'https://oficial.supabase.co', anonKey: 'c'.repeat(120) };

  assert.deepEqual(loadCloudConfig(storage, builtIn), builtIn);

  assert.equal(saveCloudConfig(CONFIG, storage), true);
  assert.equal(loadCloudConfig(storage, builtIn).url, CONFIG.url);

  clearCloudConfig(storage);
  assert.equal(loadCloudConfig(storage, builtIn).url, builtIn.url);
});

/* -------------------------------------------------------------------------- */
/*                          Pacote enviado para a nuvem                       */
/* -------------------------------------------------------------------------- */

test('o pacote leva só os modelos aprendidos — nunca a chave do LLM', () => {
  const memory = memoryWithProfile();
  const payload = buildVaultPayload(memory, { updatedAt: '2026-11-11T00:00:00.000Z', appVersion: '1.5.0' });

  assert.equal(payload.v, 1);
  assert.equal(payload.updatedAt, '2026-11-11T00:00:00.000Z');
  assert.equal(payload.appVersion, '1.5.0');
  // A memória sempre leva também os layouts de fábrica (Itaú/Bradesco).
  const learned = payload.learnedProfiles.filter((profile) => !profile.builtIn);
  assert.equal(learned.length, 1);
  assert.deepEqual(payload.tokenWeights, memory.tokenWeights);
  assert.deepEqual(payload.stats, memory.stats);
  assert.equal(payload.learningLog.length, 1);
  assert.equal('optionalLlm' in payload, false);
  assert.equal(JSON.stringify(payload).includes('sk-segredo-do-usuario'), false);
});

test('aplicar o pacote preserva a chave do LLM que já existe na máquina', () => {
  const local = memoryWithProfile('Layout antigo');
  const remote = buildVaultPayload(memoryWithProfile('Layout da equipe'));

  const merged = applyVaultPayload(local, remote);
  assert.equal(merged.learnedProfiles.find((profile) => !profile.builtIn)?.name, 'Layout da equipe');
  assert.deepEqual(merged.tokenWeights, remote.tokenWeights);
  assert.equal(merged.optionalLlm.apiKey, 'sk-segredo-do-usuario', 'a chave local continua aqui');
  assert.equal(merged.optionalLlm.provider, 'openai');
});

test('as contas memorizadas viajam no pacote da nuvem', () => {
  const memory = memoryWithProfile('Layout da equipe');
  memory.counterparties = {
    aliases: {},
    tokenWeights: {},
    contacts: {},
    accounts: {
      byHistory: { 'plasttotal industrial': { debit: '', credit: '12345', hits: 2, updatedAt: '2026-11-11T10:00:00.000Z' } },
      byContact: { '5086959': { debit: '500046', credit: '', hits: 1, updatedAt: '2026-11-11T10:00:00.000Z' } },
    },
    uses: 1,
    updatedAt: '2026-11-11T10:00:00.000Z',
  };

  const payload = buildVaultPayload(memory);
  assert.equal(payload.counterparties.accounts.byHistory['plasttotal industrial'].credit, '12345');

  const restored = applyVaultPayload(memoryWithProfile('outro'), payload);
  assert.equal(restored.counterparties.accounts.byHistory['plasttotal industrial'].credit, '12345');
  assert.equal(restored.counterparties.accounts.byContact['5086959'].debit, '500046');
});

test('pacote inválido é recusado', () => {
  assert.throws(() => applyVaultPayload(memoryWithProfile(), null), /inválido/i);
  assert.throws(() => applyVaultPayload(memoryWithProfile(), 'texto'), /inválido/i);
});

test('isPayloadNewer compara pela data de atualização', () => {
  assert.equal(isPayloadNewer({ updatedAt: '2026-11-11T10:00:00Z' }, { updatedAt: '2026-11-11T09:00:00Z' }), true);
  assert.equal(isPayloadNewer({ updatedAt: '2026-11-11T08:00:00Z' }, { updatedAt: '2026-11-11T09:00:00Z' }), false);
  assert.equal(isPayloadNewer({}, {}), false);
});

/* -------------------------------------------------------------------------- */
/*                          Enviar e recuperar da nuvem                       */
/* -------------------------------------------------------------------------- */

test('envia cifrado e recupera o mesmo conteúdo', async () => {
  const backend = fakeBackend();
  const identity = await restoreIdentityFromCode('ABCDEFGH', { iterations: FAST });
  const memory = memoryWithProfile();

  const sent = await pushVault({
    config: CONFIG,
    identity,
    memory,
    appVersion: '1.5.0',
    fetchImpl: backend.fetchImpl,
    iterations: FAST,
  });
  assert.ok(sent.updatedAt);

  // No banco só existe texto cifrado.
  const stored = backend.rows.get(identity.slot);
  assert.ok(stored, 'gravou no slot derivado da chave');
  assert.ok(stored.payload.startsWith('v1.'));
  assert.equal(stored.payload.includes('Recebimentos'), false);
  assert.equal(stored.payload.includes('recebimento'), false);

  // O POST foi enviado com o cabeçalho de upsert.
  const post = backend.calls.find((call) => call.method === 'POST');
  assert.equal(post.url.pathname, '/rest/v1/conversor_models');

  const pulled = await pullVault({ config: CONFIG, identity, fetchImpl: backend.fetchImpl, iterations: FAST });
  assert.equal(
    pulled.payload.learnedProfiles.find((profile) => !profile.builtIn)?.name,
    'Itaú — Recebimentos'
  );
  assert.deepEqual(pulled.payload.tokenWeights, memory.tokenWeights);
  assert.equal(pulled.payload.updatedAt, sent.updatedAt);

  const restored = applyVaultPayload(normalizeMemory({}), pulled.payload);
  assert.equal(restored.learnedProfiles.filter((profile) => !profile.builtIn).length, 1);
  assert.equal(restored.stats.totalFilesProcessed, 7);
});

test('outra máquina recupera os modelos digitando a mesma chave', async () => {
  const backend = fakeBackend();
  const machineA = await restoreIdentityFromCode('ABCDEFGH', { iterations: FAST });

  await pushVault({
    config: CONFIG,
    identity: machineA,
    memory: memoryWithProfile(),
    fetchImpl: backend.fetchImpl,
    iterations: FAST,
  });

  // Máquina B: sem nada local, só a chave digitada.
  const storageB = fakeStorage();
  const machineB = await restoreIdentityFromCode('abcd-efgh', { iterations: FAST });
  saveIdentity(machineB, storageB);

  assert.equal(loadIdentity(storageB).slot, machineA.slot);

  const pulled = await pullVault({
    config: CONFIG,
    identity: loadIdentity(storageB),
    fetchImpl: backend.fetchImpl,
    iterations: FAST,
  });
  assert.ok(pulled, 'achou o conteúdo da chave');
  assert.equal(
    pulled.payload.learnedProfiles.find((profile) => !profile.builtIn)?.name,
    'Itaú — Recebimentos'
  );
});

test('chaves diferentes não se enxergam (isolamento entre usuários)', async () => {
  const backend = fakeBackend();
  const ana = await restoreIdentityFromCode('ABCDEFGH', { iterations: FAST });
  const bruno = await restoreIdentityFromCode('ZYXWVUTS', { iterations: FAST });

  assert.notEqual(ana.slot, bruno.slot);

  await pushVault({
    config: CONFIG,
    identity: ana,
    memory: memoryWithProfile('Layout da Ana'),
    fetchImpl: backend.fetchImpl,
    iterations: FAST,
  });

  const doBruno = await pullVault({ config: CONFIG, identity: bruno, fetchImpl: backend.fetchImpl, iterations: FAST });
  assert.equal(doBruno, null, 'Bruno não tem nada no slot dele');

  await pushVault({
    config: CONFIG,
    identity: bruno,
    memory: memoryWithProfile('Layout do Bruno'),
    fetchImpl: backend.fetchImpl,
    iterations: FAST,
  });

  const daAna = await pullVault({ config: CONFIG, identity: ana, fetchImpl: backend.fetchImpl, iterations: FAST });
  assert.equal(daAna.payload.learnedProfiles.find((profile) => !profile.builtIn)?.name, 'Layout da Ana');
  assert.equal(backend.rows.size, 2, 'um cofre por chave');
});

test('quem tem a anon key mas não a chave só vê texto cifrado', async () => {
  const backend = fakeBackend();
  const identity = await restoreIdentityFromCode('ABCDEFGH', { iterations: FAST });

  await pushVault({
    config: CONFIG,
    identity,
    memory: memoryWithProfile('Confidencial'),
    fetchImpl: backend.fetchImpl,
    iterations: FAST,
  });

  // Simula o "select *" sem filtro que o dono do projeto poderia fazer.
  const response = await backend.fetchImpl(`${CONFIG.url}/rest/v1/conversor_models?select=*`);
  const rows = await response.json();
  assert.equal(rows.length, 1);

  const cipherText = rows[0].payload;
  await assert.rejects(async () => {
    const { decryptPayload } = await import('../src/sync-crypto.js');
    const wrong = await restoreIdentityFromCode('ZYXWVUTS', { iterations: FAST });
    await decryptPayload(wrong.aesKey, cipherText);
  });
  assert.equal(cipherText.includes('Confidencial'), false);
});

test('envio exige banco configurado e chave de acesso', async () => {
  const backend = fakeBackend();
  const identity = await restoreIdentityFromCode('ABCDEFGH', { iterations: FAST });

  await assert.rejects(
    () => pushVault({ config: {}, identity, memory: memoryWithProfile(), fetchImpl: backend.fetchImpl, iterations: FAST }),
    /Configure o banco/i
  );
  await assert.rejects(
    () => pushVault({ config: CONFIG, identity: null, memory: memoryWithProfile(), fetchImpl: backend.fetchImpl, iterations: FAST }),
    /chave de acesso/i
  );
  await assert.rejects(
    () => pullVault({ config: CONFIG, identity: { code: 'ABCDEFGH' }, fetchImpl: backend.fetchImpl, iterations: FAST }),
    /chave de acesso/i
  );
});

test('tabela ausente vira mensagem de ação (rodar o SQL)', async () => {
  const notFound = async () => jsonResponse(404, { message: 'relation does not exist' });
  const identity = await restoreIdentityFromCode('ABCDEFGH', { iterations: FAST });

  await assert.rejects(
    () => pushVault({ config: CONFIG, identity, memory: memoryWithProfile(), fetchImpl: notFound, iterations: FAST }),
    (error) => {
      assert.match(error.message, /conversor_models/);
      // A UI usa este código para oferecer o SQL de instalação na aba Nuvem.
      assert.equal(error.code, 'TABLE_MISSING');
      return true;
    }
  );

  const forbidden = async () => jsonResponse(401, { message: 'bad key' });
  await assert.rejects(
    () => pullVault({ config: CONFIG, identity, fetchImpl: forbidden, iterations: FAST }),
    /Chave anônima recusada/i
  );
});

/* -------------------------------------------------------------------------- */
/*              Memória de layout e OCR guardada no banco (cifrada)           */
/* -------------------------------------------------------------------------- */

function signatureOf(name, lastUsedAt, usageCount = 1) {
  return {
    id: `sig-${name.toLowerCase()}`,
    signature: name.toLowerCase(),
    headers: ['data', name.toLowerCase()],
    roles: [
      { header: 'data', role: 'date', historyOrder: 0 },
      { header: name.toLowerCase(), role: 'history', historyOrder: 1 },
    ],
    name,
    fileType: 'pdf',
    usageCount,
    createdAt: '2026-10-01T10:00:00.000Z',
    lastUsedAt,
  };
}

function ocrRunOf(fileName, createdAt, rowCount = 3) {
  return {
    id: `ocr-${fileName}`,
    fileName,
    fileType: 'pdf',
    pageCount: 1,
    pagesRead: 1,
    confidence: 92,
    headers: ['data', 'valor'],
    rowCount,
    truncated: false,
    createdAt,
  };
}

test('o pacote leva as assinaturas de layout e as leituras de OCR', () => {
  const memory = memoryWithProfile('Layout da equipe');
  memory.layoutSignatures = [signatureOf('Itaú', '2026-11-10T10:00:00.000Z')];
  memory.ocrRuns = [ocrRunOf('extrato-escaneado.pdf', '2026-11-10T11:00:00.000Z')];

  const payload = buildVaultPayload(memory);

  assert.equal(payload.layoutSignatures.length, 1);
  assert.equal(payload.layoutSignatures[0].name, 'Itaú');
  assert.equal(payload.ocrRuns.length, 1);
  assert.equal(payload.ocrRuns[0].confidence, 92);
  assert.equal('optionalLlm' in payload, false, 'a chave do LLM continua só no navegador');
});

test('aplicar o pacote restaura layout e OCR sem tocar na chave local', () => {
  const local = memoryWithProfile();
  local.optionalLlm = { provider: 'groq', apiKey: 'gsk_local', model: '' };
  const remote = buildVaultPayload({
    ...memoryWithProfile('Layout da equipe'),
    layoutSignatures: [signatureOf('Bradesco', '2026-11-09T10:00:00.000Z')],
    ocrRuns: [ocrRunOf('extrato.pdf', '2026-11-09T12:00:00.000Z', 8)],
  });

  const restored = applyVaultPayload(local, remote);
  assert.equal(restored.layoutSignatures.length, 1);
  assert.equal(restored.layoutSignatures[0].name, 'Bradesco');
  assert.equal(restored.ocrRuns.length, 1);
  assert.equal(restored.ocrRuns[0].rowCount, 8);
  assert.equal(restored.optionalLlm.apiKey, 'gsk_local');
  assert.equal(restored.optionalLlm.provider, 'groq');
});

test('a sincronização soma layouts e leituras dos dois lados', () => {
  const local = memoryWithProfile();
  local.layoutSignatures = [
    signatureOf('Itaú', '2026-11-11T09:00:00.000Z', 3),
    signatureOf('Sicoob', '2026-11-05T09:00:00.000Z', 1),
  ];
  local.ocrRuns = [
    ocrRunOf('extrato-itau.pdf', '2026-11-11T10:00:00.000Z', 12),
    ocrRunOf('extrato-antigo.pdf', '2026-11-01T10:00:00.000Z', 4),
  ];

  const remotePayload = buildVaultPayload({
    ...memoryWithProfile('Layout da equipe'),
    layoutSignatures: [
      // Mesma assinatura daqui, com contagem maior: o uso é somado pelo maior.
      signatureOf('Itaú', '2026-11-10T09:00:00.000Z', 7),
      signatureOf('Bradesco', '2026-11-08T09:00:00.000Z', 2),
    ],
    ocrRuns: [
      // Mesmo arquivo, leitura mais nova do outro computador.
      ocrRunOf('extrato-itau.pdf', '2026-11-11T12:00:00.000Z', 15),
      ocrRunOf('extrato-novo.pdf', '2026-11-10T10:00:00.000Z', 6),
    ],
  });

  const merged = mergeVaultPayload(local, remotePayload);

  const nomes = merged.layoutSignatures.map((signature) => signature.name).sort();
  assert.deepEqual(nomes, ['Bradesco', 'Itaú', 'Sicoob']);
  const itau = merged.layoutSignatures.find((signature) => signature.name === 'Itaú');
  assert.equal(itau.usageCount, 7);

  const arquivos = merged.ocrRuns.map((run) => run.fileName).sort();
  assert.deepEqual(arquivos, ['extrato-antigo.pdf', 'extrato-itau.pdf', 'extrato-novo.pdf']);
  const itauRun = merged.ocrRuns.find((run) => run.fileName === 'extrato-itau.pdf');
  assert.equal(itauRun.rowCount, 15, 'vale a leitura mais recente');
});

test('o pacote continua cifrado: nenhum conteúdo de layout vai em claro', async () => {
  const backend = fakeBackend();
  const memory = memoryWithProfile('Layout secreto do cliente');
  memory.layoutSignatures = [signatureOf('Itaú', '2026-11-10T10:00:00.000Z')];
  memory.ocrRuns = [ocrRunOf('extrato-confidencial.pdf', '2026-11-10T11:00:00.000Z')];

  const identity = await restoreIdentityFromCode('ABCDEFGH', { iterations: FAST });
  await pushVault({
    config: CONFIG,
    identity,
    memory,
    iterations: FAST,
    fetchImpl: backend.fetchImpl,
  });

  const stored = JSON.stringify([...backend.rows.values()]);
  assert.equal(stored.includes('Layout secreto do cliente'), false);
  assert.equal(stored.includes('extrato-confidencial.pdf'), false);
});
