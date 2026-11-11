import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildCounterpartiesCsv,
  exportCounterpartiesPdf,
  exportCounterpartiesXlsx,
} from '../src/exporters.js';

const rows = [
  {
    id: 0,
    date: '01/10/2026',
    dateIso: '2026-10-01',
    direction: 'payment',
    debitCents: 105000,
    creditCents: 0,
    valueCents: 105000,
    history: 'PLASTTOTAL PLASTICOS INDUSTRIAIS LTDA — NF 232617',
    status: 'matched',
  },
  {
    id: 1,
    date: '02/10/2026',
    dateIso: '2026-10-02',
    direction: 'receipt',
    debitCents: 0,
    creditCents: 320000,
    valueCents: 320000,
    history: 'CEREAIS BRAMIL; PV09',
    status: 'matched',
  },
];

describe('exportação da conciliação de clientes/fornecedores', () => {
  it('monta o CSV no layout data;debito;credito;valor;historico', () => {
    const csv = buildCounterpartiesCsv(rows);
    const lines = csv.replace(/^\uFEFF/, '').trim().split('\r\n');

    assert.equal(lines[0], 'data;debito;credito;valor;historico');
    assert.equal(lines[1], '01/10/2026;1050,00;0,00;1050,00;PLASTTOTAL PLASTICOS INDUSTRIAIS LTDA — NF 232617');
    // Ponto e vírgula dentro do histórico não pode quebrar as colunas.
    assert.equal(lines[2].split(';').length, 5);
    assert.equal(lines[2].includes('CEREAIS BRAMIL PV09'), true);
    assert.equal(lines[3], 'TOTAIS;1050,00;3200,00;4250,00;2 lançamento(s)');
  });

  it('nunca escreve valores negativos', () => {
    const csv = buildCounterpartiesCsv([
      { dateIso: '2026-10-01', debitCents: -12345, creditCents: 0, history: 'sinal invertido' },
      { dateIso: '2026-10-02', debitCents: 0, creditCents: -6789, history: 'sinal invertido 2' },
    ]);
    assert.equal(csv.includes('-'), false);
  });

  it('recusa exportar quando não há lançamentos', () => {
    assert.throws(() => exportCounterpartiesPdf([], {}, 'x.pdf'), /jsPDF|lançamentos/i);
    assert.rejects(() => exportCounterpartiesXlsx([], 'x.xlsx', {}), /ExcelJS|lançamentos/i);
  });
});
