import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyRecognition,
  buildLayoutSignature,
  builtInLayouts,
  detectBank,
  diffRoles,
  headerSimilarity,
  matchLearnedSignature,
  mergeLayouts,
  predictRoles,
  recognizeLayout,
  sanitizeLayout,
} from '../src/bank-layouts.js';

const file = (headers, { bannerLines = [], fileName = 'extrato.pdf', rows = [] } = {}) => ({
  fileName,
  fileType: 'pdf',
  headers,
  bannerLines,
  rows,
});

/** Análise "crua" com os papéis que a IA semântica escolheu. */
const analysisWith = (headers, roles) => ({
  status: 'new_layout',
  rules: { defaultSign: 'auto' },
  warnings: [],
  mappings: headers.map((header, colIdx) => ({
    colIdx,
    header,
    role: roles[colIdx],
    historyOrder: roles[colIdx] === 'history' ? 1 : 0,
    confidence: 70,
    stats: { samples: [] },
  })),
});

describe('catálogo de bancos', () => {
  it('traz os bancos principais já normalizados', () => {
    const layouts = builtInLayouts();
    assert.ok(layouts.length >= 15, `${layouts.length} layouts`);
    for (const layout of layouts) {
      assert.ok(layout.id, 'id');
      assert.ok(layout.columns.length > 0, `${layout.id} tem regras de coluna`);
      assert.ok(layout.columns.every((column) => column.pattern instanceof RegExp));
    }
    const ids = layouts.map((layout) => layout.id);
    for (const id of ['itau', 'bradesco', 'banco-do-brasil', 'caixa', 'santander', 'sicoob', 'sicredi', 'nubank']) {
      assert.ok(ids.includes(id), `catálogo inclui ${id}`);
    }
  });

  it('descarta layout inválido em vez de quebrar', () => {
    assert.equal(sanitizeLayout(null), null);
    assert.equal(sanitizeLayout({ name: 'sem id' }), null);
    assert.equal(sanitizeLayout({ id: 'x' }), null, 'sem colunas');
    assert.equal(sanitizeLayout({ id: 'x', columns: [{ match: '([', role: 'date' }] }), null, 'regex inválida');
    const ok = sanitizeLayout({ id: 'Banco X!', name: 'Banco X', columns: [{ match: '^data', role: 'date' }] });
    assert.equal(ok.id, 'bancox');
  });

  it('junta catálogos sem duplicar id', () => {
    const base = builtInLayouts();
    const extra = [
      sanitizeLayout({ id: 'itau', name: 'Itaú (outro)', columns: [{ match: '^data', role: 'date' }] }),
      sanitizeLayout({ id: 'novo-banco', name: 'Novo', columns: [{ match: '^data', role: 'date' }] }),
    ];
    const merged = mergeLayouts(base, extra);
    assert.equal(merged.filter((layout) => layout.id === 'itau').length, 1);
    assert.equal(merged.find((layout) => layout.id === 'itau').name, 'Itaú Unibanco', 'o embutido vence');
    assert.ok(merged.some((layout) => layout.id === 'novo-banco'), 'acrescenta o novo');
  });
});

describe('reconhecimento do banco', () => {
  it('reconhece pelo nome no arquivo', () => {
    const detected = detectBank(
      file(['Data', 'Lançamento', 'Dcto.', 'Crédito (R$)', 'Débito (R$)', 'Saldo (R$)'], {
        bannerLines: ['Bradesco S.A. Extrato de conta corrente'],
      })
    );
    assert.equal(detected.layout.id, 'bradesco');
    assert.ok(detected.confidence >= 0.8);
    assert.match(detected.evidence.join(' '), /Bradesco/);
  });

  it('reconhece pelo nome do arquivo', () => {
    const detected = detectBank(
      file(['Data', 'Histórico', 'Dcto.', 'Valor', 'Saldo'], { fileName: 'extrato_santander_out26.pdf' })
    );
    assert.equal(detected.layout.id, 'santander');
  });

  it('estrutura parecida sozinha NÃO nomeia o banco', () => {
    const detected = detectBank(file(['Data', 'Descrição', 'Valor', 'Saldo'], { bannerLines: ['BANCO ZETA'] }));
    assert.ok(!detected || detected.confidence < 0.55, 'sem nome, confiança baixa');
  });
});

