import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  diffChartAccounts,
  finalizeQuestorAccounts,
  normalizeChartHistoryKey,
  parseQuestorChartLines,
  parseQuestorChartTable,
  reconcileWithChart,
  recordChartLearning,
  scoreChartCandidates,
  searchChartAccounts,
} from '../src/chart-of-accounts.js';
import {
  CHART_CACHE_KEY,
  loadChartCache,
  loadChartFromDb,
  mergeChartLearning,
  saveChartCache,
  saveChartLearningToDb,
  syncChartPlanToDb,
} from '../src/chart-sync.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeLine(y, cols) {
  return {
    page: 1,
    y,
    h: 8,
    items: cols.map(([str, x]) => ({ str, x, y, w: str.length * 4, h: 8 })),
  };
}

function buildSampleQuestorLines() {
  return [
    makeLine(758.9, [['2085 EMPRESA MODELO LTDA', 20.9], ['27/11/2026 10:00 Pág:0001', 497]]),
    makeLine(746.9, [['CNPJ: 12.345.678/0001-99', 20.9]]),
    makeLine(734.9, [['Plano de Contas Específico sem Saldo', 241.9]]),
    makeLine(710.9, [['Conta', 46.8], ['S', 75.3], ['Classificação', 88.2], ['Apelido Conta', 451.8]]),
    makeLine(687, [['1', 61.8], ['S', 75.3], ['1', 88.2], ['ATIVO', 102.2], ['ATIVO', 451.8]]),
    makeLine(675, [['2', 61.8], ['S', 75.3], ['1.1.02', 88.2], ['CLIENTES', 108.2]]),
    makeLine(663, [['101', 55], ['1.1.02.001', 88.2], ['CLIENTE EXEMPLO LTDA', 132.2], ['CLIENTE', 451.8]]),
    makeLine(651, [['200', 55], ['S', 75.3], ['2.1.03', 88.2], ['FORNECEDORES', 108.2]]),
    makeLine(639, [['201', 55], ['2.1.03.001', 88.2], ['FORNECEDOR EXEMPLO LTDA', 132.2], ['FORNEC', 451.8]]),
    makeLine(627, [['250', 55], ['2.1.09.001', 88.2], ['ADIANTAMENTOS DE CLIENTES', 132.2]]),
    makeLine(615, [['300', 55], ['S', 75.3], ['5.7', 88.2], ['DESPESAS OPERACIONAIS', 108.2]]),
    makeLine(603, [['4698', 50], ['5.7.03.005.001', 88.2], ['DESPESAS BANCARIAS', 146], ['TARIFA', 451.8]]),
    makeLine(591, [['4477', 50], ['5.7.01.002.010', 88.2], ['ENERGIA ELETRICA', 146], ['ENERGIA', 451.8]]),
    makeLine(579, [['4670', 50], ['5.7.03.009.001', 88.2], ['IOF S/ OPERACOES FINANCEIRAS', 146], ['IOF', 451.8]]),
    makeLine(567, [['400', 55], ['S', 75.3], ['4.1.05', 88.2], ['RECEITAS FINANCEIRAS', 108.2]]),
    makeLine(555, [['2859', 50], ['4.1.05.001.003', 88.2], ['RENDIMENTO DE APLICACOES FINANCEIRAS', 146], ['REND APL', 451.8]]),
    makeLine(543, [['2860', 50], ['4.1.05.001.001', 88.2], ['JUROS RECEBIDOS', 146], ['JUROS REC', 451.8]]),
    makeLine(531, [['4695', 50], ['5.7.03.002.001', 88.2], ['JUROS PASSIVOS', 146], ['JUROS PAG', 451.8]]),
    makeLine(519, [['1020', 50], ['1.1.09.001', 88.2], ['(-) PROVISAO PARA DEVEDORES DUVIDOSOS', 146]]),
  ];
}

