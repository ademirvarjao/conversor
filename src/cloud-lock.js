/**
 * Conversor — Trava de acesso à aba "Nuvem"
 *
 * A aba Nuvem mexe na sincronização dos modelos (criar/entrar com a chave de
 * acesso, enviar, baixar e trocar o banco). Aqui fica o portão de entrada:
 * login + senha conferidos **no navegador** contra um hash PBKDF2-SHA256.
 *
 * ── O que esta trava é e o que ela não é ──────────────────────────────────
 * Ela impede que qualquer pessoa que use este computador abra a aba, veja a
 * chave de acesso ou envie/baixe modelos. Não é autenticação de servidor: o
 * app é estático (GitHub Pages), então quem souber programar pode burlar a
 * tela — e as chaves públicas do Supabase estão no código de qualquer forma.
 * O sigilo dos modelos continua vindo da criptografia (a chave de acesso),
 * que é o que importa: o banco só guarda texto cifrado.
 *
 * A senha em texto puro **não** existe no repositório: ficam apenas o salt
 * aleatório, o número de iterações e o hash.
 */

/** Configuração do portão. Trocar a senha = gerar novo salt + hash. */
export const CLOUD_LOCK = {
  /** Login do administrador (não é segredo, só evita confusão de usuário). */
  user: 'gogita',
  /** Salt aleatório de 16 bytes (base64). */
  salt: '4ag/bA9/+ic1f+OBaI0FXw==',
  /** Iterações do PBKDF2-SHA256. */
  iterations: 210000,
  /** Hash de 32 bytes (base64) da senha. */
  hash: 'Yti3LTJZbtC1Yr5UBQUUVXYMJIbY2z0UkCDf/2du8NE=',
};

/** Onde guardamos o desbloqueio (por aba do navegador). */
export const UNLOCK_KEY = 'conversor_cloud_unlock_v1';

/** Quanto tempo o desbloqueio vale antes de pedir a senha de novo (1 hora). */
export const UNLOCK_TTL_MS = 60 * 60 * 1000;

/** Tentativas erradas até o portão entrar em espera. */
export const MAX_ATTEMPTS = 5;

/** Tempo de espera depois de estourar as tentativas (30 segundos). */
export const LOCKOUT_MS = 30 * 1000;

function storageOf(storage) {
  if (storage) return storage;
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null;
  }
}

function toBase64(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return typeof btoa === 'function' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64');
}

function fromBase64(value) {
  const binary = typeof atob === 'function' ? atob(value) : Buffer.from(value, 'base64').toString('binary');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Comparação em tempo praticamente constante (evita vazar o prefixo certo). */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function webCrypto(cryptoImpl) {
  const impl = cryptoImpl || globalThis.crypto;
  if (!impl?.subtle) throw new Error('Este navegador não permite validar a senha (WebCrypto indisponível).');
  return impl;
}

/**
 * Confere login e senha contra a configuração da trava.
 * @param {string} user
 * @param {string} password
 * @param {{lock?: typeof CLOUD_LOCK, crypto?: Crypto}} [options]
 * @returns {Promise<boolean>}
 */
export async function verifyCloudCredentials(user, password, options = {}) {
  const lock = options.lock || CLOUD_LOCK;
  const informedUser = String(user ?? '').trim().toLowerCase();
  const informedPassword = String(password ?? '');
  if (!informedUser || !informedPassword) return false;
  // O login é comparado sem diferenciar maiúsculas; a senha é exata.
  if (informedUser !== String(lock.user).trim().toLowerCase()) return false;

  const cryptoImpl = webCrypto(options.crypto);
  const key = await cryptoImpl.subtle.importKey(
    'raw',
    new TextEncoder().encode(informedPassword),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await cryptoImpl.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: fromBase64(lock.salt),
      iterations: lock.iterations,
    },
    key,
    256
  );

  return safeEqual(toBase64(bits), String(lock.hash));
}

/**
 * Desbloqueio válido guardado nesta aba.
 * @returns {{user: string, expiresAt: number}|null}
 */
export function loadUnlock(storage, now = Date.now()) {
  const store = storageOf(storage);
  if (!store) return null;
  try {
    const raw = store.getItem(UNLOCK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.expiresAt !== 'number') return null;
    if (parsed.expiresAt <= now) {
      store.removeItem(UNLOCK_KEY);
      return null;
    }
    return { user: String(parsed.user || ''), expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

/** Marca a aba como desbloqueada por `UNLOCK_TTL_MS`. */
export function saveUnlock(storage, { user = CLOUD_LOCK.user, now = Date.now(), ttl = UNLOCK_TTL_MS } = {}) {
  const store = storageOf(storage);
  if (!store) return false;
  try {
    store.setItem(UNLOCK_KEY, JSON.stringify({ user, expiresAt: now + ttl, unlockedAt: now }));
    return true;
  } catch {
    return false;
  }
}

/** Bloqueia de novo (a aba volta a pedir login e senha). */
export function clearUnlock(storage) {
  const store = storageOf(storage);
  if (!store) return false;
  try {
    store.removeItem(UNLOCK_KEY);
    return true;
  } catch {
    return false;
  }
}
