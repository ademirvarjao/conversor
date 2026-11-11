/**
 * Conversor — Cliente do banco compartilhado (Supabase/PostgREST)
 *
 * O app conversa com o banco pela API REST do Supabase usando apenas a chave
 * anônima pública. Toda a proteção de conteúdo vem da criptografia feita no
 * navegador (`sync-crypto.js`): o servidor guarda `slot` + `payload` cifrado.
 *
 * A tabela esperada está em `supabase/schema.sql`.
 */

export const TABLE_NAME = 'conversor_models';

const DEFAULT_TIMEOUT_MS = 15000;

/**
 * Valida e normaliza a configuração colada pelo usuário.
 * @param {{url?: string, anonKey?: string}} raw
 * @returns {{url: string, anonKey: string}|null}
 */
export function normalizeSupabaseConfig(raw) {
  const url = String(raw?.url ?? '')
    .trim()
    .replace(/\/+$/, '');
  const anonKey = String(raw?.anonKey ?? '').trim();

  if (!url || !anonKey) return null;
  if (!/^https?:\/\/[^\s]+$/i.test(url)) return null;
  // A chave anônima do Supabase é um JWT; exigir o formato evita erros de colagem.
  if (anonKey.length < 20) return null;

  return { url, anonKey };
}

export function isSupabaseConfigured(config) {
  return normalizeSupabaseConfig(config) !== null;
}

function buildHeaders(config, extra = {}) {
  return {
    apikey: config.anonKey,
    Authorization: `Bearer ${config.anonKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...extra,
  };
}

function endpoint(config, query = '') {
  return `${config.url}/rest/v1/${TABLE_NAME}${query}`;
}

async function request(config, url, init, fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('Este ambiente não permite acesso à rede (fetch indisponível).');
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS) : null;

  let response;
  try {
    response = await doFetch(url, { ...init, signal: controller?.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('O banco compartilhado não respondeu a tempo. Tente novamente.');
    }
    throw new Error(
      'Não foi possível falar com o banco compartilhado. Confira a URL do projeto e sua conexão.'
    );
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (response.ok) return response;

  if (response.status === 401 || response.status === 403) {
    throw new Error('Chave anônima recusada pelo Supabase. Confira a configuração.');
  }
  if (response.status === 404) {
    throw new Error(
      `A tabela "${TABLE_NAME}" ainda não existe no projeto Supabase. A migração ` +
        'supabase/migrations/20261111120000_conversor_models.sql é aplicada automaticamente ' +
        'pela integração Supabase + GitHub a cada push; se o projeto foi criado agora, ' +
        'aguarde alguns segundos e recarregue. Para aplicar à mão, rode o SQL de ' +
        'supabase/schema.sql no SQL Editor.'
    );
  }
  if (response.status === 429) {
    throw new Error('Muitas tentativas em pouco tempo. Aguarde alguns segundos.');
  }

  let detail = '';
  try {
    const body = await response.json();
    detail = body?.message || body?.hint || '';
  } catch {
    /* resposta sem JSON */
  }
  throw new Error(`Falha no banco compartilhado (HTTP ${response.status})${detail ? `: ${detail}` : '.'}`);
}

/**
 * Lê o conteúdo cifrado do slot.
 * @returns {Promise<{payload: string, updatedAt: string}|null>}
 */
export async function fetchRemoteVault(config, slot, options = {}) {
  const normalized = normalizeSupabaseConfig(config);
  if (!normalized) throw new Error('Banco compartilhado não configurado.');
  if (!slot) throw new Error('Slot inválido.');

  const query = `?slot=eq.${encodeURIComponent(slot)}&select=payload,updated_at`;
  const response = await request(
    normalized,
    endpoint(normalized, query),
    { method: 'GET', headers: buildHeaders(normalized) },
    options.fetchImpl
  );

  const rows = await response.json().catch(() => []);
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const row = rows[0];
  if (!row?.payload) return null;
  return { payload: String(row.payload), updatedAt: row.updated_at || '' };
}

/**
 * Grava (ou substitui) o conteúdo cifrado do slot.
 * Usa upsert: o slot é a chave primária da tabela.
 */
export async function saveRemoteVault(config, slot, payload, options = {}) {
  const normalized = normalizeSupabaseConfig(config);
  if (!normalized) throw new Error('Banco compartilhado não configurado.');
  if (!slot) throw new Error('Slot inválido.');
  if (!payload) throw new Error('Nada para enviar.');

  await request(
    normalized,
    endpoint(normalized),
    {
      method: 'POST',
      headers: buildHeaders(normalized, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify([{ slot, payload, updated_at: new Date().toISOString() }]),
    },
    options.fetchImpl
  );

  return true;
}

/** Testa a conexão lendo a tabela (uma linha basta). */
export async function pingDatabase(config, options = {}) {
  const normalized = normalizeSupabaseConfig(config);
  if (!normalized) throw new Error('Banco compartilhado não configurado.');

  const response = await request(
    normalized,
    endpoint(normalized, '?select=slot&limit=1'),
    { method: 'GET', headers: buildHeaders(normalized) },
    options.fetchImpl
  );
  await response.json().catch(() => []);
  return true;
}
