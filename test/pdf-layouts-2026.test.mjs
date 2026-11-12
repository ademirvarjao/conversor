import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildTableFromTextLines, parseMoneyValue } from '../src/parsers.js';
import { analyzeFileLayout, transformRowsWithConfig } from '../src/ai-engine.js';
import { buildCoachReport } from '../src/training-coach.js';

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

/** Roda o caminho completo: tabela → análise → lançamentos. */
function convert(lines) {
  const table = buildTableFromTextLines(lines);
  const parsedFile = {
    fileName: 'teste.pdf',
    fileType: 'pdf',
    pageCount: 1,
    headers: table.headers,
    rows: table.rows,
    bannerLines: table.bannerLines,
    skippedRows: table.skippedRows,
    checkpoints: table.checkpoints || [],
  };
  const analysis = analyzeFileLayout(parsedFile, null);
  const result = transformRowsWithConfig(parsedFile, analysis);
  const report = buildCoachReport(parsedFile, analysis, result, {});
  return { table, parsedFile, analysis, result, report };
}

describe('SISPAG do Itaú — consulta de pagamentos', () => {
  // Cabeçalho em 3 linhas, valor com o status colado ("749,60 efetuado") e
  // favorecido quebrando em duas linhas em volta da linha do valor.
  const lines = [
    line(1, 780, [['CLINICA EXEMPLO LTDA', 51, 200]]),
    line(1, 760, [['consulta de pagamentos, transferências e Pix', 51, 240]]),
    line(1, 711, [
      ['referência da', 279, 60],
      ['data do', 369, 40],
    ]),
    line(1, 708, [
      ['favorecido/beneficiário', 51, 84],
      ['CPF/CNPJ', 139, 50],
      ['tipo de pagamento', 209, 70],
      ['valor (R$) status', 454, 80],
    ]),
    line(1, 704, [
      ['empresa', 279, 40],
      ['pagamento', 363, 45],
    ]),
    line(1, 691, [
      ['ESPECIFARMA COM DE', 51, 110],
      ['Boleto outros', 209, 70],
      ['NF286536-', 279, 60],
    ]),
    line(1, 688, [
      ['00.085.822/0001-12', 139, 90],
      ['01/10/2026', 364, 50],
      ['749,60 efetuado', 464, 70],
    ]),
    line(1, 684, [
      ['MEDICAMENTO', 51, 70],
      ['bancos', 209, 35],
      ['ESPECIFARM', 279, 60],
    ]),
    line(1, 671, [
      ['PERSEVERANTES', 51, 70],
      ['Boleto outros', 209, 70],
      ['NF05461-', 279, 60],
    ]),
    line(1, 668, [
      ['18.479.160/0001-20', 139, 90],
      ['01/10/2026', 364, 50],
      ['720,71 efetuado', 464, 70],
    ]),
    line(1, 664, [
      ['MEDICAMENTOS E C', 51, 70],
      ['bancos', 209, 35],
      ['PERSEVERANTE', 279, 60],
    ]),
    // Pagamento cujo nome, tipo e referência cabem na MESMA linha do valor.
    line(1, 647, [
      ['PERSEVERANTES MEDICAMENTOS E C', 51, 160],
      ['18.479.160/0001-20', 139, 90],
      ['Boleto outros', 209, 70],
      ['NF5679-PER. 1/2', 279, 70],
      ['01/10/2026', 364, 50],
      ['776,75 efetuado', 464, 70],
    ]),
  ];

  const { table, result } = convert(lines);

  it('monta as seis colunas a partir do cabeçalho de três linhas', () => {
    assert.deepEqual(table.headers, [
      'favorecido/beneficiário',
      'CPF/CNPJ',
      'tipo de pagamento',
      'referência da empresa',
      'data do pagamento',
      'valor (R$) status',
    ]);
  });

  it('lê o valor com o status colado', () => {
    assert.equal(parseMoneyValue('749,60 efetuado').value, 749.6);
    assert.equal(parseMoneyValue('1.200,00 agendado').value, 1200);
  });

  it('não perde o favorecido quebrado em duas linhas', () => {
    assert.equal(result.records.length, 3);
    assert.equal(result.records[0].dateIso, '2026-10-01');
    assert.equal(result.records[0].value, -749.6);
    assert.match(result.records[0].history, /^ESPECIFARMA COM DE MEDICAMENTO/);
    assert.match(result.records[0].history, /NF286536-/);
    assert.match(result.records[1].history, /^PERSEVERANTES MEDICAMENTOS E C/);
    assert.ok(result.records.every((record) => !/00\.085|18\.479/.test(record.history)), 'CNPJ no histórico');
  });

  it('segue tudo como saída (pagamento), sem saldo para conferir', () => {
    assert.ok(result.records.every((record) => record.value < 0));
  });
});