describe('previsão de papéis', () => {
  it('usa as regras do Banco do Brasil (Data do Balancete não é a data do lançamento)', () => {
    const bb = builtInLayouts().find((layout) => layout.id === 'banco-do-brasil');
    const roles = predictRoles(
      ['Data', 'Dependência Origem', 'Histórico', 'Data do Balancete', 'Documento', 'Valor'],
      bb
    );
    assert.deepEqual(
      roles.map((role) => role.role),
      ['date', 'ignore', 'history', 'ignore', 'ignore', 'value_auto']
    );
    assert.equal(roles[2].historyOrder, 1);
  });

  it('separa crédito e débito quando o banco publica as duas colunas', () => {
    const bradesco = builtInLayouts().find((layout) => layout.id === 'bradesco');
    const roles = predictRoles(
      ['Data', 'Lançamento', 'Dcto.', 'Crédito (R$)', 'Débito (R$)', 'Saldo (R$)'],
      bradesco
    );
    assert.deepEqual(
      roles.map((role) => role.role),
      ['date', 'history', 'ignore', 'value_in', 'value_out', 'ignore']
    );
  });

  it('sem banco conhecido, cai nos sinônimos genéricos', () => {
    const roles = predictRoles(['Dt. Mov.', 'Descrição', 'Nº Doc', 'Valor', 'Saldo', 'D/C']);
    assert.deepEqual(
      roles.map((role) => role.role),
      ['date', 'history', 'ignore', 'value_auto', 'ignore', 'dc_flag']
    );
  });

  it('numera o histórico na ordem das colunas', () => {
    const roles = predictRoles(['Data', 'Histórico', 'Razão Social', 'CNPJ/CPF', 'Valor']);
    const history = roles.filter((role) => role.role === 'history');
    assert.deepEqual(
      history.map((role) => role.historyOrder),
      [1, 2, 3]
    );
  });
});

describe('reconhecimento completo do layout', () => {
  it('banco no catálogo → papéis do banco', () => {
    const recognition = recognizeLayout(
      file(['Data', 'Histórico', 'Dcto.', 'Valor', 'Saldo'], {
        bannerLines: ['CAIXA ECONÔMICA FEDERAL — extrato de conta'],
      })
    );
    assert.equal(recognition.source, 'catalog');
    assert.equal(recognition.bank.id, 'caixa');
    assert.equal(recognition.roles.find((role) => role.header === 'Dcto.').role, 'ignore');
  });

  it('banco desconhecido → heurística genérica', () => {
    const recognition = recognizeLayout(
      file(['Dt. Mov.', 'Descrição', 'Nº Doc', 'Valor', 'Saldo'], { bannerLines: ['BANCO ZETA S.A.'] })
    );
    assert.equal(recognition.source, 'generic');
    assert.equal(recognition.bank, null);
    assert.match(recognition.evidence.join(' '), /sinônimos das colunas/);
  });

  it('reaproveita uma assinatura aprendida (variação de nome de coluna)', () => {
    const signature = {
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
    };

    const recognition = recognizeLayout(
      file(['Data', 'Lançamento', 'Documento', 'Crédito (R$)', 'Débito (R$)', 'Saldo (R$)'], {
        bannerLines: ['Banco Sem Nome — extrato'],
      }),
      { learnedSignatures: [signature] }
    );

    assert.equal(recognition.source, 'learned');
    assert.match(recognition.evidence.join(' '), /parecido/);
    assert.deepEqual(
      recognition.roles.map((role) => role.role),
      ['date', 'history', 'ignore', 'value_in', 'value_out', 'ignore']
    );
  });

  it('mede semelhança de cabeçalhos e escolhe a assinatura mais próxima', () => {
    assert.equal(headerSimilarity(['Data', 'Histórico', 'Valor'], ['Data', 'Histórico', 'Valor']), 1);
    assert.equal(headerSimilarity(['Data'], ['Saldo']), 0);
    const match = matchLearnedSignature(
      ['Data', 'Histórico', 'Valor'],
      [
        { id: 'a', headers: ['data', 'descricao', 'documento', 'saldo'] },
        { id: 'b', headers: ['data', 'historico', 'valor'] },
      ]
    );
    assert.equal(match.signature.id, 'b');
  });
});

