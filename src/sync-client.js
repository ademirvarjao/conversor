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

/** Limite máximo do envelope aceito pelo banco (5 MiB, igual à CHECK SQL). */
export const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RETRY_DELAY_MS = 300;
const TRANSIENT_STATUSES = new Set([502, 503, 504]);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Decodifica o corpo de um JWT sem falhar em strings comuns. */
function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const json =
      typeof atob === 'function'
        ? atob(padded)
        : Buffer.from(padded, 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Detecta chaves privilegiadas (`sb_secret_...` ou JWT `service_role`) para
 * impedir que alguém salve por engano uma chave de servidor no navegador.
 */
export function isSecretSupabaseKey(rawKey) {
  const key = String(rawKey ?? '').trim();
  if (!key) return false;
  if (/^sb_secret_/i.test(key)) return true;
  const claims = decodeJwtPayload(key);
  const role = String(claims?.role || '').toLowerCase();
  return role === 'service_role' || role === 'supabase_admin';
}

/**
 * Valida e normaliza a configuração colada pelo usuário.
 *
 * - Remove barras finais e sufixo `/rest/v1` colado por engano;
 * - Exige HTTPS fora de `localhost`/`127.0.0.1` (nunca trafega token em HTTP aberto);
 * - Recusa credenciais embutidas na URL e chaves secretas (`service_role` / `sb_secret_`).
 *
 * @param {{url?: string, anonKey?: string}} raw
 * @returns {{url: string, anonKey: string}|null}
 */
export function normalizeSupabaseConfig(raw) {
  const rawUrl = String(raw?.url ?? '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/rest\/v1$/i, '')
    .replace(/\/+$/, '');
  const anonKey = String(raw?.anonKey ?? '').trim();

  if (!rawUrl || !anonKey) return null;
  if (anonKey.length < 20 || /\s/.test(anonKey)) return null;
  if (isSecretSupabaseKey(anonKey)) return null;

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (parsed.username || parsed.password) return null;
  const protocol = parsed.protocol.toLowerCase();
  const hostname = parsed.hostname.toLowerCase();
  if (protocol === 'http:') {
    if (!LOCAL_HOSTS.has(hostname)) return null;
  } else if (protocol !== 'https:') {
    return null;
  }

  const pathname = parsed.pathname.replace(/\/+$/, '');
  return { url: `${parsed.origin}${pathname}`, anonKey };
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

function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readErrorBody(response) {
  try {
    const body = await response.json();
    if (!body || typeof body !== 'object') return { code: '', detail: '' };
    return {
      code: String(body.code || ''),
      detail: String(body.message || body.hint || body.details || ''),
    };
  } catch {
    return { code: '', detail: '' };
  }
}

async function fetchOnce(doFetch, url, init, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    return await doFetch(url, { ...init, signal: controller?.signal });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function request(config, url, init, options = {}) {
  const doFetch = options.fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('Este ambiente não permite acesso à rede (fetch indisponível).');
  }

  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const maxRetries = options.retries === 0 ? 0 : 1;
  const retryDelayMs =
    options.retryDelayMs !== undefined ? Math.max(0, Number(options.retryDelayMs) || 0) : DEFAULT_RETRY_DELAY_MS;

  let response;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      response = await fetchOnce(doFetch, url, init, timeoutMs);
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error('O banco compartilhado não respondeu a tempo. Tente novamente.');
      }
      throw new Error(
        'Não foi possível falar com o banco compartilhado. Confira a URL do projeto e sua conexão.'
      );
    }

    if (response.ok) return response;
    if (attempt < maxRetries && TRANSIENT_STATUSES.has(response.status)) {
      await sleep(retryDelayMs);
      continue;
    }
    break;
  }

  if (response.status === 401 || response.status === 403) {
    const { code, detail } = await readErrorBody(response);
    const isRlsOrOwnership =
      code === '42501' || /row-level security|pertence a outra conta|permission denied/i.test(detail);

    if (options.accessToken) {
      const expired = code === 'PGRST301' || /jwt expired/i.test(detail);
      const error = new Error(
        expired
          ? 'A sessão da conta na nuvem expirou. Entre de novo na aba Nuvem para sincronizar.'
          : 'A conta na nuvem não tem acesso a este cofre (ele pertence a outra conta ou a sessão venceu). ' +
              'Entre de novo na aba Nuvem; se o cofre foi criado sem conta, use a chave de acesso sem entrar.'
      );
      error.code = expired ? 'SESSION_EXPIRED' : 'RLS_DENIED';
      error.status = response.status;
      error.detail = detail;
      throw error;
    }

    if (isRlsOrOwnership) {
      // Sem conta, 403 com 42501 significa que o cofre já foi adotado por uma
      // conta do Supabase Auth — a chave pública está certa, falta fazer login.
      const error = new Error(
        'Este cofre pertence a uma conta na nuvem: entre com a conta dona dele na aba Nuvem para sincronizar.'
      );
      error.code = 'RLS_DENIED';
      error.status = response.status;
      error.detail = detail;
      throw error;
    }

    const error = new Error('Chave anônima recusada pelo Supabase. Confira a configuração.');
    error.code = 'AUTH_REJECTED';
    error.status = response.status;
    error.detail = detail;
    throw error;
  }

  if (response.status === 404) {
    const { detail } = await readErrorBody(response);
    const isRpc = /\/rest\/v1\/rpc\//i.test(url) || /PGRST202|Could not find the function/i.test(detail);
    if (isRpc) {
      const error = new Error(
        'O banco ainda não tem as funções de administração atualizadas. ' +
          'Copie o SQL de instalação na aba Nuvem e rode uma vez no SQL Editor.'
      );
      error.code = 'FUNCTION_MISSING';
      error.status = 404;
      error.detail = detail;
      throw error;
    }
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
    error.detail = detail;
    throw error;
  }

  if (response.status === 429) {
    const error = new Error('Muitas tentativas em pouco tempo. Aguarde alguns segundos.');
    error.code = 'RATE_LIMITED';
    error.status = 429;
    throw error;
  }

  const { code, detail } = await readErrorBody(response);

  if (code === '23514' || /conversor_models_(payload_envelope|slot_format)_chk/i.test(detail)) {
    const isSlot = /slot_format/i.test(detail);
    const error = new Error(
      isSlot
        ? 'Identificador de cofre inválido recusado pelo banco.'
        : 'Pacote de modelos recusado pelo banco (formato inválido ou acima do limite de 5 MB).'
    );
    error.code = isSlot ? 'INVALID_SLOT' : 'INVALID_PAYLOAD';
    error.status = response.status;
    error.detail = detail;
    throw error;
  }

  const error = new Error(`Falha no banco compartilhado (HTTP ${response.status})${detail ? `: ${detail}` : '.'}`);
  error.code = code;
  error.status = response.status;
  error.detail = detail;
  throw error;
}

