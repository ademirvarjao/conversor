import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DIRECTION,
  NATUREZA,
  applyRowAccount,
  buildContactsFromLines,
  buildContactsFromTable,
  buildSourceTransactions,
  contactCode,
  contactSummary,
  historyCore,
  learnFromReconciliation,
  learnManualLink,
  linkHistory,
  mergeContacts,
  mergeTransactions,
  normalizeKey,
  reconcileCounterparties,
  sanitizeCounterparties,
  scoreCandidates,
  significantTokens,
  summarizeReconciliation,
} from '../src/counterparty.js';

/* -------------------------------------------------------------------------- */
/*                          Fixtures (texto do PDF)                           */
/* -------------------------------------------------------------------------- */

const COLUMNS = {
  classificacao: 39,
  contactb: 103,
  nomepessoa: 146,
  natureza: 378,
  tipoconta: 421,
  documento: 468,
};

/** Monta uma linha do PDF: pares [texto, x]. */
function pdfLine(page, y, cells) {
  return {
    page,
    y,
    h: 9,
    items: cells.map(([str, x]) => ({ str, x, y, w: String(str).length * 4.5, h: 9 })),
  };
}

function headerLine(page = 1, y = 736) {
  return pdfLine(page, y, [
    ['classificacao', COLUMNS.classificacao],
    ['contactb', COLUMNS.contactb],
    ['nomepessoa', COLUMNS.nomepessoa],
    ['natureza', COLUMNS.natureza],
    ['tipoconta', COLUMNS.tipoconta],
    ['inscrfederal', COLUMNS.documento],
  ]);
}

function contactLine(page, y, { classificacao, codigo, nome, natureza, tipo = 'Analítica', doc = '' }) {
  return pdfLine(page, y, [
    [classificacao, COLUMNS.classificacao],
    [codigo, COLUMNS.contactb],
    [nome, COLUMNS.nomepessoa],
    [natureza, COLUMNS.natureza],
    [tipo, COLUMNS.tipoconta],
    [doc, COLUMNS.documento],
  ]);
}

const FORNECEDORES = [
  { classificacao: '2.1.03.001.001', codigo: '5.000.046', nome: 'LIGHT SERVICO DE ELETRICIDADE S/A', natureza: 'Credora' },
  { classificacao: '2.1.03.001.001', codigo: '5.086.959', nome: 'PLASTTOTAL PLASTICOS INDUSTRIAIS LTDA', natureza: 'Credora' },
  { classificacao: '2.1.03.001.001', codigo: '5.019.386', nome: 'SERRARIA LIDER TRIRRIENSE LTDA', natureza: 'Credora' },
];

const CLIENTES = [
  { classificacao: '1.1.02.001.001', codigo: '1.000.077', nome: 'CEREAIS BRAMIL LTDA', natureza: 'Devedora' },
  { classificacao: '1.1.02.001.001', codigo: '1.009.545', nome: 'ARES - AEROESPACIAL E DEFESA SA', natureza: 'Devedora' },
];

function questorLines() {
  const lines = [headerLine()];
  let y = 724;
  for (const contact of [...FORNECEDORES, ...CLIENTES]) {
    lines.push(contactLine(1, y, contact));
    y -= 11;
  }
  return lines;
}

function recordsFrom(rows) {
  return rows.map(([dateBr, value, history]) => ({ dateBr, value, history, sourceFile: 'Extrato.xlsx' }));
}

/* -------------------------------------------------------------------------- */
/*                                Texto e nomes                               */
/* -------------------------------------------------------------------------- */

describe('normalização de nomes', () => {
  it('remove acento, pontuação e caixa para comparar', () => {
    assert.equal(
      normalizeKey('Brastêmpera Beneficiamento de Metais Ltda.'),
      'brastempera beneficiamento de metais ltda'
    );
    assert.equal(normalizeKey('  J.AUGUSTO   ADVOCACIA  '), 'j augusto advocacia');
  });

  it('ignora sufixos societários e conectivos nos tokens', () => {
    assert.deepEqual(significantTokens('PLASTTOTAL PLASTICOS INDUSTRIAIS LTDA'), [
      'plasttotal',
      'plasticos',
      'industriais',
    ]);
    assert.deepEqual(significantTokens('J. AUGUSTO ADVOCACIA E CONSULTORIA S/S LTDA'), [
      'augusto',
      'advocacia',
      'consultoria',
    ]);
  });

  it('extrai o núcleo do histórico para os apelidos', () => {
    assert.equal(historyCore('Alef Ferramentas Para Usinagem Ltda 1152 1152/1'), 'alef ferramentas usinagem');
    assert.equal(historyCore('PIX RECEBIDO 123'), 'pix recebido');
  });
});

