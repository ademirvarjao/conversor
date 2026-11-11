import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  CATALOG_STORAGE_KEY,
  CATALOG_TTL_MS,
  COMMUNITY_LAYOUTS_URL,
  fetchCommunityLayouts,
  isCatalogFresh,
  loadCatalog,
  sanitizeCatalogPayload,
  saveCatalog,
} from '../src/layout-registry.js';

/** `localStorage` de mentira, só com o que o módulo usa. */
function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    get size() {
      return data.size;
    },
  };
}

const payload = {
  schema: 1,
  generatedAt: '2026-11-11T00:00:00.000Z',
  layouts: [
    {
      id: 'banco-x',
      name: 'Banco X',
      columns: [
        { match: '^data', role: 'date' },
        { match: 'historico', role: 'history' },
        { match: 'valor', role: 'value_auto' },
      ],
    },
    { id: 'quebrado', columns: [] },
    'lixo',
  ],
};

describe('catálogo público de layouts', () => {
  it('valida o JSON e descarta entradas inválidas', () => {
    const clean = sanitizeCatalogPayload(payload);
    assert.equal(clean.layouts.length, 1);
    assert.equal(clean.layouts[0].id, 'banco-x');
    assert.equal(clean.layouts[0].source, 'community');
    assert.equal(clean.generatedAt, '2026-11-11T00:00:00.000Z');
  });

  it('aguenta payload vazio/estranho', () => {
    assert.deepEqual(sanitizeCatalogPayload(null).layouts, []);
    assert.deepEqual(sanitizeCatalogPayload({ layouts: 'x' }).layouts, []);
    assert.deepEqual(sanitizeCatalogPayload([]).layouts, []);
  });

  it('o arquivo do repositório é válido (contribuição por PR)', async () => {
    const raw = await readFile(new URL('../layouts/comunidade.json', import.meta.url), 'utf8');
    const clean = sanitizeCatalogPayload(JSON.parse(raw));
    assert.ok(clean.layouts.length >= 3, `${clean.layouts.length} layouts no catálogo público`);
    for (const layout of clean.layouts) {
      assert.ok(layout.name, `${layout.id} tem nome`);
      assert.ok(layout.columns.some((column) => column.role === 'date'), `${layout.id} tem data`);
      assert.ok(
        layout.columns.some((column) => ['value_in', 'value_out', 'value_auto'].includes(column.role)),
        `${layout.id} tem valor`
      );
    }
    // Nenhum dado financeiro no arquivo público: só nomes de coluna e papéis.
    const text = JSON.stringify(clean.layouts);
    assert.doesNotMatch(text, /\d{2}\/\d{2}\/\d{4}/, 'sem datas');
    assert.doesNotMatch(text, /\d+,\d{2}/, 'sem valores');
  });

  it('guarda e relê o catálogo do navegador', () => {
    const storage = fakeStorage();
    assert.equal(loadCatalog(storage), null);

    saveCatalog({ layouts: sanitizeCatalogPayload(payload).layouts, fetchedAt: 1000, url: 'u' }, storage);
    const loaded = loadCatalog(storage);
    assert.equal(loaded.layouts.length, 1);
    assert.equal(loaded.fetchedAt, 1000);
    assert.equal(loaded.url, 'u');
    assert.ok(storage.getItem(CATALOG_STORAGE_KEY));
  });

  it('sabe quando o catálogo está velho', () => {
    const now = 10 * CATALOG_TTL_MS;
    assert.equal(isCatalogFresh({ layouts: [{}], fetchedAt: now - 1000 }, now), true);
    assert.equal(isCatalogFresh({ layouts: [{}], fetchedAt: now - CATALOG_TTL_MS - 1 }, now), false);
    assert.equal(isCatalogFresh({ layouts: [], fetchedAt: now }, now), false);
    assert.equal(isCatalogFresh(null, now), false);
  });

  it('baixa o catálogo sem enviar nada do arquivo', async () => {
    const storage = fakeStorage();
    let seen = null;
    const fetchImpl = async (url, options) => {
      seen = { url, options };
      return { ok: true, status: 200, json: async () => payload };
    };

    const result = await fetchCommunityLayouts({ fetchImpl, storage, now: 1234 });

    assert.equal(result.ok, true);
    assert.equal(result.layouts.length, 1);
    assert.equal(result.fromCache, false);
    assert.equal(seen.url, COMMUNITY_LAYOUTS_URL);
    assert.equal(seen.options.method, 'GET');
    assert.equal(seen.options.credentials, 'omit');
    assert.equal(seen.options.body, undefined, 'sem corpo na requisição');
    assert.doesNotMatch(seen.url, /\?/, 'sem query string (nada do extrato vai na URL)');
    assert.equal(loadCatalog(storage).layouts.length, 1, 'ficou em cache');
  });

  it('erro de rede cai no cache em vez de quebrar', async () => {
    const storage = fakeStorage();
    saveCatalog({ layouts: sanitizeCatalogPayload(payload).layouts, fetchedAt: Date.now(), url: 'u' }, storage);

    const result = await fetchCommunityLayouts({
      fetchImpl: async () => {
        throw new Error('offline');
      },
      storage,
    });

    assert.equal(result.ok, false);
    assert.equal(result.fromCache, true);
    assert.equal(result.layouts.length, 1);
    assert.match(result.error, /offline/);
  });

  it('HTTP de erro e catálogo vazio são tratados', async () => {
    const storage = fakeStorage();
    const http500 = await fetchCommunityLayouts({
      fetchImpl: async () => ({ ok: false, status: 500 }),
      storage,
    });
    assert.equal(http500.ok, false);
    assert.match(http500.error, /HTTP 500/);

    const vazio = await fetchCommunityLayouts({
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ layouts: [] }) }),
      storage,
    });
    assert.equal(vazio.ok, false);
    assert.match(vazio.error, /vazio|inválido/);
  });

  it('sem fetch disponível, avisa e usa o cache', async () => {
    const storage = fakeStorage();
    const result = await fetchCommunityLayouts({ fetchImpl: null, storage });
    assert.equal(result.ok, false);
    assert.match(result.error, /não permite requisições/);
  });
});
