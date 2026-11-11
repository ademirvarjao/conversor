import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildTableFromTextLines,
  clusterPositions,
  groupItemsIntoLines,
} from '../src/parsers.js';

/** Monta uma "linha visual" do PDF: [texto, x, largura]. */
function line(page, y, items) {
  const h = 9;
  return {
    page,
    y,
    h,
    items: items.map(([str, x, w = 40]) => ({ str, x, y, w, h })),
  };
}

describe('groupItemsIntoLines', () => {
  it('agrupa fragmentos com Y próximos e ordena por X', () => {
    const lines = groupItemsIntoLines([
      { str: 'mundo', x: 60, y: 100.4, w: 30, h: 9 },
      { str: 'Olá', x: 10, y: 100, w: 20, h: 9 },
      { str: 'linha 2', x: 10, y: 80, w: 40, h: 9 },
      { str: '   ', x: 90, y: 100, w: 5, h: 9 },
    ]);

    assert.equal(lines.length, 2);
    // Y decrescente = de cima para baixo no PDF
    assert.deepEqual(
      lines[0].items.map((item) => item.str),
      ['Olá', 'mundo']
    );
    assert.deepEqual(
      lines[1].items.map((item) => item.str),
      ['linha 2']
    );
  });

  it('devolve lista vazia quando não há texto', () => {
    assert.deepEqual(groupItemsIntoLines([]), []);
    assert.deepEqual(groupItemsIntoLines([{ str: '  ', x: 0, y: 0, w: 0, h: 9 }]), []);
  });
});

describe('clusterPositions', () => {
  it('agrupa posições próximas e calcula âncoras', () => {
    const clusters = clusterPositions([10, 12, 11, 50, 52, 100], 3);
    assert.equal(clusters.length, 3);
    assert.deepEqual(
      clusters.map((cluster) => cluster.min),
      [10, 50, 100]
    );
    assert.equal(clusters[0].count, 3);
    assert.equal(clusters[0].anchor, 11);
  });

  it('lida com lista vazia', () => {
    assert.deepEqual(clusterPositions([], 5), []);
  });
});

describe('buildTableFromTextLines — extrato bancário', () => {
  const pages = [
    // Página 1
    line(1, 760, [['EXTRATO DE CONTA CORRENTE - BANCO EXEMPLO', 40, 260]]),
    line(1, 740, [['CNPJ: 12.345.678/0001-99', 40, 160]]),
    line(1, 700, [
      ['Data', 40, 20],
      ['Histórico', 100, 45],
      ['Valor', 400, 30],
    ]),
    line(1, 670, [
      ['02/09/2026', 40, 50],
      ['PIX RECEBIDO', 100, 90],
      ['8.002,12', 380, 50],
    ]),
    line(1, 650, [
      ['08/09/2026', 40, 50],
      ['CORINTOS LOGISTICA', 100, 110],
      ['89.628,03', 370, 60],
    ]),
    line(1, 630, [
      ['10/09/2026', 40, 50],
      ['TARIFA MANUTENCAO', 100, 110],
      ['45,90', 395, 35],
    ]),
    line(1, 610, [
      ['TOTAL', 100, 30],
      ['97.584,25', 370, 60],
    ]),
    // Página 2 (cabeçalho repetido)
    line(2, 700, [
      ['Data', 40, 20],
      ['Histórico', 100, 45],
      ['Valor', 400, 30],
    ]),
    line(2, 670, [
      ['11/09/2026', 40, 50],
      ['TRANSFERENCIA ENVIADA', 100, 130],
      ['-1.200,00', 370, 60],
    ]),
  ];

  const table = buildTableFromTextLines(pages);

  it('reconhece os cabeçalhos', () => {
    assert.deepEqual(table.headers, ['Data', 'Histórico', 'Valor']);
    assert.equal(table.columnCount, 3);
  });

  it('extrai as linhas de dados de todas as páginas', () => {
    assert.equal(table.rows.length, 4);
    assert.deepEqual(table.rows[0], ['02/09/2026', 'PIX RECEBIDO', '8.002,12']);
    assert.deepEqual(table.rows[3], ['11/09/2026', 'TRANSFERENCIA ENVIADA', '-1.200,00']);
  });

  it('ignora título, CNPJ, total e cabeçalho repetido', () => {
    assert.deepEqual(table.bannerLines, [
      'EXTRATO DE CONTA CORRENTE - BANCO EXEMPLO',
      'CNPJ: 12.345.678/0001-99',
    ]);
    assert.ok(table.skippedRows >= 2, `ignoradas: ${table.skippedRows}`);
  });
});

