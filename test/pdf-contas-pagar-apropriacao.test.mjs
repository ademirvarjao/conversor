import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  APPROPRIATION_REPORT_HEADERS,
  buildTableFromTextLines,
} from '../src/parsers.js';
import {
  analyzeFileLayout,
  normalizeMemory,
  transformRowsWithConfig,
} from '../src/ai-engine.js';
import { diffRoles, recognizeLayout } from '../src/bank-layouts.js';

/**
 * Geometria do relatório "Contas a Pagar por Local com Apropriação" (90ti),
 * com dados FICTÍCIOS. Só as posições X/Y e os rótulos são reais: nenhum
 * fornecedor, valor ou centro de custo do PDF enviado entra no repositório.
 *
 * O fixture cobre: cabeçalho em 3 linhas, rateio quebrado em várias linhas,
 * valor apropriado que NÃO pode virar lançamento, fornecedor/tipo quebrados,
 * repetição do último título na página seguinte, totais e rodapé.
 */

const line = (page, y, items) => ({
  page,
  y,
  h: 9,
  items: items.map(([str, x, w = 40]) => ({ str, x, y, w, h: 9 })),
});

const topBanner = (page, emissao = '23/11/2026 15:59:36') => [
  line(page, 555.9, [
    ['EMPRESA EXEMPLO', 36, 100],
    ['Emissão:', 659, 45],
    [emissao, 698, 90],
  ]),
  line(page, 538.7, [['90ti - Contas a Pagar Por Local com Apropriação - CONT', 36, 300]]),
  line(page, 522.3, [
    ['Dt. Amortização:', 233, 80],
    ['01/11/2026 à 10/11/2026', 296, 120],
  ]),
];

const header = (page) => [
  line(page, 506.6, [
    ['DATA', 249, 25],
    ['DATA', 305, 25],
    ['VALOR', 372, 30],
    ['VALOR', 429, 30],
    ['RATEIO DA APROPRIAÇÃO', 585, 120],
    ['VALOR', 789, 30],
  ]),
  line(page, 502.7, [
    ['FORNECEDOR', 29, 60],
    ['TÍTULO', 171, 30],
    ['TIPO', 477, 30],
  ]),
  line(page, 498.7, [
    ['EMISSÃO', 243, 40],
    ['PAGAMENTO', 293, 50],
    ['ORIGINAL', 363, 40],
    ['PAGO', 433, 25],
    ['LOCAL', 546, 30],
    ['|', 579, 5],
    ['CENTRO DE CUSTO', 590, 70],
    ['|', 664, 5],
    ['NATUREZA', 675, 50],
    ['APROPRIADO', 767, 60],
  ]),
];

const footer = (page, total) =>
  line(page, 32.1, [
    ['EMPRESA EXEMPLO', 29, 100],
    ['Sistema Emissor Exemplo Ltda', 371, 180],
    [`Page ${page} of ${total}`, 771, 60],
  ]);

const mainRow = (page, y, supplier, titulo, emissao, pagamento, original, pago, tipo) =>
  line(page, y, [
    ...(supplier ? [[supplier, 29, 130]] : []),
    [titulo, 171, 35],
    [emissao, 241, 45],
    [pagamento, 306, 45],
    [original, 370, 35],
    [pago, 426, 35],
    [tipo, 460, 60],
  ]);

const rateio = (page, y, texto, valor) =>
  line(page, y, [
    [texto, 517, 240],
    [valor, 786, 35],
  ]);

const LINES = [
  ...topBanner(1),
  ...header(1),
  // 1) Um rateio só, valor apropriado na mesma linha.
  mainRow(1, 485.7, 'FORNECEDOR ALFA LTDA', 'NF-1', '01/11/2026', '04/11/2026', '100,00', '100,00', 'BOLETO'),
  rateio(1, 474.3, '001 - LOCAL | 04.01 | 2.01.001 - SERVIÇO', '100,00'),
  // 2) Tipo quebrado e DOIS rateios: a soma deles é o valor pago, mas cada
  //    linha de rateio NÃO pode virar um lançamento.
  mainRow(1, 463.2, 'FORNECEDOR BETA', 'NF-2', '02/11/2026', '05/11/2026', '250,00', '250,00', 'FOLHA DE'),
  line(1, 456.6, [['PAGAMENTO', 460, 60]]),
  rateio(1, 447.2, '1002.002 - MARKETING | 04.01 | 2.14.016 -', '125,00'),
  line(1, 440.2, [['PRESTADOR DE SERVIÇO INTERNO', 517, 180]]),
  rateio(1, 430.3, '1003.001 - SUPRIMENTOS | 04.02 | 2.14.016 -', '125,00'),
  line(1, 423.7, [['PRESTADOR DE SERVIÇO INTERNO', 517, 180]]),
  // 3) Último título da página 1 — será repetido no topo da página 2.
  mainRow(1, 410.0, 'FORNECEDOR GAMA', 'NF-3', '03/11/2026', '05/11/2026', '75,00', '75,00', 'RECIBOS'),
  rateio(1, 398.0, '1005.001 - FINANCEIRO | 04.01 | 2.07.019 -', '75,00'),
  footer(1, 2),

  ...topBanner(2, '23/11/2026 15:59:37'),
  ...header(2),
  // Repetição do GAMA: mesma data/valor/título, NÃO é pagamento novo.
  mainRow(2, 485.9, 'FORNECEDOR GAMA', 'NF-3', '03/11/2026', '05/11/2026', '75,00', '75,00', 'RECIBOS'),
  line(2, 474.3, [['OUTRAS DESPESAS', 517, 100]]),
  // 4) Tipo quebrado para baixo.
  mainRow(2, 463.2, 'FORNECEDOR DELTA', 'NF-4', '04/11/2026', '05/11/2026', '50,00', '50,00', 'NOTAS'),
  line(2, 456.6, [['FISCAIS', 460, 40]]),
  rateio(2, 447.2, '1004.003 - OBRA | 04.02 | 2.14.016 -', '50,00'),
  // Resumos: têm valor, mas não têm data de pagamento.
  line(2, 420.0, [
    ['TOTAL......... 4', 233, 90],
    ['475,00', 362, 35],
    ['475,00', 419, 35],
  ]),
  line(2, 400.0, [
    ['TOTAL GERAL....... 4', 234, 100],
    ['475,00', 357, 35],
    ['475,00', 414, 35],
  ]),
  // 5) Fornecedor quebrado ACIMA da linha do valor.
  line(2, 381.0, [['FORNECEDOR EPSILON', 29, 120]]),
  mainRow(2, 380.0, '', 'NF-5', '05/11/2026', '05/11/2026', '25,00', '25,00', 'MUTUO'),
  footer(2, 2),
];

