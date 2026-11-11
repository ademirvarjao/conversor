/**
 * Conversor — Parsers de Entrada (.pdf e .xlsx)
 *
 * Estratégia:
 *  - PDF: o PDF.js extrai os fragmentos de texto com coordenadas; a reconstrução
 *    das colunas (geometria) é feita por funções puras e testáveis
 *    (`buildTableFromTextLines`), sem dependência do navegador.
 *  - XLSX: lido via ExcelJS, com detecção automática de banners, cabeçalho
 *    multi-linha e remoção de linhas de total/resumo.
 */

import { formatIsoToBrDate } from './format.js';

// Reexportado para conveniência de quem consome o parser (app, testes).
export { formatIsoToBrDate };

/** Limite defensivo de colunas lidas por planilha (evita planilhas "infinitas"). */
const MAX_COLUMNS = 256;

/** Limite defensivo de linhas de dados por arquivo. */
const MAX_DATA_ROWS = 200000;

/** Tolerância vertical (pt) para considerar fragmentos na mesma linha visual. */
const LINE_TOLERANCE = 2.5;

export function cleanWhitespace(str) {
  return String(str ?? '')
    .replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeText(str) {
  return cleanWhitespace(str)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export function tokenizeHeader(str) {
  return normalizeText(str)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/* -------------------------------------------------------------------------- */
/*                                   Datas                                    */
/* -------------------------------------------------------------------------- */

function pad(value, size = 2) {
  return String(value).padStart(size, '0');
}

/**
 * Monta uma data ISO apenas se ela existir de verdade no calendário
 * (impede 31/02/2026 ou 00/00/0000).
 */
export function buildIsoDate(year, month, day) {
  if (![year, month, day].every(Number.isInteger)) return null;
  if (year < 1900 || year > 2199 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    return null;
  }
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

/** Expande anos de 2 dígitos: 00–69 → 2000–2069; 70–99 → 1970–1999. */
function expandTwoDigitYear(yy) {
  return yy <= 69 ? 2000 + yy : 1900 + yy;
}

export function excelSerialToIso(serial) {
  if (!Number.isFinite(serial) || serial <= 0) return null;
  // Época do Excel (com o bug histórico de 1900): 1899-12-30.
  const utcMs = Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000;
  const date = new Date(utcMs);
  const iso = buildIsoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  return iso;
}

/**
 * Interpreta datas nos formatos usuais de relatórios financeiros.
 * Aceita Date e textos BR/ISO. Retorna 'YYYY-MM-DD' ou null.
 *
 * Números NÃO são tratados como serial do Excel por padrão: em conciliações
 * um número como 45000 costuma ser R$ 45.000,00, não uma data. Use a opção
 * `allowExcelSerial` (ou `excelSerialToIso`) quando souber que a coluna é data.
 */
export function parseDateValue(value, { allowExcelSerial = false } = {}) {
  if (value == null || value === '') return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    // Os valores de data do Excel/ExcelJS são gravados em UTC (meia-noite).
    return buildIsoDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    if (allowExcelSerial) return excelSerialToIso(value);
    return null;
  }

  const text = cleanWhitespace(value);
  if (!text || text.length > 40) return null;

  // dd/mm/yyyy | dd-mm-yyyy | dd.mm.yyyy (opcionalmente com hora)
  let match = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})(?:[\sT].*)?$/.exec(text);
  if (match) {
    return buildIsoDate(Number(match[3]), Number(match[2]), Number(match[1]));
  }

  // dd/mm/yy
  match = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2})$/.exec(text);
  if (match) {
    return buildIsoDate(expandTwoDigitYear(Number(match[3])), Number(match[2]), Number(match[1]));
  }

  // yyyy-mm-dd | yyyy/mm/dd (opcionalmente com hora)
  match = /^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})(?:[\sT].*)?$/.exec(text);
  if (match) {
    return buildIsoDate(Number(match[1]), Number(match[2]), Number(match[3]));
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/*                                  Valores                                   */
/* -------------------------------------------------------------------------- */

const CURRENCY_SYMBOLS = /R\$|US\$|BRL|USD|EUR|GBP|\$|€|£/gi;
const D_C_SUFFIX = /\s*[([]?\s*([DCdc])\s*[)\]]?$/;

/**
 * Interpreta valores monetários nos formatos:
 *   -R$ 2.000,00 | R$ 8.002,12 | 1234,56 | -1234.56 | (1.234,56)
 *   1.234,56 D | 1.234,56 C | 1.234,56- | 12.345,67 R$
 *
 * Retorna { value, hasExplicitSign, dcTag } ou null.
 */
export function parseMoneyValue(raw) {
  if (raw == null || raw === '') return null;

  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    return { value: Math.round(raw * 100) / 100, hasExplicitSign: raw < 0, dcTag: null };
  }

  let text = cleanWhitespace(raw).replace(/[\u2212\u2013\u2014]/g, '-');
  if (!text || text.length > 40) return null;

  // Datas e códigos com barras não são valores monetários.
  if (/^\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}$/.test(text) && /[/]/.test(text)) return null;
  if (!/\d/.test(text)) return null;

  let dcTag = null;
  const dcMatch = D_C_SUFFIX.exec(text);
  if (dcMatch) {
    dcTag = dcMatch[1].toUpperCase();
    text = text.slice(0, dcMatch.index).trim();
    if (!text) return null;
  }

  let negative = false;
  let hasExplicitSign = false;

  if (/^\(.*\)$/.test(text)) {
    negative = true;
    hasExplicitSign = true;
    text = text.slice(1, -1).trim();
  }

  // Símbolos de moeda antes/depois do número
  text = text.replace(CURRENCY_SYMBOLS, ' ').trim();

  if (/^-/.test(text)) {
    negative = true;
    hasExplicitSign = true;
    text = text.slice(1).trim();
  } else if (/^\+/.test(text)) {
    hasExplicitSign = true;
    text = text.slice(1).trim();
  } else if (/-$/.test(text)) {
    // Formato contábil "1.234,56-"
    negative = true;
    hasExplicitSign = true;
    text = text.slice(0, -1).trim();
  }

  if (dcTag === 'D') {
    negative = true;
    hasExplicitSign = true;
  } else if (dcTag === 'C') {
    negative = false;
    hasExplicitSign = true;
  }

  // Remove espaços internos ("2 .000,00") e asteriscos de destaque.
  text = text.replace(/[\s*]/g, '');

  if (!/^\d[\d.,]*$/.test(text)) return null;

  const hasComma = text.includes(',');
  const hasDot = text.includes('.');

  // Códigos/documentos com zero à esquerda (ex.: "02092026") não são valores.
  if (!hasComma && !hasDot && /^0\d/.test(text)) return null;
  let normalized;

  if (hasComma && hasDot) {
    // O separador decimal é o último a aparecer: 1.234,56 (BR) | 1,234.56 (US)
    normalized =
      text.lastIndexOf(',') > text.lastIndexOf('.')
        ? text.replace(/\./g, '').replace(',', '.')
        : text.replace(/,/g, '');
  } else if (hasComma) {
    const parts = text.split(',');
    // "1,234" e "1,234,567" tendem a ser separador de milhar (sem centavos)
    const isThousands =
      parts.length > 2 || (parts.length === 2 && parts[1].length === 3 && parts[0].length <= 3);
    normalized = isThousands ? text.replace(/,/g, '') : text.replace(',', '.');
  } else if (hasDot) {
    const parts = text.split('.');
    const isThousands =
      parts.length > 2 || (parts.length === 2 && parts[1].length === 3 && parts[0].length <= 3);
    normalized = isThousands ? text.replace(/\./g, '') : text;
  } else {
    normalized = text;
  }

  const num = Number(normalized);
  if (!Number.isFinite(num)) return null;

  const signed = negative ? -Math.abs(num) : num;
  return { value: Math.round(signed * 100) / 100, hasExplicitSign, dcTag };
}

