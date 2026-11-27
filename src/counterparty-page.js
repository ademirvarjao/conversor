/**
 * Conversor — Página do conciliador de clientes/fornecedores
 *
 * Controlador da página `conciliador.html`: carrega o cadastro do Questor e o
 * extrato, concilia, permite corrigir vínculo e exportar em .xlsx/.pdf/.csv.
 *
 * A memória da IA é a mesma da página principal (mesmo `localStorage`), então o
 * que é aprendido aqui aparece lá e no pacote cifrado da nuvem. Nada de arquivo
 * ou lançamento sai do navegador.
 */

import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';
import { STORAGE_KEY as AI_MEMORY_KEY, loadAiMemory, saveAiMemory } from './ai-engine.js';
import { formatDateTime } from './admin-usage.js';
import { createAdminConsole } from './admin-console.js';
import { mountGearMenu } from './gear-menu.js';
import { escapeHtml } from './html.js';
import { installGlobalErrorReporting, reportStartupFailure } from './ui-errors.js';
import {
  DIRECTION,
  NATUREZA,
  NATUREZA_LABELS,
  buildContactsFromLines,
  buildContactsFromTable,
  candidatesFor,
  contactCode,
  contactSummary,
  accountMemorySummary,
  learnFromReconciliation,
  learnManualLink,
  learnRowAccount,
  applyRowAccount,
  isManualAccountCell,
  setRowCellAccount,
  linkHistory,
  mergeContacts,
  mergeTransactions,
  reconcileCounterparties,
  sanitizeCounterparties,
  scoreCandidates,
  documentDigits,
  findDocumentInHistory,
  formatDocument,
  historyContainsDocument,
  historyHasDocument,
  summarizeReconciliation,
  transactionsFromTable,
} from './counterparty.js';
import {
  exportCounterpartiesCsv,
  exportCounterpartiesPdf,
  exportCounterpartiesXlsx,
} from './exporters.js';
import {
  diffChartAccounts,
  parseQuestorChartPdf,
  parseQuestorChartTable,
  reconcileWithChart,
  recordChartLearning,
  scoreChartCandidates,
  searchChartAccounts,
} from './chart-of-accounts.js';
import {
  loadChartCache,
  loadChartFromDb,
  mergeChartLearning,
  saveChartCache,
  saveChartLearningToDb,
  syncChartPlanToDb,
} from './chart-sync.js';
import { formatValueGroupedBr, formatValuePlainBr } from './format.js';
import { extractPdfLines, normalizeText, parsePdfFile, parseXlsxFile } from './parsers.js';
import { formatAccessCode } from './sync-crypto.js';
import { consumeAuthRedirect, loadSession } from './cloud-auth.js';
import {
  loadCloudConfig,
  loadIdentity,
  mergeVaultPayload,
  pullVault,
  pushVault,
  touchIdentitySync,
} from './sync-vault.js';
import { APP_VERSION } from './ui-contract.js';

const DEFAULT_PAGE_SIZE = 50;
/** Opções de linhas por página (`'all'` mostra a conciliação inteira). */
const PAGE_SIZE_OPTIONS = [50, 100, 300, 1000, 'all'];
const SEARCH_DEBOUNCE_MS = 180;

if (pdfjsLib?.GlobalWorkerOptions) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/pdf.worker.min.mjs';
}

const state = {
  memory: loadAiMemory(),
  contacts: [],
  contactFile: '',
  transactions: [],
  ledgerFile: '',
  rows: [],
  stats: summarizeReconciliation([]),
  filter: 'all',
  search: '',
  page: 1,
  linkingId: null,
  linkSearch: '',
  chartLinkSearch: '',
  learnedCount: 0,
  selected: new Set(),
  pageSize: DEFAULT_PAGE_SIZE,
  busy: false,
  chartPlans: [],
  chartPlan: null,
  chartAccounts: [],
  chartRules: [],
  chartTokens: [],
  chartDbConnected: false,
};

const cloud = {
  config: loadCloudConfig(),
  identity: loadIdentity(),
  busy: false,
};

const dom = {};

const REQUIRED_IDS = [
  'cp-contacts-input',
  'cp-contacts-status',
  'cp-ledger-input',
  'cp-ledger-status',
  'cp-chart-card',
  'cp-chart-plan-select',
  'cp-chart-input',
  'btn-cp-chart-update',
  'cp-chart-status',
  'cp-use-chart-ai',
  'btn-cp-run',
  'btn-cp-rerun',
  'cp-include-unmatched',
  'cp-alert',
  'cp-result',
  'cp-kpi-count',
  'cp-kpi-matched',
  'cp-kpi-debit',
  'cp-kpi-suppliers',
  'cp-kpi-credit',
  'cp-kpi-customers',
  'cp-kpi-value',
  'cp-kpi-review',
  'cp-search',
  'cp-debit-account-input',
  'cp-credit-account-input',
  'btn-cp-account-apply',
  'cp-selected-count',
  'cp-account-hint',
  'btn-cp-apply-suggestions',
  'cp-link-memory',
  'cp-select-all',
  'cp-page-size',
  'btn-cp-clear-selection',
  'cp-link-account-input',
  'btn-cp-link-account',
  'cp-link-account-hint',
  'cp-tbody',
  'cp-pagination-info',
  'cp-btn-prev',
  'cp-btn-next',
  'cp-link-panel',
  'btn-cp-link-close',
  'cp-link-history',
  'cp-link-chart-box',
  'cp-link-chart-search',
  'cp-link-chart-candidates',
  'cp-link-contacts-box',
  'cp-link-search',
  'cp-link-candidates',
  'cp-chart-autocomplete',
  'cp-learned',
  'btn-cp-export-xlsx',
  'btn-cp-export-pdf',
  'btn-cp-export-csv',
  'cp-cloud-state',
  'btn-gear',
  'toast-container',
  'app-version',
];

/* -------------------------------------------------------------------------- */
/*                              Utilitários de UI                             */
/* -------------------------------------------------------------------------- */

function cacheDom() {
  for (const id of REQUIRED_IDS) {
    const element = document.getElementById(id);
    if (!element) console.warn(`[Conciliador] Elemento #${id} não encontrado no HTML.`);
    dom[id] = element;
  }
}

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
}

function showToast(message, type = 'success', { duration = 4500 } = {}) {
  const container = dom['toast-container'];
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');

  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = message;
  toast.appendChild(text);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Fechar notificação');
  close.textContent = '✕';
  close.addEventListener('click', () => toast.remove());
  toast.appendChild(close);

  container.appendChild(toast);

  while (container.children.length > 4) container.removeChild(container.firstElementChild);

  if (duration > 0) {
    setTimeout(() => toast.remove(), duration);
  }
}

function setProcessing(active, message = '') {
  const banner = document.getElementById('processing-banner');
  if (banner) banner.classList.toggle('hidden', !active);
  const text = document.getElementById('processing-text');
  if (text && message) text.textContent = message;
  document.querySelector('main')?.setAttribute('aria-busy', String(active));
}

function cpAlert(message, tone = 'info') {
  const box = dom['cp-alert'];
  if (!box) return;
  if (!message) {
    box.classList.add('hidden');
    box.textContent = '';
    return;
  }
  box.classList.remove('hidden');
  box.className = `ai-alert ${tone === 'error' ? 'is-error' : tone === 'warn' ? 'is-warn' : ''}`.trim();
  box.innerHTML = message;
}

/* -------------------------------------------------------------------------- */
/*            Painel do administrador (universal, pela engrenagem)            */
/* -------------------------------------------------------------------------- */

/**
 * O painel (uso, tempo, memória, logs) e o menu da engrenagem são **os mesmos**
 * do resto do site — vêm de `admin-console.js` e `gear-menu.js`. Aqui só ligamos
 * os dois à memória e à nuvem desta página.
 */
let gear = null;