/* -------------------------------------------------------------------------- */
/*                                   Cadastro                                 */
/* -------------------------------------------------------------------------- */

describe('cadastro Questor', () => {
  it('lê as colunas pela posição do cabeçalho', () => {
    const { contacts, header, rejected } = buildContactsFromLines(questorLines());

    assert.equal(rejected, 0);
    assert.equal(contacts.length, 5);
    assert.ok(header.columns.some((column) => column.column === 'nomepessoa'));

    const light = contacts.find((contact) => contact.code === '5.000.046');
    assert.equal(light.name, 'LIGHT SERVICO DE ELETRICIDADE S/A');
    assert.equal(light.natureza, NATUREZA.CREDORA);
    assert.equal(light.classification, '2.1.03.001.001');
  });

  it('separa fornecedores (credora) de clientes (devedora)', () => {
    const { contacts } = buildContactsFromLines(questorLines());
    assert.deepEqual(contactSummary(contacts), { suppliers: 3, customers: 2, total: 5 });
  });

  it('deduz a natureza pelo plano de contas quando a coluna vem vazia', () => {
    const lines = [
      headerLine(),
      contactLine(1, 700, { classificacao: '2.1.03.001.001', codigo: '5.000.001', nome: 'FORNECEDOR SEM NATUREZA', natureza: '' }),
      contactLine(1, 690, { classificacao: '1.1.02.001.001', codigo: '1.000.001', nome: 'CLIENTE SEM NATUREZA', natureza: '' }),
    ];
    const { contacts } = buildContactsFromLines(lines);
    assert.equal(contacts.find((c) => c.code === '5.000.001').natureza, NATUREZA.CREDORA);
    assert.equal(contacts.find((c) => c.code === '1.000.001').natureza, NATUREZA.DEVEDORA);
  });

  it('junta grafias diferentes do mesmo código', () => {
    const lines = [
      headerLine(),
      contactLine(1, 700, { classificacao: '2.1.03.001.001', codigo: '5.002.167', nome: 'SERASA S A', natureza: 'Credora' }),
      contactLine(1, 690, { classificacao: '2.1.03.001.001', codigo: '5.002.167', nome: 'SERASA S.A.', natureza: 'Credora' }),
      contactLine(1, 680, { classificacao: '2.1.03.001.001', codigo: '5.002.167', nome: 'SERASA SERVICOS', natureza: 'Credora' }),
    ];
    const { contacts } = buildContactsFromLines(lines);
    assert.equal(contacts.length, 1);
    assert.ok(contacts[0].aliases.length >= 2);
    assert.ok(contacts[0].tokens.includes('serasa'));
  });

  it('ignora linhas sem contato ou sem natureza reconhecida', () => {
    const lines = [
      headerLine(),
      pdfLine(1, 700, [
        ['2.1.03.001.001', COLUMNS.classificacao],
        ['', COLUMNS.contactb],
        ['SEM CODIGO', COLUMNS.nomepessoa],
        ['Credora', COLUMNS.natureza],
      ]),
      contactLine(1, 690, { classificacao: '2.1.03.001.001', codigo: '5.000.002', nome: 'OK LTDA', natureza: 'Credora' }),
    ];
    const { contacts, rejected } = buildContactsFromLines(lines);
    assert.equal(contacts.length, 1);
    assert.equal(rejected, 1);
  });

  it('aceita o mesmo cadastro vindo de planilha', () => {
    const headers = ['classificacao', 'contactb', 'nomepessoa', 'natureza', 'tipoconta', 'inscrfederal'];
    const rows = [
      ['2.1.03.001.001', '5.000.046', 'LIGHT SERVICOS DE ELETRICIDADE S/A', 'Credora', 'Analítica', '60.444.437/0001-46'],
      ['1.1.02.001.001', '1.000.077', 'CEREAIS BRAMIL LTDA', 'Devedora', 'Analítica', '32.296.378/0046-72'],
    ];
    const { contacts } = buildContactsFromTable(headers, rows);
    assert.equal(contacts.length, 2);
    assert.deepEqual(contactSummary(contacts), { suppliers: 1, customers: 1, total: 2 });
  });
});

