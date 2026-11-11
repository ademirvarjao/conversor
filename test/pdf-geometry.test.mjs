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

describe('buildTableFromTextLines — relatório agrupado por cliente', () => {
  // "Contas Recebidas por Cliente": título e razão social no topo da página,
  // nome do cliente na margem esquerda antes de cada bloco, rodapé com data.
  const pages = [
    line(1, 812, [['Contas Recebidas por Cliente - Agrupadas', 185, 218]]),
    line(1, 789, [['Período: 01/07/2026 A 31/07/2026', 220, 151]]),
    line(1, 767, [
      ['Nota Fiscal', 49, 49],
      ['Duplicata', 133, 41],
      ['Data Venc', 205, 44],
      ['Valor Venc', 301, 49],
      ['Data Rec', 369, 39],
      ['Valor Recebido', 445, 66],
    ]),
    line(1, 749, [['Usimaster Peças de Precisão Ltda', 13, 143]]),
    line(1, 735, [
      ['1', 30, 4],
      ['123349', 61, 25],
      ['123349/1', 138, 31],
      ['03/07/2026', 208, 37],
      ['1.540,82', 321, 28],
      ['03/07/2026', 370, 37],
      ['1.540,82', 482, 29],
    ]),
    line(1, 723, [
      ['2', 30, 4],
      ['123336', 61, 25],
      ['123336/2', 138, 31],
      ['06/07/2026', 208, 37],
      ['14.566,50', 317, 32],
      ['07/07/2026', 370, 37],
      ['14.566,50', 478, 33],
    ]),
    line(1, 711, [['Coldmix Ind. Com. e Representações Ltda.', 13, 190]]),
    line(1, 697, [
      ['1', 30, 4],
      ['123350', 61, 25],
      ['123350/1', 138, 31],
      ['10/07/2026', 208, 37],
      ['3.221,57', 321, 28],
      ['10/07/2026', 370, 37],
      ['3.221,57', 482, 29],
    ]),
    line(1, 48, [['quarta-feira, 5 de agosto de 2026', 13, 160], ['Página 1 de 3', 525, 40]]),
  ];

  const table = buildTableFromTextLines(pages);

  it('mantém o nome do cliente como linha própria (sem data e sem valor)', () => {
    const secoes = table.rows.filter((row) => row.filter(Boolean).length === 1);
    assert.deepEqual(
      secoes.map((row) => row.find(Boolean)),
      ['Usimaster Peças de Precisão Ltda', 'Coldmix Ind. Com. e Representações Ltda.']
    );
  });

  it('não confunde título/razão social do topo nem o rodapé com seção', () => {
    const tudo = table.rows.flat().join(' | ');
    assert.ok(!/Contas Recebidas por Cliente|Período:|Página 1 de 3/i.test(tudo), `contaminado: ${tudo}`);
  });

  it('separa as colunas de vencimento e de recebimento', () => {
    const venc = table.headers.indexOf('Valor Venc');
    const recebido = table.headers.indexOf('Valor Recebido');
    const dataRec = table.headers.indexOf('Data Rec');
    assert.ok(venc >= 0 && recebido >= 0 && dataRec >= 0, `headers: ${table.headers.join(' | ')}`);
    assert.equal(table.rows[1][venc], '1.540,82');
    assert.equal(table.rows[1][recebido], '1.540,82');
    assert.equal(table.rows[2][dataRec], '07/07/2026');
  });
});