describe('buildTableFromTextLines — colunas separadas de entrada/saída', () => {
  const pages = [
    line(1, 700, [
      ['Dt. Mov.', 40, 45],
      ['Histórico', 100, 45],
      ['Entrada (+)', 350, 55],
      ['Saída (-)', 430, 45],
      ['Saldo', 520, 35],
    ]),
    line(1, 680, [
      ['02/09/2026', 40, 50],
      ['TRANSFERENCIA RECEBIDA', 100, 120],
      ['8.002,12', 350, 45],
      ['8.002,12', 515, 45],
    ]),
    line(1, 660, [
      ['10/09/2026', 40, 50],
      ['TARIFA MANUTENCAO', 100, 110],
      ['45,90', 430, 45],
      ['7.956,22', 515, 45],
    ]),
  ];

  const table = buildTableFromTextLines(pages);

  it('mantém as colunas de entrada, saída e saldo separadas', () => {
    assert.equal(table.columnCount, 5);
    assert.deepEqual(table.headers, ['Dt. Mov.', 'Histórico', 'Entrada (+)', 'Saída (-)', 'Saldo']);
  });

  it('preenche com vazio a coluna ausente de cada lançamento', () => {
    assert.equal(table.rows.length, 2);
    assert.deepEqual(table.rows[0], ['02/09/2026', 'TRANSFERENCIA RECEBIDA', '8.002,12', '', '8.002,12']);
    assert.deepEqual(table.rows[1], ['10/09/2026', 'TARIFA MANUTENCAO', '', '45,90', '7.956,22']);
  });
});

describe('buildTableFromTextLines — casos especiais', () => {
  it('junta descrição quebrada em duas linhas visuais', () => {
    const table = buildTableFromTextLines([
      line(1, 700, [
        ['Data', 40, 20],
        ['Histórico', 100, 45],
        ['Valor', 300, 30],
      ]),
      line(1, 680, [
        ['02/09/2026', 40, 50],
        ['PAGAMENTO FORNECEDOR', 100, 120],
        ['100,00', 290, 45],
      ]),
      line(1, 668, [['REF NF 123', 100, 70]]),
    ]);

    assert.equal(table.rows.length, 1);
    assert.equal(table.rows[0][1], 'PAGAMENTO FORNECEDOR REF NF 123');
  });

  it('combina cabeçalho em múltiplas linhas', () => {
    const table = buildTableFromTextLines([
      line(1, 712, [['Valor', 300, 30]]),
      line(1, 700, [
        ['Data', 40, 20],
        ['Histórico', 100, 45],
      ]),
      line(1, 680, [
        ['02/09/2026', 40, 50],
        ['PAGAMENTO', 100, 70],
        ['100,00', 290, 45],
      ]),
    ]);

    assert.deepEqual(table.headers, ['Data', 'Histórico', 'Valor']);
    assert.equal(table.rows.length, 1);
  });

  it('lança erro quando não há linhas tabulares', () => {
    assert.throws(
      () =>
        buildTableFromTextLines([
          line(1, 700, [['Apenas um texto solto', 40, 150]]),
          line(1, 680, [['Outro texto', 40, 80]]),
        ]),
      /Não foi possível identificar linhas tabulares/
    );
  });

  it('lança erro quando não há linhas', () => {
    assert.throws(() => buildTableFromTextLines([]), /Nenhum texto extraível/);
  });
});
