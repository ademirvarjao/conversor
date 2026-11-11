import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  ROLES,
  STORAGE_KEY,
  analyzeFileLayout,
  analyzeWithOptionalLlm,
  computeColumnProfiles,
  loadAiMemory,
  normalizeMemory,
  resetAiMemory,
  saveAiMemory,
  trainAiWithLayout,
  transformRowsWithConfig,
} from '../src/ai-engine.js';

/** localStorage falso, suficiente para os testes de persistência. */
function installFakeLocalStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
  return store;
}

function rolesOf(analysis) {
  return Object.fromEntries(analysis.mappings.map((mapping) => [mapping.header, mapping.role]));
}

const statementFile = {
  fileName: 'Extrato.xlsx',
  fileType: 'xlsx',
  headers: ['Dt. Mov.', 'Doc.', 'Histórico Banco', 'Entrada (+)', 'Saída (-)', 'Saldo Dia'],
  rows: [
    ['02/09/2026', 'TRF-93593', 'TRANSFERENCIA ATLAS', '8.002,12', '', '8.002,12'],
    ['08/09/2026', '182-1', 'CORINTOS LOGISTICA', '89.628,03', '', '97.630,15'],
    ['10/09/2026', 'TAR-001', 'TARIFA MANUTENCAO', '', '45,90', '97.584,25'],
  ],
  bannerLines: [],
  skippedRows: 0,
};

const paymentsFile = {
  fileName: 'Contas a pagar - Setembro.xlsx',
  fileType: 'xlsx',
  headers: ['Vencimento', 'Fornecedor', 'Documento', 'Valor'],
  rows: [
    ['10/03/2026', 'ACME LTDA', 'NF 123', '1.000,00'],
    ['11/03/2026', 'BETA SA', 'NF 456', '2.500,50'],
  ],
  bannerLines: [],
  skippedRows: 0,
};

describe('computeColumnProfiles', () => {
  it('classifica estatisticamente datas, valores, D/C e textos', () => {
    const [date, history, value, dc, empty] = computeColumnProfiles(
      ['Data', 'Histórico', 'Valor', 'Tipo', 'Observação'],
      [
        ['01/02/2026', 'PAGTO', '10,00', 'D', null],
        ['02/02/2026', 'RECEBTO', '-20,00', 'C', null],
      ]
    );

    assert.equal(date.pctDate, 1);
    assert.equal(history.pctMoney, 0);
    assert.equal(value.pctMoney, 1);
    assert.equal(value.pctNegative, 0.5);
    assert.equal(dc.pctDC, 1);
    assert.equal(empty.nonEmpty, 0);
    assert.equal(empty.nonEmptyRatio, 0);
    assert.deepEqual(value.samples, ['10,00', '-20,00']);
  });

  it('conta datas nativas (Date) como data, não como valor', () => {
    const [date] = computeColumnProfiles(['Data'], [[new Date(Date.UTC(2026, 0, 5))]]);
    assert.equal(date.dateCount, 1);
    assert.equal(date.moneyCount, 0);
  });
});