/* -------------------------------------------------------------------------- */
/*                                Lançamentos                                 */
/* -------------------------------------------------------------------------- */

describe('lançamentos de origem', () => {
  it('converte valores em texto brasileiro e define a direção pelo sinal', () => {
    const transactions = buildSourceTransactions([
      { dateBr: '01/10/2026', value: '-851,98', history: 'Alef Ferramentas' },
      { dateBr: '01/10/2026', value: '2.618,50', history: 'Usimaster' },
      { dateBr: '01/10/2026', value: 0, history: 'zerado' },
    ]);

    assert.equal(transactions.length, 2);
    assert.equal(transactions[0].amountCents, -85198);
    assert.equal(transactions[0].direction, DIRECTION.PAYMENT);
    assert.equal(transactions[1].amountCents, 261850);
    assert.equal(transactions[1].direction, DIRECTION.RECEIPT);
  });
});

/* -------------------------------------------------------------------------- */
/*                         Vários arquivos por campo                          */
/* -------------------------------------------------------------------------- */

describe('importação de vários arquivos', () => {
  it('junta cadastros de arquivos diferentes sem duplicar o mesmo código', () => {
    const first = buildContactsFromLines(questorLines()).contacts;
    const second = buildContactsFromLines([
      headerLine(2),
      contactLine(2, 700, { classificacao: '2.1.03.001.001', codigo: '5.086.959', nome: 'PLasttotal Plasticos Industriais Ltda', natureza: 'Credora' }),
      contactLine(2, 690, { classificacao: '2.1.03.001.001', codigo: '5.077.001', nome: 'FORNECEDOR NOVO LTDA', natureza: 'Credora' }),
    ]).contacts;

    const merged = mergeContacts([first, second]);

    assert.equal(merged.length, 6); // 5 do primeiro + 1 novo
    const plast = merged.filter((contact) => contact.code === '5.086.959');
    assert.equal(plast.length, 1, 'o mesmo código não pode duplicar');
    assert.ok(plast[0].aliases.length >= 1);
  });

  it('guarda as grafias diferentes do mesmo código vindas de arquivos diferentes', () => {
    const a = buildContactsFromLines([
      headerLine(),
      contactLine(1, 700, { classificacao: '2.1.03.001.001', codigo: '5.000.046', nome: 'LIGHT SERVICOS DE ELETRICIDADE S/A', natureza: 'Credora' }),
    ]).contacts;
    const b = buildContactsFromLines([
      headerLine(2),
      contactLine(2, 700, { classificacao: '2.1.03.001.001', codigo: '5.000.046', nome: 'LIGHT SERVICO DE ELETRICIDADE LTDA', natureza: 'Credora' }),
    ]).contacts;

    const merged = mergeContacts([a, b]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].aliases.length, 2);
    assert.ok(merged[0].compactNames.length >= 2);
  });

  it('não duplica o mesmo extrato enviado duas vezes', () => {
    const one = buildSourceTransactions(
      recordsFrom([
        ['01/10/2026', '-100,00', 'Taxa bancária'],
        ['01/10/2026', '-100,00', 'Taxa bancária'],
      ])
    );

    const merged = mergeTransactions([one, one]);
    assert.equal(merged.length, 2, 'as duas linhas do mesmo arquivo são legítimas');
  });

  it('soma arquivos diferentes e ordena por data', () => {
    const october = buildSourceTransactions(recordsFrom([['01/10/2026', '-100,00', 'Taxa']]));
    const november = buildSourceTransactions(recordsFrom([['05/11/2026', '250,00', 'Recebimento']]));

    const merged = mergeTransactions([november, october]);
    assert.equal(merged.length, 2);
    assert.equal(merged[0].date, '01/10/2026');
    assert.equal(merged[1].date, '05/11/2026');
  });

  it('mantém lançamentos de mesmo valor com históricos diferentes', () => {
    const a = buildSourceTransactions(recordsFrom([['01/10/2026', '-100,00', 'Taxa A']]));
    const b = buildSourceTransactions(recordsFrom([['01/10/2026', '-100,00', 'Taxa B']]));

    assert.equal(mergeTransactions([a, b]).length, 2);
  });
});

