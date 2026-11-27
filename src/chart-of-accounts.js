/**
 * Conversor — Plano de Contas Questor & Conciliação Inteligente por I.A.
 *
 * Lê o relatório "Plano de Contas Específico sem Saldo" exportado do Questor
 * (PDF ou .xlsx), identifica contas sintéticas (`S`), constrói a árvore de
 * classificação, exclui Clientes (`1.1.02`) e Fornecedores (`2.1.03` /
 * `2.2.01.011.001`) da conciliação automática (já tratados na planilha à parte),
 * concilia os demais lançamentos pela coluna `Conta` usando I.A. híbrida
 * (regras aprendidas + afinidade de tokens + ontologia contábil PT-BR +
 * semelhança lexical + compatibilidade de natureza) e calcula diffs incrementais
 * para o botão "Atualizar banco de dados".
 *
 * Módulo puro, sem DOM nem `localStorage`, totalmente testável no Node.
 */

import { cleanWhitespace, extractPdfLines, normalizeText } from './parsers.js';

/* -------------------------------------------------------------------------- */
/*                                 Constantes                                 */
/* -------------------------------------------------------------------------- */

const CHART_MATCH_THRESHOLD = 0.62;
const CHART_SUGGEST_THRESHOLD = 0.42;
const CHART_AMBIGUITY_MARGIN = 0.05;

const STOP_WORDS = new Set([
  'a', 'ao', 'aos', 'as', 'com', 'como', 'da', 'das', 'de', 'do', 'dos',
  'e', 'em', 'na', 'nas', 'no', 'nos', 'o', 'os', 'ou', 'para', 'pela',
  'pelo', 'por', 'sem', 'sob', 'sobre', 'um', 'uma',
  'pag', 'pagto', 'pgto', 'pagamento', 'rec', 'recbto', 'recebimento',
  'deb', 'debito', 'cred', 'credito', 'mov', 'movimento', 'lanc', 'lancamento',
  'doc', 'docto', 'documento', 'nr', 'nro', 'num', 'numero', 'cod', 'codigo',
  'ref', 'referente', 'aut', 'autenticacao', 'nsu', 'ag', 'agencia', 'cta',
  'conta', 'valor', 'vlr', 'data', 'dt', 'sa', 's', 'ltda', 'me', 'epp', 'eireli',
]);

/** Prefixos de Clientes e Fornecedores excluídos da conciliação pelo Plano. */
const COUNTERPARTY_CLASS_PREFIXES = [
  '1.1.02',
  '1.2.01.001',
  '2.1.03',
  '2.2.01.011.001',
];

const COUNTERPARTY_GROUP_NAMES = new Set([
  'clientes',
  'fornecedores',
  'fornecedores nacionais',
  'fornecedores estrangeiros',
  'duplicatas a receber',
]);

/**
 * Ontologia financeira PT-BR: termos comuns em extratos bancários brasileiros
 * expandidos para conceitos do Plano de Contas contábil (Questor).
 */
