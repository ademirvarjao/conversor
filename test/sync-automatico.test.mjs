/**
 * Sincronização automática com a nuvem.
 *
 * O usuário não tem mais botão de "Enviar modelos" / "Baixar modelos": o envio
 * acontece depois de cada treinamento e o download na abertura do app. Como o
 * download deixou de ser um gesto dele, o pacote da nuvem é **somado** ao que
 * existe na máquina (`mergeVaultPayload`) — substituir apagaria um treinamento
 * feito sem rede.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { normalizeMemory } from '../src/ai-engine.js';
import { mergeVaultPayload, pullVault, pushVault, restoreIdentityFromCode } from '../src/sync-vault.js';

const ROOT = new URL('../', import.meta.url);

/** Iterações baixas: o teste valida o fluxo, não o custo do PBKDF2. */
const FAST = 1000;
const CONFIG = { url: 'https://projeto-exemplo.supabase.co', anonKey: 'a'.repeat(40) };

/** PostgREST falso: guarda uma linha por slot e entende GET/POST do app. */
function fakeBackend() {
  const rows = new Map();
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname !== '/rest/v1/conversor_models') {
      return { ok: false, status: 404, json: async () => ({ message: 'not found' }) };
    }
    if ((init.method || 'GET') === 'GET') {
      const filter = parsed.searchParams.get('slot') || '';
      const slot = filter.startsWith('eq.') ? decodeURIComponent(filter.slice(3)) : '';
      const row = rows.get(slot);
      return { ok: true, status: 200, json: async () => (row ? [{ payload: row.payload, updated_at: row.updated_at }] : []) };
    }
    const body = JSON.parse(init.body || '[]');
    for (const item of body) rows.set(item.slot, { payload: item.payload, updated_at: item.updated_at });
    return { ok: true, status: 201, json: async () => [] };
  };
  return { rows, fetchImpl };
}

/** Perfil de layout válido para a memória. */
function profile(id, name, lastUsedAt) {
  return {
    id,
    name,
    fileType: 'pdf',
    headers: ['data', 'valor'],
    mappings: [
      { header: 'data', role: 'date', historyOrder: 1 },
      { header: 'valor', role: 'amount', historyOrder: 2 },
    ],
    rules: { defaultSign: 'auto' },
    createdAt: lastUsedAt,
    lastUsedAt,
  };
}

function memoryWith({ profiles = [], log = [], tokens = {}, counterparties = {}, llm } = {}) {
  const memory = normalizeMemory({});
  memory.learnedProfiles = [...memory.learnedProfiles.filter((item) => item.builtIn), ...profiles];
  memory.learningLog = log;
  memory.tokenWeights = tokens;
  if (Object.keys(counterparties).length) memory.counterparties = counterparties;
  if (llm) memory.optionalLlm = llm;
  return normalizeMemory(memory);
}

const learnedNames = (memory) => memory.learnedProfiles.filter((item) => !item.builtIn).map((item) => item.name);