describe('Extrato mensal do Itaú — conta corrente e aplicações', () => {
  // Tabela principal: data | descrição | entradas R$ | saídas R$ | saldo R$.
  // Data só dia/mês (o ano está no título), débito com "-" no fim, legenda na
  // margem esquerda e uma segunda tabela (CDB) na mesma página que NÃO pode
  // entrar como lançamento.
  const lines = [
    line(1, 790, [['extrato mensal ag 6087 cc 20100-7 out 2026', 406, 200]]),
    line(1, 760, [['período: 01/10/2026 a 31/10/2026', 60, 200]]),
    line(1, 250, [
      ['A = agendamento', 56, 80],
      ['data', 150, 26],
      ['descrição', 208, 50],
      ['entradas R$', 357, 60],
      ['saídas R$', 426, 55],
      ['saldo R$', 521, 45],
    ]),
    line(1, 240, [
      ['(créditos)', 359, 45],
      ['(débitos)', 427, 45],
    ]),
    line(1, 220, [['D = débito a compensar', 56, 110]]),
    line(1, 207, [
      ['01/10', 150, 30],
      ['Sispag Fornecedores', 208, 90],
      ['', 357, 0],
      ['1.913,94-', 431, 45],
    ]),
    line(1, 197, [
      ['Sispag Fornecedores', 208, 90],
      ['1.050,00-', 431, 45],
    ]),
    line(1, 187, [
      ['Sispag', 208, 40],
      ['00001237', 244, 45],
      ['41.250,00', 368, 50],
    ]),
    line(1, 172, [['Explicativas no final do extrato', 56, 130]]),
    line(1, 128, [
      ['02/10', 150, 30],
      ['Mov Tít Cob Disp 02/10S', 208, 120],
      ['2.936,00', 372, 50],
    ]),
    line(1, 118, [
      ['Res Aplic Aut Mais', 208, 90],
      ['9.942,40', 370, 50],
    ]),
    // Segunda tabela do mesmo PDF (investimentos) — não é conta corrente.
    line(1, 90, [
      ['data', 172, 26],
      ['data', 232, 26],
      ['valor', 289, 30],
      ['saldo bruto R$', 429, 70],
      ['saldo líquido R$', 507, 75],
    ]),
    line(1, 80, [
      ['01/10', 174, 30],
      ['30/10', 234, 30],
      ['100.000,00', 292, 60],
      ['100.500,00', 440, 60],
      ['100.500,00', 512, 60],
    ]),
  ];

  const { table, result, report } = convert(lines);

  it('usa o cabeçalho da tabela principal, não o da tabela de CDB', () => {
    assert.deepEqual(table.headers, [
      'data',
      'descrição',
      'entradas R$ (créditos)',
      'saídas R$ (débitos)',
      'saldo R$',
    ]);
  });

  it('completa o ano das datas dd/mm com a data completa do documento', () => {
    const datas = result.records.map((record) => record.dateBr);
    assert.ok(datas.includes('01/10/2026'), `datas: ${datas.join(', ')}`);
    assert.ok(datas.every((data) => /\/2026$/.test(data)), `datas: ${datas.join(', ')}`);
  });

  it('respeita as colunas de entrada e saída (débito com "-")', () => {
    const porValor = new Map(result.records.map((record) => [record.value, record]));
    assert.equal(porValor.get(-1913.94)?.dateIso, '2026-10-01');
    assert.equal(porValor.get(41250)?.dateIso, '2026-10-01');
    assert.equal(porValor.get(2936)?.dateIso, '2026-10-02');
  });

  it('não deixa a legenda da margem entrar no histórico', () => {
    for (const record of result.records) {
      assert.ok(!/Explicativas|débito a compensar|agendamento/.test(record.history), record.history);
    }
  });

  it('ignora a segunda tabela do arquivo', () => {
    const valores = result.records.map((record) => Math.abs(record.value));
    assert.ok(!valores.includes(100000), `valores: ${valores.join(', ')}`);
    assert.ok(!valores.includes(100500));
  });

  it('não confere saldo quando a coluna de saldo é de aplicação', () => {
    const saldo = report.checks.find((check) => check.id === 'saldo');
    assert.equal(saldo.status, 'skip');
  });
});

describe('extrato da Caixa — linha de saldo com nº do documento', () => {
  const lines = [
    line(1, 553, [
      ['Data Mov.', 48, 55],
      ['Nr. Doc.', 109, 50],
      ['Histórico', 176, 60],
      ['Valor', 407, 40],
      ['Saldo', 533, 40],
    ]),
    line(1, 533, [
      ['000000', 109, 40],
      ['SALDO ANTERIOR', 176, 90],
      ['0,00', 409, 30],
      ['9.571,39 C', 512, 60],
    ]),
    line(1, 513, [
      ['01/10/2026', 48, 60],
      ['000052', 109, 40],
      ['CHEQUE PAG', 176, 80],
      ['85,62 D', 396, 45],
      ['9.485,77 C', 512, 60],
    ]),
    line(1, 492, [
      ['01/10/2026', 48, 60],
      ['000000', 109, 40],
      ['MANUT CROT', 176, 70],
      ['60,00 D', 396, 45],
      ['9.425,77 C', 512, 60],
    ]),
    line(1, 472, [
      ['01/10/2026', 48, 60],
      ['000000', 109, 40],
      ['SALDO DIA', 176, 70],
      ['0,00 C', 401, 40],
      ['9.425,77 C', 512, 60],
    ]),
  ];

  const { result } = convert(lines);

  it('não transforma "SALDO DIA" em lançamento de R$ 0,00', () => {
    assert.equal(result.records.length, 2);
    assert.deepEqual(
      result.records.map((record) => record.value),
      [-85.62, -60]
    );
    assert.match(result.records[0].history, /CHEQUE PAG$/);
    assert.ok(!result.records.some((record) => /SALDO/i.test(record.history)));
  });
});