const FINANCIAL_ONTOLOGY = [
  {
    triggers: ['tarifa', 'tar', 'cesta', 'pacote', 'manutencao', 'anuidade', 'mensalidade', 'extrato', 'ted', 'doc', 'boleto', 'cobranca', 'custodia', 'emissao'],
    concepts: ['despesas bancarias', 'bancarias diversas', 'tarifas bancarias', 'despesas financeiras'],
  },
  {
    triggers: ['iof', 'ioc'],
    concepts: ['iof', 'ioc', 'impostos e taxas'],
  },
  {
    triggers: ['juros', 'mora', 'encargos', 'rotativo', 'cheque especial'],
    concepts: ['juros', 'encargos', 'despesas financeiras', 'juros recebidos', 'juros pagos'],
  },
  {
    triggers: ['multa', 'infracao', 'atraso'],
    concepts: ['multas', 'multa', 'dedutiveis'],
  },
  {
    triggers: ['rendimento', 'rend', 'cdb', 'lci', 'lca', 'poupanca', 'fundo', 'aplicacao', 'aplic', 'resgate', 'investimento'],
    concepts: ['aplicacoes financeiras', 'receitas de aplicacoes', 'liquidez imediata', 'juros de aplicacoes'],
  },
  {
    triggers: ['fgts', 'grf', 'crf', 'secip'],
    concepts: ['fgts', 'obrigacoes trabalhistas'],
  },
  {
    triggers: ['inss', 'gps', 'previdencia', 'darf previdenciario'],
    concepts: ['inss', 'obrigacoes previdenciarias', 'inss retido'],
  },
  {
    triggers: ['darf', 'irrf', 'irpj', 'csll', 'pis', 'cofins', 'simples', 'das', 'receita federal'],
    concepts: ['impostos federais', 'irpj', 'csll', 'pis', 'cofins', 'simples', 'impostos e contribuicoes a recolher'],
  },
  {
    triggers: ['iss', 'issqn', 'prefeitura', 'iptu', 'alvara', 'tff'],
    concepts: ['iss', 'iptu', 'impostos municipais', 'taxas publicas'],
  },
  {
    triggers: ['icms', 'ipva', 'detran', 'sefaz', 'dare', 'gnre', 'licenciamento', 'dpvat'],
    concepts: ['icms', 'ipva', 'impostos estaduais'],
  },
  {
    triggers: ['energia', 'luz', 'eletric', 'cemig', 'enel', 'light', 'cpfl', 'copel', 'celesc', 'coelba', 'equatorial', 'elektro', 'energisa'],
    concepts: ['energia eletrica', 'utilidades'],
  },
  {
    triggers: ['agua', 'esgoto', 'saneamento', 'sabesp', 'cedae', 'copasa', 'sanepar', 'embasa', 'cagece'],
    concepts: ['agua e esgoto', 'saneamento'],
  },
  {
    triggers: ['telefone', 'celular', 'telecom', 'vivo', 'claro', 'tim', 'oi', 'embratel', 'nextel'],
    concepts: ['telecomunicacoes', 'telefone'],
  },
  {
    triggers: ['internet', 'fibra', 'banda larga', 'provedor'],
    concepts: ['internet', 'telecomunicacoes'],
  },
  {
    triggers: ['aluguel', 'locacao', 'condominio', 'imobiliaria'],
    concepts: ['alugueis', 'ocupacao', 'locacao'],
  },
  {
    triggers: ['salario', 'salarios', 'folha', 'holerite', 'ordenado', 'ordenados', 'adiantamento salarial'],
    concepts: ['salarios e ordenados', 'obrigacoes com o pessoal'],
  },
  {
    triggers: ['prolabore', 'pro labore', 'socio'],
    concepts: ['pro labore'],
  },
  {
    triggers: ['ferias'],
    concepts: ['ferias'],
  },
  {
    triggers: ['decimo', '13o', '13'],
    concepts: ['13 salario', 'gratificacoes natalinas'],
  },
  {
    triggers: ['combustivel', 'gasolina', 'diesel', 'etanol', 'posto', 'abastecimento'],
    concepts: ['combustiveis', 'despesas com veiculos'],
  },
  {
    triggers: ['pedagio', 'sem parar', 'veloe', 'conectcar', 'move mais'],
    concepts: ['pedagio'],
  },
  {
    triggers: ['estacionamento', 'estapar'],
    concepts: ['estacionamentos'],
  },
  {
    triggers: ['frete', 'carreto', 'transportadora', 'correios', 'sedex', 'pac', 'loggi', 'motoboy'],
    concepts: ['fretes e carretos', 'correios', 'entregas'],
  },
  {
    triggers: ['cartorio', 'tabelionato', 'protesto', 'certidao', 'registro'],
    concepts: ['cartorio', 'cartoriais'],
  },
  {
    triggers: ['contabil', 'contabilidade', 'contador', 'escritorio contabil'],
    concepts: ['honorarios contabeis'],
  },
  {
    triggers: ['advocatic', 'advogado', 'juridic', 'oab'],
    concepts: ['honorarios advocaticios', 'legais e judiciais'],
  },
  {
    triggers: ['software', 'sistema', 'licenca', 'nuvem', 'cloud', 'saas', 'microsoft', 'google', 'adobe', 'aws', 'questor', 'totvs'],
    concepts: ['informatica e softwares'],
  },
  {
    triggers: ['cartao', 'fatura', 'maquininha', 'cielo', 'rede', 'stone', 'getnet', 'pagseguro', 'mercadopago'],
    concepts: ['cartao de credito', 'encargos de cartao'],
  },
  {
    triggers: ['seguro', 'apolice', 'sinistro', 'porto seguro', 'tokio', 'allianz', 'bradesco seguros'],
    concepts: ['seguros', 'seguros de bens'],
  },
  {
    triggers: ['refeicao', 'alimentacao', 'restaurante', 'lanche', 'ifood', 'padaria', 'mercado', 'supermercado'],
    concepts: ['lanches refeicoes copa e cozinha', 'alimentacao'],
  },
  {
    triggers: ['farmacia', 'drogaria', 'medicamento'],
    concepts: ['despesas com farmacia'],
  },
  {
    triggers: ['desconto', 'descontos'],
    concepts: ['descontos obtidos', 'descontos concedidos'],
  },
  {
    triggers: ['estorno', 'devolucao', 'reembolso', 'recuperacao'],
    concepts: ['recuperacao de despesas', 'outras receitas'],
  },
];

/* -------------------------------------------------------------------------- */
/*                           Normalização e tokens                            */
/* -------------------------------------------------------------------------- */

export function normalizeAccountCode(value) {
  return String(value ?? '').replace(/[^\dA-Za-z]+/g, '').trim();
}

