/**
 * Conversor — registro das chaves de acesso conhecidas neste navegador
 *
 * A chave de acesso (8 caracteres, `ABCD-EFGH`) é a identidade do cofre: quem
 * tem a chave abre os modelos. O banco guarda só o **slot** (HMAC da chave) e o
 * conteúdo cifrado — não há como "voltar" do slot para a chave.
 *
 * Por isso este registro existe: cada chave criada ou recuperada **neste
 * navegador** fica anotada aqui (no `localStorage`), para o administrador poder
 * ver, copiar, bloquear e excluir os códigos sem depender da memória. O slot
 * fica junto, porque é ele que identifica a linha no banco.
 *
 * Módulo só de dados (sem DOM), testável sozinho.
 */

import { normalizeAccessCode } from './sync-crypto.js';

/** Onde a lista fica guardada. */
export const REGISTRY_KEY = 'conversor_admin_vaults_v1';

/** Quantos códigos ficam anotados (os mais antigos caem primeiro). */
export const MAX_ENTRIES = 50;

/** Origens aceitas: como a chave chegou a este navegador. */
export const SOURCES = ['criada', 'recuperada', 'colada'];

const MAX_LABEL = 60;

function storageOf(storage) {
  if (storage) return storage;
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function isoOrNull(value) {
  const time = Date.parse(String(value ?? ''));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** `ABCD-EFGH`; devolve `''` quando a chave não é válida. */
function cleanCode(code) {
  try {
    return normalizeAccessCode(code) || '';
  } catch {
    return '';
  }
}

function cleanSlot(slot) {
  return String(slot ?? '')
    .trim()
    .slice(0, 120);
}

function cleanLabel(label) {
  return String(label ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LABEL);
}

/** Estado vazio do registro. */
export function emptyRegistry() {
  return { version: 1, entries: [] };
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const code = cleanCode(raw.code);
  const slot = cleanSlot(raw.slot);
  if (!code || !slot) return null;
  return {
    code,
    slot,
    createdAt: isoOrNull(raw.createdAt) || new Date(0).toISOString(),
    lastSeenAt: isoOrNull(raw.lastSeenAt),
    source: SOURCES.includes(raw.source) ? raw.source : 'colada',
    blockedAt: isoOrNull(raw.blockedAt),
    label: cleanLabel(raw.label),
  };
}

/** Limpa o que veio do `localStorage` (versão antiga, valor à mão, lixo). */
export function normalizeRegistry(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.entries)) return emptyRegistry();
  const seen = new Set();
  const entries = [];
  for (const item of raw.entries) {
    const entry = normalizeEntry(item);
    if (!entry || seen.has(entry.slot)) continue;
    seen.add(entry.slot);
    entries.push(entry);
  }
  entries.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
  return { version: 1, entries: entries.slice(0, MAX_ENTRIES) };
}

export function loadRegistry(storage) {
  const store = storageOf(storage);
  if (!store) return emptyRegistry();
  try {
    const raw = store.getItem(REGISTRY_KEY);
    return normalizeRegistry(raw ? JSON.parse(raw) : null);
  } catch {
    return emptyRegistry();
  }
}

/** Grava o registro. `false` quando o navegador bloqueia (modo privado, cota). */
export function saveRegistry(registry, storage) {
  const store = storageOf(storage);
  if (!store) return false;
  try {
    store.setItem(REGISTRY_KEY, JSON.stringify(normalizeRegistry(registry)));
    return true;
  } catch {
    return false;
  }
}

export function listVaults(storage) {
  return loadRegistry(storage).entries;
}

export function findVault(slot, storage) {
  const wanted = cleanSlot(slot);
  return listVaults(storage).find((entry) => entry.slot === wanted) || null;
}

/**
 * Anota (ou atualiza) uma chave. A data de criação é preservada quando a chave
 * já é conhecida — só a origem e o último contato mudam.
 *
 * @param {{code: string, slot: string, source?: string, label?: string, lastSeenAt?: string|number}} input
 * @returns {{entry: object|null, registry: object}}
 */
export function registerVault(input, storage, now = Date.now()) {
  const registry = loadRegistry(storage);
  const code = cleanCode(input?.code);
  const slot = cleanSlot(input?.slot);
  if (!code || !slot) return { entry: null, registry };

  const existing = registry.entries.find((entry) => entry.slot === slot);
  const stamp = new Date(Number(now) || Date.now()).toISOString();
  const entry = {
    code,
    slot,
    createdAt: existing?.createdAt || stamp,
    lastSeenAt: existing?.lastSeenAt || null,
    source: SOURCES.includes(input?.source) ? input.source : existing?.source || 'colada',
    blockedAt: existing?.blockedAt || null,
    label: cleanLabel(input?.label) || existing?.label || '',
  };

  registry.entries = [entry, ...registry.entries.filter((item) => item.slot !== slot)].slice(0, MAX_ENTRIES);
  saveRegistry(registry, storage);
  return { entry, registry };
}

