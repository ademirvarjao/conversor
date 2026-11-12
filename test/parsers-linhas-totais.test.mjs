import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// A planilha de verdade é montada com a biblioteca vendorizada (UMD), igual ao
// que o app faz no navegador.
import '../vendor/exceljs/exceljs.min.js';

import { analyzeFileLayout, transformRowsWithConfig } from '../src/ai-engine.js';
import { isSummaryOrNoiseRow, parseXlsxFile } from '../src/parsers.js';

const ExcelJS = globalThis.ExcelJS;

async function buildWorkbook(linhas) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Extrato');
  for (const linha of linhas) sheet.addRow(linha);
  return workbook.xlsx.writeBuffer();
}

async function parseRows(linhas) {
  const buffer = await buildWorkbook(linhas);
  return parseXlsxFile(buffer, 'extrato.xlsx', ExcelJS);
}

describe('linhas de total/resumo não engolem lançamento real', () => {
  it('mantém o lançamento cujo histórico começa por "Total"/"Resumo"', async () => {
    const parsed = await parseRows([
      ['Histórico', 'Data', 'Valor'],
      ['TOTAL EXPRESS LTDA', '01/10/2026', -120.5],
      ['Total Distribuidora', '02/10/2026', 300],
      ['Resumo do pedido 8812', '03/10/2026', 45],
      ['PIX recebido', '04/10/2026', 50],
    ]);

    assert.deepEqual(
      parsed.rows.map((row) => row[0]),
      ['TOTAL EXPRESS LTDA', 'Total Distribuidora', 'Resumo do pedido 8812', 'PIX recebido']
    );
  });

  it('continua descartando linha de total de verdade', async () => {
    const parsed = await parseRows([
      ['Histórico', 'Data', 'Valor'],
      ['PIX recebido', '04/10/2026', 50],
      ['TOTAL DO DIA', '04/10/2026', '5.000,00'],
      ['SALDO ANTERIOR', '01/10/2026', '1.000,00'],
      ['TOTAIS', '18', '1.234,56'],
    ]);

    assert.deepEqual(
      parsed.rows.map((row) => row[0]),
      ['PIX recebido']
    );
  });

  it('reconhece data e valor mesmo quando o texto começa com palavra de resumo', () => {
    // Linha de lançamento: data + valor na mesma linha.
    assert.equal(isSummaryOrNoiseRow(['TOTAL EXPRESS LTDA', '01/10/2026', -120.5]), false);
    assert.equal(isSummaryOrNoiseRow(['Resumo do pedido 8812', '03/10/2026', 45]), false);

    // Linha de resumo: rótulo puro (com ou sem números), sem nome próprio.
    assert.equal(isSummaryOrNoiseRow(['TOTAL DO DIA', '04/10/2026', '5.000,00']), true);
    assert.equal(isSummaryOrNoiseRow(['TOTAIS', '18', '1.234,56']), true);
    assert.equal(isSummaryOrNoiseRow(['Parcial Cliente', '', '900,00']), true);
    assert.equal(isSummaryOrNoiseRow(['SALDO ANTERIOR', '01/10/2026', '1.000,00']), true);
    assert.equal(isSummaryOrNoiseRow(['Página 2', '', '']), true);
    assert.equal(isSummaryOrNoiseRow(['', '', '']), true);
  });

  it('o transformador também preserva o nome do fornecedor "Total ..."', () => {
    const parsedFile = {
      fileName: 'extrato.xlsx',
      fileType: 'xlsx',
      headers: ['Histórico', 'Data', 'Valor'],
      rows: [
        ['TOTAL EXPRESS LTDA', '01/10/2026', -120.5],
        ['Total Distribuidora', '02/10/2026', 300],
        ['TOTAL DO DIA', '', '179,50'],
        ['PIX recebido', '03/10/2026', 50],
      ],
    };

    const analysis = analyzeFileLayout(parsedFile, null);
    const { records, skipped } = transformRowsWithConfig(parsedFile, {
      mappings: analysis.mappings,
      rules: analysis.rules,
    });

    assert.deepEqual(
      records.map((record) => [record.history, record.value]),
      [
        ['TOTAL EXPRESS LTDA', -120.5],
        ['Total Distribuidora', 300],
        ['PIX recebido', 50],
      ]
    );
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].reason, /total\/resumo/i);
  });
});