describe('analyzeFileLayout', () => {
  it('identifica entrada/saída separadas e ignora saldo', () => {
    const analysis = analyzeFileLayout(statementFile, loadAiMemory());

    assert.deepEqual(rolesOf(analysis), {
      'Dt. Mov.': ROLES.DATE,
      'Doc.': ROLES.HISTORY,
      'Histórico Banco': ROLES.HISTORY,
      'Entrada (+)': ROLES.VALUE_IN,
      'Saída (-)': ROLES.VALUE_OUT,
      'Saldo Dia': ROLES.IGNORE,
    });
    assert.equal(analysis.status, 'new_layout');
    assert.ok(analysis.avgConfidence >= 70);
  });

  it('marca colunas totalmente vazias como ignoradas', () => {
    const analysis = analyzeFileLayout(
      {
        fileName: 'vazio.xlsx',
        fileType: 'xlsx',
        headers: ['Data', 'Histórico', 'Valor', 'Coluna Extra'],
        rows: [['01/01/2026', 'X', '10,00', null]],
        bannerLines: [],
      },
      loadAiMemory()
    );

    const extra = analysis.mappings.find((mapping) => mapping.header === 'Coluna Extra');
    assert.equal(extra.role, ROLES.IGNORE);
    assert.equal(extra.confidence, 100);
  });

  it('infere sinal negativo para arquivos de contas a pagar', () => {
    const analysis = analyzeFileLayout(paymentsFile, loadAiMemory());
    assert.equal(analysis.rules.defaultSign, 'negative');
  });

  it('identifica coluna D/C', () => {
    const analysis = analyzeFileLayout(
      {
        fileName: 'razao.xlsx',
        fileType: 'xlsx',
        headers: ['Data', 'Histórico', 'Documento', 'Valor', 'D/C'],
        rows: [
          ['01/02/2026', 'PAGTO FORNECEDOR', 'NF 123', '1.500,00', 'D'],
          ['02/02/2026', 'RECEBIMENTO CLIENTE', 'REC 44', '2.300,00', 'C'],
        ],
        bannerLines: [],
      },
      loadAiMemory()
    );

    assert.equal(rolesOf(analysis)['D/C'], ROLES.DC_FLAG);
  });

  it('não dá confiança alta para colunas vazias/ambíguas', () => {
    const analysis = analyzeFileLayout(
      {
        fileName: 'ambigua.xlsx',
        fileType: 'xlsx',
        headers: ['Data', 'Histórico', 'Valor', 'A', 'B'],
        rows: [
          ['01/01/2026', 'X', '10,00', 'zzz', 'yyy'],
          ['02/01/2026', 'Y', '20,00', 'www', 'xxx'],
        ],
        bannerLines: [],
      },
      loadAiMemory()
    );

    for (const mapping of analysis.mappings) {
      assert.ok(mapping.confidence <= 97, `confiança ${mapping.confidence} fora do limite`);
    }
  });

  it('reconhece layout treinado e detecta evolução', () => {
    installFakeLocalStorage();
    let memory = loadAiMemory();

    const baseFile = {
      fileName: 'layout.xlsx',
      fileType: 'xlsx',
      headers: ['Data', 'Histórico', 'Valor'],
      rows: [
        ['01/01/2026', 'X', '10,00'],
        ['02/01/2026', 'Y', '20,00'],
      ],
      bannerLines: [],
    };

    const firstAnalysis = analyzeFileLayout(baseFile, memory);
    memory = trainAiWithLayout(baseFile, firstAnalysis, 'Layout Base', memory);

    const exact = analyzeFileLayout(baseFile, memory);
    assert.equal(exact.status, 'matched');
    assert.equal(exact.matchSimilarity, 100);

    const evolvedFile = {
      ...baseFile,
      headers: ['Data', 'Histórico', 'Valor', 'Nova Coluna'],
      rows: baseFile.rows.map((row) => [...row, 'extra']),
    };
    const evolved = analyzeFileLayout(evolvedFile, memory);
    assert.equal(evolved.status, 'evolved');
    assert.ok(evolved.changesDetected.some((change) => /Nova coluna detectada/.test(change)));
  });
});