export function normalizeChartKey(value) {
  return normalizeText(value)
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stemToken(token) {
  let t = String(token || '');
  if (t.length <= 4) return t;
  if (t.endsWith('oes')) return `${t.slice(0, -3)}ao`;
  if (t.endsWith('aes')) return `${t.slice(0, -3)}ao`;
  if (t.endsWith('is') && t.length > 4) return `${t.slice(0, -2)}l`;
  if (t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
  if (t.length > 5 && (t.endsWith('amento') || t.endsWith('imentos'))) {
    t = t.slice(0, -5);
  }
  return t;
}

/**
 * Tokens significativos de um texto (sem conectivos, sem ruído bancário nem
 * números longos de documento/NSU).
 */
export function chartTokens(value) {
  return normalizeChartKey(value)
    .split(' ')
    .filter((token) => {
      if (!token || token.length < 2) return false;
      if (STOP_WORDS.has(token)) return false;
      if (/^\d+$/.test(token) && token !== '13') return false;
      return true;
    });
}

/**
 * Chave normalizada do histórico de um lançamento para memorizar regras da IA.
 * Remove datas, CPF/CNPJ e sequências numéricas longas mantendo os termos que
 * identificam a natureza do lançamento.
 */
export function normalizeChartHistoryKey(history) {
  const cleaned = cleanWhitespace(history)
    .replace(/\b\d{2}[./-]\d{2}(?:[./-]\d{2,4})?\b/g, ' ')
    .replace(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g, ' ')
    .replace(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, ' ')
    .replace(/\b\d{4,}\b/g, ' ');
  const tokens = chartTokens(cleaned).slice(0, 8);
  if (tokens.length > 0) return tokens.join(' ').slice(0, 120);
  return normalizeChartKey(cleaned).slice(0, 120);
}

/** Remove possíveis CPF/CNPJ/e-mail antes de guardar exemplo no banco. */
export function scrubSampleHistory(history) {
  return cleanWhitespace(history)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED]')
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[REDACTED]')
    .replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, '[REDACTED]')
    .slice(0, 180);
}

/* -------------------------------------------------------------------------- */
/*                     Parser do Plano de Contas Questor                      */
/* -------------------------------------------------------------------------- */

function deriveNature(classification) {
  const top = String(classification || '').split('.')[0];
  if (top === '1') return 'ativo';
  if (top === '2' || top === '3') return 'passivo';
  if (top === '4') return 'receita';
  if (top === '5' || top === '9') return 'despesa';
  if (top === '6' || top === '7') return 'resultado';
  return 'outros';
}

function slugifyPlanId(text) {
  return normalizeChartKey(text)
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]+/g, '')
    .slice(0, 48);
}

function detectColumnsFromHeader(items) {
  const text = items.map((item) => normalizeChartKey(item.str)).join(' ');
  if (!text.includes('conta') || !text.includes('classificacao')) return null;

  const contaItem = items.find((i) => normalizeChartKey(i.str) === 'conta');
  const sItem = items.find((i) => normalizeChartKey(i.str) === 's');
  const classItem = items.find((i) => normalizeChartKey(i.str).startsWith('classific'));
  const aliasItem = items.find((i) => normalizeChartKey(i.str).includes('apelido'));

  return {
    contaMaxX: sItem ? sItem.x - 2 : contaItem ? contaItem.x + 28 : 72,
    sMinX: sItem ? sItem.x - 5 : 68,
    sMaxX: classItem ? classItem.x - 2 : 84,
    classMinX: classItem ? classItem.x - 6 : 80,
    classMaxX: classItem ? classItem.x + 65 : 150,
    aliasMinX: aliasItem ? aliasItem.x - 16 : 430,
  };
}

function parseMetaFromLines(lines) {
  let companyCode = '';
  let companyName = '';
  let cnpj = '';
  let isQuestorReport = false;

  for (const line of lines.slice(0, 40)) {
    const joined = cleanWhitespace(line.items.map((i) => i.str).join(' '));
    const norm = normalizeText(joined);
    if (norm.includes('plano de contas especifico')) isQuestorReport = true;
    if (norm.includes('conta') && norm.includes('classificacao')) isQuestorReport = true;

    if (!cnpj) {
      const cnpjMatch = /cnpj:\s*(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})/i.exec(joined);
      if (cnpjMatch) cnpj = cnpjMatch[1];
    }

    if (!companyName && !norm.includes('cnpj:') && !norm.includes('plano de contas')) {
      const leftText = cleanWhitespace(
        line.items
          .filter((i) => i.x < 420 && !/^p[aá]g:/i.test(i.str.trim()) && !/^\d{2}\/\d{2}\/\d{4}/.test(i.str.trim()))
          .map((i) => i.str)
          .join(' ')
      );
      const companyMatch = /^(\d{1,8})\s+([A-ZÀ-ÿ0-9][A-ZÀ-ÿ0-9 .,&/-]{4,})$/.exec(leftText);
      if (companyMatch && !/^(conta|classificacao)/i.test(normalizeText(leftText))) {
        companyCode = companyMatch[1];
        companyName = cleanWhitespace(companyMatch[2]);
      }
    }
  }

  const cnpjDigits = cnpj.replace(/\D+/g, '');
  const id = cnpjDigits
    ? `cnpj-${cnpjDigits}`
    : companyName
      ? `empresa-${slugifyPlanId(companyName)}`
      : 'questor-default';

  return {
    id,
    company_code: companyCode,
    company_name: companyName || 'Plano de Contas Questor',
    cnpj,
    isQuestorReport,
  };
}

/**
 * Enriquece as contas brutas com `group_path`, `is_counterparty` e `nature`.
 */
