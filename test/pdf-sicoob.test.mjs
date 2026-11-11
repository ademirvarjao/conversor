import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildTableFromTextLines,
  findHeaderRow,
  parseMoneyValue,
} from '../src/parsers.js';
import { analyzeFileLayout, transformRowsWithConfig } from '../src/ai-engine.js';
import { buildCoachReport } from '../src/training-coach.js';
import { applyRecognition, recognizeLayout } from '../src/bank-layouts.js';

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

/**
 * Extrato do Sicoob (set/2022), reduzido ao essencial: cabeçalho em 4 colunas,
 * valor com sufixo C/D, descrição quebrada em várias linhas DEPOIS do valor e
 * saldo em linhas próprias ("SALDO ANTERIOR", "SALDO DO DIA ===== >").
 */
const SICOOB = [
  line(1, 830, [['Page', 486, 23], ['1', 513, 6], ['of', 522, 10], ['2', 535, 6]]),
  line(1, 800, [['SICOOB', 192, 35], ['-', 230, 3], ['Sistema de Cooperativas de Crédito do Brasil', 235, 182]]),
  line(1, 770, [['14/10/2022', 81, 45], ['EXTRATO CONTA CORRENTE', 241, 130], ['15:51:37', 496, 35]]),
  line(1, 745, [['COOP.:', 79, 32], ['4327', 119, 20], ['-', 139, 3], ['3', 142, 5], ['SICOOB EMPRESAS RJ', 155, 101]]),
  line(1, 725, [['DATA', 93, 25], ['DOCUMENTO', 160, 59], ['HISTÓRICO', 252, 50], ['VALOR', 496, 31]]),

  // O Sicoob imprime o bloco bem apertado: ~5 pt entre as linhas do mesmo
  // lançamento e ~15 pt entre um lançamento e o próximo saldo.
  line(1, 700, [['30/08/2022', 82, 45], ['SALDO ANTERIOR', 252, 80], ['54.607,59C', 481, 47]]),
  line(1, 685, [['30/08/2022', 82, 45], ['SALDO BLOQUEADO ANTERIOR', 252, 139], ['0,00*', 506, 21]]),

  line(1, 665, [['01/09/2022', 82, 45], ['129', 182, 15], ['DÉBITO PACOTE SERVIÇOS', 252, 122], ['39,00D', 498, 29]]),
  line(1, 650, [['SALDO DO DIA ===== >', 252, 101], ['54.568,59C', 481, 47]]),

  line(1, 635, [['DEBITO EMISSÃO TED', 252, 98]]),
  line(1, 630, [['05/09/2022', 82, 45], ['93514924', 170, 40], ['20.000,00D', 481, 47]]),
  line(1, 625, [['DIF.TITULARIDADE', 252, 82]]),
  line(1, 610, [['ASSOCIACAO BRASILEIRA DE STARTUPS', 252, 181]]),
  line(1, 595, [['SALDO DO DIA ===== >', 252, 101], ['34.568,59C', 481, 47]]),

  line(1, 580, [['09/09/2022', 82, 45], ['1', 187, 5], ['CRED.TRANSF.CONTAS INTERCREDIS', 252, 168], ['8.000,00C', 486, 42]]),
  line(1, 575, [['REM.: COOPERATIVA DE CREDITO', 252, 151]]),
  line(1, 560, [['SALDO DO DIA ===== >', 252, 101], ['42.568,59C', 481, 47]]),

  line(1, 545, [['26/09/2022', 82, 45], ['248954609', 167, 45], ['CRÉD.TED', 252, 46], ['-', 298, 3], ['STR', 301, 18], ['8.198,61C', 486, 42]]),
  line(1, 540, [['CONVENIO905524 2020', 252, 101]]),
  line(1, 535, [['CODIGO TED: T787105766', 252, 113]]),
  line(1, 530, [['20220046445430000000', 252, 100]]),
  line(1, 515, [['SALDO DO DIA ===== >', 252, 101], ['50.767,20C', 481, 47]]),

  line(1, 495, [['RESUMO', 287, 36]]),
  line(1, 480, [['SALDO EM CONTA CORRENTE(+):', 79, 149], ['50.767,20C', 507, 24]]),
  line(1, 465, [['OUVIDORIA SICOOB: 08007250996', 79, 148]]),
];

describe('parseMoneyValue — valores de extrato como vêm no PDF', () => {
  it('entende o sufixo C/D colado no número', () => {
    assert.deepEqual(parseMoneyValue('54.607,59C'), {
      value: 54607.59,
      hasExplicitSign: true,
      dcTag: 'C',
    });
    const debito = parseMoneyValue('20.000,00D');
    assert.equal(debito.value, -20000);
    assert.equal(debito.dcTag, 'D');
    assert.equal(parseMoneyValue('0,00*').value, 0);
  });

  it('código longo de TED não vira valor', () => {
    assert.equal(parseMoneyValue('20220046445430000000'), null);
    assert.equal(parseMoneyValue('000012345678901234567'), null);
    // Valor grande de verdade (com separador de milhar) continua valendo.
    assert.equal(parseMoneyValue('1.234.567,89').value, 1234567.89);
  });
});

