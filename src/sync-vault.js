/**
 * Conversor — Cofre compartilhado da memória da IA
 *
 * Reúne o que a interface precisa para "guardar os modelos treinados na nuvem":
 *  - identidade local (chave de acesso + slot), sem senha e sem cadastro;
 *  - configuração do projeto Supabase (URL + chave anônima pública);
 *  - montagem/limpeza do pacote enviado (nunca inclui a chave do LLM);
 *  - envio e recuperação com resolução de conflito por data.
 *
 * O conteúdo trafega cifrado (ver `sync-crypto.js`); aqui só cuidamos do
 * ciclo de vida e da forma dos dados.
 */

import { normalizeMemory } from './ai-engine.js';
import { DEFAULT_CLOUD_CONFIG } from './sync-config.js';
import { decryptPayload, deriveAccessKeys, encryptPayload } from './sync-crypto.js';
import { fetchRemoteVault, normalizeSupabaseConfig, saveRemoteVault } from './sync-client.js';

export const IDENTITY_KEY = 'conversor_cloud_identity_v1';
export const CONFIG_KEY = 'conversor_cloud_config_v1';

/** Versão do formato do pacote sincronizado. */
export const VAULT_VERSION = 1;

function memoryStorage(storage) {
  if (storage) return storage;
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function readJson(storage, key) {
  const store = memoryStorage(storage);
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(storage, key, value) {
  const store = memoryStorage(storage);
  if (!store) return false;
  try {
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Identidade                                */
/* -------------------------------------------------------------------------- */

/** @returns {{code:string, slot:string, createdAt:string, lastSyncAt:string|null}|null} */
export function loadIdentity(storage) {
  const raw = readJson(storage, IDENTITY_KEY);
  if (!raw || typeof raw.code !== 'string' || typeof raw.slot !== 'string') return null;
  return {
    code: raw.code,
    slot: raw.slot,
    createdAt: raw.createdAt || new Date().toISOString(),
    lastSyncAt: raw.lastSyncAt || null,
  };
}

export function saveIdentity(identity, storage) {
  if (!identity?.code || !identity?.slot) return false;
  return writeJson(storage, IDENTITY_KEY, {
    code: identity.code,
    slot: identity.slot,
    createdAt: identity.createdAt || new Date().toISOString(),
    lastSyncAt: identity.lastSyncAt || null,
  });
}

export function touchIdentitySync(identity, timestamp = new Date().toISOString(), storage) {
  if (!identity) return null;
  const updated = { ...identity, lastSyncAt: timestamp };
  saveIdentity(updated, storage);
  return updated;
}

export function clearIdentity(storage) {
  const store = memoryStorage(storage);
  if (!store) return false;
  try {
    store.removeItem(IDENTITY_KEY);
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/*                              Configuração do banco                         */
/* -------------------------------------------------------------------------- */

/**
 * Configuração efetiva do banco: a que o usuário salvou neste navegador tem
 * prioridade; senão vale a que veio embutida no app (`sync-config.js`), que já
 * aponta para o projeto oficial do Conversor.
 *
 * @param {Storage} [storage]
 * @param {{url?: string, anonKey?: string}} [fallback] padrão embutido
 *   (parâmetro usado pelos testes para isolar o valor publicado).
 * @returns {{url:string, anonKey:string}|null}
 */
export function loadCloudConfig(storage, fallback = DEFAULT_CLOUD_CONFIG) {
  return normalizeSupabaseConfig(readJson(storage, CONFIG_KEY)) || normalizeSupabaseConfig(fallback);
}

/**
 * `true` quando existe banco embutido no app (mesmo que o usuário ainda não
 * tenha criado a chave de acesso dele).
 */
export function hasBuiltInCloudConfig(fallback = DEFAULT_CLOUD_CONFIG) {
  return normalizeSupabaseConfig(fallback) !== null;
}

export function saveCloudConfig(config, storage) {
  const normalized = normalizeSupabaseConfig(config);
  if (!normalized) return false;
  return writeJson(storage, CONFIG_KEY, normalized);
}

export function clearCloudConfig(storage) {
  const store = memoryStorage(storage);
  if (!store) return false;
  try {
    store.removeItem(CONFIG_KEY);
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/*                            Pacote da memória                               */
/* -------------------------------------------------------------------------- */

/**
 * Monta o pacote que vai para a nuvem. Só saem os modelos aprendidos:
 * a chave do conector LLM (dado pessoal do usuário) nunca é enviada.
 */
export function buildVaultPayload(memory, options = {}) {
  const safe = normalizeMemory(memory || {});
  return {
    v: VAULT_VERSION,
    updatedAt: options.updatedAt || new Date().toISOString(),
    appVersion: options.appVersion || '',
    tokenWeights: safe.tokenWeights,
    learnedProfiles: safe.learnedProfiles,
    learningLog: safe.learningLog,
    stats: safe.stats,
    counterparties: safe.counterparties,
  };
}

/**
 * Aplica um pacote baixado sobre a memória local, preservando as preferências
 * locais (chave do LLM, provedor e modelo escolhidos neste navegador).
 */
export function applyVaultPayload(currentMemory, payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Pacote da nuvem inválido.');
  }

  const restored = normalizeMemory({
    tokenWeights: payload.tokenWeights,
    learnedProfiles: payload.learnedProfiles,
    learningLog: payload.learningLog,
    stats: payload.stats,
    counterparties: payload.counterparties,
  });

  const localLlm = currentMemory?.optionalLlm;
  if (localLlm && typeof localLlm === 'object') {
    restored.optionalLlm = {
      provider: localLlm.provider || 'none',
      apiKey: localLlm.apiKey || '',
      model: localLlm.model || '',
    };
  }

  return restored;
}

/** Compara dois pacotes pela data de atualização. */
export function isPayloadNewer(candidate, reference) {
  const candidateTime = Date.parse(candidate?.updatedAt || '') || 0;
  const referenceTime = Date.parse(reference?.updatedAt || '') || 0;
  return candidateTime > referenceTime;
}

/* -------------------------------------------------------------------------- */
/*                                Sincronização                               */
/* -------------------------------------------------------------------------- */

/**
 * Envia a memória atual para o banco compartilhado.
 * @returns {Promise<{updatedAt: string}>}
 */
export async function pushVault({ config, identity, memory, appVersion, fetchImpl, now, iterations }) {
  const normalized = normalizeSupabaseConfig(config);
  if (!normalized) throw new Error('Configure o banco compartilhado antes de enviar.');
  if (!identity?.slot) throw new Error('Gere ou informe uma chave de acesso primeiro.');

  const updatedAt = now || new Date().toISOString();
  const payload = buildVaultPayload(memory, { updatedAt, appVersion });
  const { aesKey } = await deriveAccessKeys(identity.code, { iterations });
  const envelope = await encryptPayload(aesKey, payload);

  await saveRemoteVault(normalized, identity.slot, envelope, { fetchImpl });
  return { updatedAt, payload };
}

/**
 * Baixa o pacote do slot e devolve o conteúdo já decifrado.
 * @returns {Promise<{payload: object, updatedAt: string}|null>}
 */
export async function pullVault({ config, identity, fetchImpl, iterations }) {
  const normalized = normalizeSupabaseConfig(config);
  if (!normalized) throw new Error('Configure o banco compartilhado antes de baixar.');
  if (!identity?.slot) throw new Error('Gere ou informe uma chave de acesso primeiro.');

  const remote = await fetchRemoteVault(normalized, identity.slot, { fetchImpl });
  if (!remote) return null;

  const { aesKey } = await deriveAccessKeys(identity.code, { iterations });
  const payload = await decryptPayload(aesKey, remote.payload);
  return { payload, updatedAt: payload.updatedAt || remote.updatedAt };
}

/**
 * Reconstrói a identidade a partir de uma chave já existente (outra máquina).
 * Não valida contra o servidor — quem chama deve tentar um `pullVault`.
 */
export async function restoreIdentityFromCode(code, options = {}) {
  const { code: normalized, slot } = await deriveAccessKeys(code, options);
  return { code: normalized, slot, createdAt: new Date().toISOString(), lastSyncAt: null };
}
