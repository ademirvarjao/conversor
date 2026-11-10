/**
 * Conversor Custódio — Parsers de Entrada (.pdf e .xlsx)
 * Extração geométrica adaptativa para PDFs (via PDF.js) e planilhas Excel (via ExcelJS).
 */

export function cleanWhitespace(str) {
  return String(str ?? '').replace(/\s+/g, ' ').trim();
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

/**
 * Tenta interpretar uma data nos formatos comuns BR/ISO/Excel.
 * Retorna string ISO 'YYYY-MM-DD' ou null.
 */
export function parseDateValue(val) {
  if (val == null || val === '') return null;

  if (val instanceof Date && !Number.isNaN(val.getTime())) {
    const y = val.getUTCFullYear();
    const m = val.getUTCMonth() + 1;
    const d = val.getUTCDate();
    if (y >= 1900 && y <= 2100) {
      return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    return null;
  }

  if (typeof val === 'number' && Number.isFinite(val) && val > 20000 && val < 80000) {
    // Excel serial date (epoch 1899-12-30)
    const utcMs = Date.UTC(1899, 11, 30) + Math.round(val) * 86400000;
    const d = new Date(utcMs);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  const s = cleanWhitespace(val);
  // dd/mm/yyyy ou dd-mm-yyyy ou dd.mm.yyyy
  let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})(?:\s.*)?$/);
  if (m) {
    const day = parseInt(m[1], 10);
    const mon = parseInt(m[2], 10);
    const yr = parseInt(m[3], 10);
    if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31 && yr >= 1900 && yr <= 2100) {
      return `${String(yr).padStart(4, '0')}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // dd/mm/yy
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2})$/);
  if (m) {
    const day = parseInt(m[1], 10);
    const mon = parseInt(m[2], 10);
    const yr = 2000 + parseInt(m[3], 10);
    if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) {
      return `${String(yr).padStart(4, '0')}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // yyyy-mm-dd ou yyyy/mm/dd
  m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})(?:[T\s].*)?$/);
  if (m) {
    const yr = parseInt(m[1], 10);
    const mon = parseInt(m[2], 10);
    const day = parseInt(m[3], 10);
    if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31 && yr >= 1900 && yr <= 2100) {
      return `${String(yr).padStart(4, '0')}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  return null;
}

export function formatIsoToBrDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

export function isoToUtcDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/**
 * Faz o parse de um valor monetário em diversos formatos:
 * -R$ 2.000,00 | R$ 8.002,12 | 1234,56 | -1234.56 | (1.234,56) | 1.234,56 D | 1.234,56 C
 * Retorna { value: number, hasExplicitSign: boolean, dcTag: 'D'|'C'|null } ou null.
 */
export function parseMoneyValue(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return {
      value: Math.round(raw * 100) / 100,
      hasExplicitSign: raw < 0,
      dcTag: null,
    };
  }

  let s = cleanWhitespace(raw);
  if (!s) return null;

  // Ignorar datas ou códigos com barras/muitos hífens que não parecem valores
  if (/^\d{1,2}[\/]\d{1,2}[\/]\d{2,4}$/.test(s)) return null;

  let dcTag = null;
  const dcMatch = s.match(/\s*([DCdc])(?:\s*\))?$/);
  if (dcMatch && /\d/.test(s)) {
    dcTag = dcMatch[1].toUpperCase();
    s = s.slice(0, dcMatch.index).trim();
  }

  let negative = false;
  let hasExplicitSign = false;

  if (/^\(.*\)$/.test(s)) {
    negative = true;
    hasExplicitSign = true;
    s = s.slice(1, -1).trim();
  }

  // Remove currency symbols (R$, US$, $, EUR)
  if (/^-/.test(s) || /^R\$\s*-/i.test(s) || /^-\s*R\$/i.test(s)) {
    negative = true;
    hasExplicitSign = true;
  } else if (/^\+/.test(s)) {
    hasExplicitSign = true;
  }

  s = s.replace(/R\$|US\$|BRL|\$/gi, '').trim();
  if (s.startsWith('-')) {
    negative = true;
    hasExplicitSign = true;
    s = s.slice(1).trim();
  } else if (s.startsWith('+')) {
    hasExplicitSign = true;
    s = s.slice(1).trim();
  }

  if (dcTag === 'D') {
    negative = true;
    hasExplicitSign = true;
  } else if (dcTag === 'C') {
    negative = false;
    hasExplicitSign = true;
  }

  // Remove internal spaces (e.g. "2 .000,00")
  s = s.replace(/\s+/g, '');

  // Must now look like a number (digits with . and/or ,)
  if (!/^\d[\d.,]*$/.test(s)) return null;

  // Determine decimal separator
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  let normalized;

  if (hasComma && hasDot) {
    // Compare last positions
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      // BR: 1.234,56
      normalized = s.replace(/\./g, '').replace(',', '.');
    } else {
      // US: 1,234.56
      normalized = s.replace(/,/g, '');
    }
  } else if (hasComma) {
    // Check if comma is decimal (e.g. ,00 or ,5 or ,123 when single comma <=2 decimals)
    const parts = s.split(',');
    if (parts.length === 2 && parts[1].length <= 2) {
      normalized = s.replace(',', '.');
    } else if (parts.length === 2 && parts[1].length === 3 && parts[0].length <= 3) {
      // Ambiguous like 1,234 — in BR finance usually decimal or thousand; treat 3 digits after comma with no dot as thousand if integer >= 100? Usually decimal has 2 digits.
      normalized = s.replace(/,/g, '');
    } else {
      normalized = s.replace(',', '.');
    }
  } else if (hasDot) {
    const parts = s.split('.');
    if (parts.length === 2 && parts[1].length <= 2) {
      normalized = s;
    } else if (parts.every((p, idx) => idx === 0 || p.length === 3)) {
      // 1.234 or 1.234.567 (BR thousands without cents)
      normalized = s.replace(/\./g, '');
    } else {
      normalized = s;
    }
  } else {
    normalized = s;
  }

  const num = Number(normalized);
  if (!Number.isFinite(num)) return null;
  const signed = negative ? -Math.abs(num) : num;
  return {
    value: Math.round(signed * 100) / 100,
    hasExplicitSign,
    dcTag,
  };
}

function cellToString(val) {
  if (val == null) return '';
  if (val instanceof Date) {
    const y = val.getUTCFullYear();
    const m = String(val.getUTCMonth() + 1).padStart(2, '0');
    const d = String(val.getUTCDate()).padStart(2, '0');
    return `${d}/${m}/${y}`;
  }
  if (typeof val === 'object') {
    if (val.richText && Array.isArray(val.richText)) {
      return val.richText.map((r) => r.text || '').join('');
    }
    if (val.text != null) return String(val.text);
    if (val.result !== undefined) return cellToString(val.result);
    if (val.hyperlink) return String(val.hyperlink);
    if (val.error) return '';
  }
  return String(val);
}

function cellToRawValue(val) {
  if (val == null) return null;
  if (typeof val === 'object' && !(val instanceof Date)) {
    if (val.result !== undefined) return val.result;
    if (val.richText && Array.isArray(val.richText)) {
      return val.richText.map((r) => r.text || '').join('');
    }
    if (val.text != null) return val.text;
    if (val.error) return null;
  }
  return val;
}

function isSummaryOrNoiseRow(rowCells) {
  const joined = normalizeText(rowCells.map(cellToString).join(' '));
  if (!joined) return true;
  if (/^(total|subtotal|saldo\s+(anterior|atual|final|inicial|do\s+dia)|resumo|pagina\s+\d+|emitido\s+em)/.test(joined)) {
    return true;
  }
  // Row with "TOTAL:" and only 1 or 2 non-empty cells
  const nonEmpty = rowCells.filter((c) => cleanWhitespace(cellToString(c)) !== '');
  if (nonEmpty.length <= 2 && /\btotal\b|\bsaldo\b|\bcnpj\b|\bperiodo\b|\bconciliacao\b/.test(joined)) {
    return true;
  }
  return false;
}

/**
 * Parser de arquivos .xlsx (usando ExcelJS)
 */
export async function parseXlsxFile(arrayBuffer, fileName, ExcelJSRef) {
  const ExcelJS = ExcelJSRef || window.ExcelJS;
  if (!ExcelJS) throw new Error('Biblioteca ExcelJS não carregada.');

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(arrayBuffer);

  const sheets = [];
  for (const ws of wb.worksheets) {
    if (ws.state === 'hidden' || ws.state === 'veryHidden') continue;

    // Extrair matriz de valores brutos respeitando células mescladas no cabeçalho
    const rawRows = [];
    let maxCols = 0;
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const vals = [];
      const colCount = Math.max(row.cellCount, ws.columnCount || 0);
      for (let c = 1; c <= colCount; c++) {
        const cell = row.getCell(c);
        vals.push(cellToRawValue(cell.value));
      }
      // Trim trailing empty cells
      while (vals.length > 0 && (vals[vals.length - 1] == null || cleanWhitespace(cellToString(vals[vals.length - 1])) === '')) {
        vals.pop();
      }
      if (vals.length > 0) {
        maxCols = Math.max(maxCols, vals.length);
        rawRows.push({ rowNumber, cells: vals });
      }
    });

    if (rawRows.length === 0) continue;

    // Pad rows to maxCols
    for (const r of rawRows) {
      while (r.cells.length < maxCols) r.cells.push(null);
    }

    // Detectar linha de cabeçalho: primeira linha densa (>=2 colunas não-vazias) que precede linhas de dados com data ou número
    let headerIdx = 0;
    let bestScore = -1;
    const scanLimit = Math.min(rawRows.length - 1, 25);

    for (let i = 0; i < scanLimit; i++) {
      const cells = rawRows[i].cells;
      const nonEmpty = cells.filter((c) => cleanWhitespace(cellToString(c)) !== '');
      if (nonEmpty.length < 2) continue;

      // Cabeçalhos geralmente têm texto (não datas puras nem números puros)
      const textOnly = nonEmpty.filter((c) => !parseDateValue(c) && !parseMoneyValue(c));
      const textRatio = textOnly.length / nonEmpty.length;

      // Verificar se as próximas linhas têm datas ou valores
      let nextDataSignal = 0;
      for (let k = i + 1; k < Math.min(rawRows.length, i + 6); k++) {
        const nc = rawRows[k].cells;
        const hasDate = nc.some((c) => parseDateValue(c) !== null);
        const hasMoney = nc.some((c) => parseMoneyValue(c) !== null);
        if (hasDate) nextDataSignal += 2;
        if (hasMoney) nextDataSignal += 1.5;
      }

      const headerKeywords = nonEmpty.filter((c) =>
        /\b(data|dt|valor|vr|vlr|historico|descricao|titulo|tipo|fornecedor|cliente|centro|natureza|credito|debito|lancamento|documento)\b/.test(
          normalizeText(cellToString(c))
        )
      ).length;

      const score = textRatio * 3 + nonEmpty.length * 0.6 + nextDataSignal + headerKeywords * 2.5;
      if (score > bestScore && textRatio >= 0.5) {
        bestScore = score;
        headerIdx = i;
      }
    }

    // Se a linha 0 já parece dados diretos sem cabeçalho
    const firstRowHasDate = rawRows[0].cells.some((c) => parseDateValue(c) !== null);
    let headers;
    let dataStartIdx;
    let bannerLines = [];

    if (firstRowHasDate && bestScore < 4) {
      headers = Array.from({ length: maxCols }, (_, idx) => `Coluna ${idx + 1}`);
      dataStartIdx = 0;
    } else {
      bannerLines = rawRows.slice(0, headerIdx).map((r) => cleanWhitespace(r.cells.map(cellToString).join(' '))).filter(Boolean);
      headers = rawRows[headerIdx].cells.map((c, idx) => {
        const s = cleanWhitespace(cellToString(c));
        return s || `Coluna ${idx + 1}`;
      });
      dataStartIdx = headerIdx + 1;
    }

    // Remover colunas 100% vazias
    const activeColIndices = [];
    for (let c = 0; c < maxCols; c++) {
      const hasHeader = headers[c] && !/^Coluna \d+$/.test(headers[c]);
      const hasData = rawRows.slice(dataStartIdx).some((r) => cleanWhitespace(cellToString(r.cells[c])) !== '');
      if (hasHeader || hasData) activeColIndices.push(c);
    }

    const cleanHeaders = activeColIndices.map((c) => headers[c]);
    const rows = [];
    let skippedRows = 0;

    for (let i = dataStartIdx; i < rawRows.length; i++) {
      const slice = activeColIndices.map((c) => rawRows[i].cells[c]);
      if (isSummaryOrNoiseRow(slice)) {
        skippedRows++;
        continue;
      }
      // Pular repetição de cabeçalho
      const normRow = slice.map((c) => normalizeText(cellToString(c)));
      const normHeaders = cleanHeaders.map((h) => normalizeText(h));
      if (normRow.join('|') === normHeaders.join('|')) {
        skippedRows++;
        continue;
      }
      rows.push(slice.map((c) => (c instanceof Date ? c : cellToString(c))));
    }

    sheets.push({
      sheetName: ws.name,
      headers: cleanHeaders,
      rows,
      bannerLines,
      skippedRows,
    });
  }

  if (sheets.length === 0) {
    throw new Error(`Nenhuma aba com dados encontrada em "${fileName}".`);
  }

  // Escolher a aba com mais linhas de dados
  sheets.sort((a, b) => b.rows.length - a.rows.length);
  const best = sheets[0];

  return {
    fileName,
    fileType: 'xlsx',
    sheetName: best.sheetName,
    availableSheets: sheets.map((s) => ({ name: s.sheetName, rowCount: s.rows.length })),
    allSheetsData: sheets,
    headers: best.headers,
    rows: best.rows,
    bannerLines: best.bannerLines,
    skippedRows: best.skippedRows,
  };
}

/**
 * Agrupa valores 1D (x0) próximos em clusters de colunas.
 */
function clusterPositions(xs, tolerance) {
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
  return clusters.map((c) => ({
    anchor: c.sum / c.count,
    min: c.min,
    max: c.max,
    count: c.count,
  }));
}

function isCurrencySymbolOnly(str) {
  return /^[-+]?\s*(R\$|US\$|\$|€|£)\s*$/i.test(str);
}

function isNumericToken(str) {
  return /^[-+(]?\s*\d[\d.,]*\s*[DCdc)]?$/.test(cleanWhitespace(str));
}

/**
 * Parser geométrico adaptativo de PDFs via PDF.js
 * Extrai linhas horizontais, descobre colunas por ancoragem de coordenadas X,
 * combina cabeçalhos multi-linha (ex: DATA / PAGAMENTO) e ignora cabeçalhos repetidos/totais.
 */
export async function parsePdfFile(arrayBuffer, fileName, pdfjsLib) {
  if (!pdfjsLib) throw new Error('Biblioteca PDF.js não carregada.');

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(arrayBuffer),
    cMapUrl: './vendor/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: './vendor/pdfjs/standard_fonts/',
    verbosity: 0,
  });
  const doc = await loadingTask.promise;

  const allPageLines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const byY = [];

    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue;
      const x = item.transform[4];
      const y = item.transform[5];
      const w = item.width || 0;
      const h = Math.abs(item.transform[3]) || item.height || 10;
      const str = item.str.trim();

      // Agrupar em linhas horizontais com tolerância de 2.5pt
      let line = byY.find((l) => Math.abs(l.y - y) <= 2.5);
      if (!line) {
        line = { page: p, y, h, items: [] };
        byY.push(line);
      }
      line.items.push({ x, y, w, h, str });
    }

    // Ordenar linhas de cima para baixo (PDF Y decrescente) e itens da esquerda para direita
    byY.sort((a, b) => b.y - a.y);
    for (const line of byY) {
      line.items.sort((a, b) => a.x - b.x);
      // Unir símbolo monetário isolado (-R$ / R$) ao número imediatamente à direita
      const merged = [];
      for (let i = 0; i < line.items.length; i++) {
        const cur = line.items[i];
        const next = line.items[i + 1];
        if (next && isCurrencySymbolOnly(cur.str) && isNumericToken(next.str)) {
          merged.push({
            x: cur.x,
            y: cur.y,
            w: (next.x + next.w) - cur.x,
            h: Math.max(cur.h, next.h),
            str: `${cur.str} ${next.str}`,
            isCurrency: true,
            numX: next.x,
            numRight: next.x + next.w,
          });
          i++;
        } else {
          merged.push({ ...cur });
        }
      }
      line.items = merged;
      allPageLines.push(line);
    }
  }

  if (allPageLines.length === 0) {
    throw new Error(`Nenhum texto extraível encontrado em "${fileName}". (PDF pode ser apenas imagem/escaneado.)`);
  }

  // 1. Identificar linhas candidatas a dados tabulares: linhas com >= 3 colunas OU contendo data + valor monetário
  const candidateDataLines = [];
  for (const line of allPageLines) {
    const hasDate = line.items.some((it) => parseDateValue(it.str) !== null);
    const hasMoney = line.items.some((it) => parseMoneyValue(it.str) !== null);
    if ((hasDate && hasMoney) || (hasDate && line.items.length >= 3)) {
      candidateDataLines.push(line);
    }
  }

  if (candidateDataLines.length === 0) {
    throw new Error(`Não foi possível identificar linhas tabulares com datas/valores em "${fileName}".`);
  }

  // 2. Descobrir âncoras de colunas usando frequência de posições X0 (e X1 para valores alinhados à direita)
  const allItems = [];
  for (const line of candidateDataLines) {
    for (const it of line.items) {
      const right = it.numRight ?? (it.x + (it.w || 0));
      const isMoney = parseMoneyValue(it.str) !== null;
      allItems.push({ it, x: it.x, right, isMoney });
    }
  }

  const rawClusters = clusterPositions(allItems.map((a) => a.x), 14);
  const minSupport = Math.max(2, Math.floor(candidateDataLines.length * 0.30));

  // Também preservar clusters raros que tenham valores monetários (ex: coluna "Crédito" preenchida só em 10% das linhas)
  let colClusters = rawClusters.filter((c) => {
    if (c.count >= minSupport) return true;
    const hasMoneyInCluster = allItems.some(
      (a) => a.isMoney && a.x >= c.min - 2 && a.x <= c.max + 2
    );
    return hasMoneyInCluster && c.count >= 1;
  });

  if (colClusters.length < 2) {
    colClusters = rawClusters.filter((c) => c.count >= 1);
  }
  colClusters.sort((a, b) => a.anchor - b.anchor);

  // Unir clusters numéricos que compartilham alinhamento à direita (ex: "12,50" e "150.000,00" sem "R$" fixo)
  let mergedRight = true;
  while (mergedRight && colClusters.length > 2) {
    mergedRight = false;
    for (let i = 0; i < colClusters.length - 1; i++) {
      const cA = colClusters[i];
      const cB = colClusters[i + 1];
      const itemsA = allItems.filter((a) => a.x >= cA.min - 2 && a.x <= cA.max + 2);
      const itemsB = allItems.filter((a) => a.x >= cB.min - 2 && a.x <= cB.max + 2);
      const moneyRatioA = itemsA.filter((a) => a.isMoney).length / Math.max(1, itemsA.length);
      const moneyRatioB = itemsB.filter((a) => a.isMoney).length / Math.max(1, itemsB.length);
      if (moneyRatioA >= 0.7 && moneyRatioB >= 0.7 && cB.min - cA.max <= 35) {
        const avgRightA = itemsA.reduce((s, a) => s + a.right, 0) / itemsA.length;
        const avgRightB = itemsB.reduce((s, a) => s + a.right, 0) / itemsB.length;
        if (Math.abs(avgRightA - avgRightB) <= 10) {
          cA.min = Math.min(cA.min, cB.min);
          cA.max = Math.max(cA.max, cB.max);
          cA.anchor = (cA.min + cA.max) / 2;
          cA.count += cB.count;
          colClusters.splice(i + 1, 1);
          mergedRight = true;
          break;
        }
      }
    }
  }

  // Mesclar clusters adjacentes que na verdade são continuação inline dentro da mesma coluna
  // (ex: "154 - E801... |" seguido a ~6pt por "04.02 |" dentro de "LOCAL | CENTRO DE CUSTO | NATUREZA")
  let merged = true;
  while (merged && colClusters.length > 2) {
    merged = false;
    for (let i = 0; i < colClusters.length - 1; i++) {
      const cA = colClusters[i];
      const cB = colClusters[i + 1];
      const midBoundary = (cA.anchor + cB.min) / 2;
      let cleanGapRows = 0;
      let totalPairRows = 0;
      let moneyOrDateA = 0;

      for (const line of candidateDataLines) {
        const itemsA = line.items.filter((it) => it.x >= (i === 0 ? -Infinity : (colClusters[i - 1].anchor + cA.min) / 2) && it.x < midBoundary);
        const itemsB = line.items.filter((it) => it.x >= midBoundary && it.x < (i + 2 < colClusters.length ? (cB.anchor + colClusters[i + 2].min) / 2 : Infinity));
        if (itemsA.length > 0 && itemsB.length > 0) {
          totalPairRows++;
          const textA = cleanWhitespace(itemsA.map((x) => x.str).join(' '));
          if (parseDateValue(textA) !== null || parseMoneyValue(textA) !== null) {
            moneyOrDateA++;
          }
          const lastA = itemsA[itemsA.length - 1];
          const firstB = itemsB[0];
          const rightA = lastA.numRight ?? (lastA.x + (lastA.w || 0));
          const gap = firstB.x - rightA;
          if (gap >= 10) cleanGapRows++;
        }
      }

      const isTypedColA = totalPairRows > 0 && moneyOrDateA / totalPairRows >= 0.5;
      if (!isTypedColA && totalPairRows > 0 && cleanGapRows / totalPairRows < 0.25) {
        // cB é continuação inline de cA — mesclar cB em cA
        cA.max = Math.max(cA.max, cB.max);
        colClusters.splice(i + 1, 1);
        merged = true;
        break;
      }
    }
  }

  // Calcular limites horizontais [start, end) de cada coluna descoberta
  const colBounds = colClusters.map((c, idx) => ({
    idx,
    anchor: c.anchor,
    start: idx === 0 ? -Infinity : c.min - 8,
    end: Infinity,
  }));
  for (let i = 0; i < colBounds.length - 1; i++) {
    // Limite entre coluna i e i+1: logo antes de colClusters[i+1].min (com pequena margem)
    const nextMin = colClusters[i + 1].min;
    const curAnchor = colClusters[i].anchor;
    const boundary = Math.max((curAnchor + nextMin) / 2, nextMin - 10);
    colBounds[i].end = boundary;
    colBounds[i + 1].start = boundary;
  }

  function assignItemToColumn(item) {
    // Primeiro tenta por x0 dentro de [start, end)
    for (const b of colBounds) {
      if (item.x >= b.start && item.x < b.end) return b.idx;
    }
    // Fallback por menor distância ao anchor
    let bestIdx = 0;
    let bestDist = Infinity;
    for (const b of colBounds) {
      const dist = Math.abs(item.x - b.anchor);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = b.idx;
      }
    }
    return bestIdx;
  }

  // 3. Localizar zona de cabeçalho acima da primeira linha de dados na Página 1
  const firstDataLine = candidateDataLines[0];
  const p1LinesAbove = allPageLines.filter(
    (l) => l.page === firstDataLine.page && l.y > firstDataLine.y
  );

  // Linhas imediatamente acima (dentro de ~45pt) que não são banner/CNPJ/TOTAL
  const headerLines = [];
  const bannerLines = [];
  const sortedAbove = [...p1LinesAbove].sort((a, b) => a.y - b.y); // mais próximas do dado primeiro

  for (const l of sortedAbove) {
    const lineText = cleanWhitespace(l.items.map((i) => i.str).join(' '));
    const norm = normalizeText(lineText);
    const isBanner =
      /\b(cnpj|total|conciliacao|periodo|ag\.|c\/c|banco|emitido|pagina|ltda|s\.a\.|relatorio)\b/.test(norm) ||
      l.items.length === 1 && lineText.length > 35 && !/\|/.test(lineText);

    if (!isBanner && l.y - firstDataLine.y <= 45 && bannerLines.length === 0) {
      headerLines.push(l);
    } else {
      bannerLines.push(lineText);
    }
  }
  bannerLines.reverse();
  headerLines.sort((a, b) => b.y - a.y); // topo para baixo

  // Mapear cabeçalhos às colunas descobertas (usando centro X ou sobreposição, ideal para cabeçalhos centralizados/multi-linha)
  const headerParts = Array.from({ length: colBounds.length }, () => []);
  // Definir caixa visual real de cada coluna a partir dos dados para casar cabeçalhos centralizados
  const colDataExtents = colBounds.map((b) => ({ minX: b.anchor, maxX: b.anchor + 40 }));
  for (const line of candidateDataLines.slice(0, 40)) {
    for (const it of line.items) {
      const cIdx = assignItemToColumn(it);
      colDataExtents[cIdx].minX = Math.min(colDataExtents[cIdx].minX, it.x);
      colDataExtents[cIdx].maxX = Math.max(colDataExtents[cIdx].maxX, it.x + (it.w || 20));
    }
  }

  for (const hl of headerLines) {
    for (const it of hl.items) {
      const itCenter = it.x + (it.w || 0) / 2;
      // Escolher coluna cuja extensão ou intervalo [start, end) contenha o centro do item, ou mais próxima
      let bestCol = 0;
      let bestScore = -Infinity;
      for (let c = 0; c < colBounds.length; c++) {
        const ext = colDataExtents[c];
        const b = colBounds[c];
        const inExt = itCenter >= ext.minX - 10 && itCenter <= ext.maxX + 10;
        const inBound = itCenter >= b.start && itCenter < b.end;
        const extCenter = (ext.minX + ext.maxX) / 2;
        const dist = Math.abs(itCenter - extCenter);
        const score = (inExt ? 1000 : 0) + (inBound ? 500 : 0) - dist;
        if (score > bestScore) {
          bestScore = score;
          bestCol = c;
        }
      }
      headerParts[bestCol].push(it.str);
    }
  }

  const headers = headerParts.map((parts, idx) => {
    const joined = cleanWhitespace(parts.join(' '));
    return joined || `Coluna ${idx + 1}`;
  });

  // 4. Montar linhas de dados finais em todas as páginas (ignorando cabeçalhos repetidos, banners e totais)
  const headerNormSig = normalizeText(headers.join(' '));
  const dataYCutoffPage1 = firstDataLine.y + 2.5;
  const rows = [];
  let skippedRows = 0;

  for (const line of allPageLines) {
    if (line.page === firstDataLine.page && line.y > dataYCutoffPage1) continue;

    const lineText = cleanWhitespace(line.items.map((i) => i.str).join(' '));
    const norm = normalizeText(lineText);
    if (!norm) continue;

    // Pular repetição de cabeçalho ou rodapés/totais
    if (norm === headerNormSig || /^(total|subtotal|pagina\s+\d+|emitido)/.test(norm)) {
      skippedRows++;
      continue;
    }

    const cells = Array.from({ length: colBounds.length }, () => []);
    for (const it of line.items) {
      const cIdx = assignItemToColumn(it);
      cells[cIdx].push(it.str);
    }
    const rowStrings = cells.map((parts) => cleanWhitespace(parts.join(' ')));

    // Verificar se é uma linha de dados válida (contém data em alguma coluna OU valor + >=2 colunas preenchidas)
    const hasDate = rowStrings.some((s) => parseDateValue(s) !== null);
    const nonEmptyCount = rowStrings.filter(Boolean).length;

    if (hasDate) {
      rows.push(rowStrings);
    } else if (rows.length > 0 && nonEmptyCount > 0 && nonEmptyCount <= 2 && !/\btotal\b|\bsaldo\b/.test(norm)) {
      // Possível continuação de linha (descrição quebrada em 2 linhas no PDF)
      const hasMoney = rowStrings.some((s) => parseMoneyValue(s) !== null);
      if (!hasMoney) {
        const prev = rows[rows.length - 1];
        for (let c = 0; c < rowStrings.length; c++) {
          if (rowStrings[c]) {
            prev[c] = cleanWhitespace(`${prev[c]} ${rowStrings[c]}`);
          }
        }
      } else {
        skippedRows++;
      }
    } else {
      skippedRows++;
    }
  }

  return {
    fileName,
    fileType: 'pdf',
    pageCount: doc.numPages,
    headers,
    rows,
    bannerLines,
    skippedRows,
  };
}