describe('Plano de Contas Questor: parser e regras de exclusão', () => {
  it('extrai metadados da empresa, contas sintéticas/analíticas e exclui Clientes/Fornecedores', () => {
    const { plan, accounts } = parseQuestorChartLines(buildSampleQuestorLines(), { sourceFile: 'plano_teste.pdf' });

    assert.equal(plan.id, 'cnpj-12345678000199');
    assert.equal(plan.company_code, '2085');
    assert.equal(plan.company_name, 'EMPRESA MODELO LTDA');
    assert.equal(plan.cnpj, '12.345.678/0001-99');
    assert.equal(plan.total_accounts, 15);
    assert.equal(plan.excluded_counterparties, 2);
    assert.equal(plan.analytic_accounts, 8);

    const byConta = new Map(accounts.map((a) => [a.conta, a]));
    assert.equal(byConta.get('1')?.is_synthetic, true);
    assert.equal(byConta.get('101')?.is_counterparty, true);
    assert.equal(byConta.get('201')?.is_counterparty, true);
    assert.equal(byConta.get('250')?.is_counterparty, false);
    assert.equal(byConta.get('4698')?.is_counterparty, false);
    assert.match(byConta.get('4698')?.group_path || '', /DESPESAS OPERACIONAIS/);
  });

  it('reconhece classificações de Clientes/Fornecedores sem bloquear Adiantamentos', () => {
    const { accounts } = finalizeQuestorAccounts([
      { conta: '1', classification: '1.1.02.001', name: 'CLIENTE A', is_synthetic: false },
      { conta: '2', classification: '2.1.03.015', name: 'FORNECEDOR B', is_synthetic: false },
      { conta: '3', classification: '1.2.01.001.002', name: 'CLIENTE LP', is_synthetic: false },
      { conta: '4', classification: '2.2.01.011.001.001', name: 'FORNECEDOR LP', is_synthetic: false },
      { conta: '5', classification: '2.1.09.001', name: 'ADIANTAMENTOS DE CLIENTES', is_synthetic: false },
      { conta: '6', classification: '5.7.03.005', name: 'DESPESAS BANCARIAS', is_synthetic: false },
    ]);
    const byConta = new Map(accounts.map((a) => [a.conta, a.is_counterparty]));
    assert.equal(byConta.get('1'), true);
    assert.equal(byConta.get('2'), true);
    assert.equal(byConta.get('3'), true);
    assert.equal(byConta.get('4'), true);
    assert.equal(byConta.get('5'), false);
    assert.equal(byConta.get('6'), false);
  });

  it('também lê tabela XLSX com colunas Conta, S, Classificação, Descrição e Apelido', () => {
    const parsed = parseQuestorChartTable(
      ['Conta', 'S', 'Classificação', 'Descrição', 'Apelido Conta'],
      [
        ['1', 'S', '3.2.01', 'DESPESAS OPERACIONAIS', ''],
        ['4698', '', '3.2.01.003.005', 'DESPESAS BANCARIAS', 'TARIFA'],
        ['101', '', '1.1.02.001', 'CLIENTE A', ''],
      ],
      { companyName: 'Empresa Planilha', sourceFile: 'plano.xlsx' }
    );

    assert.equal(parsed.plan.analytic_accounts, 1);
    assert.equal(parsed.plan.excluded_counterparties, 1);
    assert.equal(parsed.accounts.find((a) => a.conta === '4698')?.alias, 'TARIFA');
  });
});

describe('Plano de Contas Questor: atualização incremental e busca', () => {
  it('calcula diff incremental (novas, alteradas, iguais e desativadas)', () => {
    const previous = finalizeQuestorAccounts([
      { conta: '4698', classification: '5.7.03.005', name: 'DESPESAS BANCARIAS', alias: 'TARIFA', is_synthetic: false },
      { conta: '4477', classification: '5.7.01.010', name: 'ENERGIA ELETRICA', alias: 'ENERGIA', is_synthetic: false },
      { conta: '9999', classification: '5.7.01.099', name: 'CONTA ANTIGA', alias: '', is_synthetic: false },
    ]).accounts;

    const next = finalizeQuestorAccounts([
      { conta: '4698', classification: '5.7.03.005', name: 'DESPESAS BANCARIAS', alias: 'TARIFA', is_synthetic: false },
      { conta: '4477', classification: '5.7.01.010', name: 'ENERGIA ELETRICA CEMIG', alias: 'ENERGIA', is_synthetic: false },
      { conta: '4670', classification: '5.7.03.009', name: 'IOF', alias: 'IOF', is_synthetic: false },
    ]).accounts;

    const diff = diffChartAccounts(previous, next);
    assert.equal(diff.inserted, 1);
    assert.equal(diff.updated, 1);
    assert.equal(diff.unchanged, 1);
    assert.equal(diff.deactivated, 1);
  });

  it('busca por código da conta, nome, apelido e classificação ignorando sintéticas e contatos', () => {
    const { accounts } = parseQuestorChartLines(buildSampleQuestorLines());

    const byCode = searchChartAccounts(accounts, '4698');
    assert.equal(byCode[0]?.conta, '4698');

    const byName = searchChartAccounts(accounts, 'energia');
    assert.equal(byName[0]?.conta, '4477');

    const excluded = searchChartAccounts(accounts, 'CLIENTE EXEMPLO');
    assert.equal(excluded.length, 0);
  });
});