/* -------------------------------------------------------------------------- */
/*                             Células de planilha                            */
/* -------------------------------------------------------------------------- */

function cellToString(value) {
  if (value == null) return '';
  if (value instanceof Date) {
    return formatIsoToBrDate(parseDateValue(value));
  }
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((r) => r?.text ?? '').join('');
    if (value.text != null) return String(value.text);
    if (value.result !== undefined) return cellToString(value.result);
    if (value.hyperlink) return String(value.hyperlink);
    if (value.error) return '';
    if (value.formula || value.sharedFormula) return '';
    return '';
  }
  return String(value);
}

/**
 * Extrai o valor "bruto" de uma célula do ExcelJS, resolvendo fórmulas,
 * rich text e links. Datas e números permanecem com o tipo original.
 */
function cellToRawValue(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || value instanceof Date) return value;
  if (value.result !== undefined) return cellToRawValue(value.result);
  if (Array.isArray(value.richText)) return value.richText.map((r) => r?.text ?? '').join('');
  if (value.text != null) return value.text;
  if (value.error) return '';
  if (value.hyperlink) return value.hyperlink;
  return null;
}

const NOISE_ROW_PREFIX =
  /^(total|totais|subtotal|saldo\s+(anterior|atual|final|inicial|do\s+dia|em\s+conta)|resumo|pagina\s+\d+|emitido\s+em|gerado\s+em|relatorio\s+gerado)/;

export function isSummaryOrNoiseRow(rowCells) {
  const joined = normalizeText(rowCells.map(cellToString).join(' '));
  if (!joined) return true;
  if (NOISE_ROW_PREFIX.test(joined)) return true;

  const nonEmpty = rowCells.filter((cell) => cleanWhitespace(cellToString(cell)) !== '');
  if (
    nonEmpty.length <= 2 &&
    /\b(total|saldo|cnpj|cpf|periodo|conciliacao|agencia|conta corrente)\b/.test(joined)
  ) {
    return true;
  }
  return false;
}

