/**
 * Conversor — Exportadores (.xlsx e .pdf)
 *
 * Layout padronizado: data (dd/mm/aaaa) | valor (0000,00 / -0000,00) | historico (texto)
 * Ambos os exportadores são funções puras de geração de arquivo: recebem os
 * registros já normalizados e devolvem/baixam o documento.
 */

import { formatValuePlainBr, isoToUtcDate } from './format.js';
import { formatPeriodLabel, summarizeRecords } from './summary.js';

/** Limite de linhas da planilha Excel (menos a linha de cabeçalho e margem). */
const EXCEL_ROW_LIMIT = 1048576 - 2;

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function triggerDownload(blob, fileName) {
  if (typeof document === 'undefined') return;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 1500);
}

function normalizeRecords(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => row && isoToUtcDate(row.dateIso))
    .map((row) => ({
      dateIso: row.dateIso,
      dateBr: row.dateBr || '',
      value: Math.round(Number(row.value) * 100) / 100 || 0,
      history: String(row.history ?? ''),
      sourceFile: row.sourceFile || '',
    }));
}

/**
 * Exporta os registros para .xlsx em uma única aba (pronta para importação contábil).
 * @returns {Promise<ArrayBuffer>}
 */
export async function exportToXlsx(rows, outputName = 'Conciliacao_Custodio.xlsx', ExcelJSRef, options = {}) {
  const ExcelJS = ExcelJSRef || (typeof window !== 'undefined' ? window.ExcelJS : undefined);
  if (!ExcelJS) throw new Error('Biblioteca ExcelJS não carregada.');

  const records = normalizeRecords(rows);
  if (records.length === 0) throw new Error('Não há lançamentos válidos para exportar.');
  if (records.length > EXCEL_ROW_LIMIT) {
    throw new Error(
      `O arquivo tem ${records.length} lançamentos e o Excel aceita até ${EXCEL_ROW_LIMIT}. Divida a conciliação.`
    );
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Conversor';
  workbook.created = new Date();

  const worksheet = workbook.addWorksheet(options.sheetName || 'Conciliacao', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  const longestHistory = records.reduce((max, record) => Math.max(max, record.history.length), 0);

  worksheet.columns = [
    { header: 'data', key: 'data', width: 14 },
    { header: 'valor', key: 'valor', width: 16 },
    { header: 'historico', key: 'historico', width: Math.min(120, Math.max(60, longestHistory + 6)) },
  ];

  const headerRow = worksheet.getRow(1);
  headerRow.height = 24;
  headerRow.eachCell((cell, colNumber) => {
    cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F2744' } };
    cell.alignment = { horizontal: colNumber === 3 ? 'left' : 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFD9D9D9' } },
      bottom: { style: 'thin', color: { argb: 'FFD9D9D9' } },
      left: { style: 'thin', color: { argb: 'FFD9D9D9' } },
      right: { style: 'thin', color: { argb: 'FFD9D9D9' } },
    };
  });

  const thinBorder = {
    top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
    bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
    left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
    right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
  };

  for (const record of records) {
    const row = worksheet.addRow({
      data: isoToUtcDate(record.dateIso),
      valor: record.value,
      historico: record.history,
    });
    row.height = 18;

    const dateCell = row.getCell(1);
    dateCell.numFmt = 'dd/mm/yyyy';
    dateCell.font = { name: 'Calibri', size: 10, color: { argb: 'FF111827' } };
    dateCell.alignment = { horizontal: 'center', vertical: 'middle' };
    dateCell.border = thinBorder;

    const valueCell = row.getCell(2);
    valueCell.numFmt = '0.00';
    valueCell.font = { name: 'Calibri', size: 10, color: { argb: 'FF111827' } };
    valueCell.alignment = { horizontal: 'right', vertical: 'middle' };
    valueCell.border = thinBorder;

    const historyCell = row.getCell(3);
    historyCell.numFmt = '@';
    historyCell.font = { name: 'Calibri', size: 10, color: { argb: 'FF111827' } };
    historyCell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: false };
    historyCell.border = thinBorder;
  }

  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: records.length + 1, column: 3 },
  };

  const buffer = await workbook.xlsx.writeBuffer();

  if (typeof document !== 'undefined' && typeof Blob !== 'undefined') {
    triggerDownload(new Blob([buffer], { type: XLSX_MIME }), outputName);
  }
  return buffer;
}

/* -------------------------------------------------------------------------- */
/*                                    PDF                                     */
/* -------------------------------------------------------------------------- */