/* -------------------------------------------------------------------------- */
/*                                Conciliação                                 */
/* -------------------------------------------------------------------------- */

describe('conciliação de clientes e fornecedores', () => {
  const contacts = buildContactsFromLines(questorLines()).contacts;

  it('liga pagamento a fornecedor e recebimento a cliente', () => {
    const transactions = buildSourceTransactions(
      recordsFrom([
        ['01/10/2026', '-1.050,00', 'Plasttotal Plástico Industrial Ltda 232617 232617/1'],
        ['01/10/2026', '3.200,00', 'Cereais Bramil Ltda PV09 998877'],
      ])
    );

    const { rows, stats } = reconcileCounterparties(transactions, contacts, { memory: {} });

    assert.equal(stats.matched, 2);
    assert.equal(rows[0].contact.code, '5.086.959');
    assert.equal(rows[0].direction, DIRECTION.PAYMENT);
    assert.equal(rows[1].contact.code, '1.000.077');
    assert.equal(rows[1].direction, DIRECTION.RECEIPT);

    // Layout pedido: data, debito, credito, valor — sem sinais negativos.
    assert.equal(rows[0].debitCents, 105000);
    assert.equal(rows[0].creditCents, 0);
    assert.equal(rows[0].valueCents, 105000);
    assert.equal(rows[1].creditCents, 320000);
    assert.equal(rows[1].debitCents, 0);
    assert.ok(rows.every((row) => row.valueCents > 0));

    // Débito/crédito levam a conta do contato (`contactb`) sem pontuação.
    assert.equal(rows[0].debitAccount, '5086959');
    assert.equal(rows[0].creditAccount, '');
    assert.equal(rows[1].creditAccount, '1000077');
    assert.equal(rows[1].debitAccount, '');
  });

  it('remove a pontuação do código do contato', () => {
    assert.equal(contactCode('5.00.046'), '500046');
    assert.equal(contactCode('1.000.077'), '1000077');
    assert.equal(contactCode('5.086.959'), '5086959');
    assert.equal(contactCode(''), '');
    assert.equal(contactCode(null), '');
  });

  it('não cruza natureza: pagamento não usa cadastro de cliente', () => {
    const transactions = buildSourceTransactions(
      recordsFrom([['01/10/2026', '-500,00', 'Cereais Bramil Ltda PV09']])
    );
    const { rows } = reconcileCounterparties(transactions, contacts, { memory: {} });
    assert.equal(rows[0].contact, null);
    assert.equal(rows[0].status, 'unmatched');
    assert.equal(rows[0].history, 'Cereais Bramil Ltda PV09');
  });

  it('vincula o nome do contato ao histórico sem duplicar', () => {
    const contact = contacts.find((c) => c.code === '5.086.959');
    assert.equal(
      linkHistory('Plasttotal Plástico Industrial Ltda 232617', contact),
      'Plasttotal Plástico Industrial Ltda 232617'
    );
    assert.equal(linkHistory('NF 232617', contact), 'PLASTTOTAL PLASTICOS INDUSTRIAIS LTDA — NF 232617');
    assert.equal(linkHistory('NF 232617', null), 'NF 232617');
  });

  it('não casa só por palavra genérica', () => {
    const transactions = buildSourceTransactions(
      recordsFrom([['01/10/2026', '-85,62', 'Sindicato dos Metalurgicos de Três Rios MENSAL08/2026']])
    );
    const { rows } = reconcileCounterparties(transactions, contacts, { memory: {} });
    assert.equal(rows[0].contact, null);
  });

  it('tolera plural e abreviação do histórico', () => {
    const candidates = scoreCandidates('PLASTTOTAL PLASTICO INDUSTRIAL LTDA 1', contacts, {
      natureza: NATUREZA.CREDORA,
    });
    assert.equal(candidates[0].contact.code, '5.086.959');

    const abrev = scoreCandidates('SERRARIA LIDER TRIRRIENSE LTDA NF 10', contacts, { natureza: NATUREZA.CREDORA });
    assert.equal(abrev[0].contact.code, '5.019.386');
  });

  it('resume totais por débito e crédito', () => {
    const rows = [
      { status: 'matched', direction: DIRECTION.PAYMENT, debitCents: 10000, creditCents: 0, contact: { natureza: NATUREZA.CREDORA } },
      { status: 'manual', direction: DIRECTION.PAYMENT, debitCents: 5000, creditCents: 0, contact: { natureza: NATUREZA.CREDORA } },
      { status: 'unmatched', direction: DIRECTION.RECEIPT, debitCents: 0, creditCents: 25000, contact: null },
    ];
    const stats = summarizeReconciliation(rows);
    assert.equal(stats.total, 3);
    assert.equal(stats.matched, 2);
    assert.equal(stats.unmatched, 1);
    assert.equal(stats.debitCents, 15000);
    assert.equal(stats.creditCents, 25000);
    assert.equal(stats.valueCents, 40000);
    assert.equal(stats.suppliers, 2);
  });
});

