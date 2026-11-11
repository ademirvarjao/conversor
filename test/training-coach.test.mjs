import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { analyzeFileLayout, ROLES } from '../src/ai-engine.js';
import { buildTableFromTextLines } from '../src/parsers.js';
import {
  applyCoachFixes,
  buildCoachReport,
  CHECK_STATUS,
  coachChecksHtml,
  coachDivergencesHtml,
  coachFixesHtml,
  coachScore,
  coachSummaryHtml,
  findBalanceMapping,
  formatCoachReport,
  proposeFixes,
  reconcileBalances,
} from '../src/training-coach.js';
import { SEED_LOG_LAYOUTS } from './helpers/seed-fixtures.mjs';
import { loadAiMemory } from '../src/ai-engine.js';

/* -------------------------------------------------------------------------- */
/*                                  Ajudantes                                 */
/* -------------------------------------------------------------------------- */

const asPdf = (table, fileName = 'extrato.pdf') => ({ ...table, fileName, fileType: 'pdf' });

/** Análise mínima, escrita à mão: headers na ordem + papéis. */
function analysisWith(headers, roles, extra = {}) {
  return {
    status: 'new_layout',
    mappings: headers.map((header, colIdx) => ({
      colIdx,
      header,
      role: roles[colIdx] || ROLES.IGNORE,
      historyOrder: roles[colIdx] === ROLES.HISTORY ? 1 : 0,
      confidence: 90,
      stats: { samples: [] },
    })),
    rules: { defaultSign: 'auto', removePipes: true, collapseSpaces: true },
    warnings: [],
    ...extra,
  };
}

const loading = () => loadAiMemory();

/* -------------------------------------------------------------------------- */
/*                          Conferência de saldo                              */
/* -------------------------------------------------------------------------- */