/** `true` quando o PostgREST avisa que uma coluna pedida no `select` não existe. */
function isMissingColumnError(error, pattern) {
  if (Number(error?.status) !== 400) return false;
  return pattern.test(String(error?.detail || error?.message || ''));
}

/**
 * Lê o conteúdo cifrado do slot.
 * @returns {Promise<{payload: string, updatedAt: string, blockedAt: string|null, blockedReason: string|null}|null>}
 */
export async function fetchRemoteVault(config, slot, options = {}) {
  const normalized = normalizeSupabaseConfig(config);
  if (!normalized) throw new Error('Banco compartilhado não configurado.');
  const cleanSlot = String(slot ?? '').trim();
  if (!cleanSlot) throw new Error('Slot inválido.');

  const fetchRows = async (select) => {
    const response = await request(
      normalized,
      endpoint(normalized, `?slot=eq.${encodeURIComponent(cleanSlot)}&select=${select}`),
      { method: 'GET', headers: buildHeaders(normalized, {}, options.accessToken) },
      options
    );
    return response.json().catch(() => []);
  };

  let rows;
  try {
    rows = await fetchRows('payload,updated_at,blocked_at,blocked_reason');
  } catch (error) {
    if (isMissingColumnError(error, /blocked_reason/i)) {
      rows = await fetchRows('payload,updated_at,blocked_at');
    } else if (isMissingColumnError(error, /blocked_at/i)) {
      // Banco ainda sem a migração do bloqueio: lê como antes.
      rows = await fetchRows('payload,updated_at');
    } else {
      throw error;
    }
  }

  if (!Array.isArray(rows) || rows.length === 0) return null;
  const row = rows[0];
  if (!row?.payload && !row?.blocked_at) return null;
  return {
    payload: row?.payload ? String(row.payload) : '',
    updatedAt: row?.updated_at || '',
    blockedAt: row?.blocked_at || null,
    blockedReason: row?.blocked_reason || null,
  };
}

/**
 * Grava (ou substitui) o conteúdo cifrado do slot.
 * Usa upsert: o slot é a chave primária e `updated_at`/`revision` são mantidos
 * pelo gatilho `conversor_models_touch()` no próprio banco.
 */
export async function saveRemoteVault(config, slot, payload, options = {}) {
  const normalized = normalizeSupabaseConfig(config);
  if (!normalized) throw new Error('Banco compartilhado não configurado.');
  const cleanSlot = String(slot ?? '').trim();
  if (!cleanSlot) throw new Error('Slot inválido.');
  const body = String(payload ?? '');
  if (!body) throw new Error('Nada para enviar.');
  if (body.length > MAX_PAYLOAD_BYTES) {
    const error = new Error(
      'O pacote de modelos ultrapassou o limite de 5 MB do banco compartilhado. Exporte um backup local e limpe entradas antigas.'
    );
    error.code = 'PAYLOAD_TOO_LARGE';
    throw error;
  }

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
      body: JSON.stringify([{ slot: cleanSlot, payload: body }]),
    },
    options
  );

  return true;
}