const adminConsole = createAdminConsole({
  page: 'conciliador',
  getMemory: () => state.memory,
  getCloud: () => ({
    accessCode: cloud.identity ? formatAccessCode(cloud.identity.code) : '',
    lastSync: cloud.identity?.lastSyncAt ? formatDateTime(cloud.identity.lastSyncAt) : '—',
    host: cloud.config?.url ? cloud.config.url.replace(/^https?:\/\//i, '') : '',
    account: sessionEmail(),
    remote: cloud.identity ? 'sincronizado' : 'não verificado',
  }),
  notify: (message, kind) => showToast(message, kind || 'success'),
  // Entrou ou bloqueou: o menu (e o ícone da engrenagem) mudam na hora.
  onAccessChange: () => gear?.refresh(),
});

/** E-mail da conta na nuvem (ou "sem conta"), sem estourar se não houver sessão. */
function sessionEmail() {
  try {
    return loadSession()?.email || 'sem conta';
  } catch {
    return 'sem conta';
  }
}

/** Atalhos usados no meio do fluxo de conciliação. */
function track(type, message, details = '', counter = null, amount = 1) {
  adminConsole.track(type, message, details, counter, amount);
}

/** Só soma contador (edições em série não viram um evento cada). */
function trackCount(counter, amount = 1) {
  adminConsole.count(counter, amount);
}

/** Abre o painel na aba pedida (o console cuida da senha). */
function openAdminPanel(tab) {
  adminConsole.open(tab);
}

/** Menu da engrenagem: as opções desta página. */
function gearContext() {
  return {
    unlocked: adminConsole.isUnlocked(),
    hasMemoryModal: false,
    profiles: Array.isArray(state.memory.learnedProfiles) ? state.memory.learnedProfiles.length : 0,
    version: APP_VERSION,
  };
}

function handleGearAction(id) {
  if (id === 'admin') adminConsole.open('overview');
  else if (id === 'admin-usage') adminConsole.open('usage');
  else if (id === 'memory') adminConsole.open('memory');
  else if (id === 'lock') adminConsole.lock();
  else if (id === 'docs') window.open('./manual.html', '_blank', 'noopener');
  else if (id === 'about') window.open('./manual.html#sobre', '_blank', 'noopener');
}

/**
 * Guarda a conta digitada à mão na memória da IA (histórico + contato) e
 * persiste. Com `persist: false`, quem chamou assume o salvamento no fim.
 */
function rememberAccount(row, side, account, { persist = true } = {}) {
  if (!row || !account) return;

  state.memory.counterparties = learnRowAccount(state.memory, {
    history: row.rawHistory || row.history,
    contact: row.contact,
    side,
    account,
  });

  if (persist) {
    persistMemory();
    scheduleCloudPush();
  }
}

let storageWarned = false;

/**
 * Salva a memória avisando **uma vez** quando o navegador bloqueia (modo
 * privado, cota cheia). Antes a falha era silenciosa: o usuário achava que o
 * treino tinha sido guardado.
 */
function persistMemory() {
  if (saveAiMemory(state.memory)) return true;
  if (!storageWarned) {
    storageWarned = true;
    showToast(
      'O navegador bloqueou o salvamento da memória (modo privado ou armazenamento cheio). As contas aprendidas valem só nesta sessão.',
      'warn',
      { duration: 9000 }
    );
  }
  return false;
}

function counterpartyMemory() {
  if (!state.memory.counterparties) {
    state.memory.counterparties = sanitizeCounterparties(null);
  }
  return state.memory.counterparties;
}

/* -------------------------------------------------------------------------- */
/*                            Nuvem (modelos da IA)                           */
/* -------------------------------------------------------------------------- */

function renderCloudState(message, tone = 'idle') {
  const element = dom['cp-cloud-state'];
  if (element) {
    element.textContent = message;
    element.dataset.tone = tone;
  }
}

async function pushModels({ silent = false } = {}) {
  if (!cloud.config || !cloud.identity) {
    if (!silent) showToast('Crie sua chave na página inicial para guardar os modelos na nuvem.', 'warn');
    return;
  }
  if (cloud.busy) return;

  cloud.busy = true;
  renderCloudState('Enviando modelos…', 'busy');
  try {
    const result = await pushVault({
      config: cloud.config,
      identity: cloud.identity,
      memory: state.memory,
      appVersion: APP_VERSION,
    });
    cloud.identity = touchIdentitySync({ ...cloud.identity }, result.updatedAt);
    renderCloudState(`Modelos enviados • ${new Date().toLocaleTimeString('pt-BR')}`, 'ok');
    // O envio automático é frequente: soma no contador e só vira log quando o
    // usuário pediu (ou quando é o primeiro envio depois de aprender algo).
    if (silent) trackCount('cloudPush');
    else track('nuvem', 'Modelos enviados para a nuvem', '', 'cloudPush');
    if (!silent) showToast('Modelos aprendidos enviados para a nuvem.');
  } catch (error) {
    renderCloudState('Falha ao enviar', 'error');
    if (!silent) showToast(`Falha ao enviar: ${error.message}`, 'error');
  } finally {
    cloud.busy = false;
  }
}

/**
 * Traz os modelos da nuvem — sempre em segundo plano, junto com o envio: não há
 * botão de sincronizar. O pacote é **somado** ao que já existe aqui (merge), e
 * não substituído, para não apagar treino feito sem conexão.
 */
async function pullModels({ silent = true } = {}) {
  if (!cloud.config || !cloud.identity) {
    if (!silent) showToast('Crie sua chave na página inicial para usar os modelos da nuvem.', 'warn');
    return;
  }
  if (cloud.busy) return;

  cloud.busy = true;
  renderCloudState('Sincronizando com a nuvem…', 'busy');
  try {
    const remote = await pullVault({ config: cloud.config, identity: cloud.identity });
    if (!remote) {
      renderCloudState('Nenhum modelo na nuvem para esta chave', 'warn');
      if (!silent) showToast('A nuvem ainda não tem modelos desta chave.', 'warn');
      return;
    }

    const before = state.memory;
    state.memory = mergeVaultPayload(state.memory, remote.payload);
    persistMemory();
    cloud.identity = touchIdentitySync({ ...cloud.identity }, remote.updatedAt);

    const novos = Math.max(0, (state.memory.counterparties?.uses || 0) - (before.counterparties?.uses || 0));
    const changed = JSON.stringify(before) !== JSON.stringify(state.memory);
    renderCloudState('Modelos em dia com a nuvem', 'ok');
    trackCount('cloudPull');
    if (changed) track('nuvem', 'Modelos recebidos da nuvem', novos > 0 ? `${novos} uso(s) novo(s)` : 'memória atualizada');
    if (changed) {
      showToast(
        novos > 0
          ? `Modelos sincronizados: ${novos} conta(s) memorizada(s) chegaram da nuvem.`
          : 'Modelos sincronizados com a nuvem.'
      );
      render();
      // O que só existe aqui (aprendido sem rede) sobe agora.
      scheduleCloudPush();
    }
  } catch (error) {
    renderCloudState('Falha ao sincronizar', 'error');
    if (!silent) showToast(`Falha ao sincronizar: ${error.message}`, 'error');
  } finally {
    cloud.busy = false;
    setTimeout(() => renderCloudState(describeIdentity(), 'idle'), 4000);
  }
}

function describeIdentity() {
  if (!cloud.identity) return 'Modelos: só neste navegador';
  const code = formatAccessCode(cloud.identity.code || '');
  return `Modelos: chave ${code || '—'}`;
}

let cloudPushTimer = null;

/**
 * Envia os modelos em segundo plano. O timer é único: várias edições seguidas
 * (lote, sugestões, vínculos) geram **um** envio, e não um por linha.
 */
function scheduleCloudPush() {
  if (!cloud.config || !cloud.identity) return;
  enqueueCloudPush(1200);
}

function enqueueCloudPush(delay) {
  if (!cloud.config || !cloud.identity) return;
  if (cloudPushTimer) clearTimeout(cloudPushTimer);
  cloudPushTimer = setTimeout(() => {
    cloudPushTimer = null;
    // Se um download/envio ainda estiver em andamento, não descarta o envio.
    if (cloud.busy) {
      enqueueCloudPush(2500);
      return;
    }
    void pushModels({ silent: true });
  }, delay);
}

let cloudPullTimer = null;

/** Baixa os modelos em segundo plano (abertura, chave nova e aba em foco). */
function scheduleCloudPull(delay = 900) {
  if (!cloud.config || !cloud.identity) return;
  if (cloudPullTimer) clearTimeout(cloudPullTimer);
  cloudPullTimer = setTimeout(() => {
    cloudPullTimer = null;
    if (cloud.busy) {
      scheduleCloudPull(4000);
      return;
    }
    void pullModels({ silent: true });
  }, delay);
}

/* -------------------------------------------------------------------------- */
/*                                  Arquivos                                  */
/* -------------------------------------------------------------------------- */

function fileExtension(name) {
  return String(name).split('.').pop()?.toLowerCase() ?? '';
}

function updateRunButton() {
  const button = dom['btn-cp-run'];
  if (!button) return;
  const hasSource = state.contacts.length > 0 || state.chartAccounts.length > 0;
  button.disabled = state.busy || !hasSource || state.transactions.length === 0;
}

/* -------------------------------------------------------------------------- */
/*                     Plano de Contas Questor (Banco + I.A.)                 */
/* -------------------------------------------------------------------------- */

function activeChartAccountsCount() {
  return state.chartAccounts.filter((a) => !a.is_synthetic && !a.is_counterparty).length;
}

function findChartAccountByCode(conta) {
  const clean = String(conta ?? '').trim();
  if (!clean) return null;
  return state.chartAccounts.find((a) => a.conta === clean) || null;
}

function renderChartStatus() {
  const statusEl = dom['cp-chart-status'];
  const cardEl = dom['cp-chart-card'];
  const selectEl = dom['cp-chart-plan-select'];

  if (selectEl) {
    if (state.chartPlans.length > 1) {
      selectEl.innerHTML = state.chartPlans
        .map((p) => {
          const label = `${p.company_code ? `${p.company_code} ` : ''}${p.company_name}${p.cnpj ? ` (${p.cnpj})` : ''}`;
          return `<option value="${escapeHtml(p.id)}" ${p.id === state.chartPlan?.id ? 'selected' : ''}>${escapeHtml(label)}</option>`;
        })
        .join('');
      selectEl.classList.remove('hidden');
    } else {
      selectEl.classList.add('hidden');
      selectEl.innerHTML = '';
    }
  }

  if (!statusEl) return;

  if (!state.chartPlan || state.chartAccounts.length === 0) {
    statusEl.textContent = 'Nenhum plano salvo no banco — clique em "Atualizar banco de dados" para subir o PDF do Questor';
    cardEl?.classList.remove('is-loaded');
    return;
  }

  const analytic = activeChartAccountsCount();
  const excluded = state.chartAccounts.filter((a) => !a.is_synthetic && a.is_counterparty).length;
  const rulesCount = state.chartRules.length;
  const label = `${state.chartPlan.company_code ? `${state.chartPlan.company_code} ` : ''}${state.chartPlan.company_name}`;
  statusEl.textContent =
    `${label} (v${state.chartPlan.version || 1}) • ${analytic} contas analíticas` +
    (excluded ? ` • ${excluded} Clientes/Fornecedores excluídas` : '') +
    ` • ${rulesCount} regra(s) I.A.${state.chartDbConnected ? ' • banco conectado' : ' • cache local'}`;
  cardEl?.classList.add('is-loaded');
}

function persistChartCacheLocal() {
  saveChartCache({
    plans: state.chartPlans,
    plan: state.chartPlan,
    accounts: state.chartAccounts,
    rules: state.chartRules,
    tokens: state.chartTokens,
  });
}

async function initChartFromDatabase(planId = null) {
  const cached = loadChartCache();
  if (cached && cached.accounts.length > 0 && (!planId || cached.plan?.id === planId)) {
    state.chartPlans = cached.plans;
    state.chartPlan = cached.plan;
    state.chartAccounts = cached.accounts;
    state.chartRules = cached.rules;
    state.chartTokens = cached.tokens;
    renderChartStatus();
    updateRunButton();
  }

  if (!cloud.config) {
    renderChartStatus();
    return;
  }

  try {
    const remote = await loadChartFromDb(cloud.config, { planId });
    state.chartDbConnected = true;
    const samePlan = !planId || remote.plan?.id === cached?.plan?.id;
    const mergedLearning = samePlan
      ? mergeChartLearning(remote, cached || {})
      : { rules: remote.rules, tokens: remote.tokens };

    state.chartPlans = remote.plans;
    state.chartPlan = remote.plan;
    state.chartAccounts = remote.accounts;
    state.chartRules = mergedLearning.rules;
    state.chartTokens = mergedLearning.tokens;
    persistChartCacheLocal();
  } catch (error) {
    console.warn('[Conciliador] Falha ao carregar Plano de Contas do banco:', error);
    state.chartDbConnected = false;
  }

  renderChartStatus();
  updateRunButton();
}

async function readChartFile(file, onProgress) {
  const extension = fileExtension(file.name);
  const buffer = await file.arrayBuffer();

  if (extension === 'pdf') {
    return parseQuestorChartPdf(new Uint8Array(buffer), file.name, pdfjsLib, { onProgress });
  }

  const ExcelJSRef = typeof window !== 'undefined' ? window.ExcelJS : undefined;
  if (!ExcelJSRef) throw new Error('Biblioteca ExcelJS não carregada.');
  const parsed = await parseXlsxFile(buffer, file.name, ExcelJSRef);
  return parseQuestorChartTable(parsed.headers, parsed.rows, { sourceFile: file.name });
}

async function uploadAndSyncChart(file) {
  if (!file) return;
  const statusEl = dom['cp-chart-status'];
  if (statusEl) statusEl.textContent = `Lendo ${file.name}…`;
  setProcessing(true, `Lendo Plano de Contas (${file.name}) e atualizando banco de dados…`);

  try {
    const parsed = await readChartFile(file, (page, total) => {
      if (statusEl) statusEl.textContent = `${file.name} — página ${page} de ${total}…`;
    });

    const localDiff =
      state.chartPlan?.id === parsed.plan.id
        ? diffChartAccounts(state.chartAccounts, parsed.accounts)
        : {
            inserted: parsed.accounts.length,
            updated: 0,
            unchanged: 0,
            deactivated: 0,
          };

    let syncSummary = {
      ...localDiff,
      version: state.chartPlan?.id === parsed.plan.id ? (state.chartPlan.version || 1) + 1 : 1,
      analytic_accounts: parsed.plan.analytic_accounts,
      excluded_counterparties: parsed.plan.excluded_counterparties,
    };

    const noChanges =
      state.chartPlan?.id === parsed.plan.id &&
      localDiff.inserted === 0 &&
      localDiff.updated === 0 &&
      localDiff.deactivated === 0;

    if (noChanges && state.chartDbConnected) {
      renderChartStatus();
      updateRunButton();
      const unchangedMsg =
        `Nenhuma alteração encontrada em ${state.chartPlan.company_name} (v${state.chartPlan.version || 1}) — ` +
        `${parsed.plan.analytic_accounts} conta(s) analítica(s) já estão atualizadas no banco.`;
      cpAlert(`<strong>Plano de Contas já atualizado.</strong> ${escapeHtml(unchangedMsg)}`, 'info');
      showToast(unchangedMsg);
      return;
    }

    if (cloud.config) {
      if (statusEl) statusEl.textContent = 'Gravando atualizações no banco de dados…';
      syncSummary = await syncChartPlanToDb(cloud.config, {
        plan: parsed.plan,
        accounts: parsed.accounts,
      });
      state.chartDbConnected = true;

      const reloaded = await loadChartFromDb(cloud.config, { planId: parsed.plan.id });
      state.chartPlans = reloaded.plans;
      state.chartPlan = reloaded.plan || { ...parsed.plan, version: syncSummary.version };
      state.chartAccounts = reloaded.accounts.length > 0 ? reloaded.accounts : parsed.accounts;
      state.chartRules = reloaded.rules;
      state.chartTokens = reloaded.tokens;
    } else {
      state.chartPlan = { ...parsed.plan, version: syncSummary.version };
      state.chartAccounts = parsed.accounts;
      if (!state.chartPlans.some((p) => p.id === state.chartPlan.id)) {
        state.chartPlans = [state.chartPlan, ...state.chartPlans];
      }
    }

    persistChartCacheLocal();
    renderChartStatus();
    updateRunButton();

    const msg =
      `Banco de dados atualizado (${state.chartPlan.company_name}, v${syncSummary.version}): ` +
      `+${syncSummary.inserted} nova(s), ${syncSummary.updated} alterada(s), ` +
      `${syncSummary.deactivated} desativada(s) • ${syncSummary.analytic_accounts} conta(s) analítica(s) ativa(s) ` +
      `(${syncSummary.excluded_counterparties} de Clientes/Fornecedores excluídas).`;
    cpAlert(`<strong>Plano de Contas atualizado no banco.</strong> ${escapeHtml(msg)}`, 'info');
    showToast(msg);
    track('plano_contas', 'Plano de Contas atualizado no banco', `v${syncSummary.version} • +${syncSummary.inserted} / ~${syncSummary.updated}`, 'chartUpdates');
  } catch (error) {
    console.error(error);
    cpAlert(`<strong>Não foi possível atualizar o Plano de Contas.</strong> ${escapeHtml(error.message)}`, 'error');
    showToast(`Falha ao atualizar Plano de Contas: ${error.message}`, 'error');
    renderChartStatus();
  } finally {
    setProcessing(false);
  }
}

const pendingChartLearning = {
  rules: new Map(),
  tokens: new Map(),
  timer: null,
};

function flushChartLearning() {
  if (pendingChartLearning.timer) {
    clearTimeout(pendingChartLearning.timer);
    pendingChartLearning.timer = null;
  }
  const rules = [...pendingChartLearning.rules.values()];
  const tokens = [...pendingChartLearning.tokens.values()];
  pendingChartLearning.rules.clear();
  pendingChartLearning.tokens.clear();

  if ((rules.length === 0 && tokens.length === 0) || !state.chartPlan?.id || !cloud.config) return;
  saveChartLearningToDb(cloud.config, {
    planId: state.chartPlan.id,
    rules,
    tokens,
  })
    .then(() => {
      renderChartStatus();
    })
    .catch((err) => {
      console.warn('[Conciliador] Falha ao gravar aprendizado no banco:', err);
    });
}

function scheduleChartLearningSync(delay = 350) {
  if (pendingChartLearning.timer) clearTimeout(pendingChartLearning.timer);
  pendingChartLearning.timer = setTimeout(() => {
    flushChartLearning();
  }, delay);
}

/**
 * Grava aprendizado da I.A. (cache local + fila para o banco Supabase) sempre
 * que uma conta é preenchida manualmente, aceita de uma sugestão ou escolhida
 * no Plano de Contas.
 */
function rememberChartAssignment(row, side, conta, accountName = '', source = 'manual') {
  if (!row || !conta) return;
  const cleanConta = String(conta).trim();
  if (!cleanConta) return;

  const resolvedName = accountName || findChartAccountByCode(cleanConta)?.name || '';
  const learningStore = {
    rules: state.chartRules,
    tokens: state.chartTokens,
  };
  const learned = recordChartLearning(learningStore, {
    history: row.rawHistory || row.history,
    direction: row.direction,
    side,
    conta: cleanConta,
    accountName: resolvedName,
    source,
  });
  if (!learned) return;

  persistChartCacheLocal();
  renderChartStatus();

  const r = learned.rule;
  pendingChartLearning.rules.set(`${r.history_key}|${r.direction}|${r.side}`, r);
  for (const t of learned.tokens) {
    const tKey = `${t.token}|${t.conta}|${t.direction}`;
    const prev = pendingChartLearning.tokens.get(tKey);
    pendingChartLearning.tokens.set(tKey, {
      ...t,
      weight: (prev?.weight || 0) + t.weight,
      hits: (prev?.hits || 0) + t.hits,
    });
  }
  scheduleChartLearningSync();
}

function reinforceExportedChartMatches(rows) {
  for (const row of rows || []) {
    if (row.chartMatch && row.chartMatch.source === 'ai') {
      rememberChartAssignment(
        row,
        row.chartMatch.side,
        row.chartMatch.conta,
        row.chartMatch.name,
        'ai_accepted'
      );
    }
  }
  flushChartLearning();
}

/** Lê um arquivo de cadastro e devolve os contatos crus. */
async function readContactFile(file, onProgress) {
  const extension = fileExtension(file.name);
  const buffer = await file.arrayBuffer();

  if (extension === 'pdf') {
    const { lines } = await extractPdfLines(new Uint8Array(buffer), pdfjsLib, { onProgress });
    return buildContactsFromLines(lines);
  }

  const ExcelJSRef = typeof window !== 'undefined' ? window.ExcelJS : undefined;
  if (!ExcelJSRef) throw new Error('Biblioteca ExcelJS não carregada.');
  const parsed = await parseXlsxFile(buffer, file.name, ExcelJSRef);
  return buildContactsFromTable(parsed.headers, parsed.rows);
}

/** Carrega um ou mais cadastros e junta tudo num só (mesmo `contactb` não duplica). */
async function loadContacts(fileList) {
  const files = [...(fileList || [])];
  if (files.length === 0) return;

  const statusEl = dom['cp-contacts-status'];
  const lists = [];
  const failures = [];
  let rejected = 0;
  let read = 0;

  cpAlert('');
  for (const [index, file] of files.entries()) {
    if (statusEl) statusEl.textContent = `Lendo ${file.name} (${index + 1}/${files.length})…`;
    try {
      const parsed = await readContactFile(file, (page, total) => {
        if (statusEl) {
          statusEl.textContent = `${file.name} — página ${page} de ${total} (${index + 1}/${files.length})`;
        }
      });
      lists.push(parsed.contacts);
      rejected += parsed.rejected || 0;
      read += 1;
    } catch (error) {
      console.error(error);
      failures.push(`${file.name}: ${error.message}`);
    }
  }

  const contacts = mergeContacts(lists);
  if (contacts.length === 0) {
    throw new Error(
      failures.length > 0
        ? `Nenhum contato reconhecido. ${failures[0]}`
        : 'Nenhum contato reconhecido. Confira se os arquivos têm as colunas contactb, nomepessoa e natureza.'
    );
  }

  state.contacts = contacts;
  state.contactFile = files.map((file) => file.name).join(', ');
  state.rows = [];
  state.stats = summarizeReconciliation([]);
  state.page = 1;
  dom['cp-result']?.classList.add('hidden');

  const summary = contactSummary(contacts);
  // Quantos contatos trazem CPF/CNPJ: é o que permite casar um PIX/TED que só
  // mostra o documento, sem o nome do favorecido.
  const withDocument = contacts.filter((contact) => documentDigits(contact.document)).length;
  if (statusEl) {
    statusEl.textContent =
      `${read} arquivo(s) • ${contacts.length} contatos • ${summary.suppliers} credora • ` +
      `${summary.customers} devedora${withDocument ? ` • ${withDocument} com CPF/CNPJ` : ''}`;
  }
  dom['cp-contacts-status']?.closest('.cp-file')?.classList.add('is-loaded');

  const failureNote =
    failures.length > 0
      ? ` <strong>${failures.length} arquivo(s) não lido(s):</strong> ${failures.map(escapeHtml).join(' • ')}`
      : '';
  cpAlert(
    `Cadastro lido: <strong>${contacts.length}</strong> contatos de ${read} arquivo(s) (${summary.suppliers} fornecedores credora, ${
      summary.customers
    } clientes devedora)` +
      (withDocument
        ? ` • <strong>${withDocument}</strong> com CPF/CNPJ`
        : ' • nenhum CPF/CNPJ no cadastro: o vínculo será só por nome') +
      (rejected ? ` • ${rejected} linha(s) ignorada(s) (sem código de contato ou sem natureza)` : '') +
      `.${failureNote}`,
    failures.length > 0 ? 'warn' : 'info'
  );
  updateRunButton();
  track(
    'arquivo',
    `Cadastro carregado: ${contacts.length} contato(s)`,
    `${read} arquivo(s) • ${summary.suppliers} fornecedores • ${summary.customers} clientes`,
    'contactsFiles'
  );
}

/** Lê um arquivo de extrato e devolve os lançamentos com sinal. */
async function readLedgerFile(file, onProgress) {
  const extension = fileExtension(file.name);
  const buffer = await file.arrayBuffer();

  if (extension === 'pdf') {
    // `onProgress` cobre a leitura normal; no PDF escaneado o OCR avisa por
    // `onOcrProgress` (o mesmo contador de páginas, com o rótulo certo).
    const parsed = await parsePdfFile(buffer, file.name, pdfjsLib, {
      onProgress,
      onOcrProgress: onProgress,
    });
    return transactionsFromTable(parsed.headers, parsed.rows, { sourceFile: file.name });
  }

  const ExcelJSRef = typeof window !== 'undefined' ? window.ExcelJS : undefined;
  if (!ExcelJSRef) throw new Error('Biblioteca ExcelJS não carregada.');
  const parsed = await parseXlsxFile(buffer, file.name, ExcelJSRef);
  return transactionsFromTable(parsed.headers, parsed.rows, { sourceFile: file.name });
}

/** Carrega um ou mais extratos, juntando os lançamentos sem duplicar arquivos repetidos. */
async function loadLedger(fileList) {
  const files = [...(fileList || [])];
  if (files.length === 0) return;

  const statusEl = dom['cp-ledger-status'];
  const lists = [];
  const failures = [];
  let read = 0;

  cpAlert('');
  for (const [index, file] of files.entries()) {
    if (statusEl) statusEl.textContent = `Lendo ${file.name} (${index + 1}/${files.length})…`;
    try {
      const transactions = await readLedgerFile(file, (page, total) => {
        if (statusEl) {
          statusEl.textContent = `${file.name} — página ${page} de ${total} (${index + 1}/${files.length})`;
        }
      });
      lists.push(transactions);
      read += 1;
    } catch (error) {
      console.error(error);
      failures.push(`${file.name}: ${error.message}`);
    }
  }

  const transactions = mergeTransactions(lists);
  if (transactions.length === 0) {
    throw new Error(
      failures.length > 0
        ? `Nenhum lançamento reconhecido. ${failures[0]}`
        : 'Nenhum lançamento com data e valor foi reconhecido nos arquivos enviados.'
    );
  }

  const payments = transactions.filter((item) => item.direction === DIRECTION.PAYMENT).length;
  const receipts = transactions.length - payments;

  state.transactions = transactions;
  state.ledgerFile = files.map((file) => file.name).join(', ');
  state.rows = [];
  state.stats = summarizeReconciliation([]);
  state.page = 1;
  dom['cp-result']?.classList.add('hidden');

  // O CPF/CNPJ pode vir numa coluna própria do extrato (Itaú ICS) ou dentro do
  // histórico; os dois casos contam.
  const withDocument = transactions.filter(
    (item) => documentDigits(item.document) || historyHasDocument(item.history)
  ).length;
  if (statusEl) {
    statusEl.textContent =
      `${read} arquivo(s) • ${transactions.length} lançamentos • ${payments} pagamentos • ` +
      `${receipts} recebimentos${withDocument ? ` • ${withDocument} com CPF/CNPJ` : ''}`;
  }
  dom['cp-ledger-status']?.closest('.cp-file')?.classList.add('is-loaded');

  const failureNote =
    failures.length > 0
      ? ` <strong>${failures.length} arquivo(s) não lido(s):</strong> ${failures.map(escapeHtml).join(' • ')}`
      : '';
  cpAlert(
    `Extrato lido: <strong>${transactions.length}</strong> lançamentos de ${read} arquivo(s) (${payments} pagamentos, ${receipts} recebimentos)` +
      (withDocument ? ` • <strong>${withDocument}</strong> com CPF/CNPJ no histórico` : '') +
      `. Clique em <em>Conciliar agora</em>.${failureNote}`,
    failures.length > 0 ? 'warn' : 'info'
  );
  updateRunButton();
  track(
    'arquivo',
    `Extrato carregado: ${transactions.length} lançamento(s)`,
    `${read} arquivo(s) • ${payments} pagamentos • ${receipts} recebimentos`,
    'ledgerFiles'
  );
}

/* -------------------------------------------------------------------------- */
/*                                 Conciliação                                */
/* -------------------------------------------------------------------------- */

async function runReconciliation() {
  if (state.busy) return;
  const hasContacts = state.contacts.length > 0;
  const hasChart = state.chartAccounts.length > 0;
  if ((!hasContacts && !hasChart) || state.transactions.length === 0) {
    showToast('Carregue a conciliação bancária e um cadastro ou Plano de Contas antes de conciliar.', 'warn');
    return;
  }

  state.busy = true;
  updateRunButton();
  setProcessing(true, 'Conciliando lançamentos com I.A.…');

  try {
    const { rows } = reconcileCounterparties(state.transactions, state.contacts, {
      memory: state.memory,
    });
    rows.forEach((row, index) => {
      row.id = index;
    });

    const useChartAi = dom['cp-use-chart-ai']?.checked !== false;
    let chartStats = { matchedCount: 0, memoryCount: 0, suggestedCount: 0 };
    if (useChartAi && hasChart) {
      chartStats = reconcileWithChart(rows, state.chartAccounts, {
        rules: state.chartRules,
        tokens: state.chartTokens,
      });
    }

    const stats = summarizeReconciliation(rows);
    state.rows = rows;
    state.stats = stats;
    state.page = 1;
    state.filter = 'all';
    state.search = '';
    state.linkSearch = '';
    state.chartLinkSearch = '';
    state.linkingId = null;
    state.selected = new Set();
    if (dom['cp-search']) dom['cp-search'].value = '';
    if (dom['cp-link-search']) dom['cp-link-search'].value = '';
    if (dom['cp-link-chart-search']) dom['cp-link-chart-search'].value = '';
    dom['cp-link-panel']?.classList.add('hidden');
    hideChartAutocomplete();

    // A IA aprende a cada uso: os vínculos aceitos viram apelidos persistentes.
    // A estatística conta só o que é **novo** — refazer a conciliação não pode
    // somar de novo os mesmos vínculos.
    const before = Object.keys(sanitizeCounterparties(state.memory.counterparties).aliases).length;
    const learned = learnFromReconciliation(state.memory, rows);
    const after = Object.keys(learned.counterparties.aliases).length;
    state.memory.counterparties = learned.counterparties;
    state.learnedCount = learned.learnedCount + chartStats.memoryCount;
    state.memory.stats.correctionsLearned =
      (state.memory.stats.correctionsLearned || 0) + Math.max(0, after - before);
    persistMemory();
    scheduleCloudPush();

    render();

    track(
      'conciliacao',
      `Conciliação: ${stats.matched} de ${stats.total} vinculados`,
      `${stats.byDocument || 0} por CPF/CNPJ • ${chartStats.matchedCount} pelo Plano de Contas • ${stats.ambiguous} para revisar`,
      'reconciliations'
    );
    // Soma os números da rodada (linhas, não eventos).
    trackCount('rowsReconciled', stats.matched);
    trackCount('rowsReview', stats.ambiguous);
    trackCount('rowsUnmatched', stats.unmatched);

    const suggested = rows.filter((row) => row.accountSuggestion || row.chartSuggestion).length;
    const fromMemory = rows.filter((row) => row.counterpartSource === 'memory').length + chartStats.memoryCount;
    cpAlert('');
    showToast(
      `Conciliação concluída: ${stats.matched} de ${stats.total} lançamentos vinculados (${stats.ambiguous} para revisar).` +
        (stats.byDocument ? ` ${stats.byDocument} pelo CPF/CNPJ do histórico.` : '') +
        (chartStats.matchedCount ? ` ${chartStats.matchedCount} pelo Plano de Contas (I.A.).` : '') +
        (fromMemory ? ` ${fromMemory} conta(s) da memória.` : '') +
        (suggested ? ` ${suggested} conta(s) sugerida(s).` : '')
    );
  } catch (error) {
    console.error(error);
    cpAlert(`<strong>Não foi possível conciliar.</strong> ${escapeHtml(error.message)}`, 'error');
    showToast(`Falha na conciliação: ${error.message}`, 'error');
  } finally {
    state.busy = false;
    updateRunButton();
    setProcessing(false);
  }
}

function visibleRows() {
  const term = normalizeText(state.search);
  const includeUnmatched = dom['cp-include-unmatched']?.checked !== false;

  return state.rows.filter((row) => {
    if (!includeUnmatched && !row.contact && !row.chartMatch) return false;
    if (state.filter === 'matched' && !['matched', 'manual', 'learned'].includes(row.status)) return false;
    if (state.filter === 'chart' && !row.chartMatch && !row.chartSuggestion) return false;
    if (state.filter === 'review' && row.status !== 'ambiguous') return false;
    if (state.filter === 'unmatched' && (row.contact || row.chartMatch)) return false;
    if (state.filter === 'document' && row.matchReason !== 'document') return false;
    if (!term) return true;
    // A busca vale para tudo o que está na linha: histórico, contato, código,
    // CPF/CNPJ, data, contas de débito/crédito e conta do Plano de Contas.
    const haystack = [
      row.history,
      row.contact?.name,
      row.contact?.code,
      row.contact?.document,
      row.chartMatch?.name,
      row.chartMatch?.conta,
      row.chartMatch?.classification,
      row.date,
      row.debitAccount,
      row.creditAccount,
    ]
      .filter(Boolean)
      .join(' ');
    return normalizeText(haystack).includes(term);
  });
}

/**
 * Selo do vínculo, com a explicação no `title`.
 *
 * Saber **por que** a linha casou (nome, memória, Plano de Contas ou CPF/CNPJ)
 * é o que permite revisar rápido.
 */
function statusBadge(row) {
  const score = row.score ? `${Math.round(row.score * 100)}% de semelhança` : 'sem semelhança';
  if (row.chartMatch) {
    const pct = row.chartMatch.score ? `${Math.round(row.chartMatch.score * 100)}%` : '';
    if (row.chartMatch.source === 'memory') {
      return `<span class="cp-badge" title="Conta do Plano de Contas aplicada pela memória da I.A. (${escapeHtml(row.chartMatch.reason || '')})">memória I.A.</span>`;
    }
    if (row.chartMatch.source === 'manual' || row.chartMatch.source === 'accepted') {
      return '<span class="cp-badge" title="Conta do Plano de Contas escolhida manualmente (I.A. aprendeu)">manual</span>';
    }
    return `<span class="cp-badge" title="Conciliado automaticamente pela I.A. (${escapeHtml(row.chartMatch.reason || '')} — ${pct})">I.A. ${pct}</span>`;
  }
  if (row.status === 'manual') return '<span class="cp-badge" title="Vínculo escolhido à mão">manual</span>';
  if (row.learnedAlias) {
    return '<span class="cp-badge" title="Histórico já vinculado numa conciliação anterior">memória</span>';
  }
  if (row.status === 'matched') {
    const why = row.matchReason === 'document' ? 'CPF/CNPJ igual ao do cadastro' : `nome — ${score}`;
    return `<span class="cp-badge" title="Vínculo automático por ${escapeHtml(why)}">conciliado</span>`;
  }
  if (row.status === 'ambiguous') {
    const hint = row.chartSuggestion
      ? `Sugestão I.A. (${Math.round(row.chartSuggestion.score * 100)}%): ${row.chartSuggestion.conta} • ${row.chartSuggestion.name}`
      : `Há mais de um contato parecido (${score})`;
    return `<span class="cp-badge is-review" title="${escapeHtml(hint)} — confira antes de exportar">revisar</span>`;
  }
  return '<span class="cp-badge is-none" title="Nenhum contato ou conta do Plano bateu com este histórico">sem conta</span>';
}

/** Célula de débito/crédito: vazia ou preenchida pelo Plano de Contas vira campo editável com busca. */
function accountCell(row, side) {
  const filled = side === 'credit' ? row.creditAccount : row.debitAccount;
  const editable =
    !filled ||
    isManualAccountCell(row, side) ||
    (!row.contact && row.chartMatch?.side === side);
  const label = side === 'credit' ? 'crédito' : 'débito';

  if (!editable) return `<td class="col-account">${escapeHtml(filled)}</td>`;

  const matchedAccount = filled ? findChartAccountByCode(filled) : null;
  const title = matchedAccount
    ? `Conta ${filled} — ${matchedAccount.name} (${matchedAccount.classification}). Digite código ou nome para trocar.`
    : `Digite o código (Conta) ou busque pelo nome no Plano de Contas`;

  return `
            <td class="col-account col-account-editable">
              <input
                class="cp-cell-account"
                type="text"
                inputmode="text"
                autocomplete="off"
                spellcheck="false"
                maxlength="48"
                placeholder="—"
                value="${escapeHtml(filled || '')}"
                data-cp-cell="${side}"
                data-cp-row="${row.id}"
                aria-label="Conta do ${label} deste lançamento (digite o código ou busque no Plano de Contas)"
                title="${escapeHtml(title)}"
              />
            </td>`;
}

/** Quantas linhas cabem na página (a conciliação inteira quando `'all'`). */
function rowsPerPage() {
  return state.pageSize === 'all' ? Infinity : Number(state.pageSize) || DEFAULT_PAGE_SIZE;
}

/** Chip clicável com a conta que a memória ou a I.A. do Plano de Contas sugere para a linha. */
function suggestionChip(row) {
  const parts = [];
  const suggestion = row?.accountSuggestion;
  if (suggestion) {
    const label = suggestion.side === 'credit' ? 'crédito' : 'débito';
    parts.push(`<button
      class="cp-suggest"
      type="button"
      data-cp-suggest="${row.id}"
      title="Conta ${suggestion.account} memorizada pelo ${suggestion.source} — clique para preencher o ${label}"
    >sugestão: ${suggestion.account} no ${label}</button>`);
  }

  const chartSug = row?.chartSuggestion;
  if (chartSug) {
    const label = chartSug.side === 'credit' ? 'crédito' : 'débito';
    const pct = Math.round((chartSug.score || 0) * 100);
    parts.push(`<button
      class="cp-suggest"
      type="button"
      data-cp-chart-suggest="${row.id}"
      title="Sugestão I.A. (${pct}%): ${escapeHtml(chartSug.name)} (${escapeHtml(chartSug.classification)}) — clique para preencher ${escapeHtml(chartSug.conta)} no ${label}"
    >sugestão I.A.: ${escapeHtml(chartSug.conta)} (${escapeHtml(chartSug.name)})</button>`);
  }

  return parts.join('');
}

function renderRows() {
  const tbody = dom['cp-tbody'];
  if (!tbody) return;

  const rows = visibleRows();
  const perPage = rowsPerPage();
  const totalPages = Math.max(1, Math.ceil(rows.length / perPage));
  state.page = Math.min(Math.max(1, state.page), totalPages);
  const start = Number.isFinite(perPage) ? (state.page - 1) * perPage : 0;
  const pageRows = Number.isFinite(perPage) ? rows.slice(start, start + perPage) : rows.slice();

  if (pageRows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-cell">Nenhum lançamento para este filtro.</td></tr>';
  } else {
    tbody.innerHTML = pageRows
      .map(
        (row) => `
        <tr data-cp-row="${row.id}">
          <td class="col-select">
            <input
              type="checkbox"
              data-cp-select="${row.id}"
              aria-label="Selecionar o lançamento de ${escapeHtml(row.date || '')}"
              ${state.selected.has(row.id) ? 'checked' : ''}
            />
          </td>
          <td class="col-date">${escapeHtml(row.date || '')}</td>
          ${accountCell(row, 'debit')}
          ${accountCell(row, 'credit')}
          <td class="col-money"><strong>${escapeHtml(formatValuePlainBr(row.valueCents / 100))}</strong></td>
          <td class="col-hist">
            <span class="cp-history">${escapeHtml(row.history)}</span><br />
            ${statusBadge(row)}
            ${
              row.matchReason === 'document'
                ? '<span class="cp-badge is-doc" title="Vínculo pelo CPF/CNPJ que veio no histórico do lançamento">CPF/CNPJ</span>'
                : ''
            }
            ${
              row.chartMatch
                ? `<span class="cp-badge is-chart" title="${escapeHtml(row.chartMatch.classification || '')}">${escapeHtml(row.chartMatch.conta)} • ${escapeHtml(row.chartMatch.name)}</span>`
                : ''
            }
            ${row.counterpartSource === 'memory' ? '<span class="cp-badge is-memory" title="Conta preenchida pela memória da IA">conta da memória</span>' : ''}
            ${row.contact ? `<span class="cp-contact">${escapeHtml(row.contact.name)}</span>` : ''}
            ${suggestionChip(row)}
          </td>
          <td class="col-cp-link">
            <button class="cp-link-btn" type="button" data-cp-link="${row.id}" title="Escolher conta do Plano de Contas ou vincular contato">
              ${row.contact || row.chartMatch ? 'Trocar' : 'Vincular'}
            </button>
          </td>
        </tr>`
      )
      .join('');
  }

  if (dom['cp-pagination-info']) {
    dom['cp-pagination-info'].textContent = rows.length
      ? `Exibindo ${start + 1}–${Math.min(start + pageRows.length, rows.length)} de ${rows.length}`
      : 'Exibindo 0 de 0';
  }
  if (dom['cp-btn-prev']) dom['cp-btn-prev'].disabled = state.page <= 1;
  if (dom['cp-btn-next']) dom['cp-btn-next'].disabled = state.page >= totalPages;

  renderSelection(rows);
  renderSuggestionButton();
}

/** Habilita o botão "Aplicar sugeridas" conforme as sugestões do filtro. */
function renderSuggestionButton() {
  const button = dom['btn-cp-apply-suggestions'];
  if (!button) return;

  const pending = visibleRows().filter((row) => row.accountSuggestion || row.chartSuggestion).length;
  button.disabled = pending === 0;
  button.textContent = pending > 0 ? `Aplicar ${pending} sugerida(s)` : 'Aplicar sugeridas';
}

/**
 * Mantém o contador, o "selecionar tudo" e o "limpar seleção" coerentes.
 *
 * O "selecionar tudo" vale para **todos** os lançamentos do filtro atual, não
 * só para os da página — não é preciso ir página por página marcando.
 */
function renderSelection(rows = visibleRows()) {
  if (dom['cp-selected-count']) dom['cp-selected-count'].textContent = String(state.selected.size);

  const selectAll = dom['cp-select-all'];
  if (selectAll) {
    const ids = rows.map((row) => row.id);
    const selectedHere = ids.filter((id) => state.selected.has(id)).length;
    selectAll.checked = ids.length > 0 && selectedHere === ids.length;
    selectAll.indeterminate = selectedHere > 0 && selectedHere < ids.length;
    selectAll.disabled = ids.length === 0;
    selectAll.title = ids.length
      ? `Selecionar todos os ${ids.length} lançamentos do filtro atual`
      : 'Nenhum lançamento para selecionar';
    selectAll.setAttribute(
      'aria-label',
      ids.length ? `Selecionar todos os ${ids.length} lançamentos do filtro atual` : 'Selecionar todos os lançamentos'
    );
  }

  const clear = dom['btn-cp-clear-selection'];
  if (clear) {
    clear.disabled = state.selected.size === 0;
    clear.textContent = state.selected.size ? `Limpar seleção (${state.selected.size})` : 'Limpar seleção';
  }
}

function render() {
  const hasResult = state.rows.length > 0;
  dom['cp-result']?.classList.toggle('hidden', !hasResult);
  updateRunButton();
  if (!hasResult) return;

  const stats = state.stats;
  const set = (id, value) => {
    if (dom[id]) dom[id].textContent = value;
  };

  set('cp-kpi-count', String(stats.total));
  set(
    'cp-kpi-matched',
    `${stats.matched} conciliados • ${stats.ambiguous} para revisar` +
      (stats.byDocument ? ` • ${stats.byDocument} por CPF/CNPJ` : '')
  );
  // Totais dos cartões no mesmo formato do conversor: com separador de milhar
  // (3.023.524,00). A tabela continua sem milhar, como a planilha do conversor.
  set('cp-kpi-debit', formatValueGroupedBr(stats.debitCents / 100));
  set('cp-kpi-suppliers', `${stats.suppliers} fornecedores`);
  set('cp-kpi-credit', formatValueGroupedBr(stats.creditCents / 100));
  set('cp-kpi-customers', `${stats.customers} clientes`);
  set('cp-kpi-value', formatValueGroupedBr(stats.valueCents / 100));
  set('cp-kpi-review', `${stats.unmatched} sem contato`);

  if (dom['cp-learned']) {
    dom['cp-learned'].textContent = state.learnedCount
      ? `A IA memorizou ${state.learnedCount} vínculo(s). Na próxima conciliação esses históricos serão reconhecidos automaticamente.`
      : 'Nenhum vínculo novo para memorizar nesta rodada.';
  }

  document.querySelectorAll('.pill[data-cp-filter]').forEach((button) => {
    const active = button.dataset.cpFilter === state.filter;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });

  renderRows();
}

/* -------------------------------------------------------------------------- */
/*                                  Exportação                                */
/* -------------------------------------------------------------------------- */

/**
 * Mesma regra do conversor: **exporta o que estiver marcado; sem seleção,
 * exporta tudo** (independente do filtro na tela).
 */
function exportRows() {
  if (state.selected.size > 0) {
    const selected = state.rows.filter((row) => state.selected.has(row.id));
    if (selected.length > 0) return selected;
  }
  return state.rows;
}

function exportName(extension) {
  const stamp = new Date().toISOString().slice(0, 10);
  return `Conciliacao_Clientes_Fornecedores_${stamp}.${extension}`;
}

function guardExport() {
  if (state.rows.length === 0) {
    showToast('Concilie os arquivos antes de exportar.', 'warn');
    return false;
  }
  if (exportRows().length === 0) {
    showToast('Nenhum lançamento para exportar.', 'warn');
    return false;
  }
  return true;
}

async function exportXlsx() {
  if (!guardExport()) return;
  try {
    const rows = exportRows();
    reinforceExportedChartMatches(rows);
    await exportCounterpartiesXlsx(rows, exportName('xlsx'), window.ExcelJS);
    track('exportacao', `Planilha .xlsx gerada`, `${rows.length} lançamento(s)`, 'exports');
    showToast(
      `Planilha .xlsx gerada com ${rows.length} lançamento(s)${
        state.selected.size > 0 ? ' selecionado(s)' : ' (todos)'
      } — layout data | débito | crédito | valor | histórico.`
    );
  } catch (error) {
    showToast(`Falha ao gerar .xlsx: ${error.message}`, 'error');
  }
}

function exportPdf() {
  if (!guardExport()) return;
  try {
    const rows = exportRows();
    reinforceExportedChartMatches(rows);
    exportCounterpartiesPdf(rows, summarizeReconciliation(rows), exportName('pdf'));
    track('exportacao', 'PDF gerado', `${rows.length} lançamento(s)`, 'exports');
    showToast(
      `PDF gerado com ${rows.length} lançamento(s)${
        state.selected.size > 0 ? ' selecionado(s)' : ' (todos)'
      } — layout data | débito | crédito | valor | histórico.`
    );
  } catch (error) {
    showToast(`Falha ao gerar .pdf: ${error.message}`, 'error');
  }
}

function exportCsv() {
  if (!guardExport()) return;
  try {
    const rows = exportRows();
    reinforceExportedChartMatches(rows);
    exportCounterpartiesCsv(rows, exportName('csv'));
    track('exportacao', 'CSV gerado', `${rows.length} lançamento(s)`, 'exports');
    showToast(
      `CSV gerado com ${rows.length} lançamento(s)${
        state.selected.size > 0 ? ' selecionado(s)' : ' (todos)'
      } (separador ";" e vírgula decimal) para abrir no Excel.`
    );
  } catch (error) {
    showToast(`Falha ao gerar .csv: ${error.message}`, 'error');
  }
}

/* -------------------------------------------------------------------------- */
/*                        Conta de contrapartida manual                       */
/* -------------------------------------------------------------------------- */

function selectedScope() {
  const checked = document.querySelector('input[name="cp-account-scope"]:checked');
  return checked?.value || 'selected';
}

function accountTargets(scope) {
  if (scope === 'filtered') return visibleRows();
  if (scope === 'empty') {
    return visibleRows().filter((row) => !row.counterpartAccount);
  }
  return state.rows.filter((row) => state.selected.has(row.id));
}

function describeScope(scope, count) {
  if (scope === 'filtered') return `nos ${count} filtrados`;
  if (scope === 'empty') return `nos ${count} sem contrapartida`;
  return `nos ${count} selecionados`;
}

/** Conta digitada num dos campos do lote (débito ou crédito), já sem pontuação. */
function batchAccount(side) {
  return contactCode(dom[side === 'credit' ? 'cp-credit-account-input' : 'cp-debit-account-input']?.value ?? '');
}

/** Aplica a conta sugerida pela memória em um único lançamento. */
function applySuggestion(rowId) {
  const row = state.rows.find((item) => item.id === Number(rowId));
  const suggestion = row?.accountSuggestion;
  if (!row || !suggestion) return;

  setRowCellAccount(row, suggestion.side, suggestion.account);
  delete row.accountSuggestion;
  rememberAccount(row, suggestion.side, suggestion.account);
  if (state.chartAccounts.length > 0) {
    rememberChartAssignment(row, suggestion.side, suggestion.account, '', 'ai_accepted');
  }

  state.stats = summarizeReconciliation(state.rows);
  render();
  track('conta', 'Sugestão aceita', `conta ${suggestion.account} no ${suggestion.side === 'credit' ? 'crédito' : 'débito'}`, 'suggestionsApplied');

  showToast(
    `Conta ${suggestion.account} aplicada no ${suggestion.side === 'credit' ? 'crédito' : 'débito'} — memória reforçada.`
  );
}

/** Aplica a conta sugerida pela I.A. do Plano de Contas em um único lançamento. */
function applyChartSuggestion(rowId) {
  const row = state.rows.find((item) => item.id === Number(rowId));
  const suggestion = row?.chartSuggestion;
  if (!row || !suggestion) return;

  assignChartAccountToRow(row, suggestion.side, suggestion.conta, suggestion.name, 'ai_accepted');
  state.stats = summarizeReconciliation(state.rows);
  render();
  track('conta', 'Sugestão Plano de Contas aceita', `conta ${suggestion.conta} (${suggestion.name})`, 'suggestionsApplied');
  showToast(
    `Conta ${suggestion.conta} (${suggestion.name}) aplicada no ${suggestion.side === 'credit' ? 'crédito' : 'débito'} — I.A. memorizou no banco.`
  );
}

/** Aplica de uma vez todas as contas sugeridas no filtro atual. */
function applySuggestionsBatch() {
  const targets = visibleRows().filter((row) => row.accountSuggestion || row.chartSuggestion);
  if (targets.length === 0) {
    showToast('Nenhuma conta sugerida neste filtro.', 'warn');
    return;
  }

  for (const row of targets) {
    if (row.accountSuggestion) {
      const suggestion = row.accountSuggestion;
      setRowCellAccount(row, suggestion.side, suggestion.account);
      delete row.accountSuggestion;
      rememberAccount(row, suggestion.side, suggestion.account, { persist: false });
    }
    if (row.chartSuggestion) {
      const chartSug = row.chartSuggestion;
      assignChartAccountToRow(row, chartSug.side, chartSug.conta, chartSug.name, 'ai_accepted');
    }
  }

  persistMemory();
  scheduleCloudPush();
  flushChartLearning();

  state.stats = summarizeReconciliation(state.rows);
  render();
  track('conta', 'Sugestões aplicadas em lote', `${targets.length} conta(s)`, 'suggestionsApplied', targets.length);
  showToast(`${targets.length} conta(s) sugerida(s) aplicada(s) — a memória foi reforçada no banco.`);
}

/**
 * Aplica as contas do lote, conforme o escopo escolhido.
 *
 * São dois campos independentes: um preenche as **colunas de débito** vazias e
 * o outro as de **crédito** vazias. Um campo em branco não mexe na coluna do
 * outro; com os dois em branco, a ação limpa o que foi digitado à mão.
 */
function applyAccountBatch() {
  if (state.rows.length === 0) {
    showToast('Concilie os arquivos antes de informar as contas.', 'warn');
    return;
  }

  const debit = batchAccount('debit');
  const credit = batchAccount('credit');
  const clearing = !debit && !credit;

  const scope = selectedScope();
  const targets = accountTargets(scope);
  if (targets.length === 0) {
    showToast(
      scope === 'selected'
        ? 'Marque pelo menos um lançamento na tabela (ou escolha outro escopo).'
        : 'Nenhum lançamento se encaixa nesse escopo.',
      'warn'
    );
    return;
  }

  const parts = [];
  for (const [side, account] of [
    ['debit', debit],
    ['credit', credit],
  ]) {
    if (!account && !clearing) continue;

    let changed = 0;
    for (const row of targets) {
      const before = side === 'credit' ? row.creditAccount : row.debitAccount;
      setRowCellAccount(row, side, account);
      const after = side === 'credit' ? row.creditAccount : row.debitAccount;
      if (before !== after) {
        changed += 1;
        // Cada conta aplicada vira treino: histórico + contato + Plano de Contas.
        rememberAccount(row, side, account, { persist: false });
        if (account && state.chartAccounts.length > 0) {
          rememberChartAssignment(row, side, account, '', 'batch');
        }
      }
    }

    const label = side === 'credit' ? 'crédito' : 'débito';
    if (changed > 0) parts.push(account ? `${label} ${account} em ${changed}` : `limpeza no ${label} em ${changed}`);
  }

  persistMemory();
  scheduleCloudPush();

  state.stats = summarizeReconciliation(state.rows);
  render();

  if (parts.length === 0) {
    const message = clearing
      ? 'Nada para limpar: as células desse escopo vieram do cadastro do contato.'
      : 'Nenhuma célula vazia nesse escopo — as contas já estão preenchidas.';
    if (dom['cp-account-hint']) dom['cp-account-hint'].textContent = message;
    showToast(message, 'warn');
    return;
  }

  const summary = parts.join(' • ');
  if (dom['cp-account-hint']) {
    dom['cp-account-hint'].textContent = clearing
      ? `Contas digitadas à mão removidas — ${summary}.`
      : `Aplicado ${describeScope(scope, targets.length)} — ${summary}.`;
  }
  track(
    'conta',
    clearing ? 'Contas digitadas à mão removidas' : 'Contas aplicadas em lote',
    summary,
    clearing ? 'accountsCleared' : 'accountsApplied'
  );
  showToast(clearing ? `Contas digitadas à mão removidas — ${summary}.` : `Contas aplicadas — ${summary}.`);
}

/**
 * Atribui uma conta do Plano de Contas (ou digitada à mão) em uma célula da lista
 * e grava o aprendizado na I.A. (local + banco de dados).
 */
function assignChartAccountToRow(row, side, conta, accountName = '', source = 'manual') {
  if (!row) return;
  const cleanConta = String(conta ?? '').trim();
  const key = side === 'credit' ? 'creditAccount' : 'debitAccount';
  const matched = cleanConta ? findChartAccountByCode(cleanConta) : null;
  const resolvedName = accountName || matched?.name || '';

  if (!cleanConta) {
    if (row.chartMatch?.side === side) {
      delete row.chartMatch;
      if (!row.contact) row.status = 'unmatched';
    }
    setRowCellAccount(row, side, '');
    return;
  }

  // Permite substituir células vazias, manuais ou preenchidas anteriormente pelo Plano de Contas.
  row[key] = cleanConta;
  row.manualCells = { ...(row.manualCells || {}), [side]: true };
  delete row.accountSuggestion;
  delete row.chartSuggestion;

  const primarySide = row.direction === DIRECTION.RECEIPT ? 'credit' : 'debit';
  if (!row.contact && (side === primarySide || !row.chartMatch)) {
    row.chartMatch = {
      conta: cleanConta,
      name: resolvedName || `Conta ${cleanConta}`,
      classification: matched?.classification || '',
      side,
      score: 1,
      source: source === 'ai_accepted' ? 'accepted' : 'manual',
      reason: source === 'ai_accepted' ? 'sugestão aceita' : 'preenchido à mão',
    };
    row.status = 'manual';
  }

  rememberAccount(row, side, cleanConta, { persist: false });
  rememberChartAssignment(row, side, cleanConta, resolvedName, source);
  persistMemory();
  scheduleCloudPush();
}

/* -------------------------------------------------------------------------- */
/*                  Autocomplete do Plano de Contas na célula                 */
/* -------------------------------------------------------------------------- */

const cellAutocomplete = {
  input: null,
  rowId: null,
  side: null,
  items: [],
  activeIndex: -1,
};

function hideChartAutocomplete() {
  const menu = dom['cp-chart-autocomplete'];
  if (menu) {
    menu.classList.add('hidden');
    menu.innerHTML = '';
  }
  cellAutocomplete.input = null;
  cellAutocomplete.rowId = null;
  cellAutocomplete.side = null;
  cellAutocomplete.items = [];
  cellAutocomplete.activeIndex = -1;
}

function showChartAutocomplete(input) {
  const menu = dom['cp-chart-autocomplete'];
  if (!menu || state.chartAccounts.length === 0) {
    hideChartAutocomplete();
    return;
  }

  const rowId = Number(input.dataset.cpRow);
  const side = input.dataset.cpCell === 'credit' ? 'credit' : 'debit';
  const row = state.rows.find((item) => item.id === rowId);
  if (!row) return;

  const query = String(input.value ?? '').trim();
  let accounts;
  if (!query) {
    accounts = scoreChartCandidates(row.rawHistory || row.history, row.direction, state.chartAccounts, {
      side,
      rules: state.chartRules,
      tokens: state.chartTokens,
      limit: 6,
    }).map((entry) => entry.account);
    if (accounts.length === 0) {
      accounts = searchChartAccounts(state.chartAccounts, '', { limit: 6 });
    }
  } else {
    accounts = searchChartAccounts(state.chartAccounts, query, { limit: 8 });
  }

  if (accounts.length === 0) {
    hideChartAutocomplete();
    return;
  }

  cellAutocomplete.input = input;
  cellAutocomplete.rowId = rowId;
  cellAutocomplete.side = side;
  cellAutocomplete.items = accounts;
  cellAutocomplete.activeIndex = -1;

  const rect = input.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 340))}px`;
  const spaceBelow = window.innerHeight - rect.bottom;
  if (spaceBelow >= 220 || spaceBelow >= rect.top) {
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.bottom = 'auto';
  } else {
    menu.style.top = 'auto';
    menu.style.bottom = `${window.innerHeight - rect.top + 4}px`;
  }

  menu.innerHTML = accounts
    .map(
      (acc, index) => `
      <button
        type="button"
        class="cp-chart-ac-item"
        role="option"
        data-cp-ac-index="${index}"
      >
        <span class="cp-chart-ac-top">
          <span class="cp-chart-ac-code">${escapeHtml(acc.conta)}</span>
          <span>${escapeHtml(acc.name)}</span>
        </span>
        <span class="cp-chart-ac-meta">${escapeHtml(acc.classification)}${acc.alias ? ` • ${escapeHtml(acc.alias)}` : ''}</span>
      </button>`
    )
    .join('');

  menu.classList.remove('hidden');
}

function pickAutocompleteAccount(index) {
  const acc = cellAutocomplete.items[index];
  const row = state.rows.find((item) => item.id === cellAutocomplete.rowId);
  const side = cellAutocomplete.side;
  const input = cellAutocomplete.input;
  if (!acc || !row || !side) {
    hideChartAutocomplete();
    return;
  }

  if (input) input.dataset.cpPicked = '1';
  hideChartAutocomplete();

  assignChartAccountToRow(row, side, acc.conta, acc.name, 'manual');
  trackCount('accountEdits');
  state.stats = summarizeReconciliation(state.rows);
  render();

  const label = side === 'credit' ? 'crédito' : 'débito';
  showToast(`Conta ${acc.conta} (${acc.name}) aplicada no ${label} — I.A. memorizou no banco.`);
}

/**
 * Preenche a conta de uma célula (débito/crédito) direto na tabela.
 *
 * A célula só aceita valor quando está vazia (ou quando o próprio usuário
 * digitou ali ou veio do Plano de Contas), então a conta vinda do cadastro
 * do contato nunca é trocada por engano.
 */
function applyCellAccount(input) {
  if (input.dataset.cpPicked) {
    delete input.dataset.cpPicked;
    return;
  }

  const row = state.rows.find((item) => item.id === Number(input.dataset.cpRow));
  if (!row) return;

  const side = input.dataset.cpCell === 'credit' ? 'credit' : 'debit';
  const label = side === 'credit' ? 'crédito' : 'débito';
  const rawValue = String(input.value ?? '').trim();
  let account = contactCode(rawValue);
  const current = side === 'credit' ? row.creditAccount : row.debitAccount;

  if (input.dataset.cpCancelled) {
    delete input.dataset.cpCancelled;
    input.value = current || '';
    return;
  }

  // Se o usuário digitou texto (nome da conta) e não escolheu no menu, tenta casar 1 único resultado exato.
  if (rawValue && /[a-zA-ZÀ-ÿ]/.test(rawValue) && state.chartAccounts.length > 0) {
    const found = searchChartAccounts(state.chartAccounts, rawValue, { limit: 1 });
    if (found.length > 0) {
      account = found[0].conta;
    } else {
      input.value = current || '';
      showToast(`Nenhuma conta encontrada para "${rawValue}".`, 'warn');
      return;
    }
  }

  // Célula vazia e nada digitado: não há o que fazer.
  if (!account) {
    input.value = current || '';
    if (!current) return;
  }

  // Conta vinda do cadastro do contato não é substituída por aqui.
  const canEdit = !current || isManualAccountCell(row, side) || (!row.contact && row.chartMatch?.side === side);
  if (!canEdit) {
    input.value = current;
    showToast(`A conta do ${label} veio do cadastro do contato e não é substituída por aqui.`, 'warn');
    return;
  }

  if (account === current) return;

  const matchedAcc = account ? findChartAccountByCode(account) : null;
  assignChartAccountToRow(row, side, account, matchedAcc?.name || '', 'manual');
  trackCount('accountEdits');
  state.stats = summarizeReconciliation(state.rows);
  render();

  if (!account) {
    showToast(`Conta do ${label} limpa neste lançamento.`);
    return;
  }

  showToast(
    matchedAcc
      ? `Conta ${account} (${matchedAcc.name}) preenchida no ${label} — I.A. memorizou no banco.`
      : row.counterpartAccount === account
        ? `Conta ${account} preenchida no ${label} — contrapartida deste lançamento.`
        : `Conta ${account} preenchida no ${label} deste lançamento.`
  );
}

/** Aplica a conta de contrapartida em um único lançamento (painel de vínculo). */
function applyAccountToLinkingRow() {
  const row = currentLinkingRow();
  if (!row) return;

  const raw = dom['cp-link-account-input']?.value ?? '';
  const account = contactCode(raw);

  applyRowAccount(row, account);
  if (account) {
    const side = row.direction === DIRECTION.PAYMENT ? 'credit' : 'debit';
    rememberAccount(row, side, account);
    if (state.chartAccounts.length > 0) {
      rememberChartAssignment(row, side, account, '', 'manual');
    }
  }
  state.stats = summarizeReconciliation(state.rows);
  state.linkingId = null;
  dom['cp-link-panel']?.classList.add('hidden');
  render();

  showToast(
    account
      ? `Contrapartida ${account} aplicada — ${
          row.direction === DIRECTION.PAYMENT ? 'no crédito' : 'no débito'
        } deste lançamento.`
      : 'Contrapartida removida deste lançamento.'
  );
}

/* -------------------------------------------------------------------------- */
/*                             Correção de vínculo                            */
/* -------------------------------------------------------------------------- */

function currentLinkingRow() {
  return state.rows.find((row) => row.id === state.linkingId) || null;
}

function renderChartCandidates() {
  const box = dom['cp-link-chart-box'];
  const list = dom['cp-link-chart-candidates'];
  const row = currentLinkingRow();
  if (!list || !row) return;

  if (state.chartAccounts.length === 0) {
    box?.classList.add('hidden');
    return;
  }
  box?.classList.remove('hidden');

  const term = String(state.chartLinkSearch || '').trim();
  const primarySide = row.direction === DIRECTION.RECEIPT ? 'credit' : 'debit';
  let entries;

  if (term) {
    entries = searchChartAccounts(state.chartAccounts, term, { limit: 12 }).map((account) => ({
      account,
      score: 0,
      reason: '',
    }));
  } else {
    entries = scoreChartCandidates(row.rawHistory || row.history, row.direction, state.chartAccounts, {
      side: primarySide,
      rules: state.chartRules,
      tokens: state.chartTokens,
      limit: 10,
    });
    if (entries.length === 0) {
      entries = searchChartAccounts(state.chartAccounts, '', { limit: 10 }).map((account) => ({
        account,
        score: 0,
        reason: '',
      }));
    }
  }

  if (entries.length === 0) {
    list.innerHTML =
      '<li class="cp-candidate"><span class="cp-candidate-info"><span class="cp-candidate-name">Nenhuma conta encontrada no Plano de Contas</span><span class="cp-candidate-meta">Tente buscar pelo nome, código (Conta), apelido ou classificação.</span></span></li>';
    return;
  }

  list.innerHTML = entries
    .map(({ account, score, reason }) => {
      const pct = score ? ` • ${Math.round(score * 100)}%` : '';
      const why = reason ? ` • ${reason}` : '';
      return `
      <li class="cp-candidate">
        <span class="cp-candidate-info">
          <span class="cp-candidate-name">${escapeHtml(account.conta)} — ${escapeHtml(account.name)}</span>
          <span class="cp-candidate-meta">
            ${escapeHtml(account.classification)}${account.alias ? ` • ${escapeHtml(account.alias)}` : ''}${escapeHtml(pct)}${escapeHtml(why)}
          </span>
        </span>
        <span class="cp-candidate-actions">
          <button
            class="btn btn-sm ${primarySide === 'debit' ? 'btn-primary' : 'btn-ghost-dark'}"
            type="button"
            data-cp-chart-pick="${escapeHtml(account.conta)}"
            data-cp-chart-side="debit"
          >Débito</button>
          <button
            class="btn btn-sm ${primarySide === 'credit' ? 'btn-primary' : 'btn-ghost-dark'}"
            type="button"
            data-cp-chart-pick="${escapeHtml(account.conta)}"
            data-cp-chart-side="credit"
          >Crédito</button>
        </span>
      </li>`;
    })
    .join('');
}

function applyChartAccountFromPanel(conta, side) {
  const row = currentLinkingRow();
  const acc = findChartAccountByCode(conta);
  if (!row || !acc) return;

  assignChartAccountToRow(row, side, acc.conta, acc.name, 'manual');
  state.stats = summarizeReconciliation(state.rows);
  state.linkingId = null;
  dom['cp-link-panel']?.classList.add('hidden');
  render();
  track('plano_contas', 'Conta escolhida no painel', `${acc.conta} (${acc.name})`, 'manualLinks');
  showToast(
    `Conta ${acc.conta} (${acc.name}) aplicada no ${side === 'credit' ? 'crédito' : 'débito'} — I.A. memorizou no banco.`
  );
}

function renderCandidates() {
  const box = dom['cp-link-contacts-box'];
  const list = dom['cp-link-candidates'];
  const row = currentLinkingRow();
  if (!list || !row) return;

  if (state.contacts.length === 0) {
    box?.classList.add('hidden');
    return;
  }
  box?.classList.remove('hidden');

  const pool = candidatesFor(state.contacts, row.direction);
  const term = normalizeText(state.linkSearch);
  const filtered = term
    ? pool.filter((contact) =>
        normalizeText(`${contact.name} ${contact.code} ${contact.document || ''}`).includes(term)
      )
    : pool;

  const scored = scoreCandidates(row.rawHistory, filtered, {
    memory: state.memory,
    natureza: row.direction === DIRECTION.PAYMENT ? NATUREZA.CREDORA : NATUREZA.DEVEDORA,
    limit: 12,
  });

  const entries = scored.length
    ? scored
    : term
      ? filtered.slice(0, 12).map((contact) => ({ contact, score: 0 }))
      : [];

  if (entries.length === 0) {
    list.innerHTML =
      '<li class="cp-candidate"><span class="cp-candidate-info"><span class="cp-candidate-name">Nenhum contato encontrado</span><span class="cp-candidate-meta">Tente parte do nome, do código ou do CPF/CNPJ.</span></span></li>';
    return;
  }

  list.innerHTML = entries
    .map((entry) => {
      const document = formatDocument(entry.contact.document);
      // O CPF/CNPJ do candidato apareceu no histórico deste lançamento? Vale
      // avisar: é o sinal mais forte de que o vínculo está certo.
      const sameDocument = document && historyContainsDocument(row.rawHistory, entry.contact.document);
      return `
      <li class="cp-candidate">
        <span class="cp-candidate-info">
          <span class="cp-candidate-name">${escapeHtml(entry.contact.name)}</span>
          <span class="cp-candidate-meta">
            ${escapeHtml(contactCode(entry.contact.code))} • ${escapeHtml(NATUREZA_LABELS[entry.contact.natureza] || entry.contact.natureza)}${
              document ? ` • ${escapeHtml(document)}` : ''
            }${entry.score ? ` • ${Math.round(entry.score * 100)}%` : ''}
            ${sameDocument ? '<span class="cp-badge is-doc" title="Este CPF/CNPJ está no histórico do lançamento">mesmo CPF/CNPJ</span>' : ''}
          </span>
        </span>
        <button class="btn btn-sm btn-primary" type="button" data-cp-pick="${escapeHtml(entry.contact.code)}">Vincular</button>
      </li>`;
    })
    .join('');
}

function openLinkPanel(rowId) {
  const row = state.rows.find((item) => item.id === rowId);
  const panel = dom['cp-link-panel'];
  if (!row || !panel) return;

  state.linkingId = rowId;
  state.linkSearch = '';
  state.chartLinkSearch = '';
  if (dom['cp-link-search']) dom['cp-link-search'].value = '';
  if (dom['cp-link-chart-search']) dom['cp-link-chart-search'].value = '';
  if (dom['cp-link-history']) {
    // Quando o histórico traz o CPF/CNPJ, isso vai junto: é a pista mais forte
    // para o usuário escolher o contato certo na lista abaixo.
    const document = row.contact?.document
      ? formatDocument(row.contact.document)
      : formatDocument(row.document) || findDocumentInHistory(row.rawHistory);
    dom['cp-link-history'].textContent = document
      ? `${row.rawHistory} • CPF/CNPJ no histórico: ${document}`
      : row.rawHistory;
  }
  const suggestion = row.accountSuggestion;
  if (dom['cp-link-account-input']) {
    dom['cp-link-account-input'].value = row.counterpartAccount || suggestion?.account || '';
  }
  if (dom['cp-link-memory']) {
    if (suggestion) {
      dom['cp-link-memory'].textContent =
        `Sugestão da memória: ${suggestion.account} (pelo ${suggestion.source}, ` +
        `${suggestion.hits} confirmação(ões)) — já preenchida acima.`;
    } else if (row.counterpartAccount) {
      dom['cp-link-memory'].textContent =
        row.counterpartSource === 'memory'
          ? `Conta ${row.counterpartAccount} veio da memória (${row.counterpartHits || 1} confirmação(ões)).`
          : `Conta ${row.counterpartAccount} já preenchida nesta linha — ajuste no campo acima se precisar.`;
    } else {
      dom['cp-link-memory'].textContent =
        'A memória ainda não tem conta para este histórico: ao aplicar, ela passa a sugerir nas próximas vezes.';
    }
  }
  if (dom['cp-link-account-hint']) {
    const isPayment = row.direction === DIRECTION.PAYMENT;
    dom['cp-link-account-hint'].textContent = isPayment
      ? 'Este é um pagamento: o débito tem o fornecedor, então a contrapartida vai para o crédito.'
      : 'Este é um recebimento: o crédito tem o cliente, então a contrapartida vai para o débito.';
  }
  panel.classList.remove('hidden');
  renderChartCandidates();
  renderCandidates();
  (state.chartAccounts.length > 0 ? dom['cp-link-chart-search'] : dom['cp-link-search'])?.focus();
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function applyLink(code) {
  const row = currentLinkingRow();
  if (!row) return;
  const contact = state.contacts.find((item) => item.code === code);
  if (!contact) return;

  row.contact = {
    code: contact.code,
    name: contact.name,
    natureza: contact.natureza,
    classification: contact.classification,
  };
  delete row.chartMatch;
  delete row.chartSuggestion;
  row.status = 'manual';
  row.score = 1;
  row.learnedAlias = false;
  row.history = linkHistory(row.rawHistory, contact);

  const account = contactCode(contact.code);
  // A conta do contato ocupa a coluna da direção; a contrapartida do outro
  // lado (se já existir) é preservada.
  if (row.direction === DIRECTION.PAYMENT) row.debitAccount = account;
  else row.creditAccount = account;

  state.memory.counterparties = learnManualLink(state.memory, { history: row.rawHistory, contact });
  if (row.debitAccount) rememberAccount(row, 'debit', row.debitAccount, { persist: false });
  if (row.creditAccount) rememberAccount(row, 'credit', row.creditAccount, { persist: false });
  persistMemory();
  scheduleCloudPush();

  state.stats = summarizeReconciliation(state.rows);
  state.linkingId = null;
  dom['cp-link-panel']?.classList.add('hidden');
  render();
  track('vinculo', 'Vínculo feito à mão', `${contact.name} (${contact.code})`, 'manualLinks');
  showToast(`Vínculo memorizado: este histórico passa a apontar para ${contact.name}.`);
}

/* -------------------------------------------------------------------------- */
/*                                   Eventos                                  */
/* -------------------------------------------------------------------------- */

function bindEvents() {
  dom['cp-contacts-input']?.addEventListener('change', async (event) => {
    const files = [...(event.target.files || [])];
    if (files.length === 0) return;
    try {
      await loadContacts(files);
    } catch (error) {
      console.error(error);
      cpAlert(`<strong>Cadastro não lido.</strong> ${escapeHtml(error.message)}`, 'error');
      if (dom['cp-contacts-status']) dom['cp-contacts-status'].textContent = 'Falha ao ler o arquivo';
    }
  });

  dom['cp-ledger-input']?.addEventListener('change', async (event) => {
    const files = [...(event.target.files || [])];
    if (files.length === 0) return;
    try {
      await loadLedger(files);
    } catch (error) {
      console.error(error);
      cpAlert(`<strong>Extrato não lido.</strong> ${escapeHtml(error.message)}`, 'error');
      if (dom['cp-ledger-status']) dom['cp-ledger-status'].textContent = 'Falha ao ler o arquivo';
    }
  });

  dom['btn-cp-chart-update']?.addEventListener('click', () => {
    dom['cp-chart-input']?.click();
  });

  dom['cp-chart-input']?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    await uploadAndSyncChart(file);
  });

  dom['cp-chart-plan-select']?.addEventListener('change', (event) => {
    const planId = event.target.value;
    if (planId) void initChartFromDatabase(planId);
  });

  dom['btn-cp-run']?.addEventListener('click', () => void runReconciliation());
  dom['btn-cp-rerun']?.addEventListener('click', () => void runReconciliation());

  dom['cp-include-unmatched']?.addEventListener('change', () => {
    state.page = 1;
    renderRows();
  });

  dom['cp-search']?.addEventListener(
    'input',
    debounce((event) => {
      state.search = event.target.value;
      state.page = 1;
      renderRows();
    }, SEARCH_DEBOUNCE_MS)
  );

  document.querySelectorAll('.pill[data-cp-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      state.filter = button.dataset.cpFilter || 'all';
      state.page = 1;
      render();
    });
  });

  dom['cp-btn-prev']?.addEventListener('click', () => {
    state.page -= 1;
    renderRows();
  });
  dom['cp-btn-next']?.addEventListener('click', () => {
    state.page += 1;
    renderRows();
  });

  dom['cp-tbody']?.addEventListener('focusin', (event) => {
    const cell = event.target.closest('[data-cp-cell]');
    if (!cell) return;
    showChartAutocomplete(cell);
  });

  dom['cp-tbody']?.addEventListener('input', (event) => {
    const cell = event.target.closest('[data-cp-cell]');
    if (!cell) return;
    showChartAutocomplete(cell);
  });

  dom['cp-tbody']?.addEventListener('focusout', (event) => {
    const cell = event.target.closest('[data-cp-cell]');
    if (!cell) return;
    setTimeout(() => {
      if (cellAutocomplete.input === cell && document.activeElement !== cell) {
        hideChartAutocomplete();
      }
    }, 120);
  });

  dom['cp-tbody']?.addEventListener('keydown', (event) => {
    const cell = event.target.closest('[data-cp-cell]');
    if (!cell) return;
    const menuOpen = !dom['cp-chart-autocomplete']?.classList.contains('hidden');
    if (menuOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const max = cellAutocomplete.items.length - 1;
      if (max >= 0) {
        cellAutocomplete.activeIndex =
          event.key === 'ArrowDown'
            ? (cellAutocomplete.activeIndex + 1) % cellAutocomplete.items.length
            : (cellAutocomplete.activeIndex - 1 + cellAutocomplete.items.length) % cellAutocomplete.items.length;
        dom['cp-chart-autocomplete']?.querySelectorAll('[data-cp-ac-index]').forEach((el, idx) => {
          el.classList.toggle('is-active', idx === cellAutocomplete.activeIndex);
        });
      }
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (menuOpen && cellAutocomplete.activeIndex >= 0) {
        pickAutocompleteAccount(cellAutocomplete.activeIndex);
        return;
      }
      hideChartAutocomplete();
      cell.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      hideChartAutocomplete();
      cell.dataset.cpCancelled = '1';
      cell.blur();
    }
  });

  dom['cp-chart-autocomplete']?.addEventListener('mousedown', (event) => {
    const item = event.target.closest('[data-cp-ac-index]');
    if (!item) return;
    event.preventDefault();
    pickAutocompleteAccount(Number(item.dataset.cpAcIndex));
  });

  dom['cp-tbody']?.addEventListener('click', (event) => {
    const chartSuggest = event.target.closest('[data-cp-chart-suggest]');
    if (chartSuggest) {
      applyChartSuggestion(chartSuggest.dataset.cpChartSuggest);
      return;
    }

    const suggestion = event.target.closest('[data-cp-suggest]');
    if (suggestion) {
      applySuggestion(suggestion.dataset.cpSuggest);
      return;
    }

    const button = event.target.closest('[data-cp-link]');
    if (!button) return;
    openLinkPanel(Number(button.dataset.cpLink));
  });

  dom['btn-cp-apply-suggestions']?.addEventListener('click', applySuggestionsBatch);

  // Engrenagem: menu universal com o painel do administrador, a memória e a ajuda.
  gear = mountGearMenu({ ctx: gearContext, onAction: handleGearAction });

  dom['cp-tbody']?.addEventListener('change', (event) => {
    const cell = event.target.closest('[data-cp-cell]');
    if (cell) {
      applyCellAccount(cell);
      return;
    }

    const checkbox = event.target.closest('[data-cp-select]');
    if (!checkbox) return;
    const id = Number(checkbox.dataset.cpSelect);
    if (checkbox.checked) state.selected.add(id);
    else state.selected.delete(id);
    renderSelection();
  });

  dom['cp-select-all']?.addEventListener('change', (event) => {
    const select = event.target.checked;
    for (const row of visibleRows()) {
      if (select) state.selected.add(row.id);
      else state.selected.delete(row.id);
    }
    renderRows();
  });

  dom['btn-cp-clear-selection']?.addEventListener('click', () => {
    state.selected.clear();
    renderRows();
  });

  dom['cp-page-size']?.addEventListener('change', (event) => {
    const value = event.target.value;
    state.pageSize = value === 'all' ? 'all' : Number(value);
    state.page = 1;
    renderRows();
  });

  dom['btn-cp-account-apply']?.addEventListener('click', applyAccountBatch);
  for (const id of ['cp-debit-account-input', 'cp-credit-account-input']) {
    dom[id]?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        applyAccountBatch();
      }
    });
  }

  dom['btn-cp-link-account']?.addEventListener('click', applyAccountToLinkingRow);
  dom['cp-link-account-input']?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      applyAccountToLinkingRow();
    }
  });

  dom['btn-cp-link-close']?.addEventListener('click', () => {
    state.linkingId = null;
    dom['cp-link-panel']?.classList.add('hidden');
  });

  dom['cp-link-chart-search']?.addEventListener(
    'input',
    debounce((event) => {
      state.chartLinkSearch = event.target.value;
      renderChartCandidates();
    }, SEARCH_DEBOUNCE_MS)
  );

  dom['cp-link-chart-candidates']?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-cp-chart-pick]');
    if (!button) return;
    applyChartAccountFromPanel(button.dataset.cpChartPick, button.dataset.cpChartSide || 'debit');
  });

  dom['cp-link-search']?.addEventListener(
    'input',
    debounce((event) => {
      state.linkSearch = event.target.value;
      renderCandidates();
    }, SEARCH_DEBOUNCE_MS)
  );

  dom['cp-link-candidates']?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-cp-pick]');
    if (!button) return;
    applyLink(button.dataset.cpPick);
  });

  dom['btn-cp-export-xlsx']?.addEventListener('click', () => void exportXlsx());
  dom['btn-cp-export-pdf']?.addEventListener('click', exportPdf);
  dom['btn-cp-export-csv']?.addEventListener('click', exportCsv);
}

/* -------------------------------------------------------------------------- */
/*                                    Init                                    */
/* -------------------------------------------------------------------------- */

function init() {
  cacheDom();

  installGlobalErrorReporting({
    scope: 'Conciliador',
    notify: (message, kind, options) => {
      if (kind === 'error') track('erro', 'Aviso de erro na tela', String(message).slice(0, 180), 'errors');
      showToast(message, kind, options);
    },
  });
  if (dom['app-version']) dom['app-version'].textContent = `v${APP_VERSION}`;

  // Tamanho da página vem do seletor; qualquer valor estranho cai no padrão.
  const initialSize = dom['cp-page-size']?.value;
  state.pageSize =
    initialSize === 'all' || PAGE_SIZE_OPTIONS.includes(Number(initialSize))
      ? initialSize === 'all'
        ? 'all'
        : Number(initialSize)
      : DEFAULT_PAGE_SIZE;
  if (dom['cp-page-size']) dom['cp-page-size'].value = String(state.pageSize);

  // Limpa e salva eventual sessão vinda de redirect de confirmação do Supabase Auth.
  consumeAuthRedirect();
  counterpartyMemory();
  renderCloudState(describeIdentity(), 'idle');
  // Painel do administrador: marcação, sessão de uso e tempo ativo. O
  // desbloqueio feito na página principal (mesma aba) vale aqui também.
  adminConsole.mount();
  bindEvents();
  render();
  void initChartFromDatabase();
  // Sem botão de sincronizar: puxa a nuvem sozinho na abertura e ao voltar o foco.
  scheduleCloudPull();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    scheduleCloudPull(1500);
  });

  if (!('ExcelJS' in window) || !window.jspdf) {
    showToast('Bibliotecas de planilha/PDF não carregaram corretamente. Recarregue a página.', 'error', {
      duration: 0,
    });
  }
}

try {
  init();
} catch (error) {
  reportStartupFailure({ scope: 'Conciliador', label: 'a página', error });
}

if (typeof window !== 'undefined') window.__conciliador = { state };