describe('colunas de entradas e saídas (débito × crédito)', () => {
  // Layout de extrato bancário: o valor de cada linha aparece em UMA das duas
  // colunas (Pagto. ou Recbto.), nunca nas duas, e existe uma coluna de saldo.
  const extratoBancario = {
    fileName: 'Extrato - Conta Corrente.pdf',
    fileType: 'pdf',
    headers: ['Lancto', 'Data', 'Beneficiário', 'Histórico', 'Pagto.', 'Recbto.', 'Saldo'],
    rows: [
      ['0', '31/05/2026', '', 'SALDO ANTERIOR', '', '', '10.000,00'],
      ['87564', '01/06/2026', 'FORNECEDOR ALFA', 'LINK DE PGT', '2.357,98', '', '7.642,02'],
      ['87565', '01/06/2026', 'CLIENTE BETA', 'VALOR RECEBIDO', '', '836,40', '8.478,42'],
      ['87566', '02/06/2026', 'CLIENTE GAMA', 'VALOR RECEBIDO', '', '27.639,00', '36.117,42'],
      ['87567', '03/06/2026', 'FORNECEDOR DELTA', 'PAGAMENTO', '1.500,00', '', '34.617,42'],
      ['87568', '04/06/2026', 'CLIENTE EPSILON', 'VALOR RECEBIDO', '', '320,55', '34.937,97'],
      ['87569', '05/06/2026', 'TARIFA', 'ITAÚ SUL', '45,90', '', '34.892,07'],
      ['99999999', '30/06/2026', '', 'SALDO FINAL', '', '', '34.892,07'],
    ],
    bannerLines: ['EMPRESA EXEMPLO LTDA'],
    skippedRows: 0,
  };

  const copiaComCabecalhos = (headers) => ({ ...extratoBancario, headers });

  it('reconhece o par Pagto./Recbto. e confirma o sentido pelo saldo', () => {
    const analysis = analyzeFileLayout(extratoBancario, loadAiMemory());

    assert.deepEqual(rolesOf(analysis), {
      Lancto: ROLES.IGNORE,
      Data: ROLES.DATE,
      Beneficiário: ROLES.HISTORY,
      Histórico: ROLES.HISTORY,
      'Pagto.': ROLES.VALUE_OUT,
      'Recbto.': ROLES.VALUE_IN,
      Saldo: ROLES.IGNORE,
    });

    const pagto = analysis.mappings.find((mapping) => mapping.header === 'Pagto.');
    const recbto = analysis.mappings.find((mapping) => mapping.header === 'Recbto.');
    assert.match(pagto.reason, /par entradas\/saídas/i);
    assert.match(recbto.reason, /par entradas\/saídas/i);
    assert.ok(pagto.confidence >= 90);
    assert.deepEqual(analysis.warnings, []);
  });

  it('transforma cada linha em um único lançamento com o sinal correto', () => {
    const analysis = analyzeFileLayout(extratoBancario, loadAiMemory());
    const { records, skipped } = transformRowsWithConfig(extratoBancario, {
      mappings: analysis.mappings,
      rules: analysis.rules,
    });

    assert.deepEqual(
      records.map((record) => record.value),
      [-2357.98, 836.4, 27639, -1500, 320.55, -45.9]
    );
    assert.equal(skipped.length, 2); // saldo anterior e saldo final não têm valor
  });

  it('decide o sentido pelo saldo quando os cabeçalhos não ajudam', () => {
    const anonimo = copiaComCabecalhos([
      'Lancto',
      'Data',
      'Beneficiário',
      'Histórico',
      'Valor 1',
      'Valor 2',
      'Saldo',
    ]);
    const analysis = analyzeFileLayout(anonimo, loadAiMemory());
    const roles = rolesOf(analysis);

    assert.equal(roles['Valor 1'], ROLES.VALUE_OUT);
    assert.equal(roles['Valor 2'], ROLES.VALUE_IN);
  });

  it('usa o cabeçalho Entradas/Saídas quando não existe coluna de saldo', () => {
    const semSaldo = {
      fileName: 'Movimento.xlsx',
      fileType: 'xlsx',
      headers: ['Data', 'Histórico', 'Entradas', 'Saídas'],
      rows: [
        ['01/06/2026', 'VENDA', '1.000,00', ''],
        ['02/06/2026', 'FORNECEDOR', '', '400,00'],
        ['03/06/2026', 'SERVICO', '250,00', ''],
        ['04/06/2026', 'ALUGUEL', '', '1.200,00'],
        ['05/06/2026', 'JUROS', '12,30', ''],
        ['06/06/2026', 'TARIFA', '', '45,90'],
      ],
      bannerLines: [],
      skippedRows: 0,
    };

    const analysis = analyzeFileLayout(semSaldo, loadAiMemory());
    assert.deepEqual(rolesOf(analysis), {
      Data: ROLES.DATE,
      Histórico: ROLES.HISTORY,
      Entradas: ROLES.VALUE_IN,
      Saídas: ROLES.VALUE_OUT,
    });

    const { records } = transformRowsWithConfig(semSaldo, {
      mappings: analysis.mappings,
      rules: analysis.rules,
    });
    assert.deepEqual(
      records.map((record) => record.value),
      [1000, -400, 250, -1200, 12.3, -45.9]
    );
  });

  it('não soma duas colunas de valor independentes', () => {
    const duasColunas = {
      fileName: 'Vendas.xlsx',
      fileType: 'xlsx',
      headers: ['Data', 'Histórico', 'Valor Bruto', 'Valor Líquido'],
      rows: [
        ['01/06/2026', 'VENDA A', '1.000,00', '950,00'],
        ['02/06/2026', 'VENDA B', '2.000,00', '1.900,00'],
        ['03/06/2026', 'VENDA C', '3.000,00', '2.850,00'],
      ],
      bannerLines: [],
      skippedRows: 0,
    };

    const analysis = analyzeFileLayout(duasColunas, loadAiMemory());
    const auto = analysis.mappings.filter((mapping) => mapping.role === ROLES.VALUE_AUTO);
    assert.equal(auto.length, 1, 'apenas uma coluna pode ser valor automático');
    assert.ok(analysis.warnings.some((warning) => /mais de uma coluna parecia valor/i.test(warning)));
  });
});

