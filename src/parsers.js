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

/**
 * Limite de células por intervalo mesclado. Acima disso o intervalo é ignorado:
 * um "merge" de aba inteira (comum em relatórios antigos) custaria centenas de
 * milhares de entradas no Set e travaria a leitura sem melhorar o resultado.
 */
const MAX_MERGE_CELLS = 5000;

/** Tolerância vertical (pt) para considerar fragmentos na mesma linha visual. */
const LINE_TOLERANCE = 2.5;

/**
 * Distância vertical máxima (pt) entre a linha de um lançamento e uma linha de
 * continuação do mesmo bloco (histórico/razão social quebrados em 2-3 linhas).
 */
const CONTINUATION_RANGE = 24;

/**
 * Folga (pt) aceita ACIMA do primeiro lançamento da página. Serve para a
 * descrição que quebra em duas linhas bem na virada de página, sem deixar
 * passar o cabeçalho/banner do topo.
 */
const PAGE_TOP_SLACK = 8;

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

// Relatórios de pagamento (SISPAG do Itaú, consulta de Pix) imprimem o status
// colado no valor — "749,60 efetuado". O status não é valor, mas se ficar no
// texto a leitura falha e o relatório inteiro sai vazio.
const STATUS_TAIL_RE =
  /\s+(?:efetuado|efetivado|agendado|processado|processando|pendente|cancelado|liquidado|realizado|baixado|aprovado|rejeitado|devolvido|em\s+aberto)$/i;

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

  // "749,60 efetuado" / "1.200,00 agendado": o status vem depois do número.
  text = text.replace(STATUS_TAIL_RE, '').trim();
  if (!text) return null;

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

  // Códigos longos ("20220046445430000000", 20 dígitos) passam pelo formato
  // numérico e viravam "valor" — o que criava lançamento fantasma em extratos
  // que imprimem a linha digitável do TED depois do lançamento.
  const digitCount = text.replace(/[.,]/g, '').length;
  if (!hasComma && !hasDot && digitCount > 12) return null;

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

/**
 * Linhas de rodapé/cabeçalho de página que nunca são lançamento.
 * (Saldo não entra aqui: existe lançamento legítimo com "saldo" no histórico.)
 */
const PAGE_NOISE_PREFIX =
  /^(saldo\s+(anterior|atual|final|inicial|do\s+dia|em\s+conta)|pagina\s+\d+|emitido\s+em|gerado\s+em|relatorio\s+gerado)/;

/**
 * Rótulo de total/resumo **de verdade** — "Total do dia", "Subtotal geral",
 * "Parcial Cliente", "TOTAIS 45 1.234,56".
 *
 * A regra anterior aceitava qualquer linha começando por "total", "resumo" ou
 * "saldo" e isso apagava lançamento real: fornecedor "Total Express Ltda",
 * "Total Distribuidora", histórico "Resumo do pedido 123" e por aí vai. Aqui,
 * depois da palavra inicial, só passam conectivos ("do", "de", "em"), palavras
 * de resumo e números — um nome próprio derruba a regra, e o lançamento fica.
 */
export const TOTAL_LABEL_RE = new RegExp(
  '^(?:parcial|parciais|total|totais|subtotal|subtotais|resumo|resumos)\\b' +
    '(?:\\s+(?:d[oa]s?|em|no|na|nos|nas|geral|bruto|bruta|liquido|liquida|final|inicial|anterior|atual|' +
    'mensal|semanal|diario|diaria|cliente|clientes|fornecedor|fornecedores|credor|credora|devedor|devedora|' +
    'entradas?|saidas?|creditos?|debitos?|periodo|mes|dia|caixa|bancos?|contas?|lancamentos?|registros?|' +
    'movimentos?|documentos?|itens?|[\\d.,/-]+))*$'
);

/**
 * Diz se a linha é cabeçalho/banner/resumo em vez de lançamento.
 *
 * Regra de ouro: **linha com data e valor é lançamento**, mesmo que o texto
 * comece com uma palavra de resumo — só o rótulo restrito acima derruba.
 */