/** Marca o último uso da chave (chamado a cada sincronização). */
export function touchVault(slot, storage, now = Date.now()) {
  const registry = loadRegistry(storage);
  const entry = registry.entries.find((item) => item.slot === cleanSlot(slot));
  if (!entry) return null;
  entry.lastSeenAt = new Date(Number(now) || Date.now()).toISOString();
  saveRegistry(registry, storage);
  return entry;
}

/** Anota/limpa o bloqueio vindo do banco. */
export function markVaultBlocked(slot, blockedAt, storage) {
  const registry = loadRegistry(storage);
  const entry = registry.entries.find((item) => item.slot === cleanSlot(slot));
  if (!entry) return null;
  entry.blockedAt = blockedAt ? isoOrNull(blockedAt) || new Date().toISOString() : null;
  saveRegistry(registry, storage);
  return entry;
}

/** Remove a chave do registro (depois de excluir do banco, ou a pedido). */
export function removeVault(slot, storage) {
  const registry = loadRegistry(storage);
  const before = registry.entries.length;
  registry.entries = registry.entries.filter((item) => item.slot !== cleanSlot(slot));
  saveRegistry(registry, storage);
  return registry.entries.length < before;
}

/** `ABCD-••••` — o suficiente para reconhecer sem mostrar a chave na tela. */
export function maskCode(code) {
  const clean = cleanCode(code);
  if (!clean) return '—';
  return `${clean.slice(0, 4)}-••••`;
}

/** Apelido curto de um slot (para linhas que só existem no banco). */
export function shortSlot(slot) {
  const clean = cleanSlot(slot);
  if (!clean) return '—';
  return clean.length <= 10 ? clean : `${clean.slice(0, 10)}…`;
}

/**
 * Junta o que este navegador sabe (chave + datas + origem) com o que o banco
 * devolveu (existe? está bloqueado? de quem é?).
 *
 * Devolve uma linha por cofre, já pronta para o painel:
 *
 * - `code`  — a chave completa, quando este navegador a conhece (`null` quando
 *             o cofre só foi visto no banco, porque o banco guarda só o slot);
 * - `inDb`  — `true` quando a linha existe no banco agora;
 * - bloqueado — `blockedAt` vem do banco; o registro local só é usado como
 *             memória quando o banco não respondeu.
 *
 * As linhas bloqueadas vêm primeiro; depois, as usadas mais recentemente.
 */
export function mergeVaultView(entries, rows = [], options = {}) {
  const currentSlot = cleanSlot(options.currentSlot);
  const bySlot = new Map();
  const now = options.now || new Date().toISOString();

  for (const entry of normalizeRegistry({ version: 1, entries }).entries) {
    bySlot.set(entry.slot, {
      slot: entry.slot,
      code: entry.code,
      masked: maskCode(entry.code),
      shortSlot: shortSlot(entry.slot),
      createdAt: entry.createdAt,
      lastSeenAt: entry.lastSeenAt,
      source: entry.source,
      label: entry.label,
      blockedAt: entry.blockedAt,
      inDb: false,
      ownerId: null,
      dbUpdatedAt: null,
      isCurrent: entry.slot === currentSlot,
    });
  }

  for (const row of Array.isArray(rows) ? rows : []) {
    const slot = cleanSlot(row?.slot);
    if (!slot) continue;
    const known = bySlot.get(slot);
    const blockedAt = isoOrNull(row?.blockedAt);
    if (known) {
      known.inDb = true;
      known.ownerId = row?.ownerId || null;
      known.dbUpdatedAt = isoOrNull(row?.updatedAt);
      known.blockedAt = blockedAt;
      continue;
    }
    bySlot.set(slot, {
      slot,
      code: null,
      masked: shortSlot(slot),
      shortSlot: shortSlot(slot),
      createdAt: isoOrNull(row?.updatedAt) || now,
      lastSeenAt: null,
      source: 'banco',
      label: '',
      blockedAt,
      inDb: true,
      ownerId: row?.ownerId || null,
      dbUpdatedAt: isoOrNull(row?.updatedAt),
      isCurrent: slot === currentSlot,
    });
  }

  const when = (value) => Date.parse(value || '') || 0;
  return [...bySlot.values()].sort((a, b) => {
    if (Boolean(a.blockedAt) !== Boolean(b.blockedAt)) return a.blockedAt ? -1 : 1;
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    return Math.max(when(b.lastSeenAt), when(b.dbUpdatedAt), when(b.createdAt)) -
      Math.max(when(a.lastSeenAt), when(a.dbUpdatedAt), when(a.createdAt));
  });
}

/** Quantos cofres estão bloqueados numa lista de `mergeVaultView`. */
export function countBlocked(list) {
  return (Array.isArray(list) ? list : []).filter((item) => item?.blockedAt).length;
}