describe('relatório de contas recebidas (agrupado por cliente)', () => {
  // Layout "Contas Recebidas por Cliente": o valor previsto (vencimento) e o
  // realizado (recebido) convivem, e cada grupo começa com o nome do cliente.
  const contasRecebidas = {
    fileName: 'CONTAS RECEBIDAS JUL26.pdf',
    fileType: 'pdf',
    headers: ['Coluna 1', 'Nota Fiscal', 'Duplicata', 'Data Venc', 'Valor Venc', 'Data Rec', 'Valor Recebido'],
    rows: [
      ['Usimaster Peças de Precisão Ltda', '', '', '', '', '', ''],
      ['1', '123349', '123349/1', '03/07/2026', '1.540,82', '03/07/2026', '1.540,82'],
      ['2', '123336', '123336/2', '06/07/2026', '14.566,50', '07/07/2026', '14.566,50'],
      ['3', '123337', '123337/2', '06/07/2026', '825,50', '07/07/2026', '825,50'],
      ['Coldmix Ind. Com. e Representações Ltda.', '', '', '', '', '', ''],
      ['1', '123350', '123350/1', '10/07/2026', '3.221,57', '10/07/2026', '3.221,57'],
      ['2', '123375', '123375/1', '12/07/2026', '2.575,80', '12/07/2026', '2.575,80'],
    ],
    bannerLines: ['Contas Recebidas por Cliente - Agrupadas'],
    skippedRows: 0,
  };

  it('usa a data de recebimento, não a de vencimento', () => {
    const analysis = analyzeFileLayout(contasRecebidas, loadAiMemory());
    assert.equal(rolesOf(analysis)['Data Rec'], ROLES.DATE);
    assert.equal(rolesOf(analysis)['Data Venc'], ROLES.IGNORE);
  });

  it('usa o valor recebido, não o valor de vencimento', () => {
    const analysis = analyzeFileLayout(contasRecebidas, loadAiMemory());
    assert.equal(rolesOf(analysis)['Valor Recebido'], ROLES.VALUE_AUTO);
    assert.equal(rolesOf(analysis)['Valor Venc'], ROLES.IGNORE);
  });

  it('ignora a numeração sequencial da linha', () => {
    const analysis = analyzeFileLayout(contasRecebidas, loadAiMemory());
    assert.equal(rolesOf(analysis)['Coluna 1'], ROLES.IGNORE);
  });

  it('usa o nome do cliente como prefixo do histórico do grupo', () => {
    const analysis = analyzeFileLayout(contasRecebidas, loadAiMemory());
    const { records, skipped } = transformRowsWithConfig(contasRecebidas, {
      mappings: analysis.mappings,
      rules: analysis.rules,
    });

    assert.equal(records.length, 5);
    assert.deepEqual(
      records.map((record) => [record.dateBr, record.value, record.history]),
      [
        ['03/07/2026', 1540.82, 'Usimaster Peças de Precisão Ltda 123349 123349/1'],
        ['07/07/2026', 14566.5, 'Usimaster Peças de Precisão Ltda 123336 123336/2'],
        ['07/07/2026', 825.5, 'Usimaster Peças de Precisão Ltda 123337 123337/2'],
        ['10/07/2026', 3221.57, 'Coldmix Ind. Com. e Representações Ltda. 123350 123350/1'],
        ['12/07/2026', 2575.8, 'Coldmix Ind. Com. e Representações Ltda. 123375 123375/1'],
      ]
    );
    assert.ok(
      skipped.some((entry) => /cabeçalho de grupo/i.test(entry.reason)),
      'os cabeçalhos de grupo são registrados como ignorados'
    );
  });

  it('mantém o formato data | valor | historico igual ao extrato de recebimentos', () => {
    const analysis = analyzeFileLayout(contasRecebidas, loadAiMemory());
    const { records } = transformRowsWithConfig(contasRecebidas, {
      mappings: analysis.mappings,
      rules: analysis.rules,
    });
    for (const record of records) {
      assert.match(record.dateBr, /^\d{2}\/\d{2}\/\d{4}$/);
      assert.equal(typeof record.value, 'number');
      assert.ok(record.value > 0, 'recebimentos entram positivos');
      assert.ok(record.history.length > 0);
    }
  });
});