export function isSummaryOrNoiseRow(rowCells) {
  const joined = normalizeText(rowCells.map(cellToString).join(' '));
  if (!joined) return true;
  if (PAGE_NOISE_PREFIX.test(joined)) return true;
  if (TOTAL_LABEL_RE.test(joined)) return true;

  const hasDate = rowCells.some((cell) => parseDateValue(cell) !== null);
  const hasMoney = rowCells.some((cell) => parseMoneyValue(cell) !== null);
  if (hasDate && hasMoney) return false;

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
    //
    // A área é calculada antes de percorrer: planilhas exportadas de sistemas
    // antigos às vezes trazem um "merge" gigante (a aba inteira). Percorrer isso
    // célula por célula travaria a aba do navegador sem ganho nenhum, então
    // intervalos acima do limite ficam de fora — o pior caso é repetir um
    // título, que as regras de cabeçalho/rodapé já descartam.
    const mergedSlaves = new Set();
    const mergedRanges = worksheet.model?.merges || [];
    for (const rangeRef of mergedRanges) {
      const [startRef, endRef] = String(rangeRef).split(':');
      const start = decodeCellRef(startRef);
      const end = decodeCellRef(endRef || startRef);
      if (!start || !end) continue;
      const area = (end.row - start.row + 1) * (end.col - start.col + 1);
      if (!Number.isFinite(area) || area > MAX_MERGE_CELLS) continue;
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

/**
 * Linha de identificação do período ("Extrato de: Ag: 2805 | CC: 0022793-5 ...
 * 01/10/2026 e 31/10/2026"). Ela tem datas, mas não é lançamento: se entrasse
 * como linha de dados, o cabeçalho da tabela seria procurado acima dela e o
 * cabeçalho verdadeiro (Data / Lançamento / Dcto. / Crédito / Débito / Saldo)
 * ficaria de fora — era o que acontecia com o extrato do Bradesco.
 */
function isPeriodBanner(text) {
  const norm = normalizeText(text);
  if (!norm) return false;
  if (/\b(extrato|relatorio|demonstrativo)\b/.test(norm) && /\b(de|do|da|mensal|periodo)\b/.test(norm)) {
    return true;
  }
  if (/\b(periodo|folha\s+\d|pagina\s+\d|data\s+da\s+operacao|nome\s+do\s+usuario)\b/.test(norm)) {
    return true;
  }
  return false;
}

/**
 * Rodapé/hyperlink do próprio extrato: "novos lançamentos", "atualizado em
 * 06/11/2026 16:05", SAC 0800, ouvidoria, site do banco. Aparece depois do
 * último saldo, não tem data nem valor e não pode virar lançamento — era o que
 * acontecia no extrato do Itaú (2 linhas de lixo no fim de 590).
 */
function isStatementNoise(text) {
  const norm = normalizeText(text);
  if (!norm) return true;
  if (/^(novos lancamentos|atualizado em|em caso de duvidas)\b/.test(norm)) return true;
  // "OUVIDORIA SICOOB: 08007250996" — o telefone vem colado, sem espaço.
  if (/\b(sac|central de atendimento|ouvidoria|fale conosco)\b/.test(norm)) return true;
  if (/^(www\.|https?:|about:blank)/.test(norm)) return true;
  if (/\bpagina\s+\d+\s+(de|of)\s+\d+\b/.test(norm)) return true;
  // Rodapé de sistemas que imprimem avisos e links no fim do extrato.
  if (/^(acesse o menu|limites de credito disponiveis|este documento|documento emitido)\b/.test(norm)) {
    return true;
  }
  return false;
}

function isBannerOrSummary(text) {
  const norm = normalizeText(text);
  if (/\bpagina\s+\d+\s+de\s+\d+\b/.test(norm)) return true;
  return /^(total|totais|subtotal|saldo\s+(anterior|atual|final|inicial|do\s+dia)|resumo|pagina\s+\d+|emitido\s+em|gerado\s+em)\b/.test(
    norm
  );
}


/* -------------------------------------------------------------------------- */
/*                     PDF: cabeçalho e colunas da tabela                     */
/* -------------------------------------------------------------------------- */

/** Rótulos que aparecem num cabeçalho de extrato/relatório. */
const COLUMN_LABEL_RE =
  /\b(data|dt|valor|valores|vlr|vl|historico|descricao|desc|documento|dcto|docto|doc|saldo|credito|debito|entrada|saida|lancamento|origem|tipo|complemento|agencia|conta|hora|hora|dependencia|historico|quantia|tarifa)\b/;

/**
 * Junta fragmentos do cabeçalho que são o mesmo rótulo quebrado
 * ("Crédito" + "(R$)" → "Crédito (R$)"; "DATA" + "MOV." → "DATA MOV.").
 */
function mergeHeaderItems(items) {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  const merged = [];

  for (const item of sorted) {
    const last = merged[merged.length - 1];
    const lastRight = last ? last.x + (last.w || 0) : -Infinity;
    if (last && item.x - lastRight <= 8) {
      last.str = `${last.str} ${item.str}`.trim();
      last.w = Math.max(lastRight, item.x + (item.w || 0)) - last.x;
      continue;
    }
    merged.push({
      str: item.str,
      x: item.x,
      w: item.w || 0,
      numRight: item.numRight ?? item.x + (item.w || 0),
    });
  }

  return merged;
}

/**
 * Encontra a linha de cabeçalho da tabela: só texto, pelo menos dois rótulos
 * conhecidos e nenhum número solto (para não confundir com uma faixa de
 * identificação do tipo "COOP.: 4327 - 3").
 *
 * @returns {{line:object, items:Array<{str:string,x:number,w:number}>, score:number}|null}
 */
export function findHeaderRow(allPageLines) {
  const candidates = [];

  for (const line of allPageLines) {
    const items = mergeHeaderItems(line.items);
    if (items.length < 2) continue;

    // Cabeçalho é texto puro: um "4327" ou "15:51:37" solto já o desqualifica.
    const allText = items.every(
      (item) => parseMoneyValue(item.str) === null && parseDateValue(item.str) === null
    );
    if (!allText) continue;

    const labels = items.filter((item) => COLUMN_LABEL_RE.test(normalizeText(item.str)));
    if (labels.length < 2) continue;

    const norm = normalizeText(lineText(line));
    const hasValueOrBalance = /\b(valor|saldo|credito|debito|entrada|saida)\b/.test(norm);
    const score = labels.length * 2 + items.length + (hasValueOrBalance ? 3 : 0);

    candidates.push({ line, items, score, signature: norm });
  }

  if (candidates.length === 0) return null;

  // O cabeçalho da tabela principal é o que o banco REPETE em cada página.
  // Num extrato mensal do Itaú há também a tabela de CDB ("data | data | valor |
  // saldo bruto | saldo líquido"), que tem mais rótulos numa única página e
  // ganhava a disputa: o extrato inteiro era lido com as colunas da tabela de
  // investimentos e saía vazio. Repetição quebra esse empate.
  const pagesBySignature = new Map();
  for (const candidate of candidates) {
    const pages = pagesBySignature.get(candidate.signature) || new Set();
    pages.add(candidate.line.page);
    pagesBySignature.set(candidate.signature, pages);
  }

  let best = null;
  for (const candidate of candidates) {
    const pages = pagesBySignature.get(candidate.signature).size;
    const total = candidate.score + Math.max(0, pages - 1) * 8;
    if (!best || total > best.score) best = { line: candidate.line, items: candidate.items, score: total };
  }

  return best;
}

/**
 * Colunas ancoradas nos rótulos do cabeçalho.
 *
 * A fronteira entre duas colunas é o meio do vão entre o fim de um rótulo e o
 * começo do próximo — e não o meio entre os centros — porque rótulos de coluna
 * numérica costumam ficar bem à esquerda dos números (alinhados à direita).
 */
export function buildColumnsFromHeaderRow(headerRow) {
  const items = headerRow?.items;
  if (!items || items.length < 3) return null;
  return boundsFromHeaderItems(
    items.map((item) => ({ x: item.x, right: item.x + (item.w || 0), label: item.str }))
  );
}

/** Fronteiras das colunas a partir dos rótulos já agrupados (esquerda → direita). */
function boundsFromHeaderItems(items) {
  const ordered = [...items].sort((a, b) => a.x - b.x);
  if (ordered.length < 3) return null;

  const bounds = ordered.map((item, idx) => ({
    idx,
    anchor: (item.x + item.right) / 2,
    start: -Infinity,
    end: Infinity,
    label: item.label,
  }));

  for (let i = 0; i < ordered.length - 1; i++) {
    const right = ordered[i].right;
    const nextStart = ordered[i + 1].x;
    const boundary = right <= nextStart ? (right + nextStart) / 2 : (ordered[i].x + nextStart) / 2;
    bounds[i].end = boundary;
    bounds[i + 1].start = boundary;
  }

  return bounds;
}

// Rótulos que são legenda, não coluna: no extrato mensal do Itaú a mesma linha
// do cabeçalho traz "A = agendamento", "B = ações movimentadas"… à margem.
const HEADER_LEGEND_RE = /^[A-Za-zÀ-ÿ]\s*=\s*\S/;

/**
 * Colunas de um cabeçalho quebrado em várias linhas (SISPAG do Itaú:
 * "referência da" / "empresa" embaixo de "tipo de pagamento"; Caixa:
 * "Valor" + "(R$)"). Junta os rótulos que estão na MESMA posição
 * horizontal, de cima para baixo, em vez de escolher uma única linha — antes a
 * linha do meio virava o cabeçalho inteiro e as outras 2 eram espremidas nas
 * colunas vizinhas, trocando a coluna de data com a de valor.
 */
export function buildColumnsFromHeaderRows(headerLines) {
  const entries = [];
  for (const line of headerLines || []) {
    for (const item of line.items) {
      if (HEADER_LEGEND_RE.test(item.str.trim())) continue;
      entries.push({
        str: item.str,
        x: item.x,
        right: item.x + (item.w || 0),
        y: line.y,
      });
    }
  }
  if (entries.length < 3) return null;

  entries.sort((a, b) => a.x - b.x);

  const groups = [];
  for (const entry of entries) {
    const last = groups[groups.length - 1];
    // Mesma coluna: rótulos praticamente na mesma abcissa (a 2ª/3ª linha do
    // cabeçalho repete a posição do rótulo de cima).
    if (last && entry.x - last.x <= 12) {
      last.items.push(entry);
      last.right = Math.max(last.right, entry.right);
      continue;
    }
    groups.push({ x: entry.x, right: entry.right, items: [entry] });
  }

  const items = groups.map((group) => ({
    x: group.x,
    right: group.right,
    label: cleanWhitespace(
      [...group.items]
        .sort((a, b) => b.y - a.y)
        .map((entry) => entry.str)
        .join(' ')
    ),
  }));

  return boundsFromHeaderItems(items);
}

/**
 * O modelo do cabeçalho só vale se todos os rótulos receberem dados e se
 * alguma coluna concentrar datas. Sem isso, voltamos ao agrupamento por
 * posição (que funciona bem em extratos com muitas colunas estreitas).
 */
export function headerColumnsLookSane(bounds, dataLines) {
  const stats = bounds.map(() => ({ items: 0, dates: 0, money: 0 }));
  const centerOf = (item) => item.x + (item.w || 0) / 2;

  for (const line of dataLines) {
    for (const item of line.items) {
      const center = centerOf(item);
      let idx = bounds.findIndex((bound) => center >= bound.start && center < bound.end);
      if (idx < 0) {
        idx = bounds.reduce(
          (best, bound, i) =>
            Math.abs(center - bound.anchor) < Math.abs(center - bounds[best].anchor) ? i : best,
          0
        );
      }
      stats[idx].items += 1;
      if (parseDateValue(item.str) !== null) stats[idx].dates += 1;
      if (parseMoneyValue(item.str) !== null) stats[idx].money += 1;
    }
  }

  // Uma coluna pode ser esparsa e continuar legítima: no extrato mensal do Itaú
  // a coluna "saldo R$" só aparece nas linhas de saldo, que não são candidatas
  // a dado. Antes, uma coluna vazia derrubava o cabeçalho inteiro e o extrato
  // caía no agrupamento por posição — com 5 colunas estimadas às cegas.
  const comDados = stats.filter((stat) => stat.items > 0).length;
  if (comDados < Math.max(3, Math.ceil(stats.length * 0.6))) return false;
  if (!stats.some((stat) => stat.dates >= 1)) return false;
  if (!stats.some((stat) => stat.money >= 1)) return false;
  return true;
}

/** Agrupamento de colunas pela posição X dos dados (plano B). */
function clusterColumnsFromData(candidateDataLines, allPageLines) {
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

  const documentItems = [];
  for (const line of allPageLines) {
    for (const item of line.items) documentItems.push(item);
  }
  const supportOf = (cluster) => {
    let total = 0;
    for (const item of documentItems) {
      if (item.x >= cluster.min - 2 && item.x <= cluster.max + 2) total += 1;
    }
    return total;
  };

  let colClusters = rawClusters.filter((cluster) => {
    if (cluster.count >= minSupport) return true;
    if (supportOf(cluster) >= minSupport) return true;
    return allItems.some(
      (entry) => entry.isMoney && entry.x >= cluster.min - 2 && entry.x <= cluster.max + 2
    );
  });

  if (colClusters.length < 2) colClusters = rawClusters;
  colClusters.sort((a, b) => a.anchor - b.anchor);

  const itemsInCluster = (cluster) =>
    allItems.filter((entry) => entry.x >= cluster.min - 2 && entry.x <= cluster.max + 2);

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
        const rightRight = rightItems.reduce((sum, entry) => sum + entry.right, 0) / rightItems.length;
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

  return colClusters;
}

/** Fronteiras horizontais a partir dos clusters (plano B). */
function boundsFromClusters(colClusters) {
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

  return colBounds;
}

/**
 * Reconstrói a tabela (cabeçalhos + linhas) a partir das linhas de texto
 * extraídas do PDF. Função pura e independente do PDF.js.
 *
 * @param {Array<{page:number,y:number,h:number,items:Array}>} allPageLines
 * @returns {{headers:string[],rows:string[][],bannerLines:string[],skippedRows:number,columnCount:number}}
 */
/**
 * Data de referência do documento (a que aparece com mais frequência), usada
 * para completar datas sem ano.
 */
function findReferenceDate(allPageLines) {
  const votes = new Map();
  for (const line of allPageLines) {
    for (const item of line.items) {
      const iso = parseDateValue(item.str);
      if (!iso) continue;
      votes.set(iso, (votes.get(iso) || 0) + 1);
    }
  }
  if (votes.size === 0) return null;
  let best = null;
  for (const [iso, count] of votes) {
    if (!best || count > best.count || (count === best.count && iso > best.iso)) best = { iso, count };
  }
  const [year, month] = best.iso.split('-').map(Number);
  return { year, month };
}

/**
 * Blocos de cabeçalho do documento, em ordem de leitura.
 *
 * Um PDF pode trazer MAIS DE UMA tabela (extrato mensal do Itaú: movimentação
 * da conta, aplicações automáticas, CDB…). Cada bloco de cabeçalho — a linha e
 * as vizinhas que formam o mesmo rótulo — marca onde começa uma tabela nova.
 * As linhas de uma tabela que não é a principal são descartadas, senão os
 * números do CDB entravam como "entradas" da conta corrente.
 */
function collectHeaderBlocks(allPageLines) {
  const candidates = [];

  for (const line of allPageLines) {
    const items = mergeHeaderItems(line.items);
    if (items.length < 2) continue;
    const allText = items.every(
      (item) => parseMoneyValue(item.str) === null && parseDateValue(item.str) === null
    );
    if (!allText) continue;
    const labels = items.filter((item) => COLUMN_LABEL_RE.test(normalizeText(item.str)));
    if (labels.length < 2) continue;
    candidates.push({ line, labelCount: labels.length });
  }

  candidates.sort((a, b) => a.line.page - b.line.page || b.line.y - a.line.y);

  const blocks = [];
  for (const candidate of candidates) {
    const last = blocks[blocks.length - 1];
    if (
      last &&
      last.page === candidate.line.page &&
      Math.abs(last.y - candidate.line.y) <= 12
    ) {
      last.lines.push(candidate.line);
      last.labelCount = Math.max(last.labelCount, candidate.labelCount);
      continue;
    }
    blocks.push({
      page: candidate.line.page,
      y: candidate.line.y,
      lines: [candidate.line],
      labelCount: candidate.labelCount,
    });
  }

  // Assinatura do bloco: o mesmo cabeçalho repetido em cada página tem a mesma
  // assinatura (é o que diferencia "continuação da tabela principal" de
  // "começou outra tabela").
  for (const block of blocks) {
    const texts = [];
    for (const line of block.lines) {
      for (const item of line.items) {
        if (HEADER_LEGEND_RE.test(item.str.trim())) continue;
        texts.push(item.str);
      }
    }
    block.signature = normalizeText(texts.join(' '));
  }

  return blocks;
}

/**
 * Completa datas sem ano ("01/10") nas próprias linhas do PDF.
 *
 * O extrato mensal do Itaú imprime dia/mês na tabela e o ano só no título. Sem
 * completar isso NENHUMA linha tem data válida — o arquivo inteiro saía vazio
 * (0 lançamentos em 466 linhas) porque a coluna de data nunca era detectada.
 * O ano vem da data completa mais frequente do documento e é ajustado na
 * virada (dez → jan).
 */
function completeShortDates(allPageLines) {
  const SHORT_DATE_RE = /^(\d{1,2})\/(\d{1,2})$/;
  const entries = [];

  for (const line of allPageLines) {
    for (const item of line.items) {
      const match = SHORT_DATE_RE.exec(cleanWhitespace(item.str));
      if (!match) continue;
      const day = Number(match[1]);
      const month = Number(match[2]);
      if (day < 1 || day > 31 || month < 1 || month > 12) continue;
      entries.push({ item, day, month, page: line.page, y: line.y });
    }
  }

  if (entries.length < 3) return 0;

  // Documento que já imprime datas completas não precisa de ajuda: no SISPAG
  // do Itaú uma referência de nota solta como "03/03" virava 03/03/2027.
  let fullDates = 0;
  for (const line of allPageLines) {
    for (const item of line.items) {
      if (parseDateValue(item.str) !== null) fullDates += 1;
    }
  }
  if (fullDates >= entries.length * 2) return 0;

  const reference = findReferenceDate(allPageLines);
  let year = reference ? reference.year : new Date().getFullYear();
  let previousMonth = reference ? reference.month : entries[0].month;

  // Ordem do documento: página e, dentro dela, de cima para baixo.
  entries.sort((a, b) => a.page - b.page || b.y - a.y);

  let completed = 0;
  for (const entry of entries) {
    if (entry.month < previousMonth - 6) year += 1;
    else if (entry.month > previousMonth + 6) year -= 1;
    previousMonth = entry.month;
    entry.item.str = `${pad(entry.day)}/${pad(entry.month)}/${year}`;
    completed += 1;
  }

  return completed;
}

export function buildTableFromTextLines(allPageLines) {
  if (!Array.isArray(allPageLines) || allPageLines.length === 0) {
    throw new Error('Nenhum texto extraível encontrado no PDF (pode ser um documento digitalizado).');
  }

  // 0a. Datas "dd/mm" ganham o ano do documento (extrato mensal do Itaú).
  completeShortDates(allPageLines);

  // 0. Cabeçalho da tabela (âncora de tudo): só o que está ABAIXO dele é dado.
  const headerRow = findHeaderRow(allPageLines);
  const headerPage = headerRow ? headerRow.line.page : null;
  const headerY = headerRow ? headerRow.line.y : null;

  // Zona de cada tabela: linhas abaixo de um cabeçalho que NÃO é o principal
  // pertencem a outra tabela do mesmo PDF e não entram no resultado.
  const headerBlocks = collectHeaderBlocks(allPageLines);
  const mainBlock = headerRow
    ? headerBlocks.find((block) => block.lines.includes(headerRow.line))
    : null;
  const isHeaderBlockOfMain = (block) =>
    mainBlock ? block.signature === mainBlock.signature : true;
  const otherTableKeys = new Set();
  if (headerRow && headerBlocks.length > 1) {
    for (const block of headerBlocks) {
      if (isHeaderBlockOfMain(block)) continue;
      // Só uma tabela de verdade: precisa de pelo menos 2 rótulos e de estar
      // abaixo de um cabeçalho principal já visto (senão é legenda/texto).
      for (const line of block.lines) otherTableKeys.add(`${line.page}:${line.y}`);
    }
  }

  const foreignRowKeys = new Set();
  if (otherTableKeys.size > 0) {
    const starts = headerBlocks
      .filter((block) => !isHeaderBlockOfMain(block))
      .map((block) => ({ page: block.page, y: block.y }));
    for (const line of allPageLines) {
      const owner = starts.find(
        (start) => line.page === start.page && line.y <= start.y + 0.5
      );
      if (!owner) continue;
      const mainAfter = headerBlocks
        .filter((block) => isHeaderBlockOfMain(block))
        .find((block) => block.page === line.page && block.y < owner.y);
      if (mainAfter && line.y <= mainAfter.y + 0.5) continue;
      foreignRowKeys.add(`${line.page}:${line.y}`);
    }
  }

  // 1. Linhas candidatas a dados: contêm data + valor, ou data e 3+ colunas.
  const candidateDataLines = allPageLines.filter((line) => {
    // Faixa de identificação acima do cabeçalho ("14/10/2022 EXTRATO CONTA
    // CORRENTE 15:51:37") tem data e valor, mas é cabeçalho, não lançamento.
    if (line.page === headerPage && headerY !== null && line.y > headerY) return false;

    const hasDate = line.items.some((item) => parseDateValue(item.str) !== null);
    const hasMoney = line.items.some((item) => parseMoneyValue(item.str) !== null);
    if (!hasDate && !hasMoney) return false;
    // "Extrato de: ... 01/10/2026 e 31/10/2026" tem data mas é cabeçalho.
    if (isPeriodBanner(lineText(line))) return false;
    return (hasDate && hasMoney) || (hasDate && line.items.length >= 3);
  });

  // As linhas de outra tabela do mesmo PDF não podem influenciar as colunas da
  // principal (na página 8 do extrato mensal a tabela de aplicações imprime
  // datas em x=58 e puxava a 1ª coluna para a margem).
  for (let index = candidateDataLines.length - 1; index >= 0; index--) {
    const line = candidateDataLines[index];
    if (foreignRowKeys.has(`${line.page}:${line.y}`)) candidateDataLines.splice(index, 1);
  }

  if (candidateDataLines.length === 0) {
    throw new Error(
      'Não foi possível identificar linhas tabulares com datas/valores no PDF. ' +
        'Se o arquivo é um cadastro/relatório (sem lançamentos), ele não entra aqui: ' +
        'use a página do conciliador para os cadastros.'
    );
  }

  // 2. Colunas: preferimos as posições do CABEÇALHO da tabela; se ele não for
  // encontrado, montamos as colunas pela frequência das posições X dos dados.
  //
  // Ancorar no cabeçalho é o que salva layouts “em lista” como o do Sicoob, em
  // que a descrição quebra em várias linhas na MESMA coluna e um pedaço dela
  // ("- STR") começa 45 pt à direita do rótulo: pelo agrupamento de posições
  // isso virava uma coluna fantasma ("Coluna 5") e jogava o valor para a
  // coluna errada.
  // Linhas que compõem o cabeçalho: a do cabeçalho e as vizinhas (±12 pt) que
  // também são texto puro. Cabeçalho quebrado em várias linhas (SISPAG) precisa
  // das três para saber onde começa cada coluna.
  const labelLines = headerRow
    ? allPageLines.filter(
        (line) =>
          line.page === headerRow.line.page &&
          Math.abs(line.y - headerRow.line.y) <= 12 &&
          line.items.every(
            (item) => parseMoneyValue(item.str) === null && parseDateValue(item.str) === null
          )
      )
    : [];

  const headerColumnsFromLines = headerRow ? buildColumnsFromHeaderRows(labelLines) : null;
  const headerColumns = headerColumnsFromLines || (headerRow ? buildColumnsFromHeaderRow(headerRow) : null);
  const headerModelFromLines = Boolean(headerColumnsFromLines);
  const headerModel =
    headerColumns && headerColumns.length >= 3 && headerColumnsLookSane(headerColumns, candidateDataLines)
      ? headerColumns
      : null;

  let colClusters;
  let colBounds;

  if (headerModel) {
    colClusters = headerModel.map((column) => ({
      anchor: column.anchor,
      min: column.anchor,
      max: column.anchor,
      count: 0,
      label: column.label,
    }));
    colBounds = headerModel;
  } else {
    colClusters = clusterColumnsFromData(candidateDataLines, allPageLines);
    colBounds = boundsFromClusters(colClusters);
  }

  // Estatística de cada coluna (extensão real dos dados e âncoras de valores
  // alinhados à direita). Rodada em duas passagens: primeiro pela faixa do
  // cabeçalho, depois refinando os valores pela borda direita.
  const assignByBand = (item) => {
    const center = item.x + (item.w || 0) / 2;
    for (const bounds of colBounds) {
      if (center >= bounds.start && center < bounds.end) return bounds.idx;
    }
    let bestIdx = 0;
    let bestDistance = Infinity;
    for (const bounds of colBounds) {
      const distance = Math.abs(center - bounds.anchor);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIdx = bounds.idx;
      }
    }
    return bestIdx;
  };

  const buildStats = (assign) => {
    const stats = colBounds.map((bounds) => ({
      min: bounds.anchor,
      max: bounds.anchor + 40,
      moneyRights: [],
      dates: 0,
      items: 0,
    }));
    for (const line of candidateDataLines) {
      for (const item of line.items) {
        const idx = assign(item);
        const stat = stats[idx];
        if (!stat) continue;
        stat.items += 1;
        stat.min = Math.min(stat.min, item.x);
        stat.max = Math.max(stat.max, item.x + (item.w || 20));
        if (parseMoneyValue(item.str) !== null) {
          stat.moneyRights.push(item.numRight ?? item.x + (item.w || 0));
        }
        if (parseDateValue(item.str) !== null) stat.dates += 1;
      }
    }
    return stats;
  };

  const bandStats = buildStats(assignByBand);
  const moneyRightAnchors = bandStats.map((stat) => {
    if (stat.moneyRights.length === 0) return null;
    const sorted = [...stat.moneyRights].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  });

  const assignItemToColumn = (item) => {
    if (parseMoneyValue(item.str) !== null) {
      const right = item.numRight ?? item.x + (item.w || 0);
      let bestIdx = -1;
      let bestGap = Infinity;
      moneyRightAnchors.forEach((anchor, idx) => {
        if (anchor === null) return;
        const gap = Math.abs(right - anchor);
        if (gap < bestGap) {
          bestGap = gap;
          bestIdx = idx;
        }
      });
      // Só troca quando a borda direita casa quase exatamente (colunas
      // alinhadas à direita); caso contrário fica a regra por posição.
      if (bestIdx >= 0 && bestGap <= 10) return bestIdx;
    }
    return assignByBand(item);
  };

  const colDataExtents = buildStats(assignItemToColumn).map((stat) => ({
    minX: stat.min,
    maxX: stat.max,
  }));


  // 4. Localizar a zona de cabeçalho acima da primeira linha de dados.
  // Preferimos uma linha com VALOR: linhas que só têm data (faixa de período,
  // "extrato de...") ficam acima do cabeçalho de verdade.
  const firstDataLine =
    candidateDataLines.find((line) => line.items.some((item) => parseMoneyValue(item.str) !== null)) ||
    candidateDataLines[0];
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

  // Se o cabeçalho foi reconhecido semanticamente, ele manda: linhas vizinhas
  // ("COOP.: 4327 - 3 SICOOB EMPRESAS RJ") não entram como nome de coluna.
  const partLines = headerRow ? labelLines : headerLines;

  for (const headerLine of partLines) {
    // Uma coluna costuma ter um rótulo por linha de cabeçalho; quando o rótulo
    // flutua entre duas colunas (caso de coluna numérica alinhada à direita) ele
    // não deve repetir a coluna do rótulo anterior da mesma linha.
    const columnsUsedOnLine = new Set();
    for (const item of headerLine.items) {
      const center = item.x + (item.w || 0) / 2;
      // Intervalo horizontal ocupado pelo rótulo do cabeçalho.
      const labelStart = item.x;
      const labelEnd = item.x + (item.w || 0);
      const candidates = [];
      for (let col = 0; col < colBounds.length; col++) {
        const extent = colDataExtents[col];
        const bounds = colBounds[col];
        // Distância entre o rótulo e os dados da coluna. Em colunas numéricas
        // alinhadas à direita o rótulo costuma ficar bem à esquerda dos
        // números (ou vice-versa), então o vão entre os dois intervalos diz
        // mais do que o centro do rótulo — era o que colava "data valor".
        const gap =
          labelEnd < extent.minX
            ? extent.minX - labelEnd
            : labelStart > extent.maxX
              ? labelStart - extent.maxX
              : 0;
        const inBounds = center >= bounds.start && center < bounds.end;
        const distance = Math.abs(center - (extent.minX + extent.maxX) / 2);
        const score = -gap * 1000 + (inBounds ? 500 : 0) - distance;
        candidates.push({ col, gap, score });
      }
      candidates.sort((a, b) => b.score - a.score);
      const bestCol = (
        candidates.find((candidate) => candidate.gap === 0) ||
        candidates.find((candidate) => !columnsUsedOnLine.has(candidate.col)) ||
        candidates[0]
      ).col;
      columnsUsedOnLine.add(bestCol);
      headerParts[bestCol].push(item.str);
    }
  }

  // O rótulo vem do cabeçalho já agrupado por posição (que descarta legendas do
  // tipo "A = agendamento"); \`headerParts\` só completa quando ele falta.
  const headers = headerModelFromLines && headerModel
    ? headerModel.map((column, idx) =>
        cleanWhitespace(column.label || headerParts[idx].join(' ')) || `Coluna ${idx + 1}`
      )
    : headerParts.map((parts, idx) => cleanWhitespace(parts.join(' ')) || `Coluna ${idx + 1}`);

  // 6. Montar as linhas de dados de todas as páginas.
  const headerSignatures = new Set(headerLines.map((line) => normalizeText(lineText(line))));
  headerSignatures.add(normalizeText(headers.join(' ')));

  // Cada página repete o cabeçalho/rodapé ("Página : 2 / 6", nome da empresa,
  // filtros...). Tudo o que está acima da primeira linha de dados da página é
  // cabeçalho, não lançamento.
  const firstDataYByPage = new Map();
  const considerTopLine = (line) => {
    const current = firstDataYByPage.get(line.page);
    if (current === undefined || line.y > current) firstDataYByPage.set(line.page, line.y);
  };
  for (const line of candidateDataLines) considerTopLine(line);

  // Lançamento na virada de página costuma vir SEM data (documento + valor +
  // saldo). Ele também marca onde os dados começam — senão a regra de "tudo
  // acima do primeiro lançamento é cabeçalho" descartaria essa linha.
  //
  // Só entram aqui as linhas puramente numéricas: as faixas de resumo do topo
  // ("R$ 2.520,90 R$ 0,00…") trazem texto junto e continuam sendo banner.
  const datedByPage = new Map();
  for (const line of candidateDataLines) {
    const list = datedByPage.get(line.page);
    if (list) list.push(line.y);
    else datedByPage.set(line.page, [line.y]);
  }
  for (const list of datedByPage.values()) list.sort((a, b) => b.y - a.y);

  for (const line of allPageLines) {
    if (line.items.length < 2) continue;
    if (!line.items.every((item) => parseMoneyValue(item.str) !== null)) continue;
    if (isPeriodBanner(lineText(line))) continue;
    // Precisa estar colado na tabela: logo ACIMA de um lançamento com data
    // (virada de página). Faixas de resumo do topo ficam longe dos dados.
    const below = (datedByPage.get(line.page) || []).find((y) => y < line.y);
    if (below === undefined || line.y - below > 30) continue;
    considerTopLine(line);
  }

  // Abcissa em que a 1ª coluna imprime DADO (dinheiro ou data). Serve para
  // reconhecer texto de legenda na margem esquerda: no extrato mensal do Itaú
  // as siglas ("D = débito a compensar") ficam ~95 pt à esquerda da data,
  // enquanto num relatório agrupado por cliente o nome do cliente está na
  // própria coluna de dados (e precisa continuar sendo título de grupo).
  let typedFirstColX = Infinity;
  for (const line of candidateDataLines) {
    for (const item of line.items) {
      if (assignItemToColumn(item) !== 0) continue;
      if (parseMoneyValue(item.str) === null && parseDateValue(item.str) === null) continue;
      typedFirstColX = Math.min(typedFirstColX, item.x);
    }
  }

  const dataYByPage = new Map();
  for (const line of candidateDataLines) {
    const list = dataYByPage.get(line.page);
    if (list) list.push(line.y);
    else dataYByPage.set(line.page, [line.y]);
  }

  const rows = [];
  const skipped = [];
  const entries = [];
  // Linhas de saldo (SALDO ANTERIOR / SALDO DO DIA / SALDO EM CONTA…). Quando o
  // extrato NÃO tem coluna de saldo, o valor dessas linhas cai na mesma coluna
  // dos lançamentos, então elas não podem virar lançamento nem sumir: viram
  // **checkpoints** para a conferência de saldo do treinador.
  const checkpoints = [];
  const hasSaldoColumn = headers.some((header) => /\bsaldo\b/i.test(normalizeText(header)));

  for (const line of allPageLines) {
    const norm = normalizeText(lineText(line));
    if (!norm) continue;

    if (foreignRowKeys.has(`${line.page}:${line.y}`)) {
      skipped.push(norm);
      continue;
    }

    // Rodapé/hyperlink: só é descartado quando a linha não tem data nem valor
    // (um lançamento de verdade com "0800" no histórico continua valendo).
    if (
      isStatementNoise(lineText(line)) &&
      !line.items.some((item) => parseDateValue(item.str) !== null) &&
      !line.items.some((item) => parseMoneyValue(item.str) !== null)
    ) {
      skipped.push(norm);
      continue;
    }

    const cells = Array.from({ length: colBounds.length }, () => []);
    for (const item of line.items) cells[assignItemToColumn(item)].push(item.str);
    const rowStrings = cells.map((parts) => cleanWhitespace(parts.join(' ')));

    const hasDate = rowStrings.some((value) => parseDateValue(value) !== null);
    const nonEmptyCount = rowStrings.filter(Boolean).length;
    const text = lineText(line);

    // Linha de saldo (âncora/checkpoint): nunca é lançamento.
    const moneyCells = rowStrings
      .map((value) => parseMoneyValue(value))
      .filter((money) => money !== null);
    const textCells = rowStrings.filter(
      (value) =>
        cleanWhitespace(value) &&
        parseMoneyValue(value) === null &&
        parseDateValue(value) === null
    );
    const label = normalizeText(textCells.join(' '));
    const isSaldoRow = /^saldo\b/.test(label) && moneyCells.length > 0;

    // Sem coluna de saldo, a linha de saldo é checkpoint (e sai das linhas).
    // COM coluna de saldo (Itaú, Bradesco) ela continua sendo linha: é dali que
    // o treinador tira as âncoras da conferência.
    if (isSaldoRow && !hasSaldoColumn) {
      checkpoints.push({
        label: cleanWhitespace(textCells.join(' ')),
        value: moneyCells[0].value,
        dcTag: moneyCells[0].dcTag || null,
        page: line.page,
        y: line.y,
      });
      skipped.push(norm);
      continue;
    }

    // Legenda/rodapé na margem: no extrato mensal do Itaú a coluna da esquerda
    // traz "D = débito a compensar", "Para demais siglas…", "Explicativas no
    // final do extrato" e o rodapé da página ("Este material está disponível
    // na Internet…"). Nada disso é lançamento nem título de grupo — antes
    // grudava no histórico do lançamento seguinte.
    const isMarginNote =
      typedFirstColX !== Infinity &&
      line.items.every((item) => item.x <= typedFirstColX - 45) &&
      !line.items.some((item) => parseMoneyValue(item.str) !== null || parseDateValue(item.str) !== null);
    const isPageFooter = line.y <= 24 && !line.items.some((item) => parseMoneyValue(item.str) !== null);
    if (isMarginNote || isPageFooter) {
      skipped.push(norm);
      continue;
    }

    // Cabeçalho de grupo de um relatório agrupado por cliente/fornecedor:
    // texto único, encostado na margem esquerda (à esquerda da 1ª coluna de
    // dados) e colado nas linhas de dados. Vira uma linha própria, usada pelo
    // conversor como prefixo do histórico dos lançamentos seguintes.
    const pageTopDataY = firstDataYByPage.get(line.page);
    // Positivo = a linha está acima da primeira linha de dados da página.
    const distanceAboveData = pageTopDataY === undefined ? 0 : line.y - pageTopDataY;
    // Título de grupo fica com folga em relação às linhas de dados. No SISPAG
    // do Itaú sobram fragmentos de nome sozinhos a 3 pt da linha do valor —
    // eles viravam "título de grupo" e eram colados no histórico seguinte.
    const nearestDataY = (dataYByPage.get(line.page) || []).reduce(
      (best, y) => (Math.abs(y - line.y) < Math.abs(best - line.y) ? y : best),
      Number.POSITIVE_INFINITY
    );
    const isSectionHeader =
      nonEmptyCount === 1 &&
      !hasDate &&
      text.length >= 3 &&
      text.length <= 120 &&
      Math.abs(nearestDataY - line.y) >= 6 &&
      !isBannerOrSummary(text) &&
      // No topo da página só aceitamos a seção colada na tabela; mais acima é
      // cabeçalho/razão social repetido pelo sistema emissor.
      (distanceAboveData <= 0 || distanceAboveData <= 40) &&
      line.items.every((item) => item.x <= colClusters[0].anchor + 6);

    // Abaixo da linha de cabeçalho da tabela é ZONA DE DADOS: uma linha daqui
    // não pode ser confundida com o cabeçalho só porque o texto é parecido. No
    // SISPAG do Itaú a primeira linha de um pagamento ("ESPECIFARMA COM DE |
    // Boleto outros | NF286536-") era capturada como "cabeçalho" pela região
    // acima da 1ª linha de dados e o nome do fornecedor desaparecia.
    const abaixoDoCabecalho =
      headerRow !== null &&
      (line.page > headerRow.line.page ||
        (line.page === headerRow.line.page && line.y < headerRow.line.y));
    const isKnownHeaderLine = !abaixoDoCabecalho && headerSignatures.has(norm);

    // Linhas acima da primeira linha de dados da página são cabeçalho/banner.
    if (!isSectionHeader) {
      if (pageTopDataY !== undefined && line.y > pageTopDataY + PAGE_TOP_SLACK) continue;
      if (isKnownHeaderLine) {
        skipped.push(norm);
        continue;
      }
    }

    // Linhas de total/resumo só são descartadas quando não têm data própria:
    // um lançamento cujo histórico começa por "TOTAL ..." continua válido.
    if (isKnownHeaderLine || (isBannerOrSummary(text) && (!hasDate || nonEmptyCount <= 2))) {
      skipped.push(norm);
      continue;
    }

    const moneyCols = [];
    rowStrings.forEach((value, idx) => {
      if (value && parseMoneyValue(value) !== null) moneyCols.push(idx);
    });

    entries.push({
      page: line.page,
      y: line.y,
      cells: rowStrings,
      norm,
      text,
      hasDate,
      isSectionHeader,
      nonEmptyCount,
      hasMoney: moneyCols.length > 0,
      moneyCols,
    });
  }

  // 7. Montar as linhas de dados juntando as continuações ao bloco correto.
  //
  // Em vários extratos a data não fica na mesma linha visual do histórico: no
  // bloco do Itaú (três linhas) a data aparece junto com CNPJ e valor na linha
  // do MEIO, com uma linha de descrição acima e outra abaixo:
  //     RECEBIMENTO REDE VISA   | REDECARD INSTITUICAO DE
  //     01/10/2026              | 01.425.787/0001-04 | 1.230,90
  //     DB0094977224            | PAGAMENTO S.A.
  // Por isso a continuação se liga ao bloco mais próximo — inclusive quando ela
  // está ACIMA da linha que traz a data — e o texto de cada coluna é remontado
  // na ordem vertical original.
  // Lançamento sem data própria: no extrato do Bradesco o dia aparece só na
  // PRIMEIRA linha de cada data e as seguintes herdam a data de cima. Essas
  // linhas continuam sendo lançamentos (têm valor fora da coluna de saldo) e
  // precisam virar bloco — antes eram descartadas e a descrição delas ia parar
  // no lançamento vizinho.
  const lastColumnIdx = colBounds.length - 1;
  const isCarryCandidate = (entry) =>
    !entry.hasDate &&
    !entry.isSectionHeader &&
    entry.moneyCols.some((idx) => idx < lastColumnIdx) &&
    !isBannerOrSummary(entry.text);

  const blocks = [];
  for (const entry of entries) {
    if (entry.hasDate || entry.isSectionHeader) blocks.push({ ...entry, extra: [], inheritsDate: false });
    else if (isCarryCandidate(entry)) blocks.push({ ...entry, extra: [], inheritsDate: true });
  }

  // Índice por página (topo → base) para achar o bloco vizinho em O(log n).
  const blocksByPage = new Map();
  for (const block of blocks) {
    const list = blocksByPage.get(block.page);
    if (list) list.push(block);
    else blocksByPage.set(block.page, [block]);
  }
  for (const list of blocksByPage.values()) list.sort((a, b) => b.y - a.y);

  for (const entry of entries) {
    if (entry.hasDate || entry.isSectionHeader || isCarryCandidate(entry)) continue;
    // Linhas de continuação podem preencher até 3 colunas (SISPAG do Itaú:
    // "ESPECIFARMA COM DE | Boleto outros | NF286536-"); antes o limite era 2
    // e o nome do favorecido se perdia.
    if (entry.nonEmptyCount === 0 || entry.nonEmptyCount > 3 || entry.hasMoney) {
      skipped.push(entry.norm);
      continue;
    }

    const pageBlocks = blocksByPage.get(entry.page) || [];
    let lo = 0;
    let hi = pageBlocks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pageBlocks[mid].y >= entry.y) lo = mid + 1;
      else hi = mid;
    }
    const above = lo > 0 ? pageBlocks[lo - 1] : null;
    const below = lo < pageBlocks.length ? pageBlocks[lo] : null;

    const aboveDistance = above ? above.y - entry.y : Infinity;
    const belowDistance = below ? entry.y - below.y : Infinity;
    // O padrão do mercado é a continuação logo ABAIXO da linha do lançamento.
    // Só escolhemos o bloco de baixo quando ele está claramente mais perto —
    // é o caso do bloco com a data na linha do meio (extrato do Itaú).
    const preferBelow =
      below !== null && belowDistance <= CONTINUATION_RANGE && belowDistance * 4 <= aboveDistance * 3;
    let target = null;
    if (preferBelow) target = below;
    else if (above && aboveDistance <= CONTINUATION_RANGE) target = above;
    else if (below && belowDistance <= CONTINUATION_RANGE) target = below;

    // Cabeçalho de seção é um rótulo isolado: só recebe texto que esteja
    // abaixo dele (texto acima é rodapé/observação da tabela anterior).
    if (target && target.isSectionHeader && entry.y > target.y) target = null;

    // Nunca no cabeçalho da página seguinte (era o que colava "Página : 2 / 6"
    // na última linha): o bloco precisa estar na mesma página.
    if (!target) {
      skipped.push(entry.norm);
      continue;
    }
    target.extra.push(entry);
  }

  const assembledRows = [];
  for (const block of blocks) {
    const parts = [
      { y: block.y, cells: block.cells },
      ...block.extra.map((entry) => ({ y: entry.y, cells: entry.cells })),
    ].sort((a, b) => b.y - a.y);
    const assembled = Array.from({ length: colBounds.length }, () => '');
    for (const part of parts) {
      for (let col = 0; col < assembled.length; col++) {
        const value = part.cells[col];
        if (value) assembled[col] = cleanWhitespace(`${assembled[col]} ${value}`);
      }
    }
    if (!assembled.some(Boolean)) continue;
    assembledRows.push({
      cells: assembled,
      inheritsDate: Boolean(block.inheritsDate),
      page: block.page,
      y: block.y,
    });
  }

  // Data herdada: descobrimos qual coluna é a de data (a que tem mais datas
  // nas linhas que trazem data) e repetimos a última data vista para as linhas
  // marcadas como continuação do mesmo dia.
  const dateVotes = new Array(colBounds.length).fill(0);
  for (const entry of entries) {
    if (!entry.hasDate) continue;
    entry.cells.forEach((value, idx) => {
      if (value && parseDateValue(value) !== null) dateVotes[idx] += 1;
    });
  }
  const dateColIdx = dateVotes.some((votes) => votes > 0)
    ? dateVotes.indexOf(Math.max(...dateVotes))
    : -1;

  let lastDate = '';
  for (const row of assembledRows) {
    const ownDate = row.cells.some((value) => parseDateValue(value) !== null);
    if (ownDate) {
      lastDate = row.cells.find((value) => parseDateValue(value) !== null) || lastDate;
    } else if (row.inheritsDate && lastDate && dateColIdx >= 0 && !row.cells[dateColIdx]) {
      row.cells[dateColIdx] = lastDate;
    }
  }

  for (const row of assembledRows) rows.push(row.cells);

  // Índice da linha em que cada checkpoint aparece: o treinador soma os
  // lançamentos entre dois checkpoints para conferir o saldo.
  const rowPositions = assembledRows.map((row) => ({ page: row.page, y: row.y }));
  for (const checkpoint of checkpoints) {
    const index = rowPositions.findIndex(
      (position) =>
        position.page > checkpoint.page ||
        (position.page === checkpoint.page && position.y < checkpoint.y)
    );
    checkpoint.rowIdx = index === -1 ? assembledRows.length : index;
    delete checkpoint.y;
  }

  return {
    headers,
    rows,
    bannerLines: bannerLines.filter(Boolean),
    skippedRows: skipped.length,
    columnCount: colBounds.length,
    checkpoints,
  };
}

/**
 * Diz, em uma frase, por que um PDF não rendeu tabela quando quase não há texto.
 *
 * Extrato escaneado (foto/print) costuma trazer só o cabeçalho do banco e o
 * número da página — o suficiente para não ser "PDF sem texto", mas longe de
 * ser um extrato. Nesse caso o usuário precisa saber que o problema é o formato,
 * não a ferramenta: a saída é baixar o extrato em .xlsx/.csv ou o PDF do
 * internet banking.
 */
function describeSparseText(lines, pageCount) {
  const caracteres = lines.reduce(
    (total, line) => total + line.items.reduce((soma, item) => soma + item.str.length, 0),
    0
  );
  const porPagina = caracteres / Math.max(1, pageCount || 1);
  if (porPagina >= 120) return '';
  return (
    ' O PDF quase não tem texto selecionável (média de ' +
    `${Math.round(porPagina)} caractere(s) por página), o que indica documento escaneado: ` +
    'baixe o extrato em .xlsx/.csv ou em PDF direto do internet banking.'
  );
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
    throw new Error(`${error.message}${describeSparseText(lines, pageCount)} (${fileName})`);
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
    checkpoints: table.checkpoints || [],
  };
}
