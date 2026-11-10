import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';
import {
  parsePdfFile,
  parseXlsxFile,
  cleanWhitespace,
  normalizeText,
} from './parsers.js';
import {
  ROLES,
  ROLE_LABELS,
  loadAiMemory,
  saveAiMemory,
  resetAiMemory,
  analyzeFileLayout,
  trainAiWithLayout,
  transformRowsWithConfig,
  analyzeWithOptionalLlm,
} from './ai-engine.js';
import {
  formatValuePlainBr,
  exportToXlsx,
  exportToPdf,
} from './exporters.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/pdf.worker.min.mjs';

const PAGE_SIZE = 100;

const state = {
  memory: loadAiMemory(),
  files: [], // { id, parsedFile, analysis, result: { records, skipped } }
  selectedFileId: null,
  unifiedRows: [],
  filteredRows: [],
  summary: {
    totalIn: 0,
    inCount: 0,
    totalOut: 0,
    outCount: 0,
    netTotal: 0,
    skippedCount: 0,
    minDateBr: '',
    maxDateBr: '',
  },
  searchTerm: '',
  typeFilter: 'all',
  currentPage: 1,
};

// DOM Elements
const $ = (id) => document.getElementById(id);
const dropzone = $('dropzone');
const fileInput = $('file-input');
const filesListEl = $('files-list');
const btnClearFiles = $('btn-clear-files');
const btnDemo = $('btn-demo');
const btnAiMemory = $('btn-ai-memory');
const aiProfilesBadge = $('ai-profiles-badge');

const trainerSection = $('ai-trainer-section');
const trainerTitle = $('trainer-title');
const trainerAlert = $('trainer-alert');
const layoutNameInput = $('layout-name-input');
const ruleDefaultSign = $('rule-default-sign');
const ruleRemovePipes = $('rule-remove-pipes');
const ruleCollapseSpaces = $('rule-collapse-spaces');
const ruleReplaceFrom = $('rule-replace-from');
const ruleReplaceTo = $('rule-replace-to');
const mappingTbody = $('mapping-tbody');
const btnTrainApply = $('btn-train-apply');
const btnCloseTrainer = $('btn-close-trainer');
const btnLlmAnalyze = $('btn-llm-analyze');

const outputSection = $('output-section');
const btnExportXlsx = $('btn-export-xlsx');
const btnExportPdf = $('btn-export-pdf');
const kpiCount = $('kpi-count');
const kpiPeriod = $('kpi-period');
const kpiIn = $('kpi-in');
const kpiInCount = $('kpi-in-count');
const kpiOut = $('kpi-out');
const kpiOutCount = $('kpi-out-count');
const kpiNet = $('kpi-net');
const kpiSkipped = $('kpi-skipped');
const searchInput = $('search-input');
const previewTbody = $('preview-tbody');
const paginationInfo = $('pagination-info');
const btnPrevPage = $('btn-prev-page');
const btnNextPage = $('btn-next-page');

const aiModal = $('ai-modal');
const btnCloseModal = $('btn-close-modal');
const memStatProfiles = $('mem-stat-profiles');
const memStatFiles = $('mem-stat-files');
const memStatCorr = $('mem-stat-corr');
const memStatTokens = $('mem-stat-tokens');
const mtabProfiles = $('mtab-profiles');
const mtabLogs = $('mtab-logs');
const mtabSettings = $('mtab-settings');
const btnExportMemory = $('btn-export-memory');
const importMemoryInput = $('import-memory-input');
const btnResetMemory = $('btn-reset-memory');
const llmProviderEl = $('llm-provider');
const llmApiKeyEl = $('llm-apikey');
const btnSaveLlm = $('btn-save-llm');
const toastContainer = $('toast-container');

function showToast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  toastContainer.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 4200);
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function updateAiBadge() {
  const count = state.memory.learnedProfiles.length;
  aiProfilesBadge.textContent = `${count} ${count === 1 ? 'perfil' : 'perfis'}`;
}