describe('transformRowsWithConfig', () => {
  it('converte entrada/saída separadas em valores assinados', () => {
    const analysis = analyzeFileLayout(statementFile, loadAiMemory());
    const { records, skipped } = transformRowsWithConfig(statementFile, analysis);

    assert.equal(skipped.length, 0);
    assert.deepEqual(
      records.map((record) => record.value),
      [8002.12, 89628.03, -45.9]
    );
    assert.equal(records[0].dateBr, '02/09/2026');
    assert.equal(records[0].history, 'TRF-93593 TRANSFERENCIA ATLAS');
    assert.equal(records[0].sourceFile, 'Extrato.xlsx');
  });

  it('aplica D/C, sinal padrão e limpeza do histórico', () => {
    const file = {
      fileName: 'razao.xlsx',
      fileType: 'xlsx',
      headers: ['Data', 'Histórico', 'Valor', 'D/C'],
      rows: [
        ['01/02/2026', 'PAGTO | FORNECEDOR   ABC', '1.500,00', 'D'],
        ['02/02/2026', 'RECEBIMENTO  CLIENTE', '2.300,00', 'C'],
      ],
      bannerLines: [],
    };

    const config = {
      mappings: [
        { colIdx: 0, role: ROLES.DATE, historyOrder: 0 },
        { colIdx: 1, role: ROLES.HISTORY, historyOrder: 1 },
        { colIdx: 2, role: ROLES.VALUE_AUTO, historyOrder: 0 },
        { colIdx: 3, role: ROLES.DC_FLAG, historyOrder: 0 },
      ],
      rules: { defaultSign: 'auto', removePipes: true, collapseSpaces: true },
    };

    const { records } = transformRowsWithConfig(file, config);
    assert.deepEqual(
      records.map((record) => record.value),
      [-1500, 2300]
    );
    assert.equal(records[0].history, 'PAGTO FORNECEDOR ABC');
  });

  it('usa o sinal padrão quando o arquivo não traz sinal', () => {
    const analysis = analyzeFileLayout(paymentsFile, loadAiMemory());
    const { records } = transformRowsWithConfig(paymentsFile, analysis);

    assert.deepEqual(
      records.map((record) => record.value),
      [-1000, -2500.5]
    );
  });

  it('aplica substituição extra configurada', () => {
    const file = {
      fileName: 'x.xlsx',
      fileType: 'xlsx',
      headers: ['Data', 'Histórico', 'Valor'],
      rows: [['01/01/2026', 'PAGTO*ABC*DEF', '10,00']],
      bannerLines: [],
    };
    const config = {
      mappings: [
        { colIdx: 0, role: ROLES.DATE, historyOrder: 0 },
        { colIdx: 1, role: ROLES.HISTORY, historyOrder: 1 },
        { colIdx: 2, role: ROLES.VALUE_AUTO, historyOrder: 0 },
      ],
      rules: { defaultSign: 'auto', removePipes: true, customReplaceFrom: '*', customReplaceTo: '-' },
    };

    const { records } = transformRowsWithConfig(file, config);
    assert.equal(records[0].history, 'PAGTO-ABC-DEF');
  });

  it('ignora linhas sem data ou sem valor e informa o motivo', () => {
    const file = {
      fileName: 'linhas.xlsx',
      fileType: 'xlsx',
      headers: ['Data', 'Histórico', 'Valor'],
      rows: [
        ['01/01/2026', 'OK', '10,00'],
        ['sem data', 'IGNORAR', '20,00'],
        ['02/01/2026', 'SEM VALOR', ''],
      ],
      bannerLines: [],
    };
    const config = {
      mappings: [
        { colIdx: 0, role: ROLES.DATE, historyOrder: 0 },
        { colIdx: 1, role: ROLES.HISTORY, historyOrder: 1 },
        { colIdx: 2, role: ROLES.VALUE_AUTO, historyOrder: 0 },
      ],
    };

    const { records, skipped } = transformRowsWithConfig(file, config);
    assert.equal(records.length, 1);
    assert.deepEqual(
      skipped.map((item) => item.reason),
      ['Sem data válida', 'Sem valor numérico válido']
    );
    assert.equal(skipped[0].rowIdx, 2);
  });

  it('não quebra quando a configuração vem incompleta', () => {
    const file = {
      fileName: 'x.xlsx',
      fileType: 'xlsx',
      headers: ['Data', 'Valor'],
      rows: [['01/01/2026', '10,00']],
      bannerLines: [],
    };

    const { records, skipped } = transformRowsWithConfig(file, {});
    assert.equal(records.length, 0);
    assert.equal(skipped.length, 1);
  });

  it('respeita a ordem do histórico e formata datas nativas', () => {
    const file = {
      fileName: 'x.xlsx',
      fileType: 'xlsx',
      headers: ['Histórico B', 'Data', 'Histórico A', 'Valor'],
      rows: [[new Date(Date.UTC(2026, 0, 5)), 'segundo', 'primeiro', '10,00']],
      bannerLines: [],
    };
    const config = {
      mappings: [
        { colIdx: 0, role: ROLES.DATE, historyOrder: 0 },
        { colIdx: 1, role: ROLES.HISTORY, historyOrder: 2 },
        { colIdx: 2, role: ROLES.HISTORY, historyOrder: 1 },
        { colIdx: 3, role: ROLES.VALUE_AUTO, historyOrder: 0 },
      ],
    };

    const { records } = transformRowsWithConfig(file, config);
    assert.equal(records[0].history, 'primeiro segundo');
    assert.equal(records[0].dateBr, '05/01/2026');
  });
});

