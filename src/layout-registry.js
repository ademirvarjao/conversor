/**
 * Conversor — Catálogo público de layouts (comunidade)
 *
 * O app é estático e o extrato **nunca sai do navegador**. Por isso a parte
 * “buscar na internet” é feita do único jeito honesto possível: o app **baixa**
 * uma lista pública de layouts de banco (nome, nomes de coluna e papel de cada
 * uma) e compara **localmente** com o arquivo aberto.
 *
 *  - Requisição `GET` simples, sem query string, sem cookie e sem credencial:
 *    nada do arquivo do usuário é enviado (nem cabeçalho, nem valor, nem data).
 *  - O resultado fica em `localStorage` por 7 dias; falha de rede não quebra
 *    nada (o catálogo embutido continua valendo).
 *  - Todo layout baixado passa por `sanitizeLayout` antes de entrar no catálogo.
 *
 * Para contribuir com um banco novo, basta abrir um PR acrescentando o layout
 * em `layouts/comunidade.json` — nenhum dado de cliente entra nesse arquivo.
 */

import { sanitizeLayout } from './bank-layouts.js';

/** Catálogo público servido pelo GitHub (CORS liberado, sem autenticação). */
export const COMMUNITY_LAYOUTS_URL =
  'https://raw.githubusercontent.com/ademirvarjao/conversor/main/layouts/comunidade.json';

export const CATALOG_STORAGE_KEY = 'conversor_layout_catalog_v1';

/** 7 dias: o catálogo muda pouco e não vale bater na rede a cada importação. */
export const CATALOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const MAX_LAYOUTS = 400;
const FETCH_TIMEOUT_MS = 8000;

function safeStorage(storage) {
  if (storage) return storage;
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
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

/** Catálogo guardado neste navegador (ou `null`). */
export function loadCatalog(storage = null) {
  const store = safeStorage(storage);
  if (!store) return null;
  try {
    const raw = store.getItem(CATALOG_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const { layouts, generatedAt } = sanitizeCatalogPayload(parsed);
    return {
      layouts,
      generatedAt,
      fetchedAt: Number(parsed.fetchedAt) || 0,
      url: typeof parsed.url === 'string' ? parsed.url : COMMUNITY_LAYOUTS_URL,
    };
  } catch {
    return null;
  }
}

export function saveCatalog(catalog, storage = null) {
  const store = safeStorage(storage);
  if (!store || !catalog) return false;
  try {
    store.setItem(
      CATALOG_STORAGE_KEY,
      JSON.stringify({
        layouts: catalog.layouts || [],
        generatedAt: catalog.generatedAt || null,
        fetchedAt: Number(catalog.fetchedAt) || Date.now(),
        url: catalog.url || COMMUNITY_LAYOUTS_URL,
      })
    );
    return true;
  } catch {
    return false;
  }
}

export function isCatalogFresh(catalog, now = Date.now(), ttl = CATALOG_TTL_MS) {
  return Boolean(catalog && catalog.layouts?.length && now - Number(catalog.fetchedAt || 0) < ttl);
}

/**
 * Baixa o catálogo público.
 *
 * @param {object} [options]
 * @param {string} [options.url]
 * @param {Function} [options.fetchImpl] `fetch` injetável (testes)
 * @param {number} [options.timeoutMs]
 * @param {object} [options.storage]
 * @param {number} [options.now]
 * @returns {Promise<{ok:boolean, layouts:Array, fetchedAt:number, url:string,
 *   error?:string, fromCache:boolean}>}
 */
export async function fetchCommunityLayouts({
  url = COMMUNITY_LAYOUTS_URL,
  fetchImpl = typeof fetch === 'function' ? fetch : null,
  timeoutMs = FETCH_TIMEOUT_MS,
  storage = null,
  now = Date.now(),
} = {}) {
  const cached = loadCatalog(storage);

  if (!fetchImpl) {
    return {
      ok: false,
      layouts: cached?.layouts || [],
      fetchedAt: cached?.fetchedAt || 0,
      url,
      error: 'Este navegador não permite requisições de rede.',
      fromCache: Boolean(cached?.layouts?.length),
    };
  }

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-cache',
      signal: controller?.signal,
    });
    if (!response?.ok) throw new Error(`catálogo respondeu HTTP ${response?.status ?? '?'}`);

    const payload = sanitizeCatalogPayload(await response.json());
    if (payload.layouts.length === 0) throw new Error('catálogo vazio ou inválido');

    const catalog = { ...payload, fetchedAt: now, url };
    saveCatalog(catalog, storage);

    return { ok: true, layouts: catalog.layouts, fetchedAt: now, url, fromCache: false };
  } catch (error) {
    const message =
      error?.name === 'AbortError'
        ? 'o catálogo demorou demais para responder'
        : String(error?.message || error);
    return {
      ok: false,
      layouts: cached?.layouts || [],
      fetchedAt: cached?.fetchedAt || 0,
      url,
      error: message,
      fromCache: Boolean(cached?.layouts?.length),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
