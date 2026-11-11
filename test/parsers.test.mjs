import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// As bibliotecas vendorizadas são UMD: ao importá-las como módulo, elas se
// registram em globalThis exatamente como no navegador.
import '../vendor/exceljs/exceljs.min.js';

import {
  buildIsoDate,
  cleanWhitespace,
  excelSerialToIso,
  normalizeText,
  parseDateValue,
  parseMoneyValue,
  parseXlsxFile,
  tokenizeHeader,
} from '../src/parsers.js';

const ExcelJS = globalThis.ExcelJS;

describe('cleanWhitespace / normalizeText / tokenizeHeader', () => {
  it('colapsa espaços, NBSP e caracteres de controle', () => {
    assert.equal(cleanWhitespace('  a\u00a0 b \n c\t'), 'a b c');
    assert.equal(cleanWhitespace(null), '');
    assert.equal(cleanWhitespace('a\u0000b'), 'a b');
  });

  it('remove acentos e caixa', () => {
    assert.equal(normalizeText('Histórico  BANCO'), 'historico banco');
  });

  it('quebra cabeçalhos em tokens alfanuméricos', () => {
    assert.deepEqual(tokenizeHeader('LOCAL | CENTRO DE CUSTO'), ['local', 'centro', 'de', 'custo']);
    assert.deepEqual(tokenizeHeader('Dt. Mov.'), ['dt', 'mov']);
    assert.deepEqual(tokenizeHeader('!!!'), []);
  });
});

describe('buildIsoDate', () => {
  it('valida datas reais do calendário', () => {
    assert.equal(buildIsoDate(2026, 2, 28), '2026-02-28');
    assert.equal(buildIsoDate(2026, 2, 29), null);
    assert.equal(buildIsoDate(2024, 2, 29), '2024-02-29');
    assert.equal(buildIsoDate(2026, 4, 31), null);
    assert.equal(buildIsoDate(2026, 13, 1), null);
    assert.equal(buildIsoDate(2026, 0, 10), null);
    assert.equal(buildIsoDate(1899, 12, 31), null);
  });
});

describe('parseDateValue', () => {
  it('aceita os formatos brasileiros e ISO', () => {
    assert.equal(parseDateValue('02/09/2026'), '2026-09-02');
    assert.equal(parseDateValue('2/9/2026'), '2026-09-02');
    assert.equal(parseDateValue('02-09-2026'), '2026-09-02');
    assert.equal(parseDateValue('02.09.2026'), '2026-09-02');
    assert.equal(parseDateValue('02/09/2026 14:35'), '2026-09-02');
    assert.equal(parseDateValue('2026-09-02'), '2026-09-02');
    assert.equal(parseDateValue('2026-09-02T10:00:00Z'), '2026-09-02');
    assert.equal(parseDateValue('02/09/26'), '2026-09-02');
    assert.equal(parseDateValue('02/09/69'), '2069-09-02');
    assert.equal(parseDateValue('02/09/70'), '1970-09-02');
  });

  it('rejeita datas impossíveis e textos', () => {
    assert.equal(parseDateValue('31/02/2026'), null);
    assert.equal(parseDateValue('00/01/2026'), null);
    assert.equal(parseDateValue('01/01/1800'), null);
    assert.equal(parseDateValue('PAGAMENTO'), null);
    assert.equal(parseDateValue(''), null);
    assert.equal(parseDateValue(null), null);
  });

  it('trata objetos Date em UTC', () => {
    assert.equal(parseDateValue(new Date(Date.UTC(2026, 8, 2))), '2026-09-02');
    assert.equal(parseDateValue(new Date('invalid')), null);
  });

  it('não confunde valores monetários grandes com serial do Excel', () => {
    assert.equal(parseDateValue(45000), null);
    assert.equal(parseDateValue(45000, { allowExcelSerial: true }), '2023-03-15');
    assert.equal(excelSerialToIso(45000), '2023-03-15');
    assert.equal(excelSerialToIso(0), null);
  });
});