function rebuildUnifiedOutput() {
  const all = [];
  let skippedCount = 0;

  for (const f of state.files) {
    const res = transformRowsWithConfig(f.parsedFile, f.analysis);
    f.result = res;
    all.push(...res.records);
    skippedCount += res.skipped.length;
  }

  // Ordenar por data crescente (sort estável)
  all.sort((a, b) => a.dateIso.localeCompare(b.dateIso));
  state.unifiedRows = all;

  let totalIn = 0;
  let inCount = 0;
  let totalOut = 0;
  let outCount = 0;

  for (const r of all) {
    if (r.value >= 0) {
      totalIn += r.value;
      inCount++;
    } else {
      totalOut += r.value;
      outCount++;
    }
  }

  const netTotal = Math.round((totalIn + totalOut) * 100) / 100;
  state.summary = {
    totalIn: Math.round(totalIn * 100) / 100,
    inCount,
    totalOut: Math.round(totalOut * 100) / 100,
    outCount,
    netTotal,
    skippedCount,
    minDateBr: all.length > 0 ? all[0].dateBr : '',
    maxDateBr: all.length > 0 ? all[all.length - 1].dateBr : '',
  };

  applyFilters();
  renderFilesList();
  renderOutputSection();
}

function applyFilters() {
  const term = normalizeText(state.searchTerm);
  state.filteredRows = state.unifiedRows.filter((r) => {
    if (state.typeFilter === 'in' && r.value < 0) return false;
    if (state.typeFilter === 'out' && r.value >= 0) return false;
    if (term) {
      const hay = normalizeText(`${r.dateBr} ${r.history} ${r.sourceFile}`);
      if (!hay.includes(term)) return false;
    }
    return true;
  });
  state.currentPage = 1;
}

function renderFilesList() {
  if (state.files.length === 0) {
    filesListEl.classList.add('hidden');
    btnClearFiles.classList.add('hidden');
    return;
  }

  filesListEl.classList.remove('hidden');
  btnClearFiles.classList.remove('hidden');
  filesListEl.innerHTML = '';

  for (const f of state.files) {
    const card = document.createElement('div');
    card.className = `file-card${f.id === state.selectedFileId ? ' active-editing' : ''}`;

    const extClass = f.parsedFile.fileType === 'pdf' ? 'ext-pdf' : 'ext-xlsx';
    const subSum = f.result.records.reduce((s, r) => s + r.value, 0);
    const sumColor = subSum >= 0 ? 'var(--emerald)' : 'var(--crimson)';

    let statusPill = '';
    if (f.analysis.status === 'matched') {
      statusPill = `<span class="ai-status-pill status-matched">IA Reconheceu: ${escapeHtml(f.analysis.matchedProfileName)} (${f.analysis.matchSimilarity}%)</span>`;
    } else if (f.analysis.status === 'evolved') {
      statusPill = `<span class="ai-status-pill status-evolved">Mudança de Layout Detectada (${f.analysis.matchSimilarity}% similar)</span>`;
    } else {
      statusPill = `<span class="ai-status-pill status-new">Novo Layout Inferido (${f.analysis.avgConfidence}% confiança)</span>`;
    }

    let sheetSelectorHtml = '';
    if (f.parsedFile.fileType === 'xlsx' && f.parsedFile.availableSheets?.length > 1) {
      const opts = f.parsedFile.availableSheets
        .map(
          (s) =>
            `<option value="${escapeHtml(s.name)}" ${s.name === f.parsedFile.sheetName ? 'selected' : ''}>Aba: ${escapeHtml(s.name)} (${s.rowCount})</option>`
        )
        .join('');
      sheetSelectorHtml = `<select class="sheet-select" data-file-id="${f.id}">${opts}</select>`;
    }

    const pagesOrSheet =
      f.parsedFile.fileType === 'pdf'
        ? `${f.parsedFile.pageCount} pág.`
        : `Aba "${escapeHtml(f.parsedFile.sheetName)}"`;

    card.innerHTML = `
      <div class="file-card-top">
        <div class="file-name-wrap">
          <span class="ext-badge ${extClass}">${f.parsedFile.fileType}</span>
          <span class="file-name" title="${escapeHtml(f.parsedFile.fileName)}">${escapeHtml(f.parsedFile.fileName)}</span>
        </div>
        <button class="icon-btn btn-remove-file" data-file-id="${f.id}" title="Remover arquivo" type="button">✕</button>
      </div>
      ${statusPill}
      <div class="file-meta">
        <span>${pagesOrSheet}</span>
        <span>•</span>
        <span><strong>${f.result.records.length}</strong> lançamentos</span>
        <span>•</span>
        <span style="color:${sumColor}; font-weight:700;">${formatValuePlainBr(subSum)}</span>
      </div>
      <div class="file-card-actions">
        ${sheetSelectorHtml || `<span style="font-size:0.76rem;color:var(--text-light);">${f.parsedFile.headers.length} colunas</span>`}
        <button class="btn btn-sm btn-secondary btn-edit-layout" data-file-id="${f.id}" type="button">
          Ajustar / Treinar IA
        </button>
      </div>
    `;

    filesListEl.appendChild(card);
  }
}

