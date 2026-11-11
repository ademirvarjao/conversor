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
import { loadAiMemory, saveAiMemory } from './ai-engine.js';
import {
  DIRECTION,
  NATUREZA,
  NATUREZA_LABELS,
  buildContactsFromLines,
  buildContactsFromTable,
  candidatesFor,
  contactCode,
  contactSummary,
  learnFromReconciliation,
  learnManualLink,
  linkHistory,
  mergeContacts,
  mergeTransactions,
  reconcileCounterparties,
  sanitizeCounterparties,
  scoreCandidates,
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
import {
  applyVaultPayload,
  loadCloudConfig,
  loadIdentity,
  pullVault,
  pushVault,
  touchIdentitySync,
} from './sync-vault.js';
import { APP_VERSION } from './ui-contract.js';

const PAGE_SIZE = 40;
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
  'btn-cp-cloud-push',
  'btn-cp-cloud-pull',
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

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  const hasIdentity = Boolean(cloud.identity && cloud.config);
  for (const id of ['btn-cp-cloud-push', 'btn-cp-cloud-pull']) {
    if (dom[id]) dom[id].disabled = !hasIdentity || cloud.busy;
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
    if (!silent) showToast('Modelos aprendidos enviados para a nuvem.');
  } catch (error) {
    renderCloudState('Falha ao enviar', 'error');
    if (!silent) showToast(`Falha ao enviar: ${error.message}`, 'error');
  } finally {
    cloud.busy = false;
    renderCloudState(dom['cp-cloud-state']?.textContent || '', 'idle');
  }
}

async function pullModels() {
  if (!cloud.config || !cloud.identity) {
    showToast('Crie sua chave na página inicial para baixar os modelos da nuvem.', 'warn');
    return;
  }
  if (cloud.busy) return;

  cloud.busy = true;
  renderCloudState('Baixando modelos…', 'busy');
  try {
    const remote = await pullVault({ config: cloud.config, identity: cloud.identity });
    if (!remote) {
      renderCloudState('Nenhum modelo na nuvem para esta chave', 'warn');
      showToast('Nada para baixar: a nuvem ainda não tem modelos desta chave.', 'warn');
      return;
    }

    state.memory = applyVaultPayload(state.memory, remote.payload);
    saveAiMemory(state.memory);
    cloud.identity = touchIdentitySync({ ...cloud.identity }, remote.updatedAt);
    renderCloudState('Modelos atualizados', 'ok');
    showToast('Modelos da nuvem aplicados a esta máquina.');
  } catch (error) {
    renderCloudState('Falha ao baixar', 'error');
    showToast(`Falha ao baixar: ${error.message}`, 'error');
  } finally {
    cloud.busy = false;
    setTimeout(() => renderCloudState(describeIdentity(), 'idle'), 1200);
  }
}

function describeIdentity() {
  if (!cloud.identity) return 'Modelos: só neste navegador';
  const code = formatAccessCode(cloud.identity.code || '');
  return `Modelos: chave ${code || '—'}`;
}