describe('parseMoneyValue', () => {
  const cases = [
    ['-R$ 2.000,00', -2000],
    ['R$ 8.002,12', 8002.12],
    ['R$ 1.234.567,89', 1234567.89],
    ['1234,56', 1234.56],
    ['-1234.56', -1234.56],
    ['(1.234,56)', -1234.56],
    ['1.234,56 D', -1234.56],
    ['1.234,56 C', 1234.56],
    ['1.234,56-', -1234.56],
    ['1.234,56 R$', 1234.56],
    ['12.50', 12.5],
    ['1.234', 1234],
    ['1,234', 1234],
    ['1,234.56', 1234.56],
    ['0,00', 0],
    ['45,90', 45.9],
    ['− 10,00', -10],
    [1500.5, 1500.5],
    [-20, -20],
  ];

  for (const [input, expected] of cases) {
    it(`interpreta ${JSON.stringify(input)} como ${expected}`, () => {
      const result = parseMoneyValue(input);
      assert.ok(result, `esperava um valor para ${String(input)}`);
      assert.equal(result.value, expected);
    });
  }

  it('marca sinal explícito e tag D/C', () => {
    assert.deepEqual(parseMoneyValue('-R$ 10,00'), {
      value: -10,
      hasExplicitSign: true,
      dcTag: null,
    });
    assert.deepEqual(parseMoneyValue('10,00 D'), {
      value: -10,
      hasExplicitSign: true,
      dcTag: 'D',
    });
    assert.equal(parseMoneyValue('1.500,00').hasExplicitSign, false);
    assert.equal(parseMoneyValue('1.500,00 C').value, 1500);
  });

  it('rejeita documentos, datas e textos', () => {
    assert.equal(parseMoneyValue('31/12/2025'), null);
    assert.equal(parseMoneyValue('814-1'), null);
    assert.equal(parseMoneyValue('02092026'), null); // código com zero à esquerda
    assert.equal(parseMoneyValue('PAGAMENTO'), null);
    assert.equal(parseMoneyValue('D'), null);
    assert.equal(parseMoneyValue(''), null);
    assert.equal(parseMoneyValue(null), null);
    assert.equal(parseMoneyValue(Number.NaN), null);
  });
});

/**
 * Cria um workbook em memória para exercitar o parser de planilhas.
 */
async function buildWorkbook(build) {
  const workbook = new ExcelJS.Workbook();
  build(workbook);
  return workbook.xlsx.writeBuffer();
}

