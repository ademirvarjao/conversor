/**
 * Conversor — Catálogo de layouts bancários e reconhecimento por estrutura
 *
 * Objetivo: reconhecer o layout de **qualquer** extrato, não só dos dois que já
 * vêm treinados. São três camadas, nesta ordem de confiança:
 *
 *  1. **Catálogo de bancos** (`BANK_LAYOUTS`): nome do banco (banner, nome do
 *     arquivo ou cabeçalho) + regras de coluna daquele banco. É o que resolve
 *     o caso em que o banco muda o nome de uma coluna (`Dcto.` ↔ `Documento`)
 *     ou inverte Crédito/Débito.
 *  2. **Assinaturas aprendidas**: todo layout que o usuário confirmar/treinar
 *     vira uma assinatura (cabeçalhos + papéis). Um extrato parecido (≥ 70% de
 *     semelhança nos cabeçalhos) reaproveita os papéis já aprendidos.
 *  3. **Heurística genérica**: sinônimos universais de data/histórico/
 *     documento/saldo/crédito/débito/valor/D-C. Funciona em banco desconhecido.
 *
 * Tudo é puro e offline: nada aqui navega na internet. O catálogo público
 * (`layout-registry.js`) é só uma *lista de layouts* baixada de um JSON — o
 * conteúdo do extrato do usuário nunca sai do navegador.
 */

import { cleanWhitespace, normalizeText } from './parsers.js';

/* -------------------------------------------------------------------------- */
/*                          Papéis e utilitários                              */
/* -------------------------------------------------------------------------- */

export const LAYOUT_ROLES = {
  DATE: 'date',
  HISTORY: 'history',
  VALUE_AUTO: 'value_auto',
  VALUE_IN: 'value_in',
  VALUE_OUT: 'value_out',
  DC_FLAG: 'dc_flag',
  IGNORE: 'ignore',
};

const VALID_ROLES = new Set(Object.values(LAYOUT_ROLES));

/**
 * Regras genéricas de coluna — usadas quando o banco não é conhecido.
 * A ordem importa: a primeira regra que casar define o papel.
 */
export const GENERIC_COLUMN_RULES = [
  { match: '^data(\\b|$)|^dt\\.?\\s|^data\\s', role: LAYOUT_ROLES.DATE },
  { match: 'saldo', role: LAYOUT_ROLES.IGNORE },
  { match: 'total|totais|resumo|acumulado', role: LAYOUT_ROLES.IGNORE },
  { match: '^(d\\s*/?\\s*c|dc|deb|cred|d|credito\\s*/\\s*debito)$', role: LAYOUT_ROLES.DC_FLAG },
  { match: 'credito|entrada|recebimento|recebidos|deposito', role: LAYOUT_ROLES.VALUE_IN },
  { match: 'debito|saida|pagamento|pagamentos|saidas', role: LAYOUT_ROLES.VALUE_OUT },
  { match: 'dcto|docto|documento|doc\\b|autenticacao|autentic|nosso numero|lote|n[ºo]\\s*doc|numero\\s*doc', role: LAYOUT_ROLES.IGNORE },
  { match: 'valor|montante|quantia|vlr', role: LAYOUT_ROLES.VALUE_AUTO },
  { match: 'lancamento|descricao|historico|detalhe|complemento|observacao|razao social|favorecido|pagador|beneficiario|cnpj|cpf', role: LAYOUT_ROLES.HISTORY },
];

/** Mesma coisa, mas para linhas de texto (banner) — detecta o banco. */
const BANK_ALIASES = {
  itau: 'itau|ita[uú] unibanco',
  bradesco: 'bradesco',
  'banco-do-brasil': 'banco do brasil|\\bbb\\b',
  caixa: 'caixa economica|caixa econ[oô]mica|\\bcef\\b|caixa tem',
  santander: 'santander',
  sicoob: 'sicoob|bancoob',
  sicredi: 'sicredi',
  nubank: 'nubank|nu pagamentos|nu financeira',
  inter: 'banco inter|intermedium|\\binter\\b',
  c6: 'c6 bank|c6 s\\.?a|\\bc6\\b',
  btg: 'btg pactual|\\bbtg\\b',
  safra: 'banco safra',
  banrisul: 'banrisul',
  'mercado-pago': 'mercado pago|mercadopago',
  pagbank: 'pagseguro|pagbank|pag seguro',
  stone: 'stone pagamentos|\\bstone\\b',
  original: 'banco original',
  agibank: 'agibank|agipag',
};

