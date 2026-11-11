import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';
import { cleanWhitespace, normalizeText, parsePdfFile, parseXlsxFile } from './parsers.js';
import {
  ROLES,
  ROLE_LABELS,
  analyzeFileLayout,
  analyzeWithOptionalLlm,
  loadAiMemory,
  normalizeMemory,
  resetAiMemory,
  saveAiMemory,
  trainAiWithLayout,
  transformRowsWithConfig,
} from './ai-engine.js';
import { formatLocalDateTime, formatValueGroupedBr, formatValuePlainBr, sumValues } from './format.js';
import { summarizeRecords } from './summary.js';
import { applyRowEdits, recordKey, setHistoryOverride } from './row-edits.js';
import { exportToPdf, exportToXlsx } from './exporters.js';
import { formatAccessCode, generateAccessCode, normalizeAccessCode } from './sync-crypto.js';
import {
  applyVaultPayload,
  clearCloudConfig,
  clearIdentity,
  loadCloudConfig,
  loadIdentity,
  pullVault,
  pushVault,
  restoreIdentityFromCode,
  saveCloudConfig,
  saveIdentity,
  touchIdentitySync,
} from './sync-vault.js';
import { normalizeSupabaseConfig, pingDatabase } from './sync-client.js';
import { DEFAULT_CLOUD_CONFIG } from './sync-config.js';
import { APP_VERSION, REQUIRED_ELEMENT_IDS } from './ui-contract.js';

const DEFAULT_PAGE_SIZE = 100;
/** Opções de linhas por página (`'all'` mostra a planilha inteira). */
const PAGE_SIZE_OPTIONS = [50, 100, 300, 1000, 'all'];
const MAX_FILE_BYTES = 60 * 1024 * 1024; // 60 MB por arquivo
const SEARCH_DEBOUNCE_MS = 180;
const SUPPORTED_EXTENSIONS = ['pdf', 'xlsx'];

if (pdfjsLib?.GlobalWorkerOptions) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/pdf.worker.min.mjs';
}

/* -------------------------------------------------------------------------- */
/*                                    Estado                                  */
/* -------------------------------------------------------------------------- */

const state = {
  memory: loadAiMemory(),
  /** @type {Array<{id:string,parsedFile:object,analysis:object,result:{records:any[],skipped:any[]},meta:{size:number,uploadedAt:string}}>} */
  files: [],
  selectedFileId: null,
  unifiedRows: [],
  filteredRows: [],
  summary: summarizeRecords([]),
  searchTerm: '',
  typeFilter: 'all',
  currentPage: 1,
  pageSize: DEFAULT_PAGE_SIZE,
  /** Chaves (`arquivo#linha`) marcadas na tabela. */
  selected: new Set(),
  /** Histórico digitado à mão, por chave de origem. */
  historyOverrides: new Map(),
  /** Linhas que o usuário excluiu (podem ser restauradas). */
  removedKeys: new Set(),
  removedCount: 0,
  exportOnlyFiltered: false,
  processing: false,
};

/**
 * Estado da nuvem compartilhada: configuração do banco (URL + chave anônima) e
 * a identidade deste navegador (chave de acesso + slot cifrado).
 */
const cloud = {
  config: loadCloudConfig(),
  identity: loadIdentity(),
  busy: false,
  statusTone: 'idle',
  /** Resultado da checagem automática do banco: null | 'checking' | 'ok' | string (erro). */
  ping: null,
};

/** Banco embutido no app (URL + chave anônima públicas): não há o que configurar. */
const BUILT_IN_CLOUD = normalizeSupabaseConfig(DEFAULT_CLOUD_CONFIG);

/* -------------------------------------------------------------------------- */
/*                                    DOM                                     */
/* -------------------------------------------------------------------------- */

const dom = {};

function cacheDom() {
  for (const id of REQUIRED_ELEMENT_IDS) {
    const element = document.getElementById(id);
    if (!element) {
      console.warn(`[Conversor] Elemento #${id} não encontrado no HTML.`);
    }
    dom[id] = element;
  }
}

/* -------------------------------------------------------------------------- */
/*                              Utilitários de UI                             */
/* -------------------------------------------------------------------------- */

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const MAX_TOASTS = 4;

function showToast(message, type = 'success', { duration = 4500 } = {}) {
  const container = dom['toast-container'];
  if (!container) return;

  while (container.children.length >= MAX_TOASTS) container.firstElementChild?.remove();

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
  if (duration > 0) {
    setTimeout(() => toast.remove(), duration);
  }
}

function setProcessing(active, message = '') {
  state.processing = active;
  const banner = dom['processing-banner'];
  const text = dom['processing-text'];
  if (banner) banner.classList.toggle('hidden', !active);
  if (text && message) text.textContent = message;
  if (dom.dropzone) {
    dom.dropzone.classList.toggle('is-disabled', active);
    dom.dropzone.setAttribute('aria-busy', String(active));
  }
  document.querySelector('main')?.setAttribute('aria-busy', String(active));
}

function debounce(fn, wait) {
  let timer = null;
  const debounced = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
  debounced.flush = (...args) => {
    if (timer) clearTimeout(timer);
    timer = null;
    fn(...args);
  };
  return debounced;
}

function suggestLayoutName(parsedFile) {
  const base = String(parsedFile.fileName || '')
    .replace(/\.(pdf|xlsx)$/i, '')
    .replace(/[_-]+/g, ' ');
  return cleanWhitespace(base).slice(0, 48) || 'Novo layout';
}

function updateAiBadge() {
  const badge = dom['ai-profiles-badge'];
  if (!badge) return;
  const count = state.memory.learnedProfiles.length;
  badge.textContent = `${count} ${count === 1 ? 'perfil' : 'perfis'}`;
  badge.title = `${count} layout(s) memorizado(s) neste navegador`;
}

function syncRulesToAnalysis(file) {
  if (!file) return;
  file.analysis.rules = {
    ...file.analysis.rules,
    defaultSign: dom['rule-default-sign'].value,
    removePipes: dom['rule-remove-pipes'].checked,
    collapseSpaces: dom['rule-collapse-spaces'].checked,
    customReplaceFrom: dom['rule-replace-from'].value,
    customReplaceTo: dom['rule-replace-to'].value,
  };
}

/* -------------------------------------------------------------------------- */
/*                          Consolidação e filtros                            */
/* -------------------------------------------------------------------------- */

function rebuildUnifiedOutput({ resetPage = true } = {}) {
  const allRecords = [];
  let skippedCount = 0;

  for (const file of state.files) {
    const result = transformRowsWithConfig(file.parsedFile, file.analysis);
    file.result = result;
    allRecords.push(...result.records);
    skippedCount += result.skipped.length;
  }

  // Reaplica o que o usuário editou/excluiu à mão — a chave é a origem
  // (arquivo + linha), então as edições sobrevivem a remapear/treinar a IA.
  const { rows: keptRecords, removed } = applyRowEdits(allRecords, {
    historyOverrides: state.historyOverrides,
    removedKeys: state.removedKeys,
  });
  state.removedCount = removed;

  // Ordenação cronológica crescente e estável (por arquivo/linha de origem).
  keptRecords.sort(
    (a, b) =>
      a.dateIso.localeCompare(b.dateIso) ||
      a.sourceFile.localeCompare(b.sourceFile) ||
      (a.sourceRow || 0) - (b.sourceRow || 0)
  );

  state.unifiedRows = keptRecords;
  state.summary = summarizeRecords(keptRecords, { skippedCount });

  // Seleção só faz sentido para linhas que ainda existem.
  const alive = new Set(keptRecords.map((record) => recordKey(record)));
  for (const key of [...state.selected]) {
    if (!alive.has(key)) state.selected.delete(key);
  }

  applyFilters({ resetPage });
  renderFilesList();
  renderOutputSection();
}

function applyFilters({ resetPage = false } = {}) {
  const term = normalizeText(state.searchTerm);

  state.filteredRows = state.unifiedRows.filter((row) => {
    if (state.typeFilter === 'in' && row.value < 0) return false;
    if (state.typeFilter === 'out' && row.value >= 0) return false;
    if (!term) return true;
    const haystack = normalizeText(`${row.dateBr} ${row.history} ${row.sourceFile}`);
    return haystack.includes(term);
  });

  if (resetPage) state.currentPage = 1;
}

function visibleExportRows() {
  return state.exportOnlyFiltered ? state.filteredRows : state.unifiedRows;
}

/* -------------------------------------------------------------------------- */
/*                              Lista de arquivos                             */
/* -------------------------------------------------------------------------- */

function analysisStatusPill(analysis) {
  if (analysis.status === 'matched') {
    return `<span class="ai-status-pill status-matched" title="Layout reconhecido na memória da IA">IA reconheceu: ${escapeHtml(
      analysis.matchedProfileName || 'perfil salvo'
    )} (${analysis.matchSimilarity}%)</span>`;
  }
  if (analysis.status === 'evolved') {
    return `<span class="ai-status-pill status-evolved" title="Mudança estrutural em relação ao perfil memorizado">Mudança de layout (${analysis.matchSimilarity}% similar)</span>`;
  }
  return `<span class="ai-status-pill status-new" title="Layout inédito inferido pela IA semântica">Novo layout inferido (${analysis.avgConfidence}% confiança)</span>`;
}