describe('parseXlsxFile', () => {
  it('detecta cabeçalho, ignora banners e linhas de total', async () => {
    const buffer = await buildWorkbook((workbook) => {
      const sheet = workbook.addWorksheet('Extrato');
      sheet.addRow(['BANCO EXEMPLO S.A.']);
      sheet.addRow(['CNPJ: 12.345.678/0001-99']);
      sheet.addRow([]);
      sheet.addRow(['Data', 'Histórico', 'Documento', 'Valor', 'Saldo']);
      sheet.addRow([new Date(Date.UTC(2026, 0, 5)), 'PIX RECEBIDO', 'PIX-1', 1500.5, 5000]);
      sheet.addRow([new Date(Date.UTC(2026, 0, 6)), 'TARIFA', 'TAR-2', -20.9, 4979.1]);
      sheet.addRow(['TOTAL', '', '', 1479.6, '']);
      sheet.addRow(['Data', 'Histórico', 'Documento', 'Valor', 'Saldo']);
      sheet.mergeCells('A1:E1');
    });

    const parsed = await parseXlsxFile(buffer, 'extrato.xlsx', ExcelJS);

    assert.equal(parsed.fileType, 'xlsx');
    assert.equal(parsed.sheetName, 'Extrato');
    assert.deepEqual(parsed.headers, ['Data', 'Histórico', 'Documento', 'Valor', 'Saldo']);
    assert.equal(parsed.rows.length, 2);

    // Valores nativos preservados (não convertidos em string)
    assert.ok(parsed.rows[0][0] instanceof Date);
    assert.equal(parsed.rows[0][3], 1500.5);
    assert.equal(parsed.rows[1][3], -20.9);

    // Banner mesclado não deve aparecer cinco vezes
    assert.deepEqual(parsed.bannerLines, [
      'BANCO EXEMPLO S.A.',
      'CNPJ: 12.345.678/0001-99',
    ]);
    assert.ok(parsed.skippedRows >= 2); // TOTAL + cabeçalho repetido
  });

  it('escolhe a aba com mais lançamentos e ignora abas ocultas', async () => {
    const buffer = await buildWorkbook((workbook) => {
      const small = workbook.addWorksheet('Resumo');
      small.addRow(['Data', 'Histórico', 'Valor']);
      small.addRow(['01/01/2026', 'Único', '10,00']);

      const big = workbook.addWorksheet('Lançamentos');
      big.addRow(['Data', 'Histórico', 'Valor']);
      big.addRow(['01/01/2026', 'A', '10,00']);
      big.addRow(['02/01/2026', 'B', '20,00']);
      big.addRow(['03/01/2026', 'C', '30,00']);

      const hidden = workbook.addWorksheet('Oculta', { state: 'hidden' });
      hidden.addRow(['Data', 'Histórico', 'Valor']);
      hidden.addRow(['01/01/2026', 'X', '99,00']);
    });

    const parsed = await parseXlsxFile(buffer, 'multi.xlsx', ExcelJS);
    assert.equal(parsed.sheetName, 'Lançamentos');
    assert.equal(parsed.rows.length, 3);
    assert.deepEqual(
      parsed.availableSheets.map((sheet) => sheet.name),
      ['Resumo', 'Lançamentos']
    );
  });

  it('interpreta planilha sem cabeçalho (linhas direto de dados)', async () => {
    const buffer = await buildWorkbook((workbook) => {
      const sheet = workbook.addWorksheet('Dados');
      sheet.addRow(['01/01/2026', 'FORNECEDOR A', '100,00']);
      sheet.addRow(['02/01/2026', 'FORNECEDOR B', '200,00']);
    });

    const parsed = await parseXlsxFile(buffer, 'sem-cabecalho.xlsx', ExcelJS);
    assert.deepEqual(parsed.headers, ['Coluna 1', 'Coluna 2', 'Coluna 3']);
    assert.equal(parsed.rows.length, 2);
  });

  it('resolve fórmulas, rich text e células com erro', async () => {
    const buffer = await buildWorkbook((workbook) => {
      const sheet = workbook.addWorksheet('Dados');
      sheet.addRow(['Data', 'Histórico', 'Valor', 'Fórmula', 'Erro']);
      sheet.addRow([
        new Date(Date.UTC(2026, 0, 5)),
        { richText: [{ text: 'TEXTO' }, { text: ' RICO' }] },
        100,
        { formula: 'C2*2', result: 200 },
        { error: '#DIV/0!' },
      ]);
      sheet.addRow([
        new Date(Date.UTC(2026, 0, 6)),
        'Simples',
        { formula: 'SUM(C2:C2)', result: 50 },
        null,
        '',
      ]);
      sheet.addRow(['TOTAL', '', 150, '', '']);
    });

    const parsed = await parseXlsxFile(buffer, 'exotico.xlsx', ExcelJS);

    assert.equal(parsed.rows.length, 2);
    assert.equal(parsed.rows[0][1], 'TEXTO RICO');
    assert.equal(parsed.rows[0][3], 200); // resultado da fórmula
    assert.equal(parsed.rows[0][4], null); // erro não polui o histórico
    assert.equal(parsed.rows[1][2], 50);
  });

  it('erro amigável quando não há dados', async () => {
    const buffer = await buildWorkbook((workbook) => {
      const sheet = workbook.addWorksheet('Vazia');
      sheet.addRow(['RELATÓRIO SEM LANÇAMENTOS']);
    });

    await assert.rejects(
      () => parseXlsxFile(buffer, 'vazia.xlsx', ExcelJS),
      /Nenhuma linha de dados encontrada/
    );
  });

  it('erro quando ExcelJS não está disponível', async () => {
    await assert.rejects(() => parseXlsxFile(new ArrayBuffer(4), 'x.xlsx', null), /ExcelJS/);
  });

  it('erro amigável para arquivo corrompido', async () => {
    await assert.rejects(
      () => parseXlsxFile(new TextEncoder().encode('não é planilha').buffer, 'ruim.xlsx', ExcelJS),
      /Não foi possível ler/
    );
  });
});