/* -------------------------------------------------------------------------- */
/*                          Catálogo dos bancos                               */
/* -------------------------------------------------------------------------- */

/**
 * Cada banco tem:
 *  - `id`/`name`: identificação;
 *  - `aliases`: regex (sobre texto normalizado) que aparece no banner, no nome
 *    do arquivo ou no cabeçalho da tabela;
 *  - `columns`: regras de coluna próprias do banco (vencem as genéricas);
 *  - `quirks`: observações usadas pelo treinador automático.
 *
 * `columns` usa a MESMA estrutura do catálogo público (strings de regex), para
 * que os dois caminhos passem pelo mesmo validador.
 */
export const BANK_LAYOUTS = [
  {
    id: 'itau',
    name: 'Itaú Unibanco',
    kind: 'conta-corrente-pj',
    columns: [
      { match: '^data', role: LAYOUT_ROLES.DATE },
      { match: 'lancamentos?|historico', role: LAYOUT_ROLES.HISTORY },
      { match: 'razao social', role: LAYOUT_ROLES.HISTORY },
      { match: 'cnpj|cpf', role: LAYOUT_ROLES.HISTORY },
      { match: 'valor', role: LAYOUT_ROLES.VALUE_AUTO },
      { match: 'saldo', role: LAYOUT_ROLES.IGNORE },
    ],
    quirks: {
      // O extrato do Itaú só publica o saldo no fechamento do dia.
      saldo: 'checkpoint',
      // Cada lançamento ocupa 3 linhas (descrição quebrada em cima e embaixo).
      blockLines: 3,
      sections: ['saldo total disponivel dia'],
    },
  },
  {
    id: 'bradesco',
    name: 'Bradesco',
    kind: 'conta-corrente-pj',
    columns: [
      { match: '^data', role: LAYOUT_ROLES.DATE },
      { match: 'lancamento|historico', role: LAYOUT_ROLES.HISTORY },
      { match: 'dcto|documento|docto', role: LAYOUT_ROLES.IGNORE },
      { match: 'credito', role: LAYOUT_ROLES.VALUE_IN },
      { match: 'debito', role: LAYOUT_ROLES.VALUE_OUT },
      { match: 'saldo', role: LAYOUT_ROLES.IGNORE },
    ],
    quirks: {
      saldo: 'corrente',
      sections: ['saldo anterior', 'saldo invest facil', 'ultimos lancamentos'],
    },
  },
  {
    id: 'banco-do-brasil',
    name: 'Banco do Brasil',
    kind: 'conta-corrente-pj',
    columns: [
      // A regra específica vem ANTES do "^data": no BB a coluna "Data do
      // Balancete" também começa com "Data" e não é a data do lançamento.
      { match: 'data do balancete|data balancete', role: LAYOUT_ROLES.IGNORE },
      { match: 'dependencia', role: LAYOUT_ROLES.IGNORE },
      { match: '^data', role: LAYOUT_ROLES.DATE },
      { match: 'historico|lancamento', role: LAYOUT_ROLES.HISTORY },
      { match: 'documento|dcto|n[ºo] doc|nº doc', role: LAYOUT_ROLES.IGNORE },
      { match: 'valor', role: LAYOUT_ROLES.VALUE_AUTO },
      { match: 'saldo', role: LAYOUT_ROLES.IGNORE },
    ],
    quirks: {
      // O BB escreve o sentido depois do valor: "1.234,56 C" / "1.234,56 D".
      valueSuffixDC: true,
      saldo: 'corrente',
    },
  },
  {
    id: 'caixa',
    name: 'Caixa Econômica Federal',
    kind: 'conta-corrente-pj',
    columns: [
      { match: '^data', role: LAYOUT_ROLES.DATE },
      { match: 'historico|descricao|lancamento', role: LAYOUT_ROLES.HISTORY },
      { match: 'dcto|documento|doc', role: LAYOUT_ROLES.IGNORE },
      { match: 'valor', role: LAYOUT_ROLES.VALUE_AUTO },
      { match: 'saldo', role: LAYOUT_ROLES.IGNORE },
    ],
    quirks: { saldo: 'corrente', valueSuffixDC: true },
  },
  {
    id: 'santander',
    name: 'Santander',
    kind: 'conta-corrente-pj',
    columns: [
      { match: '^data', role: LAYOUT_ROLES.DATE },
      { match: 'lancamento|historico|descricao', role: LAYOUT_ROLES.HISTORY },
      { match: 'dcto|documento|doc', role: LAYOUT_ROLES.IGNORE },
      { match: 'credito', role: LAYOUT_ROLES.VALUE_IN },
      { match: 'debito', role: LAYOUT_ROLES.VALUE_OUT },
      { match: 'saldo', role: LAYOUT_ROLES.IGNORE },
    ],
    quirks: { saldo: 'corrente' },
  },
  {
    id: 'sicoob',
    name: 'Sicoob',
    kind: 'cooperativa',
    columns: [
      { match: '^data', role: LAYOUT_ROLES.DATE },
      { match: 'historico|descricao|lancamento', role: LAYOUT_ROLES.HISTORY },
      { match: 'documento|dcto|doc', role: LAYOUT_ROLES.IGNORE },
      { match: 'valor', role: LAYOUT_ROLES.VALUE_AUTO },
      { match: 'saldo', role: LAYOUT_ROLES.IGNORE },
    ],
    quirks: { saldo: 'corrente' },
  },
  {
    id: 'sicredi',
    name: 'Sicredi',
    kind: 'cooperativa',
    columns: [
      { match: '^data', role: LAYOUT_ROLES.DATE },
      { match: 'descricao|historico|lancamento', role: LAYOUT_ROLES.HISTORY },
      { match: 'documento|dcto|doc', role: LAYOUT_ROLES.IGNORE },
      { match: 'valor', role: LAYOUT_ROLES.VALUE_AUTO },
      { match: 'saldo', role: LAYOUT_ROLES.IGNORE },
    ],
    quirks: { saldo: 'corrente' },
  },
  {
    id: 'nubank',
    name: 'Nubank',
    kind: 'conta-digital',
    columns: [
      { match: '^data', role: LAYOUT_ROLES.DATE },
      { match: 'descricao|historico|estabelecimento', role: LAYOUT_ROLES.HISTORY },
      { match: 'valor', role: LAYOUT_ROLES.VALUE_AUTO },
      { match: 'saldo', role: LAYOUT_ROLES.IGNORE },
    ],
    quirks: { saldo: 'sem-saldo' },
  },
  {
    id: 'inter',
    name: 'Banco Inter',
    kind: 'conta-digital',
    columns: [
      { match: '^data', role: LAYOUT_ROLES.DATE },
      { match: 'descricao|historico|lancamento', role: LAYOUT_ROLES.HISTORY },
      { match: 'valor', role: LAYOUT_ROLES.VALUE_AUTO },
      { match: 'saldo', role: LAYOUT_ROLES.IGNORE },
    ],
    quirks: { saldo: 'corrente' },
  },
  {
    id: 'c6',
    name: 'C6 Bank',
    kind: 'conta-digital',
    columns: [
      { match: '^data', role: LAYOUT_ROLES.DATE },
      { match: 'descricao|historico|lancamento', role: LAYOUT_ROLES.HISTORY },
      { match: 'valor', role: LAYOUT_ROLES.VALUE_AUTO },
      { match: 'saldo', role: LAYOUT_ROLES.IGNORE },
    ],
    quirks: { saldo: 'corrente' },
  },
  {
    id: 'btg',
    name: 'BTG Pactual',
    kind: 'conta-investimento',
    columns: [
      { match: '^data', role: LAYOUT_ROLES.DATE },
      { match: 'historico|descricao|lancamento', role: LAYOUT_ROLES.HISTORY },
      { match: 'dcto|documento|doc', role: LAYOUT_ROLES.IGNORE },
      { match: 'valor', role: LAYOUT_ROLES.VALUE_AUTO },
      { match: 'saldo', role: LAYOUT_ROLES.IGNORE },
    ],
    quirks: { saldo: 'corrente' },
  },
  {
    id: 'safra',
    name: 'Banco Safra',
    kind: 'conta-corrente-pj',
    columns: [
      { match: '^data', role: LAYOUT_ROLES.DATE },
      { match: 'historico|descricao|lancamento', role: LAYOUT_ROLES.HISTORY },
      { match: 'documento|dcto|doc', role: LAYOUT_ROLES.IGNORE },
      { match: 'valor', role: LAYOUT_ROLES.VALUE_AUTO },
      { match: 'saldo', role: LAYOUT_ROLES.IGNORE },
    ],
    quirks: { saldo: 'corrente' },
  },
  {
    id: 'banrisul',
    name: 'Banrisul',
    kind: 'conta-corrente-pj',
    columns: [
      { match: '^data', role: LAYOUT_ROLES.DATE },
      { match: 'historico|descricao|lancamento', role: LAYOUT_ROLES.HISTORY },
      { match: 'documento|dcto|doc', role: LAYOUT_ROLES.IGNORE },
      { match: 'valor', role: LAYOUT_ROLES.VALUE_AUTO },
      { match: 'saldo', role: LAYOUT_ROLES.IGNORE },
    ],
    quirks: { saldo: 'corrente' },
  },
  {
    id: 'mercado-pago',
    name: 'Mercado Pago',
    kind: 'conta-digital',
    columns: [
      { match: '^data', role: LAYOUT_ROLES.DATE },
      { match: 'descricao|historico|detalhe', role: LAYOUT_ROLES.HISTORY },
      { match: 'valor', role: LAYOUT_ROLES.VALUE_AUTO },
      { match: 'saldo', role: LAYOUT_ROLES.IGNORE },
    ],
    quirks: { saldo: 'corrente' },
  },
  {
    id: 'pagbank',
    name: 'PagBank / PagSeguro',
    kind: 'conta-digital',
    columns: [
      { match: '^data', role: LAYOUT_ROLES.DATE },
      { match: 'descricao|historico|lancamento', role: LAYOUT_ROLES.HISTORY },
      { match: 'valor', role: LAYOUT_ROLES.VALUE_AUTO },
      { match: 'saldo', role: LAYOUT_ROLES.IGNORE },
    ],
    quirks: { saldo: 'corrente' },
  },
  {
    id: 'stone',
    name: 'Stone',
    kind: 'conta-digital',
    columns: [
      { match: '^data', role: LAYOUT_ROLES.DATE },
      { match: 'descricao|historico|lancamento', role: LAYOUT_ROLES.HISTORY },
      { match: 'valor', role: LAYOUT_ROLES.VALUE_AUTO },
      { match: 'saldo', role: LAYOUT_ROLES.IGNORE },
    ],
    quirks: { saldo: 'corrente' },
  },
  {
    id: 'original',
    name: 'Banco Original',
    kind: 'conta-corrente-pj',
    columns: [
      { match: '^data', role: LAYOUT_ROLES.DATE },
      { match: 'descricao|historico|lancamento', role: LAYOUT_ROLES.HISTORY },
      { match: 'documento|dcto|doc', role: LAYOUT_ROLES.IGNORE },
      { match: 'valor', role: LAYOUT_ROLES.VALUE_AUTO },
      { match: 'saldo', role: LAYOUT_ROLES.IGNORE },
    ],
    quirks: { saldo: 'corrente' },
  },
  {
    id: 'agibank',
    name: 'Agibank',
    kind: 'conta-corrente-pj',
    columns: [
      { match: '^data', role: LAYOUT_ROLES.DATE },
      { match: 'descricao|historico|lancamento', role: LAYOUT_ROLES.HISTORY },
      { match: 'documento|dcto|doc', role: LAYOUT_ROLES.IGNORE },
      { match: 'valor', role: LAYOUT_ROLES.VALUE_AUTO },
      { match: 'saldo', role: LAYOUT_ROLES.IGNORE },
    ],
    quirks: { saldo: 'corrente' },
  },
];