export function finalizeQuestorAccounts(rawAccounts, meta = {}) {
  const byClassification = new Map();
  for (const row of rawAccounts || []) {
    if (row.is_synthetic && row.classification && !byClassification.has(row.classification)) {
      byClassification.set(row.classification, row.name);
    }
  }

  const counterpartyPrefixes = new Set(COUNTERPARTY_CLASS_PREFIXES);
  for (const row of rawAccounts || []) {
    if (!row.is_synthetic) continue;
    const parts = String(row.classification || '').split('.');
    if (parts.length >= 3 && COUNTERPARTY_GROUP_NAMES.has(normalizeChartKey(row.name))) {
      counterpartyPrefixes.add(row.classification);
    }
  }

  const deduped = new Map();
  for (const raw of rawAccounts || []) {
    const conta = String(raw.conta ?? '').trim();
    const classification = String(raw.classification ?? '').trim();
    const name = cleanWhitespace(raw.name);
    if (!conta || !name) continue;

    const parts = classification ? classification.split('.') : [];
    const ancestors = [];
    for (let depth = 1; depth < parts.length; depth += 1) {
      const prefix = parts.slice(0, depth).join('.');
      const ancestorName = byClassification.get(prefix);
      if (ancestorName) ancestors.push(ancestorName);
    }

    const isCounterparty = [...counterpartyPrefixes].some(
      (prefix) => classification === prefix || classification.startsWith(`${prefix}.`)
    );

    const account = {
      conta,
      classification,
      name,
      alias: cleanWhitespace(raw.alias || ''),
      group_path: ancestors.join(' > '),
      is_synthetic: Boolean(raw.is_synthetic),
      is_counterparty: isCounterparty,
      nature: deriveNature(classification),
    };

    deduped.set(conta, account);
  }

  const accounts = [...deduped.values()].sort((a, b) =>
    a.classification.localeCompare(b.classification, 'pt-BR', { numeric: true }) ||
    a.conta.localeCompare(b.conta, 'pt-BR', { numeric: true })
  );

  const analytic = accounts.filter((a) => !a.is_synthetic && !a.is_counterparty).length;
  const excluded = accounts.filter((a) => !a.is_synthetic && a.is_counterparty).length;

  return {
    plan: {
      id: meta.id || 'questor-default',
      company_code: meta.company_code || '',
      company_name: meta.company_name || 'Plano de Contas Questor',
      cnpj: meta.cnpj || '',
      source_file: meta.source_file || '',
      total_accounts: accounts.length,
      analytic_accounts: analytic,
      excluded_counterparties: excluded,
    },
    accounts,
  };
}

/**
 * Interpreta as linhas extraídas de um PDF "Plano de Contas Específico sem Saldo" do Questor.
 */
export function parseQuestorChartLines(lines, options = {}) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error('O PDF do Plano de Contas está vazio.');
  }

  const meta = parseMetaFromLines(lines);
  let columns = {
    contaMaxX: 72,
    sMinX: 68,
    sMaxX: 84,
    classMinX: 80,
    classMaxX: 150,
    aliasMinX: 430,
  };

  const rawAccounts = [];
  for (const line of lines) {
    const items = [...(line.items || [])].sort((a, b) => a.x - b.x);
    if (items.length === 0) continue;

    const detected = detectColumnsFromHeader(items);
    if (detected) {
      columns = detected;
      continue;
    }

    const joined = cleanWhitespace(items.map((i) => i.str).join(' '));
    if (/^_+$/.test(joined.replace(/\s+/g, ''))) continue;

    const contaItem = items.find((i) => i.x <= columns.contaMaxX && /^\d+$/.test(i.str.trim()));
    if (!contaItem) continue;

    const sItem = items.find(
      (i) => i !== contaItem && i.x >= columns.sMinX && i.x <= columns.sMaxX && i.str.trim() === 'S'
    );

    const classItem = items.find(
      (i) =>
        i !== contaItem &&
        i !== sItem &&
        i.x >= columns.classMinX &&
        i.x <= columns.classMaxX &&
        /^\d+(?:\.\d+)*$/.test(i.str.trim())
    );
    if (!classItem) continue;

    const nameItems = items.filter(
      (i) => i !== contaItem && i !== sItem && i !== classItem && i.x > classItem.x && i.x < columns.aliasMinX
    );
    const aliasItems = items.filter(
      (i) => i !== contaItem && i !== sItem && i !== classItem && i.x >= columns.aliasMinX
    );

    const name = cleanWhitespace(nameItems.map((i) => i.str).join(' '));
    if (!name) continue;

    rawAccounts.push({
      conta: contaItem.str.trim(),
      is_synthetic: Boolean(sItem),
      classification: classItem.str.trim(),
      name,
      alias: cleanWhitespace(aliasItems.map((i) => i.str).join(' ')),
    });
  }

  if (rawAccounts.length === 0) {
    throw new Error(
      'Nenhuma conta contábil foi reconhecida neste PDF. Confira se é o relatório "Plano de Contas Específico sem Saldo" do Questor (colunas Conta, S, Classificação, Descrição e Apelido Conta).'
    );
  }

  return finalizeQuestorAccounts(rawAccounts, {
    ...meta,
    source_file: options.sourceFile || '',
  });
}

/**
 * Lê um arquivo PDF do Plano de Contas do Questor no navegador (ou Node com pdfjsLib).
 */
export async function parseQuestorChartPdf(arrayBuffer, fileName, pdfjsLib, options = {}) {
  const { lines } = await extractPdfLines(arrayBuffer, pdfjsLib, options);
  return parseQuestorChartLines(lines, { sourceFile: fileName });
}

/**
 * Interpreta uma tabela (.xlsx) com o Plano de Contas do Questor.
 */
