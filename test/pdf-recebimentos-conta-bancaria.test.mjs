import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BANK_RECEIPTS_REPORT_HEADERS,
  buildTableFromTextLines,
} from '../src/parsers.js';
import {
  analyzeFileLayout,
  normalizeMemory,
  transformRowsWithConfig,
} from '../src/ai-engine.js';
import { diffRoles, recognizeLayout } from '../src/bank-layouts.js';
import { buildCoachReport } from '../src/training-coach.js';

/**
 * Geometria do relatório "90ti - Recebimentos por Conta Bancária",
 * com dados FICTÍCIOS. Só as posições X/Y e os rótulos são reais: nenhum
 * cliente, título ou valor do PDF enviado entra no repositório.
 *
 * O fixture cobre: código de conta bancária ("01/01/0445") acima do cabeçalho,
 * sobreposição horizontal entre "Data Recebimento" e "Forma Pagto." no
 * cabeçalho, colunas numéricas alinhadas à direita, quebra de linha em
 * cliente/forma de pagamento, subtotal puramente numérico sem a palavra "TOTAL:",
 * linha "TOTAL:", segunda conta bancária e virada de página com rodapé.
 */

const line = (page, y, items) => ({
  page,
  y,
  h: 9,
  items: items.map(([str, x, w = 40]) => ({ str, x, y, w, h: 9 })),
});

const topBanner = (page, conta = '01/01/0445', emissao = '24/11/2026 15:55:26') => [
  line(page, 550, [['EMPRESA EXEMPLO', 369.6, 105.9]]),
  line(page, 527, [['90ti - Recebimentos por Conta Bancária - teste', 302.7, 239.3]]),
  line(page, 504.5, [
    ['Recebimento', 239.2, 60.5],
    ['01/11/2026 à 10/11/2026', 301.8, 106.7],
    [`Emissão: ${emissao}`, 705.7, 103.8],
  ]),
  ...(conta ? [line(page, 476, [[conta, 30.2, 57.5]])] : []),
];

const header = (page) => [
  line(page, 454, [
    ['Cliente', 29.5, 23.8],
    ['No.Título', 244.9, 31.1],
    ['Local', 318.6, 18.3],
    ['Data Recebimento', 432, 63.4],
    ['Forma Pagto.', 483.1, 46.4],
    ['Vr. Amortizado', 577.5, 50.6],
    ['Vr. Acréscimo', 642.9, 47.6],
    ['Vr. Dedução', 710.3, 42.6],
    ['Vr. Recebido', 768.1, 44.3],
  ]),
];

const footer = (page, total) =>
  line(page, 32, [
    ['EMPRESA EXEMPLO', 29.5, 100],
    ['Sistema Emissor Exemplo Ltda', 371, 180],
    [`Page ${page} of ${total}`, 771, 60],
  ]);

const dataRow = (page, y, cliente, titulo, local, data, forma, amort, acresc, deduc, recebido) =>
  line(page, y, [
    [cliente, 29.5, 140],
    [titulo, 244.9, 60],
    [local, 324.3, 58.3],
    [data, 432, 38.3],
    [forma, 488.7, 61.3],
    // Bordas direitas reais: 625.3, 687.7, 750.0, 812.4
    [amort, 625.3 - 30, 30],
    [acresc, 687.7 - 15, 15],
    [deduc, 750.0 - 15, 15],
    [recebido, 812.4 - 30, 30],
  ]);

const LINES = [
  ...topBanner(1, '01/01/0445'),
  ...header(1),
  dataRow(1, 437, 'CLIENTE ALFA CONSTRUCOES LTDA', 'TRF-2026110001', 'MATRIZ', '04/11/2026', 'PIX Transferência', '10000,00', '0,00', '0,00', '10.000,00'),
  dataRow(1, 426, 'BANCO EXEMPLO S.A.', 'REN-2026110002', 'MATRIZ', '04/11/2026', 'Crédito em Conta', '0,50', '0,00', '0,00', '0,50'),
  // Cliente quebrado em duas linhas (parte de baixo) + acréscimo/dedução diferentes de zero.
  dataRow(1, 415, 'CLIENTE BETA SERVICOS', 'TRF-2026110003', 'FILIAL', '05/11/2026', 'Boleto Bancário', '2000,00', '25,00', '5,00', '2.020,00'),
  line(1, 408, [['INDUSTRIA E COMERCIO LTDA', 29.5, 140]]),
  // Subtotal puramente numérico (sem a palavra TOTAL:) — NÃO pode virar lançamento.
  line(1, 389, [
    ['12.000,50', 625.3 - 38.3, 38.3],
    ['25,00', 687.7 - 20, 20],
    ['5,00', 750.0 - 15, 15],
    ['12.020,50', 812.4 - 38.3, 38.3],
  ]),
  footer(1, 2),

  // Página 2: segunda conta bancária e total geral.
  ...topBanner(2, '01/01/0446'),
  ...header(2),
  dataRow(2, 437, 'CLIENTE GAMA LTDA', 'TRF-2026110004', 'MATRIZ', '06/11/2026', 'PIX Transferência', '500,00', '0,00', '0,00', '500,00'),
  line(2, 420, [
    ['500,00', 625.3 - 25, 25],
    ['0,00', 687.7 - 15, 15],
    ['0,00', 750.0 - 15, 15],
    ['500,00', 812.4 - 25, 25],
  ]),
  line(2, 396, [
    ['TOTAL:', 449, 31.5],
    ['4', 502.2, 4.8],
    ['12.500,50', 625.3 - 38.3, 38.3],
    ['25,00', 687.7 - 20, 20],
    ['5,00', 750.0 - 15, 15],
    ['12.520,50', 812.4 - 38.3, 38.3],
  ]),
  footer(2, 2),
];