export const BANK_LAYOUT_IDS = BANK_LAYOUTS.map((layout) => layout.id);

/* -------------------------------------------------------------------------- */
/*                              Validação                                     */
/* -------------------------------------------------------------------------- */

const MAX_PATTERN_LENGTH = 160;

/** Compila um padrão com segurança (regex inválido ou absurdo é descartado). */
function compilePattern(source) {
  if (typeof source !== 'string' || !source || source.length > MAX_PATTERN_LENGTH) return null;
  try {
    return new RegExp(source, 'i');
  } catch {
    return null;
  }
}

/**
 * Valida/normaliza um layout vindo de qualquer lugar (catálogo embutido ou JSON
 * baixado). Um layout inválido é descartado — nunca quebra o app.
 */
export function sanitizeLayout(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;

  const id = cleanWhitespace(raw.id).toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!id) return null;

  const name = cleanWhitespace(raw.name) || id;
  const columns = Array.isArray(raw.columns)
    ? raw.columns
        .map((column) => {
          const pattern = compilePattern(column?.match);
          if (!pattern) return null;
          const role = VALID_ROLES.has(column.role) ? column.role : LAYOUT_ROLES.HISTORY;
          return { match: column.match, role, pattern };
        })
        .filter(Boolean)
        .slice(0, 24)
    : [];
  if (columns.length === 0) return null;

  // Apelido: explícito no layout, do catálogo embutido ou derivado do nome
  // ("Banco do Nordeste (BNB)" → "banco do nordeste").
  const derivedAlias = normalizeText(name)
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[.*+?^${}()|[\]\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const alias =
    typeof raw.alias === 'string' && raw.alias
      ? raw.alias.slice(0, MAX_PATTERN_LENGTH)
      : BANK_ALIASES[id] || (derivedAlias.length >= 3 ? derivedAlias : '');

  return {
    id,
    name,
    kind: cleanWhitespace(raw.kind) || 'extrato',
    alias,
    columns,
    quirks: raw.quirks && typeof raw.quirks === 'object' ? { ...raw.quirks } : {},
    source: raw.source === 'community' ? 'community' : 'builtin',
    order: index,
  };
}