describe('treinador automático — conferência de saldo', () => {
  it('fecha o saldo linha a linha no extrato do Bradesco (corrente)', () => {
    const table = buildTableFromTextLines(SEED_LOG_LAYOUTS.bradesco);
    const parsed = asPdf(table, 'bradesco.pdf');
    const analysis = analyzeFileLayout(parsed, loading());

    const balance = reconcileBalances(parsed, analysis);

    assert.equal(balance.available, true);
    assert.equal(balance.columnHeader, 'Saldo (R$)');
    assert.equal(balance.divergences.length, 0);
    assert.equal(balance.checked, 5);
    assert.equal(balance.matched, 5);
    assert.equal(balance.firstSaldoCents, 150000);
    assert.equal(balance.lastSaldoCents, 196174);
  });

  it('no extrato do Itaú só há o saldo anterior — não dá para conferir a soma', () => {
    const parsed = asPdf(buildTableFromTextLines(SEED_LOG_LAYOUTS.itau), 'itau.pdf');
    const analysis = analyzeFileLayout(parsed, loading());

    const balance = reconcileBalances(parsed, analysis);
    assert.equal(balance.available, true);
    assert.equal(balance.checked, 0);

    const report = buildCoachReport(parsed, analysis);
    const check = report.checks.find((item) => item.id === 'saldo');
    assert.equal(check.status, CHECK_STATUS.SKIP);
    assert.match(check.detail, /Só há um saldo/);
  });

  it('confere por checkpoint quando o saldo só aparece no fechamento do dia', () => {
    const parsed = {
      fileName: 'checkpoint.pdf',
      fileType: 'pdf',
      headers: ['Data', 'Histórico', 'Valor (R$)', 'Saldo (R$)'],
      rows: [
        ['30/09/2026', 'SALDO ANTERIOR', '', '1.000,00'],
        ['01/10/2026', 'PIX RECEBIDO', '200,00', ''],
        ['01/10/2026', 'TARIFA', '-50,00', ''],
        ['01/10/2026', 'SALDO TOTAL DISPONÍVEL DIA', '', '1.150,00'],
        ['02/10/2026', 'PIX ENVIADO', '-150,00', ''],
        ['02/10/2026', 'SALDO TOTAL DISPONÍVEL DIA', '', '1.000,00'],
      ],
    };
    const analysis = analysisWith(parsed.headers, [
      ROLES.DATE,
      ROLES.HISTORY,
      ROLES.VALUE_AUTO,
      ROLES.IGNORE,
    ]);

    const balance = reconcileBalances(parsed, analysis);
    assert.equal(balance.checked, 2);
    assert.equal(balance.matched, 2);
    assert.equal(balance.divergences.length, 0);
    assert.equal(balance.anchors.length, 3);
  });

  it('aponta a linha que não fecha, com o valor esperado e a diferença', () => {
    const parsed = {
      fileName: 'erro.pdf',
      fileType: 'pdf',
      headers: ['Data', 'Histórico', 'Valor (R$)', 'Saldo (R$)'],
      rows: [
        ['30/09/2026', 'SALDO ANTERIOR', '', '1.000,00'],
        ['01/10/2026', 'PIX ENVIADO', '-100,00', '800,00'],
        ['02/10/2026', 'PIX ENVIADO', '-100,00', '700,00'],
      ],
    };
    const analysis = analysisWith(parsed.headers, [
      ROLES.DATE,
      ROLES.HISTORY,
      ROLES.VALUE_AUTO,
      ROLES.IGNORE,
    ]);

    const balance = reconcileBalances(parsed, analysis);
    assert.equal(balance.checked, 2);
    assert.equal(balance.matched, 1);
    assert.equal(balance.divergences.length, 1);
    const [divergence] = balance.divergences;
    assert.equal(divergence.saldoCents, 80000);
    assert.equal(divergence.expectedCents, 90000);
    assert.equal(divergence.deltaCents, 10000);
  });

  it('“SALDO ANTERIOR” no meio do arquivo reinicia a conta em vez de virar erro', () => {
    const parsed = {
      fileName: 'secao.pdf',
      fileType: 'pdf',
      headers: ['Data', 'Histórico', 'Valor (R$)', 'Saldo (R$)'],
      rows: [
        ['30/09/2026', 'SALDO ANTERIOR', '', '1.000,00'],
        ['01/10/2026', 'PIX ENVIADO', '-100,00', '900,00'],
        ['04/11/2026', 'SALDO ANTERIOR', '', '500,00'],
        ['05/11/2026', 'PIX ENVIADO', '-100,00', '400,00'],
      ],
    };
    const analysis = analysisWith(parsed.headers, [
      ROLES.DATE,
      ROLES.HISTORY,
      ROLES.VALUE_AUTO,
      ROLES.IGNORE,
    ]);

    const balance = reconcileBalances(parsed, analysis);
    assert.equal(balance.checked, 2);
    assert.equal(balance.matched, 2);
    assert.equal(balance.divergences.length, 0);
    assert.equal(balance.anchors.filter((anchor) => anchor.kind === 'inicial').length, 2);
  });

  it('saldo de outra série (investimento) fica fora da conferência', () => {
    const parsed = {
      fileName: 'invest.pdf',
      fileType: 'pdf',
      headers: ['Data', 'Histórico', 'Valor (R$)', 'Saldo (R$)'],
      rows: [
        ['30/09/2026', 'SALDO ANTERIOR', '', '1.000,00'],
        ['01/10/2026', 'PIX ENVIADO', '-100,00', '900,00'],
        ['01/10/2026', 'SALDO INVEST FÁCIL', '', '333,33'],
        ['02/10/2026', 'SALDO INVEST FÁCIL', '', '444,44'],
      ],
    };
    const analysis = analysisWith(parsed.headers, [
      ROLES.DATE,
      ROLES.HISTORY,
      ROLES.VALUE_AUTO,
      ROLES.IGNORE,
    ]);

    const balance = reconcileBalances(parsed, analysis);
    assert.equal(balance.divergences.length, 0);
    assert.equal(balance.otherSeries.length, 2);
    assert.match(balance.otherSeries[0].label, /INVEST/);
  });

  it('sem coluna de saldo explica por que a conferência não roda', () => {
    const parsed = {
      fileName: 'sem-saldo.pdf',
      fileType: 'pdf',
      headers: ['Data', 'Histórico', 'Valor'],
      rows: [['01/10/2026', 'PIX', '10,00']],
    };
    const analysis = analysisWith(parsed.headers, [ROLES.DATE, ROLES.HISTORY, ROLES.VALUE_AUTO]);

    assert.equal(findBalanceMapping(analysis), null);
    const balance = reconcileBalances(parsed, analysis);
    assert.equal(balance.available, false);
    assert.match(balance.reason, /não tem coluna de saldo/);
  });

  it('coluna de saldo entrando como valor bloqueia a conferência e vira correção', () => {
    const parsed = {
      fileName: 'saldo-valor.pdf',
      fileType: 'pdf',
      headers: ['Data', 'Histórico', 'Saldo (R$)'],
      rows: [
        ['30/09/2026', 'SALDO ANTERIOR', '1.000,00'],
        ['01/10/2026', 'PIX ENVIADO', '900,00'],
      ],
    };
    const analysis = analysisWith(parsed.headers, [ROLES.DATE, ROLES.HISTORY, ROLES.VALUE_AUTO]);

    const balance = reconcileBalances(parsed, analysis);
    assert.equal(balance.available, false);
    assert.match(balance.reason, /está entrando como valor/);

    const fixes = proposeFixes(parsed, analysis, balance);
    assert.equal(fixes.length, 1);
    assert.equal(fixes[0].kind, 'set_role');
    assert.equal(fixes[0].to, ROLES.IGNORE);
  });
});

