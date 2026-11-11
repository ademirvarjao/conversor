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
import { formatLocalDateTime, formatValuePlainBr, sumValues } from './format.js';
import { summarizeRecords } from './summary.js';
import { exportToPdf, exportToXlsx } from './exporters.js';
import { APP_VERSION, REQUIRED_ELEMENT_IDS } from './ui-contract.js';

const PAGE_SIZE = 100;
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
  exportOnlyFiltered: false,
  processing: false,
};

/* -------------------------------------------------------------------------- */
/*                                    DOM                                     */
/* -------------------------------------------------------------------------- */

const dom = {};

function cacheDom() {
  for (const id of REQUIRED_ELEMENT_IDS) {
    const element = document.getElementById(id);
    if (!element) {
      console.warn(`[Conversor Custódio] Elemento #${id} não encontrado no HTML.`);
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

function rebuildUnifiedOutput() {
  const allRecords = [];
  let skippedCount = 0;

  for (const file of state.files) {
    const result = transformRowsWithConfig(file.parsedFile, file.analysis);
    file.result = result;
    allRecords.push(...result.records);
    skippedCount += result.skipped.length;
  }

  // Ordenação cronológica crescente e estável (por arquivo/linha de origem).
  allRecords.sort(
    (a, b) =>
      a.dateIso.localeCompare(b.dateIso) ||
      a.sourceFile.localeCompare(b.sourceFile) ||
      (a.sourceRow || 0) - (b.sourceRow || 0)
  );

  state.unifiedRows = allRecords;
  state.summary = summarizeRecords(allRecords, { skippedCount });

  applyFilters({ resetPage: true });
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

  dom['kpi-in'].textContent = formatValuePlainBr(summary.totalIn);
  dom['kpi-in-count'].textContent = `${summary.inCount} recebimento(s)`;
  dom['kpi-out'].textContent = formatValuePlainBr(summary.totalOutAbs);
  dom['kpi-out-count'].textContent = `${summary.outCount} pagamento(s)`;
  dom['kpi-net'].textContent = formatValuePlainBr(summary.netTotal);
  dom['kpi-net'].style.color = summary.netTotal >= 0 ? 'var(--emerald)' : 'var(--crimson)';
  dom['kpi-skipped'].textContent = `${summary.skippedCount} linha(s) ignorada(s)`;

  const total = state.filteredRows.length;
  const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (state.currentPage > maxPage) state.currentPage = maxPage;

  const startIndex = (state.currentPage - 1) * PAGE_SIZE;
  const endIndex = Math.min(total, startIndex + PAGE_SIZE);
  const pageRows = state.filteredRows.slice(startIndex, endIndex);

  const tbody = dom['preview-tbody'];
  tbody.innerHTML = '';

  if (pageRows.length === 0) {
    const row = document.createElement('tr');
    row.innerHTML = `<td colspan="3" class="empty-row">${
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
      row.innerHTML = `
        <td class="col-date">${escapeHtml(record.dateBr)}</td>
        <td class="col-val ${valueClass}">${escapeHtml(formatValuePlainBr(record.value))}</td>
        <td class="col-hist" title="Origem: ${escapeHtml(record.sourceFile)}">${escapeHtml(
          record.history
        )}</td>
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

    if (added > 0) saveAiMemory(state.memory);
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

  dropzone.addEventListener('click', openPicker);
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

  dom['btn-prev-page']?.addEventListener('click', () => {
    if (state.currentPage > 1) {
      state.currentPage--;
      renderOutputSection();
      dom['output-section']?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });

  dom['btn-next-page']?.addEventListener('click', () => {
    const maxPage = Math.max(1, Math.ceil(state.filteredRows.length / PAGE_SIZE));
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
        `Conciliacao_Custodio_${stamp}.xlsx`,
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
      exportToPdf(rows, summary, `Conciliacao_Custodio_${stamp}.pdf`);
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
    const json = JSON.stringify(state.memory, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'custodio-ia-memoria.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    showToast('Memória exportada em custodio-ia-memoria.json.');
  });

  dom['import-memory-input']?.addEventListener('change', async () => {
    const input = dom['import-memory-input'];
    const file = input.files?.[0];
    if (!file) return;

    try {
      const payload = JSON.parse(await file.text());
      if (!payload || !Array.isArray(payload.learnedProfiles) || !payload.tokenWeights) {
        throw new Error('O arquivo não parece ser uma memória do Conversor Custódio.');
      }

      state.memory = normalizeMemory(payload);
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
/*                                Modo demonstração                           */
/* -------------------------------------------------------------------------- */

function runDemo() {
  if (
    state.files.length > 0 &&
    !window.confirm('Isto substitui os arquivos atuais pelos exemplos. Continuar?')
  ) {
    return;
  }

  state.files = [];
  state.selectedFileId = null;

  const demoPayments = {
    fileName: 'Exemplo_Pagamentos_Itau_Layout_Novo.xlsx',
    fileType: 'xlsx',
    sheetName: 'Pagamentos',
    availableSheets: [{ name: 'Pagamentos', rowCount: 3 }],
    headers: [
      'DATA PAGAMENTO',
      'TÍTULO',
      'TIPO',
      'FORNECEDOR',
      'VALOR PAGO',
      'LOCAL | CENTRO DE CUSTO | NATUREZA',
      'OBSERVAÇÃO OBRA',
    ],
    rows: [
      [
        '02/09/2026',
        '02092026',
        'FOLHA DE PAGAMENTO',
        'SILVESTRE ABELARDO ENGENHARIA',
        '-R$ 2.000,00',
        '154 - E801-T-ADAPTOGEN-SP-2026 | 04.02 | 2.14.017 - PRESTADOR DE SERVIÇO',
        'Aprovado Eng.',
      ],
      [
        '04/09/2026',
        '814-1',
        'RECIBOS',
        'HORTIFRUTI INHANGA LTDA',
        '-R$ 532,00',
        '1001.004 - ADMINISTRATIVO | 04.01 | 2.07.019 - OUTRAS DESPESAS',
        'Copa Matriz',
      ],
      [
        '09/09/2026',
        'REN_LINEAR-2',
        'RENEGOCIAÇÃO',
        'LINEAR SERVIÇOS AR CONDICIONADO',
        '-R$ 29.250,00',
        '137 - E462-O-OCEANERRING-RJ-2025 | 02.01 | 2.02.002 - AR CONDICIONADO',
        'Parcela 2',
      ],
    ],
    bannerLines: ['CUSTÓDIO SOLUÇÕES EM CONSTRUÇÕES LTDA'],
    skippedRows: 0,
  };

  const demoReceipts = {
    fileName: 'Exemplo_Recebimentos_Layout_Banco.xlsx',
    fileType: 'xlsx',
    sheetName: 'Extrato',
    availableSheets: [{ name: 'Extrato', rowCount: 3 }],
    headers: ['Dt. Mov.', 'Doc.', 'Histórico Banco', 'Entrada (+)', 'Saída (-)', 'Saldo Dia'],
    rows: [
      ['02/09/2026', 'TRF-93593', 'TRANSFERENCIA CUSTODIO SOLUCOES', '8.002,12', '', '8.002,12'],
      [
        '08/09/2026',
        '182-1',
        'CORINTOS LOGISTICA COMERCIO EXTERIOR | CLIENTES',
        '89.628,03',
        '',
        '97.630,15',
      ],
      ['10/09/2026', 'TAR-001', 'TARIFA MANUTENCAO CONTA', '', '45,90', '97.584,25'],
    ],
    bannerLines: ['Extrato Bancário Modelo Variável'],
    skippedRows: 0,
  };

  for (const parsedFile of [demoPayments, demoReceipts]) {
    state.files.push({
      id: `demo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      parsedFile,
      analysis: analyzeFileLayout(parsedFile, state.memory),
      result: { records: [], skipped: [] },
      meta: { size: 0, uploadedAt: new Date().toISOString() },
    });
  }

  rebuildUnifiedOutput();
  openTrainerForFile(state.files[1].id);
  showToast(
    'Exemplo carregado: veja como a IA separou Entrada/Saída e ignorou a coluna Saldo Dia.',
    'warn'
  );
}

/* -------------------------------------------------------------------------- */
/*                                   Init                                     */
/* -------------------------------------------------------------------------- */

function init() {
  cacheDom();
  updateAiBadge();

  if (dom['app-version']) dom['app-version'].textContent = `v${APP_VERSION}`;

  bindUploadEvents();
  bindFilesListEvents();
  bindTrainerEvents();
  bindOutputEvents();
  bindModalEvents();
  bindGlobalEvents();

  dom['btn-demo']?.addEventListener('click', runDemo);

  // Mantém filtros e controles acessíveis em estados iniciais coerentes.
  document.querySelectorAll('.pill[data-filter]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.classList.contains('active')));
  });
  activateModalTab('profiles');
  dom['ai-modal']?.setAttribute('aria-hidden', 'true');

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
  console.error('[Conversor Custódio] Falha na inicialização:', error);
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
if (typeof window !== 'undefined') window.__conversorCustodio = { state };
