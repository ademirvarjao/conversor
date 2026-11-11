/**
 * Conversor — Catálogo público de layouts (comunidade)
 *
 * O app é estático e o extrato **nunca sai do navegador**. Por isso a parte
 * “buscar na internet” é feita do único jeito honesto possível: o app **baixa**
 * uma lista pública de layouts de banco (nome, nomes de coluna e papel de cada
 * uma) e compara **localmente** com o arquivo aberto.
 *
 * Independência é requisito, não detalhe:
 *
 *  1. **O app nunca depende da rede para funcionar.** O catálogo embutido
 *     (`src/bank-layouts.js`, 18 bancos) está no pacote; o baixado é só um
 *     complemento. Sem rede, com o arquivo removido do repositório ou com o
 *     `fetch` bloqueado, tudo continua valendo.
 *  2. **Três fontes, com failover**: primeiro o **próprio site** (mesma origem
 *     — sem CORS, sem terceiros, funciona em qualquer fork/auto-hospedagem),
 *     depois o espelho **jsDelivr** e, por último, o **raw.githubusercontent**.
 *     A fonte que funcionou é lembrada e tentada primeiro na próxima vez.
 *  3. **Sempre atualizado**: revalida sozinho na abertura (com ETag, então
 *     normalmente é um 304 barato), a cada hora de uso e quando a aba volta a
 *     ficar visível. O arquivo pode mudar sem republicar o app.
 *  4. **Portátil**: o catálogo pode ser **exportado** em `.json` e **importado**
 *     em outro navegador/equipe — inclusive em máquina sem internet.
 *
 * Privacidade: requisição `GET` simples, sem query string, sem corpo, sem
 * cookie e sem credencial — nada do arquivo do usuário é enviado (nem cabeçalho,
 * nem valor, nem data). A comparação entre o catálogo e o extrato é local.
 *
 * Para contribuir com um banco novo, basta abrir um PR acrescentando o layout em
 * `layouts/comunidade.json` — nenhum dado de cliente entra nesse arquivo.
 */

import { sanitizeLayout } from './bank-layouts.js';

/** Caminho do catálogo dentro do próprio site (mesma origem do app). */
export const COMMUNITY_LAYOUTS_PATH = 'layouts/comunidade.json';

/** Repositório de origem (usado pelos espelhos de CDN/raw). */
export const COMMUNITY_LAYOUTS_URL =
  'https://raw.githubusercontent.com/ademirvarjao/conversor/main/layouts/comunidade.json';

export const CATALOG_STORAGE_KEY = 'conversor_layout_catalog_v1';

/** Cópia de segurança: se o registro principal corromper, esta ainda vale. */
export const CATALOG_BACKUP_KEY = 'conversor_layout_catalog_v1_bkp';

/** 7 dias: por quanto tempo o catálogo baixado continua valendo offline. */
export const CATALOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** De quanto em quanto tempo vale a pena revalidar na rede. */
export const CATALOG_REVALIDATE_MS = 60 * 60 * 1000;

const MAX_LAYOUTS = 400;
const FETCH_TIMEOUT_MS = 8000;

/**
 * Fontes em ordem de preferência. `same-origin` é relativa de propósito: vale
 * para o Pages oficial e para qualquer fork servido de outro endereço.
 */
export const CATALOG_SOURCES = [
  {
    id: 'same-origin',
    label: 'próprio site',
    url: COMMUNITY_LAYOUTS_PATH,
    sameOrigin: true,
  },
  {
    id: 'jsdelivr',
    label: 'espelho jsDelivr',
    url: 'https://cdn.jsdelivr.net/gh/ademirvarjao/conversor@main/layouts/comunidade.json',
  },
  {
    id: 'github-raw',
    label: 'GitHub (raw)',
    url: COMMUNITY_LAYOUTS_URL,
  },
];