/** Catálogo embutido já normalizado (com as regex compiladas). */
export function builtInLayouts() {
  return BANK_LAYOUTS.map((layout, index) =>
    sanitizeLayout({ ...layout, alias: BANK_ALIASES[layout.id] || '', source: 'builtin' }, index)
  ).filter(Boolean);
}

/** Junta catálogos por `id` (o primeiro vence; o segundo só acrescenta). */
export function mergeLayouts(...catalogs) {
  const byId = new Map();
  for (const catalog of catalogs) {
    for (const layout of catalog || []) {
      if (!layout || !layout.id) continue;
      if (!byId.has(layout.id)) byId.set(layout.id, layout);
    }
  }
  return [...byId.values()];
}

/* -------------------------------------------------------------------------- */
/*                          Reconhecimento do banco                           */
/* -------------------------------------------------------------------------- */

function corpusFor(parsedFile, fileNameHint = '') {
  const parts = [
    fileNameHint,
    parsedFile?.fileName || '',
    ...(Array.isArray(parsedFile?.bannerLines) ? parsedFile.bannerLines : []),
    ...(Array.isArray(parsedFile?.headers) ? parsedFile.headers : []),
  ];
  return normalizeText(parts.filter(Boolean).join(' '));
}

/**
 * Descobre de qual banco é o arquivo.
 * @returns {{ layout: object, confidence: number, evidence: string[] }|null}
 */
