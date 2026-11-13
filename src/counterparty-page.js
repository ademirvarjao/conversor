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
import {
  MAX_EVENTS,
  USAGE_KEY,
  addActiveTime,
  bumpCounter,
  eventsToCsv,
  formatDateTime,
  formatDuration,
  loadUsage,
  recordEvent,
  resetUsage,
  saveUsage,
  startSession,
  usageReport,
} from './admin-usage.js';
import { adminPanelHeadline, renderAdminPanel } from './admin-panel.js';
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
import { formatValuePlainBr } from './format.js';
import { extractPdfLines, normalizeText, parsePdfFile, parseXlsxFile } from './parsers.js';
import { formatAccessCode } from './sync-crypto.js';
import { LOCKOUT_MS, MAX_ATTEMPTS, loadUnlock, saveUnlock, verifyCloudCredentials } from './cloud-lock.js';
import { loadSession } from './cloud-auth.js';
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
  learnedCount: 0,
  selected: new Set(),
  pageSize: DEFAULT_PAGE_SIZE,
  busy: false,
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
  'cp-memory-state',
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
  'cp-link-search',
  'cp-link-candidates',
  'cp-learned',
  'btn-cp-export-xlsx',
  'btn-cp-export-pdf',
  'btn-cp-export-csv',
  'cp-cloud-state',
  'btn-cp-admin',
  'cp-admin-gate',
  'cp-admin-user',
  'cp-admin-password',
  'btn-cp-admin-enter',
  'cp-admin-error',
  'cp-admin-panel',
  'cp-admin-body',
  'cp-admin-headline',
  'btn-cp-admin-close',
  'btn-cp-admin-refresh',
  'btn-cp-admin-export',
  'btn-cp-admin-logs',
  'btn-cp-admin-reset',
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
  toast.textContent = message;
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
/*                 Uso, logs e painel do administrador                        */
/* -------------------------------------------------------------------------- */

/**
 * O painel do administrador é local: mostra o uso **deste navegador** (sessões,
 * tempo com a aba visível, conciliações, exportações), a memória da IA, os logs
 * de eventos e os dados do dispositivo. Nada aqui consulta servidor nem guarda
 * conteúdo de arquivo.
 */
const usage = loadUsage();
const adminPanel = { tab: 'overview', open: false, logFilter: 'all', sessionStartedAt: Date.now() };
const USAGE_TICK_MS = 30000;
let activeAnchor = 0;

function persistUsage() {
  saveUsage(usage);
}

/** Registra um evento no histórico (e, se pedido, soma um contador). */
function track(type, message, details = '', counter = null, amount = 1) {
  recordEvent(usage, { type, message, details }, Date.now());
  if (counter) bumpCounter(usage, counter, amount, Date.now());
  persistUsage();
}

/** Só soma contador (edições em série não viram um evento cada). */
function trackCount(counter, amount = 1) {
  bumpCounter(usage, counter, amount, Date.now());
  persistUsage();
}

/**
 * Tempo de uso = tempo com a aba visível. Fecha o período quando a aba sai de
 * foco, ao trocar de página e a cada 30 s enquanto ela está aberta.
 */
function flushActiveTime() {
  if (!activeAnchor) return;
  const now = Date.now();
  addActiveTime(usage, now - activeAnchor, now);
  activeAnchor = now;
  persistUsage();
}

