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
    const tudo = table.rows.flat().join(' | ');
    assert.ok(!/CNPJ|EXTRATO DE CONTA|^TOTAL/i.test(tudo), `sobrou lixo: ${tudo}`);
    assert.ok(table.skippedRows >= 1, `ignoradas: ${table.skippedRows}`);
  });
});

describe('buildTableFromTextLines — extrato paginado com Pagto./Recbto.', () => {
  // Geometria típica de extrato bancário: cada página repete o cabeçalho e o
  // rodapé, os valores ficam alinhados à direita em colunas próprias e existe
  // uma linha de contexto ("Conta Corrente : ...") logo acima dos lançamentos.
  const larguraTexto = (texto) => texto.length * 4.6;
  const valorDireita = (texto, fim) => {
    const largura = larguraTexto(texto);
    return [texto, fim - largura, largura];
  };

  const pagina = (numero, yTopo) => [
    line(numero, yTopo + 55, [
      ['Página :', 477, 30],
      [String(numero), 529, 5],
      ['/', 539, 3],
      ['2', 564, 5],
    ]),
    line(numero, yTopo + 40, [['EMPRESA EXEMPLO LTDA', 18, 180]]),
    line(numero, yTopo, [
      ['Lancto', 21, 30],
      ['Data', 69, 20],
      ['Beneficiário', 130, 52],
      ['Histórico', 289, 39],
      ['Pagto.', 420, 29],
      ['Recbto.', 471, 34],
      ['Saldo', 529, 25],
    ]),
    line(numero, yTopo - 18, [
      ['Conta Corrente :', 25, 95],
      ['43812-5', 126, 44],
      ['EMPRESA EXEMPLO LTDA', 224, 189],
    ]),
  ];

  const lancamentos = [
    // [data, beneficiário, histórico, valor assinado, saldo]
    ['01/06/2026', 'FORNECEDOR ALFA', 'LINK DE PGT. 1 X', '-2.357,98', '-29.911,14'],
    ['01/06/2026', 'CLIENTE BETA', 'VALOR RECEBIDO S/TITULO', '836,40', '-29.074,74'],
    ['02/06/2026', 'CLIENTE GAMA', 'VALOR RECEBIDO S/TITULO', '27.639,00', '-1.435,74'],
    ['03/06/2026', 'FORNECEDOR DELTA', 'PAGAMENTO TITULO', '-1.500,00', '-2.935,74'],
    ['04/06/2026', 'CLIENTE EPSILON', 'VALOR RECEBIDO S/TITULO', '320,55', '-2.615,19'],
    ['05/06/2026', 'FORNECEDOR ZETA', 'TARIFA', '-45,90', '-2.661,09'],
  ];

  const linhaLancamento = (numero, y, indice, [data, beneficiario, historico, valor, saldo]) => {
    const pagamento = valor.startsWith('-');
    const valorAbsoluto = valor.replace('-', '');
    return line(numero, y, [
      [String(87564 + indice), 32, 22],
      [data, 61, 40],
      [beneficiario, 104, 102],
      [historico, 212, 120],
      pagamento ? valorDireita(valorAbsoluto, 460) : valorDireita(valorAbsoluto, 513),
      valorDireita(saldo, 567),
    ]);
  };

  const pages = [
    ...pagina(1, 675),
    ...lancamentos.slice(0, 4).map((item, indice) => linhaLancamento(1, 640 - indice * 20, indice, item)),
    ...pagina(2, 675),
    ...lancamentos.slice(4).map((item, indice) => linhaLancamento(2, 640 - indice * 20, indice + 4, item)),
  ];

  const table = buildTableFromTextLines(pages);
  const indicePagto = table.headers.indexOf('Pagto.');
  const indiceRecbto = table.headers.indexOf('Recbto.');

  it('não mistura a linha de contexto da conta nos nomes das colunas', () => {
    assert.ok(indicePagto >= 0, `headers: ${table.headers.join(' | ')}`);
    assert.ok(indiceRecbto >= 0, `headers: ${table.headers.join(' | ')}`);
    assert.notEqual(indicePagto, indiceRecbto);
    for (const header of table.headers) {
      assert.ok(!header.includes(':'), `cabeçalho contaminado: ${header}`);
      assert.ok(!/Conta Corrente|Página/i.test(header), `cabeçalho contaminado: ${header}`);
    }
  });

  it('mantém pagamentos e recebimentos em colunas distintas', () => {
    assert.equal(table.rows.length, lancamentos.length);
    assert.equal(table.rows[0][indicePagto], '2.357,98');
    assert.equal(table.rows[0][indiceRecbto], '');
    assert.equal(table.rows[1][indicePagto], '');
    assert.equal(table.rows[1][indiceRecbto], '836,40');
  });

  it('não cola o cabeçalho da página seguinte na última linha da anterior', () => {
    const tudo = table.rows.flat().join(' | ');
    assert.ok(!/Página|EMPRESA EXEMPLO|Conta Corrente/i.test(tudo), `contaminado: ${tudo}`);
    assert.equal(table.rows[4][1], '04/06/2026');
    assert.equal(table.rows[4][indiceRecbto], '320,55');
    assert.equal(table.rows[5][indicePagto], '45,90');
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