function renderFilesList() {
  const list = dom['files-list'];
  const clearButton = dom['btn-clear-files'];
  if (!list) return;

  if (state.files.length === 0) {
    list.classList.add('hidden');
    list.innerHTML = '';
    clearButton?.classList.add('hidden');
    return;
  }

  list.classList.remove('hidden');
  clearButton?.classList.remove('hidden');
  list.innerHTML = '';

  const fragment = document.createDocumentFragment();

  for (const file of state.files) {
    const records = file.result?.records ?? [];
    const subtotal = sumValues(records.map((record) => record.value));
    const subtotalColor = subtotal >= 0 ? 'var(--emerald)' : 'var(--crimson)';
    const isPdf = file.parsedFile.fileType === 'pdf';

    let sheetSelector = '';
    if (!isPdf && (file.parsedFile.availableSheets?.length ?? 0) > 1) {
      const options = file.parsedFile.availableSheets
        .map(
          (sheet) =>
            `<option value="${escapeHtml(sheet.name)}" ${
              sheet.name === file.parsedFile.sheetName ? 'selected' : ''
            }>Aba: ${escapeHtml(sheet.name)} (${sheet.rowCount})</option>`
        )
        .join('');
      sheetSelector = `<select class="sheet-select" data-file-id="${file.id}" aria-label="Aba da planilha ${escapeHtml(
        file.parsedFile.fileName
      )}">${options}</select>`;
    }

    const originLabel = isPdf
      ? `${file.parsedFile.pageCount} página(s)`
      : `Aba "${escapeHtml(file.parsedFile.sheetName)}"`;

    const warningChip =
      (file.analysis.warnings?.length ?? 0) > 0
        ? `<span class="warn-chip" title="${escapeHtml(
            file.analysis.warnings.join(' • ')
          )}">⚠ ${file.analysis.warnings.length} aviso(s)</span>`
        : '';

    const card = document.createElement('article');
    card.className = `file-card${file.id === state.selectedFileId ? ' active-editing' : ''}`;
    card.dataset.fileId = file.id;
    card.innerHTML = `
      <div class="file-card-top">
        <div class="file-name-wrap">
          <span class="ext-badge ${isPdf ? 'ext-pdf' : 'ext-xlsx'}">${file.parsedFile.fileType}</span>
          <span class="file-name" title="${escapeHtml(file.parsedFile.fileName)}">${escapeHtml(
            file.parsedFile.fileName
          )}</span>
        </div>
        <button class="icon-btn btn-remove-file" data-file-id="${file.id}" title="Remover arquivo" aria-label="Remover ${escapeHtml(
          file.parsedFile.fileName
        )}" type="button">✕</button>
      </div>
      ${analysisStatusPill(file.analysis)}
      <div class="file-meta">
        <span>${originLabel}</span>
        <span aria-hidden="true">•</span>
        <span><strong>${records.length}</strong> lançamento(s)</span>
        <span aria-hidden="true">•</span>
        <span style="color:${subtotalColor}; font-weight:700;">${formatValuePlainBr(subtotal)}</span>
        ${warningChip}
      </div>
      <div class="file-card-actions">
        ${
          sheetSelector ||
          `<span class="file-columns-count">${file.parsedFile.headers.length} coluna(s) detectada(s)</span>`
        }
        <button class="btn btn-sm btn-secondary btn-edit-layout" data-file-id="${file.id}" type="button">
          Ajustar / Treinar IA
        </button>
      </div>
    `;
    fragment.appendChild(card);
  }

  list.appendChild(fragment);
}

/* -------------------------------------------------------------------------- */
/*                              Painel de treino                              */
/* -------------------------------------------------------------------------- */

function findFile(fileId) {
  return state.files.find((file) => file.id === fileId) || null;
}

function renderTrainerAlert(file) {
  const alert = dom['trainer-alert'];
  const warningsBox = dom['trainer-warnings'];
  if (!alert) return;

  const analysis = file.analysis;
  alert.classList.remove('hidden', 'matched', 'evolved', 'new');

  if (analysis.status === 'evolved') {
    alert.classList.add('evolved');
    const diffs = analysis.changesDetected.length
      ? `Alterações: ${analysis.changesDetected.join(' • ')}.`
      : 'Algumas colunas mudaram em relação ao modelo anterior.';
    alert.innerHTML = `<strong>Layout evoluído detectado!</strong> Similar a <em>"${escapeHtml(
      analysis.matchedProfileName || ''
    )}"</em> (${analysis.matchSimilarity}%). ${escapeHtml(
      diffs
    )} Revise o mapeamento e clique em <strong>Treinar IA e Aplicar Layout</strong>.`;
  } else if (analysis.status === 'matched') {
    alert.classList.add('matched');
    alert.innerHTML = `<strong>Layout reconhecido na memória da IA!</strong> Perfil <em>"${escapeHtml(
      analysis.matchedProfileName || ''
    )}"</em> aplicado automaticamente com ${analysis.matchSimilarity}% de similaridade.`;
  } else {
    alert.classList.add('new');
    alert.innerHTML = `<strong>Novo layout analisado pela IA semântica</strong> (${analysis.avgConfidence}% de confiança média). Confirme ou ajuste as colunas abaixo e clique em <strong>Treinar IA e Aplicar Layout</strong> para que a IA memorize este padrão.`;
  }

  if (warningsBox) {
    const warnings = analysis.warnings || [];
    warningsBox.classList.toggle('hidden', warnings.length === 0);
    warningsBox.innerHTML = warnings
      .map((warning) => `<li>${escapeHtml(warning)}</li>`)
      .join('');
  }
}

function openTrainerForFile(fileId) {
  const file = findFile(fileId);
  const section = dom['ai-trainer-section'];

  if (!file || !section) {
    section?.classList.add('hidden');
    return;
  }

  state.selectedFileId = fileId;
  section.classList.remove('hidden');

  if (dom['trainer-title']) {
    dom['trainer-title'].textContent = `Mapeamento Inteligente: ${file.parsedFile.fileName}`;
  }

  const hasLlm = state.memory.optionalLlm?.provider !== 'none' && !!state.memory.optionalLlm?.apiKey;
  dom['btn-llm-analyze']?.classList.toggle('hidden', !hasLlm);

  renderTrainerAlert(file);

  dom['layout-name-input'].value =
    file.analysis.matchedProfileName || suggestLayoutName(file.parsedFile);
  dom['rule-default-sign'].value = file.analysis.rules.defaultSign || 'auto';
  dom['rule-remove-pipes'].checked = file.analysis.rules.removePipes !== false;
  dom['rule-collapse-spaces'].checked = file.analysis.rules.collapseSpaces !== false;
  dom['rule-replace-from'].value = file.analysis.rules.customReplaceFrom || '';
  dom['rule-replace-to'].value = file.analysis.rules.customReplaceTo || '';

  renderMappingRows(file);
  renderFilesList();
}

function renderMappingRows(file) {
  const tbody = dom['mapping-tbody'];
  if (!tbody) return;

  tbody.innerHTML = '';
  const fragment = document.createDocumentFragment();

  for (const mapping of file.analysis.mappings) {
    const row = document.createElement('tr');

    const confidenceClass =
      mapping.confidence >= 85 ? 'conf-high' : mapping.confidence >= 65 ? 'conf-mid' : 'conf-low';
    const sourceLabel = mapping.source === 'learned_profile' ? 'Memória' : 'Semântica';
    const changeBadge =
      mapping.changeType === 'added'
        ? '<span class="tag-change">NOVA</span>'
        : mapping.changeType === 'renamed'
          ? '<span class="tag-change">RENOMEADA</span>'
          : '';

    const samples = (mapping.stats.samples || [])
      .slice(0, 3)
      .map(
        (sample) =>
          `<span class="sample-chip" title="${escapeHtml(sample)}">${escapeHtml(sample)}</span>`
      )
      .join('');

    const roleOptions = Object.entries(ROLE_LABELS)
      .map(
        ([value, label]) =>
          `<option value="${value}" ${mapping.role === value ? 'selected' : ''}>${escapeHtml(
            label
          )}</option>`
      )
      .join('');

    const isHistory = mapping.role === ROLES.HISTORY;

    row.innerHTML = `
      <td>
        <strong>${escapeHtml(mapping.header)}</strong>${changeBadge}
        ${mapping.reason ? `<div class="mapping-reason">${escapeHtml(mapping.reason)}</div>` : ''}
      </td>
      <td>
        <div class="sample-chips">${samples || '<span class="sample-chip">(vazio)</span>'}</div>
      </td>
      <td>
        <span class="conf-pill ${confidenceClass}" title="Origem: ${sourceLabel}">${mapping.confidence}% • ${sourceLabel}</span>
      </td>
      <td>
        <select class="role-select" data-col-idx="${mapping.colIdx}" aria-label="Função da coluna ${escapeHtml(
          mapping.header
        )}">${roleOptions}</select>
      </td>
      <td>
        ${
          isHistory
            ? `<div class="order-btns">
                 <button class="order-btn btn-move-up" data-col-idx="${mapping.colIdx}" type="button" title="Mover para cima no histórico" aria-label="Mover ${escapeHtml(
                   mapping.header
                 )} para cima no histórico">▲</button>
                 <span>#${mapping.historyOrder}</span>
                 <button class="order-btn btn-move-down" data-col-idx="${mapping.colIdx}" type="button" title="Mover para baixo no histórico" aria-label="Mover ${escapeHtml(
                   mapping.header
                 )} para baixo no histórico">▼</button>
               </div>`
            : '<span class="muted-dash">—</span>'
        }
      </td>
    `;

    fragment.appendChild(row);
  }

  tbody.appendChild(fragment);
}