const HEADER_KEYWORD_RE =
  /\b(data|dt|valor|vr|vlr|vl|historico|descricao|desc|titulo|tipo|fornecedor|cliente|favorecido|beneficiario|centro|natureza|credito|debito|devedor|credor|lancamento|documento|doc|nf|observacao|obs|saldo|entrada|saida|banco|conta|parcela|complemento|local|categoria|plano|forma|pagamento|recebimento|vencimento|competencia|emissao|movimento)\b/;

/**
 * Converte as abas de um workbook em tabelas { headers, rows }.
 * Função pura (recebe um workbook já carregado) — facilita testes.
 */
export function extractSheetsFromWorkbook(workbook) {
  const sheets = [];

  for (const worksheet of workbook.worksheets) {
    if (worksheet.state === 'hidden' || worksheet.state === 'veryHidden') continue;

    // Células mescladas: só a célula "mestre" carrega o valor; as demais são
    // ignoradas para não duplicar banners e títulos.
    const mergedSlaves = new Set();
    const mergedRanges = worksheet.model?.merges || [];
    for (const rangeRef of mergedRanges) {
      const [startRef, endRef] = String(rangeRef).split(':');
      const start = decodeCellRef(startRef);
      const end = decodeCellRef(endRef || startRef);
      if (!start || !end) continue;
      for (let row = start.row; row <= end.row; row++) {
        for (let col = start.col; col <= end.col; col++) {
          if (row === start.row && col === start.col) continue;
          mergedSlaves.add(`${row}:${col}`);
        }
      }
    }

    const rawRows = [];
    let maxCols = 0;

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const cellCount = Math.min(Math.max(row.cellCount || 0, 0), MAX_COLUMNS);
      const cells = [];
      for (let col = 1; col <= cellCount; col++) {
        if (mergedSlaves.has(`${rowNumber}:${col}`)) {
          cells.push(null);
          continue;
        }
        cells.push(cellToRawValue(row.getCell(col).value));
      }
      while (cells.length > 0 && cleanWhitespace(cellToString(cells[cells.length - 1])) === '') {
        cells.pop();
      }
      if (cells.length === 0) return;
      maxCols = Math.max(maxCols, cells.length);
      rawRows.push({ rowNumber, cells });
    });

    if (rawRows.length === 0) continue;
    for (const row of rawRows) {
      while (row.cells.length < maxCols) row.cells.push(null);
    }

    const headerIdx = detectHeaderRowIndex(rawRows, maxCols);
    let headers;
    let dataStartIdx;
    let bannerLines = [];

    if (headerIdx === -1) {
      headers = Array.from({ length: maxCols }, (_, idx) => `Coluna ${idx + 1}`);
      dataStartIdx = 0;
    } else {
      bannerLines = rawRows
        .slice(0, headerIdx)
        .map((row) => cleanWhitespace(row.cells.map(cellToString).join(' ')))
        .filter(Boolean);
      headers = rawRows[headerIdx].cells.map((cell, idx) => {
        const text = cleanWhitespace(cellToString(cell));
        return text || `Coluna ${idx + 1}`;
      });
      dataStartIdx = headerIdx + 1;
    }

    // Descarta colunas 100% vazias (sem título próprio e sem dados).
    const activeColIndices = [];
    const dataRows = rawRows.slice(dataStartIdx);
    for (let col = 0; col < maxCols; col++) {
      const hasOwnHeader = headers[col] && !/^Coluna \d+$/.test(headers[col]);
      const hasData = dataRows.some((row) => cleanWhitespace(cellToString(row.cells[col])) !== '');
      if (hasOwnHeader || hasData) activeColIndices.push(col);
    }

    const cleanHeaders = activeColIndices.map((col) => headers[col]);
    const headerSignature = cleanHeaders.map((header) => normalizeText(header)).join('|');
    const rows = [];
    let skippedRows = 0;

    for (const rawRow of dataRows) {
      if (rows.length >= MAX_DATA_ROWS) {
        skippedRows += rawRow ? 1 : 0;
        continue;
      }
      const slice = activeColIndices.map((col) => rawRow.cells[col] ?? null);
      if (isSummaryOrNoiseRow(slice)) {
        skippedRows++;
        continue;
      }
      const normalized = slice.map((cell) => normalizeText(cellToString(cell)));
      if (normalized.join('|') === headerSignature) {
        skippedRows++;
        continue;
      }
      rows.push(slice);
    }

    if (rows.length === 0) {
      // Aba apenas com cabeçalho/banner: mantém para permitir troca manual de aba,
      // porém não compete com abas que possuem dados.
      sheets.push({
        sheetName: worksheet.name,
        headers: cleanHeaders,
        rows: [],
        bannerLines,
        skippedRows,
      });
      continue;
    }

    sheets.push({
      sheetName: worksheet.name,
      headers: cleanHeaders,
      rows,
      bannerLines,
      skippedRows,
    });
  }

  return sheets;
}

function decodeCellRef(ref) {
  const match = /^([A-Z]+)(\d+)$/i.exec(String(ref ?? '').trim());
  if (!match) return null;
  return { col: columnLetterToNumber(match[1]), row: Number(match[2]) };
}