function openTrainerForFile(fileId) {
  const f = state.files.find((x) => x.id === fileId);
  if (!f) {
    trainerSection.classList.add('hidden');
    return;
  }

  state.selectedFileId = fileId;
  trainerSection.classList.remove('hidden');
  trainerTitle.textContent = `Mapeamento Inteligente: ${f.parsedFile.fileName}`;

  if (state.memory.optionalLlm?.provider !== 'none' && state.memory.optionalLlm?.apiKey) {
    btnLlmAnalyze.classList.remove('hidden');
  } else {
    btnLlmAnalyze.classList.add('hidden');
  }

  // Status banner
  trainerAlert.classList.remove('hidden', 'matched', 'evolved', 'new');
  if (f.analysis.status === 'evolved') {
    trainerAlert.classList.add('evolved');
    const diffList = f.analysis.changesDetected.length
      ? `Alterações detectadas: ${f.analysis.changesDetected.join(' • ')}.`
      : 'Algumas colunas mudaram em relação ao modelo anterior.';
    trainerAlert.innerHTML = `<strong>Layout evoluído detectado!</strong> Similar a <em>"${escapeHtml(f.analysis.matchedProfileName)}"</em> (${f.analysis.matchSimilarity}%). ${escapeHtml(diffList)} Revise o mapeamento abaixo e clique em <strong>Treinar IA</strong> para consolidar o aprendizado.`;
  } else if (f.analysis.status === 'matched') {
    trainerAlert.classList.add('matched');
    trainerAlert.innerHTML = `<strong>Layout reconhecido na Memória da IA!</strong> Perfil <em>"${escapeHtml(f.analysis.matchedProfileName)}"</em> aplicado automaticamente com ${f.analysis.matchSimilarity}% de similaridade.`;
  } else {
    trainerAlert.classList.add('new');
    trainerAlert.innerHTML = `<strong>Novo layout analisado pela IA semântica</strong> (${f.analysis.avgConfidence}% de confiança média). Confirme ou ajuste as colunas abaixo e clique em <strong>Treinar IA e Aplicar Layout</strong> para que a IA memorize este padrão.`;
  }

  layoutNameInput.value =
    f.analysis.matchedProfileName ||
    suggestLayoutName(f.parsedFile);
  ruleDefaultSign.value = f.analysis.rules.defaultSign || 'auto';
  ruleRemovePipes.checked = f.analysis.rules.removePipes !== false;
  ruleCollapseSpaces.checked = f.analysis.rules.collapseSpaces !== false;
  ruleReplaceFrom.value = f.analysis.rules.customReplaceFrom || '';
  ruleReplaceTo.value = f.analysis.rules.customReplaceTo || '';

  renderMappingRows(f);
  renderFilesList();
}

function suggestLayoutName(parsedFile) {
  const base = parsedFile.fileName.replace(/\.(pdf|xlsx)$/i, '').replace(/[_-]+/g, ' ');
  return cleanWhitespace(base).slice(0, 48);
}

function renderMappingRows(f) {
  mappingTbody.innerHTML = '';
  const mappings = f.analysis.mappings;

  for (let i = 0; i < mappings.length; i++) {
    const m = mappings[i];
    const tr = document.createElement('tr');

    const confClass =
      m.confidence >= 85 ? 'conf-high' : m.confidence >= 65 ? 'conf-mid' : 'conf-low';
    const srcLabel = m.source === 'learned_profile' ? 'Memória' : 'Semântica';
    const changeBadge =
      m.changeType === 'added'
        ? '<span class="tag-change">NOVA</span>'
        : m.changeType === 'renamed'
        ? '<span class="tag-change">RENOMEADA</span>'
        : '';

    const samplesHtml = m.stats.samples
      .slice(0, 3)
      .map((s) => `<span class="sample-chip" title="${escapeHtml(s)}">${escapeHtml(s)}</span>`)
      .join('');

    const roleOpts = Object.entries(ROLE_LABELS)
      .map(
        ([val, lbl]) =>
          `<option value="${val}" ${m.role === val ? 'selected' : ''}>${escapeHtml(lbl)}</option>`
      )
      .join('');

    const isHist = m.role === ROLES.HISTORY;

    tr.innerHTML = `
      <td>
        <strong>${escapeHtml(m.header)}</strong>${changeBadge}
      </td>
      <td>
        <div class="sample-chips">${samplesHtml || '<span class="sample-chip">(vazio)</span>'}</div>
      </td>
      <td>
        <span class="conf-pill ${confClass}">${m.confidence}% • ${srcLabel}</span>
      </td>
      <td>
        <select class="role-select" data-col-idx="${m.colIdx}">${roleOpts}</select>
      </td>
      <td>
        ${
          isHist
            ? `<div class="order-btns">
                 <button class="order-btn btn-move-up" data-col-idx="${m.colIdx}" type="button" title="Mover antes no histórico">▲</button>
                 <span>#${m.historyOrder}</span>
                 <button class="order-btn btn-move-down" data-col-idx="${m.colIdx}" type="button" title="Mover depois no histórico">▼</button>
               </div>`
            : '<span style="color:var(--text-light);font-size:0.78rem;">—</span>'
        }
      </td>
    `;
    mappingTbody.appendChild(tr);
  }
}