function scheduleCloudPush() {
  if (!cloud.config || !cloud.identity) return;
  setTimeout(() => {
    void pushModels({ silent: true });
  }, 900);
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
  if (statusEl) {
    statusEl.textContent = `${read} arquivo(s) • ${contacts.length} contatos • ${summary.suppliers} credora • ${summary.customers} devedora`;
  }
  dom['cp-contacts-status']?.closest('.cp-file')?.classList.add('is-loaded');

  const failureNote =
    failures.length > 0
      ? ` <strong>${failures.length} arquivo(s) não lido(s):</strong> ${failures.map(escapeHtml).join(' • ')}`
      : '';
  cpAlert(
    `Cadastro lido: <strong>${contacts.length}</strong> contatos de ${read} arquivo(s) (${summary.suppliers} fornecedores credora, ${
      summary.customers
    } clientes devedora)${rejected ? ` • ${rejected} linha(s) ignorada(s)` : ''}.${failureNote}`,
    failures.length > 0 ? 'warn' : 'info'
  );
  updateRunButton();
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

  if (statusEl) {
    statusEl.textContent = `${read} arquivo(s) • ${transactions.length} lançamentos • ${payments} pagamentos • ${receipts} recebimentos`;
  }
  dom['cp-ledger-status']?.closest('.cp-file')?.classList.add('is-loaded');

  const failureNote =
    failures.length > 0
      ? ` <strong>${failures.length} arquivo(s) não lido(s):</strong> ${failures.map(escapeHtml).join(' • ')}`
      : '';
  cpAlert(
    `Extrato lido: <strong>${transactions.length}</strong> lançamentos de ${read} arquivo(s) (${payments} pagamentos, ${receipts} recebimentos). Clique em <em>Conciliar agora</em>.${failureNote}`,
    failures.length > 0 ? 'warn' : 'info'
  );
  updateRunButton();
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
    if (dom['cp-search']) dom['cp-search'].value = '';
    if (dom['cp-link-search']) dom['cp-link-search'].value = '';
    dom['cp-link-panel']?.classList.add('hidden');

    // A IA aprende a cada uso: os vínculos aceitos viram apelidos persistentes.
    const learned = learnFromReconciliation(state.memory, rows);
    state.memory.counterparties = learned.counterparties;
    state.learnedCount = learned.learnedCount;
    state.memory.stats.correctionsLearned =
      (state.memory.stats.correctionsLearned || 0) + learned.learnedCount;
    saveAiMemory(state.memory);
    scheduleCloudPush();

    render();
    cpAlert('');
    showToast(
      `Conciliação concluída: ${stats.matched} de ${stats.total} lançamentos vinculados (${stats.ambiguous} para revisar).`
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
    if (state.filter === 'matched' && !(row.status === 'matched' || row.status === 'manual')) return false;
    if (state.filter === 'review' && row.status !== 'ambiguous') return false;
    if (state.filter === 'unmatched' && row.contact) return false;
    if (!term) return true;
    return normalizeText(`${row.history} ${row.contact?.name || ''} ${row.date}`).includes(term);
  });
}

function statusBadge(row) {
  if (row.status === 'manual') return '<span class="cp-badge">manual</span>';
  if (row.learnedAlias) return '<span class="cp-badge">memória</span>';
  if (row.status === 'matched') return '<span class="cp-badge">conciliado</span>';
  if (row.status === 'ambiguous') return '<span class="cp-badge is-review">revisar</span>';
  return '<span class="cp-badge is-none">sem contato</span>';
}

