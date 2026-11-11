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

/**
 * Cabeçalhos da API REST.
 * Com conta (`accessToken`), o `Authorization` leva o token do Supabase Auth e o
 * Row Level Security entrega/aceita apenas os cofres daquele usuário; sem conta,
 * vai a chave anônima (só alcança cofres que ainda não têm dono).
 */
function buildHeaders(config, extra = {}, accessToken = '') {
  return {
    apikey: config.anonKey,
    Authorization: `Bearer ${accessToken || config.anonKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...extra,
  };
}

function endpoint(config, query = '') {
  return `${config.url}/rest/v1/${TABLE_NAME}${query}`;
}

async function request(config, url, init, options = {}) {
  const doFetch = options.fetchImpl || globalThis.fetch;
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
    if (options.accessToken) {
      // Com conta, 403/401 quase sempre é o RLS: o cofre é de outro usuário (ou
      // o token venceu no meio do caminho).
      throw new Error(
        'A conta na nuvem não tem acesso a este cofre (ele pertence a outra conta ou a sessão venceu). ' +
          'Entre de novo na aba Nuvem; se o cofre foi criado sem conta, use a chave de acesso sem entrar.'
      );
    }
    throw new Error('Chave anônima recusada pelo Supabase. Confira a configuração.');
  }
  if (response.status === 404) {
    // PostgREST responde 404 (PGRST205) quando a tabela ainda não existe — caso
    // da migração do repositório que ainda não rodou no projeto. A UI usa o
    // `code` para oferecer o SQL de instalação ao usuário.
    const error = new Error(
      `A tabela "${TABLE_NAME}" ainda não existe no projeto Supabase. ` +
        'A migração de supabase/migrations/ é aplicada pela integração Supabase + GitHub ' +
        '(com supabase/config.toml no repositório); se ela ainda não rodou, use o SQL de ' +
        'instalação que o app oferece na aba Nuvem.'
    );
    error.code = 'TABLE_MISSING';
    error.status = 404;
    throw error;
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
    { method: 'GET', headers: buildHeaders(normalized, {}, options.accessToken) },
    options
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
      headers: buildHeaders(
        normalized,
        { Prefer: 'resolution=merge-duplicates,return=minimal' },
        options.accessToken
      ),
      body: JSON.stringify([{ slot, payload, updated_at: new Date().toISOString() }]),
    },
    options
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
    { method: 'GET', headers: buildHeaders(normalized, {}, options.accessToken) },
    options
  );
  await response.json().catch(() => []);
  return true;
}