function renderOutputSection() {
  if (state.files.length === 0) {
    outputSection.classList.add('hidden');
    return;
  }

  outputSection.classList.remove('hidden');
  const s = state.summary;

  kpiCount.textContent = String(state.unifiedRows.length);
  kpiPeriod.textContent = s.minDateBr ? `${s.minDateBr} a ${s.maxDateBr}` : 'Sem datas';
  kpiIn.textContent = formatValuePlainBr(s.totalIn);
  kpiInCount.textContent = `${s.inCount} recebimento(s)`;
  kpiOut.textContent = formatValuePlainBr(s.totalOut);
  kpiOutCount.textContent = `${s.outCount} pagamento(s)`;
  kpiNet.textContent = formatValuePlainBr(s.netTotal);
  kpiNet.style.color = s.netTotal >= 0 ? 'var(--emerald)' : 'var(--crimson)';
  kpiSkipped.textContent = `${s.skippedCount} linha(s) ignorada(s)`;

  const total = state.filteredRows.length;
  const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (state.currentPage > maxPage) state.currentPage = maxPage;

  const startIdx = (state.currentPage - 1) * PAGE_SIZE;
  const endIdx = Math.min(total, startIdx + PAGE_SIZE);
  const pageSlice = state.filteredRows.slice(startIdx, endIdx);

  previewTbody.innerHTML = '';
  if (pageSlice.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="3" style="text-align:center;padding:24px;color:var(--text-light);">Nenhum lançamento encontrado com o filtro atual.</td>`;
    previewTbody.appendChild(tr);
  } else {
    const frag = document.createDocumentFragment();
    for (const r of pageSlice) {
      const tr = document.createElement('tr');
      const valStr = formatValuePlainBr(r.value);
      const valCls = r.value < 0 ? 'val-neg' : 'val-pos';
      tr.innerHTML = `
        <td class="col-date">${escapeHtml(r.dateBr)}</td>
        <td class="col-val ${valCls}">${escapeHtml(valStr)}</td>
        <td class="col-hist" title="Origem: ${escapeHtml(r.sourceFile)}">${escapeHtml(r.history)}</td>
      `;
      frag.appendChild(tr);
    }
    previewTbody.appendChild(frag);
  }

  paginationInfo.textContent =
    total === 0
      ? '0 registros'
      : `Exibindo ${startIdx + 1}–${endIdx} de ${total} lançamentos (Página ${state.currentPage}/${maxPage})`;
  btnPrevPage.disabled = state.currentPage <= 1;
  btnNextPage.disabled = state.currentPage >= maxPage;

  btnExportXlsx.disabled = state.unifiedRows.length === 0;
  btnExportPdf.disabled = state.unifiedRows.length === 0;
}

async function processUploadedFiles(fileList) {
  const arr = [...fileList];
  if (arr.length === 0) return;

  let firstNeedsReview = null;

  for (const file of arr) {
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (ext !== 'pdf' && ext !== 'xlsx') {
      showToast(`Formato não suportado: ${file.name}. Use .pdf ou .xlsx.`, 'warn');
      continue;
    }

    try {
      const buf = await file.arrayBuffer();
      const parsedFile =
        ext === 'pdf'
          ? await parsePdfFile(buf, file.name, pdfjsLib)
          : await parseXlsxFile(buf, file.name, window.ExcelJS);

      const analysis = analyzeFileLayout(parsedFile, state.memory);
      const id = `file-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      state.memory.stats.totalFilesProcessed = (state.memory.stats.totalFilesProcessed || 0) + 1;
      if (analysis.status === 'matched') {
        state.memory.stats.autoMatchedCount = (state.memory.stats.autoMatchedCount || 0) + 1;
      }

      state.files.push({
        id,
        parsedFile,
        analysis,
        result: { records: [], skipped: [] },
      });

      if (!firstNeedsReview && (analysis.status === 'evolved' || analysis.status === 'new_layout')) {
        firstNeedsReview = id;
      }
    } catch (err) {
      console.error(err);
      showToast(`Erro ao ler "${file.name}": ${err.message}`, 'error');
    }
  }

  saveAiMemory(state.memory);
  updateAiBadge();
  rebuildUnifiedOutput();

  if (firstNeedsReview) {
    openTrainerForFile(firstNeedsReview);
    showToast('Novo layout ou alteração detectada! Verifique o Painel da IA.', 'warn');
  } else if (state.files.length > 0 && !state.selectedFileId) {
    openTrainerForFile(state.files[0].id);
    showToast(`${arr.length} arquivo(s) processado(s) com sucesso!`);
  }
}