/* -------------------------------------------------------------------------- */
/*                            Correções propostas                             */
/* -------------------------------------------------------------------------- */

describe('treinador automático — correções', () => {
  it('tira o número do documento da soma', () => {
    const parsed = {
      fileName: 'doc.pdf',
      fileType: 'pdf',
      headers: ['Data', 'Histórico', 'Dcto.', 'Valor (R$)'],
      rows: [
        ['01/10/2026', 'PIX', '102805', '100,00'],
        ['02/10/2026', 'PIX', '7727668', '200,00'],
      ],
    };
    const analysis = analysisWith(parsed.headers, [
      ROLES.DATE,
      ROLES.HISTORY,
      ROLES.VALUE_IN,
      ROLES.VALUE_AUTO,
    ]);

    const fixes = proposeFixes(parsed, analysis);
    const fix = fixes.find((item) => item.id.startsWith('documento-como-valor'));
    assert.ok(fix, 'propõe ignorar a coluna de documento');
    assert.equal(fix.colIdx, 2);

    const fixed = applyCoachFixes(analysis, [fix]);
    assert.equal(fixed.mappings[2].role, ROLES.IGNORE);
    // Não mexe na análise original.
    assert.equal(analysis.mappings[2].role, ROLES.VALUE_IN);
  });

  it('troca crédito e débito quando os sinais estão do lado errado', () => {
    const parsed = {
      fileName: 'trocado.pdf',
      fileType: 'pdf',
      headers: ['Data', 'Histórico', 'Crédito (R$)', 'Débito (R$)'],
      rows: [
        ['01/10/2026', 'PIX ENVIADO', '-100,00', ''],
        ['02/10/2026', 'PIX ENVIADO', '-200,00', ''],
        ['03/10/2026', 'RECEBIMENTO', '', '150,00'],
      ],
    };
    const analysis = analysisWith(parsed.headers, [
      ROLES.DATE,
      ROLES.HISTORY,
      ROLES.VALUE_IN,
      ROLES.VALUE_OUT,
    ]);

    const fixes = proposeFixes(parsed, analysis);
    const fix = fixes.find((item) => item.kind === 'swap_roles');
    assert.ok(fix, 'propõe trocar as colunas');

    const fixed = applyCoachFixes(analysis, [fix]);
    assert.equal(fixed.mappings[2].role, ROLES.VALUE_OUT);
    assert.equal(fixed.mappings[3].role, ROLES.VALUE_IN);
  });

  it('força o sinal de saída quando o saldo cai exatamente a soma dos valores', () => {
    const parsed = {
      fileName: 'pagamentos.pdf',
      fileType: 'pdf',
      headers: ['Data', 'Histórico', 'Valor (R$)', 'Saldo (R$)'],
      rows: [
        ['30/09/2026', 'SALDO ANTERIOR', '', '1.000,00'],
        ['01/10/2026', 'PIX ENVIADO', '50,00', '950,00'],
        ['02/10/2026', 'PIX ENVIADO', '50,00', '900,00'],
        ['03/10/2026', 'TARIFA', '10,00', '890,00'],
      ],
    };
    const analysis = analysisWith(parsed.headers, [
      ROLES.DATE,
      ROLES.HISTORY,
      ROLES.VALUE_AUTO,
      ROLES.IGNORE,
    ]);

    const before = reconcileBalances(parsed, analysis);
    assert.equal(before.matched, 0, 'sem o sinal, o saldo não fecha');

    const fixes = proposeFixes(parsed, analysis, before);
    const fix = fixes.find((item) => item.kind === 'set_default_sign');
    assert.ok(fix, 'propõe o sinal negativo');
    assert.equal(fix.to, 'negative');

    const fixed = applyCoachFixes(analysis, [fix]);
    const after = reconcileBalances(parsed, fixed);
    assert.equal(after.matched, after.checked, 'com o sinal corrigido o saldo fecha');
    assert.equal(after.checked, 3);
  });

  it('usa a coluna D/C quando ela existe e está ignorada', () => {
    const parsed = {
      fileName: 'dc.pdf',
      fileType: 'pdf',
      headers: ['Data', 'Histórico', 'D/C', 'Valor (R$)'],
      rows: [
        ['01/10/2026', 'PIX', 'D', '100,00'],
        ['02/10/2026', 'PIX', 'C', '200,00'],
        ['03/10/2026', 'PIX', 'D', '50,00'],
      ],
    };
    const analysis = analysisWith(parsed.headers, [
      ROLES.DATE,
      ROLES.HISTORY,
      ROLES.IGNORE,
      ROLES.VALUE_AUTO,
    ]);

    const fixes = proposeFixes(parsed, analysis);
    const fix = fixes.find((item) => item.kind === 'set_role' && item.to === ROLES.DC_FLAG);
    assert.ok(fix, 'propõe usar a coluna D/C');

    const fixed = applyCoachFixes(analysis, [fix]);
    const report = buildCoachReport(parsed, fixed);
    assert.equal(report.counts.records, 3);
  });

  it('não propõe nada quando o layout já está correto', () => {
    const parsed = asPdf(buildTableFromTextLines(SEED_LOG_LAYOUTS.bradesco), 'bradesco.pdf');
    const analysis = analyzeFileLayout(parsed, loading());
    assert.deepEqual(proposeFixes(parsed, analysis), []);
  });
});