describe('memória da IA', () => {
  beforeEach(() => installFakeLocalStorage());
  afterEach(() => {
    delete globalThis.localStorage;
  });

  it('cria memória padrão quando não há nada salvo', () => {
    const memory = loadAiMemory();
    assert.equal(memory.learnedProfiles.length, 0);
    assert.equal(memory.version, 2);
    assert.ok(memory.tokenWeights.historico);
  });

  it('adota a memória guardada em chave de versão anterior (migração)', () => {
    const antiga = 'conversor_legado_ai_memory_v1';
    const treinada = analyzeFileLayout(statementFile, loadAiMemory());
    const memoria = trainAiWithLayout(statementFile, treinada, 'Extrato da versão antiga', loadAiMemory());
    localStorage.setItem(antiga, JSON.stringify(memoria));

    const adotada = loadAiMemory();
    assert.equal(adotada.learnedProfiles.length, 1);
    assert.equal(adotada.learnedProfiles[0].name, 'Extrato da versão antiga');
    // Regravada na chave atual, sem apagar a antiga (reserva).
    assert.ok(localStorage.getItem(STORAGE_KEY), 'gravou na chave atual');
    assert.ok(localStorage.getItem(antiga), 'manteve a chave antiga intacta');
    assert.equal(loadAiMemory().learnedProfiles.length, 1);
  });

  it('ignora chave antiga corrompida e continua procurando', () => {
    localStorage.setItem('outro_app_ai_memory_v3', '{quebrado');
    const memory = loadAiMemory();
    assert.equal(memory.learnedProfiles.length, 0);
    assert.equal(memory.version, 2);
  });

  it('sobrevive a conteúdo corrompido no localStorage', () => {
    localStorage.setItem(STORAGE_KEY, '{não é json');
    assert.equal(loadAiMemory().learnedProfiles.length, 0);

    localStorage.setItem(STORAGE_KEY, JSON.stringify({ learnedProfiles: 'x' }));
    const memory = loadAiMemory();
    assert.deepEqual(memory.learnedProfiles, []);
    assert.equal(memory.optionalLlm.provider, 'none');
  });

  it('salva e recarrega perfis', () => {
    let memory = loadAiMemory();
    const analysis = analyzeFileLayout(statementFile, memory);
    memory = trainAiWithLayout(statementFile, analysis, 'Extrato Banco', memory);

    assert.equal(saveAiMemory(memory), true);
    const reloaded = loadAiMemory();
    assert.equal(reloaded.learnedProfiles.length, 1);
    assert.equal(reloaded.learnedProfiles[0].name, 'Extrato Banco');
  });

  it('resetar volta ao padrão', () => {
    const memory = resetAiMemory();
    assert.equal(memory.learnedProfiles.length, 0);
    assert.equal(loadAiMemory().learnedProfiles.length, 0);
  });

  it('normaliza payloads importados e descarta lixo', () => {
    const memory = normalizeMemory({
      version: 1,
      tokenWeights: { historico: { history: 999 }, invalido: { role_x: 5 }, zzz: 'nao-objeto' },
      learnedProfiles: [
        { id: 'p1', name: 'Ok', fileType: 'pdf', mappings: [{ header: 'Data', role: 'date' }] },
        { id: 'p2', name: 'Ruim', mappings: [] },
        'lixo',
      ],
      learningLog: [{ message: 'evento' }],
      stats: { totalFilesProcessed: '3', autoMatchedCount: -1 },
      optionalLlm: { provider: 'hacker', apiKey: 42 },
    });

    assert.equal(memory.learnedProfiles.length, 1);
    assert.equal(memory.learnedProfiles[0].fileType, 'pdf');
    assert.equal(memory.tokenWeights.historico.history, 12); // limitado
    assert.equal(memory.tokenWeights.invalido, undefined);
    assert.equal(memory.stats.totalFilesProcessed, 3);
    assert.equal(memory.stats.autoMatchedCount, 0);
    assert.equal(memory.optionalLlm.provider, 'none');
    assert.equal(memory.optionalLlm.apiKey, '');
    assert.equal(memory.learningLog.length, 1);
  });

  it('não conta a mesma correção duas vezes', () => {
    let memory = loadAiMemory();
    const file = {
      fileName: 'c.xlsx',
      fileType: 'xlsx',
      headers: ['Data', 'Histórico', 'Valor'],
      rows: [
        ['01/01/2026', 'X', '10,00'],
        ['02/01/2026', 'Y', '20,00'],
      ],
      bannerLines: [],
    };

    const analysis = analyzeFileLayout(file, memory);
    const valueColumn = analysis.mappings.find((mapping) => mapping.role === ROLES.VALUE_AUTO);
    assert.ok(valueColumn);
    valueColumn.role = ROLES.VALUE_OUT; // correção manual do usuário

    memory = trainAiWithLayout(file, analysis, 'Corrigido', memory);
    assert.equal(memory.stats.correctionsLearned, 1);

    const secondAnalysis = analyzeFileLayout(file, memory);
    memory = trainAiWithLayout(file, secondAnalysis, 'Corrigido', memory);
    assert.equal(memory.stats.correctionsLearned, 1, 'treinar novamente não deve recontar ajustes');
  });

  it('atualiza o mesmo perfil em vez de criar duplicatas', () => {
    let memory = loadAiMemory();
    const file = {
      fileName: 'd.xlsx',
      fileType: 'xlsx',
      headers: ['Data', 'Histórico', 'Valor'],
      rows: [
        ['01/01/2026', 'X', '10,00'],
        ['02/01/2026', 'Y', '20,00'],
      ],
      bannerLines: [],
    };

    for (let round = 0; round < 3; round++) {
      const analysis = analyzeFileLayout(file, memory);
      memory = trainAiWithLayout(file, analysis, 'Perfil Único', memory);
    }

    assert.equal(memory.learnedProfiles.length, 1);
    assert.equal(memory.learnedProfiles[0].usageCount, 3);
    assert.ok(memory.learningLog.length >= 3);
  });

  it('preserva a ordem do histórico aprendida no perfil', () => {
    installFakeLocalStorage();
    let memory = loadAiMemory();

    const file = {
      fileName: 'ordem.xlsx',
      fileType: 'xlsx',
      headers: ['Data', 'Fornecedor', 'Centro de Custo', 'Valor'],
      rows: [
        ['01/01/2026', 'ACME', 'OBRA A', '10,00'],
        ['02/01/2026', 'BETA', 'OBRA B', '20,00'],
      ],
      bannerLines: [],
    };

    const analysis = analyzeFileLayout(file, memory);
    const centro = analysis.mappings.find((mapping) => mapping.header === 'Centro de Custo');
    const fornecedor = analysis.mappings.find((mapping) => mapping.header === 'Fornecedor');
    // Usuário inverte a ordem para "Centro de Custo | Fornecedor"
    centro.role = ROLES.HISTORY;
    centro.historyOrder = 1;
    fornecedor.role = ROLES.HISTORY;
    fornecedor.historyOrder = 2;

    memory = trainAiWithLayout(file, analysis, 'Ordem Customizada', memory);

    const relearned = analyzeFileLayout(file, memory);
    assert.equal(relearned.status, 'matched');
    assert.equal(relearned.mappings.find((m) => m.header === 'Centro de Custo').historyOrder, 1);
    assert.equal(relearned.mappings.find((m) => m.header === 'Fornecedor').historyOrder, 2);

    const { records } = transformRowsWithConfig(file, relearned);
    assert.equal(records[0].history, 'OBRA A ACME');
  });

  it('limita o crescimento dos pesos aprendidos', () => {
    let memory = loadAiMemory();
    const file = {
      fileName: 'w.xlsx',
      fileType: 'xlsx',
      headers: ['Data', 'Histórico', 'Valor'],
      rows: [
        ['01/01/2026', 'X', '10,00'],
        ['02/01/2026', 'Y', '20,00'],
      ],
      bannerLines: [],
    };

    for (let round = 0; round < 40; round++) {
      const analysis = analyzeFileLayout(file, memory);
      memory = trainAiWithLayout(file, analysis, 'Pesos', memory);
    }

    for (const roles of Object.values(memory.tokenWeights)) {
      for (const weight of Object.values(roles)) {
        assert.ok(weight <= 12, `peso ${weight} acima do limite`);
        assert.ok(weight >= 0, `peso ${weight} negativo`);
      }
    }
  });

  it('funciona sem localStorage disponível', () => {
    delete globalThis.localStorage;
    const memory = loadAiMemory();
    assert.equal(memory.learnedProfiles.length, 0);
    assert.equal(saveAiMemory(memory), false);
  });
});

describe('analyzeWithOptionalLlm', () => {
  it('exige configuração do provedor', async () => {
    await assert.rejects(
      () => analyzeWithOptionalLlm(statementFile, { provider: 'none', apiKey: '' }),
      /Nenhum provedor LLM externo configurado/
    );
    await assert.rejects(() => analyzeWithOptionalLlm(statementFile, null), /Nenhum provedor/);
  });
});