// Event Listeners
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  if (e.dataTransfer?.files?.length) {
    processUploadedFiles(e.dataTransfer.files);
  }
});
fileInput.addEventListener('change', () => {
  if (fileInput.files?.length) {
    processUploadedFiles(fileInput.files);
    fileInput.value = '';
  }
});

btnClearFiles.addEventListener('click', () => {
  state.files = [];
  state.selectedFileId = null;
  trainerSection.classList.add('hidden');
  rebuildUnifiedOutput();
});

filesListEl.addEventListener('click', (e) => {
  const editBtn = e.target.closest('.btn-edit-layout');
  if (editBtn) {
    openTrainerForFile(editBtn.dataset.fileId);
    return;
  }
  const remBtn = e.target.closest('.btn-remove-file');
  if (remBtn) {
    const id = remBtn.dataset.fileId;
    state.files = state.files.filter((f) => f.id !== id);
    if (state.selectedFileId === id) {
      state.selectedFileId = state.files[0]?.id || null;
      if (state.selectedFileId) openTrainerForFile(state.selectedFileId);
      else trainerSection.classList.add('hidden');
    }
    rebuildUnifiedOutput();
  }
});

filesListEl.addEventListener('change', (e) => {
  const sel = e.target.closest('.sheet-select');
  if (!sel) return;
  const f = state.files.find((x) => x.id === sel.dataset.fileId);
  if (!f) return;
  const sheetObj = f.parsedFile.allSheetsData.find((s) => s.sheetName === sel.value);
  if (!sheetObj) return;
  f.parsedFile.sheetName = sheetObj.sheetName;
  f.parsedFile.headers = sheetObj.headers;
  f.parsedFile.rows = sheetObj.rows;
  f.parsedFile.bannerLines = sheetObj.bannerLines;
  f.analysis = analyzeFileLayout(f.parsedFile, state.memory);
  rebuildUnifiedOutput();
  if (state.selectedFileId === f.id) openTrainerForFile(f.id);
});

// Mapping table events
mappingTbody.addEventListener('change', (e) => {
  const sel = e.target.closest('.role-select');
  if (!sel) return;
  const f = state.files.find((x) => x.id === state.selectedFileId);
  if (!f) return;
  const colIdx = Number(sel.dataset.colIdx);
  const m = f.analysis.mappings.find((x) => x.colIdx === colIdx);
  if (m) {
    m.role = sel.value;
    renderMappingRows(f);
    rebuildUnifiedOutput();
  }
});

mappingTbody.addEventListener('click', (e) => {
  const up = e.target.closest('.btn-move-up');
  const down = e.target.closest('.btn-move-down');
  if (!up && !down) return;
  const f = state.files.find((x) => x.id === state.selectedFileId);
  if (!f) return;
  const colIdx = Number((up || down).dataset.colIdx);
  const histMaps = f.analysis.mappings
    .filter((m) => m.role === ROLES.HISTORY)
    .sort((a, b) => a.historyOrder - b.historyOrder);
  const pos = histMaps.findIndex((m) => m.colIdx === colIdx);
  if (pos === -1) return;
  const targetPos = up ? pos - 1 : pos + 1;
  if (targetPos < 0 || targetPos >= histMaps.length) return;
  const tmp = histMaps[pos].historyOrder;
  histMaps[pos].historyOrder = histMaps[targetPos].historyOrder;
  histMaps[targetPos].historyOrder = tmp;
  renderMappingRows(f);
  rebuildUnifiedOutput();
});