describe('mergeVaultPayload', () => {
  it('soma os layouts das duas máquinas em vez de trocar um pelo outro', () => {
    const local = memoryWith({ profiles: [profile('prof-a', 'Layout daqui', '2026-11-01T10:00:00.000Z')] });
    const remote = memoryWith({ profiles: [profile('prof-b', 'Layout do escritório', '2026-11-02T10:00:00.000Z')] });

    const merged = mergeVaultPayload(local, { learnedProfiles: remote.learnedProfiles });

    assert.deepEqual(learnedNames(merged).sort(), ['Layout daqui', 'Layout do escritório']);
  });

  it('no mesmo perfil (mesmo id) fica o usado por último, de que lado estiver', () => {
    const antigo = memoryWith({ profiles: [profile('prof-a', 'Nome antigo', '2026-11-01T10:00:00.000Z')] });
    const novo = memoryWith({ profiles: [profile('prof-a', 'Nome novo', '2026-11-05T10:00:00.000Z')] });

    // Nuvem mais recente vence o que está aqui.
    const daNuvem = mergeVaultPayload(antigo, { learnedProfiles: novo.learnedProfiles });
    assert.deepEqual(learnedNames(daNuvem), ['Nome novo']);

    // Aqui mais recente vence o que veio da nuvem.
    const daqui = mergeVaultPayload(novo, { learnedProfiles: antigo.learnedProfiles });
    assert.deepEqual(learnedNames(daqui), ['Nome novo']);
    assert.equal(daqui.learnedProfiles.filter((item) => item.id === 'prof-a').length, 1);
  });

  it('junta o histórico de aprendizado sem duplicar', () => {
    const entrada = (id, timestamp, message) => ({ id, timestamp, type: 'train', message, details: '' });
    const local = memoryWith({ log: [entrada('log-1', '2026-11-01T10:00:00.000Z', 'treinou aqui')] });
    const remote = memoryWith({
      log: [
        entrada('log-1', '2026-11-01T10:00:00.000Z', 'treinou aqui'),
        entrada('log-2', '2026-11-03T10:00:00.000Z', 'treinou no escritório'),
      ],
    });

    const merged = mergeVaultPayload(local, { learningLog: remote.learningLog });
    assert.deepEqual(
      merged.learningLog.map((item) => item.id).sort(),
      ['log-1', 'log-2']
    );
    assert.ok(merged.learningLog[0].timestamp >= merged.learningLog[1].timestamp, 'mais recente primeiro');
  });

  it('cada palavra-chave fica com o maior peso dos dois lados', () => {
    // Pesos calibrados abaixo dos de fábrica (`recebimento` já vem com 1.8 para
    // data), para o teste enxergar o valor que veio de cada lado.
    const local = memoryWith({ tokens: { plasttotal: { history: 3.5 }, light: { history: 2.2 } } });
    const remote = memoryWith({ tokens: { plasttotal: { history: 5 }, rodovias: { history: 4.4 } } });

    const merged = mergeVaultPayload(local, { tokenWeights: remote.tokenWeights });

    assert.equal(merged.tokenWeights.plasttotal.history, 5, 'maior peso entre os dois lados');
    assert.equal(merged.tokenWeights.light.history, 2.2, 'só existe aqui, fica');
    assert.equal(merged.tokenWeights.rodovias.history, 4.4, 'só existe na nuvem, fica');
  });

  it('une contas memorizadas, contatos e apelidos dos dois lados', () => {
    const local = memoryWith({
      counterparties: {
        aliases: { 'plasttotal industria': '5086959' },
        tokenWeights: {},
        contacts: { 5086959: { name: 'PLASTTOTAL PLASTICOS', natureza: 'Devedora', hits: 3 } },
        accounts: {
          byHistory: { 'plasttotal industrial': { debit: '', credit: '12345', hits: 2, updatedAt: '2026-11-01T10:00:00.000Z' } },
          byContact: { 5086959: { debit: '500046', credit: '', hits: 1, updatedAt: '2026-11-01T10:00:00.000Z' } },
        },
        uses: 4,
        updatedAt: '2026-11-01T10:00:00.000Z',
      },
    });
    const remote = memoryWith({
      counterparties: {
        aliases: { 'light servicos': '998877' },
        tokenWeights: {},
        contacts: { 998877: { name: 'LIGHT SERVICOS', natureza: 'Credora', hits: 1 }, 5086959: { name: 'PLASTTOTAL PLASTICOS', natureza: 'Devedora', hits: 9 } },
        accounts: {
          byHistory: { 'light energia': { debit: '301', credit: '', hits: 5, updatedAt: '2026-11-09T10:00:00.000Z' } },
          byContact: { 998877: { debit: '', credit: '302', hits: 2, updatedAt: '2026-11-09T10:00:00.000Z' } },
        },
        uses: 6,
        updatedAt: '2026-11-09T10:00:00.000Z',
      },
    });

    const merged = mergeVaultPayload(local, { counterparties: remote.counterparties });

    assert.equal(merged.counterparties.aliases['plasttotal industria'], '5086959');
    assert.equal(merged.counterparties.aliases['light servicos'], '998877');
    assert.equal(merged.counterparties.accounts.byHistory['plasttotal industrial'].credit, '12345');
    assert.equal(merged.counterparties.accounts.byHistory['light energia'].debit, '301');
    assert.equal(merged.counterparties.accounts.byContact[998877].credit, '302');
    assert.equal(merged.counterparties.contacts[5086959].hits, 9, 'hits somam pelo maior');
    assert.equal(merged.counterparties.uses, 6);
  });

  it('preserva a chave do LLM e as preferências que nunca sobem para a nuvem', () => {
    const local = memoryWith({ llm: { provider: 'openai', apiKey: 'sk-daqui', model: 'gpt-4o-mini' } });
    local.settings = { communityCatalog: false };

    const merged = mergeVaultPayload(local, { learnedProfiles: [], tokenWeights: {} });

    assert.equal(merged.optionalLlm.apiKey, 'sk-daqui');
    assert.equal(merged.settings.communityCatalog, false);
    assert.equal(JSON.stringify(merged).includes('sk-daqui'), true);
  });

  it('recusa pacote inválido', () => {
    assert.throws(() => mergeVaultPayload(memoryWith(), null), /inválido/i);
    assert.throws(() => mergeVaultPayload(memoryWith(), 'texto'), /inválido/i);
  });
});

