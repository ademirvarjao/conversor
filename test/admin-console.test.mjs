/**
 * Console do administrador — o painel que qualquer página monta.
 *
 * Sem navegador, o console não pode abrir janela: o que dá para garantir aqui é
 * que ele não quebra, que os dados de uso são gravados no mesmo lugar para as
 * duas páginas, que o resumo da memória sai certo e que tamanho de storage e
 * dados do aparelho não dependem de APIs do navegador.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  USAGE_KEY,
  loadUsage,
  normalizeUsage,
  recordEvent,
  bumpCounter,
  addActiveTime,
} from '../src/admin-usage.js';
import { createAdminConsole, deviceRows, memorySummary, storageSizes } from '../src/admin-console.js';

function fakeStorage(entries = {}) {
  const data = new Map(Object.entries(entries));
  return {
    data,
    get length() {
      return data.size;
    },
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

describe('console sem navegador', () => {
  it('montar não abre nada e não estoura', () => {
    const admin = createAdminConsole({ page: 'teste' });
    assert.equal(admin.mount(), false);
    assert.equal(admin.isOpen(), false);
    assert.equal(admin.isUnlocked(), false);
    assert.equal(admin.open(), false);
    assert.equal(admin.openGate(), false);
    assert.equal(admin.snapshot().page, 'teste');
  });

  it('registrar evento/contador funciona e grava no mesmo registro das duas páginas', () => {
    const storage = fakeStorage();
    globalThis.localStorage = storage;
    try {
      const admin = createAdminConsole({ page: 'conversor' });
      admin.track('arquivo', 'Importação: 2 arquivo(s)', '0 duplicado', 'filesLoaded', 2);
      admin.count('exports', 3);

      const usage = loadUsage(storage);
      assert.equal(usage.events.length, 1);
      assert.equal(usage.events[0].type, 'arquivo');
      assert.equal(usage.counters.filesLoaded, 2);
      assert.equal(usage.counters.exports, 3);
      assert.ok(storage.getItem(USAGE_KEY), 'gravou no localStorage');
    } finally {
      delete globalThis.localStorage;
    }
  });

  it('cada console tem a sua sessão, mas o histórico é o mesmo', () => {
    const storage = fakeStorage();
    globalThis.localStorage = storage;
    try {
      const conversor = createAdminConsole({ page: 'conversor' });
      conversor.track('sessao', 'Página aberta: conversor');
      const conciliador = createAdminConsole({ page: 'conciliador' });
      conciliador.track('sessao', 'Página aberta: conciliador');

      const usage = loadUsage(storage);
      assert.deepEqual(
        usage.events.map((event) => event.message),
        ['Página aberta: conversor', 'Página aberta: conciliador']
      );
    } finally {
      delete globalThis.localStorage;
    }
  });
});

describe('resumo da memória (o que só o painel mostra)', () => {
  it('conta históricos, contatos com conta e contatos do cadastro', () => {
    const summary = memorySummary({
      counterparties: {
        contacts: {
          A: { name: 'Alfa Ltda', natureza: 'credora', hits: 3 },
          B: { name: 'Beta ME', natureza: 'devedora', hits: 1 },
        },
        aliases: { 'pix alfa': 'A' },
        accounts: {
          byHistory: { 'pix alfa': { debit: '', credit: '500046', hits: 3 } },
          byContact: { A: { debit: '', credit: '500046', hits: 3 } },
        },
      },
    });
    assert.equal(summary.byHistory, 1);
    assert.equal(summary.byContact, 1);
    assert.equal(summary.contacts, 2);
    assert.equal(summary.text, 'Memória: 1 histórico(s) • 1 contato(s) com conta • 2 contato(s) conciliado(s)');
  });

  it('sem contato no cadastro, o texto para antes do último item', () => {
    const summary = memorySummary({
      counterparties: {
        contacts: {},
        accounts: { byHistory: { 'pix alfa': { debit: '1', credit: '', hits: 1 } }, byContact: {} },
      },
    });
    assert.equal(summary.text, 'Memória: 1 histórico(s) • 0 contato(s) com conta');
    assert.equal(summary.text.includes('conciliado'), false);
  });

  it('memória vazia ou quebrada não vira "undefined"', () => {
    for (const memory of [null, undefined, {}, { counterparties: 'x' }, { counterparties: { contacts: [] } }]) {
      const summary = memorySummary(memory);
      assert.equal(summary.text, 'Memória: nenhuma conta memorizada ainda');
      assert.equal(Number.isNaN(summary.total), false);
    }
  });
});

describe('dados do aparelho e do armazenamento', () => {
  it('lê o tamanho de cada chave sem expor o conteúdo', () => {
    const storage = fakeStorage({
      conversor_ai_memory_v1: 'x'.repeat(2048),
      conversor_admin_usage_v1: 'y'.repeat(1024),
      outra: 'z'.repeat(10),
    });
    const sizes = storageSizes(storage);
    assert.equal(sizes.memory, '2,0 KB');
    assert.equal(sizes.usage, '1,0 KB');
    assert.equal(sizes.keys, 3);
    assert.match(sizes.total, /KB$/);
  });

  it('sem armazenamento (modo privado), devolve travessões', () => {
    const sizes = storageSizes({ get length() { throw new Error('bloqueado'); } });
    assert.equal(sizes.memory, '—');
    assert.equal(sizes.total, '—');
  });

  it('identifica navegador, sistema e tela sem pedir permissão', () => {
    const janela = {
      navigator: {
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
        language: 'pt-BR',
        hardwareConcurrency: 8,
        deviceMemory: 8,
        maxTouchPoints: 0,
        connection: { effectiveType: '4g' },
      },
      screen: { width: 1920, height: 1080 },
      innerWidth: 1280,
      innerHeight: 720,
      devicePixelRatio: 1.25,
      location: { pathname: '/conversor/conciliador.html' },
    };
    const rows = Object.fromEntries(deviceRows(janela));
    assert.equal(rows.Navegador, 'Chrome');
    assert.equal(rows.Sistema, 'Windows');
    assert.equal(rows.Idioma, 'pt-BR');
    assert.equal(rows.Tela, '1920×1080 (janela 1280×720)');
    assert.equal(rows['Núcleos de CPU'], '8');
    assert.equal(rows.Conexão, '4G');
    assert.equal(rows.Página, 'conversor/conciliador.html');
    assert.equal(rows.Toque, 'não');
  });

  it('não confunde Safari com Chrome nem Android com Linux', () => {
    const safari = Object.fromEntries(
      deviceRows({
        navigator: {
          userAgent:
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        },
        screen: { width: 1440, height: 900 },
        innerWidth: 1200,
        innerHeight: 800,
      })
    );
    assert.equal(safari.Navegador, 'Safari');
    assert.equal(safari.Sistema, 'macOS');

    const android = Object.fromEntries(
      deviceRows({
        navigator: {
          userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Mobile Safari/537.36',
          maxTouchPoints: 5,
        },
        screen: { width: 412, height: 915 },
        innerWidth: 412,
        innerHeight: 915,
      })
    );
    assert.equal(android.Sistema, 'Android');
    assert.equal(android.Toque, 'sim (5 ponto(s))');
  });
});

describe('o painel alimenta o registro de uso', () => {
  it('tempo ativo é somado no dia (não em segundo plano)', () => {
    const usage = normalizeUsage(null, 1_800_000_000_000);
    addActiveTime(usage, 60_000, 1_800_000_000_000);
    assert.equal(usage.activeMs, 60_000);
    const stored = fakeStorage();
    stored.setItem(USAGE_KEY, JSON.stringify(usage));
    assert.equal(loadUsage(stored).activeMs, 60_000);
  });

  it('evento e contador convivem na mesma gravação', () => {
    const usage = normalizeUsage(null, 1_800_000_000_000);
    recordEvent(usage, { type: 'exportacao', message: 'PDF gerado' }, 1_800_000_000_000);
    bumpCounter(usage, 'exports', 1, 1_800_000_000_000);
    assert.equal(usage.events.length, 1);
    assert.equal(usage.counters.exports, 1);
  });
});
