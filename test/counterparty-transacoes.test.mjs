/**
 * Leitura do extrato para a conciliação: além da descrição, o lançamento
 * carrega o **nome** (Razão Social, Favorecido…) e o **CPF/CNPJ** quando o
 * arquivo traz essas colunas — é o que permite achar o contato.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DIRECTION, transactionsFromTable } from '../src/counterparty.js';

describe('transactionsFromTable', () => {
  it('junta descrição e razão social no histórico (extrato ICS do Itaú)', () => {
    const headers = ['Data', 'Lançamentos', 'Razão Social', 'CNPJ/CPF', 'Valor (R$)', 'Saldo (R$)'];
    const rows = [
      ['01/10/2026', 'RECEBIMENTO REDE ELO DB0094', 'REDECARD INSTITUICAO DE PAGAMENTO S.A.', '01.425.787/0001-04', '90,21', ''],
      ['02/10/2026', 'PIX RECEBIDO ALELO S01/10', 'ALELO SA', '04.740.876/0001-25', '216,64', ''],
    ];

    const [primeiro, segundo] = transactionsFromTable(headers, rows, { sourceFile: 'ics.pdf' });

    assert.equal(
      primeiro.history,
      'RECEBIMENTO REDE ELO DB0094 — REDECARD INSTITUICAO DE PAGAMENTO S.A.'
    );
    assert.equal(primeiro.document, '01.425.787/0001-04');
    assert.equal(primeiro.amountCents, 9021);
    assert.equal(primeiro.direction, DIRECTION.RECEIPT);
    // "ALELO" já está na descrição: o nome não é repetido.
    assert.equal(segundo.history, 'PIX RECEBIDO ALELO S01/10');
    assert.equal(segundo.document, '04.740.876/0001-25');
  });

  it('não repete o nome quando ele já está na descrição', () => {
    const headers = ['Data', 'Histórico', 'Favorecido', 'Valor'];
    const rows = [['01/10/2026', 'PAGTO PLASTTOTAL PLASTICOS', 'PLASTTOTAL PLASTICOS INDUSTRIAIS LTDA', '-1.000,00']];

    const [tx] = transactionsFromTable(headers, rows);
    // 3 das 4 palavras do nome já estão na descrição: nada a acrescentar.
    assert.equal(tx.history, 'PAGTO PLASTTOTAL PLASTICOS');
  });

  it('não mistura saldo nem valor no histórico', () => {
    const headers = ['Data', 'Histórico', 'Saldo', 'Valor'];
    const rows = [['01/10/2026', 'TARIFA PACOTE', '5.000,00', '-29,90']];

    const [tx] = transactionsFromTable(headers, rows);
    assert.equal(tx.history, 'TARIFA PACOTE');
    assert.equal(tx.amountCents, -2990);
    assert.equal(tx.document, '');
  });

  it('mantém a tabela simples (data | histórico | valor) como antes', () => {
    const headers = ['data', 'historico', 'valor'];
    const rows = [
      ['01/10/2026', 'PIX RECEBIDO', '1.500,00'],
      ['02/10/2026', 'TARIFA', '-20,90'],
    ];

    const txs = transactionsFromTable(headers, rows);
    assert.deepEqual(
      txs.map((tx) => [tx.history, tx.amountCents, tx.direction]),
      [
        ['PIX RECEBIDO', 150000, DIRECTION.RECEIPT],
        ['TARIFA', -2090, DIRECTION.PAYMENT],
      ]
    );
    assert.equal(txs.every((tx) => tx.document === ''), true);
  });

  it('continua lendo débito e crédito em colunas separadas', () => {
    const headers = ['Data', 'Histórico', 'Débito', 'Crédito'];
    const rows = [
      ['01/10/2026', 'PAGAMENTO FORNECEDOR', '500,00', ''],
      ['02/10/2026', 'RECEBIMENTO CLIENTE', '', '800,00'],
    ];

    const txs = transactionsFromTable(headers, rows);
    assert.deepEqual(
      txs.map((tx) => [tx.amountCents, tx.direction]),
      [
        [-50000, DIRECTION.PAYMENT],
        [80000, DIRECTION.RECEIPT],
      ]
    );
  });

  it('ignora linha sem data e mantém a origem', () => {
    const headers = ['Data', 'Histórico', 'Valor'];
    const rows = [
      ['SALDO ANTERIOR', '', '1.000,00'],
      ['03/10/2026', 'PIX', '10,00'],
    ];

    const txs = transactionsFromTable(headers, rows, { sourceFile: 'extrato.xlsx' });
    assert.equal(txs.length, 1);
    assert.equal(txs[0].sourceFile, 'extrato.xlsx');
  });
});