export function parseQuestorChartTable(headers, rows, options = {}) {
  const normHeaders = (headers || []).map((h) => normalizeChartKey(h));
  const findCol = (candidates) =>
    normHeaders.findIndex((h) => candidates.some((c) => h === c || h.startsWith(`${c} `)));

  const iConta = findCol(['conta', 'cod conta', 'codigo']);
  const iSyn = findCol(['s', 'sintetica', 'tipo']);
  const iClass = findCol(['classificacao', 'classific']);
  const iName = findCol(['descricao', 'nome', 'nome da conta', 'conta contabil', 'titulo']);
  const iAlias = findCol(['apelido', 'apelido conta']);

  if (iConta < 0 || iName < 0) {
    throw new Error(
      'Planilha sem as colunas esperadas do Plano de Contas (Conta e Descrição/Nome).'
    );
  }

  const rawAccounts = [];
  for (const row of rows || []) {
    const conta = String(row[iConta] ?? '').trim();
    const name = cleanWhitespace(row[iName] ?? '');
    if (!conta || !name || !/\d/.test(conta)) continue;

    const synVal = iSyn >= 0 ? normalizeChartKey(row[iSyn]) : '';
    const isSynthetic = synVal === 's' || synVal === 'sintetica' || synVal === 'sim';

    rawAccounts.push({
      conta,
      is_synthetic: isSynthetic,
      classification: iClass >= 0 ? String(row[iClass] ?? '').trim() : '',
      name,
      alias: iAlias >= 0 ? cleanWhitespace(row[iAlias] ?? '') : '',
    });
  }

  if (rawAccounts.length === 0) {
    throw new Error('Nenhuma conta encontrada na planilha do Plano de Contas.');
  }

  const companyName = options.companyName || String(options.sourceFile || 'Plano de Contas Questor').replace(/\.[^.]+$/, '');
  return finalizeQuestorAccounts(rawAccounts, {
    id: options.planId || `empresa-${slugifyPlanId(companyName) || 'questor'}`,
    company_name: companyName,
    source_file: options.sourceFile || '',
  });
}

/* -------------------------------------------------------------------------- */
/*                     Diff incremental (atualizar banco)                     */
/* -------------------------------------------------------------------------- */

/**
 * Calcula exatamente o que muda ao subir um novo relatório do Plano de Contas
 * sobre o que já estava salvo.
 */
export function diffChartAccounts(existingAccounts = [], incomingAccounts = []) {
  const existingMap = new Map();
  for (const acc of existingAccounts || []) {
    if (acc?.conta) existingMap.set(String(acc.conta), acc);
  }

  const incomingSet = new Set();
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  for (const inc of incomingAccounts || []) {
    const conta = String(inc?.conta || '');
    if (!conta) continue;
    incomingSet.add(conta);

    const prev = existingMap.get(conta);
    if (!prev) {
      inserted += 1;
    } else if (
      prev.active === false ||
      prev.classification !== inc.classification ||
      prev.name !== inc.name ||
      (prev.alias || '') !== (inc.alias || '') ||
      (prev.group_path || '') !== (inc.group_path || '') ||
      Boolean(prev.is_synthetic) !== Boolean(inc.is_synthetic) ||
      Boolean(prev.is_counterparty) !== Boolean(inc.is_counterparty) ||
      (prev.nature || '') !== (inc.nature || '')
    ) {
      updated += 1;
    } else {
      unchanged += 1;
    }
  }

  let deactivated = 0;
  for (const prev of existingAccounts || []) {
    if (prev?.active !== false && prev?.conta && !incomingSet.has(String(prev.conta))) {
      deactivated += 1;
    }
  }

  return { inserted, updated, unchanged, deactivated };
}

/* -------------------------------------------------------------------------- */
/*                      Motor de I.A. & Aprendizado                           */
/* -------------------------------------------------------------------------- */

function buildRuleMap(rules = []) {
  const map = new Map();
  for (const r of rules || []) {
    const key = normalizeChartKey(r.history_key || r.historyKey || '');
    const conta = String(r.conta || '').trim();
    if (!key || !conta) continue;
    const direction = r.direction || 'any';
    const side = r.side === 'credit' ? 'credit' : 'debit';
    map.set(`${key}|${direction}|${side}`, {
      history_key: key,
      direction,
      side,
      conta,
      account_name: r.account_name || '',
      hits: Math.max(1, Number(r.hits) || 1),
      confidence: Number(r.confidence) || 0.85,
      source: r.source || 'manual',
    });
  }
  return map;
}

function buildTokenAffinityMap(tokens = []) {
  // token|direction -> Map<conta, weight>
  const map = new Map();
  for (const t of tokens || []) {
    const token = normalizeChartKey(t.token);
    const conta = String(t.conta || '').trim();
    const weight = Number(t.weight) || 0;
    if (!token || !conta || weight <= 0) continue;
    const dir = t.direction || 'any';
    const key = `${token}|${dir}`;
    if (!map.has(key)) map.set(key, new Map());
    const bucket = map.get(key);
    bucket.set(conta, (bucket.get(conta) || 0) + weight);
  }
  return map;
}