describe('ida e volta pela nuvem', () => {
  it('duas máquinas terminam com os modelos das duas (nada é perdido)', async () => {
    const backend = fakeBackend();
    const identity = await restoreIdentityFromCode('ABCDEFGH', { iterations: FAST });

    const maquinaA = memoryWith({ profiles: [profile('prof-a', 'Layout daqui', '2026-11-01T10:00:00.000Z')] });
    const maquinaB = memoryWith({ profiles: [profile('prof-b', 'Layout do escritório', '2026-11-02T10:00:00.000Z')] });

    // A envia o que sabe.
    await pushVault({ config: CONFIG, identity, memory: maquinaA, fetchImpl: backend.fetchImpl, iterations: FAST });

    // B baixa e SOMA ao que já tinha (em vez de substituir), e envia de volta.
    const baixado = await pullVault({ config: CONFIG, identity, fetchImpl: backend.fetchImpl, iterations: FAST });
    const bSomado = mergeVaultPayload(maquinaB, baixado.payload);
    assert.deepEqual(learnedNames(bSomado).sort(), ['Layout daqui', 'Layout do escritório']);
    await pushVault({ config: CONFIG, identity, memory: bSomado, fetchImpl: backend.fetchImpl, iterations: FAST });

    // A, na próxima abertura, recebe o que B tinha.
    const devolta = await pullVault({ config: CONFIG, identity, fetchImpl: backend.fetchImpl, iterations: FAST });
    const aSomado = mergeVaultPayload(maquinaA, devolta.payload);
    assert.deepEqual(learnedNames(aSomado).sort(), ['Layout daqui', 'Layout do escritório']);
  });
});

describe('sincronização sem botões', () => {
  const read = (name) => readFile(new URL(name, ROOT), 'utf8');

  it('index.html não mostra mais os botões de enviar/baixar', async () => {
    const html = await read('index.html');
    for (const id of ['btn-cloud-push', 'btn-cloud-pull']) {
      const tag = new RegExp(`<button[^>]*id="${id}"[^>]*>`).exec(html)?.[0] || '';
      assert.ok(tag, `#${id} continua no HTML (contrato do controlador)`);
      assert.match(tag, /\bhidden\b/, `#${id} está escondido`);
      assert.match(tag, /tabindex="-1"/, `#${id} fora da ordem de tabulação`);
    }
    assert.doesNotMatch(html, /<h3>2\. Sincronizar<\/h3>/, 'o bloco virou texto explicativo');
    assert.match(html, /2\. Sincronização automática/);
  });

  it('conciliador.html esconde os botões e mantém o estado no topo', async () => {
    const html = await read('conciliador.html');
    for (const id of ['btn-cp-cloud-push', 'btn-cp-cloud-pull']) {
      const tag = new RegExp(`<button[^>]*id="${id}"[^>]*>`).exec(html)?.[0] || '';
      assert.ok(tag, `#${id} continua no HTML`);
      assert.match(tag, /\bhidden\b/, `#${id} está escondido`);
    }
    assert.match(html, /id="cp-cloud-state"/, 'o estado da sincronização continua visível');
  });

  it('as duas páginas baixam a nuvem sozinhas e somam à memória local', async () => {
    for (const file of ['src/app.js', 'src/counterparty-page.js']) {
      const code = await read(file);
      assert.match(code, /function scheduleCloudPull\(/, `${file} agenda o download`);
      assert.match(code, /scheduleCloudPull\(\)/, `${file} dispara o download na abertura`);
      assert.match(code, /mergeVaultPayload\(/, `${file} soma em vez de substituir`);
      assert.match(code, /visibilitychange/, `${file} confere a nuvem quando a aba volta`);
      assert.doesNotMatch(code, /applyVaultPayload\(/, `${file} não descarta mais o que existe aqui`);
    }
  });
});