/* -------------------------------------------------------------------------- */
/*                        Conta de contrapartida manual                       */
/* -------------------------------------------------------------------------- */

describe('conta de contrapartida digitada à mão', () => {
  it('completa a coluna oposta: pagamento preenche o crédito, recebimento o débito', () => {
    const pagamento = {
      direction: DIRECTION.PAYMENT,
      debitAccount: '5086959',
      creditAccount: '',
      rawHistory: 'NF 10',
      history: 'PLASTTOTAL — NF 10',
    };
    applyRowAccount(pagamento, '1.234-5');
    assert.equal(pagamento.debitAccount, '5086959', 'a conta do fornecedor continua no débito');
    assert.equal(pagamento.creditAccount, '12345', 'a contrapartida entra no crédito');
    assert.equal(pagamento.counterpartAccount, '12345');

    const recebimento = {
      direction: DIRECTION.RECEIPT,
      debitAccount: '',
      creditAccount: '1000077',
      rawHistory: 'PV 20',
      history: 'CEREAIS BRAMIL — PV 20',
    };
    applyRowAccount(recebimento, '12345');
    assert.equal(recebimento.creditAccount, '1000077', 'a conta do cliente continua no crédito');
    assert.equal(recebimento.debitAccount, '12345', 'a contrapartida entra no débito');
  });

  it('não mexe no contato, no histórico nem no status da linha', () => {
    const row = {
      direction: DIRECTION.PAYMENT,
      status: 'matched',
      score: 0.812,
      contact: { code: '5.086.959', name: 'PLASTTOTAL', natureza: NATUREZA.CREDORA },
      rawHistory: 'NF 10',
      history: 'PLASTTOTAL — NF 10',
      debitAccount: '5086959',
      creditAccount: '',
    };

    applyRowAccount(row, '777');
    assert.equal(row.debitAccount, '5086959');
    assert.equal(row.creditAccount, '777');
    assert.equal(row.status, 'matched');
    assert.equal(row.score, 0.812);
    assert.equal(row.contact.code, '5.086.959');
    assert.equal(row.history, 'PLASTTOTAL — NF 10');
  });

  it('funciona em linha sem contato, preenchendo só a contrapartida', () => {
    const row = { direction: DIRECTION.RECEIPT, contact: null, status: 'unmatched', debitAccount: '', creditAccount: '' };
    applyRowAccount(row, '12345');
    assert.equal(row.debitAccount, '12345');
    assert.equal(row.creditAccount, '');
    assert.equal(row.status, 'unmatched');
    assert.equal(row.contact, null);
  });

  it('com a conta vazia, limpa a contrapartida', () => {
    const row = {
      direction: DIRECTION.PAYMENT,
      debitAccount: '5086959',
      creditAccount: '12345',
      counterpartAccount: '12345',
    };
    applyRowAccount(row, '');
    assert.equal(row.creditAccount, '');
    assert.equal(row.debitAccount, '5086959');
    assert.equal(row.counterpartAccount, '');
  });

  it('a conta do contato não é apagada quando a linha recebe contrapartida', () => {
    const rows = [
      { direction: DIRECTION.PAYMENT, debitAccount: '5086959', creditAccount: '' },
      { direction: DIRECTION.RECEIPT, debitAccount: '', creditAccount: '1000077' },
    ];
    for (const row of rows) applyRowAccount(row, '999');
    assert.deepEqual(
      rows.map((row) => [row.debitAccount, row.creditAccount]),
      [
        ['5086959', '999'],
        ['999', '1000077'],
      ]
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                                 Aprendizado                                */
/* -------------------------------------------------------------------------- */

describe('aprendizado da IA', () => {
  const contacts = buildContactsFromLines(questorLines()).contacts;

  it('memoriza o vínculo e reconhece uma descrição truncada na próxima vez', () => {
    const transactions = buildSourceTransactions(
      recordsFrom([['01/10/2026', '-1.050,00', 'Plasttotal Plástico Industrial Ltda 232617']])
    );
    const first = reconcileCounterparties(transactions, contacts, { memory: {} });
    assert.equal(first.rows[0].contact.code, '5.086.959');

    const learned = learnFromReconciliation({}, first.rows);
    assert.equal(learned.learnedCount, 1);
    const aliasKey = historyCore('Plasttotal Plástico Industrial Ltda 232617');
    assert.equal(learned.counterparties.aliases[aliasKey], '5.086.959');

    // Na próxima vez o mesmo histórico é reconhecido mesmo sem os tokens todos.
    const truncated = buildSourceTransactions(recordsFrom([['02/10/2026', '-90,00', 'Plasttotal 99']]));
    const second = reconcileCounterparties(truncated, contacts, { memory: learned });
    assert.equal(second.rows[0].contact.code, '5.086.959');
    assert.equal(second.rows[0].learnedAlias, true);
  });

  it('correção manual vira apelido e reforça os pesos', () => {
    const contact = contacts.find((c) => c.code === '5.019.386');
    const learned = learnManualLink({}, { history: 'SERRARIA DO ZE 8877', contact });

    assert.equal(learned.aliases[historyCore('SERRARIA DO ZE 8877')], '5.019.386');
    assert.ok(Object.values(learned.tokenWeights['5.019.386']).every((weight) => weight >= 1));
    assert.equal(learned.contacts['5.019.386'].name, 'SERRARIA LIDER TRIRRIENSE LTDA');
  });

  it('descarta conteúdo inválido da memória', () => {
    assert.deepEqual(sanitizeCounterparties(null), {
      version: 1,
      aliases: {},
      tokenWeights: {},
      contacts: {},
      uses: 0,
      updatedAt: null,
    });

    const sanitized = sanitizeCounterparties({
      aliases: { 'PLASTTOTAL 232617': '5.086.959', '': 'x' },
      tokenWeights: { '5.086.959': { plasttotal: 3, ruim: 'abc' } },
      contacts: { '5.086.959': { name: 'PLASTTOTAL', natureza: 'devedora', hits: 2 }, x: {} },
      uses: 4,
      updatedAt: '2026-11-11T10:00:00.000Z',
    });

    assert.equal(sanitized.aliases['plasttotal 232617'], '5.086.959');
    assert.equal('' in sanitized.aliases, false);
    assert.equal(sanitized.tokenWeights['5.086.959'].plasttotal, 3);
    assert.equal('ruim' in sanitized.tokenWeights['5.086.959'], false);
    assert.equal(sanitized.contacts['5.086.959'].natureza, NATUREZA.DEVEDORA);
    assert.equal(sanitized.uses, 4);
  });

  it('limita o peso aprendido para não explodir', () => {
    let memory = {};
    const contact = contacts.find((c) => c.code === '5.086.959');
    for (let i = 0; i < 40; i += 1) {
      memory = { counterparties: learnManualLink(memory, { history: `NF ${i}`, contact }) };
    }
    const weight = memory.counterparties.tokenWeights['5.086.959'].plasttotal;
    assert.ok(weight <= 6, `peso ficou em ${weight}`);
  });
});