/* -------------------------------------------------------------------------- */
/*                          Resultado e paginação                             */
/* -------------------------------------------------------------------------- */

/** Quantas linhas cabem na página (a planilha inteira quando `'all'`). */
function rowsPerPage() {
  return state.pageSize === 'all' ? Infinity : Number(state.pageSize) || DEFAULT_PAGE_SIZE;
}

/** Mantém seleção, botões de ação e o "selecionar tudo" coerentes. */
function renderPreviewSelection() {
  const ids = state.filteredRows.map((record) => recordKey(record));
  const selectedHere = ids.filter((key) => state.selected.has(key)).length;
  const total = state.selected.size;

  const selectAll = dom['preview-select-all'];
  if (selectAll) {
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

  const del = dom['btn-delete-selected'];
  if (del) {
    del.disabled = total === 0;
    del.textContent = total ? `Excluir selecionados (${total})` : 'Excluir selecionados';
  }

  const restore = dom['btn-restore-deleted'];
  if (restore) {
    restore.disabled = state.removedCount === 0;
    restore.textContent = state.removedCount
      ? `Restaurar excluídas (${state.removedCount})`
      : 'Restaurar excluídas';
  }

  const clear = dom['btn-clear-preview-selection'];
  if (clear) {
    clear.disabled = total === 0;
    clear.textContent = total ? `Limpar seleção (${total})` : 'Limpar seleção';
  }
}

/** Exclui da planilha os lançamentos marcados (dá para restaurar depois). */
function deleteSelectedRows() {
  const keys = [...state.selected];
  if (keys.length === 0) return;

  for (const key of keys) state.removedKeys.add(key);
  state.selected.clear();
  rebuildUnifiedOutput({ resetPage: false });

  showToast(
    `${keys.length} lançamento(s) excluído(s) da planilha — use “Restaurar excluídas” para voltar.`,
    'success'
  );
}

/** Exclui um único lançamento (botão ✕ da linha). */
function deleteRow(key) {
  if (!key) return;
  state.removedKeys.add(key);
  state.selected.delete(key);
  rebuildUnifiedOutput({ resetPage: false });
  showToast('Lançamento excluído — use “Restaurar excluídas” para voltar.');
}

/** Devolve à planilha tudo o que foi excluído. */
function restoreDeletedRows() {
  if (state.removedKeys.size === 0) return;
  const count = state.removedKeys.size;
  state.removedKeys.clear();
  rebuildUnifiedOutput({ resetPage: false });
  showToast(`${count} lançamento(s) restaurado(s) na planilha.`);
}

/** Grava o histórico digitado na linha, sem sair do lugar. */
function commitHistoryEdit(input) {
  const key = input?.dataset?.previewHistory;
  if (!key) return;

  const record = state.unifiedRows.find((item) => recordKey(item) === key);
  if (!record) return;

  if (input.dataset.previewCancelled) {
    delete input.dataset.previewCancelled;
    input.value = record.history;
    return;
  }

  const changed = setHistoryOverride(state, record, input.value);
  applyFilters();
  renderOutputSection();

  if (changed) showToast('Histórico atualizado — o novo texto vale para as exportações.');
  else if (input.value.trim() === '') showToast('Edição desfeita: voltou o histórico do arquivo.', 'warn');
}

function renderOutputSection() {
  const section = dom['output-section'];
  if (!section) return;

  if (state.files.length === 0) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');
  const summary = state.summary;

  dom['kpi-count'].textContent = summary.count.toLocaleString('pt-BR');
  dom['kpi-period'].textContent = summary.minDateBr
    ? summary.minDateBr === summary.maxDateBr
      ? summary.minDateBr
      : `${summary.minDateBr} a ${summary.maxDateBr}`
    : 'Sem datas';

  dom['kpi-in'].textContent = formatValueGroupedBr(summary.totalIn);
  dom['kpi-in-count'].textContent = `${summary.inCount} recebimento(s)`;
  dom['kpi-out'].textContent = formatValueGroupedBr(summary.totalOutAbs);
  dom['kpi-out-count'].textContent = `${summary.outCount} pagamento(s)`;
  dom['kpi-net'].textContent = formatValueGroupedBr(summary.netTotal);
  dom['kpi-net'].style.color = summary.netTotal >= 0 ? 'var(--emerald)' : 'var(--crimson)';
  dom['kpi-skipped'].textContent = `${summary.skippedCount} linha(s) ignorada(s)`;

  const total = state.filteredRows.length;
  const perPage = rowsPerPage();
  const maxPage = Math.max(1, Math.ceil(total / perPage));
  if (state.currentPage > maxPage) state.currentPage = maxPage;

  const startIndex = Number.isFinite(perPage) ? (state.currentPage - 1) * perPage : 0;
  const pageRows =
    state.filteredRows.length === 0
      ? []
      : Number.isFinite(perPage)
        ? state.filteredRows.slice(startIndex, startIndex + perPage)
        : state.filteredRows.slice();
  const endIndex = startIndex + pageRows.length;

  const tbody = dom['preview-tbody'];
  tbody.innerHTML = '';

  if (pageRows.length === 0) {
    const row = document.createElement('tr');
    row.innerHTML = `<td colspan="5" class="empty-row">${
      state.unifiedRows.length === 0
        ? 'Nenhum lançamento válido foi extraído dos arquivos importados.'
        : 'Nenhum lançamento encontrado com o filtro atual.'
    }</td>`;
    tbody.appendChild(row);
  } else {
    const fragment = document.createDocumentFragment();
    for (const record of pageRows) {
      const row = document.createElement('tr');
      const valueClass = record.value < 0 ? 'val-neg' : 'val-pos';
      const key = recordKey(record);
      row.dataset.previewRow = key;
      row.innerHTML = `
        <td class="col-select">
          <input
            type="checkbox"
            data-preview-select="${escapeHtml(key)}"
            aria-label="Selecionar o lançamento de ${escapeHtml(record.dateBr)}"
            ${state.selected.has(key) ? 'checked' : ''}
          />
        </td>
        <td class="col-date">${escapeHtml(record.dateBr)}</td>
        <td class="col-val ${valueClass}">${escapeHtml(formatValuePlainBr(record.value))}</td>
        <td class="col-hist" title="Origem: ${escapeHtml(record.sourceFile)}">
          <input
            class="preview-history-input"
            type="text"
            data-preview-history="${escapeHtml(key)}"
            value="${escapeHtml(record.history)}"
            aria-label="Histórico do lançamento de ${escapeHtml(record.dateBr)}"
            title="Clique para editar o histórico"
          />
        </td>
        <td class="col-actions">
          <button
            class="row-delete-btn"
            type="button"
            data-preview-delete="${escapeHtml(key)}"
            aria-label="Excluir o lançamento de ${escapeHtml(record.dateBr)}"
            title="Excluir este lançamento"
          >✕</button>
        </td>
      `;
      fragment.appendChild(row);
    }
    tbody.appendChild(fragment);
  }

  dom['pagination-info'].textContent =
    total === 0
      ? '0 registro'
      : `Exibindo ${startIndex + 1}–${endIndex} de ${total.toLocaleString(
          'pt-BR'
        )} lançamento(s) • Página ${state.currentPage}/${maxPage}`;

  dom['btn-prev-page'].disabled = state.currentPage <= 1;
  dom['btn-next-page'].disabled = state.currentPage >= maxPage;

  renderPreviewSelection();

  const hasRows = state.unifiedRows.length > 0;
  dom['btn-export-xlsx'].disabled = !hasRows;
  dom['btn-export-pdf'].disabled = !hasRows;
  if (dom['export-only-filtered']) {
    dom['export-only-filtered'].disabled = !hasRows;
    dom['export-only-filtered'].checked = state.exportOnlyFiltered;
  }
}

/* -------------------------------------------------------------------------- */
/*                              Importação (upload)                           */
/* -------------------------------------------------------------------------- */

function fileExtension(name) {
  return String(name).split('.').pop()?.toLowerCase() ?? '';
}

function isDuplicate(candidate) {
  return state.files.some(
    (file) =>
      file.parsedFile.fileName === candidate.name && (file.meta?.size ?? 0) === candidate.size
  );
}

async function parseUploadedFile(file) {
  const extension = fileExtension(file.name);
  const buffer = await file.arrayBuffer();

  if (extension === 'pdf') {
    return parsePdfFile(buffer, file.name, pdfjsLib, {
      onProgress: (page, total) => {
        const text = dom['processing-text'];
        if (text) text.textContent = `Lendo ${file.name} — página ${page} de ${total}…`;
      },
    });
  }

  const ExcelJSRef = typeof window !== 'undefined' ? window.ExcelJS : undefined;
  if (!ExcelJSRef) throw new Error('Biblioteca ExcelJS não carregada.');
  return parseXlsxFile(buffer, file.name, ExcelJSRef);
}

async function processUploadedFiles(fileList) {
  const incoming = [...(fileList || [])];
  if (incoming.length === 0 || state.processing) return;

  setProcessing(true, 'Lendo arquivos…');

  const failures = [];
  let added = 0;
  let duplicates = 0;
  let firstNeedingReview = null;

  try {
    for (const file of incoming) {
      const extension = fileExtension(file.name);

      if (!SUPPORTED_EXTENSIONS.includes(extension)) {
        failures.push(`${file.name}: formato não suportado (use .pdf ou .xlsx).`);
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        failures.push(
          `${file.name}: arquivo maior que ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB.`
        );
        continue;
      }
      if (isDuplicate(file)) {
        duplicates++;
        continue;
      }

      const text = dom['processing-text'];
      if (text) text.textContent = `Processando ${file.name}…`;

      try {
        const parsedFile = await parseUploadedFile(file);
        const analysis = analyzeFileLayout(parsedFile, state.memory);

        state.memory.stats.totalFilesProcessed =
          (state.memory.stats.totalFilesProcessed || 0) + 1;
        if (analysis.status === 'matched') {
          state.memory.stats.autoMatchedCount =
            (state.memory.stats.autoMatchedCount || 0) + 1;
        }

        const id = `file-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        state.files.push({
          id,
          parsedFile,
          analysis,
          result: { records: [], skipped: [] },
          meta: { size: file.size, uploadedAt: new Date().toISOString() },
        });
        added++;

        if (!firstNeedingReview && analysis.status !== 'matched') {
          firstNeedingReview = id;
        }
      } catch (error) {
        console.error(error);
        failures.push(`${file.name}: ${error.message}`);
      }
    }

    if (added > 0) {
      if (!saveAiMemory(state.memory)) {
        showToast(
          'O navegador bloqueou o salvamento da memória da IA (modo privado ou armazenamento cheio) — o treino vale só nesta sessão.',
          'warn',
          { duration: 9000 }
        );
      }
      scheduleCloudPush();
    }
    updateAiBadge();
    rebuildUnifiedOutput();

    if (firstNeedingReview) {
      openTrainerForFile(firstNeedingReview);
      showToast('Novo layout ou alteração detectada. Confira o painel da IA.', 'warn');
    } else if (added > 0 && !state.selectedFileId) {
      openTrainerForFile(state.files[0].id);
    }

    if (added > 0) {
      showToast(
        `${added} arquivo(s) processado(s) com sucesso${duplicates ? ` • ${duplicates} duplicado(s) ignorado(s)` : ''}.`
      );
    }
    for (const failure of failures.slice(0, 3)) showToast(failure, 'error');
    if (failures.length > 3) {
      showToast(`Mais ${failures.length - 3} arquivo(s) falharam ao ser lidos.`, 'error');
    }
    if (added === 0 && failures.length === 0 && duplicates > 0) {
      showToast('Todos os arquivos enviados já estavam na lista.', 'warn');
    }
  } finally {
    setProcessing(false);
  }
}

/* -------------------------------------------------------------------------- */
/*                             Memória da IA (modal)                          */
/* -------------------------------------------------------------------------- */

let lastFocusedElement = null;

function renderAiModal() {
  const memory = state.memory;

  dom['mem-stat-profiles'].textContent = String(memory.learnedProfiles.length);
  dom['mem-stat-files'].textContent = String(memory.stats.totalFilesProcessed || 0);
  dom['mem-stat-corr'].textContent = String(memory.stats.correctionsLearned || 0);
  dom['mem-stat-tokens'].textContent = String(Object.keys(memory.tokenWeights).length);

  if (memory.learnedProfiles.length === 0) {
    dom['mtab-profiles'].innerHTML = `<p class="empty-hint">Nenhum layout foi treinado ainda. Importe um arquivo e clique em <strong>Treinar IA e Aplicar Layout</strong> para começar.</p>`;
  } else {
    dom['mtab-profiles'].innerHTML = memory.learnedProfiles
      .map((profile) => {
        const columns = profile.mappings
          .map(
            (mapping) =>
              `<span class="col-tag"><strong>${escapeHtml(mapping.header)}</strong> → ${escapeHtml(
                ROLE_LABELS[mapping.role] || mapping.role
              )}</span>`
          )
          .join('');
        return `
          <div class="profile-item">
            <div class="profile-item-head">
              <div class="profile-title">
                <strong>${escapeHtml(profile.name)}</strong>
                <span class="ext-badge ${profile.fileType === 'pdf' ? 'ext-pdf' : 'ext-xlsx'}">${escapeHtml(
                  profile.fileType
                )}</span>
              </div>
              <div class="profile-actions">
                <span class="profile-usage" title="Última utilização">${escapeHtml(
                  formatLocalDateTime(profile.lastUsedAt)
                )}</span>
                <span class="profile-usage">${profile.usageCount || 1} uso(s)</span>
                <button class="btn btn-sm btn-danger-outline btn-del-profile" data-prof-id="${escapeHtml(
                  profile.id
                )}" type="button">Excluir</button>
              </div>
            </div>
            <div class="profile-cols">${columns}</div>
          </div>
        `;
      })
      .join('');
  }

  dom['mtab-logs'].innerHTML = memory.learningLog
    .map(
      (entry) => `
        <div class="log-item">
          <div class="log-head">
            <strong>${escapeHtml(entry.message)}</strong>
            <span>${escapeHtml(formatLocalDateTime(entry.timestamp))}</span>
          </div>
          <div class="log-detail">${escapeHtml(entry.details)}</div>
        </div>
      `
    )
    .join('');

  dom['llm-provider'].value = memory.optionalLlm?.provider || 'none';
  dom['llm-apikey'].value = memory.optionalLlm?.apiKey || '';
}

function openAiModal() {
  renderAiModal();
  lastFocusedElement = document.activeElement;
  dom['ai-modal'].classList.remove('hidden');
  dom['ai-modal'].setAttribute('aria-hidden', 'false');
  dom['btn-close-modal']?.focus();
}

function closeAiModal() {
  dom['ai-modal'].classList.add('hidden');
  dom['ai-modal'].setAttribute('aria-hidden', 'true');
  if (lastFocusedElement instanceof HTMLElement) lastFocusedElement.focus();
}

function activateModalTab(tabName) {
  document.querySelectorAll('.mtab').forEach((button) => {
    const isActive = button.dataset.mtab === tabName;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-selected', String(isActive));
    button.tabIndex = isActive ? 0 : -1;
  });
  dom['mtab-profiles'].classList.toggle('hidden', tabName !== 'profiles');
  dom['mtab-logs'].classList.toggle('hidden', tabName !== 'logs');
  dom['mtab-settings'].classList.toggle('hidden', tabName !== 'settings');
  dom['mtab-cloud']?.classList.toggle('hidden', tabName !== 'cloud');
  if (tabName === 'cloud') renderCloudPanel();
}

/* -------------------------------------------------------------------------- */
/*                                  Eventos                                   */
/* -------------------------------------------------------------------------- */

function bindUploadEvents() {
  const dropzone = dom.dropzone;
  const fileInput = dom['file-input'];
  if (!dropzone || !fileInput) return;

  const openPicker = () => {
    if (!state.processing) fileInput.click();
  };

  dropzone.addEventListener('click', (event) => {
    // O input de arquivo é filho do dropzone: evita reabrir o seletor em laço.
    if (event.target === fileInput) return;
    openPicker();
  });
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openPicker();
    }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files?.length) {
      processUploadedFiles(fileInput.files);
      fileInput.value = '';
    }
  });

  const hasFiles = (event) =>
    Array.from(event.dataTransfer?.types || []).includes('Files');

  window.addEventListener('dragover', (event) => {
    if (!hasFiles(event) || state.processing) return;
    event.preventDefault();
    dropzone.classList.add('dragover');
  });

  window.addEventListener('dragleave', (event) => {
    if (event.relatedTarget) return;
    dropzone.classList.remove('dragover');
  });

  window.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dropzone.classList.remove('dragover');
    if (!state.processing && event.dataTransfer?.files?.length) {
      processUploadedFiles(event.dataTransfer.files);
    }
  });
}

function bindFilesListEvents() {
  const list = dom['files-list'];
  if (!list) return;

  list.addEventListener('click', (event) => {
    const editButton = event.target.closest('.btn-edit-layout');
    if (editButton) {
      openTrainerForFile(editButton.dataset.fileId);
      return;
    }

    const removeButton = event.target.closest('.btn-remove-file');
    if (removeButton) {
      const id = removeButton.dataset.fileId;
      const removed = findFile(id);
      state.files = state.files.filter((file) => file.id !== id);
      if (state.selectedFileId === id) {
        state.selectedFileId = state.files[0]?.id ?? null;
        if (state.selectedFileId) openTrainerForFile(state.selectedFileId);
        else dom['ai-trainer-section']?.classList.add('hidden');
      }
      rebuildUnifiedOutput();
      showToast(`"${removed?.parsedFile.fileName ?? 'Arquivo'}" removido da conciliação.`, 'warn');
    }
  });

  list.addEventListener('change', (event) => {
    const select = event.target.closest('.sheet-select');
    if (!select) return;

    const file = findFile(select.dataset.fileId);
    const sheet = file?.parsedFile?.allSheetsData?.find((item) => item.sheetName === select.value);
    if (!file || !sheet) return;

    file.parsedFile.sheetName = sheet.sheetName;
    file.parsedFile.headers = sheet.headers;
    file.parsedFile.rows = sheet.rows;
    file.parsedFile.bannerLines = sheet.bannerLines;
    file.analysis = analyzeFileLayout(file.parsedFile, state.memory);

    rebuildUnifiedOutput();
    if (state.selectedFileId === file.id) openTrainerForFile(file.id);
    showToast(`Aba "${sheet.sheetName}" aplicada a ${file.parsedFile.fileName}.`);
  });
}

function bindTrainerEvents() {
  const tbody = dom['mapping-tbody'];

  tbody?.addEventListener('change', (event) => {
    const select = event.target.closest('.role-select');
    if (!select) return;

    const file = findFile(state.selectedFileId);
    if (!file) return;

    const columnIndex = Number(select.dataset.colIdx);
    const mapping = file.analysis.mappings.find((item) => item.colIdx === columnIndex);
    if (!mapping) return;

    mapping.role = select.value;
    mapping.source = 'manual';
    mapping.reason = 'Ajustado manualmente';

    // Reordena apenas as colunas de histórico (1..n).
    let order = 1;
    for (const item of file.analysis.mappings) {
      item.historyOrder = item.role === ROLES.HISTORY ? order++ : 0;
    }

    renderMappingRows(file);
    rebuildUnifiedOutput();
  });

  tbody?.addEventListener('click', (event) => {
    const upButton = event.target.closest('.btn-move-up');
    const downButton = event.target.closest('.btn-move-down');
    if (!upButton && !downButton) return;

    const file = findFile(state.selectedFileId);
    if (!file) return;

    const columnIndex = Number((upButton || downButton).dataset.colIdx);
    const historyMappings = file.analysis.mappings
      .filter((mapping) => mapping.role === ROLES.HISTORY)
      .sort((a, b) => a.historyOrder - b.historyOrder);

    const position = historyMappings.findIndex((mapping) => mapping.colIdx === columnIndex);
    if (position === -1) return;

    const targetPosition = upButton ? position - 1 : position + 1;
    if (targetPosition < 0 || targetPosition >= historyMappings.length) return;

    const current = historyMappings[position];
    const target = historyMappings[targetPosition];
    [current.historyOrder, target.historyOrder] = [target.historyOrder, current.historyOrder];

    renderMappingRows(file);
    rebuildUnifiedOutput();
  });

  const ruleInputs = [
    dom['rule-default-sign'],
    dom['rule-remove-pipes'],
    dom['rule-collapse-spaces'],
    dom['rule-replace-from'],
    dom['rule-replace-to'],
  ].filter(Boolean);

  const applyRules = () => {
    const file = findFile(state.selectedFileId);
    if (!file) return;
    syncRulesToAnalysis(file);
    rebuildUnifiedOutput();
  };

  for (const input of ruleInputs) {
    input.addEventListener('change', applyRules);
  }
  // Texto livre: atualiza sem exigir blur, mas com debounce.
  const debouncedApply = debounce(applyRules, 250);
  dom['rule-replace-from']?.addEventListener('input', debouncedApply);
  dom['rule-replace-to']?.addEventListener('input', debouncedApply);

  dom['btn-train-apply']?.addEventListener('click', () => {
    const file = findFile(state.selectedFileId);
    if (!file) return;

    syncRulesToAnalysis(file);
    const name = cleanWhitespace(dom['layout-name-input'].value);
    state.memory = trainAiWithLayout(file.parsedFile, file.analysis, name, state.memory);

    updateAiBadge();
    rebuildUnifiedOutput();
    openTrainerForFile(file.id);

    const saved = saveAiMemory(state.memory);
    showToast(
      saved
        ? `IA treinada! Layout "${name || file.analysis.matchedProfileName}" memorizado.`
        : 'Layout aplicado, mas o navegador bloqueou o salvamento da memória.',
      saved ? 'success' : 'warn'
    );
    // Com a nuvem conectada, o novo modelo sobe sozinho.
    if (saved) scheduleCloudPush();
  });

  dom['btn-close-trainer']?.addEventListener('click', () => {
    dom['ai-trainer-section'].classList.add('hidden');
    state.selectedFileId = null;
    renderFilesList();
  });

  dom['btn-llm-analyze']?.addEventListener('click', async () => {
    const file = findFile(state.selectedFileId);
    const button = dom['btn-llm-analyze'];
    if (!file || !button) return;

    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = 'Analisando…';

    try {
      const result = await analyzeWithOptionalLlm(file.parsedFile, state.memory.optionalLlm);

      if (result.layoutName) dom['layout-name-input'].value = result.layoutName;
      if (result.defaultSign) {
        file.analysis.rules.defaultSign = result.defaultSign;
        file.analysis.defaultSign = result.defaultSign;
        dom['rule-default-sign'].value = result.defaultSign;
      }

      result.roles.forEach((role, index) => {
        const mapping = file.analysis.mappings[index];
        if (mapping && Object.values(ROLES).includes(role)) {
          mapping.role = role;
          mapping.source = 'llm';
          mapping.reason = 'Sugerido pelo LLM';
        }
      });

      let order = 1;
      for (const mapping of file.analysis.mappings) {
        mapping.historyOrder = mapping.role === ROLES.HISTORY ? order++ : 0;
      }

      openTrainerForFile(file.id);
      rebuildUnifiedOutput();
      showToast('Mapeamento sugerido pelo LLM aplicado. Revise antes de treinar.', 'warn');
    } catch (error) {
      showToast(error.message || 'Falha ao consultar o LLM.', 'error');
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  });
}

function bindOutputEvents() {
  const searchInput = dom['search-input'];
  if (searchInput) {
    const applySearch = () => {
      state.searchTerm = searchInput.value;
      applyFilters({ resetPage: true });
      renderOutputSection();
    };
    const debouncedSearch = debounce(applySearch, SEARCH_DEBOUNCE_MS);

    searchInput.addEventListener('input', debouncedSearch);
    searchInput.addEventListener('search', () => debouncedSearch.flush());
    searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') debouncedSearch.flush();
    });
  }

  document.querySelectorAll('.pill[data-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.pill[data-filter]').forEach((other) => {
        other.classList.remove('active');
        other.setAttribute('aria-pressed', 'false');
      });
      button.classList.add('active');
      button.setAttribute('aria-pressed', 'true');
      state.typeFilter = button.dataset.filter;
      applyFilters({ resetPage: true });
      renderOutputSection();
    });
  });

  dom['preview-select-all']?.addEventListener('change', (event) => {
    const select = event.target.checked;
    for (const record of state.filteredRows) {
      const key = recordKey(record);
      if (select) state.selected.add(key);
      else state.selected.delete(key);
    }
    renderOutputSection();
  });

  dom['preview-tbody']?.addEventListener('change', (event) => {
    const checkbox = event.target.closest('[data-preview-select]');
    if (checkbox) {
      const key = checkbox.dataset.previewSelect;
      if (checkbox.checked) state.selected.add(key);
      else state.selected.delete(key);
      renderPreviewSelection();
      return;
    }

    const historyInput = event.target.closest('[data-preview-history]');
    if (historyInput) commitHistoryEdit(historyInput);
  });

  dom['preview-tbody']?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-preview-delete]');
    if (!button) return;
    deleteRow(button.dataset.previewDelete);
  });

  dom['preview-tbody']?.addEventListener('keydown', (event) => {
    const input = event.target.closest('[data-preview-history]');
    if (!input) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      input.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      input.dataset.previewCancelled = '1';
      input.blur();
    }
  });

  dom['btn-delete-selected']?.addEventListener('click', deleteSelectedRows);
  dom['btn-restore-deleted']?.addEventListener('click', restoreDeletedRows);
  dom['btn-clear-preview-selection']?.addEventListener('click', () => {
    state.selected.clear();
    renderOutputSection();
  });

  dom['preview-page-size']?.addEventListener('change', (event) => {
    const value = event.target.value;
    state.pageSize = value === 'all' ? 'all' : Number(value) || DEFAULT_PAGE_SIZE;
    state.currentPage = 1;
    renderOutputSection();
  });

  dom['btn-prev-page']?.addEventListener('click', () => {
    if (state.currentPage > 1) {
      state.currentPage--;
      renderOutputSection();
      dom['output-section']?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });

  dom['btn-next-page']?.addEventListener('click', () => {
    const maxPage = Math.max(1, Math.ceil(state.filteredRows.length / rowsPerPage()));
    if (state.currentPage < maxPage) {
      state.currentPage++;
      renderOutputSection();
      dom['output-section']?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });

  dom['export-only-filtered']?.addEventListener('change', (event) => {
    state.exportOnlyFiltered = event.target.checked;
  });

  dom['btn-export-xlsx']?.addEventListener('click', async () => {
    const rows = visibleExportRows();
    if (rows.length === 0) {
      showToast('Não há lançamentos para exportar.', 'warn');
      return;
    }
    const button = dom['btn-export-xlsx'];
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = 'Gerando…';

    try {
      const stamp = new Date().toISOString().slice(0, 10);
      await exportToXlsx(
        rows,
        `Conciliacao_${stamp}.xlsx`,
        typeof window !== 'undefined' ? window.ExcelJS : undefined
      );
      showToast(`${rows.length} lançamento(s) exportado(s) em .xlsx.`);
    } catch (error) {
      showToast(`Erro ao exportar .xlsx: ${error.message}`, 'error');
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  });

  dom['btn-export-pdf']?.addEventListener('click', () => {
    const rows = visibleExportRows();
    if (rows.length === 0) {
      showToast('Não há lançamentos para exportar.', 'warn');
      return;
    }

    try {
      const stamp = new Date().toISOString().slice(0, 10);
      const summary = state.exportOnlyFiltered
        ? summarizeRecords(rows, { skippedCount: state.summary.skippedCount })
        : state.summary;
      exportToPdf(rows, summary, `Conciliacao_${stamp}.pdf`);
      showToast(`${rows.length} lançamento(s) exportado(s) em .pdf.`);
    } catch (error) {
      showToast(`Erro ao exportar .pdf: ${error.message}`, 'error');
    }
  });

  dom['btn-clear-files']?.addEventListener('click', () => {
    if (state.files.length === 0) return;
    if (!window.confirm('Remover todos os arquivos e o resultado consolidado?')) return;

    state.files = [];
    state.selectedFileId = null;
    state.searchTerm = '';
    if (dom['search-input']) dom['search-input'].value = '';
    state.typeFilter = 'all';
    document.querySelectorAll('.pill[data-filter]').forEach((button) => {
      const isAll = button.dataset.filter === 'all';
      button.classList.toggle('active', isAll);
      button.setAttribute('aria-pressed', String(isAll));
    });
    dom['ai-trainer-section']?.classList.add('hidden');
    rebuildUnifiedOutput();
    showToast('Tudo limpo. Pronto para uma nova conciliação.');
  });
}

function bindModalEvents() {
  dom['btn-ai-memory']?.addEventListener('click', openAiModal);
  dom['btn-close-modal']?.addEventListener('click', closeAiModal);

  dom['ai-modal']?.addEventListener('click', (event) => {
    if (event.target === dom['ai-modal']) closeAiModal();
  });

  document.querySelectorAll('.mtab').forEach((button) => {
    button.addEventListener('click', () => activateModalTab(button.dataset.mtab));
  });

  // Navegação por teclado entre abas.
  document.querySelector('.modal-tabs')?.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const tabs = [...document.querySelectorAll('.mtab')];
    const currentIndex = tabs.findIndex((tab) => tab.classList.contains('active'));
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const nextIndex = (currentIndex + direction + tabs.length) % tabs.length;
    event.preventDefault();
    tabs[nextIndex].focus();
    activateModalTab(tabs[nextIndex].dataset.mtab);
  });

  dom['mtab-profiles']?.addEventListener('click', (event) => {
    const button = event.target.closest('.btn-del-profile');
    if (!button) return;
    if (!window.confirm('Excluir este layout da memória da IA?')) return;

    state.memory.learnedProfiles = state.memory.learnedProfiles.filter(
      (profile) => profile.id !== button.dataset.profId
    );
    saveAiMemory(state.memory);
    updateAiBadge();
    renderAiModal();
    showToast('Perfil removido da memória da IA.', 'warn');
  });

  dom['btn-export-memory']?.addEventListener('click', () => {
    // Backup nunca leva a chave do LLM: o arquivo é feito para versionar e
    // compartilhar, e a chave é um dado pessoal que só fica neste navegador.
    const backup = {
      ...state.memory,
      optionalLlm: { ...state.memory.optionalLlm, apiKey: '' },
    };
    const json = JSON.stringify(backup, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'conversor-ia-memoria.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    showToast('Memória exportada em conversor-ia-memoria.json.');
  });

  dom['import-memory-input']?.addEventListener('change', async () => {
    const input = dom['import-memory-input'];
    const file = input.files?.[0];
    if (!file) return;

    try {
      const payload = JSON.parse(await file.text());
      if (!payload || !Array.isArray(payload.learnedProfiles) || !payload.tokenWeights) {
        throw new Error('O arquivo não parece ser uma memória do Conversor.');
      }

      const imported = normalizeMemory(payload);
      // A configuração do LLM é local: o backup não a substitui.
      imported.optionalLlm = {
        provider: state.memory.optionalLlm?.provider || 'none',
        apiKey: state.memory.optionalLlm?.apiKey || '',
        model: state.memory.optionalLlm?.model || '',
      };
      state.memory = imported;
      saveAiMemory(state.memory);
      updateAiBadge();
      renderAiModal();
      if (state.selectedFileId) openTrainerForFile(state.selectedFileId);
      showToast(
        `Memória importada: ${state.memory.learnedProfiles.length} perfil(is) de layout.`
      );
    } catch (error) {
      showToast(`Erro ao importar memória: ${error.message}`, 'error');
    } finally {
      input.value = '';
    }
  });

  dom['btn-reset-memory']?.addEventListener('click', () => {
    if (!window.confirm('Apagar todos os layouts aprendidos e voltar ao vocabulário padrão?')) return;
    state.memory = resetAiMemory();
    updateAiBadge();
    renderAiModal();
    scheduleCloudPush();
    showToast('Memória da IA restaurada para o padrão inicial.', 'warn');
  });

  dom['btn-save-llm']?.addEventListener('click', () => {
    const provider = dom['llm-provider'].value;
    const apiKey = dom['llm-apikey'].value.trim();

    if (provider !== 'none' && !apiKey) {
      showToast('Informe a API key do provedor escolhido ou selecione "Desativado".', 'warn');
      return;
    }

    state.memory.optionalLlm = { provider, apiKey, model: '' };
    const saved = saveAiMemory(state.memory);
    if (state.selectedFileId) openTrainerForFile(state.selectedFileId);
    showToast(
      saved
        ? 'Configuração do LLM salva localmente neste navegador.'
        : 'Configuração aplicada, mas o navegador bloqueou o salvamento.',
      saved ? 'success' : 'warn'
    );
  });
}

/* -------------------------------------------------------------------------- */
/*                        Nuvem compartilhada (modelos)                       */
/* -------------------------------------------------------------------------- */

function setCloudStatus(message, tone = 'idle') {
  const box = dom['cloud-status'];
  if (!box) return;
  box.textContent = message;
  box.classList.remove('is-ok', 'is-warn', 'is-error');
  if (tone === 'ok') box.classList.add('is-ok');
  else if (tone === 'warn') box.classList.add('is-warn');
  else if (tone === 'error') box.classList.add('is-error');
  cloud.statusTone = tone;
}

/**
 * Mantém a chave visível na barra superior: é ali que o usuário a encontra
 * para copiar e levar para outro computador, sem precisar abrir o modal.
 */
function renderTopKey() {
  const button = dom['btn-cloud-key'];
  const codeEl = dom['cloud-key-code'];
  if (!button || !codeEl) return;

  const identity = cloud.identity;
  const hasKey = !!identity;
  const shown = hasKey ? formatAccessCode(identity.code) : '';

  button.classList.toggle('is-empty', !hasKey);
  codeEl.textContent = hasKey ? shown : 'criar agora';
  if (dom['cloud-key-caption']) {
    dom['cloud-key-caption'].textContent = hasKey ? 'Chave de acesso' : 'Chave para outro PC';
  }

  button.title = hasKey
    ? `Clique para copiar a chave ${shown}. Você precisa dela para abrir seus modelos em outro computador.`
    : 'Clique para criar sua chave de acesso. Você precisa dela para abrir seus modelos em outro computador.';
  button.setAttribute(
    'aria-label',
    hasKey
      ? `Sua chave de acesso é ${shown}. Clique para copiar. É com ela que você abre seus modelos em outro computador.`
      : 'Criar chave de acesso. Você precisa dela para abrir seus modelos em outro computador.'
  );
}

function describeLastSync(identity) {
  if (!identity?.lastSyncAt) return 'nenhuma sincronização ainda';
  const date = new Date(identity.lastSyncAt);
  if (Number.isNaN(date.getTime())) return 'nenhuma sincronização ainda';
  return `última sincronização em ${date.toLocaleString('pt-BR')}`;
}

/**
 * `true` quando o app está usando o banco embutido (nem o usuário nem um
 * administrador salvaram outra conexão neste navegador).
 */
function usingBuiltInCloud() {
  return (
    !!BUILT_IN_CLOUD &&
    !!cloud.config &&
    cloud.config.url === BUILT_IN_CLOUD.url &&
    cloud.config.anonKey === BUILT_IN_CLOUD.anonKey
  );
}

/** Nome curto do projeto para mostrar na tela (ex.: "abcdefgh.supabase.co"). */
function cloudHostLabel(config = cloud.config) {
  if (!config?.url) return '';
  return config.url.replace(/^https?:\/\//i, '');
}

/**
 * Checa o banco uma vez por sessão assim que a aba "Nuvem" abre, para o usuário
 * ver na hora se a conexão embutida está respondendo.
 */
async function ensureCloudOnline() {
  if (!cloud.config || cloud.ping !== null || cloud.busy) return;
  cloud.ping = 'checking';
  try {
    await pingDatabase(cloud.config);
    cloud.ping = 'ok';
  } catch (error) {
    cloud.ping = error?.message || 'falha ao falar com o banco';
  }
  if (dom['cloud-status']) renderCloudPanel();
}

function cloudStatusMessage(hasConfig, identity) {
  if (!hasConfig) {
    return {
      tone: 'warn',
      message:
        'Banco compartilhado ainda não configurado. Cole a URL e a chave anônima em “Conexão com o banco”.',
    };
  }

  const online = cloud.ping === 'ok' ? ' Banco online.' : cloud.ping === 'checking' ? ' Checando o banco…' : '';
  const offline = typeof cloud.ping === 'string' && cloud.ping !== 'checking' && cloud.ping !== 'ok'
    ? ` Banco indisponível: ${cloud.ping}`
    : '';

  if (!identity) {
    return {
      tone: 'warn',
      message: `Banco conectado${cloudHostLabel() ? ` (${cloudHostLabel()})` : ''} e pronto — falta só criar a sua chave.${online}${offline}`,
    };
  }

  return {
    tone: offline ? 'warn' : 'ok',
    message: `Conectado como ${formatAccessCode(identity.code)} — ${describeLastSync(identity)}.${online}${offline}`,
  };
}

function renderCloudPanel() {
  const hasConfig = !!cloud.config;
  const identity = cloud.identity;

  if (dom['cloud-url']) dom['cloud-url'].value = cloud.config?.url || '';
  if (dom['cloud-anon-key']) dom['cloud-anon-key'].value = cloud.config?.anonKey || '';

  // O app já vem com o banco oficial embutido: a configuração manual fica
  // escondida em "avançado" e só aparece como opção de troca de projeto.
  const builtIn = usingBuiltInCloud();
  if (dom['cloud-config-block']) {
    dom['cloud-config-block'].classList.toggle('is-built-in', builtIn);
  }
  if (dom['cloud-official-note']) {
    dom['cloud-official-note'].textContent = builtIn
      ? `Banco oficial do Conversor em uso (${cloudHostLabel(BUILT_IN_CLOUD)}) — já vem configurado no app, não é preciso colar nada.`
      : `Conexão personalizada em uso${cloudHostLabel() ? ` (${cloudHostLabel()})` : ''}.`;
    dom['cloud-official-note'].classList.toggle('hidden', !BUILT_IN_CLOUD);
  }
  if (dom['btn-cloud-reset-config']) {
    dom['btn-cloud-reset-config'].classList.toggle('hidden', !BUILT_IN_CLOUD || builtIn);
  }

  dom['cloud-identity-empty']?.classList.toggle('hidden', !!identity);
  dom['cloud-identity-active']?.classList.toggle('hidden', !identity);

  if (dom['cloud-code-display']) {
    // Campo somente leitura: além do botão "Copiar chave", o usuário pode
    // selecionar e copiar com Ctrl+C (inclusive no celular).
    dom['cloud-code-display'].value = identity ? formatAccessCode(identity.code) : '—';
  }

  renderTopKey();

  const disableActions = !hasConfig || !identity || cloud.busy;
  for (const id of ['btn-cloud-push', 'btn-cloud-pull']) {
    if (dom[id]) dom[id].disabled = disableActions;
  }
  // A chave de acesso é local: pode ser criada/informada mesmo antes de o
  // administrador publicar a URL do banco.
  if (dom['btn-cloud-create']) dom['btn-cloud-create'].disabled = cloud.busy;
  if (dom['btn-cloud-recover']) dom['btn-cloud-recover'].disabled = cloud.busy;

  if (cloud.busy) return;
  const { tone, message } = cloudStatusMessage(hasConfig, identity);
  setCloudStatus(message, tone);

  // Primeira abertura da aba: confere se o banco embutido está respondendo.
  if (hasConfig && cloud.ping === null) void ensureCloudOnline();
}

async function withCloudBusy(task) {
  if (cloud.busy) return;
  cloud.busy = true;
  renderCloudPanel();
  try {
    await task();
  } finally {
    cloud.busy = false;
    renderCloudPanel();
  }
}

/** Envia de fato (usado também dentro de fluxos que já estão "ocupados"). */
async function pushNow({ silent = false } = {}) {
  try {
    const result = await pushVault({
      config: cloud.config,
      identity: cloud.identity,
      memory: state.memory,
      appVersion: APP_VERSION,
    });
    cloud.identity = touchIdentitySync({ ...cloud.identity }, result.updatedAt);
    return result;
  } catch (error) {
    setCloudStatus(`Falha ao enviar: ${error.message}`, 'error');
    if (!silent) showToast(`Falha ao enviar: ${error.message}`, 'error');
    return null;
  }
}

/** Baixa de fato e devolve `{ payload }`, `null` (vazio) ou `false` (erro). */
async function pullNow({ silent = false } = {}) {
  try {
    const remote = await pullVault({ config: cloud.config, identity: cloud.identity });
    if (!remote) {
      setCloudStatus('Nenhum modelo encontrado para esta chave na nuvem.', 'warn');
      if (!silent) showToast('Nada para baixar: a nuvem ainda não tem modelos desta chave.', 'warn');
      return null;
    }

    state.memory = applyVaultPayload(state.memory, remote.payload);
    saveAiMemory(state.memory);
    updateAiBadge();
    renderAiModal();
    if (state.selectedFileId) openTrainerForFile(state.selectedFileId);
    renderFilesList();

    cloud.identity = touchIdentitySync({ ...cloud.identity }, remote.updatedAt);
    showToast(
      `Modelos restaurados da nuvem: ${state.memory.learnedProfiles.length} perfil(is) de layout.`
    );
    return remote;
  } catch (error) {
    setCloudStatus(`Falha ao baixar: ${error.message}`, 'error');
    if (!silent) showToast(`Falha ao baixar: ${error.message}`, 'error');
    return false;
  }
}

async function cloudPush({ silent = false } = {}) {
  if (!cloud.config) {
    if (!silent) showToast('Configure o banco compartilhado primeiro.', 'warn');
    return;
  }
  if (!cloud.identity) {
    if (!silent) showToast('Crie ou informe sua chave de acesso primeiro.', 'warn');
    return;
  }

  await withCloudBusy(async () => {
    if (!silent) setCloudStatus('Enviando modelos para a nuvem…');
    const result = await pushNow({ silent });
    if (result && !silent) showToast('Modelos enviados para a nuvem.');
  });
}

async function cloudPull({ silent = false } = {}) {
  if (!cloud.config || !cloud.identity) {
    if (!silent) showToast('Configure o banco e a chave de acesso primeiro.', 'warn');
    return;
  }

  await withCloudBusy(async () => {
    if (!silent) setCloudStatus('Baixando modelos da nuvem…');
    await pullNow({ silent });
  });
}

/** Envia em segundo plano depois de treinar (sem travar a interface). */
let cloudPushTimer = null;

/**
 * Envia em segundo plano depois de treinar (sem travar a interface). O timer é
 * único: várias alterações seguidas geram **um** envio, não um por alteração.
 */
function scheduleCloudPush() {
  if (!cloud.config || !cloud.identity) return;
  if (cloudPushTimer) clearTimeout(cloudPushTimer);
  cloudPushTimer = setTimeout(() => {
    cloudPushTimer = null;
    void cloudPush({ silent: true });
  }, 1200);
}

/** Copia a chave; devolve `true` quando o navegador permitiu. */
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* permissão negada ou contexto inseguro */
  }
  // Plano B: quando o campo da aba Nuvem está visível, deixa a chave
  // selecionada para o usuário copiar com Ctrl+C.
  const field = dom['cloud-code-display'];
  if (field && typeof field.select === 'function' && field.offsetParent !== null) {
    field.focus();
    field.select();
  }
  return false;
}

/**
 * Adota uma chave já existente (digitada/colada em qualquer lugar do app) e
 * tenta trazer os modelos da nuvem. Usada pelo campo do topo e pela aba Nuvem.
 */
async function useAccessCode(rawCode) {
  const code = normalizeAccessCode(rawCode);
  if (!code) {
    showToast('Chave inválida: use os 8 caracteres no formato ABCD-EFGH.', 'warn');
    return false;
  }

  let adopted = false;
  await withCloudBusy(async () => {
    try {
      const identity = await restoreIdentityFromCode(code);
      saveIdentity(identity);
      cloud.identity = identity;
      renderCloudPanel();
      adopted = true;

      if (!cloud.config) {
        showToast(
          `Chave ${formatAccessCode(code)} aceita e guardada neste navegador. Falta configurar o banco para baixar seus modelos.`,
          'warn'
        );
        return;
      }

      showToast(`Chave aceita: ${formatAccessCode(code)}. Baixando seus modelos…`);
      const pulled = await pullNow({ silent: true });

      if (pulled === null) {
        setCloudStatus(
          `Chave ${formatAccessCode(code)} guardada neste dispositivo, mas a nuvem ainda não tem modelos para ela. ` +
            'Se você já usava essa chave em outra máquina, confira se digitou certo — uma chave diferente abre um cofre novo.',
          'warn'
        );
        showToast(
          'Chave guardada. Nenhum modelo encontrado para ela na nuvem — confira se digitou certo.',
          'warn'
        );
      } else if (pulled === false) {
        // A chave pode estar certa mas o banco inacessível: mantém a chave.
        showToast('Chave guardada, mas não consegui baixar os modelos agora. Tente “Baixar modelos”.', 'warn');
      }
    } catch (error) {
      clearIdentity();
      cloud.identity = null;
      renderCloudPanel();
      setCloudStatus(`Não foi possível usar esta chave: ${error.message}`, 'error');
      showToast(`Não foi possível usar esta chave: ${error.message}`, 'error');
    }
  });

  return adopted;
}

/** Cria a chave deste dispositivo, copia e já publica os modelos locais. */
async function createAccessIdentity() {
  try {
    const code = generateAccessCode();
    const identity = await restoreIdentityFromCode(code);
    saveIdentity(identity);
    cloud.identity = identity;
    renderCloudPanel();

    const shown = formatAccessCode(code);
    const copied = await copyText(shown);
    showToast(
      copied
        ? `Chave ${shown} criada e copiada. Você precisa dela para abrir seus modelos em outro computador.`
        : `Chave ${shown} criada. Anote: você precisa dela para abrir seus modelos em outro computador.`
    );

    // Já publica o que existe localmente, para a nuvem refletir os modelos atuais.
    if (cloud.config) await pushNow({ silent: true });
  } catch (error) {
    setCloudStatus(`Falha ao criar a chave: ${error.message}`, 'error');
  }
}

function downloadKeyCard(identity) {
  const code = formatAccessCode(identity.code);
  const content = [
    'CONVERSOR — CARTÃO DE ACESSO À NUVEM',
    '',
    `Chave de acesso: ${code}`,
    `Criada em: ${new Date(identity.createdAt).toLocaleString('pt-BR')}`,
    '',
    'Como usar:',
    '1. Abra o Conversor em qualquer computador.',
    '2. Vá em Memória da IA → aba "Nuvem (Equipe)".',
    '3. Informe esta chave em "Já tenho uma chave de acesso".',
    '',
    'Guarde este cartão em local seguro: quem tiver a chave acessa seus modelos.',
  ].join('\n');

  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'conversor-chave-de-acesso.txt';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function bindCloudEvents() {
  dom['btn-cloud-save-config']?.addEventListener('click', async () => {
    const config = {
      url: dom['cloud-url']?.value || '',
      anonKey: dom['cloud-anon-key']?.value || '',
    };
    if (!saveCloudConfig(config)) {
      showToast('Informe a Project URL e a chave anônima do Supabase.', 'warn');
      return;
    }
    cloud.config = loadCloudConfig();
    cloud.ping = null;
    renderCloudPanel();
    showToast('Conexão com o banco compartilhado salva.');
  });

  // Volta para o banco oficial embutido (descarta a conexão personalizada).
  dom['btn-cloud-reset-config']?.addEventListener('click', () => {
    clearCloudConfig();
    cloud.config = loadCloudConfig();
    cloud.ping = null;
    renderCloudPanel();
    showToast('Conectado ao banco oficial do Conversor.');
  });

  dom['btn-cloud-test']?.addEventListener('click', async () => {
    const config = {
      url: dom['cloud-url']?.value || '',
      anonKey: dom['cloud-anon-key']?.value || '',
    };
    try {
      await pingDatabase(config);
      cloud.ping = 'ok';
      renderCloudPanel();
      showToast('Conexão com o banco funcionando.', 'success');
    } catch (error) {
      cloud.ping = error?.message || 'falha ao falar com o banco';
      renderCloudPanel();
      showToast(`Falha no teste: ${error.message}`, 'error');
    }
  });

  dom['btn-cloud-create']?.addEventListener('click', () => withCloudBusy(createAccessIdentity));

  // A chave na barra superior: cria quando ainda não existe, copia quando existe.
  dom['btn-cloud-key']?.addEventListener('click', async () => {
    if (!cloud.identity) {
      await withCloudBusy(createAccessIdentity);
      return;
    }

    const code = formatAccessCode(cloud.identity.code);
    if (await copyText(code)) {
      showToast(
        `Chave ${code} copiada. Guarde: você precisa dela para abrir seus modelos em outro computador.`
      );
      return;
    }

    // Sem permissão de área de transferência: abre a aba onde a chave fica
    // selecionável e avisa o usuário.
    openAiModal();
    activateModalTab('cloud');
    dom['cloud-code-display']?.focus();
    dom['cloud-code-display']?.select();
    showToast(`Sua chave é ${code} — ela está selecionada, copie com Ctrl+C.`, 'warn');
  });

  dom['btn-cloud-key-info']?.addEventListener('click', () => {
    showToast(
      'A chave de acesso é a sua identidade, sem senha: é com ela que você abre seus modelos em outro computador. Guarde-a — se perdê-la, não é possível recuperar o que está na nuvem.'
    );
  });

  dom['btn-cloud-recover']?.addEventListener('click', async () => {
    const ok = await useAccessCode(dom['cloud-code-input']?.value || '');
    if (ok && dom['cloud-code-input']) dom['cloud-code-input'].value = '';
  });

  // Campo do topo: colar a chave de outro computador e entrar.
  const submitTopKey = async () => {
    const input = dom['cloud-key-top-input'];
    const raw = input?.value || '';
    if (!raw.trim()) {
      input?.focus();
      showToast('Cole a chave de 8 caracteres que aparece no outro computador.', 'warn');
      return;
    }
    const ok = await useAccessCode(raw);
    if (ok && input) {
      input.value = '';
      input.blur();
    }
  };

  dom['btn-cloud-key-use']?.addEventListener('click', submitTopKey);
  dom['cloud-key-top-input']?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitTopKey();
    }
  });
  // Ao sair do campo, mostra a chave no formato ABCD-EFGH se ela for válida.
  dom['cloud-key-top-input']?.addEventListener('blur', () => {
    const input = dom['cloud-key-top-input'];
    const code = normalizeAccessCode(input?.value || '');
    if (input && code) input.value = formatAccessCode(code);
  });

  dom['btn-cloud-copy']?.addEventListener('click', async () => {
    if (!cloud.identity) return;
    const code = formatAccessCode(cloud.identity.code);
    if (await copyText(code)) {
      showToast(`Chave ${code} copiada.`);
    } else {
      showToast(`Chave selecionada — copie com Ctrl+C: ${code}`, 'warn');
    }
  });

  // Clicar na chave já a deixa selecionada para copiar.
  dom['cloud-code-display']?.addEventListener('click', () => {
    if (!cloud.identity) return;
    dom['cloud-code-display'].select?.();
  });

  dom['btn-cloud-download']?.addEventListener('click', () => {
    if (!cloud.identity) return;
    downloadKeyCard(cloud.identity);
    showToast('Cartão da chave baixado.');
  });

  dom['btn-cloud-forget']?.addEventListener('click', () => {
    if (!window.confirm('Esquecer a chave neste dispositivo? Sem ela, os modelos da nuvem não podem ser recuperados.')) {
      return;
    }
    clearIdentity();
    cloud.identity = null;
    renderCloudPanel();
    showToast('Chave removida deste dispositivo.', 'warn');
  });

  dom['btn-cloud-push']?.addEventListener('click', () => cloudPush());
  dom['btn-cloud-pull']?.addEventListener('click', () => cloudPull());
}

function bindGlobalEvents() {
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (dom['ai-modal'] && !dom['ai-modal'].classList.contains('hidden')) {
      closeAiModal();
      return;
    }
    if (dom['ai-trainer-section'] && !dom['ai-trainer-section'].classList.contains('hidden')) {
      dom['btn-close-trainer']?.click();
    }
  });

  // Mantém o foco dentro do modal enquanto ele estiver aberto.
  document.addEventListener('focusin', (event) => {
    const modal = dom['ai-modal'];
    if (!modal || modal.classList.contains('hidden')) return;
    if (!modal.contains(event.target)) {
      dom['btn-close-modal']?.focus();
    }
  });

  window.addEventListener('beforeunload', (event) => {
    if (state.files.length === 0) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

/* -------------------------------------------------------------------------- */
/*                                   Init                                     */
/* -------------------------------------------------------------------------- */

function init() {
  cacheDom();
  updateAiBadge();

  // Tamanho da página vem do seletor; valor estranho cai no padrão.
  const initialSize = dom['preview-page-size']?.value;
  state.pageSize =
    initialSize === 'all' ? 'all' : PAGE_SIZE_OPTIONS.includes(Number(initialSize)) ? Number(initialSize) : DEFAULT_PAGE_SIZE;
  if (dom['preview-page-size']) dom['preview-page-size'].value = String(state.pageSize);

  if (dom['app-version']) dom['app-version'].textContent = `v${APP_VERSION}`;

  bindUploadEvents();
  bindFilesListEvents();
  bindTrainerEvents();
  bindOutputEvents();
  bindModalEvents();
  bindCloudEvents();
  bindGlobalEvents();


  // Mantém filtros e controles acessíveis em estados iniciais coerentes.
  document.querySelectorAll('.pill[data-filter]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.classList.contains('active')));
  });
  activateModalTab('profiles');
  dom['ai-modal']?.setAttribute('aria-hidden', 'true');
  renderCloudPanel();

  renderFilesList();
  renderOutputSection();

  if (!('ExcelJS' in window) || !window.jspdf) {
    showToast(
      'Bibliotecas de planilha/PDF não carregaram corretamente. Recarregue a página.',
      'error',
      { duration: 0 }
    );
  }
}

try {
  init();
} catch (error) {
  console.error('[Conversor] Falha na inicialização:', error);
  const container = document.getElementById('toast-container');
  if (container) {
    const toast = document.createElement('div');
    toast.className = 'toast error';
    toast.setAttribute('role', 'alert');
    toast.textContent = `Falha ao iniciar a aplicação: ${error.message}`;
    container.appendChild(toast);
  }
}

// Exposto para depuração manual no console e para testes de integração.
if (typeof window !== 'undefined') window.__conversor = { state, rebuildUnifiedOutput, renderOutputSection };