[ruleDefaultSign, ruleRemovePipes, ruleCollapseSpaces, ruleReplaceFrom, ruleReplaceTo].forEach((el) => {
  el.addEventListener('change', () => {
    const f = state.files.find((x) => x.id === state.selectedFileId);
    if (!f) return;
    f.analysis.rules.defaultSign = ruleDefaultSign.value;
    f.analysis.rules.removePipes = ruleRemovePipes.checked;
    f.analysis.rules.collapseSpaces = ruleCollapseSpaces.checked;
    f.analysis.rules.customReplaceFrom = ruleReplaceFrom.value;
    f.analysis.rules.customReplaceTo = ruleReplaceTo.value;
    rebuildUnifiedOutput();
  });
});

btnTrainApply.addEventListener('click', () => {
  const f = state.files.find((x) => x.id === state.selectedFileId);
  if (!f) return;

  f.analysis.rules.defaultSign = ruleDefaultSign.value;
  f.analysis.rules.removePipes = ruleRemovePipes.checked;
  f.analysis.rules.collapseSpaces = ruleCollapseSpaces.checked;
  f.analysis.rules.customReplaceFrom = ruleReplaceFrom.value;
  f.analysis.rules.customReplaceTo = ruleReplaceTo.value;

  state.memory = trainAiWithLayout(f.parsedFile, f.analysis, layoutNameInput.value, state.memory);
  f.analysis.status = 'matched';
  f.analysis.matchSimilarity = 100;
  f.analysis.changesDetected = [];

  updateAiBadge();
  rebuildUnifiedOutput();
  openTrainerForFile(f.id);
  showToast(`IA treinada! Layout "${layoutNameInput.value}" memorizado com sucesso.`);
});

btnCloseTrainer.addEventListener('click', () => {
  trainerSection.classList.add('hidden');
  state.selectedFileId = null;
  renderFilesList();
});

btnLlmAnalyze.addEventListener('click', async () => {
  const f = state.files.find((x) => x.id === state.selectedFileId);
  if (!f) return;
  try {
    btnLlmAnalyze.disabled = true;
    btnLlmAnalyze.textContent = 'Analisando...';
    const llmRes = await analyzeWithOptionalLlm(f.parsedFile, state.memory.optionalLlm);
    if (llmRes.layoutName) layoutNameInput.value = llmRes.layoutName;
    if (llmRes.defaultSign) f.analysis.rules.defaultSign = llmRes.defaultSign;
    llmRes.roles.forEach((r, idx) => {
      if (f.analysis.mappings[idx] && Object.values(ROLES).includes(r)) {
        f.analysis.mappings[idx].role = r;
      }
    });
    openTrainerForFile(f.id);
    rebuildUnifiedOutput();
    showToast('Mapeamento sugerido pelo LLM aplicado!');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btnLlmAnalyze.disabled = false;
    btnLlmAnalyze.textContent = 'Analisar via LLM';
  }
});

// Filters & Pagination
searchInput.addEventListener('input', () => {
  state.searchTerm = searchInput.value;
  applyFilters();
  renderOutputSection();
});

document.querySelectorAll('.pill[data-filter]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.pill[data-filter]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.typeFilter = btn.dataset.filter;
    applyFilters();
    renderOutputSection();
  });
});

btnPrevPage.addEventListener('click', () => {
  if (state.currentPage > 1) {
    state.currentPage--;
    renderOutputSection();
  }
});

btnNextPage.addEventListener('click', () => {
  const maxPage = Math.max(1, Math.ceil(state.filteredRows.length / PAGE_SIZE));
  if (state.currentPage < maxPage) {
    state.currentPage++;
    renderOutputSection();
  }
});

// Exporters
btnExportXlsx.addEventListener('click', async () => {
  try {
    const stamp = new Date().toISOString().slice(0, 10);
    await exportToXlsx(state.unifiedRows, `Conciliacao_Custodio_${stamp}.xlsx`, window.ExcelJS);
    showToast('Arquivo .xlsx exportado com sucesso!');
  } catch (err) {
    showToast(`Erro ao exportar .xlsx: ${err.message}`, 'error');
  }
});