/* -------------------------------------------------------------------------- */
/*                              Relatório                                     */
/* -------------------------------------------------------------------------- */

describe('treinador automático — relatório', () => {
  it('resume registros, período, totais e conferências', () => {
    const parsed = asPdf(buildTableFromTextLines(SEED_LOG_LAYOUTS.bradesco), 'bradesco.pdf');
    const analysis = analyzeFileLayout(parsed, loading());
    const report = buildCoachReport(parsed, analysis);

    assert.equal(report.counts.records, 5);
    assert.equal(report.period.firstBr, '05/10/2026');
    assert.equal(report.period.lastBr, '09/10/2026');
    assert.equal(report.totals.inCents, 50764);
    assert.equal(report.totals.outCents, -4590);
    assert.equal(report.totals.netCents, 46174);
    assert.equal(report.score.fail, 0);

    const ids = report.checks.map((check) => check.id);
    assert.deepEqual(ids, [
      'layout',
      'colunas',
      'lancamentos',
      'datas',
      'sinal',
      'saldo',
      'descartes',
      'duplicados',
    ]);
    assert.ok(report.checks.every((check) => check.detail.length > 0));
  });

  it('acha lançamentos idênticos', () => {
    const parsed = {
      fileName: 'duplicado.pdf',
      fileType: 'pdf',
      headers: ['Data', 'Histórico', 'Valor (R$)'],
      rows: [
        ['01/10/2026', 'TARIFA', '10,00'],
        ['01/10/2026', 'TARIFA', '10,00'],
        ['02/10/2026', 'TARIFA', '10,00'],
      ],
    };
    const analysis = analysisWith(parsed.headers, [ROLES.DATE, ROLES.HISTORY, ROLES.VALUE_AUTO]);
    const report = buildCoachReport(parsed, analysis);

    assert.equal(report.duplicates.length, 1);
    assert.equal(report.duplicates[0].count, 2);
    const check = report.checks.find((item) => item.id === 'duplicados');
    assert.equal(check.status, CHECK_STATUS.WARN);
  });

  it('gera texto para copiar/colar', () => {
    const parsed = asPdf(buildTableFromTextLines(SEED_LOG_LAYOUTS.bradesco), 'bradesco.pdf');
    const analysis = analyzeFileLayout(parsed, loading());
    const text = formatCoachReport(buildCoachReport(parsed, analysis));

    assert.match(text, /Diagnóstico do arquivo: bradesco\.pdf/);
    assert.match(text, /5 lançamento\(s\)/);
    assert.match(text, /Saldo conferido linha a linha/);
    assert.match(text, /todas fecham/);
  });
});