describe('buildTableFromTextLines — extrato Itaú com bloco de 3 linhas', () => {
  // Geometria real do extrato ICS (Itaú): cada lançamento ocupa três linhas
  // visuais com passo de ~5,3 pt e a data/valor/CNPJ ficam na linha do MEIO.
  // A coluna de histórico só aparece em parte das linhas que têm data — se o
  // suporte fosse contado apenas nas linhas com data ela seria descartada e
  // seus textos cairiam dentro da coluna de data ("Data Lançamentos").
  const pages = [
    line(1, 712.1, [['Saldo total', 35, 60], ['Limite da conta', 167, 70]]),
    line(1, 691.8, [['R$ 2.520,90', 35, 60], ['R$ 0,00', 167, 40]]),
    line(1, 654.5, [['Lançamentos do período:', 34, 120], ['01/10/2026 até 31/10/2026', 131, 120]]),
    line(1, 628.1, [
      ['Data', 35, 22],
      ['Lançamentos', 90, 52],
      ['Razão Social', 226, 60],
      ['CNPJ/CPF', 363, 48],
      ['Valor (R$)', 470, 40],
      ['Saldo (R$)', 521, 42],
    ]),
    line(1, 615.3, [
      ['30/09/2026', 35, 42],
      ['SALDO ANTERIOR', 90, 62],
      ['244.600,52', 518, 41],
    ]),
    line(1, 602.5, [
      ['01/10/2026', 35, 42],
      ['PIX RECEBIDO ALELO S01/10', 90, 100],
      ['ALELO SA', 226, 40],
      ['04.740.876/0001-25', 363, 76],
      ['216,64', 483, 24],
    ]),
    line(1, 589.7, [
      ['RECEBIMENTO REDE ELO', 90, 84],
      ['REDECARD INSTITUICAO DE', 226, 92],
    ]),
    line(1, 584.4, [
      ['01/10/2026', 35, 42],
      ['01.425.787/0001-04', 363, 76],
      ['90,21', 487, 20],
    ]),
    line(1, 579.1, [
      ['DB0094977224', 90, 52],
      ['PAGAMENTO S.A.', 226, 50],
    ]),
    line(1, 566.3, [
      ['RECEBIMENTO REDE VISA', 90, 88],
      ['REDECARD INSTITUICAO DE', 226, 92],
    ]),
    line(1, 561.0, [
      ['01/10/2026', 35, 42],
      ['01.425.787/0001-04', 363, 76],
      ['1.230,90', 476, 28],
    ]),
    line(1, 555.7, [
      ['DB0094977224', 90, 52],
      ['PAGAMENTO S.A.', 226, 50],
    ]),
  ];

  const table = buildTableFromTextLines(pages);

  it('não funde a coluna de data com a de lançamentos', () => {
    assert.deepEqual(table.headers, [
      'Data',
      'Lançamentos',
      'Razão Social',
      'CNPJ/CPF',
      'Valor (R$)',
      'Saldo (R$)',
    ]);
  });

  it('mantém data e histórico em colunas separadas em cada linha', () => {
    assert.equal(table.rows.length, 4);
    assert.equal(table.rows[0][0], '30/09/2026');
    assert.equal(table.rows[0][1], 'SALDO ANTERIOR');
    assert.equal(table.rows[1][0], '01/10/2026');
    assert.equal(table.rows[1][1], 'PIX RECEBIDO ALELO S01/10');
  });

  it('liga a descrição acima da data ao bloco a que ela pertence', () => {
    // "RECEBIMENTO REDE ELO" está ACIMA da data, mas pertence a este bloco.
    assert.equal(table.rows[2][0], '01/10/2026');
    assert.equal(table.rows[2][1], 'RECEBIMENTO REDE ELO DB0094977224');
    assert.equal(table.rows[2][2], 'REDECARD INSTITUICAO DE PAGAMENTO S.A.');
    assert.equal(table.rows[2][3], '01.425.787/0001-04');
    assert.equal(table.rows[2][4], '90,21');
    assert.equal(table.rows[3][1], 'RECEBIMENTO REDE VISA DB0094977224');
    assert.equal(table.rows[3][4], '1.230,90');
  });

  it('não perde o saldo da linha de abertura nem o rotulo do cabecalho', () => {
    assert.equal(table.rows[0][5], '244.600,52');
    assert.ok(!table.rows.flat().join(' ').includes('Data Lançamentos'));
  });
});