function safeStorage(storage) {
  if (storage) return storage;
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function currentLocation(location) {
  if (location) return location;
  try {
    return typeof globalThis.location !== 'undefined' ? globalThis.location : null;
  } catch {
    return null;
  }
}

/**
 * Lista de fontes a tentar, já considerando onde o app está rodando.
 *
 * `file://` (abrir o HTML direto do disco) não tem mesma origem útil e o CDN
 * costuma ser bloqueado por CORS nesse contexto — aí só o GitHub raw vale.
 *
 * @param {object} [options]
 * @param {Location|null} [options.location]
 * @param {string|null} [options.preferredSource] id da fonte que funcionou antes
 * @param {Array} [options.sources] lista explícita (testes)
 */
export function catalogSources({ location = null, preferredSource = null, sources = null } = {}) {
  if (Array.isArray(sources)) return sources;

  const loc = currentLocation(location);
  const protocol = loc?.protocol || 'https:';

  const usable =
    protocol === 'file:'
      ? CATALOG_SOURCES.filter((source) => !source.sameOrigin && source.id !== 'jsdelivr')
      : CATALOG_SOURCES;

  if (!preferredSource) return [...usable];

  const preferred = usable.filter((source) => source.id === preferredSource);
  return [...preferred, ...usable.filter((source) => source.id !== preferredSource)];
}

/**
 * Valida o JSON do catálogo (tanto o baixado quanto o que vem do cache).
 * @returns {{ layouts: Array<object>, generatedAt: string|null, schema: number }}
 */
export function sanitizeCatalogPayload(raw) {
  const empty = { layouts: [], generatedAt: null, schema: 1 };
  if (!raw || typeof raw !== 'object') return empty;

  const list = Array.isArray(raw.layouts) ? raw.layouts : Array.isArray(raw) ? raw : [];
  const layouts = list
    .map((layout, index) => sanitizeLayout({ ...layout, source: 'community' }, index))
    .filter(Boolean)
    .slice(0, MAX_LAYOUTS);

  return {
    layouts,
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : null,
    schema: Number(raw.schema) || 1,
  };
}

/** Assinatura curta do catálogo: serve para saber se algo mudou de verdade. */
export function fingerprintLayouts(layouts) {
  const text = (layouts || [])
    .map((layout) => `${layout.id}:${layout.name}:${layout.updatedAt || ''}:${layout.columns.length}`)
    .join('|');

  // FNV-1a de 32 bits: suficiente para detectar mudança, sem dependência.
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Junta dois catálogos por `id`. Em empate vale o remoto (é a fonte publicada);
 * um layout com `updatedAt` mais novo ganha do mais velho.
 */
export function mergeCatalogLayouts(local = [], remote = []) {
  const byId = new Map();

  for (const layout of local || []) {
    if (layout?.id) byId.set(layout.id, layout);
  }

  for (const layout of remote || []) {
    if (!layout?.id) continue;
    const current = byId.get(layout.id);
    if (!current) {
      byId.set(layout.id, layout);
      continue;
    }
    const currentAt = Date.parse(current.updatedAt || '') || 0;
    const incomingAt = Date.parse(layout.updatedAt || '') || 0;
    if (incomingAt >= currentAt) byId.set(layout.id, layout);
  }

  return [...byId.values()];
}

function readRecord(key, storage) {
  const store = safeStorage(storage);
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const { layouts, generatedAt } = sanitizeCatalogPayload(parsed);
    if (layouts.length === 0) return null;
    return {
      layouts,
      generatedAt,
      fetchedAt: Number(parsed.fetchedAt) || 0,
      url: typeof parsed.url === 'string' ? parsed.url : COMMUNITY_LAYOUTS_URL,
      sourceId: typeof parsed.sourceId === 'string' ? parsed.sourceId : null,
      fingerprint: typeof parsed.fingerprint === 'string' ? parsed.fingerprint : fingerprintLayouts(layouts),
    };
  } catch {
    return null;
  }
}

/** Catálogo guardado neste navegador (ou `null`). */
export function loadCatalog(storage = null) {
  return readRecord(CATALOG_STORAGE_KEY, storage) || readRecord(CATALOG_BACKUP_KEY, storage);
}

/** @returns {boolean} */
export function saveCatalog(catalog, storage = null) {
  const store = safeStorage(storage);
  if (!store || !catalog) return false;

  const record = {
    schema: Number(catalog.schema) || 1,
    layouts: catalog.layouts || [],
    generatedAt: catalog.generatedAt || null,
    fetchedAt: Number(catalog.fetchedAt) || Date.now(),
    url: catalog.url || COMMUNITY_LAYOUTS_URL,
    sourceId: catalog.sourceId || null,
    fingerprint: catalog.fingerprint || fingerprintLayouts(catalog.layouts || []),
  };

  try {
    store.setItem(CATALOG_STORAGE_KEY, JSON.stringify(record));
    // Cópia de segurança: um registro corrompido não zera o catálogo offline.
    try {
      store.setItem(CATALOG_BACKUP_KEY, JSON.stringify(record));
    } catch {
      /* sem espaço para o backup: o principal já foi salvo */
    }
    return true;
  } catch {
    return false;
  }
}

export function isCatalogFresh(catalog, now = Date.now(), ttl = CATALOG_TTL_MS) {
  return Boolean(catalog && catalog.layouts?.length && now - Number(catalog.fetchedAt || 0) < ttl);
}

/** Vale a pena revalidar na rede agora? (na abertura, a cada hora, ao voltar) */
export function shouldRevalidate(catalog, now = Date.now(), minInterval = CATALOG_REVALIDATE_MS) {
  if (!catalog || !catalog.layouts?.length) return true;
  return now - Number(catalog.fetchedAt || 0) >= minInterval;
}

/** Lê um arquivo `.json` de catálogo (importação manual / máquina sem internet). */
export function parseCatalogFile(text) {
  let parsed;
  try {
    parsed = typeof text === 'string' ? JSON.parse(text) : text;
  } catch (error) {
    return { ok: false, layouts: [], error: `JSON inválido (${error.message})` };
  }

  const payload = sanitizeCatalogPayload(parsed);
  if (payload.layouts.length === 0) {
    return { ok: false, layouts: [], error: 'nenhum layout válido no arquivo' };
  }

  return {
    ok: true,
    layouts: payload.layouts.map((layout) => ({ ...layout, source: 'imported' })),
    generatedAt: payload.generatedAt,
    schema: payload.schema,
    error: null,
  };
}

/** Catálogo em texto para exportar/compartilhar (só nomes de coluna e papéis). */
export function serializeCatalog(layouts, { generatedAt = new Date().toISOString() } = {}) {
  return JSON.stringify(
    {
      schema: 1,
      generatedAt,
      about:
        'Catálogo público de layouts de extrato do Conversor. Só nomes de coluna e papéis: ' +
        'nenhum dado de cliente, valor ou data de lançamento. Contribua com um PR.',
      layouts: (layouts || []).map((layout) => ({
        id: layout.id,
        name: layout.name,
        ...(layout.updatedAt ? { updatedAt: layout.updatedAt } : {}),
        ...(layout.alias ? { alias: layout.alias } : {}),
        columns: layout.columns.map(({ match, role }) => ({ match, role })),
        ...(layout.quirks && Object.keys(layout.quirks).length > 0 ? { quirks: layout.quirks } : {}),
      })),
    },
    null,
    2
  );
}

async function fetchWithTimeout(url, { fetchImpl, timeoutMs, signal }) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  const abortAll = () => controller?.abort();
  signal?.addEventListener?.('abort', abortAll, { once: true });

  try {
    return await fetchImpl(url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      // Deixa o navegador revalidar pelo ETag: catálogo igual custa um 304.
      cache: 'no-cache',
      headers: { Accept: 'application/json' },
      signal: controller?.signal,
    });
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener?.('abort', abortAll);
  }
}