/* -------------------------------------------------------------------------- */
/*                        Desenho do painel (HTML)                            */
/* -------------------------------------------------------------------------- */

describe('treinador automático — o que aparece na tela', () => {
  const bradescoReport = () => {
    const parsed = asPdf(buildTableFromTextLines(SEED_LOG_LAYOUTS.bradesco), 'bradesco.pdf');
    const analysis = analyzeFileLayout(parsed, loading());
    return buildCoachReport(parsed, analysis);
  };

  it('resume o arquivo em cartões', () => {
    const html = coachSummaryHtml(bradescoReport());
    assert.match(html, /class="coach-stat"/);
    assert.match(html, /Lançamentos/);
    assert.match(html, />5</);
    assert.match(html, /05\/10\/2026 → 09\/10\/2026/);
    assert.match(html, /Saldo conferido/);
    assert.match(html, />5\/5</);
  });

  it('marca cada conferência com o tom certo', () => {
    const report = bradescoReport();
    const html = coachChecksHtml(report);
    assert.match(html, /data-check="colunas"/);
    assert.match(html, /class="coach-check status-ok"/);
    assert.match(html, /Saldo conferido linha a linha/);
  });

  it('selo do cartão do arquivo mostra a conferência de saldo', () => {
    const score = coachScore(bradescoReport());
    assert.equal(score.tone, 'ok');
    assert.match(score.label, /saldo conferido 5\/5/);
    assert.match(score.title, /Colunas entendidas/);
  });

  it('não desenha caixas vazias de correção/divergência quando está tudo certo', () => {
    const report = bradescoReport();
    assert.equal(coachFixesHtml(report), '');
    assert.equal(coachDivergencesHtml(report), '');
  });

  it('desenha as linhas divergentes com valor esperado e diferença', () => {
    const parsed = {
      fileName: 'erro.pdf',
      fileType: 'pdf',
      headers: ['Data', 'Histórico', 'Valor (R$)', 'Saldo (R$)'],
      rows: [
        ['30/09/2026', 'SALDO ANTERIOR', '', '1.000,00'],
        ['01/10/2026', 'PIX ENVIADO', '-100,00', '800,00'],
      ],
    };
    const analysis = analysisWith(parsed.headers, [
      ROLES.DATE,
      ROLES.HISTORY,
      ROLES.VALUE_AUTO,
      ROLES.IGNORE,
    ]);
    const report = buildCoachReport(parsed, analysis);
    const html = coachDivergencesHtml(report);

    assert.match(html, /Linhas que não fecham o saldo \(1\)/);
    assert.match(html, /linha 2/);
    assert.match(html, /esperado 900,00/);
    assert.match(html, /diferença 100,00/);
  });

  it('escapa o conteúdo do arquivo (nada de HTML injetado)', () => {
    const parsed = {
      fileName: 'x.pdf',
      fileType: 'pdf',
      headers: ['Data', 'Histórico', 'Valor (R$)'],
      rows: [['01/10/2026', '<img src=x onerror=alert(1)>', '10,00']],
    };
    const analysis = analysisWith(parsed.headers, [ROLES.DATE, ROLES.HISTORY, ROLES.VALUE_AUTO]);
    const report = buildCoachReport(parsed, analysis);
    const html = coachSummaryHtml(report) + coachChecksHtml(report) + coachFixesHtml(report);
    assert.doesNotMatch(html, /<img/);
  });
});

