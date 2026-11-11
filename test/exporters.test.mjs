import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

// Bibliotecas vendorizadas (UMD) registram-se em globalThis ao serem importadas,
// exatamente como os <script> do index.html fazem no navegador.
import '../vendor/exceljs/exceljs.min.js';
import '../vendor/jspdf/jspdf.umd.min.js';
import '../vendor/jspdf/jspdf.plugin.autotable.min.js';

import { exportToPdf, exportToXlsx } from '../src/exporters.js';
import { parseXlsxFile } from '../src/parsers.js';
import { summarizeRecords } from '../src/summary.js';

const ExcelJS = globalThis.ExcelJS;
const previousWindow = globalThis.window;
globalThis.window = { jspdf: globalThis.jspdf };
after(() => {
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
});

const records = [
  {
    dateIso: '2026-09-02',
    dateBr: '02/09/2026',
    value: 8002.12,
    history: 'TRANSFERENCIA ATLAS',
    sourceFile: 'extrato.xlsx',
  },
  {
    dateIso: '2026-09-10',
    dateBr: '10/09/2026',
    value: -45.9,
    history: 'TARIFA MANUTENCAO',
    sourceFile: 'extrato.xlsx',
  },
];

describe('exportToXlsx', () => {
  it('gera planilha padronizada e legível pelo próprio parser', async () => {
    const buffer = await exportToXlsx(records, 'saida.xlsx', ExcelJS);
    assert.ok(buffer.byteLength > 0);

    const parsed = await parseXlsxFile(buffer, 'saida.xlsx', ExcelJS);

    assert.equal(parsed.sheetName, 'Conciliacao');
    assert.deepEqual(parsed.headers, ['data', 'valor', 'historico']);
    assert.equal(parsed.rows.length, 2);
    assert.ok(parsed.rows[0][0] instanceof Date);
    assert.equal(parsed.rows[0][0].toISOString(), '2026-09-02T00:00:00.000Z');
    assert.equal(parsed.rows[0][1], 8002.12);
    assert.equal(parsed.rows[1][1], -45.9);
    assert.equal(parsed.rows[1][2], 'TARIFA MANUTENCAO');
  });

  it('ignora registros com data inválida', async () => {
    const buffer = await exportToXlsx(
      [...records, { dateIso: 'data-ruim', value: 10, history: 'x' }],
      'saida.xlsx',
      ExcelJS
    );
    const parsed = await parseXlsxFile(buffer, 'saida.xlsx', ExcelJS);
    assert.equal(parsed.rows.length, 2);
  });

  it('recusa exportar sem lançamentos', async () => {
    await assert.rejects(() => exportToXlsx([], 'vazio.xlsx', ExcelJS), /Não há lançamentos/);
    await assert.rejects(() => exportToXlsx(undefined, 'vazio.xlsx', ExcelJS), /Não há lançamentos/);
  });

  it('exige a biblioteca ExcelJS', async () => {
    await assert.rejects(() => exportToXlsx(records, 'x.xlsx', null), /ExcelJS/);
  });
});

describe('exportToPdf', () => {
  it('gera um PDF válido a partir dos registros', () => {
    const doc = exportToPdf(records, summarizeRecords(records), 'relatorio.pdf', {
      autoSave: false,
    });

    const buffer = doc.output('arraybuffer');
    assert.ok(buffer.byteLength > 500);
    assert.equal(String.fromCharCode(...new Uint8Array(buffer).slice(0, 4)), '%PDF');
    assert.equal(doc.internal.getNumberOfPages(), 1);
  });

  it('pagina automaticamente quando há muitos lançamentos', () => {
    const many = Array.from({ length: 200 }, (_, index) => ({
      dateIso: '2026-09-02',
      dateBr: '02/09/2026',
      value: index % 2 === 0 ? 100.5 : -20.25,
      history: `LANCAMENTO ${index + 1} COM DESCRICAO LONGA PARA TESTAR QUEBRA DE PAGINA`,
      sourceFile: 'arquivo.xlsx',
    }));

    const doc = exportToPdf(many, summarizeRecords(many), 'relatorio.pdf', { autoSave: false });
    assert.ok(doc.internal.getNumberOfPages() >= 2);
  });

  it('recusa exportar sem lançamentos', () => {
    assert.throws(() => exportToPdf([], undefined, 'x.pdf', { autoSave: false }), /Não há lançamentos/);
  });
});

describe('summarizeRecords', () => {
  it('totaliza entradas, saídas e período', () => {
    const summary = summarizeRecords(records, { skippedCount: 2 });

    assert.equal(summary.count, 2);
    assert.equal(summary.totalIn, 8002.12);
    assert.equal(summary.inCount, 1);
    assert.equal(summary.totalOut, -45.9);
    assert.equal(summary.totalOutAbs, 45.9);
    assert.equal(summary.outCount, 1);
    assert.equal(summary.netTotal, 7956.22);
    assert.equal(summary.skippedCount, 2);
    assert.equal(summary.minDateBr, '02/09/2026');
    assert.equal(summary.maxDateBr, '10/09/2026');
  });

  it('não acumula erro de ponto flutuante', () => {
    const summary = summarizeRecords([
      { dateIso: '2026-01-01', value: 0.1 },
      { dateIso: '2026-01-02', value: 0.2 },
    ]);
    assert.equal(summary.totalIn, 0.3);
    assert.equal(summary.netTotal, 0.3);
  });

  it('lida com lista vazia', () => {
    const summary = summarizeRecords([]);
    assert.equal(summary.count, 0);
    assert.equal(summary.netTotal, 0);
    assert.equal(summary.minDateBr, '');
  });
});
