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
import { currentAccessToken } from './cloud-auth.js';
import { DEFAULT_CLOUD_CONFIG } from './sync-config.js';
import { decryptPayload, deriveAccessKeys, encryptPayload } from './sync-crypto.js';
import { fetchRemoteVault, normalizeSupabaseConfig, saveRemoteVault } from './sync-client.js';
import { markVaultBlocked, registerVault, touchVault } from './vault-registry.js';

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
  const saved = writeJson(storage, IDENTITY_KEY, {
    code: identity.code,
    slot: identity.slot,
    createdAt: identity.createdAt || new Date().toISOString(),
    lastSyncAt: identity.lastSyncAt || null,
  });
  // Toda chave que passa por aqui entra no registro do administrador: é a única
  // forma de o painel mostrar o código (o banco só guarda o slot derivado).
  if (saved) {
    registerVault(
      { code: identity.code, slot: identity.slot, source: identity.source || 'colada' },
      storage
    );
  }
  return saved;
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

/** Erro único para cofre bloqueado (a UI mostra a mesma frase em todo lugar). */
export function vaultBlockedError(code, blockedAt = null) {
  const error = new Error(
    'Esta chave de acesso está bloqueada pelo administrador: o envio e o download de modelos ficam suspensos. ' +
      'Use outra chave ou peça o desbloqueio no painel do administrador.'
  );
  error.code = 'VAULT_BLOCKED';
  error.blockedAt = blockedAt;
  error.accessCode = code;
  return error;
}

/** Data em milissegundos (0 quando ausente ou inválida). */
function stamp(value) {
  const time = Date.parse(String(value ?? ''));
  return Number.isFinite(time) ? time : 0;
}

/** Une dois mapas `chave -> { hits, updatedAt }`, ficando com o mais recente. */
function mergeAccountBucket(local = {}, remote = {}) {
  const merged = { ...remote };
  for (const [key, info] of Object.entries(local)) {
    const other = merged[key];
    if (!other || stamp(info?.updatedAt) >= stamp(other?.updatedAt)) merged[key] = info;
  }
  return merged;
}

/**
 * Junta as memórias de contrapartida dos dois lados: o que foi aprendido aqui e
 * o que foi aprendido em outra máquina. Nada é descartado — em conflito ganha o
 * lado com a data mais recente.
 */
function mergeCounterparties(local, remote) {
  const left = local && typeof local === 'object' ? local : {};
  const right = remote && typeof remote === 'object' ? remote : {};
  const remoteIsNewer = stamp(right.updatedAt) > stamp(left.updatedAt);

  // Em conflito, o lado mais recente sobrescreve o outro.
  const prefer = remoteIsNewer ? { ...(left.aliases || {}), ...(right.aliases || {}) } : { ...(right.aliases || {}), ...(left.aliases || {}) };

  const tokenWeights = {};
  for (const source of [right.tokenWeights || {}, left.tokenWeights || {}]) {
    for (const [code, tokens] of Object.entries(source)) {
      const entry = { ...(tokenWeights[code] || {}) };
      for (const [token, weight] of Object.entries(tokens || {})) {
        entry[token] = Math.max(Number(entry[token]) || 0, Number(weight) || 0);
      }
      tokenWeights[code] = entry;
    }
  }

  const contacts = { ...(right.contacts || {}) };
  for (const [code, info] of Object.entries(left.contacts || {})) {
    const other = contacts[code];
    if (!other) {
      contacts[code] = info;
      continue;
    }
    const winner = remoteIsNewer ? other : info;
    contacts[code] = { ...winner, hits: Math.max(Number(other.hits) || 0, Number(info.hits) || 0) };
  }

  return {
    version: 2,
    aliases: prefer,
    tokenWeights,
    contacts,
    accounts: {
      byHistory: mergeAccountBucket(left.accounts?.byHistory, right.accounts?.byHistory),
      byContact: mergeAccountBucket(left.accounts?.byContact, right.accounts?.byContact),
    },
    uses: Math.max(Number(left.uses) || 0, Number(right.uses) || 0),
    updatedAt: remoteIsNewer ? right.updatedAt : left.updatedAt,
  };
}

/**
 * Aplica o pacote da nuvem **somando** ao que já existe neste navegador.
 *
 * É o que a sincronização automática usa: com o envio e o download acontecendo
 * sem o usuário pedir, substituir a memória local poderia apagar um treinamento
 * feito offline. Aqui os dois lados são unidos (perfis e histórico por `id`,
 * pesos e contas pelo maior/mais recente) e as preferências locais — chave do
 * LLM, assinaturas de layout e catálogo da comunidade — são preservadas.
 */