function columnLetterToNumber(letters) {
  let value = 0;
  for (const char of letters.toUpperCase()) {
    value = value * 26 + (char.charCodeAt(0) - 64);
  }
  return value;
}

/**
 * Descobre a linha de cabeçalho analisando densidade, tipo de conteúdo e a
 * presença de datas/valores nas linhas seguintes. Retorna -1 quando o arquivo
 * aparenta ser uma tabela sem cabeçalho.
 */
function detectHeaderRowIndex(rawRows, maxCols) {
  const scanLimit = Math.min(Math.max(rawRows.length - 1, 0), 25);
  let bestIdx = -1;
  let bestScore = 0;
  let firstRowHasDate = parseDateValue(rawRows[0].cells.find((cell) => parseDateValue(cell))) !== null;

  for (let i = 0; i < scanLimit; i++) {
    const cells = rawRows[i].cells;
    const nonEmpty = cells.filter((cell) => cleanWhitespace(cellToString(cell)) !== '');
    if (nonEmpty.length < 2) continue;

    const textOnly = nonEmpty.filter(
      (cell) => parseDateValue(cell) === null && parseMoneyValue(cell) === null
    );
    const textRatio = textOnly.length / nonEmpty.length;
    if (textRatio < 0.5) continue;

    let nextDataSignal = 0;
    for (let k = i + 1; k < Math.min(rawRows.length, i + 6); k++) {
      const nextCells = rawRows[k].cells;
      if (nextCells.some((cell) => parseDateValue(cell) !== null)) nextDataSignal += 2;
      if (nextCells.some((cell) => parseMoneyValue(cell) !== null)) nextDataSignal += 1.5;
    }

    const keywordHits = nonEmpty.filter((cell) =>
      HEADER_KEYWORD_RE.test(normalizeText(cellToString(cell)))
    ).length;

    const score =
      textRatio * 3 + nonEmpty.length * 0.6 + nextDataSignal + keywordHits * 2.5;

    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  if (bestIdx === -1) return firstRowHasDate ? -1 : 0;
  if (firstRowHasDate && bestScore < 4) return -1;
  return bestIdx;
}

/**
 * Parser de arquivos .xlsx (usando ExcelJS).
 * Retorna a aba com mais linhas de dados e mantém todas as abas disponíveis.
 */
export async function parseXlsxFile(arrayBuffer, fileName, ExcelJSRef) {
  const ExcelJS = ExcelJSRef || (typeof window !== 'undefined' ? window.ExcelJS : undefined);
  if (!ExcelJS) throw new Error('Biblioteca ExcelJS não carregada.');

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(arrayBuffer);
  } catch (error) {
    throw new Error(`Não foi possível ler "${fileName}" como planilha .xlsx (${error.message}).`);
  }

  const sheets = extractSheetsFromWorkbook(workbook);
  if (sheets.length === 0) {
    throw new Error(`Nenhuma aba visível com dados encontrada em "${fileName}".`);
  }

  const withData = sheets.filter((sheet) => sheet.rows.length > 0);
  if (withData.length === 0) {
    throw new Error(
      `Nenhuma linha de dados encontrada em "${fileName}". Verifique se a planilha possui cabeçalho e lançamentos.`
    );
  }

  // A aba com mais lançamentos é a mais provável de ser a conciliação.
  const best = [...withData].sort((a, b) => b.rows.length - a.rows.length)[0];

  return {
    fileName,
    fileType: 'xlsx',
    sheetName: best.sheetName,
    availableSheets: sheets.map((sheet) => ({
      name: sheet.sheetName,
      rowCount: sheet.rows.length,
    })),
    allSheetsData: sheets,
    headers: best.headers,
    rows: best.rows,
    bannerLines: best.bannerLines,
    skippedRows: best.skippedRows,
  };
}

/* -------------------------------------------------------------------------- */
/*                              PDF: extração                                 */
/* -------------------------------------------------------------------------- */

/**
 * Agrupa fragmentos de texto em linhas visuais.
 * Recebe itens { str, x, y, w, h } de uma página e devolve linhas ordenadas
 * de cima para baixo com itens da esquerda para a direita.
 */
export function groupItemsIntoLines(items, tolerance = LINE_TOLERANCE) {
  const usable = items.filter((item) => cleanWhitespace(item.str));
  if (usable.length === 0) return [];

  const sorted = [...usable].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  let current = null;

  for (const item of sorted) {
    if (!current || Math.abs(current.y - item.y) > tolerance) {
      current = { y: item.y, h: item.h, items: [item] };
      lines.push(current);
    } else {
      current.items.push(item);
      // Mantém a referência Y "média" para linhas levemente desalinhadas.
      current.y = (current.y * (current.items.length - 1) + item.y) / current.items.length;
      current.h = Math.max(current.h, item.h);
    }
  }

  for (const line of lines) line.items.sort((a, b) => a.x - b.x);
  return lines;
}

function isCurrencySymbolOnly(text) {
  return /^[-+]?\s*(R\$|US\$|\$|€|£)\s*$/i.test(text);
}