const parsed = buildTableFromTextLines(LINES);
const parsedFile = {
  fileName: 'conciliação-pagamentos-itau-exemplo.pdf',
  fileType: 'pdf',
  pageCount: 2,
  ...parsed,
};
const analysis = analyzeFileLayout(parsedFile, normalizeMemory(null));
const { records, skipped } = transformRowsWithConfig(parsedFile, analysis);

describe('modelo aprendido: conciliação de pagamentos com rateio de apropriação', () => {
  it('reconhece o cabeçalho e devolve uma linha por título pago', () => {
    assert.deepEqual(parsed.headers, APPROPRIATION_REPORT_HEADERS);
    assert.equal(parsed.columnCount, 8);
    assert.equal(parsed.rows.length, 5);
    assert.equal(skipped.length, 0);
    assert.match(parsed.bannerLines.join(' '), /Contas a Pagar Por Local com Apropriação/);

    const tudo = parsed.rows.flat().join(' ');
    assert.doesNotMatch(tudo, /TOTAL|Page \d+ of|APROPRIADO/i, 'cabeçalho, total e rodapé ficam fora');
    assert.doesNotMatch(tudo, /125,00/, 'valor apropriado não entra como valor');
  });

  it('junta fornecedor, tipo e rateio quebrados, sem duplicar a virada de página', () => {
    assert.equal(records.length, 5);
    assert.deepEqual(
      records.map((record) => record.dateBr),
      ['04/11/2026', '05/11/2026', '05/11/2026', '05/11/2026', '05/11/2026']
    );
    assert.deepEqual(
      records.map((record) => record.value),
      [-100, -250, -75, -50, -25]
    );
    assert.equal(records.reduce((sum, record) => sum + record.value, 0), -500);

    assert.match(records[0].history, /FORNECEDOR ALFA LTDA NF-1 BOLETO/);
    assert.match(records[0].history, /001 - LOCAL 04.01 2.01.001 - SERVIÇO/);
    assert.match(records[1].history, /FOLHA DE PAGAMENTO/);
    assert.match(records[1].history, /1002.002 - MARKETING/);
    assert.match(records[1].history, /1003.001 - SUPRIMENTOS/);
    // O GAMA aparece uma vez só e herda a continuação do rateio da página 2.
    assert.equal(records.filter((record) => record.history.includes('FORNECEDOR GAMA')).length, 1);
    assert.match(records[2].history, /OUTRAS DESPESAS/);
    assert.match(records[3].history, /NOTAS FISCAIS/);
    assert.match(records[4].history, /^FORNECEDOR EPSILON NF-5 MUTUO/);
  });

  it('é reconhecido na primeira importação pelo perfil de fábrica', () => {
    assert.equal(analysis.status, 'matched');
    assert.equal(analysis.matchedProfileId, 'seed-contas-pagar-apropriacao');
    const roles = Object.fromEntries(analysis.mappings.map((mapping) => [mapping.header, mapping.role]));
    assert.equal(roles['DATA EMISSÃO'], 'ignore');
    assert.equal(roles['DATA PAGAMENTO'], 'date');
    assert.equal(roles['VALOR ORIGINAL'], 'ignore');
    assert.equal(roles['VALOR PAGO'], 'value_out');
    assert.equal(roles.APROPRIAÇÃO, 'history');
    assert.equal(analysis.rules.defaultSign, 'negative');
  });

  it('o catálogo não confunde o relatório com o extrato bancário do Itaú', () => {
    const recognition = recognizeLayout(parsedFile);
    assert.equal(recognition.source, 'catalog');
    assert.equal(recognition.bank.id, 'contas-pagar-apropriacao');
    assert.deepEqual(diffRoles(analysis, recognition), []);
  });
});