btnExportPdf.addEventListener('click', () => {
  try {
    const stamp = new Date().toISOString().slice(0, 10);
    exportToPdf(state.unifiedRows, state.summary, `Conciliacao_Custodio_${stamp}.pdf`);
    showToast('Arquivo .pdf exportado com sucesso!');
  } catch (err) {
    showToast(`Erro ao exportar .pdf: ${err.message}`, 'error');
  }
});

// Modal: Memória da IA
function renderAiModal() {
  memStatProfiles.textContent = String(state.memory.learnedProfiles.length);
  memStatFiles.textContent = String(state.memory.stats.totalFilesProcessed || 0);
  memStatCorr.textContent = String(state.memory.stats.correctionsLearned || 0);
  memStatTokens.textContent = String(Object.keys(state.memory.tokenWeights).length);

  // Profiles tab
  if (state.memory.learnedProfiles.length === 0) {
    mtabProfiles.innerHTML = `<p style="color:var(--text-light);font-size:0.86rem;">Nenhum layout personalizado foi treinado ainda. Importe um arquivo e clique em <strong>Treinar IA e Aplicar Layout</strong> para começar.</p>`;
  } else {
    mtabProfiles.innerHTML = state.memory.learnedProfiles
      .map((p) => {
        const cols = p.mappings
          .map((m) => `<span class="col-tag"><strong>${escapeHtml(m.header)}</strong> → ${escapeHtml(ROLE_LABELS[m.role] || m.role)}</span>`)
          .join('');
        return `
          <div class="profile-item">
            <div class="profile-item-head">
              <div>
                <strong>${escapeHtml(p.name)}</strong>
                <span class="ext-badge ${p.fileType === 'pdf' ? 'ext-pdf' : 'ext-xlsx'}" style="margin-left:6px;">${p.fileType}</span>
              </div>
              <div style="display:flex;align-items:center;gap:8px;">
                <span style="font-size:0.75rem;color:var(--text-light);">Usos: ${p.usageCount || 1}</span>
                <button class="btn btn-sm btn-danger-outline btn-del-profile" data-prof-id="${p.id}" type="button">Excluir</button>
              </div>
            </div>
            <div class="profile-cols">${cols}</div>
          </div>
        `;
      })
      .join('');
  }

  // Logs tab
  mtabLogs.innerHTML = state.memory.learningLog
    .map((l) => {
      const dt = new Date(l.timestamp).toLocaleString('pt-BR');
      return `
        <div class="log-item">
          <div style="display:flex;justify-content:space-between;gap:8px;">
            <strong style="font-size:0.85rem;">${escapeHtml(l.message)}</strong>
            <span style="font-size:0.74rem;color:var(--text-light);white-space:nowrap;">${dt}</span>
          </div>
          <div style="font-size:0.8rem;color:var(--text-muted);margin-top:3px;">${escapeHtml(l.details)}</div>
        </div>
      `;
    })
    .join('');

  llmProviderEl.value = state.memory.optionalLlm?.provider || 'none';
  llmApiKeyEl.value = state.memory.optionalLlm?.apiKey || '';
}

btnAiMemory.addEventListener('click', () => {
  renderAiModal();
  aiModal.classList.remove('hidden');
});

btnCloseModal.addEventListener('click', () => aiModal.classList.add('hidden'));
aiModal.addEventListener('click', (e) => {
  if (e.target === aiModal) aiModal.classList.add('hidden');
});

document.querySelectorAll('.mtab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mtab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.mtab;
    mtabProfiles.classList.toggle('hidden', tab !== 'profiles');
    mtabLogs.classList.toggle('hidden', tab !== 'logs');
    mtabSettings.classList.toggle('hidden', tab !== 'settings');
  });
});

mtabProfiles.addEventListener('click', (e) => {
  const del = e.target.closest('.btn-del-profile');
  if (!del) return;
  state.memory.learnedProfiles = state.memory.learnedProfiles.filter((p) => p.id !== del.dataset.profId);
  saveAiMemory(state.memory);
  updateAiBadge();
  renderAiModal();
  showToast('Perfil removido da memória da IA.');
});

