/**
 * Conversor — Criptografia e identidade da sincronização na nuvem
 *
 * O app é 100% estático, então a "conta" do usuário é uma **chave de acesso**
 * curta, sem senha e sem cadastro:
 *
 *   chave  = 8 caracteres (alfabeto de 32 símbolos, sem ambiguidade) ~ 40 bits
 *            o alfabeto exclui os pares confusos 0/O e 1/I/l, então qualquer
 *            um desses símbolos digitado é erro de digitação, não outra letra;
 *   PBKDF2 = 310.000 iterações de SHA-256  → material de 32 bytes
 *   slot   = HMAC(material, "slot")        → id opaco no banco compartilhado
 *   AES    = HMAC(material, "enc")         → AES-GCM-256 do conteúdo
 *
 * Consequências:
 *  - o banco guarda apenas texto cifrado; quem tiver a chave anônima do Supabase
 *    não consegue ler nem relacionar os modelos de usuários diferentes;
 *  - o "slot" é derivado da chave, então ninguém enumera as contas por nome;
 *  - as 310.000 iterações encarecem muito o teste de chave por força bruta,
 *    o que é indispensável porque a chave é curta.
 *
 * Nada aqui toca no DOM e tudo roda igualmente no navegador e no Node (o que
 * permite testar a criptografia de verdade na suíte).
 */

/**
 * 32 símbolos para não confundir ao ditar ou digitar: são 24 letras (sem I e O)
 * e os dígitos 2–9. Os símbolos 0, O, 1, I e l ficam de fora por serem os que se
 * confundem entre si — assim 32^8 = 2^40 combinações, sem ambiguidade.
 */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const CODE_LENGTH = 8;

/** Iterações do PBKDF2 usadas em produção. */
export const PBKDF2_ITERATIONS = 310000;

/** Sal fixo do PBKDF2: precisa ser igual em todos os dispositivos. */
const PBKDF2_SALT = 'conversor-cloud-v1|identidade';

/** Prefixo de versão do envelope cifrado. */
const ENVELOPE_PREFIX = 'v1';

const IV_BYTES = 12;

function subtleCrypto() {
  const webcrypto = globalThis.crypto;
  if (!webcrypto?.subtle) {
    throw new Error('Este navegador não oferece WebCrypto (necessário para a nuvem).');
  }
  return webcrypto;
}

/* -------------------------------------------------------------------------- */
/*                                 Chave de acesso                            */
/* -------------------------------------------------------------------------- */

/**
 * Normaliza o que o usuário digitou: aceita minúsculas, espaços, hífens e
 * pontuação e valida o alfabeto. Não "adivinha" símbolos: 0, O, 1 e I nunca
 * aparecem numa chave, então digitá-los significa que a chave está errada —
 * melhor recusar do que gravar num slot diferente por causa de um typo.
 * @returns {string|null} chave canônica ou null se inválida
 */
export function normalizeAccessCode(input) {
  const raw = String(input ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

  if (raw.length !== CODE_LENGTH) return null;
  for (const char of raw) {
    if (!CODE_ALPHABET.includes(char)) return null;
  }
  return raw;
}

/** Exibe a chave em dois blocos: `ABCD-EFGH`. */
export function formatAccessCode(code) {
  const normalized = normalizeAccessCode(code);
  if (!normalized) return '';
  return groupsOf4(normalized);
}

function groupsOf4(code) {
  return `${code.slice(0, 4)}-${code.slice(4, 8)}`;
}

/**
 * Gera uma chave de acesso nova.
 * @param {(size:number)=>Uint8Array} [randomFn] injetável para testes
 */
export function generateAccessCode(randomFn) {
  const random = randomFn || ((size) => subtleCrypto().getRandomValues(new Uint8Array(size)));
  // Rejeição simples para evitar viés de módulo.
  const limit = Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length;
  let code = '';
  while (code.length < CODE_LENGTH) {
    const bytes = random(CODE_LENGTH * 2);
    for (const byte of bytes) {
      if (byte >= limit) continue;
      code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      if (code.length === CODE_LENGTH) break;
    }
  }
  return code;
}

/* -------------------------------------------------------------------------- */
/*                              Derivação de chaves                           */
/* -------------------------------------------------------------------------- */

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = typeof btoa === 'function' ? btoa(binary) : '';
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(text) {
  const normalized = String(text || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Deriva, a partir da chave de acesso, o identificador do slot no banco e a
 * chave AES-GCM que cifra o conteúdo.
 *
 * @param {string} code chave digitada (com ou sem hífen)
 * @param {{iterations?: number}} [options] iterações (menores nos testes)
 * @returns {Promise<{code:string, slot:string, aesKey:CryptoKey}>}
 */
export async function deriveAccessKeys(code, options = {}) {
  const normalized = normalizeAccessCode(code);
  if (!normalized) {
    throw new Error('Chave de acesso inválida: use as 8 letras/números gerados pelo app.');
  }

  const crypto = subtleCrypto();
  const iterations = Math.max(1, Math.floor(options.iterations || PBKDF2_ITERATIONS));
  const encoder = new TextEncoder();

  const baseKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(normalized),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const material = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: encoder.encode(PBKDF2_SALT), iterations, hash: 'SHA-256' },
    baseKey,
    256
  );

  const hmacKey = await crypto.subtle.importKey(
    'raw',
    material,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const slotBytes = await crypto.subtle.sign('HMAC', hmacKey, encoder.encode('slot'));
  const encBytes = await crypto.subtle.sign('HMAC', hmacKey, encoder.encode('enc'));

  const aesKey = await crypto.subtle.importKey('raw', encBytes, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);

  return {
    code: normalized,
    // 128 bits bastam para identificar o slot e evitam colisão acidental.
    slot: bytesToHex(new Uint8Array(slotBytes)).slice(0, 32),
    aesKey,
  };
}

/* -------------------------------------------------------------------------- */
/*                            Envelope cifrado (AES)                          */
/* -------------------------------------------------------------------------- */

/**
 * Cifra um objeto JSON e devolve `v1.<base64url(iv|cifra)>`.
 * @returns {Promise<string>}
 */
export async function encryptPayload(aesKey, data) {
  const crypto = subtleCrypto();
  const encoder = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = encoder.encode(JSON.stringify(data));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plaintext)
  );

  const envelope = new Uint8Array(iv.length + ciphertext.length);
  envelope.set(iv, 0);
  envelope.set(ciphertext, iv.length);
  return `${ENVELOPE_PREFIX}.${bytesToBase64Url(envelope)}`;
}

/**
 * Decifra o envelope produzido por `encryptPayload`.
 * Lança erro amigável quando a chave não corresponde ao conteúdo.
 * @returns {Promise<any>}
 */
export async function decryptPayload(aesKey, envelope) {
  const text = String(envelope || '');
  const [prefix, body] = text.split('.');
  if (prefix !== ENVELOPE_PREFIX || !body) {
    throw new Error('Conteúdo da nuvem em formato desconhecido.');
  }

  const crypto = subtleCrypto();
  let bytes;
  try {
    bytes = base64UrlToBytes(body);
  } catch {
    throw new Error('Não foi possível abrir os dados desta chave de acesso.');
  }
  if (bytes.length <= IV_BYTES) throw new Error('Conteúdo da nuvem está corrompido.');

  const iv = bytes.slice(0, IV_BYTES);
  const ciphertext = bytes.slice(IV_BYTES);

  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertext);
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new Error('Não foi possível abrir os dados desta chave de acesso.');
  }
}