export function detectBank(parsedFile, catalogs = null) {
  const layouts = catalogs || builtInLayouts();
  const corpus = corpusFor(parsedFile);
  const headers = (parsedFile?.headers || []).map((header) => normalizeText(header));

  let best = null;

  for (const layout of layouts) {
    const evidence = [];
    let score = 0;

    const alias = compilePattern(layout.alias || '');
    if (alias && corpus && alias.test(corpus)) {
      score += 0.6;
      evidence.push(`nome do banco no arquivo (“${layout.name}”)`);
    }

    if (headers.length > 0 && layout.columns.length > 0) {
      const coverage = headers.filter((header) =>
        layout.columns.some((column) => column.pattern.test(header))
      ).length;
      const ratio = coverage / headers.length;
      if (ratio >= 0.7) {
        score += 0.25;
        evidence.push(`${coverage} de ${headers.length} colunas batem com o padrão do banco`);
      } else if (ratio >= 0.4) {
        score += 0.1;
        evidence.push(`${coverage} de ${headers.length} colunas compatíveis`);
      }
    }

    if (score > 0 && (!best || score > best.confidence)) {
      best = {
        layout,
        confidence: Math.min(0.98, Number(score.toFixed(2))),
        evidence,
      };
    }
  }

  return best;
}

/* -------------------------------------------------------------------------- */
/*                        Previsão de papéis                                  */
/* -------------------------------------------------------------------------- */