function isNumericToken(text) {
  return /^[-+(]?\s*\d[\d.,]*\s*[DCdc)\-]?$/.test(cleanWhitespace(text));
}

/** Junta símbolos de moeda isolados ao número imediatamente à direita. */
function mergeCurrencyTokens(items) {
  const merged = [];
  for (let i = 0; i < items.length; i++) {
    const current = items[i];
    const next = items[i + 1];
    if (next && isCurrencySymbolOnly(current.str) && isNumericToken(next.str)) {
      merged.push({
        x: current.x,
        y: current.y,
        w: next.x + next.w - current.x,
        h: Math.max(current.h, next.h),
        str: `${current.str} ${next.str}`,
        isCurrency: true,
        numRight: next.x + next.w,
      });
      i++;
    } else {
      merged.push({ ...current });
    }
  }
  return merged;
}

/**
 * Extrai as linhas de texto de um PDF usando o PDF.js.
 * Retorna { pageCount, lines } onde cada linha tem { page, y, h, items }.
 *
 * @param {ArrayBuffer|Uint8Array} arrayBuffer
 * @param {object} pdfjsLib  namespace do PDF.js (injetado para testes)
 * @param {{ onProgress?: (page:number, total:number)=>void, cMapUrl?: string, standardFontDataUrl?: string }} options
 */