describe('Plano de Contas Questor: conciliação por IA e aprendizado', () => {
  it('concilia lançamentos sem contato usando natureza da operação, palavra exata e memória', () => {
    const { accounts } = parseQuestorChartLines(buildSampleQuestorLines());
    const rows = [
      {
        id: 0,
        direction: 'payment',
        rawHistory: 'TARIFA BANCARIA DEBITO AUTOMATICO',
        history: 'TARIFA BANCARIA DEBITO AUTOMATICO',
        contact: null,
        status: 'unmatched',
        debitAccount: '',
        creditAccount: '',
      },
      {
        id: 1,
        direction: 'payment',
        rawHistory: 'DEB IOF OPERACAO FINANCEIRA',
        history: 'DEB IOF OPERACAO FINANCEIRA',
        contact: null,
        status: 'unmatched',
        debitAccount: '',
        creditAccount: '',
      },
      {
        id: 2,
        direction: 'receipt',
        rawHistory: 'RESGATE RENDIMENTO CDB',
        history: 'RESGATE RENDIMENTO CDB',
        contact: null,
        status: 'unmatched',
        debitAccount: '',
        creditAccount: '',
      },
      {
        id: 3,
        direction: 'payment',
        rawHistory: 'PAGAMENTO ENERGIA CEMIG',
        history: 'PAGAMENTO ENERGIA CEMIG',
        contact: { code: '201', name: 'FORNECEDOR EXEMPLO LTDA' },
        status: 'matched',
        debitAccount: '201',
        creditAccount: '',
      },
    ];

    const stats = reconcileWithChart(rows, accounts);
    assert.equal(rows[0].debitAccount, '4698');
    assert.equal(rows[1].debitAccount, '4670');
    assert.equal(rows[2].creditAccount, '2859');
    assert.equal(rows[3].debitAccount, '201');
    assert.equal(rows[3].chartMatch, undefined);
    assert.ok(stats.matchedCount >= 3);
  });

  it('grava aprendizado manual e passa a aplicar da memória nas próximas conciliações', () => {
    const { accounts } = parseQuestorChartLines(buildSampleQuestorLines());
    const rules = [];
    const tokens = [];

    recordChartLearning(
      { rules, tokens },
      {
        history: 'DEBITO AUTOMATICO CONCESSIONARIA X 01/2026',
        direction: 'payment',
        side: 'debit',
        conta: '4477',
        accountName: 'ENERGIA ELETRICA',
        source: 'manual',
      }
    );

    assert.equal(rules.length, 1);
    assert.ok(tokens.length > 0);
    assert.equal(
      normalizeChartHistoryKey('DEBITO AUTOMATICO CONCESSIONARIA X 01/2026'),
      normalizeChartHistoryKey('DEBITO AUTOMATICO CONCESSIONARIA X 02/2026')
    );

    const futureRows = [
      {
        id: 0,
        direction: 'payment',
        rawHistory: 'DEBITO AUTOMATICO CONCESSIONARIA X 02/2026',
        history: 'DEBITO AUTOMATICO CONCESSIONARIA X 02/2026',
        contact: null,
        status: 'unmatched',
        debitAccount: '',
        creditAccount: '',
      },
    ];

    const stats = reconcileWithChart(futureRows, accounts, { rules, tokens });
    assert.equal(futureRows[0].debitAccount, '4477');
    assert.equal(futureRows[0].chartMatch?.source, 'memory');
    assert.equal(stats.memoryCount, 1);
  });

  it('prefere receita no recebimento e despesa no pagamento para termos parecidos (ex: juros)', () => {
    const { accounts } = parseQuestorChartLines(buildSampleQuestorLines());
    const receipt = scoreChartCandidates('JUROS', 'receipt', accounts, { side: 'credit' });
    const payment = scoreChartCandidates('JUROS', 'payment', accounts, { side: 'debit' });

    assert.equal(receipt[0]?.account.conta, '2860');
    assert.equal(payment[0]?.account.conta, '4695');
  });
});