function expandOntologyTokens(rawTokens) {
  const tokenSet = new Set(rawTokens);
  const joined = ` ${rawTokens.join(' ')} `;
  const expanded = new Set();

  for (const entry of FINANCIAL_ONTOLOGY) {
    const matched = entry.triggers.some((trigger) => {
      if (trigger.includes(' ')) return joined.includes(` ${trigger} `);
      return tokenSet.has(trigger) || rawTokens.some((t) => t.startsWith(trigger));
    });
    if (!matched) continue;
    for (const concept of entry.concepts) {
      for (const tok of chartTokens(concept)) {
        expanded.add(tok);
      }
    }
  }
  return expanded;
}

function indexChartAccounts(accounts = []) {
  const activePool = [];
  const byConta = new Map();

  for (const acc of accounts || []) {
    if (!acc || acc.active === false) continue;
    byConta.set(String(acc.conta), acc);
    if (acc.is_synthetic || acc.is_counterparty) continue;

    const nameNorm = normalizeChartKey(acc.name);
    const nameTokens = chartTokens(acc.name);
    const groupTokens = chartTokens(acc.group_path);
    const aliasNorm = normalizeChartKey(acc.alias);

    activePool.push({
      account: acc,
      nameNorm,
      nameTokens,
      nameStems: nameTokens.map(stemToken),
      groupTokens,
      groupStems: groupTokens.map(stemToken),
      aliasNorm,
    });
  }

  return { activePool, byConta };
}

function natureAdjustment(account, direction, historyNorm) {
  const cls = String(account.classification || '');
  const nature = account.nature || deriveNature(cls);
  const isRefund = /\b(estorno|devolucao|reembolso|recuperacao)\b/.test(historyNorm);
  const isContra = String(account.name || '').trim().startsWith('(-)');
  const contraPenalty = isContra ? -0.14 : 0;

  if (direction === 'payment') {
    if (nature === 'despesa') {
      if (cls.startsWith('5.7.03.')) return 0.16 + contraPenalty;
      if (cls.startsWith('5.7.11.') || cls.startsWith('5.7.09.')) return 0.14 + contraPenalty;
      if (cls.startsWith('5.7.01.')) return 0.11 + contraPenalty;
      if (cls.startsWith('5.5.')) return 0.08 + contraPenalty;
      return 0.05 + contraPenalty;
    }
    if (cls.startsWith('2.1.05.') || cls.startsWith('2.1.07.') || cls.startsWith('2.1.01.')) {
      return 0.10 + contraPenalty;
    }
    if (cls.startsWith('1.1.06.') || cls.startsWith('1.1.01.')) return 0.04 + contraPenalty;
    if (nature === 'receita' && !isRefund) return -0.35;
    return contraPenalty;
  }

  if (direction === 'receipt') {
    if (nature === 'receita') {
      if (cls.startsWith('4.1.05.001.') || cls.startsWith('4.1.01.')) return 0.14 + contraPenalty;
      return 0.09 + contraPenalty;
    }
    if (cls.startsWith('1.1.06.') || cls.startsWith('1.1.01.')) return 0.06 + contraPenalty;
    if (nature === 'despesa' && !isRefund) return -0.35;
    return contraPenalty;
  }

  return contraPenalty;
}

function lookupRule(ruleMap, historyKey, direction, side) {
  if (!historyKey) return null;
  return (
    ruleMap.get(`${historyKey}|${direction}|${side}`) ||
    ruleMap.get(`${historyKey}|any|${side}`) ||
    null
  );
}

/**
 * Pontua todas as contas elegíveis do Plano de Contas para um histórico.
 * Retorna os melhores candidatos ordenados por relevância (0..0.99).
 */
