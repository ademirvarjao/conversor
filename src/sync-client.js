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
    detail = body?.message || body?.hint || body?.details || '';
  } catch {
    /* resposta sem JSON */
  }
  const error = new Error(`Falha no banco compartilhado (HTTP ${response.status})${detail ? `: ${detail}` : '.'}`);
  error.status = response.status;
  error.detail = detail;
  throw error;
}

/**
 * Lê o conteúdo cifrado do slot.
 * @returns {Promise<{payload: string, updatedAt: string}|null>}
 */
export async function fetchRemoteVault(config, slot, options = {}) {
  const normalized = normalizeSupabaseConfig(config);
  if (!normalized) throw new Error('Banco compartilhado não configurado.');
  if (!slot) throw new Error('Slot inválido.');

  const fetchRows = async (select) => {
    const response = await request(
      normalized,
      endpoint(normalized, `?slot=eq.${encodeURIComponent(slot)}&select=${select}`),
      { method: 'GET', headers: buildHeaders(normalized, {}, options.accessToken) },
      options
    );
    return response.json().catch(() => []);
  };

  let rows;
  try {
    rows = await fetchRows('payload,updated_at,blocked_at');
  } catch (error) {
    // Banco ainda sem a migração do bloqueio: lê como antes.
    if (error?.status === 400 && /blocked_at/i.test(String(error.detail || error.message))) {
      rows = await fetchRows('payload,updated_at');
    } else {
      throw error;
    }
  }

  if (!Array.isArray(rows) || rows.length === 0) return null;
  const row = rows[0];
  if (!row?.payload) return null;
  return {
    payload: String(row.payload),
    updatedAt: row.updated_at || '',
    blockedAt: row.blocked_at || null,
  };
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

/* -------------------------------------------------------------------------- */
/*                     Administração dos cofres (painel)                      */
/* -------------------------------------------------------------------------- */

function rpcEndpoint(config, name) {
  return `${config.url}/rest/v1/rpc/${name}`;
}

/**
 * Lista os cofres que **este** navegador consegue enxergar (a política de RLS
 * mostra os cofres sem dono e os da conta que estiver logada).
 *
 * Nunca traz o `payload` (o conteúdo cifrado não interessa aqui) — só o que o
 * painel precisa para mostrar e administrar: slot, data, dono e bloqueio.
 *
 * @returns {Promise<{rows: Array<{slot: string, updatedAt: string, ownerId: string|null, blockedAt: string|null}>, schemaOutdated: boolean}>}
 */
export async function fetchVaultRows(config, options = {}) {
  const normalized = normalizeSupabaseConfig(config);
  if (!normalized) throw new Error('Banco compartilhado não configurado.');

  const query = (select) => `?select=${select}&order=updated_at.desc&limit=200`;
  const run = async (select) => {
    const response = await request(
      normalized,
      endpoint(normalized, query(select)),
      { method: 'GET', headers: buildHeaders(normalized, {}, options.accessToken) },
      options
    );
    return response.json().catch(() => []);
  };

  let rows;
  let schemaOutdated = false;
  try {
    rows = await run('slot,updated_at,blocked_at,owner_id');
  } catch (error) {
    // Banco sem a migração do bloqueio: lista o que existe, avisando o painel.
    if (error?.status === 400 && /blocked_at/i.test(String(error.detail || error.message))) {
      schemaOutdated = true;
      rows = await run('slot,updated_at,owner_id');
    } else {
      throw error;
    }
  }

  return {
    schemaOutdated,
    rows: (Array.isArray(rows) ? rows : []).map((row) => ({
      slot: String(row?.slot || ''),
      updatedAt: row?.updated_at || '',
      ownerId: row?.owner_id || null,
      blockedAt: row?.blocked_at || null,
    })),
  };
}

/** Traduz o erro do banco numa frase útil para o painel. */
export function describeVaultAdminError(error) {
  const status = Number(error?.status) || 0;
  const detail = String(error?.detail || error?.message || '');
  if (status === 404 || /PGRST202|Could not find the function/i.test(detail)) {
    return 'O banco ainda não tem as funções de administração. Copie o SQL de instalação atualizado (aba Nuvem) e rode uma vez no SQL Editor.';
  }
  if (/bloqueado pelo administrador|conversor_vault_blocked/i.test(detail)) {
    return 'Este cofre está bloqueado pelo administrador.';
  }
  if (/pertence a outra conta|42501/i.test(detail)) {
    return 'Este cofre pertence a outra conta: entre com a conta dona dele para administrar.';
  }
  if (/não encontrado|P0002/i.test(detail)) {
    return 'Este cofre não existe mais no banco.';
  }
  return detail || 'Não foi possível falar com o banco.';
}

/**
 * Bloqueia (ou desbloqueia) um cofre.
 *
 * O bloqueio é feito por uma função do banco (`conversor_block_vault`) que só
 * aceita cofres sem dono ou da própria conta. Enquanto bloqueado, o app recusa
 * enviar e baixar por aquele código.
 */
export async function blockVault(config, slot, blocked = true, options = {}) {
  const normalized = normalizeSupabaseConfig(config);
  if (!normalized) throw new Error('Banco compartilhado não configurado.');
  if (!slot) throw new Error('Cofre inválido.');

  const response = await request(
    normalized,
    rpcEndpoint(normalized, 'conversor_block_vault'),
    {
      method: 'POST',
      headers: buildHeaders(normalized, {}, options.accessToken),
      body: JSON.stringify({
        p_slot: slot,
        p_blocked: Boolean(blocked),
        p_reason: String(options.reason || '').slice(0, 200),
      }),
    },
    options
  );

  const body = await response.json().catch(() => null);
  const row = Array.isArray(body) ? body[0] : body;
  return { slot, blockedAt: row?.blocked_at || (blocked ? new Date().toISOString() : null) };
}

/**
 * Exclui o cofre do banco (a linha com o conteúdo cifrado).
 * Também passa por função no servidor, que confere o dono antes de apagar.
 */
export async function deleteVault(config, slot, options = {}) {
  const normalized = normalizeSupabaseConfig(config);
  if (!normalized) throw new Error('Banco compartilhado não configurado.');
  if (!slot) throw new Error('Cofre inválido.');

  const response = await request(
    normalized,
    rpcEndpoint(normalized, 'conversor_delete_vault'),
    {
      method: 'POST',
      headers: buildHeaders(normalized, {}, options.accessToken),
      body: JSON.stringify({ p_slot: slot }),
    },
    options
  );

  const body = await response.json().catch(() => true);
  const deleted = Array.isArray(body) ? body[0] : body;
  return { slot, deleted: deleted !== false };
}
