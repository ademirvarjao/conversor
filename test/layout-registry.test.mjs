import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  CATALOG_BACKUP_KEY,
  CATALOG_REVALIDATE_MS,
  CATALOG_SOURCES,
  CATALOG_STORAGE_KEY,
  CATALOG_TTL_MS,
  COMMUNITY_LAYOUTS_URL,
  catalogSources,
  fetchCommunityLayouts,
  fingerprintLayouts,
  isCatalogFresh,
  loadCatalog,
  mergeCatalogLayouts,
  parseCatalogFile,
  sanitizeCatalogPayload,
  saveCatalog,
  serializeCatalog,
  shouldRevalidate,
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
      updatedAt: '2026-11-10T00:00:00.000Z',
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

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe('catálogo público — validação', () => {
  it('valida o JSON e descarta entradas inválidas', () => {
    const clean = sanitizeCatalogPayload(payload);
    assert.equal(clean.layouts.length, 1);
    assert.equal(clean.layouts[0].id, 'banco-x');
    assert.equal(clean.layouts[0].source, 'community');
    assert.equal(clean.layouts[0].updatedAt, '2026-11-10T00:00:00.000Z');
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
});

describe('catálogo público — fontes', () => {
  it('tenta o próprio site primeiro e deixa o GitHub como último recurso', () => {
    const ids = catalogSources({ location: { protocol: 'https:' } }).map((source) => source.id);
    assert.deepEqual(ids, ['same-origin', 'jsdelivr', 'github-raw']);
    assert.equal(CATALOG_SOURCES.at(-1).url, COMMUNITY_LAYOUTS_URL);

    const sameOrigin = CATALOG_SOURCES[0];
    assert.equal(sameOrigin.sameOrigin, true);
    assert.doesNotMatch(sameOrigin.url, /^https?:/, 'caminho relativo: vale em qualquer fork');
  });

  it('em file:// não usa a mesma origem nem o CDN (CORS bloqueado)', () => {
    const ids = catalogSources({ location: { protocol: 'file:' } }).map((source) => source.id);
    assert.deepEqual(ids, ['github-raw']);
  });

  it('coloca a fonte que funcionou por último na frente', () => {
    const ids = catalogSources({
      location: { protocol: 'https:' },
      preferredSource: 'github-raw',
    }).map((source) => source.id);
    assert.deepEqual(ids, ['github-raw', 'same-origin', 'jsdelivr']);
  });

  it('respeita uma lista explícita (testes / auto-hospedagem)', () => {
    const sources = [{ id: 'local', label: 'local', url: './x.json' }];
    assert.deepEqual(catalogSources({ sources }), sources);
  });
});

describe('catálogo público — persistência', () => {
  it('guarda, relê e mantém cópia de segurança', () => {
    const storage = fakeStorage();
    assert.equal(loadCatalog(storage), null);

    assert.equal(
      saveCatalog(
        {
          layouts: sanitizeCatalogPayload(payload).layouts,
          fetchedAt: 1000,
          url: 'u',
          sourceId: 'same-origin',
        },
        storage
      ),
      true
    );

    const loaded = loadCatalog(storage);
    assert.equal(loaded.layouts.length, 1);
    assert.equal(loaded.fetchedAt, 1000);
    assert.equal(loaded.url, 'u');
    assert.equal(loaded.sourceId, 'same-origin');
    assert.ok(loaded.fingerprint);
    assert.ok(storage.getItem(CATALOG_STORAGE_KEY));
    assert.ok(storage.getItem(CATALOG_BACKUP_KEY), 'cópia de segurança gravada');

    // Registro principal corrompido: a cópia de segurança salva o dia.
    storage.setItem(CATALOG_STORAGE_KEY, '{quebrado');
    assert.equal(loadCatalog(storage).layouts.length, 1);
  });

  it('sabe quando o catálogo está velho e quando revalidar', () => {
    const now = 10 * CATALOG_TTL_MS;
    assert.equal(isCatalogFresh({ layouts: [{}], fetchedAt: now - 1000 }, now), true);
    assert.equal(isCatalogFresh({ layouts: [{}], fetchedAt: now - CATALOG_TTL_MS - 1 }, now), false);
    assert.equal(isCatalogFresh({ layouts: [], fetchedAt: now }, now), false);
    assert.equal(isCatalogFresh(null, now), false);

    assert.equal(shouldRevalidate(null, now), true);
    assert.equal(shouldRevalidate({ layouts: [{}], fetchedAt: now - 1000 }, now), false);
    assert.equal(shouldRevalidate({ layouts: [{}], fetchedAt: now - CATALOG_REVALIDATE_MS }, now), true);
  });

  it('detecta mudança pelo fingerprint e prefere a versão mais nova no merge', () => {
    const base = sanitizeCatalogPayload(payload).layouts;
    assert.equal(fingerprintLayouts(base), fingerprintLayouts(base));
    assert.notEqual(fingerprintLayouts(base), fingerprintLayouts([{ ...base[0], name: 'Outro Nome' }]));

    const antigo = { ...base[0], name: 'Antigo', updatedAt: '2026-01-01T00:00:00.000Z' };
    const novo = { ...base[0], name: 'Novo', updatedAt: '2026-06-01T00:00:00.000Z' };
    assert.equal(mergeCatalogLayouts([antigo], [novo])[0].name, 'Novo');
    assert.equal(mergeCatalogLayouts([novo], [antigo])[0].name, 'Novo');
    assert.equal(mergeCatalogLayouts([], [novo]).length, 1);
    assert.equal(mergeCatalogLayouts([novo], []).length, 1, 'catálogo vazio não apaga o que já existe');
  });
});

describe('catálogo público — download', () => {
  it('baixa da mesma origem, sem corpo, sem query e sem credencial', async () => {
    const storage = fakeStorage();
    const seen = [];
    const fetchImpl = async (url, options) => {
      seen.push({ url, options });
      return jsonResponse(payload);
    };

    const result = await fetchCommunityLayouts({
      fetchImpl,
      storage,
      now: 1234,
      location: { protocol: 'https:' },
    });

    assert.equal(result.ok, true);
    assert.equal(result.layouts.length, 1);
    assert.equal(result.sourceId, 'same-origin');
    assert.equal(result.sourceLabel, 'próprio site');
    assert.equal(result.changed, true);
    assert.equal(seen.length, 1, 'primeira fonte já respondeu');
    assert.equal(seen[0].url, 'layouts/comunidade.json');
    assert.equal(seen[0].options.method, 'GET');
    assert.equal(seen[0].options.credentials, 'omit');
    assert.equal(seen[0].options.body, undefined, 'sem corpo na requisição');
    assert.doesNotMatch(seen[0].url, /\?/, 'sem query string (nada do extrato vai na URL)');
    assert.equal(loadCatalog(storage).layouts.length, 1, 'ficou em cache');
  });

  it('se a primeira fonte falha, cai para a próxima (failover)', async () => {
    const storage = fakeStorage();
    const tentadas = [];
    const fetchImpl = async (url) => {
      tentadas.push(url);
      if (tentadas.length === 1) throw new Error('sem rede');
      if (tentadas.length === 2) return jsonResponse({}, 503);
      return jsonResponse(payload);
    };

    const result = await fetchCommunityLayouts({
      fetchImpl,
      storage,
      location: { protocol: 'https:' },
    });

    assert.equal(result.ok, true);
    assert.equal(result.sourceId, 'github-raw');
    assert.deepEqual(
      result.attempts.map((attempt) => attempt.id),
      ['same-origin', 'jsdelivr', 'github-raw']
    );
    assert.match(result.attempts[0].error, /sem rede/);
    assert.match(result.attempts[1].error, /HTTP 503/);
  });

  it('304 (ETag) mantém o catálogo e só atualiza a data da verificação', async () => {
    const storage = fakeStorage();
    saveCatalog(
      { layouts: sanitizeCatalogPayload(payload).layouts, fetchedAt: 100, sourceId: 'same-origin' },
      storage
    );

    const result = await fetchCommunityLayouts({
      fetchImpl: async () => ({ ok: false, status: 304 }),
      storage,
      now: 5000,
      location: { protocol: 'https:' },
    });

    assert.equal(result.ok, true);
    assert.equal(result.unchanged, true);
    assert.equal(result.changed, false);
    assert.equal(result.fetchedAt, 5000);
    assert.equal(loadCatalog(storage).fetchedAt, 5000);
    assert.equal(loadCatalog(storage).layouts.length, 1);
  });

  it('todas as fontes fora: erro claro e catálogo antigo preservado', async () => {
    const storage = fakeStorage();
    saveCatalog({ layouts: sanitizeCatalogPayload(payload).layouts, fetchedAt: 100 }, storage);

    const result = await fetchCommunityLayouts({
      fetchImpl: async () => {
        throw new Error('offline');
      },
      storage,
      location: { protocol: 'https:' },
    });

    assert.equal(result.ok, false);
    assert.equal(result.layouts.length, 1, 'continua com o que já tinha');
    assert.equal(result.attempts.length, 3);
    assert.match(result.error, /próprio site: offline/);
    assert.equal(loadCatalog(storage).fetchedAt, 100, 'não apaga o cache bom');
  });

  it('catálogo vazio e navegador sem fetch são tratados', async () => {
    const storage = fakeStorage();
    const vazio = await fetchCommunityLayouts({
      fetchImpl: async () => jsonResponse({ layouts: [] }),
      storage,
      location: { protocol: 'https:' },
    });
    assert.equal(vazio.ok, false);
    assert.match(vazio.error, /vazio ou inválido/);

    const semFetch = await fetchCommunityLayouts({ fetchImpl: null, storage });
    assert.equal(semFetch.ok, false);
    assert.match(semFetch.error, /não permite requisições/);
  });
});

describe('catálogo público — portabilidade', () => {
  it('exporta e reimporta (máquina sem internet / kit da equipe)', () => {
    const layouts = sanitizeCatalogPayload(payload).layouts;
    const json = serializeCatalog(layouts);
    const parsedJson = JSON.parse(json);

    assert.equal(parsedJson.schema, 1);
    assert.equal(parsedJson.layouts[0].id, 'banco-x');
    assert.deepEqual(Object.keys(parsedJson.layouts[0].columns[0]).sort(), ['match', 'role']);

    const importado = parseCatalogFile(json);
    assert.equal(importado.ok, true);
    assert.equal(importado.layouts.length, 1);
    assert.equal(importado.layouts[0].source, 'imported');
    assert.equal(importado.layouts[0].name, 'Banco X');
  });

  it('recusa arquivo que não é catálogo', () => {
    assert.equal(parseCatalogFile('não é json').ok, false);
    assert.match(parseCatalogFile('não é json').error, /JSON inválido/);
    assert.equal(parseCatalogFile('{"layouts":[]}').ok, false);
    assert.match(parseCatalogFile('{"layouts":[]}').error, /nenhum layout válido/);
  });
});
