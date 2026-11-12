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
    debitAccount: '5086959',
    creditAccount: '',
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
    debitAccount: '',
    creditAccount: '1000077',
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
    // Débito/crédito = conta do contato (contactb) sem pontuação.
    assert.equal(lines[1], '01/10/2026;5086959;;1050,00;PLASTTOTAL PLASTICOS INDUSTRIAIS LTDA — NF 232617');
    // Ponto e vírgula dentro do histórico não pode quebrar as colunas.
    assert.equal(lines[2].split(';').length, 5);
    assert.equal(lines[2].startsWith('02/10/2026;;1000077;3200,00;'), true);
    assert.equal(lines[2].includes('CEREAIS BRAMIL PV09'), true);
    assert.equal(lines[3], 'TOTAIS;;;4250,00;2 lançamento(s) • 1 débito(s) • 1 crédito(s)');
  });

  it('nunca escreve valores negativos', () => {
    const csv = buildCounterpartiesCsv([
      { dateIso: '2026-10-01', debitCents: -12345, creditCents: 0, history: 'sinal invertido' },
      { dateIso: '2026-10-02', debitCents: 0, creditCents: -6789, history: 'sinal invertido 2' },
    ]);
    assert.equal(csv.includes('-'), false);
  });

  it('leva a conta do contato para débito ou crédito conforme a direção', () => {
    const csv = buildCounterpartiesCsv([
      { dateIso: '2026-10-01', debitCents: 1000, creditCents: 0, debitAccount: '5086959', history: 'pagamento' },
      { dateIso: '2026-10-02', debitCents: 0, creditCents: 2000, creditAccount: '1000077', history: 'recebimento' },
      { dateIso: '2026-10-03', debitCents: 500, creditCents: 0, history: 'sem contato' },
    ]);
    const lines = csv.replace(/^\uFEFF/, '').trim().split('\r\n');
    assert.equal(lines[1], '01/10/2026;5086959;;10,00;pagamento');
    assert.equal(lines[2], '02/10/2026;;1000077;20,00;recebimento');
    assert.equal(lines[3], '03/10/2026;;;5,00;sem contato');
  });

  it('neutraliza histórico que o Excel trataria como fórmula', () => {
    const csv = buildCounterpartiesCsv([
      { dateIso: '2026-10-01', debitCents: 1000, creditCents: 0, history: '=SOMA(A1:A9)' },
      { dateIso: '2026-10-02', debitCents: 2000, creditCents: 0, history: '+55 11 99999-0000 fornecedor' },
      { dateIso: '2026-10-03', debitCents: 3000, creditCents: 0, history: '@PIX recebido' },
      { dateIso: '2026-10-04', debitCents: 4000, creditCents: 0, history: '- transferência' },
    ]);
    const lines = csv.replace(/^\uFEFF/, '').trim().split('\r\n');

    assert.equal(lines[1], "01/10/2026;;;10,00;'=SOMA(A1:A9)");
    assert.equal(lines[2], "02/10/2026;;;20,00;'+55 11 99999-0000 fornecedor");
    assert.equal(lines[3], "03/10/2026;;;30,00;'@PIX recebido");
    assert.equal(lines[4], "04/10/2026;;;40,00;'- transferência");
    // Histórico normal continua intacto.
    assert.equal(buildCounterpartiesCsv([{ dateIso: '2026-10-05', debitCents: 500, history: 'PAGAMENTO NF 12' }]).includes(';PAGAMENTO NF 12'), true);
  });

  it('recusa exportar quando não há lançamentos', () => {
    assert.throws(() => exportCounterpartiesPdf([], {}, 'x.pdf'), /jsPDF|lançamentos/i);
    assert.rejects(() => exportCounterpartiesXlsx([], 'x.xlsx', {}), /ExcelJS|lançamentos/i);
  });
});
