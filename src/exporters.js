/**
 * Conversor Custódio — Exportadores (.xlsx e .pdf)
 * Gera planilhas Excel e relatórios PDF padronizados no layout:
 * data (dd/mm/aaaa) | valor (0000,00 / -0000,00) | historico (texto)
 */

import { isoToUtcDate } from './parsers.js';

export function formatValuePlainBr(num) {
  const rounded = Math.round(Number(num) * 100) / 100;
  const fixed = Math.abs(rounded).toFixed(2).replace('.', ',');
  return rounded < 0 ? `-${fixed}` : fixed;
}

export function formatValueCurrencyBr(num) {
  const rounded = Math.round(Number(num) * 100) / 100;
  const formatted = Math.abs(rounded).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return rounded < 0 ? `-R$ ${formatted}` : `R$ ${formatted}`;
}

function triggerDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 1500);
}

/**
 * Exporta registros ordenados para .xlsx (aba única 'Conciliacao')
 */
export async function exportToXlsx(rows, outputName = 'Conciliacao_Custodio.xlsx', ExcelJSRef) {
  const ExcelJS = ExcelJSRef || window.ExcelJS;
  if (!ExcelJS) throw new Error('Biblioteca ExcelJS não carregada.');

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Conversor Custódio';
  wb.created = new Date();

  const ws = wb.addWorksheet('Conciliacao', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  ws.columns = [
    { header: 'data', key: 'data', width: 14 },
    { header: 'valor', key: 'valor', width: 16 },
    {
      header: 'historico',
      key: 'historico',
      width: Math.min(220, Math.max(60, ...rows.map((r) => (r.history?.length || 0) + 6))),
    },
  ];

  const headerRow = ws.getRow(1);
  headerRow.height = 24;
  headerRow.eachCell((cell, colNumber) => {
    cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F2744' } };
    cell.alignment = {
      horizontal: colNumber === 3 ? 'left' : 'center',
      vertical: 'middle',
    };
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

  for (let i = 0; i < rows.length; i++) {
    const rec = rows[i];
    const row = ws.addRow({
      data: isoToUtcDate(rec.dateIso),
      valor: Math.round(rec.value * 100) / 100,
      historico: String(rec.history ?? ''),
    });
    row.height = 18;

    const cDate = row.getCell(1);
    cDate.numFmt = 'dd/mm/yyyy';
    cDate.font = { name: 'Calibri', size: 10, color: { argb: 'FF111827' } };
    cDate.alignment = { horizontal: 'center', vertical: 'middle' };
    cDate.border = thinBorder;

    const cVal = row.getCell(2);
    cVal.numFmt = '0.00';
    cVal.font = { name: 'Calibri', size: 10, color: { argb: 'FF111827' } };
    cVal.alignment = { horizontal: 'right', vertical: 'middle' };
    cVal.border = thinBorder;

    const cHist = row.getCell(3);
    cHist.numFmt = '@';
    cHist.font = { name: 'Calibri', size: 10, color: { argb: 'FF111827' } };
    cHist.alignment = { horizontal: 'left', vertical: 'middle' };
    cHist.border = thinBorder;
  }

  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: rows.length + 1, column: 3 },
  };

  const buffer = await wb.xlsx.writeBuffer();
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    const blob = new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    triggerDownload(blob, outputName);
  }
  return buffer;
}

/**
 * Exporta registros ordenados para .pdf (usando jsPDF + autoTable)
 */
export function exportToPdf(rows, summary, outputName = 'Conciliacao_Custodio.pdf') {
  const jspdfNs = window.jspdf;
  if (!jspdfNs || !jspdfNs.jsPDF) {
    throw new Error('Biblioteca jsPDF não carregada.');
  }

  const { jsPDF } = jspdfNs;
  const doc = new jsPDF({
    orientation: 'landscape',
    unit: 'mm',
    format: 'a4',
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const marginX = 12;

  // Cabeçalho institucional
  doc.setFillColor(15, 39, 68);
  doc.rect(0, 0, pageWidth, 24, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text('CONVERSOR CUSTÓDIO — Conciliação Unificada', marginX, 10.5);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  const periodLabel = summary.minDateBr && summary.maxDateBr
    ? `Período: ${summary.minDateBr} a ${summary.maxDateBr}`
    : 'Período não identificado';
  doc.text(
    `${periodLabel}   •   Lançamentos: ${rows.length}   •   Recebimentos: ${formatValuePlainBr(summary.totalIn)}   •   Pagamentos: ${formatValuePlainBr(summary.totalOut)}   •   Saldo: ${formatValuePlainBr(summary.netTotal)}`,
    marginX,
    17.5
  );

  const body = rows.map((r) => [
    r.dateBr,
    formatValuePlainBr(r.value),
    String(r.history ?? ''),
  ]);

  const tableOpts = {
    startY: 28,
    margin: { left: marginX, right: marginX, top: 28, bottom: 14 },
    head: [['data', 'valor', 'historico']],
    body,
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
    columnStyles: {
      0: { cellWidth: 23, halign: 'center' },
      1: { cellWidth: 28, halign: 'right', fontStyle: 'bold' },
      2: { cellWidth: 'auto', halign: 'left' },
    },
    alternateRowStyles: {
      fillColor: [248, 250, 252],
    },
    didParseCell(hookData) {
      if (hookData.section === 'body' && hookData.column.index === 1) {
        const rawText = String(hookData.cell.raw || '');
        if (rawText.startsWith('-')) {
          hookData.cell.styles.textColor = [185, 28, 28];
        } else {
          hookData.cell.styles.textColor = [4, 120, 87];
        }
      }
      if (hookData.section === 'head' && hookData.column.index <= 1) {
        hookData.cell.styles.halign = hookData.column.index === 0 ? 'center' : 'right';
      }
    },
    didDrawPage(data) {
      const pageCount = doc.internal.getNumberOfPages();
      doc.setFontSize(7.5);
      doc.setTextColor(100, 116, 139);
      doc.text(
        `Conversor Custódio • Gerado em ${new Date().toLocaleString('pt-BR')}`,
        marginX,
        doc.internal.pageSize.getHeight() - 6
      );
      doc.text(
        `Página ${data.pageNumber} de ${pageCount}`,
        pageWidth - marginX,
        doc.internal.pageSize.getHeight() - 6,
        { align: 'right' }
      );
    },
  };

  if (typeof doc.autoTable === 'function') {
    doc.autoTable(tableOpts);
  } else if (typeof window.autoTable === 'function') {
    window.autoTable(doc, tableOpts);
  } else {
    throw new Error('Plugin jsPDF-AutoTable não inicializado.');
  }

  doc.save(outputName);
}