describe('divergências entre o que a IA escolheu e o padrão do banco', () => {
  const caixaFile = file(['Data', 'Histórico', 'Dcto.', 'Valor', 'Saldo'], {
    bannerLines: ['CAIXA ECONÔMICA FEDERATRIZ'],
  });

  it('propõe tirar o documento da soma', () => {
    const recognition = recognizeLayout(caixaFile);
    const analysis = analysisWith(caixaFile.headers, ['date', 'history', 'value_auto', 'value_auto', 'ignore']);
    const diffs = diffRoles(analysis, recognition);

    assert.equal(diffs.length, 1);
    assert.equal(diffs[0].header, 'Dcto.');
    assert.equal(diffs[0].to, 'ignore');
    assert.match(diffs[0].reason, /Caixa/);
  });

  it('não mexe quando o papel "valor" é decisão da IA', () => {
    const onlyValues = file(['Data', 'Histórico', 'Valor'], { bannerLines: ['CAIXA ECONÔMICA FEDERAL'] });
    const recognition = recognizeLayout(onlyValues);
    const analysis = analysisWith(onlyValues.headers, ['date', 'history', 'value_auto']);
    assert.deepEqual(diffRoles(analysis, recognition), []);
  });

  it('aplica os papéis num clone (sem alterar a análise original)', () => {
    const recognition = recognizeLayout(caixaFile);
    const analysis = analysisWith(caixaFile.headers, ['date', 'history', 'value_auto', 'value_auto', 'ignore']);
    const applied = applyRecognition(analysis, recognition);

    assert.equal(applied.mappings[2].role, 'ignore');
    assert.equal(analysis.mappings[2].role, 'value_auto', 'original intacta');
    assert.equal(applied.layoutSource, 'catalog');
    assert.equal(applied.detectedBank.id, 'caixa');
  });
});

describe('assinatura do layout treinado', () => {
  it('guarda cabeçalhos normalizados + papéis', () => {
    const parsed = {
      fileName: 'x.pdf',
      fileType: 'pdf',
      headers: ['Data', 'Histórico', 'Valor'],
    };
    const signature = buildLayoutSignature(parsed, {
      mappings: [
        { header: 'Data', role: 'date', historyOrder: 0 },
        { header: 'Histórico', role: 'history', historyOrder: 1 },
        { header: 'Valor', role: 'value_auto', historyOrder: 0 },
      ],
    });

    assert.deepEqual(signature.headers, ['data', 'historico', 'valor']);
    assert.equal(signature.roles.length, 3);
    assert.equal(signature.fileType, 'pdf');
  });

  it('não gera assinatura vazia', () => {
    assert.equal(buildLayoutSignature({ headers: [] }, { mappings: [] }), null);
    assert.equal(buildLayoutSignature({ headers: ['Data'] }, { mappings: [] }), null);
  });
});

describe('catálogo publicado × embutido', () => {
  it('embutido vence por padrão; override explícito atualiza sem publicar versão', () => {
    const [embutido] = builtInLayouts().filter((layout) => layout.id === 'itau');
    assert.ok(embutido, 'Itaú está no catálogo embutido');

    const semOverride = sanitizeLayout(
      {
        id: 'itau',
        name: 'Itaú (catálogo)',
        source: 'community',
        columns: [{ match: '^data', role: 'date' }],
      },
      0
    );
    assert.equal(mergeLayouts([embutido], [semOverride]).find((l) => l.id === 'itau').name, embutido.name);

    const comOverride = sanitizeLayout(
      {
        id: 'itau',
        name: 'Itaú (catálogo corrigido)',
        source: 'community',
        override: true,
        columns: [{ match: '^data', role: 'date' }],
      },
      0
    );
    assert.equal(
      mergeLayouts([embutido], [comOverride]).find((l) => l.id === 'itau').name,
      'Itaú (catálogo corrigido)'
    );
  });
});