/** Testa a conexão lendo a tabela (uma linha basta). */
export async function pingDatabase(config, options = {}) {
  if (isSecretSupabaseKey(config?.anonKey)) {
    throw new Error(
      'Recusado por segurança: nunca use a chave service_role ou sb_secret_ no navegador. Use a chave pública (publishable/anon).'
    );
  }
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
 * Nunca traz o `payload` (o conteúdo cifrado não interessa aqui) — só metadados
 * de administração e diagnóstico (`slot`, datas, dono, bloqueio, revisão e
 * tamanho em bytes).
 *
 * @returns {Promise<{rows: Array<{slot: string, createdAt: string|null, updatedAt: string, ownerId: string|null, blockedAt: string|null, blockedReason: string|null, revision: number|null, payloadBytes: number|null}>, schemaOutdated: boolean}>}
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
    rows = await run('slot,created_at,updated_at,blocked_at,blocked_reason,owner_id,revision,payload_bytes');
  } catch (error) {
    if (isMissingColumnError(error, /created_at|blocked_reason|revision|payload_bytes/i)) {
      // Projeto próprio ainda sem a migração de auditoria: tenta o schema v1 de bloqueio.
      try {
        rows = await run('slot,updated_at,blocked_at,owner_id');
      } catch (fallbackError) {
        if (isMissingColumnError(fallbackError, /blocked_at/i)) {
          schemaOutdated = true;
          rows = await run('slot,updated_at,owner_id');
        } else {
          throw fallbackError;
        }
      }
    } else if (isMissingColumnError(error, /blocked_at/i)) {
      // Banco sem a migração do bloqueio: lista o que existe, avisando o painel.
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
      createdAt: row?.created_at || null,
      updatedAt: row?.updated_at || '',
      ownerId: row?.owner_id || null,
      blockedAt: row?.blocked_at || null,
      blockedReason: row?.blocked_reason || null,
      revision: Number.isFinite(Number(row?.revision)) && Number(row?.revision) >= 1 ? Number(row.revision) : null,
      payloadBytes:
        Number.isFinite(Number(row?.payload_bytes)) && Number(row?.payload_bytes) >= 0
          ? Number(row.payload_bytes)
          : null,
    })),
  };
}

/** Traduz o erro do banco numa frase útil para o painel. */
export function describeVaultAdminError(error) {
  const status = Number(error?.status) || 0;
  const code = String(error?.code || '');
  const detail = String(error?.detail || error?.message || '');
  if (
    status === 404 ||
    code === 'FUNCTION_MISSING' ||
    code === 'TABLE_MISSING' ||
    /PGRST202|Could not find the function/i.test(detail)
  ) {
    return 'O banco ainda não tem as funções de administração. Copie o SQL de instalação atualizado (aba Nuvem) e rode uma vez no SQL Editor.';
  }
  if (/bloqueado pelo administrador|conversor_vault_blocked/i.test(detail)) {
    return 'Este cofre está bloqueado pelo administrador.';
  }
  if (code === 'SESSION_EXPIRED' || /sessão.*expirou|jwt expired/i.test(detail)) {
    return 'A sessão da conta na nuvem expirou: entre de novo na aba Nuvem.';
  }
  if (code === 'RLS_DENIED' || /pertence a outra conta|pertence a uma conta|42501/i.test(detail)) {
    return 'Este cofre pertence a outra conta: entre com a conta dona dele para administrar.';
  }
  if (/não encontrado|P0002/i.test(detail)) {
    return 'Este cofre não existe mais no banco.';
  }
  if (/Cofre inválido|22023/i.test(detail)) {
    return 'Identificador de cofre inválido.';
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
  const cleanSlot = String(slot ?? '').trim();
  if (!cleanSlot) throw new Error('Cofre inválido.');

  const reason = String(options.reason || '')
    .trim()
    .slice(0, 200);

  const response = await request(
    normalized,
    rpcEndpoint(normalized, 'conversor_block_vault'),
    {
      method: 'POST',
      headers: buildHeaders(normalized, {}, options.accessToken),
      body: JSON.stringify({
        p_slot: cleanSlot,
        p_blocked: Boolean(blocked),
        p_reason: reason,
      }),
    },
    options
  );

  const body = await response.json().catch(() => null);
  const row = Array.isArray(body) ? body[0] : body;
  return {
    slot: cleanSlot,
    blockedAt: row?.blocked_at || (blocked ? new Date().toISOString() : null),
    blockedReason: row?.blocked_reason || null,
  };
}

/**
 * Exclui o cofre do banco (a linha com o conteúdo cifrado).
 * Também passa por função no servidor, que confere o dono com trava antes de apagar.
 */
export async function deleteVault(config, slot, options = {}) {
  const normalized = normalizeSupabaseConfig(config);
  if (!normalized) throw new Error('Banco compartilhado não configurado.');
  const cleanSlot = String(slot ?? '').trim();
  if (!cleanSlot) throw new Error('Cofre inválido.');

  const response = await request(
    normalized,
    rpcEndpoint(normalized, 'conversor_delete_vault'),
    {
      method: 'POST',
      headers: buildHeaders(normalized, {}, options.accessToken),
      body: JSON.stringify({ p_slot: cleanSlot }),
    },
    options
  );

  const body = await response.json().catch(() => true);
  const deleted = Array.isArray(body) ? body[0] : body;
  return { slot: cleanSlot, deleted: deleted !== false };
}