export function scoreChartCandidates(history, direction, accounts, options = {}) {
  const side = options.side || (direction === 'receipt' ? 'credit' : 'debit');
  const index = options.index || indexChartAccounts(accounts);
  const ruleMap = options.ruleMap || buildRuleMap(options.rules);
  const tokenMap = options.tokenMap || buildTokenAffinityMap(options.tokens);
  const limit = Number(options.limit) || 8;

  const historyNorm = normalizeChartKey(history);
  const historyKey = normalizeChartHistoryKey(history);
  const rawTokens = chartTokens(history);
  const historySet = new Set(rawTokens);
  const historyStems = new Set(rawTokens.map(stemToken));
  const ontologyTokens = expandOntologyTokens(rawTokens);
  const ontologyStems = new Set([...ontologyTokens].map(stemToken));

  const learnedRule = lookupRule(ruleMap, historyKey, direction, side);

  // Afinidade agregada pelos tokens aprendidos no banco
  const tokenAffinity = new Map();
  for (const token of rawTokens) {
    for (const dir of [direction, 'any']) {
      const bucket = tokenMap.get(`${token}|${dir}`);
      if (!bucket) continue;
      for (const [conta, weight] of bucket.entries()) {
        tokenAffinity.set(conta, (tokenAffinity.get(conta) || 0) + weight * (dir === direction ? 1 : 0.7));
      }
    }
  }

  const scored = [];
  for (const item of index.activePool) {
    const acc = item.account;
    let score = 0;
    const reasons = [];

    // 1. Regra aprendida exata (memória da IA)
    if (learnedRule && learnedRule.conta === acc.conta) {
      score = Math.min(0.99, 0.90 + Math.min(0.08, learnedRule.hits * 0.015));
      reasons.push(`aprendida pela I.A. (${learnedRule.hits}x)`);
    } else {
      // 2. Afinidade aprendida por tokens
      const affWeight = tokenAffinity.get(acc.conta) || 0;
      if (affWeight > 0) {
        score += 0.54 * (1 - Math.exp(-affWeight / 3.2));
        reasons.push('tokens aprendidos');
      }

      // 3. Nome completo da conta dentro do histórico (com fronteira de palavra para siglas curtas)
      const exactWholeName =
        item.nameNorm.length >= 3 &&
        (` ${historyNorm} `.includes(` ${item.nameNorm} `) ||
          (item.nameNorm.length >= 6 && historyNorm.includes(item.nameNorm)));
      if (exactWholeName) {
        score += item.nameTokens.length >= 2 ? 0.70 : 0.66;
        reasons.push('nome exato no histórico');
      } else {
        // 4. Sobreposição de tokens e ontologia contábil
        let directHits = 0;
        let ontologyHits = 0;
        for (let i = 0; i < item.nameTokens.length; i += 1) {
          const tok = item.nameTokens[i];
          const stem = item.nameStems[i];
          if (historySet.has(tok) || historyStems.has(stem)) {
            directHits += 1;
          } else if (ontologyTokens.has(tok) || ontologyStems.has(stem)) {
            ontologyHits += 0.85;
          }
        }

        if (item.nameTokens.length > 0 && (directHits > 0 || ontologyHits > 0)) {
          const coverage = (directHits + ontologyHits) / item.nameTokens.length;
          const density = Math.min(1, (directHits + ontologyHits) / Math.max(2, rawTokens.length));
          const lexical = Math.min(0.68, coverage * 0.56 + density * 0.16);
          score += lexical;
          if (directHits > 0) reasons.push('nome da conta');
          if (ontologyHits > 0) reasons.push('contexto financeiro I.A.');
        }

        // Bônus por grupo contábil (ex.: "Despesas Financeiras", "Impostos")
        let groupHits = 0;
        for (let i = 0; i < item.groupTokens.length; i += 1) {
          const tok = item.groupTokens[i];
          const stem = item.groupStems[i];
          if (historySet.has(tok) || historyStems.has(stem) || ontologyTokens.has(tok)) {
            groupHits += 1;
          }
        }
        if (groupHits > 0 && item.groupTokens.length > 0) {
          score += Math.min(0.14, (groupHits / item.groupTokens.length) * 0.18);
        }

        // Bônus por Apelido Conta (ex.: FGTS, IPTU, IPVA, INSS, ITAU)
        if (item.aliasNorm.length >= 3 && historySet.has(item.aliasNorm)) {
          score += 0.34;
          reasons.push(`apelido ${acc.alias}`);
        }
      }

      // 5. Compatibilidade contábil (despesa no pagamento / receita no recebimento)
      if (score > 0.15) {
        score += natureAdjustment(acc, direction, historyNorm);
      }
    }

    const clamped = Number(Math.max(0, Math.min(0.99, score)).toFixed(3));
    if (clamped <= 0.12) continue;

    scored.push({
      account: acc,
      score: clamped,
      matchType: learnedRule && learnedRule.conta === acc.conta ? 'memory_rule' : 'ai',
      reason: reasons.join(' + ') || 'semelhança semântica',
    });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.account.classification.localeCompare(b.account.classification, 'pt-BR', { numeric: true })
  );

  return scored.slice(0, limit);
}

/**
 * Concilia os lançamentos bancários usando o Plano de Contas do Questor
 * (exceto Clientes e Fornecedores). Preserva qualquer lançamento que já tenha
 * contato de Cliente/Fornecedor ou conta preenchida.
 */
export function reconcileWithChart(rows, chartAccounts, options = {}) {
  const index = indexChartAccounts(chartAccounts);
  const ruleMap = buildRuleMap(options.rules);
  const tokenMap = buildTokenAffinityMap(options.tokens);

  let matchedCount = 0;
  let memoryCount = 0;
  let suggestedCount = 0;

  for (const row of rows || []) {
    // Clientes e Fornecedores continuam com a planilha à parte: nunca sobrescreve.
    if (row.contact) continue;

    const direction = row.direction === 'receipt' ? 'receipt' : 'payment';
    const side = direction === 'receipt' ? 'credit' : 'debit';
    const alreadyFilled = side === 'credit' ? row.creditAccount : row.debitAccount;
    if (alreadyFilled) continue;

    const candidates = scoreChartCandidates(row.rawHistory || row.history, direction, chartAccounts, {
      side,
      index,
      ruleMap,
      tokenMap,
      limit: 5,
    });

    const best = candidates[0];
    const second = candidates[1];
    if (!best) continue;

    const clearMargin =
      best.matchType === 'memory_rule' ||
      !second ||
      best.score - second.score >= CHART_AMBIGUITY_MARGIN ||
      best.score >= 0.78;

    if (best.score >= CHART_MATCH_THRESHOLD && clearMargin) {
      if (side === 'credit') row.creditAccount = best.account.conta;
      else row.debitAccount = best.account.conta;

      row.status = best.matchType === 'memory_rule' ? 'learned' : 'matched';
      row.score = best.score;
      row.matchReason = best.matchType === 'memory_rule' ? 'chart_memory' : 'chart_ai';
      row.chartMatch = {
        conta: best.account.conta,
        name: best.account.name,
        classification: best.account.classification,
        side,
        score: best.score,
        source: best.matchType === 'memory_rule' ? 'memory' : 'ai',
        reason: best.reason,
      };
      delete row.chartSuggestion;
      matchedCount += 1;
      if (best.matchType === 'memory_rule') memoryCount += 1;
    } else if (best.score >= CHART_SUGGEST_THRESHOLD) {
      row.chartSuggestion = {
        conta: best.account.conta,
        name: best.account.name,
        classification: best.account.classification,
        side,
        score: best.score,
        reason: best.reason,
      };
      if (row.status === 'unmatched') row.status = 'ambiguous';
      row.score = best.score;
      suggestedCount += 1;
    }
  }

  return { matchedCount, memoryCount, suggestedCount };
}

