/**
 * Conciliação por CPF/CNPJ: quando o extrato traz o documento do favorecido
 * (PIX e TED costumam trazer), o vínculo não depende de adivinhar o nome.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DIRECTION,
  NATUREZA,
  buildContactsFromTable,
  buildSourceTransactions,
  documentDigits,
  documentMatches,
  findDocumentInHistory,
  formatDocument,
  historyContainsDocument,
  historyHasDocument,
  reconcileCounterparties,
  scoreCandidates,
  summarizeReconciliation,
} from '../src/counterparty.js';

const HEADERS = ['classificacao', 'contactb', 'nomepessoa', 'natureza', 'inscrfederal'];

const CONTACT_ROWS = [
  ['2.1.03.001.001', '5.086.959', 'PLASTTOTAL PLASTICOS INDUSTRIAIS LTDA', 'Credora', '12.345.678/0001-99'],
  ['2.1.03.001.001', '5.000.046', 'LIGHT SERVICO DE ELETRICIDADE S/A', 'Credora', '60.444.437/0001-46'],
  ['2.1.03.001.001', '5.019.386', 'SERRARIA LIDER TRIRRIENSE LTDA', 'Credora', ''],
  ['1.1.02.001.001', '1.000.077', 'CEREAIS BRAMIL LTDA', 'Devedora', '44.123.456/0001-77'],
];

function contatos() {
  return buildContactsFromTable(HEADERS, CONTACT_ROWS).contacts;
}

function lancamentos(pares) {
  return buildSourceTransactions(
    pares.map(([dateBr, value, history]) => ({ dateBr, value, history, sourceFile: 'Extrato.xlsx' }))
  );
}

function conciliar(pares, options = {}) {
  return reconcileCounterparties(lancamentos(pares), contatos(), { memory: {}, ...options });
}

describe('documentDigits', () => {
  it('aceita CPF e CNPJ com ou sem pontuação', () => {
    assert.equal(documentDigits('12.345.678/0001-99'), '12345678000199');
    assert.equal(documentDigits('12345678000199'), '12345678000199');
    assert.equal(documentDigits('123.456.789-09'), '12345678909');
    assert.equal(documentDigits('12345678909'), '12345678909');
  });

  it('recusa o que não é documento', () => {
    assert.equal(documentDigits(''), null);
    assert.equal(documentDigits('-'), null);
    assert.equal(documentDigits('123'), null);
    assert.equal(documentDigits('1234567890'), null); // 10 dígitos
    assert.equal(documentDigits('123456789012345'), null); // 15 dígitos
    // Documentos de teste/repetidos não identificam ninguém.
    assert.equal(documentDigits('111.111.111-11'), null);
    assert.equal(documentDigits('00.000.000/0000-00'), null);
    assert.equal(documentDigits(null), null);
  });

  it('formata para exibição', () => {
    assert.equal(formatDocument('12345678000199'), '12.345.678/0001-99');
    assert.equal(formatDocument('123.456.789-09'), '123.456.789-09');
    assert.equal(formatDocument('nada'), '');
  });
});

describe('documento no histórico', () => {
  it('encontra o documento com e sem máscara', () => {
    assert.equal(historyHasDocument('PIX ENVIADO 12.345.678/0001-99'), true);
    assert.equal(historyHasDocument('TED 60444437000146'), true);
    assert.equal(historyHasDocument('PAGAMENTO NF 1234'), false);
    assert.equal(historyHasDocument(''), false);
  });

  it('compara com um documento específico', () => {
    assert.equal(historyContainsDocument('PIX 12.345.678/0001-99', '12345678000199'), true);
    assert.equal(historyContainsDocument('PIX 12.345.678/0001-99', '60.444.437/0001-46'), false);
    assert.equal(historyContainsDocument('PIX', '12345678000199'), false);
    assert.equal(historyContainsDocument('PIX 111.111.111-11', '111.111.111-11'), false);
  });
});

describe('conciliação pelo CPF/CNPJ', () => {
  it('vincula pelo CNPJ mascarado, sem o nome no histórico', () => {
    const { rows, stats } = conciliar([['01/10/2026', -1050, 'PIX ENVIADO 12.345.678/0001-99']]);

    assert.equal(rows[0].contact.name, 'PLASTTOTAL PLASTICOS INDUSTRIAIS LTDA');
    assert.equal(rows[0].status, 'matched');
    assert.equal(rows[0].matchReason, 'document');
    assert.equal(stats.byDocument, 1);
    assert.equal(stats.matched, 1);
  });

  it('vincula pelo CNPJ sem máscara, grudado em outro número', () => {
    const { rows } = conciliar([['02/10/2026', -300, 'TED 220 60444437000146 LIGHT']]);
    assert.equal(rows[0].contact.code, '5.000.046');
    assert.equal(rows[0].matchReason, 'document');
  });

  it('vincula pelo CPF do recebimento', () => {
    const { rows } = conciliar([['03/10/2026', 800, 'PIX RECEBIDO 44123456000177']]);
    assert.equal(rows[0].contact?.name, 'CEREAIS BRAMIL LTDA');
    assert.equal(rows[0].direction, DIRECTION.RECEIPT);
    assert.equal(rows[0].matchReason, 'document');
  });

  it('respeita a natureza: pagamento não casa com documento de cliente', () => {
    const { rows } = conciliar([['04/10/2026', -500, 'PAGAMENTO 44123456000177']]);
    assert.equal(rows[0].contact, null);
    assert.equal(rows[0].status, 'unmatched');
  });

  it('números soltos no histórico não criam vínculo', () => {
    const { rows, stats } = conciliar([['05/10/2026', -99, 'NF 12345 6789012345 77']]);
    assert.equal(rows[0].contact, null);
    assert.equal(stats.byDocument, 0);
  });

  it('contato sem documento continua casando por nome', () => {
    const { rows } = conciliar([['06/10/2026', -70, 'PAGTO SERRARIA LIDER TRIRRIENSE']]);
    assert.equal(rows[0].contact?.code, '5.019.386');
    assert.equal(rows[0].matchReason, 'name');
  });

  it('mesmo documento em dois códigos não vira ambiguidade', () => {
    const contacts = buildContactsFromTable(HEADERS, [
      ['2.1.03.001.001', '5.000.111', 'PLASTTOTAL PLASTICOS INDUSTRIAIS LTDA', 'Credora', '12.345.678/0001-99'],
      ['2.1.03.001.001', '5.000.222', 'PLASTTOTAL PLASTICOS INDUSTRIAIS LTDA', 'Credora', '12.345.678/0001-99'],
    ]).contacts;
    const { rows } = reconcileCounterparties(
      lancamentos([['07/10/2026', -400, 'PIX 12345678000199']]),
      contacts,
      { memory: {} }
    );
    assert.equal(rows[0].status, 'matched');
    assert.equal(rows[0].matchReason, 'document');
  });

  it('conta os vínculos por documento nas estatísticas', () => {
    const { rows } = conciliar([
      ['08/10/2026', -100, 'PIX 12.345.678/0001-99'],
      ['09/10/2026', -200, 'PIX 60.444.437/0001-46'],
      ['10/10/2026', -300, 'PAGTO SERRARIA LIDER TRIRRIENSE'],
      ['11/10/2026', -400, 'SAQUE 24H'],
    ]);
    const stats = summarizeReconciliation(rows);
    assert.equal(stats.total, 4);
    assert.equal(stats.matched, 3);
    assert.equal(stats.byDocument, 2);
    assert.equal(stats.unmatched, 1);
  });

  it('explica o casamento por documento na lista de candidatos', () => {
    const [melhor] = scoreCandidates('PIX 12345678000199', contatos(), { natureza: NATUREZA.CREDORA });
    assert.equal(melhor.contact.code, '5.086.959');
    assert.equal(melhor.score, 0.99);

    const contexto = {
      historyTokens: new Set(['pix']),
      historyCompact: 'pix12345678000199',
      documents: { blob: '12345678000199', runs: new Set(['12345678000199']) },
      learned: null,
      index: null,
    };
    assert.equal(documentMatches(melhor.contact, contexto), true);
  });
});

describe('findDocumentInHistory (pista mostrada no painel de vínculo)', () => {
  it('devolve o documento formatado que aparece no histórico', () => {
    assert.equal(findDocumentInHistory('PIX 12.345.678/0001-99'), '12.345.678/0001-99');
    assert.equal(findDocumentInHistory('TED 60444437000146'), '60.444.437/0001-46');
    assert.equal(findDocumentInHistory('CPF 123.456.789-09 do favorecido'), '123.456.789-09');
    assert.equal(findDocumentInHistory('NF 1234 5678'), '');
    // Não recorta pedaço de número maior.
    assert.equal(findDocumentInHistory('NF 12345678 1234567890123'), '');
  });
});