export async function extractPdfLines(arrayBuffer, pdfjsLib, options = {}) {
  if (!pdfjsLib) throw new Error('Biblioteca PDF.js não carregada.');

  const {
    onProgress,
    cMapUrl = './vendor/pdfjs/cmaps/',
    standardFontDataUrl = './vendor/pdfjs/standard_fonts/',
  } = options;

  const data =
    arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);

  const loadingTask = pdfjsLib.getDocument({
    data,
    cMapUrl,
    cMapPacked: true,
    standardFontDataUrl,
    verbosity: 0,
  });

  let doc;
  try {
    doc = await loadingTask.promise;
  } catch (error) {
    const name = error?.name || '';
    if (name === 'PasswordException') {
      throw new Error('O PDF está protegido por senha. Remova a proteção e tente novamente.');
    }
    throw new Error(`Não foi possível abrir o PDF: ${error?.message || 'arquivo inválido ou corrompido'}.`);
  }

  const lines = [];
  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const items = [];

      for (const item of content.items) {
        if (!item?.str || !item.str.trim()) continue;
        const x = item.transform[4];
        const y = item.transform[5];
        items.push({
          str: item.str.trim(),
          x,
          y,
          w: item.width || 0,
          h: Math.abs(item.transform[3]) || item.height || 10,
        });
      }

      for (const line of groupItemsIntoLines(items)) {
        lines.push({
          page: pageNumber,
          y: line.y,
          h: line.h,
          items: mergeCurrencyTokens(line.items),
        });
      }

      if (typeof onProgress === 'function') onProgress(pageNumber, doc.numPages);
      page.cleanup?.();
    }
    return { pageCount: doc.numPages, lines };
  } finally {
    // Libera as estruturas internas do PDF.js (importante em PDFs grandes).
    try {
      await doc.destroy();
    } catch {
      /* ignora falhas de limpeza */
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                          PDF: geometria da tabela                          */
/* -------------------------------------------------------------------------- */

/** Agrupa posições X próximas em clusters (colunas candidatas). */
export function clusterPositions(xs, tolerance) {
  if (xs.length === 0) return [];
  const sorted = [...xs].sort((a, b) => a - b);
  const clusters = [{ sum: sorted[0], count: 1, min: sorted[0], max: sorted[0] }];

  for (let i = 1; i < sorted.length; i++) {
    const x = sorted[i];
    const last = clusters[clusters.length - 1];
    const mean = last.sum / last.count;
    if (x - mean <= tolerance) {
      last.sum += x;
      last.count += 1;
      last.max = x;
    } else {
      clusters.push({ sum: x, count: 1, min: x, max: x });
    }
  }

  return clusters.map((cluster) => ({
    anchor: cluster.sum / cluster.count,
    min: cluster.min,
    max: cluster.max,
    count: cluster.count,
  }));
}

function lineText(line) {
  return cleanWhitespace(line.items.map((item) => item.str).join(' '));
}

function isBannerOrSummary(text) {
  const norm = normalizeText(text);
  if (/\bpagina\s+\d+\s+de\s+\d+\b/.test(norm)) return true;
  return /^(total|totais|subtotal|saldo\s+(anterior|atual|final|inicial|do\s+dia)|resumo|pagina\s+\d+|emitido\s+em|gerado\s+em)\b/.test(
    norm
  );
}

/**
 * Reconstrói a tabela (cabeçalhos + linhas) a partir das linhas de texto
 * extraídas do PDF. Função pura e independente do PDF.js.
 *
 * @param {Array<{page:number,y:number,h:number,items:Array}>} allPageLines
 * @returns {{headers:string[],rows:string[][],bannerLines:string[],skippedRows:number,columnCount:number}}
 */
export function buildTableFromTextLines(allPageLines) {
  if (!Array.isArray(allPageLines) || allPageLines.length === 0) {
    throw new Error('Nenhum texto extraível encontrado no PDF (pode ser um documento digitalizado).');
  }

  // 1. Linhas candidatas a dados: contêm data + valor, ou data e 3+ colunas.
  const candidateDataLines = allPageLines.filter((line) => {
    const hasDate = line.items.some((item) => parseDateValue(item.str) !== null);
    const hasMoney = line.items.some((item) => parseMoneyValue(item.str) !== null);
    return (hasDate && hasMoney) || (hasDate && line.items.length >= 3);
  });

  if (candidateDataLines.length === 0) {
    throw new Error('Não foi possível identificar linhas tabulares com datas/valores no PDF.');
  }

  // 2. Descobrir âncoras de colunas pela frequência das posições X.
  const allItems = [];
  for (const line of candidateDataLines) {
    for (const item of line.items) {
      const right = item.numRight ?? item.x + (item.w || 0);
      allItems.push({ item, x: item.x, right, isMoney: parseMoneyValue(item.str) !== null });
    }
  }

  const rawClusters = clusterPositions(
    allItems.map((entry) => entry.x),
    14
  );
  const minSupport = Math.max(2, Math.floor(candidateDataLines.length * 0.3));

  let colClusters = rawClusters.filter((cluster) => {
    if (cluster.count >= minSupport) return true;
    // Preserva colunas raras que contenham valores monetários (ex.: "Crédito"
    // preenchido em poucas linhas).
    return allItems.some(
      (entry) => entry.isMoney && entry.x >= cluster.min - 2 && entry.x <= cluster.max + 2
    );
  });

  if (colClusters.length < 2) colClusters = rawClusters;
  colClusters.sort((a, b) => a.anchor - b.anchor);

  const itemsInCluster = (cluster) =>
    allItems.filter((entry) => entry.x >= cluster.min - 2 && entry.x <= cluster.max + 2);

  // Unir clusters de valores alinhados à direita (ex.: "12,50" e "150.000,00").
  let mergedRight = true;
  while (mergedRight && colClusters.length > 2) {
    mergedRight = false;
    for (let i = 0; i < colClusters.length - 1; i++) {
      const left = colClusters[i];
      const right = colClusters[i + 1];
      const leftItems = itemsInCluster(left);
      const rightItems = itemsInCluster(right);
      const leftMoneyRatio =
        leftItems.filter((entry) => entry.isMoney).length / Math.max(1, leftItems.length);
      const rightMoneyRatio =
        rightItems.filter((entry) => entry.isMoney).length / Math.max(1, rightItems.length);

      if (leftMoneyRatio >= 0.7 && rightMoneyRatio >= 0.7 && right.min - left.max <= 35) {
        const leftRight = leftItems.reduce((sum, entry) => sum + entry.right, 0) / leftItems.length;
        const rightRight =
          rightItems.reduce((sum, entry) => sum + entry.right, 0) / rightItems.length;
        if (Math.abs(leftRight - rightRight) <= 10) {
          left.min = Math.min(left.min, right.min);
          left.max = Math.max(left.max, right.max);
          left.anchor = (left.min + left.max) / 2;
          left.count += right.count;
          colClusters.splice(i + 1, 1);
          mergedRight = true;
          break;
        }
      }
    }
  }

  // Unir clusters que são continuação "inline" da mesma coluna lógica
  // (ex.: "154 - E801..." seguido alguns pontos depois por "04.02").
  let mergedInline = true;
  while (mergedInline && colClusters.length > 2) {
    mergedInline = false;
    for (let i = 0; i < colClusters.length - 1; i++) {
      const left = colClusters[i];
      const right = colClusters[i + 1];
      const boundary = (left.anchor + right.min) / 2;
      const previousBoundary = i === 0 ? -Infinity : (colClusters[i - 1].anchor + left.min) / 2;
      const nextBoundary =
        i + 2 < colClusters.length ? (right.anchor + colClusters[i + 2].min) / 2 : Infinity;

      let pairRows = 0;
      let typedRows = 0;
      let cleanGapRows = 0;

      for (const line of candidateDataLines) {
        const leftItems = line.items.filter((item) => item.x >= previousBoundary && item.x < boundary);
        const rightItems = line.items.filter((item) => item.x >= boundary && item.x < nextBoundary);
        if (leftItems.length === 0 || rightItems.length === 0) continue;

        pairRows++;
        const leftText = cleanWhitespace(leftItems.map((item) => item.str).join(' '));
        if (parseDateValue(leftText) !== null || parseMoneyValue(leftText) !== null) {
          typedRows++;
        }

        const lastLeft = leftItems[leftItems.length - 1];
        const leftRight = lastLeft.numRight ?? lastLeft.x + (lastLeft.w || 0);
        if (rightItems[0].x - leftRight >= 10) cleanGapRows++;
      }

      const isTypedColumn = pairRows > 0 && typedRows / pairRows >= 0.5;
      if (!isTypedColumn && pairRows > 0 && cleanGapRows / pairRows < 0.25) {
        left.max = Math.max(left.max, right.max);
        left.count += right.count;
        colClusters.splice(i + 1, 1);
        mergedInline = true;
        break;
      }
    }
  }

  // 3. Limites horizontais de cada coluna descoberta.
  const colBounds = colClusters.map((cluster, idx) => ({
    idx,
    anchor: cluster.anchor,
    start: idx === 0 ? -Infinity : cluster.min - 8,
    end: Infinity,
  }));

  for (let i = 0; i < colBounds.length - 1; i++) {
    const nextMin = colClusters[i + 1].min;
    const boundary = Math.max((colClusters[i].anchor + nextMin) / 2, nextMin - 10);
    colBounds[i].end = boundary;
    colBounds[i + 1].start = boundary;
  }

  const assignItemToColumn = (item) => {
    for (const bounds of colBounds) {
      if (item.x >= bounds.start && item.x < bounds.end) return bounds.idx;
    }
    let bestIdx = 0;
    let bestDistance = Infinity;
    for (const bounds of colBounds) {
      const distance = Math.abs(item.x - bounds.anchor);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIdx = bounds.idx;
      }
    }
    return bestIdx;
  };

  // 4. Localizar a zona de cabeçalho acima da primeira linha de dados.
  const firstDataLine = candidateDataLines[0];
  const linesAbove = allPageLines
    .filter((line) => line.page === firstDataLine.page && line.y > firstDataLine.y)
    .sort((a, b) => a.y - b.y); // mais próximas do dado primeiro

  const headerLines = [];
  const bannerLines = [];

  for (const line of linesAbove) {
    const text = lineText(line);
    const norm = normalizeText(text);
    const itemCount = line.items.length;
    const distance = line.y - firstDataLine.y;

    // Só a região imediatamente acima dos dados pode conter cabeçalho/banner.
    if (distance > 160) break;

    const isSummary = isBannerOrSummary(text);
    const isFarTitle = distance > 45;
    const isSingleCellBanner =
      itemCount === 1 &&
      (text.length > 25 ||
        /\b(cnpj|cpf|agencia|conta|periodo|emitido|extrato|relatorio|banco)\b/.test(norm));
    // Linhas de contexto/identificação ("Conta Corrente : 43812-5 TRELAR SUL...")
    // ficam coladas no cabeçalho, mas não são nomes de coluna: se entrassem,
    // virariam "Data Conta Corrente :" e atrapalhariam a classificação.
    const isContextLine = /[:=]/.test(text) && itemCount <= 4;

    if (isSummary || isFarTitle || isSingleCellBanner || isContextLine) {
      bannerLines.push(text);
      continue;
    }

    if (headerLines.length === 0) {
      headerLines.push(line);
      continue;
    }

    const previousY = headerLines[headerLines.length - 1].y;
    if (previousY - line.y <= 20 && headerLines.length < 3) {
      headerLines.push(line);
    } else {
      bannerLines.push(text);
    }
  }

  bannerLines.reverse();
  headerLines.sort((a, b) => b.y - a.y); // topo → base

  // 5. Mapear cada fragmento de cabeçalho à coluna mais provável.
  const headerParts = Array.from({ length: colBounds.length }, () => []);
  const colDataExtents = colBounds.map((bounds) => ({ minX: bounds.anchor, maxX: bounds.anchor + 40 }));

  for (const line of candidateDataLines.slice(0, 40)) {
    for (const item of line.items) {
      const colIdx = assignItemToColumn(item);
      colDataExtents[colIdx].minX = Math.min(colDataExtents[colIdx].minX, item.x);
      colDataExtents[colIdx].maxX = Math.max(
        colDataExtents[colIdx].maxX,
        item.x + (item.w || 20)
      );
    }
  }

  for (const headerLine of headerLines) {
    for (const item of headerLine.items) {
      const center = item.x + (item.w || 0) / 2;
      let bestCol = 0;
      let bestScore = -Infinity;
      for (let col = 0; col < colBounds.length; col++) {
        const extent = colDataExtents[col];
        const bounds = colBounds[col];
        const inExtent = center >= extent.minX - 10 && center <= extent.maxX + 10;
        const inBounds = center >= bounds.start && center < bounds.end;
        const distance = Math.abs(center - (extent.minX + extent.maxX) / 2);
        const score = (inExtent ? 1000 : 0) + (inBounds ? 500 : 0) - distance;
        if (score > bestScore) {
          bestScore = score;
          bestCol = col;
        }
      }
      headerParts[bestCol].push(item.str);
    }
  }

  const headers = headerParts.map((parts, idx) => cleanWhitespace(parts.join(' ')) || `Coluna ${idx + 1}`);

  // 6. Montar as linhas de dados de todas as páginas.
  const headerSignatures = new Set(headerLines.map((line) => normalizeText(lineText(line))));
  headerSignatures.add(normalizeText(headers.join(' ')));

  // Cada página repete o cabeçalho/rodapé ("Página : 2 / 6", nome da empresa,
  // filtros...). Tudo o que está acima da primeira linha de dados da página é
  // cabeçalho, não lançamento.
  const firstDataYByPage = new Map();
  for (const line of candidateDataLines) {
    const current = firstDataYByPage.get(line.page);
    if (current === undefined || line.y > current) firstDataYByPage.set(line.page, line.y);
  }

  const rows = [];
  const skipped = [];
  let lastRowPage = null;
  let lastRowY = null;

  for (const line of allPageLines) {
    const norm = normalizeText(lineText(line));
    if (!norm) continue;

    const cells = Array.from({ length: colBounds.length }, () => []);
    for (const item of line.items) cells[assignItemToColumn(item)].push(item.str);
    const rowStrings = cells.map((parts) => cleanWhitespace(parts.join(' ')));

    const hasDate = rowStrings.some((value) => parseDateValue(value) !== null);
    const nonEmptyCount = rowStrings.filter(Boolean).length;
    const text = lineText(line);

    // Cabeçalho de grupo de um relatório agrupado por cliente/fornecedor:
    // texto único, encostado na margem esquerda (à esquerda da 1ª coluna de
    // dados) e colado nas linhas de dados. Vira uma linha própria, usada pelo
    // conversor como prefixo do histórico dos lançamentos seguintes.
    const pageTopDataY = firstDataYByPage.get(line.page);
    // Positivo = a linha está acima da primeira linha de dados da página.
    const distanceAboveData = pageTopDataY === undefined ? 0 : line.y - pageTopDataY;
    const isSectionHeader =
      nonEmptyCount === 1 &&
      !hasDate &&
      text.length >= 3 &&
      text.length <= 120 &&
      !isBannerOrSummary(text) &&
      // No topo da página só aceitamos a seção colada na tabela; mais acima é
      // cabeçalho/razão social repetido pelo sistema emissor.
      (distanceAboveData <= 0 || distanceAboveData <= 40) &&
      line.items.every((item) => item.x <= colClusters[0].anchor + 6);

    // Linhas acima da primeira linha de dados da página são cabeçalho/banner.
    if (!isSectionHeader) {
      if (pageTopDataY !== undefined && line.y > pageTopDataY + LINE_TOLERANCE) continue;
      if (headerSignatures.has(norm)) {
        skipped.push(norm);
        continue;
      }
    }

    // Linhas de total/resumo só são descartadas quando não têm data própria:
    // um lançamento cujo histórico começa por "TOTAL ..." continua válido.
    if (headerSignatures.has(norm) || (isBannerOrSummary(text) && (!hasDate || nonEmptyCount <= 2))) {
      skipped.push(norm);
      continue;
    }

    if (hasDate) {
      rows.push(rowStrings);
      lastRowPage = line.page;
      lastRowY = line.y;
      continue;
    }

    if (isSectionHeader) {
      rows.push(rowStrings);
      lastRowPage = line.page;
      lastRowY = line.y;
      continue;
    }

    // Continuação de uma descrição quebrada em duas linhas no PDF: precisa
    // estar na mesma página e imediatamente abaixo — nunca no cabeçalho da
    // página seguinte (era o que colava "Página : 2 / 6" na última linha).
    const nearPreviousRow =
      lastRowPage === line.page && lastRowY !== null && lastRowY - line.y <= 24;
    if (rows.length > 0 && nonEmptyCount > 0 && nonEmptyCount <= 2 && nearPreviousRow) {
      const hasMoney = rowStrings.some((value) => parseMoneyValue(value) !== null);
      if (!hasMoney) {
        const previous = rows[rows.length - 1];
        for (let col = 0; col < rowStrings.length; col++) {
          if (rowStrings[col]) {
            previous[col] = cleanWhitespace(`${previous[col]} ${rowStrings[col]}`);
          }
        }
        lastRowY = line.y;
        continue;
      }
    }

    skipped.push(norm);
  }

  return {
    headers,
    rows,
    bannerLines: bannerLines.filter(Boolean),
    skippedRows: skipped.length,
    columnCount: colBounds.length,
  };
}

/**
 * Parser geométrico adaptativo de PDFs via PDF.js.
 * Extrai as linhas de texto e delega a reconstrução da tabela para
 * `buildTableFromTextLines`.
 */
export async function parsePdfFile(arrayBuffer, fileName, pdfjsLib, options = {}) {
  const { pageCount, lines } = await extractPdfLines(arrayBuffer, pdfjsLib, options);

  if (lines.length === 0) {
    throw new Error(
      `Nenhum texto extraível encontrado em "${fileName}". O PDF pode ser apenas imagem/escaneado.`
    );
  }

  let table;
  try {
    table = buildTableFromTextLines(lines);
  } catch (error) {
    throw new Error(`${error.message} (${fileName})`);
  }

  if (table.rows.length === 0) {
    throw new Error(`Nenhum lançamento com data foi reconhecido em "${fileName}".`);
  }

  return {
    fileName,
    fileType: 'pdf',
    pageCount,
    headers: table.headers,
    rows: table.rows,
    bannerLines: table.bannerLines,
    skippedRows: table.skippedRows,
  };
}