function resolveAutoTable(doc) {
  if (typeof doc.autoTable === 'function') return (options) => doc.autoTable(options);
  if (typeof globalThis !== 'undefined' && typeof globalThis.autoTable === 'function') {
    return (options) => globalThis.autoTable(doc, options);
  }
  if (typeof window !== 'undefined' && typeof window.autoTable === 'function') {
    return (options) => window.autoTable(doc, options);
  }
  throw new Error('Plugin jsPDF-AutoTable não inicializado.');
}

/**
 * Exporta os registros para um relatório A4 paisagem paginado.
 * @param {object} [options] `{ title?, autoSave? }` — `autoSave: false` apenas
 *   gera o documento sem baixar (usado em testes e pré-visualização).
 * @returns {object} instância do jsPDF (útil para testes/preview)
 */
export function exportToPdf(rows, summary, outputName = 'Conciliacao_Custodio.pdf', options = {}) {
  const jspdfNamespace = typeof window !== 'undefined' ? window.jspdf : undefined;
  const jsPDF = jspdfNamespace?.jsPDF;
  if (!jsPDF) throw new Error('Biblioteca jsPDF não carregada.');

  const records = normalizeRecords(rows);
  if (records.length === 0) throw new Error('Não há lançamentos válidos para exportar.');

  const totals = summary && Number.isFinite(summary.netTotal) ? summary : summarizeRecords(records);
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const autoTable = resolveAutoTable(doc);

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginX = 12;
  const title = options.title || 'CONVERSOR — Conciliação Unificada';
  const generatedAt = new Date().toLocaleString('pt-BR');

  const drawHeader = () => {
    doc.setFillColor(15, 39, 68);
    doc.rect(0, 0, pageWidth, 24, 'F');

    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.text(title, marginX, 10.5);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.text(
      [
        formatPeriodLabel(totals),
        `Lançamentos: ${records.length}`,
        `Recebimentos: ${formatValuePlainBr(totals.totalIn)}`,
        `Pagamentos: ${formatValuePlainBr(Math.abs(totals.totalOut))}`,
        `Saldo: ${formatValuePlainBr(totals.netTotal)}`,
      ].join('   •   '),
      marginX,
      17.5
    );
  };

  const drawFooter = (pageNumber) => {
    const pageCount = doc.internal.getNumberOfPages();
    doc.setFontSize(7.5);
    doc.setTextColor(100, 116, 139);
    doc.text(`Conversor • Gerado em ${generatedAt}`, marginX, pageHeight - 6);
    doc.text(`Página ${pageNumber} de ${pageCount}`, pageWidth - marginX, pageHeight - 6, {
      align: 'right',
    });
  };

  const body = records.map((record) => [
    record.dateBr || record.dateIso.split('-').reverse().join('/'),
    formatValuePlainBr(record.value),
    record.history,
  ]);

  const foot = [
    [
      'TOTAIS',
      formatValuePlainBr(totals.netTotal),
      `${records.length} lançamento(s) • Entradas ${formatValuePlainBr(totals.totalIn)} • Saídas ${formatValuePlainBr(Math.abs(totals.totalOut))}`,
    ],
  ];

  autoTable({
    startY: 28,
    margin: { left: marginX, right: marginX, top: 28, bottom: 14 },
    head: [['data', 'valor', 'historico']],
    body,
    foot,
    theme: 'grid',
    styles: {
      font: 'helvetica',
      fontSize: 7.8,
      cellPadding: 2,
      textColor: [17, 24, 39],
      lineColor: [226, 232, 240],
      lineWidth: 0.2,
      overflow: 'linebreak',
    },
    headStyles: {
      fillColor: [30, 58, 95],
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 8.5,
      halign: 'left',
    },
    footStyles: {
      fillColor: [241, 245, 249],
      textColor: [15, 39, 68],
      fontStyle: 'bold',
      fontSize: 8,
      halign: 'left',
    },
    columnStyles: {
      0: { cellWidth: 23, halign: 'center' },
      1: { cellWidth: 30, halign: 'right', fontStyle: 'bold' },
      2: { cellWidth: 'auto', halign: 'left' },
    },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    didParseCell(hookData) {
      if (hookData.section === 'body' && hookData.column.index === 1) {
        const raw = String(hookData.cell.raw || '');
        hookData.cell.styles.textColor = raw.startsWith('-') ? [185, 28, 28] : [4, 120, 87];
      }
    },
    didDrawPage(data) {
      if (data.pageNumber > 1) drawHeader();
      drawFooter(data.pageNumber);
    },
  });

  if (options.autoSave !== false) doc.save(outputName);
  return doc;
}