btnExportMemory.addEventListener('click', () => {
  const json = JSON.stringify(state.memory, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'custodio-ia-memoria.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

importMemoryInput.addEventListener('change', async () => {
  const file = importMemoryInput.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (!parsed.tokenWeights || !Array.isArray(parsed.learnedProfiles)) {
      throw new Error('Arquivo JSON inválido.');
    }
    state.memory = parsed;
    saveAiMemory(state.memory);
    updateAiBadge();
    renderAiModal();
    showToast('Memória da IA importada com sucesso!');
  } catch (err) {
    showToast(`Erro ao importar memória: ${err.message}`, 'error');
  } finally {
    importMemoryInput.value = '';
  }
});

btnResetMemory.addEventListener('click', () => {
  state.memory = resetAiMemory();
  updateAiBadge();
  renderAiModal();
  showToast('Memória da IA restaurada para o padrão inicial.', 'warn');
});

btnSaveLlm.addEventListener('click', () => {
  state.memory.optionalLlm = {
    provider: llmProviderEl.value,
    apiKey: llmApiKeyEl.value.trim(),
    model: '',
  };
  saveAiMemory(state.memory);
  if (state.selectedFileId) openTrainerForFile(state.selectedFileId);
  showToast('Configuração de LLM salva localmente no navegador.');
});

// Demo: Simula arquivo de layout novo/evoluído para testar a IA instantaneamente
btnDemo.addEventListener('click', () => {
  state.files = [];
  state.selectedFileId = null;

  const demoPag = {
    fileName: 'Exemplo_Pagamentos_Itau_Layout_Novo.xlsx',
    fileType: 'xlsx',
    sheetName: 'Pagamentos',
    availableSheets: [{ name: 'Pagamentos', rowCount: 3 }],
    headers: ['DATA PAGAMENTO', 'TÍTULO', 'TIPO', 'FORNECEDOR', 'VALOR PAGO', 'LOCAL | CENTRO DE CUSTO | NATUREZA', 'OBSERVAÇÃO OBRA'],
    rows: [
      ['02/09/2026', '02092026', 'FOLHA DE PAGAMENTO', 'SILVESTRE ABELARDO ENGENHARIA', '-R$ 2.000,00', '154 - E801-T-ADAPTOGEN-SP-2026 | 04.02 | 2.14.017 - PRESTADOR DE SERVIÇO', 'Aprovado Eng.'],
      ['04/09/2026', '814-1', 'RECIBOS', 'HORTIFRUTI INHANGA LTDA', '-R$ 532,00', '1001.004 - ADMINISTRATIVO | 04.01 | 2.07.019 - OUTRAS DESPESAS', 'Copa Matriz'],
      ['09/09/2026', 'REN_LINEAR-2', 'RENEGOCIAÇÃO', 'LINEAR SERVIÇOS AR CONDICIONADO', '-R$ 29.250,00', '137 - E462-O-OCEANERRING-RJ-2025 | 02.01 | 2.02.002 - AR CONDICIONADO', 'Parcela 2'],
    ],
    bannerLines: ['CUSTÓDIO SOLUÇÕES EM CONSTRUÇÕES LTDA'],
    skippedRows: 0,
  };

  const demoRec = {
    fileName: 'Exemplo_Recebimentos_Layout_Banco.xlsx',
    fileType: 'xlsx',
    sheetName: 'Extrato',
    availableSheets: [{ name: 'Extrato', rowCount: 3 }],
    headers: ['Dt. Mov.', 'Doc.', 'Histórico Banco', 'Entrada (+)', 'Saída (-)', 'Saldo Dia'],
    rows: [
      ['02/09/2026', 'TRF-93593', 'TRANSFERENCIA CUSTODIO SOLUCOES', '8.002,12', '', '8.002,12'],
      ['08/09/2026', '182-1', 'CORINTOS LOGISTICA COMERCIO EXTERIOR | CLIENTES', '89.628,03', '', '97.630,15'],
      ['10/09/2026', 'TAR-001', 'TARIFA MANUTENCAO CONTA', '', '45,90', '97.584,25'],
    ],
    bannerLines: ['Extrato Bancário Modelo Variável'],
    skippedRows: 0,
  };

  for (const pf of [demoPag, demoRec]) {
    const analysis = analyzeFileLayout(pf, state.memory);
    state.files.push({
      id: `demo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      parsedFile: pf,
      analysis,
      result: { records: [], skipped: [] },
    });
  }

  rebuildUnifiedOutput();
  openTrainerForFile(state.files[1].id);
  showToast('Exemplo de layout variável carregado! Observe como a IA separou Entrada/Saída e ignorou Saldo Dia.');
});

// Init
updateAiBadge();