/**
 * Registra localmente um aprendizado da I.A. (regra de histórico + tokens) e
 * devolve os payloads prontos para persistir no Supabase via RPC.
 */
export function recordChartLearning(stateStore, entry) {
  const historyKey = normalizeChartHistoryKey(entry?.history || '');
  const conta = String(entry?.conta || '').trim();
  if (!historyKey || !conta) return null;

  const direction = entry?.direction === 'receipt' ? 'receipt' : entry?.direction === 'payment' ? 'payment' : 'any';
  const side = entry?.side === 'credit' ? 'credit' : 'debit';
  const accountName = cleanWhitespace(entry?.accountName || '');
  const source = entry?.source || 'manual';
  const confidence = Number(entry?.confidence) || (source === 'manual' ? 0.92 : 0.85);
  const sampleHistory = scrubSampleHistory(entry?.history || '');

  const rules = Array.isArray(stateStore?.rules) ? stateStore.rules : [];
  const tokens = Array.isArray(stateStore?.tokens) ? stateStore.tokens : [];

  const existingIdx = rules.findIndex(
    (r) => r.history_key === historyKey && r.direction === direction && r.side === side
  );

  let savedRule;
  if (existingIdx >= 0) {
    const prev = rules[existingIdx];
    const sameConta = prev.conta === conta;
    savedRule = {
      history_key: historyKey,
      direction,
      side,
      conta,
      account_name: accountName || prev.account_name || '',
      hits: sameConta ? (Number(prev.hits) || 1) + 1 : 1,
      confidence: sameConta ? Math.min(0.999, Math.max(Number(prev.confidence) || 0.85, confidence) + 0.02) : confidence,
      source,
      sample_history: sampleHistory || prev.sample_history || '',
      updated_at: new Date().toISOString(),
    };
    rules[existingIdx] = savedRule;
  } else {
    savedRule = {
      history_key: historyKey,
      direction,
      side,
      conta,
      account_name: accountName,
      hits: 1,
      confidence,
      source,
      sample_history: sampleHistory,
      updated_at: new Date().toISOString(),
    };
    rules.unshift(savedRule);
  }

  const learnedTokens = [];
  for (const token of chartTokens(entry?.history || '').slice(0, 6)) {
    const tokenItem = {
      token,
      conta,
      direction,
      weight: source === 'manual' ? 1.5 : 0.8,
      hits: 1,
    };
    learnedTokens.push(tokenItem);

    const tIdx = tokens.findIndex(
      (t) => t.token === token && t.conta === conta && (t.direction || 'any') === direction
    );
    if (tIdx >= 0) {
      tokens[tIdx] = {
        ...tokens[tIdx],
        weight: Math.min(100, (Number(tokens[tIdx].weight) || 0) + tokenItem.weight),
        hits: (Number(tokens[tIdx].hits) || 0) + 1,
      };
    } else {
      tokens.push(tokenItem);
    }
  }

  return { rule: savedRule, tokens: learnedTokens };
}

/**
 * Busca contas no Plano de Contas pelo código (`Conta`), nome, apelido ou classificação.
 */
export function searchChartAccounts(accounts = [], query = '', options = {}) {
  const includeCounterparties = Boolean(options.includeCounterparties);
  const limit = Number(options.limit) || 15;
  const norm = normalizeChartKey(query);
  const rawTrim = String(query ?? '').trim();

  const pool = (accounts || []).filter(
    (acc) => acc && acc.active !== false && !acc.is_synthetic && (includeCounterparties || !acc.is_counterparty)
  );

  if (!norm && !rawTrim) return pool.slice(0, limit);

  const terms = norm.split(' ').filter(Boolean);
  const results = [];

  for (const acc of pool) {
    let rank = 0;
    if (rawTrim && acc.conta === rawTrim) rank = 100;
    else if (rawTrim && acc.conta.startsWith(rawTrim)) rank = 80;
    else if (norm && normalizeChartKey(acc.alias) === norm) rank = 75;
    else {
      const hay = normalizeChartKey(`${acc.conta} ${acc.name} ${acc.alias} ${acc.classification} ${acc.group_path}`);
      if (terms.every((t) => hay.includes(t))) {
        const nameNorm = normalizeChartKey(acc.name);
        rank = nameNorm.startsWith(norm) ? 65 : nameNorm.includes(norm) ? 55 : 40;
      }
    }
    if (rank > 0) results.push({ account: acc, rank });
  }

  results.sort(
    (a, b) =>
      b.rank - a.rank ||
      a.account.classification.localeCompare(b.account.classification, 'pt-BR', { numeric: true })
  );

  return results.slice(0, limit).map((entry) => entry.account);
}