const parsed = buildTableFromTextLines(LINES);
const parsedFile = {
  fileName: 'Conciliação recebimentos Itaú - 01.11 até 10.11.2026.pdf',
  fileType: 'pdf',
  pageCount: 2,
  ...parsed,
};
const analysis = analyzeFileLayout(parsedFile, normalizeMemory(null));
const { records, skipped } = transformRowsWithConfig(parsedFile, analysis);
const coach = buildCoachReport(parsedFile, analysis, { records, skipped }, {});

describe('modelo aprendido: 90ti — Recebimentos por Conta Bancária', () => {
  it('reconhece o cabeçalho de 9 colunas sem colar o código da conta nem contar subtotais', () => {
    assert.deepEqual(parsed.headers, BANK_RECEIPTS_REPORT_HEADERS);
    assert.equal(parsed.columnCount, 9);
    assert.equal(parsed.rows.length, 4);
    assert.equal(skipped.length, 0);
    assert.match(parsed.bannerLines.join(' '), /Recebimentos por Conta Bancária/);

    const tudo = parsed.rows.flat().join(' ');
    assert.doesNotMatch(tudo, /01\/01\/044[56]|TOTAL|Page \d+ of|Emissão:/i);
    assert.doesNotMatch(tudo, /12\.020,50|12\.520,50/);
  });

  it('extrai data de recebimento, valor recebido positivo e histórico completo', () => {
    assert.equal(records.length, 4);
    assert.deepEqual(
      records.map((record) => record.dateBr),
      ['04/11/2026', '04/11/2026', '05/11/2026', '06/11/2026']
    );
    assert.deepEqual(
      records.map((record) => record.value),
      [10000, 0.5, 2020, 500]
    );
    assert.equal(records.reduce((sum, record) => sum + record.value, 0), 12520.5);

    assert.equal(
      records[0].history,
      'CLIENTE ALFA CONSTRUCOES LTDA TRF-2026110001 MATRIZ PIX Transferência'
    );
    assert.equal(
      records[2].history,
      'CLIENTE BETA SERVICOS INDUSTRIA E COMERCIO LTDA TRF-2026110003 FILIAL Boleto Bancário'
    );
    assert.equal(
      records[3].history,
      'CLIENTE GAMA LTDA TRF-2026110004 MATRIZ PIX Transferência'
    );
  });

  it('é reconhecido na primeira importação pelo perfil de fábrica sem avisos', () => {
    assert.equal(analysis.status, 'matched');
    assert.equal(analysis.matchedProfileId, 'seed-recebimentos-conta-bancaria');
    assert.deepEqual(analysis.warnings, []);
    assert.equal(analysis.rules.defaultSign, 'positive');

    const roles = Object.fromEntries(analysis.mappings.map((mapping) => [mapping.header, mapping.role]));
    assert.equal(roles.Cliente, 'history');
    assert.equal(roles['No.Título'], 'history');
    assert.equal(roles.Local, 'history');
    assert.equal(roles['Data Recebimento'], 'date');
    assert.equal(roles['Forma Pagto.'], 'history');
    assert.equal(roles['Vr. Amortizado'], 'ignore');
    assert.equal(roles['Vr. Acréscimo'], 'ignore');
    assert.equal(roles['Vr. Dedução'], 'ignore');
    assert.equal(roles['Vr. Recebido'], 'value_in');
  });

  it('o catálogo reconhece como Relatório 90ti — Recebimentos por Conta Bancária (não Itaú extrato)', () => {
    const recognition = recognizeLayout(parsedFile);
    assert.equal(recognition.source, 'catalog');
    assert.equal(recognition.bank.id, 'recebimentos-conta-bancaria');
    assert.deepEqual(diffRoles(analysis, recognition), []);
    assert.deepEqual(coach.fixes, []);
    assert.equal(coach.score.fail, 0);
    assert.equal(coach.score.warn, 0);
  });
});