function renderRows() {
  const tbody = dom['cp-tbody'];
  if (!tbody) return;

  const rows = visibleRows();
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  state.page = Math.min(Math.max(1, state.page), totalPages);
  const start = (state.page - 1) * PAGE_SIZE;
  const pageRows = rows.slice(start, start + PAGE_SIZE);

  if (pageRows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">Nenhum lançamento para este filtro.</td></tr>';
  } else {
    tbody.innerHTML = pageRows
      .map(
        (row) => `
        <tr data-cp-row="${row.id}">
          <td class="col-date">${escapeHtml(row.date || '')}</td>
          <td class="col-account">${escapeHtml(row.debitAccount || '—')}</td>
          <td class="col-account">${escapeHtml(row.creditAccount || '—')}</td>
          <td class="col-money"><strong>${escapeHtml(formatValuePlainBr(row.valueCents / 100))}</strong></td>
          <td class="col-hist">
            <span class="cp-history">${escapeHtml(row.history)}</span><br />
            ${statusBadge(row)}
            ${row.contact ? `<span class="cp-contact">${escapeHtml(row.contact.name)}</span>` : ''}
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
      ? `Exibindo ${start + 1}–${Math.min(start + PAGE_SIZE, rows.length)} de ${rows.length}`
      : 'Exibindo 0 de 0';
  }
  if (dom['cp-btn-prev']) dom['cp-btn-prev'].disabled = state.page <= 1;
  if (dom['cp-btn-next']) dom['cp-btn-next'].disabled = state.page >= totalPages;
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
  set('cp-kpi-matched', `${stats.matched} conciliados • ${stats.ambiguous} para revisar`);
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

function exportRows() {
  return visibleRows();
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
    showToast('O filtro atual não tem lançamentos para exportar.', 'warn');
    return false;
  }
  return true;
}

async function exportXlsx() {
  if (!guardExport()) return;
  try {
    await exportCounterpartiesXlsx(exportRows(), exportName('xlsx'), window.ExcelJS);
    showToast('Planilha .xlsx gerada com o layout data | débito | crédito | valor | histórico.');
  } catch (error) {
    showToast(`Falha ao gerar .xlsx: ${error.message}`, 'error');
  }
}

function exportPdf() {
  if (!guardExport()) return;
  try {
    const rows = exportRows();
    exportCounterpartiesPdf(rows, summarizeReconciliation(rows), exportName('pdf'));
    showToast('PDF gerado com o layout data | débito | crédito | valor | histórico.');
  } catch (error) {
    showToast(`Falha ao gerar .pdf: ${error.message}`, 'error');
  }
}

function exportCsv() {
  if (!guardExport()) return;
  try {
    exportCounterpartiesCsv(exportRows(), exportName('csv'));
    showToast('CSV gerado (separador ";" e vírgula decimal) para abrir no Excel.');
  } catch (error) {
    showToast(`Falha ao gerar .csv: ${error.message}`, 'error');
  }
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
    .map(
      (entry) => `
      <li class="cp-candidate">
        <span class="cp-candidate-info">
          <span class="cp-candidate-name">${escapeHtml(entry.contact.name)}</span>
          <span class="cp-candidate-meta">
            ${escapeHtml(contactCode(entry.contact.code))} • ${escapeHtml(NATUREZA_LABELS[entry.contact.natureza] || entry.contact.natureza)}${
              entry.score ? ` • ${Math.round(entry.score * 100)}%` : ''
            }
          </span>
        </span>
        <button class="btn btn-sm btn-primary" type="button" data-cp-pick="${escapeHtml(entry.contact.code)}">Vincular</button>
      </li>`
    )
    .join('');
}

function openLinkPanel(rowId) {
  const row = state.rows.find((item) => item.id === rowId);
  const panel = dom['cp-link-panel'];
  if (!row || !panel) return;

  state.linkingId = rowId;
  state.linkSearch = '';
  if (dom['cp-link-search']) dom['cp-link-search'].value = '';
  if (dom['cp-link-history']) dom['cp-link-history'].textContent = row.rawHistory;
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
  row.debitAccount = row.direction === DIRECTION.PAYMENT ? account : '';
  row.creditAccount = row.direction === DIRECTION.PAYMENT ? '' : account;

  state.memory.counterparties = learnManualLink(state.memory, { history: row.rawHistory, contact });
  saveAiMemory(state.memory);
  scheduleCloudPush();

  state.stats = summarizeReconciliation(state.rows);
  state.linkingId = null;
  dom['cp-link-panel']?.classList.add('hidden');
  render();
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

  dom['cp-tbody']?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-cp-link]');
    if (!button) return;
    openLinkPanel(Number(button.dataset.cpLink));
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

  dom['btn-cp-cloud-push']?.addEventListener('click', () => void pushModels());
  dom['btn-cp-cloud-pull']?.addEventListener('click', () => void pullModels());
}

/* -------------------------------------------------------------------------- */
/*                                    Init                                    */
/* -------------------------------------------------------------------------- */

function init() {
  cacheDom();
  if (dom['app-version']) dom['app-version'].textContent = `v${APP_VERSION}`;

  counterpartyMemory();
  renderCloudState(describeIdentity(), 'idle');
  bindEvents();
  render();

  if (!('ExcelJS' in window) || !window.jspdf) {
    showToast('Bibliotecas de planilha/PDF não carregaram corretamente. Recarregue a página.', 'error', {
      duration: 0,
    });
  }
}

try {
  init();
} catch (error) {
  console.error('[Conciliador] Falha na inicialização:', error);
  const container = document.getElementById('toast-container');
  if (container) {
    const toast = document.createElement('div');
    toast.className = 'toast error';
    toast.setAttribute('role', 'alert');
    toast.textContent = `Falha ao iniciar a página: ${error.message}`;
    container.appendChild(toast);
  }
}

if (typeof window !== 'undefined') window.__conciliador = { state };