function watchActiveTime() {
  activeAnchor = document.visibilityState === 'visible' ? Date.now() : 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      activeAnchor = Date.now();
      return;
    }
    flushActiveTime();
    activeAnchor = 0;
  });
  window.addEventListener('pagehide', flushActiveTime);
  setInterval(flushActiveTime, USAGE_TICK_MS);
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1).replace('.', ',')} KB`;
  return `${(value / (1024 * 1024)).toFixed(2).replace('.', ',')} MB`;
}

/** Quanto cada coisa ocupa no navegador (só o tamanho, nunca o conteúdo). */
function storageSizes() {
  const sizes = { memory: 0, usage: 0, total: 0, keys: 0 };
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key) continue;
      const size = key.length + (localStorage.getItem(key) || '').length;
      sizes.total += size;
      sizes.keys += 1;
      if (key === AI_MEMORY_KEY) sizes.memory = size;
      if (key === USAGE_KEY) sizes.usage = size;
    }
  } catch {
    /* modo privado: mostra "—" */
  }
  return {
    memory: sizes.memory ? formatBytes(sizes.memory) : '—',
    usage: sizes.usage ? formatBytes(sizes.usage) : '—',
    total: sizes.total ? formatBytes(sizes.total) : '—',
    keys: sizes.keys,
  };
}

/** Navegador, sistema e tela — o que o app consegue saber sem pedir permissão. */
function deviceRows() {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const ua = String(nav.userAgent || '');
  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : 'não identificado';
  const system =
    /Windows/.test(ua) ? 'Windows'
    : /Android/.test(ua) ? 'Android'
    : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Mac OS X/.test(ua) ? 'macOS'
    : /Linux/.test(ua) ? 'Linux'
    : 'não identificado';
  const screenInfo =
    typeof screen !== 'undefined' ? `${screen.width}×${screen.height} (janela ${window.innerWidth}×${window.innerHeight})` : '—';
  const tz = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || '—';
    } catch {
      return '—';
    }
  })();

  return [
    ['Navegador', browser],
    ['Sistema', system],
    ['Idioma', nav.language || '—'],
    ['Fuso horário', tz],
    ['Tela', screenInfo],
    ['Densidade', `${window.devicePixelRatio || 1}×`],
    ['Núcleos de CPU', nav.hardwareConcurrency ? String(nav.hardwareConcurrency) : '—'],
    ['Memória do aparelho', nav.deviceMemory ? `${nav.deviceMemory} GB` : 'não informado'],
    ['Conexão', nav.connection?.effectiveType ? nav.connection.effectiveType.toUpperCase() : 'não informada'],
    ['Toque', nav.maxTouchPoints > 0 ? `sim (${nav.maxTouchPoints} ponto(s))` : 'não'],
  ];
}

/** Resumo da nuvem já formatado para o painel. */
function cloudSummary() {
  const identity = cloud.identity;
  let account = 'sem conta';
  try {
    const saved = loadSession();
    account = saved?.email || 'sem conta';
  } catch {
    /* sem sessão guardada */
  }
  return {
    accessCode: identity ? formatAccessCode(identity.code) : '',
    lastSync: identity?.lastSyncAt ? formatDateTime(identity.lastSyncAt) : '—',
    host: cloud.config?.url ? cloud.config.url.replace(/^https?:\/\//i, '') : '',
    account,
    remote: identity ? 'sincronizado' : 'não verificado',
    auto: true,
  };
}

/** Redesenha o corpo do painel (aba atual). */
function renderAdminPanelBody() {
  const body = dom['cp-admin-body'];
  if (!body) return;

  body.innerHTML = renderAdminPanel({
    tab: adminPanel.tab,
    usage,
    memory: state.memory,
    device: { rows: deviceRows() },
    cloud: cloudSummary(),
    storage: storageSizes(),
    logFilter: adminPanel.logFilter,
    sessionStartedAt: adminPanel.sessionStartedAt,
  });
  if (dom['cp-admin-headline']) dom['cp-admin-headline'].textContent = adminPanelHeadline(usage);

  document.querySelectorAll('[data-cp-admin-tab]').forEach((button) => {
    const active = button.dataset.cpAdminTab === adminPanel.tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
}

function openAdminPanel() {
  const panel = dom['cp-admin-panel'];
  if (!panel) return;
  flushActiveTime();
  adminPanel.open = true;
  renderAdminPanelBody();
  panel.classList.remove('hidden');
  panel.setAttribute('aria-hidden', 'false');
  dom['btn-cp-admin-close']?.focus();
  track('sessao', 'Painel do administrador aberto');
}

function closeAdminPanel() {
  const panel = dom['cp-admin-panel'];
  if (!panel || panel.classList.contains('hidden')) return;
  adminPanel.open = false;
  panel.classList.add('hidden');
  panel.setAttribute('aria-hidden', 'true');
  dom['btn-cp-admin']?.focus();
}

/** Baixa um arquivo de texto gerado no navegador. */
function downloadTextFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function adminFileName(extension) {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return `painel-administrador-${stamp}.${extension}`;
}

function exportAdminReport() {
  flushActiveTime();
  const report = usageReport(
    {
      usage,
      memory: state.memory,
      device: Object.fromEntries(deviceRows()),
      cloud: cloudSummary(),
      appVersion: APP_VERSION,
    },
    Date.now()
  );
  downloadTextFile(JSON.stringify(report, null, 2), adminFileName('json'), 'application/json');
  track('exportacao', 'Relatório do painel exportado', '.json');
  showToast('Relatório do painel exportado em .json.');
}

function exportAdminLogs() {
  const csv = `\ufeff${eventsToCsv(usage)}`;
  downloadTextFile(csv, adminFileName('csv'), 'text/csv;charset=utf-8');
  track('exportacao', 'Logs do painel exportados', '.csv');
  showToast('Logs exportados em .csv (separador ";" — abre direto no Excel).');
}

function resetAdminHistory() {
  if (!window.confirm('Apagar o histórico de uso e os logs deste navegador? A memória da IA não é afetada.')) return;
  const fresh = resetUsage();
  Object.assign(usage, fresh);
  persistUsage();
  adminPanel.sessionStartedAt = Date.now();
  renderAdminPanelBody();
  showToast('Histórico de uso apagado.', 'warn');
}

/* -------------------------------------------------------------------------- */
/*                    Painel da memória (só administrador)                    */
/* -------------------------------------------------------------------------- */

/**
 * O resumo "Memória: N históricos • N contatos…" é informação de administração.
 * Ele só aparece depois de o dono entrar com login e senha, usando **a mesma
 * trava da conexão do banco** (`cloud-lock.js`): o desbloqueio fica na sessão da
 * aba por 1 hora, então quem liberou na página principal já encontra liberado
 * aqui, e quem nunca entrou não vê número nenhum.
 */
const admin = {
  unlocked: Boolean(loadUnlock()),
  attempts: 0,
  cooldownUntil: 0,
};

/** `true` só enquanto o desbloqueio vale; expirou, volta a esconder. */
function adminUnlocked() {
  if (!admin.unlocked) return false;
  if (loadUnlock()) return true;
  admin.unlocked = false;
  return false;
}

function setAdminError(message) {
  const box = dom['cp-admin-error'];
  if (!box) return;
  box.textContent = message;
  box.classList.toggle('hidden', !message);
}

/**
 * Estado do acesso administrativo: o botão fica sempre no topo (é ele que abre
 * o login ou, já liberado, o painel completo), o formulário só aparece quando
 * ainda falta entrar e o resumo da memória só com o desbloqueio válido.
 */
function renderAdminState() {
  const unlocked = adminUnlocked();
  const toggle = dom['btn-cp-admin'];
  if (toggle) {
    toggle.hidden = false;
    toggle.title = unlocked
      ? 'Abrir o painel do administrador (uso, memória, logs)'
      : 'Entrar como administrador para ver o painel';
    toggle.dataset.state = unlocked ? 'unlocked' : 'locked';
    toggle.setAttribute('aria-label', unlocked ? 'Abrir o painel do administrador' : 'Entrar como administrador');
  }
  if (unlocked) {
    dom['cp-admin-gate']?.classList.add('hidden');
    toggle?.setAttribute('aria-expanded', 'false');
    setAdminError('');
  }
  renderMemoryState();
}

async function submitAdminGate(event) {
  event?.preventDefault();
  const now = Date.now();
  if (admin.cooldownUntil > now) {
    setAdminError(`Muitas tentativas. Aguarde ${Math.ceil((admin.cooldownUntil - now) / 1000)}s.`);
    return;
  }

  const user = dom['cp-admin-user']?.value || '';
  const password = dom['cp-admin-password']?.value || '';
  if (!user.trim() || !password) {
    setAdminError('Informe login e senha.');
    return;
  }

  const button = dom['btn-cp-admin-enter'];
  if (button) button.disabled = true;
  try {
    const ok = await verifyCloudCredentials(user, password);
    if (!ok) {
      admin.attempts += 1;
      if (admin.attempts >= MAX_ATTEMPTS) {
        admin.attempts = 0;
        admin.cooldownUntil = Date.now() + LOCKOUT_MS;
        setAdminError('Muitas tentativas erradas. Aguarde 30 segundos.');
      } else {
        setAdminError(`Login ou senha incorretos (${admin.attempts}/${MAX_ATTEMPTS}).`);
      }
      if (dom['cp-admin-password']) dom['cp-admin-password'].value = '';
      return;
    }

    admin.attempts = 0;
    admin.cooldownUntil = 0;
    admin.unlocked = true;
    saveUnlock();
    if (dom['cp-admin-password']) dom['cp-admin-password'].value = '';
    renderAdminState();
    openAdminPanel();
    showToast('Painel do administrador liberado nesta aba por 1 hora.', 'success');
  } catch (error) {
    setAdminError(error?.message || 'Não foi possível validar a senha.');
  } finally {
    if (button) button.disabled = false;
  }
}

/**
 * Mostra o quanto a memória já sabe sobre contas (treino do conciliador).
 * Sem o desbloqueio do administrador o resumo fica oculto e o texto é limpo,
 * para não sobrar número no DOM.
 */
function renderMemoryState() {
  const element = dom['cp-memory-state'];
  if (!element) return;

  const show = adminUnlocked();
  element.classList.toggle('hidden', !show);
  element.hidden = !show;
  if (!show) {
    element.textContent = '';
    // Se o desbloqueio venceu com a página aberta, o acesso volta a aparecer.
    if (dom['btn-cp-admin']) dom['btn-cp-admin'].hidden = false;
    return;
  }

  const summary = accountMemorySummary(state.memory);
  const contacts = Object.keys(sanitizeCounterparties(state.memory.counterparties).contacts).length;
  if (summary.total === 0 && contacts === 0) {
    element.textContent = 'Memória: nenhuma conta memorizada ainda';
    return;
  }

  element.textContent =
    `Memória: ${summary.byHistory} histórico(s) • ${summary.byContact} contato(s) com conta` +
    (contacts > 0 ? ` • ${contacts} contato(s) conciliado(s)` : '');
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
    renderMemoryState();
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
    renderMemoryState();
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
  if (cloudPushTimer) clearTimeout(cloudPushTimer);
  cloudPushTimer = setTimeout(() => {
    cloudPushTimer = null;
    void pushModels({ silent: true });
  }, 1200);
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
  button.disabled = state.busy || state.contacts.length === 0 || state.transactions.length === 0;
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
    const parsed = await parsePdfFile(buffer, file.name, pdfjsLib, { onProgress });
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
  if (state.contacts.length === 0 || state.transactions.length === 0) {
    showToast('Carregue o cadastro e o extrato antes de conciliar.', 'warn');
    return;
  }

  state.busy = true;
  updateRunButton();
  setProcessing(true, 'Conciliando clientes e fornecedores…');

  try {
    const { rows, stats } = reconcileCounterparties(state.transactions, state.contacts, {
      memory: state.memory,
    });
    rows.forEach((row, index) => {
      row.id = index;
    });

    state.rows = rows;
    state.stats = stats;
    state.page = 1;
    state.filter = 'all';
    state.search = '';
    state.linkSearch = '';
    state.linkingId = null;
    state.selected = new Set();
    if (dom['cp-search']) dom['cp-search'].value = '';
    if (dom['cp-link-search']) dom['cp-link-search'].value = '';
    dom['cp-link-panel']?.classList.add('hidden');

    // A IA aprende a cada uso: os vínculos aceitos viram apelidos persistentes.
    // A estatística conta só o que é **novo** — refazer a conciliação não pode
    // somar de novo os mesmos vínculos.
    const before = Object.keys(sanitizeCounterparties(state.memory.counterparties).aliases).length;
    const learned = learnFromReconciliation(state.memory, rows);
    const after = Object.keys(learned.counterparties.aliases).length;
    state.memory.counterparties = learned.counterparties;
    state.learnedCount = learned.learnedCount;
    state.memory.stats.correctionsLearned =
      (state.memory.stats.correctionsLearned || 0) + Math.max(0, after - before);
    persistMemory();
    renderMemoryState();
    scheduleCloudPush();

    render();

    track(
      'conciliacao',
      `Conciliação: ${stats.matched} de ${stats.total} vinculados`,
      `${stats.byDocument || 0} por CPF/CNPJ • ${stats.ambiguous} para revisar • ${stats.unmatched} sem contato`,
      'reconciliations'
    );
    // Soma os números da rodada (linhas, não eventos).
    bumpCounter(usage, 'rowsReconciled', stats.matched, Date.now());
    bumpCounter(usage, 'rowsReview', stats.ambiguous, Date.now());
    bumpCounter(usage, 'rowsUnmatched', stats.unmatched, Date.now());
    persistUsage();

    const suggested = rows.filter((row) => row.accountSuggestion).length;
    const fromMemory = rows.filter((row) => row.counterpartSource === 'memory').length;
    cpAlert('');
    showToast(
      `Conciliação concluída: ${stats.matched} de ${stats.total} lançamentos vinculados (${stats.ambiguous} para revisar).` +
        (stats.byDocument ? ` ${stats.byDocument} pelo CPF/CNPJ do histórico.` : '') +
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
    if (!includeUnmatched && !row.contact) return false;
    if (state.filter === 'matched' && !['matched', 'manual'].includes(row.status)) return false;
    if (state.filter === 'review' && row.status !== 'ambiguous') return false;
    if (state.filter === 'unmatched' && row.contact) return false;
    if (state.filter === 'document' && row.matchReason !== 'document') return false;
    if (!term) return true;
    // A busca vale para tudo o que está na linha: histórico, contato, código,
    // CPF/CNPJ, data e as contas de débito/crédito. Procurar a conta
    // "5086959" é o jeito mais rápido de auditar onde ela foi usada.
    const haystack = [
      row.history,
      row.contact?.name,
      row.contact?.code,
      row.contact?.document,
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
 * Saber **por que** a linha casou (nome, memória ou CPF/CNPJ) é o que permite
 * revisar rápido: um vínculo por nome a 62% merece conferência; um vínculo por
 * CPF/CNPJ, não.
 */
function statusBadge(row) {
  const score = row.score ? `${Math.round(row.score * 100)}% de semelhança` : 'sem semelhança';
  if (row.status === 'manual') return '<span class="cp-badge" title="Vínculo escolhido à mão">manual</span>';
  if (row.learnedAlias) {
    return '<span class="cp-badge" title="Histórico já vinculado numa conciliação anterior">memória</span>';
  }
  if (row.status === 'matched') {
    const why = row.matchReason === 'document' ? 'CPF/CNPJ igual ao do cadastro' : `nome — ${score}`;
    return `<span class="cp-badge" title="Vínculo automático por ${escapeHtml(why)}">conciliado</span>`;
  }
  if (row.status === 'ambiguous') {
    return `<span class="cp-badge is-review" title="Há mais de um contato parecido (${escapeHtml(score)}) — confira antes de exportar">revisar</span>`;
  }
  return '<span class="cp-badge is-none" title="Nenhum contato do cadastro bateu com este histórico">sem contato</span>';
}

/** Célula de débito/crédito: vazia vira campo para digitar a conta à mão. */
function accountCell(row, side) {
  const filled = side === 'credit' ? row.creditAccount : row.debitAccount;
  const editable = !filled || isManualAccountCell(row, side);
  const label = side === 'credit' ? 'crédito' : 'débito';

  if (!editable) return `<td class="col-account">${escapeHtml(filled)}</td>`;

  return `
            <td class="col-account col-account-editable">
              <input
                class="cp-cell-account"
                type="text"
                inputmode="numeric"
                autocomplete="off"
                spellcheck="false"
                maxlength="24"
                placeholder="—"
                value="${escapeHtml(filled || '')}"
                data-cp-cell="${side}"
                data-cp-row="${row.id}"
                aria-label="Conta do ${label} deste lançamento (célula vazia, digite para preencher)"
                title="Digite a conta do ${label} — só preenche o que está vazio"
              />
            </td>`;
}

/** Quantas linhas cabem na página (a conciliação inteira quando `'all'`). */
function rowsPerPage() {
  return state.pageSize === 'all' ? Infinity : Number(state.pageSize) || DEFAULT_PAGE_SIZE;
}

/** Chip clicável com a conta que a memória sugere para a linha. */
function suggestionChip(row) {
  const suggestion = row?.accountSuggestion;
  if (!suggestion) return '';

  const label = suggestion.side === 'credit' ? 'crédito' : 'débito';
  return `<button
      class="cp-suggest"
      type="button"
      data-cp-suggest="${row.id}"
      title="Conta ${suggestion.account} memorizada pelo ${suggestion.source} — clique para preencher o ${label}"
    >sugestão: ${suggestion.account} no ${label}</button>`;
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
            ${row.counterpartSource === 'memory' ? '<span class="cp-badge is-memory" title="Conta preenchida pela memória da IA">conta da memória</span>' : ''}
            ${row.contact ? `<span class="cp-contact">${escapeHtml(row.contact.name)}</span>` : ''}
            ${suggestionChip(row)}
          </td>
          <td class="col-cp-link">
            <button class="cp-link-btn" type="button" data-cp-link="${row.id}" title="Vincular este lançamento a outro contato">
              ${row.contact ? 'Trocar' : 'Vincular'}
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

  const pending = visibleRows().filter((row) => row.accountSuggestion).length;
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
  set('cp-kpi-debit', formatValuePlainBr(stats.debitCents / 100));
  set('cp-kpi-suppliers', `${stats.suppliers} fornecedores`);
  set('cp-kpi-credit', formatValuePlainBr(stats.creditCents / 100));
  set('cp-kpi-customers', `${stats.customers} clientes`);
  set('cp-kpi-value', formatValuePlainBr(stats.valueCents / 100));
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

  state.stats = summarizeReconciliation(state.rows);
  render();
  track('conta', 'Sugestão aceita', `conta ${suggestion.account} no ${suggestion.side === 'credit' ? 'crédito' : 'débito'}`, 'suggestionsApplied');

  showToast(
    `Conta ${suggestion.account} aplicada no ${suggestion.side === 'credit' ? 'crédito' : 'débito'} — memória reforçada.`
  );
}

/** Aplica de uma vez todas as contas sugeridas no filtro atual. */
function applySuggestionsBatch() {
  const targets = visibleRows().filter((row) => row.accountSuggestion);
  if (targets.length === 0) {
    showToast('Nenhuma conta sugerida neste filtro.', 'warn');
    return;
  }

  for (const row of targets) {
    const suggestion = row.accountSuggestion;
    setRowCellAccount(row, suggestion.side, suggestion.account);
    delete row.accountSuggestion;
    rememberAccount(row, suggestion.side, suggestion.account, { persist: false });
  }

  persistMemory();
  renderMemoryState();
  scheduleCloudPush();

  state.stats = summarizeReconciliation(state.rows);
  render();
  track('conta', 'Sugestões aplicadas em lote', `${targets.length} conta(s)`, 'suggestionsApplied', targets.length);
  showToast(`${targets.length} conta(s) sugerida(s) aplicada(s) — a memória foi reforçada.`);
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
        // Cada conta aplicada vira treino: histórico + contato.
        rememberAccount(row, side, account, { persist: false });
      }
    }

    const label = side === 'credit' ? 'crédito' : 'débito';
    if (changed > 0) parts.push(account ? `${label} ${account} em ${changed}` : `limpeza no ${label} em ${changed}`);
  }

  persistMemory();
  renderMemoryState();
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
 * Preenche a conta de uma célula (débito/crédito) direto na tabela.
 *
 * A célula só aceita valor quando está vazia (ou quando o próprio usuário
 * digitou ali), então a conta vinda do cadastro do contato nunca é trocada
 * por engano. Vale para completar o outro lado — a contrapartida — ou para
 * preencher a conta do contato num lançamento que ficou "sem contato".
 */
function applyCellAccount(input) {
  const row = state.rows.find((item) => item.id === Number(input.dataset.cpRow));
  if (!row) return;

  const side = input.dataset.cpCell === 'credit' ? 'credit' : 'debit';
  const label = side === 'credit' ? 'crédito' : 'débito';
  const account = contactCode(input.value);
  const current = side === 'credit' ? row.creditAccount : row.debitAccount;

  if (input.dataset.cpCancelled) {
    delete input.dataset.cpCancelled;
    input.value = current || '';
    return;
  }

  // Célula vazia e nada digitado: não há o que fazer.
  if (!account) {
    input.value = current || '';
    if (!current) return;
  }

  // Conta vinda do cadastro do contato não é substituída por aqui.
  if (current && !isManualAccountCell(row, side)) {
    input.value = current;
    showToast(`A conta do ${label} veio do cadastro do contato e não é substituída por aqui.`, 'warn');
    return;
  }

  setRowCellAccount(row, side, account);
  delete row.accountSuggestion;
  rememberAccount(row, side, account);
  trackCount('accountEdits');
  state.stats = summarizeReconciliation(state.rows);
  render();

  if (!account) {
    showToast(`Conta do ${label} limpa neste lançamento.`);
    return;
  }

  showToast(
    row.counterpartAccount === account
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
    rememberAccount(row, row.direction === DIRECTION.PAYMENT ? 'credit' : 'debit', account);
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

function renderCandidates() {
  const list = dom['cp-link-candidates'];
  const row = currentLinkingRow();
  if (!list || !row) return;

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
  if (dom['cp-link-search']) dom['cp-link-search'].value = '';
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
  renderCandidates();
  dom['cp-link-search']?.focus();
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
  renderMemoryState();
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

  dom['cp-tbody']?.addEventListener('keydown', (event) => {
    const cell = event.target.closest('[data-cp-cell]');
    if (!cell) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      cell.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cell.dataset.cpCancelled = '1';
      cell.blur();
    }
  });

  dom['cp-tbody']?.addEventListener('click', (event) => {
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

  // Administrador: sem desbloqueio abre o login; com desbloqueio abre o painel.
  dom['btn-cp-admin']?.addEventListener('click', () => {
    if (adminUnlocked()) {
      openAdminPanel();
      return;
    }
    const gate = dom['cp-admin-gate'];
    if (!gate) return;
    const open = gate.classList.toggle('hidden') === false;
    dom['btn-cp-admin'].setAttribute('aria-expanded', String(open));
    setAdminError('');
    if (open) dom['cp-admin-user']?.focus();
  });
  dom['cp-admin-gate']?.addEventListener('submit', (event) => void submitAdminGate(event));

  // ---- painel do administrador ----
  dom['btn-cp-admin-close']?.addEventListener('click', closeAdminPanel);
  dom['btn-cp-admin-refresh']?.addEventListener('click', () => {
    flushActiveTime();
    renderAdminPanelBody();
    showToast('Painel atualizado.');
  });
  dom['btn-cp-admin-export']?.addEventListener('click', exportAdminReport);
  dom['btn-cp-admin-logs']?.addEventListener('click', exportAdminLogs);
  dom['btn-cp-admin-reset']?.addEventListener('click', resetAdminHistory);

  dom['cp-admin-panel']?.addEventListener('click', (event) => {
    // Clique no fundo escuro fecha o painel (clique no cartão, não).
    if (event.target === dom['cp-admin-panel']) closeAdminPanel();
  });

  document.querySelectorAll('[data-cp-admin-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      adminPanel.tab = button.dataset.cpAdminTab;
      renderAdminPanelBody();
    });
  });

  // Filtro dos logs: guarda o tipo escolhido e redesenha a aba.
  dom['cp-admin-body']?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-cp-admin-log]');
    if (!chip) return;
    adminPanel.logFilter = chip.dataset.cpAdminLog || 'all';
    renderAdminPanelBody();
  });

  // Esc fecha o painel e o login do administrador.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (adminPanel.open) {
      closeAdminPanel();
      return;
    }
    dom['cp-admin-gate']?.classList.add('hidden');
    dom['btn-cp-admin']?.setAttribute('aria-expanded', 'false');
  });

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

  // Uso deste navegador: sessão nova + um contador de aberturas por dia.
  startSession(usage);
  bumpCounter(usage, 'sessions', 1, Date.now());
  persistUsage();
  watchActiveTime();
  recordEvent(usage, { type: 'sessao', message: 'Conciliação aberta' }, Date.now());
  persistUsage();

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

  counterpartyMemory();
  renderCloudState(describeIdentity(), 'idle');
  // Quem já entrou como administrador na página principal (mesma aba do
  // navegador) não digita a senha de novo para ver o painel.
  if (loadUnlock()) admin.unlocked = true;
  renderAdminState();
  bindEvents();
  render();
  // Sem botão de sincronizar: puxa a nuvem sozinho na abertura e ao voltar o foco.
  scheduleCloudPull();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    renderAdminState(); // o desbloqueio do administrador expira em 1 hora
    if (adminPanel.open) renderAdminPanelBody();
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
