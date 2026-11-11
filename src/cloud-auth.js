/**
 * Conversor — Conta na nuvem (Supabase Auth)
 *
 * A chave de acesso (`sync-crypto.js`) protege o *conteúdo*: sem ela o payload
 * é ilegível. A conta protege o *acesso*: com Row Level Security
 * (`supabase/migrations/20261111160000_conversor_models_owner.sql`), o banco só
 * entrega/aceita os cofres de quem é dono deles — ninguém mais consegue ler,
 * sobrescrever ou apagar os teus modelos, mesmo com a chave pública do projeto.
 *
 * Aqui fica o mínimo do GoTrue/Supabase Auth por REST (nenhuma biblioteca):
 * entrar, criar conta, renovar o token e sair. A sessão (tokens) fica no
 * `localStorage` deste navegador; a senha da conta **nunca** é guardada.
 */

export const SESSION_KEY = 'conversor_cloud_session_v1';

/** Renova o token um pouco antes de vencer (evita 401 no meio do envio). */
const EXPIRY_SKEW_MS = 60 * 1000;

const TIMEOUT_MS = 15000;

function storageOf(storage) {
  if (storage) return storage;
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function readJson(storage, key) {
  const store = storageOf(storage);
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(storage, key, value) {
  const store = storageOf(storage);
  if (!store) return false;
  try {
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Sessão                                    */
/* -------------------------------------------------------------------------- */

/** @returns {{accessToken:string, refreshToken:string, expiresAt:number, userId:string, email:string}|null} */
export function normalizeSession(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const accessToken = String(raw.access_token || raw.accessToken || '');
  if (!accessToken) return null;
  const expiresIn = Number(raw.expires_in || raw.expiresIn || 3600);
  const expiresAt = Number(raw.expires_at || raw.expiresAt) || now + expiresIn * 1000;
  const user = raw.user && typeof raw.user === 'object' ? raw.user : {};
  return {
    accessToken,
    refreshToken: String(raw.refresh_token || raw.refreshToken || ''),
    expiresAt,
    userId: String(user.id || raw.userId || ''),
    email: String(user.email || raw.email || ''),
  };
}

export function loadSession(storage) {
  return normalizeSession(readJson(storage, SESSION_KEY));
}

export function saveSession(session, storage) {
  if (!session?.accessToken) return false;
  return writeJson(storage, SESSION_KEY, session);
}

export function clearSession(storage) {
  const store = storageOf(storage);
  if (!store) return false;
  try {
    store.removeItem(SESSION_KEY);
    return true;
  } catch {
    return false;
  }
}

/** Token vencido (ou perto de vencer). */
export function isSessionExpired(session, now = Date.now()) {
  if (!session?.accessToken) return true;
  return Number(session.expiresAt || 0) - now <= EXPIRY_SKEW_MS;
}

/** Rótulo curto da conta, para a interface. */
export function describeSession(session) {
  if (!session?.accessToken) return 'Sem conta: usando só a chave de acesso';
  return session.email ? `Conta ${session.email}` : 'Conta conectada';
}

/* -------------------------------------------------------------------------- */
/*                                 Requisições                                */
/* -------------------------------------------------------------------------- */

export function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

/** Traduz as respostas do GoTrue para mensagens em português. */
export function authErrorMessage(status, data) {
  const code = String(data?.error_code || data?.code || '').toLowerCase();
  const raw = String(data?.msg || data?.error_description || data?.message || data?.error || '');
  const lower = raw.toLowerCase();

  if (code === 'invalid_credentials' || lower.includes('invalid login credentials')) {
    return 'E-mail ou senha incorretos.';
  }
  if (code === 'email_not_confirmed' || lower.includes('email not confirmed')) {
    return 'Confirme o e-mail: abra a mensagem que o Supabase enviou e clique no link antes de entrar.';
  }
  if (code === 'user_already_exists' || code === 'email_exists' || lower.includes('already registered')) {
    return 'Já existe uma conta com este e-mail. Use “Entrar”.';
  }
  if (code === 'weak_password' || lower.includes('password should be')) {
    return 'Senha muito fraca: use pelo menos 8 caracteres, com letras e números.';
  }
  if (code === 'email_address_invalid' || lower.includes('invalid email')) {
    return 'E-mail inválido.';
  }
  if (code === 'over_email_send_rate_limit' || status === 429) {
    return 'Muitas tentativas em pouco tempo. Aguarde um minuto e tente de novo.';
  }
  if (code === 'signup_disabled') {
    return 'Cadastro desativado neste projeto: crie a conta pelo painel do Supabase.';
  }
  if (status === 401 || status === 403) {
    return 'O Supabase recusou a operação. Confira as credenciais e tente de novo.';
  }
  return raw || `Falha na conta na nuvem (HTTP ${status}).`;
}

async function authRequest(config, path, { method = 'POST', body, token, fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('Este ambiente não permite acesso à rede (fetch indisponível).');
  }
  if (!config?.url || !config?.anonKey) {
    throw new Error('Banco compartilhado não configurado.');
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null;

  let response;
  try {
    response = await doFetch(`${String(config.url).replace(/\/+$/, '')}/auth/v1/${path}`, {
      method,
      headers: {
        apikey: config.anonKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller?.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('A conta na nuvem não respondeu a tempo. Tente novamente.');
    }
    throw new Error('Não foi possível falar com a conta na nuvem. Confira sua conexão.');
  } finally {
    if (timer) clearTimeout(timer);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(authErrorMessage(response.status, data));
    error.status = response.status;
    error.code = data?.error_code || data?.code || '';
    throw error;
  }
  return data;
}

/* -------------------------------------------------------------------------- */
/*                                  Ações                                     */
/* -------------------------------------------------------------------------- */

/** Entra com e-mail e senha e devolve a sessão já normalizada. */
export async function signIn(config, email, password, options = {}) {
  const mail = normalizeEmail(email);
  if (!mail || !password) throw new Error('Informe e-mail e senha da conta.');
  const data = await authRequest(config, 'token?grant_type=password', {
    body: { email: mail, password: String(password) },
    fetchImpl: options.fetchImpl,
  });
  const session = normalizeSession(data, options.now);
  if (!session) throw new Error('O Supabase não devolveu uma sessão válida. Tente de novo.');
  saveSession(session, options.storage);
  return session;
}

/**
 * Cria a conta.
 * @returns {Promise<{session: object|null, needsConfirmation: boolean, email: string}>}
 *   `needsConfirmation` = o projeto exige confirmar o e-mail antes do primeiro login.
 */
export async function signUp(config, email, password, options = {}) {
  const mail = normalizeEmail(email);
  if (!mail || !password) throw new Error('Informe e-mail e senha para criar a conta.');
  if (String(password).length < 8) throw new Error('A senha da conta precisa de pelo menos 8 caracteres.');

  const data = await authRequest(config, 'signup', {
    body: { email: mail, password: String(password) },
    fetchImpl: options.fetchImpl,
  });
  const session = normalizeSession(data, options.now);
  if (session) saveSession(session, options.storage);
  return { session, needsConfirmation: !session, email: mail };
}

/** Renova o token. Lança erro quando o refresh token também venceu. */
export async function refreshSession(config, session, options = {}) {
  if (!session?.refreshToken) throw new Error('Sessão sem token de renovação: entre de novo.');
  const data = await authRequest(config, 'token?grant_type=refresh_token', {
    body: { refresh_token: session.refreshToken },
    fetchImpl: options.fetchImpl,
  });
  const renewed = normalizeSession(data, options.now);
  if (!renewed) throw new Error('Não foi possível renovar a sessão: entre de novo.');
  saveSession(renewed, options.storage);
  return renewed;
}

/** Sai da conta no servidor (melhor esforço) e limpa a sessão local. */
export async function signOut(config, session, options = {}) {
  if (session?.accessToken && config?.url) {
    try {
      await authRequest(config, 'logout', { token: session.accessToken, fetchImpl: options.fetchImpl });
    } catch {
      /* sessão já expirada no servidor: seguimos limpando o local */
    }
  }
  clearSession(options.storage);
  return true;
}

/**
 * Token para mandar no `Authorization` das consultas ao banco.
 * Devolve `''` quando não há conta — nesse caso o app usa a chave anônima e o
 * banco só alcança cofres sem dono (comportamento antigo).
 */
export async function currentAccessToken(config, options = {}) {
  const storage = options.storage;
  const session = options.session || loadSession(storage);
  if (!session?.accessToken) return '';

  if (!isSessionExpired(session, options.now)) return session.accessToken;
  if (!session.refreshToken) {
    clearSession(storage);
    return '';
  }

  try {
    const renewed = await refreshSession(config, session, { fetchImpl: options.fetchImpl, storage, now: options.now });
    return renewed.accessToken;
  } catch {
    clearSession(storage);
    return '';
  }
}