describe('buildTableFromTextLines — rótulo de coluna numérica alinhada à direita', () => {
  // Exportações com números alinhados à direita deixam o rótulo bem à esquerda
  // do valor; o rótulo precisa ir para a coluna do valor (e não se juntar ao
  // rótulo anterior, virando "data valor").
  const pages = [
    line(1, 520, [
      ['data', 40, 17],
      ['valor', 105, 20],
      ['historico', 190, 36],
    ]),
    line(1, 500, [
      ['01/10/2026', 47, 39],
      ['-851,98', 152, 26],
      ['Alef Ferramentas Para Usinagem Ltda 1152 1152/1', 190, 179],
    ]),
    line(1, 480, [
      ['01/10/2026', 47, 39],
      ['-142,80', 152, 26],
      ['Arcelormittal Brasil S/a 1679708 1679708/1', 190, 170],
    ]),
  ];

  const table = buildTableFromTextLines(pages);

  it('não cola o rótulo do valor no rótulo da data', () => {
    assert.deepEqual(table.headers, ['data', 'valor', 'historico']);
  });

  it('mantém os dados em três colunas', () => {
    assert.deepEqual(table.rows[0], [
      '01/10/2026',
      '-851,98',
      'Alef Ferramentas Para Usinagem Ltda 1152 1152/1',
    ]);
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

  it('aceita lançamento sem data na virada de página (documento + valor + saldo)', () => {
    const table = buildTableFromTextLines([
      line(1, 760, [
        ['Data', 40, 20],
        ['Lançamento', 100, 45],
        ['Dcto.', 250, 25],
        ['Crédito (R$)', 330, 50],
        ['Débito (R$)', 420, 45],
        ['Saldo (R$)', 500, 45],
      ]),
      line(1, 740, [
        ['05/10/2026', 40, 45],
        ['RECEBIMENTO FORNECEDOR', 100, 110],
        ['102805', 250, 30],
        ['120,00', 350, 30],
        ['1.620,00', 510, 35],
      ]),
      // ---- página 2, sem cabeçalho: linha numérica no topo dos dados ----
      line(2, 828, [
        ['8554385', 250, 30],
        ['22,08', 350, 30],
        ['1.626,18', 510, 35],
      ]),
      line(2, 812, [
        ['06/10/2026', 40, 45],
        ['RECEBIMENTO FORNECEDOR', 100, 110],
        ['8698071', 250, 30],
        ['335,56', 350, 30],
        ['1.961,74', 510, 35],
      ]),
      // Débito existe na página para fixar a coluna do extrato.
      line(2, 796, [
        ['07/10/2026', 40, 45],
        ['TARIFA BANCARIA', 100, 90],
        ['61026', 250, 30],
        ['', 440, 10],
        ['-45,90', 435, 32],
        ['1.915,84', 510, 35],
      ]),
    ]);

    assert.equal(table.rows.length, 4, 'nenhum lançamento descartado');
    assert.deepEqual(table.rows[0], ['05/10/2026', 'RECEBIMENTO FORNECEDOR', '102805', '120,00', '', '1.620,00']);
    // A linha sem data herda o dia anterior em vez de virar banner do topo.
    assert.deepEqual(table.rows[1], ['05/10/2026', '', '8554385', '22,08', '', '1.626,18']);
    assert.deepEqual(table.rows[2], ['06/10/2026', 'RECEBIMENTO FORNECEDOR', '8698071', '335,56', '', '1.961,74']);
    // Valor negativo alinhado à direita cai na coluna de débito, não na de crédito.
    assert.deepEqual(table.rows[3], ['07/10/2026', 'TARIFA BANCARIA', '61026', '', '-45,90', '1.915,84']);
  });

  it('não confunde faixa de resumo do topo com lançamento sem data', () => {
    const table = buildTableFromTextLines([
      line(1, 760, [
        ['Data', 40, 20],
        ['Histórico', 100, 45],
        ['Valor', 300, 30],
      ]),
      line(1, 740, [
        ['05/10/2026', 40, 45],
        ['PAGAMENTO', 100, 70],
        ['100,00', 290, 45],
      ]),
      // Faixa de saldos no topo da página 2: só números, mas LONGE dos dados.
      line(2, 800, [
        ['2.520,90', 40, 45],
        ['0,00', 200, 30],
      ]),
      line(2, 700, [
        ['06/10/2026', 40, 45],
        ['PAGAMENTO', 100, 70],
        ['200,00', 290, 45],
      ]),
    ]);

    assert.equal(table.rows.length, 2);
    assert.equal(table.rows[1][2], '200,00');
  });

  it('descarta rodapé do extrato (hyperlink e SAC) sem perder lançamentos', () => {
    const table = buildTableFromTextLines([
      line(1, 760, [
        ['Data', 40, 20],
        ['Histórico', 100, 45],
        ['Valor', 300, 30],
      ]),
      line(1, 740, [
        ['05/10/2026', 40, 45],
        ['PAGAMENTO', 100, 70],
        ['100,00', 290, 45],
      ]),
      line(1, 40, [['novos lançamentos', 40, 90]]),
      line(1, 25, [['atualizado em 06/11/2026 SAC 0800 728', 40, 200]]),
    ]);

    assert.equal(table.rows.length, 1);
    assert.equal(table.rows[0][1], 'PAGAMENTO');
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