/**
 * Prevê o papel de cada coluna a partir das regras do banco (ou genéricas).
 * @returns {Array<{ colIdx:number, header:string, role:string, historyOrder:number, rule:string }>}
 */
export function predictRoles(headers, layout = null) {
  const rules = layout?.columns?.length ? [...layout.columns, ...GENERIC_COLUMN_RULES.map((r) => ({
    ...r,
    pattern: compilePattern(r.match),
  })).filter((r) => r.pattern)] : GENERIC_COLUMN_RULES.map((rule) => ({ ...rule, pattern: compilePattern(rule.match) })).filter((rule) => rule.pattern);

  const predictions = [];
  let historyOrder = 1;

  (headers || []).forEach((header, colIdx) => {
    const norm = normalizeText(header);
    const rule = rules.find((candidate) => candidate.pattern.test(norm));
    const role = rule?.role || LAYOUT_ROLES.IGNORE;
    predictions.push({
      colIdx,
      header,
      role,
      historyOrder: role === LAYOUT_ROLES.HISTORY ? historyOrder++ : 0,
      rule: rule?.match || '(sem regra)',
    });
  });

  return predictions;
}

/* -------------------------------------------------------------------------- */
/*                        Assinaturas aprendidas                              */
/* -------------------------------------------------------------------------- */

function headerTokens(headers) {
  return (headers || [])
    .map((header) => normalizeText(header))
    .filter(Boolean)
    .join(' ')
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
}