describe('buildTableFromTextLines — extrato em lista (Sicoob)', () => {
  const table = buildTableFromTextLines(SICOOB);

  it('usa as 4 colunas do cabeçalho, sem colunas fantasma', () => {
    assert.deepEqual(table.headers, ['DATA', 'DOCUMENTO', 'HISTÓRICO', 'VALOR']);
    assert.equal(table.columnCount, 4);
  });

  it('não trata a faixa acima do cabeçalho como lançamento', () => {
    assert.ok(
      table.bannerLines.some((text) => /EXTRATO CONTA CORRENTE/.test(text)),
      'faixa de identificação virou banner'
    );
    assert.ok(
      !table.rows.some((row) => /EXTRATO CONTA CORRENTE/.test(row.join(' '))),
      'faixa de identificação não virou linha'
    );
  });

  it('junta a descrição quebrada em várias linhas no lançamento certo', () => {
    const ted = table.rows.find((row) => row[3] === '20.000,00D');
    assert.ok(ted, 'lançamento da TED presente');
    assert.match(ted[2], /DIF\.TITULARIDADE/);
    assert.match(ted[2], /ASSOCIACAO BRASILEIRA DE STARTUPS/);
    assert.equal(ted[1], '93514924');
  });

  it('mantém a descrição inteira na mesma coluna mesmo com pedaço deslocado', () => {
    const credito = table.rows.find((row) => row[3] === '8.198,61C');
    assert.ok(credito);
    assert.match(credito[2], /CRÉD\.TED - STR/);
    assert.match(credito[2], /CONVENIO905524/);
    assert.match(credito[2], /CODIGO TED/);
  });

  it('linha de saldo não vira lançamento e alimenta os checkpoints', () => {
    assert.ok(!table.rows.some((row) => /SALDO DO DIA/i.test(row.join(' '))));
    assert.ok(!table.rows.some((row) => /^SALDO ANTERIOR$/i.test(row[2] || '')));

    const labels = table.checkpoints.map((checkpoint) => checkpoint.label);
    assert.ok(labels.some((label) => /SALDO ANTERIOR/.test(label)), 'saldo inicial virou checkpoint');
    assert.ok(
      table.checkpoints.filter((checkpoint) => /SALDO DO DIA/.test(checkpoint.label)).length >= 4,
      'checkpoints do dia capturados'
    );

    const inicial = table.checkpoints.find((checkpoint) => /SALDO ANTERIOR/.test(checkpoint.label));
    assert.equal(inicial.value, 54607.59);
    assert.equal(inicial.rowIdx, 0, 'saldo inicial vem antes de qualquer linha');
  });

  it('descarta resumo, ouvidoria e código solto', () => {
    const tudo = table.rows.map((row) => row.join(' ')).join('\n');
    assert.doesNotMatch(tudo, /RESUMO/);
    assert.doesNotMatch(tudo, /OUVIDORIA/);
    assert.doesNotMatch(tudo, /SALDO EM CONTA CORRENTE/);
    // O código de barras da TED pode completar o histórico do lançamento —
    // o que não pode é virar lançamento sozinho.
    assert.equal(table.rows.filter((row) => /20220046445430000000/.test(row.join(' '))).length, 1);
  });

  it('encontra o cabeçalho certo mesmo com linhas de identificação acima', () => {
    const header = findHeaderRow(SICOOB);
    assert.ok(header);
    assert.deepEqual(
      header.items.map((item) => item.str),
      ['DATA', 'DOCUMENTO', 'HISTÓRICO', 'VALOR']
    );
  });
});

describe('Sicoob de ponta a ponta (parser → IA → treinador)', () => {
  const parsedFile = {
    fileName: 'Extrato Sicoob set-22.pdf',
    fileType: 'pdf',
    ...buildTableFromTextLines(SICOOB),
  };

  it('reconhece o banco e aplica o layout do extrato', () => {
    const analysis = analyzeFileLayout(parsedFile, null);
    const recognition = recognizeLayout(parsedFile, {});
    assert.equal(recognition.source, 'catalog');
    assert.equal(recognition.bank.id, 'sicoob');

    const applied = applyRecognition(analysis, recognition);
    const roles = applied.mappings.map((mapping) => `${mapping.header}:${mapping.role}`);
    assert.deepEqual(roles, ['DATA:date', 'DOCUMENTO:ignore', 'HISTÓRICO:history', 'VALOR:value_auto']);
  });

  it('converte só os lançamentos, com sinal do sufixo C/D', () => {
    const analysis = analyzeFileLayout(parsedFile, null);
    const { records } = transformRowsWithConfig(parsedFile, analysis);

    assert.equal(records.length, 4);
    assert.deepEqual(
      records.map((record) => [record.dateBr, record.value]),
      [
        ['01/09/2022', -39],
        ['05/09/2022', -20000],
        ['09/09/2022', 8000],
        ['26/09/2022', 8198.61],
      ]
    );
    assert.ok(!records.some((record) => /SALDO/i.test(record.history)), 'nenhum saldo virou lançamento');
  });

  it('fecha o saldo nos checkpoints impressos no extrato', () => {
    const analysis = analyzeFileLayout(parsedFile, null);
    const transform = transformRowsWithConfig(parsedFile, analysis);
    const report = buildCoachReport(parsedFile, analysis, transform, {});

    const saldo = report.checks.find((check) => check.id === 'saldo');
    assert.equal(saldo.status, 'ok', saldo.detail);
    assert.match(saldo.detail, /todas fecham/);
    assert.match(saldo.detail, /Saldo final 50\.767,20/);

    const datas = report.checks.find((check) => check.id === 'datas');
    assert.equal(datas.status, 'ok');
    const lancamentos = report.checks.find((check) => check.id === 'lancamentos');
    assert.equal(lancamentos.status, 'ok');
  });
});