/**
 * Baixa o catálogo público, tentando as fontes em ordem até uma responder.
 *
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] `fetch` injetável (testes)
 * @param {number} [options.timeoutMs] timeout **por fonte**
 * @param {object} [options.storage]
 * @param {number} [options.now]
 * @param {Array} [options.sources] lista explícita de fontes
 * @param {Location|null} [options.location]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ok:boolean, layouts:Array, fetchedAt:number, url:string,
 *   sourceId:string|null, sourceLabel:string|null, changed:boolean, unchanged:boolean,
 *   attempts:Array<{id:string, ok:boolean, error?:string}>, error?:string,
 *   fromCache:boolean}>}
 */
export async function fetchCommunityLayouts({
  fetchImpl = typeof fetch === 'function' ? fetch : null,
  timeoutMs = FETCH_TIMEOUT_MS,
  storage = null,
  now = Date.now(),
  sources = null,
  location = null,
  signal = null,
} = {}) {
  const cached = loadCatalog(storage);

  const sourcesToTry = catalogSources({ location, preferredSource: cached?.sourceId, sources });

  const base = {
    layouts: cached?.layouts || [],
    fetchedAt: cached?.fetchedAt || 0,
    url: cached?.url || COMMUNITY_LAYOUTS_URL,
    sourceId: cached?.sourceId || null,
    sourceLabel: null,
    changed: false,
    unchanged: false,
    attempts: [],
    fromCache: Boolean(cached?.layouts?.length),
  };

  if (!fetchImpl) {
    return {
      ...base,
      ok: false,
      error: 'Este navegador não permite requisições de rede.',
    };
  }

  const attempts = [];
  const errors = [];

  for (const source of sourcesToTry) {
    const label = source.label || source.id || source.url;
    try {
      const response = await fetchWithTimeout(source.url, { fetchImpl, timeoutMs, signal });

      // 304: o navegador já tem a versão publicada — nada a fazer além de
      // carimbar a data da verificação (o cache segue valendo por mais 7 dias).
      if (response?.status === 304) {
        if (!cached) throw new Error('catálogo respondeu 304 sem cópia local');
        const catalog = { ...cached, fetchedAt: now, url: source.url, sourceId: source.id };
        saveCatalog(catalog, storage);
        attempts.push({ id: source.id, ok: true });
        return {
          ...base,
          ok: true,
          layouts: catalog.layouts,
          fetchedAt: now,
          url: source.url,
          sourceId: source.id,
          sourceLabel: label,
          changed: false,
          unchanged: true,
          attempts,
          fromCache: true,
        };
      }

      if (!response?.ok) throw new Error(`HTTP ${response?.status ?? '?'}`);

      const payload = sanitizeCatalogPayload(await response.json());
      if (payload.layouts.length === 0) throw new Error('catálogo vazio ou inválido');

      const layouts = mergeCatalogLayouts(cached?.layouts || [], payload.layouts);
      const fingerprint = fingerprintLayouts(layouts);
      const changed = !cached || cached.fingerprint !== fingerprint;

      const catalog = {
        ...payload,
        layouts,
        fetchedAt: now,
        url: source.url,
        sourceId: source.id,
        fingerprint,
      };
      saveCatalog(catalog, storage);

      attempts.push({ id: source.id, ok: true });
      return {
        ok: true,
        layouts,
        fetchedAt: now,
        url: source.url,
        sourceId: source.id,
        sourceLabel: label,
        changed,
        unchanged: !changed,
        attempts,
        fromCache: false,
      };
    } catch (error) {
      const message =
        error?.name === 'AbortError' ? 'demorou demais para responder' : String(error?.message || error);
      attempts.push({ id: source.id, ok: false, error: message });
      errors.push(`${label}: ${message}`);
    }
  }

  return {
    ...base,
    ok: false,
    attempts,
    error: errors.join(' · ') || 'nenhuma fonte de catálogo respondeu',
  };
}