/** Semelhança entre dois conjuntos de cabeçalhos (0 a 1). */
export function headerSimilarity(a, b) {
  const setA = new Set(headerTokens(a));
  const setB = new Set(headerTokens(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  return intersection / (setA.size + setB.size - intersection);
}

/**
 * Acha a assinatura aprendida mais parecida com este arquivo.
 * @param {string[]} headers
 * @param {Array<{id:string, headers:string[], roles:object[]}>} signatures
 */
export function matchLearnedSignature(headers, signatures, { minSimilarity = 0.7 } = {}) {
  let best = null;
  for (const signature of signatures || []) {
    const similarity = headerSimilarity(headers, signature.headers);
    if (similarity < minSimilarity) continue;
    if (!best || similarity > best.similarity) best = { signature, similarity };
  }
  return best;
}

/* -------------------------------------------------------------------------- */
/*                       Reconhecimento completo                              */
/* -------------------------------------------------------------------------- */

/**
 * Reconhece o layout de um extrato combinando catálogo + aprendizado + genérico.
 *
 * @param {object} parsedFile `{ headers, bannerLines, rows, fileName }`
 * @param {object} [options]
 * @param {Array} [options.layouts] catálogo extra (ex.: baixado da comunidade)
 * @param {Array} [options.learnedSignatures] assinaturas da memória
 * @returns {{
 *   source: 'catalog'|'learned'|'generic',
 *   bank: { id:string, name:string }|null,
 *   confidence: number,
 *   evidence: string[],
 *   roles: Array<object>,
 * }}
 */
export function recognizeLayout(parsedFile, { layouts = null, learnedSignatures = [] } = {}) {
  const headers = Array.isArray(parsedFile?.headers) ? parsedFile.headers : [];
  const external = (layouts || []).map((layout, index) => sanitizeLayout(layout, index)).filter(Boolean);
  const catalog = external.length > 0 ? mergeLayouts(builtInLayouts(), external) : builtInLayouts();
  const detected = detectBank(parsedFile, catalog);

  // 1) Banco reconhecido no catálogo — só com nome no arquivo (ou estrutura
  //    muito característica). Estrutura parecida sozinha não nomeia o banco:
  //    "Data | Descrição | Valor | Saldo" existe em meio mundo.
  const confidentBank = detected && detected.confidence >= 0.55 ? detected : null;

  if (confidentBank && headers.length > 0) {
    return {
      source: 'catalog',
      bank: { id: confidentBank.layout.id, name: confidentBank.layout.name },
      confidence: confidentBank.confidence,
      evidence: confidentBank.evidence,
      roles: predictRoles(headers, confidentBank.layout),
      quirks: confidentBank.layout.quirks || {},
    };
  }

  // 2) Layout que o usuário já treinou (variação de nome de coluna).
  const learned = matchLearnedSignature(headers, learnedSignatures);
  if (learned) {
    return {
      source: 'learned',
      bank: learned.signature.bank || null,
      confidence: Number((0.5 + learned.similarity * 0.45).toFixed(2)),
      evidence: [
        `parecido (${Math.round(learned.similarity * 100)}%) com o layout “${
          learned.signature.name || 'já treinado'
        }”`,
      ],
      roles: learned.signature.roles.map((role, colIdx) => ({
        colIdx,
        header: headers[colIdx] || role.header,
        role: role.role,
        historyOrder: role.historyOrder || 0,
        rule: 'assinatura aprendida',
      })),
      quirks: {},
    };
  }

  // 3) Heurística genérica: funciona em qualquer banco. As regras do banco
  //    apenas "candidato" (estrutura parecida) são usadas como dica extra.
  return {
    source: 'generic',
    bank: null,
    bankCandidate: detected ? { id: detected.layout.id, name: detected.layout.name } : null,
    confidence: detected ? Math.min(0.5, detected.confidence) : 0.35,
    evidence: detected
      ? [
          ...detected.evidence,
          'sem o nome do banco no arquivo: papéis inferidos pelos sinônimos das colunas',
        ]
      : ['banco não identificado: papéis inferidos pelos sinônimos das colunas'],
    roles: predictRoles(headers, detected?.layout || null),
    quirks: detected?.layout?.quirks || {},
  };
}

/* -------------------------------------------------------------------------- */
/*                     Aplicar o reconhecimento na análise                    */
/* -------------------------------------------------------------------------- */

/**
 * Compara o que a IA escolheu com o que o reconhecimento espera.
 * Só entram divergências de colunas com papel "seguro" (data, documento,
 * saldo, crédito/débito explícito) — valor genérico fica com a IA.
 *
 * @returns {Array<{ colIdx:number, header:string, from:string, to:string, reason:string }>}
 */
export function diffRoles(analysis, recognition) {
  const mappings = Array.isArray(analysis?.mappings) ? analysis.mappings : [];
  const diffs = [];

  for (const predicted of recognition?.roles || []) {
    const mapping = mappings.find((item) => item.colIdx === predicted.colIdx);
    if (!mapping || mapping.role === predicted.role) continue;

    const from = mapping.role;
    const to = predicted.role;
    if (!VALID_ROLES.has(to)) continue;

    const normHeader = normalizeText(mapping.header);
    const headerMoneySide = /credito|entrada|recebimento|deposito/.test(normHeader)
      ? LAYOUT_ROLES.VALUE_IN
      : /debito|saida|pagamento/.test(normHeader)
        ? LAYOUT_ROLES.VALUE_OUT
        : null;

    const moneySwap =
      (from === LAYOUT_ROLES.VALUE_IN && to === LAYOUT_ROLES.VALUE_OUT) ||
      (from === LAYOUT_ROLES.VALUE_OUT && to === LAYOUT_ROLES.VALUE_IN) ||
      // "Crédito (R$)" estava como valor neutro e o banco diz que é crédito.
      (from === LAYOUT_ROLES.VALUE_AUTO && headerMoneySide === to);
    const toIgnore = to === LAYOUT_ROLES.IGNORE && from !== LAYOUT_ROLES.IGNORE;
    const fromIgnore = from === LAYOUT_ROLES.IGNORE && to !== LAYOUT_ROLES.IGNORE;
    const dateFix = to === LAYOUT_ROLES.DATE || from === LAYOUT_ROLES.DATE;
    const dcFix = to === LAYOUT_ROLES.DC_FLAG;

    // "Valor" genérico é decisão da IA (pode ser valor único, entrada ou saída).
    const ambiguousValue =
      to === LAYOUT_ROLES.VALUE_AUTO && from !== LAYOUT_ROLES.IGNORE && from !== LAYOUT_ROLES.DATE;

    if (!moneySwap && !toIgnore && !fromIgnore && !dateFix && !dcFix) continue;
    if (ambiguousValue) continue;

    diffs.push({
      colIdx: predicted.colIdx,
      header: mapping.header,
      from,
      to,
      reason:
        recognition.source === 'catalog' && recognition.bank
          ? `O padrão do ${recognition.bank.name} marca esta coluna como “${to}”.`
          : `O padrão de colunas marca “${mapping.header}” como “${to}”.`,
    });
  }

  return diffs;
}

/**
 * Devolve uma cópia da análise com os papéis previstos aplicados (usado quando
 * o layout é inédito e o reconhecimento é confiável).
 */
export function applyRecognition(analysis, recognition) {
  const next = JSON.parse(JSON.stringify(analysis || {}));
  const mappings = Array.isArray(next.mappings) ? next.mappings : [];

  for (const predicted of recognition?.roles || []) {
    const mapping = mappings.find((item) => item.colIdx === predicted.colIdx);
    if (!mapping) continue;
    mapping.role = predicted.role;
    if (predicted.role === LAYOUT_ROLES.HISTORY && predicted.historyOrder > 0) {
      mapping.historyOrder = predicted.historyOrder;
    } else if (predicted.role !== LAYOUT_ROLES.HISTORY) {
      mapping.historyOrder = 0;
    }
  }

  // Renumera o histórico para 1..n na ordem das colunas.
  let order = 1;
  for (const mapping of mappings) {
    if (mapping.role === LAYOUT_ROLES.HISTORY) mapping.historyOrder = order++;
    else mapping.historyOrder = 0;
  }

  next.layoutSource = recognition?.source || 'generic';
  next.detectedBank = recognition?.bank || null;
  next.layoutConfidence = Number(recognition?.confidence) || 0;
  return next;
}

/**
 * Assinatura de um layout treinado — o que a memória guarda para reconhecer
 * variações no futuro.
 */
export function buildLayoutSignature(parsedFile, analysis, { name = '', bank = null } = {}) {
  const headers = (parsedFile?.headers || []).map((header) => normalizeText(header));
  if (headers.length === 0) return null;

  const roles = (analysis?.mappings || []).map((mapping) => ({
    header: mapping.header,
    role: mapping.role,
    historyOrder: mapping.historyOrder || 0,
  }));
  if (roles.length === 0) return null;

  return {
    headers,
    roles,
    name: cleanWhitespace(name) || `Extrato ${headers.slice(0, 2).join(' / ')}`,
    bank: bank ? { id: bank.id, name: bank.name } : null,
    fileType: parsedFile?.fileType === 'pdf' ? 'pdf' : 'xlsx',
  };
}