describe('Plano de Contas Questor: sync Supabase e cache local', () => {
  it('salva e carrega cache local sem duplicar aprendizados no merge', () => {
    const store = new Map();
    const storage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
    };

    saveChartCache(
      {
        plans: [{ id: 'p1', company_name: 'Empresa A' }],
        plan: { id: 'p1', company_name: 'Empresa A' },
        accounts: [{ conta: '4698', name: 'DESPESAS BANCARIAS' }],
        rules: [{ history_key: 'tarifa', direction: 'payment', side: 'debit', conta: '4698', updated_at: '2026-11-27T10:00:00Z' }],
        tokens: [{ token: 'tarifa', conta: '4698', direction: 'payment', weight: 1, hits: 1 }],
      },
      storage
    );

    assert.ok(store.has(CHART_CACHE_KEY));
    const loaded = loadChartCache(storage);
    assert.equal(loaded.accounts.length, 1);

    const merged = mergeChartLearning(loaded, {
      rules: [{ history_key: 'tarifa', direction: 'payment', side: 'debit', conta: '4698', updated_at: '2026-11-27T12:00:00Z' }],
      tokens: [{ token: 'tarifa', conta: '4698', direction: 'payment', weight: 3, hits: 2 }],
    });
    assert.equal(merged.rules.length, 1);
    assert.equal(merged.tokens.length, 1);
    assert.equal(merged.tokens[0].hits, 2);
  });

  it('chama as RPCs do Supabase com os payloads esperados', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, plans: [], plan: null, accounts: [], rules: [], tokens: [] }),
      };
    };

    const config = {
      url: 'https://exemplo.supabase.co',
      anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.signature',
    };
    await loadChartFromDb(config, { planId: 'p1', fetchImpl });
    await syncChartPlanToDb(config, { plan: { id: 'p1' }, accounts: [{ conta: '4698' }], fetchImpl });
    await saveChartLearningToDb(config, { planId: 'p1', rules: [{ history_key: 'tarifa' }], tokens: [], fetchImpl });

    assert.equal(calls.length, 3);
    assert.match(calls[0].url, /\/rest\/v1\/rpc\/conversor_chart_load$/);
    assert.equal(calls[0].body.p_plan_id, 'p1');
    assert.match(calls[1].url, /\/rest\/v1\/rpc\/conversor_chart_sync_plan$/);
    assert.equal(calls[1].body.p_accounts.length, 1);
    assert.match(calls[2].url, /\/rest\/v1\/rpc\/conversor_chart_learn_batch$/);
    assert.equal(calls[2].body.p_plan_id, 'p1');
  });
});

describe('Contrato de UI e SQL do Plano de Contas no Conciliador', () => {
  it('expõe o cartão do Plano de Contas, filtro, painel e autocomplete sem quebrar contratos antigos', async () => {
    const html = await readFile(path.join(ROOT, 'conciliador.html'), 'utf8');
    const js = await readFile(path.join(ROOT, 'src/counterparty-page.js'), 'utf8');
    const css = await readFile(path.join(ROOT, 'src/styles.css'), 'utf8');
    const migration = await readFile(path.join(ROOT, 'supabase/migrations/20261127192353_conversor_chart_of_accounts.sql'), 'utf8');

    for (const id of [
      'cp-chart-card',
      'cp-chart-plan-select',
      'cp-chart-input',
      'btn-cp-chart-update',
      'cp-chart-status',
      'cp-use-chart-ai',
      'cp-link-chart-box',
      'cp-link-chart-search',
      'cp-link-chart-candidates',
      'cp-chart-autocomplete',
    ]) {
      assert.ok(html.includes(`id="${id}"`), `falta #${id} em conciliador.html`);
    }

    assert.match(html, /data-cp-filter="chart"/);
    assert.match(html, /PASSO 1 • PLANO DE CONTAS/);
    assert.match(html, /PASSO 2 • ARQUIVOS/);
    assert.match(html, /PASSO 3 • RESULTADO/);
    assert.ok(
      html.indexOf('id="cp-chart-card"') < html.indexOf('id="cp-contacts-input"') &&
        html.indexOf('id="cp-contacts-input"') < html.indexOf('id="cp-result"'),
      'Plano de Contas deve aparecer como primeira etapa antes dos arquivos e do resultado'
    );
    assert.match(js, /reconcileWithChart/);
    assert.match(js, /initChartFromDatabase/);
    assert.match(js, /uploadAndSyncChart/);
    assert.match(css, /\.cp-chart-autocomplete\b/);
    assert.match(migration, /conversor_chart_sync_plan/);
    assert.match(migration, /conversor_chart_learn_batch/);
    assert.match(migration, /conversor_chart_load/);
  });
});