/* -------------------------------------------------------------------------- */
/*                   Catálogo de bancos dentro do relatório                   */
/* -------------------------------------------------------------------------- */

describe('treinador automático — banco e catálogo', () => {
  const caixaFile = {
    fileName: 'caixa.pdf',
    fileType: 'pdf',
    headers: ['Data', 'Histórico', 'Dcto.', 'Valor', 'Saldo'],
    bannerLines: ['CAIXA ECONÔMICA FEDERAL — extrato de conta corrente'],
    rows: [
      ['30/09/2026', 'SALDO ANTERIOR', '', '', '1.000,00'],
      ['01/10/2026', 'TED RECEBIDA', '123456', '100,00', '1.100,00'],
      ['02/10/2026', 'TARIFA', '789', '-10,00', '1.090,00'],
    ],
  };

  it('identifica o banco no catálogo e diz como reconheceu', () => {
    const parsed = asPdf(buildTableFromTextLines(SEED_LOG_LAYOUTS.bradesco), 'bradesco.pdf');
    const analysis = analyzeFileLayout(parsed, loading());
    const report = buildCoachReport(parsed, analysis);

    assert.equal(report.layout.source, 'catalog');
    assert.equal(report.layout.bank.id, 'bradesco');
    assert.ok(report.layout.confidence >= 0.8);
    assert.match(report.layout.evidence.join(' '), /Bradesco/);

    const check = report.checks.find((item) => item.id === 'layout');
    assert.equal(check.status, CHECK_STATUS.OK);
    assert.match(check.detail, /Bradesco/);
  });

  it('sem banco identificado, avisa que está usando os sinônimos das colunas', () => {
    const parsed = {
      fileName: 'banco-novo.pdf',
      fileType: 'pdf',
      headers: ['Data', 'Descrição', 'Valor'],
      bannerLines: ['BANCO INÉDITO S.A.'],
      rows: [['01/10/2026', 'PIX', '10,00']],
    };
    const analysis = analysisWith(parsed.headers, [ROLES.DATE, ROLES.HISTORY, ROLES.VALUE_AUTO]);
    const report = buildCoachReport(parsed, analysis);

    assert.equal(report.layout.source, 'generic');
    const check = report.checks.find((item) => item.id === 'layout');
    assert.equal(check.status, CHECK_STATUS.WARN);
    assert.match(check.detail, /sinônimos das colunas/);
  });

  it('propõe a correção do banco (Dcto. não é valor) e ela fecha o saldo', () => {
    const analysis = analysisWith(caixaFile.headers, [
      ROLES.DATE,
      ROLES.HISTORY,
      ROLES.VALUE_AUTO, // errado: é o documento
      ROLES.VALUE_AUTO,
      ROLES.IGNORE,
    ]);
    const report = buildCoachReport(caixaFile, analysis);

    const fix = report.fixes.find((item) => fix0(item) === 'ignore');
    function fix0(item) {
      return item.colIdx === 2 ? item.to : null;
    }
    assert.ok(fix, 'correção para a coluna do documento');
    assert.equal(fix.to, ROLES.IGNORE);
    assert.match(fix.reason, /Caixa/, 'motivo cita o banco');

    const fixed = applyCoachFixes(analysis, report.fixes);
    assert.equal(fixed.mappings[2].role, ROLES.IGNORE);
  });

  it('usa layouts baixados da comunidade no reconhecimento', () => {
    const parsed = {
      fileName: 'bnb.pdf',
      fileType: 'pdf',
      headers: ['Data', 'Histórico', 'Documento', 'Valor', 'Saldo'],
      bannerLines: ['BANCO DO NORDESTE DO BRASIL S.A.'],
      rows: [['01/10/2026', 'PIX', '1', '10,00', '1.010,00']],
    };
    const analysis = analysisWith(parsed.headers, [
      ROLES.DATE,
      ROLES.HISTORY,
      ROLES.VALUE_AUTO, // documento entrando como valor
      ROLES.VALUE_AUTO,
      ROLES.IGNORE,
    ]);

    const semCatalogo = buildCoachReport(parsed, analysis);
    assert.equal(semCatalogo.layout.source, 'generic');

    const community = [
      {
        id: 'banco-do-nordeste',
        name: 'Banco do Nordeste (BNB)',
        columns: [
          { match: '^data', role: 'date' },
          { match: 'historico', role: 'history' },
          { match: 'documento', role: 'ignore' },
          { match: 'valor', role: 'value_auto' },
          { match: 'saldo', role: 'ignore' },
        ],
      },
    ];
    const comCatalogo = buildCoachReport(parsed, analysis, null, { layouts: community });
    assert.equal(comCatalogo.layout.source, 'catalog');
    assert.equal(comCatalogo.layout.bank.name, 'Banco do Nordeste (BNB)');
    assert.ok(comCatalogo.fixes.some((fix) => fix.to === ROLES.IGNORE && fix.colIdx === 2));
  });

  it('reaproveita assinatura aprendida quando o banco não está no catálogo', () => {
    const parsed = {
      fileName: 'banco-novo.pdf',
      fileType: 'pdf',
      headers: ['Data', 'Lançamento', 'Documento', 'Crédito (R$)', 'Débito (R$)', 'Saldo (R$)'],
      bannerLines: ['BANCO INÉDITO S.A.'],
      rows: [['01/10/2026', 'PIX', '1', '10,00', '', '1.010,00']],
    };
    const analysis = analysisWith(parsed.headers, [
      ROLES.DATE,
      ROLES.HISTORY,
      ROLES.VALUE_AUTO,
      ROLES.VALUE_AUTO,
      ROLES.VALUE_AUTO,
      ROLES.IGNORE,
    ]);

    const learnedSignatures = [
      {
        id: 'sig-1',
        name: 'Extrato do banco novo',
        headers: ['data', 'lancamento', 'documento', 'credito (r$)', 'debito (r$)', 'saldo (r$)'],
        roles: [
          { header: 'Data', role: 'date', historyOrder: 0 },
          { header: 'Lançamento', role: 'history', historyOrder: 1 },
          { header: 'Documento', role: 'ignore', historyOrder: 0 },
          { header: 'Crédito (R$)', role: 'value_in', historyOrder: 0 },
          { header: 'Débito (R$)', role: 'value_out', historyOrder: 0 },
          { header: 'Saldo (R$)', role: 'ignore', historyOrder: 0 },
        ],
      },
    ];

    const report = buildCoachReport(parsed, analysis, null, { learnedSignatures });
    assert.equal(report.layout.source, 'learned');
    assert.ok(report.fixes.some((fix) => fix.colIdx === 3 && fix.to === ROLES.VALUE_IN));
    assert.ok(report.fixes.some((fix) => fix.colIdx === 4 && fix.to === ROLES.VALUE_OUT));
  });
});