export function mergeVaultPayload(currentMemory, payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Pacote da nuvem inválido.');
  }

  const local = normalizeMemory(currentMemory || {});
  const remote = applyVaultPayload(local, payload);

  // Perfis de layout: união por id; em conflito fica o usado por último.
  const profiles = new Map();
  for (const profile of remote.learnedProfiles) profiles.set(profile.id, profile);
  for (const profile of local.learnedProfiles) {
    const existing = profiles.get(profile.id);
    if (!existing || stamp(profile.lastUsedAt) > stamp(existing.lastUsedAt)) {
      profiles.set(profile.id, profile);
    }
  }
  const learnedProfiles = [...profiles.values()].sort((a, b) => stamp(b.lastUsedAt) - stamp(a.lastUsedAt));

  // Histórico de aprendizado: união por id, do mais recente para o mais antigo.
  const entries = new Map();
  for (const entry of remote.learningLog) entries.set(entry.id, entry);
  for (const entry of local.learningLog) {
    if (!entries.has(entry.id)) entries.set(entry.id, entry);
  }
  const learningLog = [...entries.values()].sort((a, b) => stamp(b.timestamp) - stamp(a.timestamp));

  // Pesos semânticos: cada token/papel fica com o maior peso dos dois lados.
  const tokenWeights = { ...remote.tokenWeights };
  for (const [token, roles] of Object.entries(local.tokenWeights || {})) {
    const merged = { ...(tokenWeights[token] || {}) };
    for (const [role, weight] of Object.entries(roles || {})) {
      merged[role] = Math.max(Number(merged[role]) || 0, Number(weight) || 0);
    }
    tokenWeights[token] = merged;
  }

  return normalizeMemory({
    tokenWeights,
    learnedProfiles,
    learningLog,
    stats: {
      totalFilesProcessed: Math.max(local.stats.totalFilesProcessed, remote.stats.totalFilesProcessed),
      autoMatchedCount: Math.max(local.stats.autoMatchedCount, remote.stats.autoMatchedCount),
      correctionsLearned: Math.max(local.stats.correctionsLearned, remote.stats.correctionsLearned),
    },
    counterparties: mergeCounterparties(local.counterparties, remote.counterparties),
    // Preferências que nunca sobem para a nuvem continuam sendo as daqui.
    optionalLlm: local.optionalLlm,
    layoutSignatures: local.layoutSignatures,
    settings: local.settings,
  });
}

/* -------------------------------------------------------------------------- */
/*                                Sincronização                               */
/* -------------------------------------------------------------------------- */

/**
 * Envia a memória atual para o banco compartilhado.
 * @returns {Promise<{updatedAt: string}>}
 */
export async function pushVault({
  config,
  identity,
  memory,
  appVersion,
  fetchImpl,
  now,
  iterations,
  accessToken,
  storage,
}) {
  const normalized = normalizeSupabaseConfig(config);
  if (!normalized) throw new Error('Configure o banco compartilhado antes de enviar.');
  if (!identity?.slot) throw new Error('Gere ou informe uma chave de acesso primeiro.');

  const updatedAt = now || new Date().toISOString();
  const payload = buildVaultPayload(memory, { updatedAt, appVersion });
  const { aesKey } = await deriveAccessKeys(identity.code, { iterations });
  const envelope = await encryptPayload(aesKey, payload);

  // Com conta na nuvem o POST vai autenticado e o banco grava o cofre como
  // sendo dessa conta (owner_id = auth.uid()).
  const token = accessToken ?? (await currentAccessToken(normalized, { fetchImpl, storage }));
  try {
    await saveRemoteVault(normalized, identity.slot, envelope, { fetchImpl, accessToken: token });
  } catch (error) {
    // O banco barra a escrita de cofre bloqueado pelo administrador.
    if (/conversor_vault_blocked|bloqueado pelo administrador/i.test(String(error?.detail || error?.message || ''))) {
      throw vaultBlockedError(identity.code);
    }
    throw error;
  }
  touchVault(identity.slot, storage);
  registerVault({ code: identity.code, slot: identity.slot }, storage);
  return { updatedAt, payload, owned: Boolean(token) };
}

/**
 * Baixa o pacote do slot e devolve o conteúdo já decifrado.
 * @returns {Promise<{payload: object, updatedAt: string}|null>}
 */
export async function pullVault({ config, identity, fetchImpl, iterations, accessToken, storage }) {
  const normalized = normalizeSupabaseConfig(config);
  if (!normalized) throw new Error('Configure o banco compartilhado antes de baixar.');
  if (!identity?.slot) throw new Error('Gere ou informe uma chave de acesso primeiro.');

  const token = accessToken ?? (await currentAccessToken(normalized, { fetchImpl, storage }));
  const remote = await fetchRemoteVault(normalized, identity.slot, { fetchImpl, accessToken: token });
  if (!remote) return null;

  if (remote.blockedAt) {
    markVaultBlocked(identity.slot, remote.blockedAt, storage);
    throw vaultBlockedError(identity.code, remote.blockedAt);
  }
  markVaultBlocked(identity.slot, null, storage);
  touchVault(identity.slot, storage);

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
  return {
    code: normalized,
    slot,
    createdAt: new Date().toISOString(),
    lastSyncAt: null,
    // Como a chave chegou aqui: criada, recuperada (mesma chave de outro
    // computador) ou colada. Serve só para o painel do administrador.
    source: ['criada', 'recuperada'].includes(options.source) ? options.source : 'colada',
  };
}
