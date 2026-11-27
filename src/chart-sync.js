/**
 * Conversor — Persistência do Plano de Contas e aprendizado da I.A. no Supabase
 *
 * Comunica com as RPCs `conversor_chart_load`, `conversor_chart_sync_plan` e
 * `conversor_chart_learn_batch` usando a configuração pública do projeto
 * Supabase (`sync-config.js`) e mantém um cache local de respaldo no navegador.
 */

import { DEFAULT_CLOUD_CONFIG } from './sync-config.js';
import { normalizeSupabaseConfig } from './sync-client.js';

export const CHART_CACHE_KEY = 'conversor_chart_of_accounts_v1';
const DEFAULT_TIMEOUT_MS = 25000;

function memoryStorage(storage) {
  if (storage) return storage;
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function loadChartCache(storage) {
  const store = memoryStorage(storage);
  if (!store) return null;
  try {
    const raw = store.getItem(CHART_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      plans: Array.isArray(parsed.plans) ? parsed.plans : [],
      plan: parsed.plan && typeof parsed.plan === 'object' ? parsed.plan : null,
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
      rules: Array.isArray(parsed.rules) ? parsed.rules : [],
      tokens: Array.isArray(parsed.tokens) ? parsed.tokens : [],
    };
  } catch {
    return null;
  }
}

export function saveChartCache(data, storage) {
  const store = memoryStorage(storage);
  if (!store || !data) return false;
  try {
    store.setItem(
      CHART_CACHE_KEY,
      JSON.stringify({
        plans: Array.isArray(data.plans) ? data.plans : [],
        plan: data.plan || null,
        accounts: Array.isArray(data.accounts) ? data.accounts : [],
        rules: Array.isArray(data.rules) ? data.rules.slice(0, 1500) : [],
        tokens: Array.isArray(data.tokens) ? data.tokens.slice(0, 3000) : [],
        cachedAt: new Date().toISOString(),
      })
    );
    return true;
  } catch {
    return false;
  }
}

async function callChartRpc(config, rpcName, payload = {}, options = {}) {
  const normalized = normalizeSupabaseConfig(config || DEFAULT_CLOUD_CONFIG);
  if (!normalized) {
    throw new Error('Configuração do banco Supabase inválida ou ausente.');
  }
  const doFetch = options.fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('Fetch indisponível neste ambiente.');
  }

  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let response;
  try {
    response = await doFetch(`${normalized.url}/rest/v1/rpc/${rpcName}`, {
      method: 'POST',
      headers: {
        apikey: normalized.anonKey,
        Authorization: `Bearer ${normalized.anonKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller?.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('O banco de dados demorou para responder. Tente novamente.');
    }
    throw new Error('Não foi possível conectar ao banco de dados Supabase.');
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!response.ok) {
    let detail = '';
    try {
      const errBody = await response.json();
      detail = errBody?.message || errBody?.hint || errBody?.details || '';
    } catch {
      /* ignora corpo inválido */
    }
    const err = new Error(detail || `Erro HTTP ${response.status} ao chamar ${rpcName}.`);
    err.status = response.status;
    throw err;
  }

  return response.json();
}

export async function loadChartFromDb(config, options = {}) {
  const data = await callChartRpc(
    config,
    'conversor_chart_load',
    { p_plan_id: options.planId || null },
    options
  );
  return {
    plans: Array.isArray(data?.plans) ? data.plans : [],
    plan: data?.plan || null,
    accounts: Array.isArray(data?.accounts) ? data.accounts : [],
    rules: Array.isArray(data?.rules) ? data.rules : [],
    tokens: Array.isArray(data?.tokens) ? data.tokens : [],
  };
}

export async function syncChartPlanToDb(config, { plan, accounts, ...options }) {
  return callChartRpc(
    config,
    'conversor_chart_sync_plan',
    {
      p_plan: plan || {},
      p_accounts: Array.isArray(accounts) ? accounts : [],
    },
    options
  );
}

export async function saveChartLearningToDb(config, { planId, rules, tokens, ...options }) {
  if (!planId) return { ok: false, rules_saved: 0, tokens_saved: 0 };
  return callChartRpc(
    config,
    'conversor_chart_learn_batch',
    {
      p_plan_id: planId,
      p_rules: Array.isArray(rules) ? rules : [],
      p_tokens: Array.isArray(tokens) ? tokens : [],
    },
    options
  );
}

/**
 * Une regras e tokens aprendidos no banco com eventuais aprendizados locais
 * ainda não enviados, sem duplicar entradas.
 */
export function mergeChartLearning(remote = {}, local = {}) {
  const ruleMap = new Map();
  for (const sourceList of [remote.rules || [], local.rules || []]) {
    for (const r of sourceList) {
      if (!r?.history_key || !r?.conta) continue;
      const key = `${r.history_key}|${r.direction || 'any'}|${r.side === 'credit' ? 'credit' : 'debit'}`;
      const prev = ruleMap.get(key);
      if (!prev || Date.parse(r.updated_at || '') >= Date.parse(prev.updated_at || '')) {
        ruleMap.set(key, r);
      }
    }
  }

  const tokenMap = new Map();
  for (const sourceList of [remote.tokens || [], local.tokens || []]) {
    for (const t of sourceList) {
      if (!t?.token || !t?.conta) continue;
      const key = `${t.token}|${t.conta}|${t.direction || 'any'}`;
      const prev = tokenMap.get(key);
      if (!prev || (Number(t.hits) || 0) >= (Number(prev.hits) || 0)) {
        tokenMap.set(key, t);
      }
    }
  }

  return {
    rules: [...ruleMap.values()],
    tokens: [...tokenMap.values()],
  };
}
