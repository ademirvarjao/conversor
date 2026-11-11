/**
 * Conversor — Motor de IA Adaptativa para Layouts
 *
 * Combina quatro camadas:
 *  1. Classificador semântico multi-sinal (estatística das colunas + pesos léxicos aprendidos)
 *  2. Detector de evolução de layout (compara com perfis memorizados e aponta
 *     colunas novas, renomeadas e removidas)
 *  3. Aprendizado supervisionado contínuo (reforça/penaliza tokens e salva perfis)
 *  4. Conector LLM opcional (OpenAI/Gemini com chave do próprio usuário)
 *
 * O módulo não toca no DOM: toda a persistência é feita via localStorage
 * (opcional) e todas as funções são testáveis em Node.
 */

import { emptyCounterparties, sanitizeCounterparties } from './counterparty.js';
import {
  cleanWhitespace,
  normalizeText,
  tokenizeHeader,
  parseDateValue,
  parseMoneyValue,
} from './parsers.js';
import {
  formatIsoToBrDate,
  formatValuePlainBr,
  fromCents,
  round2,
  toCents,
} from './format.js';

export const STORAGE_KEY = 'conversor_ai_memory_v1';

/**
 * Chaves de memória de versões anteriores do app são adotadas pelo formato do
 * nome (`*_ai_memory_vN`), sem lista fixa de nomes antigos: assim a memória de
 * quem já usava o Conversor não se perde ao trocar o nome do produto.
 */
const LEGACY_MEMORY_KEY = /(?:^|_)ai_memory_v\d+$/;
export const MEMORY_VERSION = 2;

/** Limites de segurança para o aprendizado online. */
const MAX_TOKEN_WEIGHT = 12;
const MIN_TOKEN_WEIGHT = 0;
const MAX_TOKENS = 3000;
const MAX_LOG_ENTRIES = 60;
const MAX_PROFILES = 60;

export const ROLES = {
  DATE: 'date',
  VALUE_AUTO: 'value_auto',
  VALUE_OUT: 'value_out',
  VALUE_IN: 'value_in',
  DC_FLAG: 'dc_flag',
  HISTORY: 'history',
  IGNORE: 'ignore',
};

export const ROLE_LABELS = {
  [ROLES.DATE]: 'Data (dd/mm/aaaa)',
  [ROLES.VALUE_AUTO]: 'Valor (+/- automático)',
  [ROLES.VALUE_OUT]: 'Valor Pago / Débito (-)',
  [ROLES.VALUE_IN]: 'Valor Recebido / Crédito (+)',
  [ROLES.DC_FLAG]: 'Indicador D/C (Sinal)',
  [ROLES.HISTORY]: 'Incluir no Histórico',
  [ROLES.IGNORE]: 'Ignorar (ex: Saldo/Total)',
};

export const ALL_ROLES = Object.values(ROLES);

const VALUE_ROLES = [ROLES.VALUE_AUTO, ROLES.VALUE_OUT, ROLES.VALUE_IN];

/**
 * Cabeçalhos que indicam, sem ambiguidade, uma coluna de valor/saldo.
 * Servem para não confundir "nº do documento" com montante.
 */
const AMOUNT_HEADER_RE =
  /\b(valor|valores|vlr|vl|quantia|montante|pago|pagto|pgtos|pgto|recebido|recbto|debito|credito|saida|entrada|saidas|entradas|debitos|creditos|despesa|receita|tarifa|juros|saldo)\b/;

/** Cabeçalhos de saldo/acumulado (valor de contexto, nunca lançamento). */
const BALANCE_HEADER_RE = /\b(saldo|acumulado|subtotal)\b/;

/** Sequências numéricas (nº do lançamento, ordem, código) não são valores. */
const SEQUENCE_HEADER_RE = /\b(lancto|lcto|lanc|id|seq|sequencia|ordem|codigo|cod|nro|numero|num)\b/;

/** Números de documento (nota, cheque, título) vão para o histórico. */
const DOCUMENT_HEADER_RE =
  /\b(documento|documentos|docto|doc|nf|nota|cheque|chq|titulo|autenticacao|protocolo)\b/;

/**
 * Datas de vencimento/prazo são previsão; as de movimento (recebimento,
 * pagamento, baixa, caixa) são o fato que interessa na conciliação.
 */
const DUE_DATE_HEADER_RE = /\b(venc|vencimento|vencido|vencer|prazo|previsao|previsto)\b/;
const EVENT_DATE_HEADER_RE =
  /\b(rec|receb|recebimento|recebido|pag|pago|pagamento|liquidacao|liquidado|baixa|caixa|movimento|mov|compensacao)\b/;

/** Valores previstos (vencimento, orçamento) perdem para os realizados. */
const FORECAST_AMOUNT_RE =
  /\b(venc|vencimento|vencido|vencer|previsto|previsao|orcado|orcamento|provisionado|estimado)\b/;
const REALIZED_AMOUNT_RE =
  /\b(recebido|recebidos|pago|pagos|liquidado|baixado|realizado|creditado|debitado)\b/;

const BASE_TOKEN_WEIGHTS = {
  // Datas
  data: { date: 4.5 },
  dt: { date: 4.0 },
  vencimento: { date: 2.5 },
  pagamento: { date: 1.8, value_out: 0.6 },
  recebimento: { date: 1.8, value_in: 0.6 },
  movimento: { date: 2.6 },
  movimentacao: { date: 2.4 },
  emissao: { date: 2.0 },
  competencia: { date: 2.0 },
  lancamento: { date: 1.8, history: 1.0 },
  date: { date: 4.5 },
  dia: { date: 1.2 },

  // Valores gerais
  valor: { value_auto: 4.0 },
  vr: { value_auto: 3.5 },
  vlr: { value_auto: 3.5 },
  vl: { value_auto: 3.2 },
  quantia: { value_auto: 3.0 },
  montante: { value_auto: 3.0 },
  liquido: { value_auto: 2.5 },
  bruto: { value_auto: 2.2 },
  importancia: { value_auto: 2.5 },
  total: { ignore: 2.6, value_auto: 0.8 },

  // Saídas / Pagamentos / Débitos
  pagto: { value_out: 4.4 },
  pgtos: { value_out: 4.2 },
  pagtos: { value_out: 4.2 },
  pgto: { value_out: 4.4 },
  pgt: { value_out: 4.0 },
  pago: { value_out: 3.8 },
  pagos: { value_out: 3.6 },
  pagar: { value_out: 3.5 },
  debito: { value_out: 4.2 },
  debitos: { value_out: 4.0 },
  deb: { value_out: 3.5 },
  saida: { value_out: 4.0 },
  saidas: { value_out: 3.8 },
  despesa: { value_out: 3.5 },
  despesas: { value_out: 3.4 },
  tarifa: { value_out: 2.2, history: 2.0 },
  aplicacao: { value_out: 1.2, history: 1.2 },
  saque: { value_out: 2.4 },
  saques: { value_out: 2.4 },

  // Entradas / Recebimentos / Créditos
  recebido: { value_in: 3.8 },
  recebidos: { value_in: 3.6 },
  receber: { value_in: 3.5 },
  credito: { value_in: 4.2 },
  creditos: { value_in: 4.0 },
  cred: { value_in: 3.5 },
  entrada: { value_in: 4.0 },
  entradas: { value_in: 3.8 },
  receita: { value_in: 3.5 },
  recbto: { value_in: 4.4 },
  recbtos: { value_in: 4.2 },
  recebto: { value_in: 4.4 },
  deposito: { value_in: 3.2 },
  depositos: { value_in: 3.0 },
  resgate: { value_in: 1.2, history: 1.2 },

  // Indicador D/C
  dc: { dc_flag: 4.5 },
  'd/c': { dc_flag: 4.5 },
  sinal: { dc_flag: 3.5 },
  operacao: { dc_flag: 1.8, history: 1.5 },
  'n/a': { ignore: 0.4 },

  // Histórico / Textos descritivos
  historico: { history: 4.5 },
  descricao: { history: 4.2 },
  desc: { history: 3.5 },
  titulo: { history: 3.8 },
  documento: { history: 3.5 },
  doc: { history: 3.2 },
  nf: { history: 3.5 },
  nota: { history: 3.0 },
  tipo: { history: 3.2 },
  // Identificadores (nº do lançamento/documento) — nunca são montantes.
  lancto: { history: 1.2, ignore: 1.2 },
  lcto: { history: 1.2, ignore: 1.2 },
  numero: { ignore: 1.8 },
  nro: { ignore: 1.8 },
  sequencia: { ignore: 2.0 },
  seq: { ignore: 2.0 },
  fornecedor: { history: 4.2 },
  cliente: { history: 4.2 },
  favorecido: { history: 4.2 },
  beneficiario: { history: 4.0 },
  sacado: { history: 3.8 },
  pagador: { history: 3.8 },
  local: { history: 3.8 },
  centro: { history: 3.8 },
  custo: { history: 3.8 },
  natureza: { history: 4.0 },
  categoria: { history: 3.8 },
  classificacao: { history: 3.5 },
  plano: { history: 3.0 },
  contas: { history: 2.8 },
  observacao: { history: 3.8 },
  observacoes: { history: 3.6 },
  obs: { history: 3.5 },
  complemento: { history: 3.8 },
  detalhe: { history: 3.5 },
  detalhes: { history: 3.5 },
  parcela: { history: 3.2 },
  obra: { history: 3.5 },
  projeto: { history: 3.5 },
  banco: { history: 2.5 },
  conta: { history: 2.5 },
  agencia: { history: 2.0 },
  forma: { history: 2.4 },
  pix: { history: 2.6 },
  boleto: { history: 2.6 },
  cheque: { history: 2.6 },
  documento_fiscal: { history: 2.4 },

  // Ignorar (saldos, totais acumulados)
  saldo: { ignore: 4.8 },
  acumulado: { ignore: 4.2 },
  subtotal: { ignore: 4.0 },
  anterior: { ignore: 2.5 },
  disponivel: { ignore: 2.2 },
};

function createDefaultMemory() {
  return {
    version: MEMORY_VERSION,
    tokenWeights: JSON.parse(JSON.stringify(BASE_TOKEN_WEIGHTS)),
    learnedProfiles: [],
    learningLog: [
      {
        id: 'init-1',
        timestamp: new Date().toISOString(),
        type: 'system_init',
        message: 'Motor de IA Adaptativa inicializado com ontologia financeira PT-BR.',
        details: 'Pronto para detectar novos layouts, aprender correções e memorizar regras.',
      },
    ],
    stats: {
      totalFilesProcessed: 0,
      autoMatchedCount: 0,
      correctionsLearned: 0,
    },
    optionalLlm: {
      provider: 'none',
      apiKey: '',
      model: '',
    },
    // Conciliação de clientes/fornecedores (PDF Questor): apelidos de histórico
    // já ligados a um contato, pesos por contato e a última vez que foi usada.
    counterparties: emptyCounterparties(),
  };
}

function clampWeight(value) {
  return Math.max(MIN_TOKEN_WEIGHT, Math.min(MAX_TOKEN_WEIGHT, round2(value)));
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasLocalStorage() {
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null;
  } catch {
    return false;
  }
}

/** Mantém apenas as chaves conhecidas e com peso numérico válido. */
function sanitizeTokenWeights(rawWeights) {
  const merged = JSON.parse(JSON.stringify(BASE_TOKEN_WEIGHTS));
  if (!isPlainObject(rawWeights)) return merged;

  for (const [token, roles] of Object.entries(rawWeights)) {
    if (!isPlainObject(roles)) continue;
    const cleanToken = normalizeText(token).slice(0, 40);
    if (!cleanToken) continue;

    const target = merged[cleanToken] ? { ...merged[cleanToken] } : {};
    let applied = false;
    for (const [role, weight] of Object.entries(roles)) {
      const numeric = Number(weight);
      if (!ALL_ROLES.includes(role) || !Number.isFinite(numeric)) continue;
      target[role] = clampWeight(numeric);
      applied = true;
    }
    if (applied) merged[cleanToken] = target;
  }
  return merged;
}

/** Normaliza um perfil aprendido vindo do localStorage ou de um backup JSON. */
function sanitizeProfile(rawProfile) {
  if (!isPlainObject(rawProfile)) return null;
  const mappings = Array.isArray(rawProfile.mappings)
    ? rawProfile.mappings
        .filter((mapping) => isPlainObject(mapping) && ALL_ROLES.includes(mapping.role))
        .map((mapping, index) => ({
          header: cleanWhitespace(mapping.header),
          role: mapping.role,
          historyOrder: Number.isFinite(mapping.historyOrder) ? mapping.historyOrder : index + 1,
        }))
        .filter((mapping) => mapping.header)
    : [];

  if (mappings.length === 0) return null;

  const headers = Array.isArray(rawProfile.headers)
    ? rawProfile.headers.map((header) => normalizeText(header)).filter(Boolean)
    : mappings.map((mapping) => normalizeText(mapping.header));

  const rules = isPlainObject(rawProfile.rules)
    ? {
        defaultSign: ['auto', 'negative', 'positive'].includes(rawProfile.rules.defaultSign)
          ? rawProfile.rules.defaultSign
          : 'auto',
        removePipes: rawProfile.rules.removePipes !== false,
        collapseSpaces: rawProfile.rules.collapseSpaces !== false,
        customReplaceFrom: String(rawProfile.rules.customReplaceFrom ?? ''),
        customReplaceTo: String(rawProfile.rules.customReplaceTo ?? ''),
      }
    : defaultRules('auto');

  return {
    id: String(rawProfile.id || `prof-imported-${Math.random().toString(36).slice(2, 8)}`),
    name: cleanWhitespace(rawProfile.name) || 'Layout importado',
    fileType: rawProfile.fileType === 'pdf' ? 'pdf' : 'xlsx',
    headers,
    mappings,
    rules,
    usageCount: Math.max(1, Number(rawProfile.usageCount) || 1),
    correctionsCount: Math.max(0, Number(rawProfile.correctionsCount) || 0),
    createdAt: rawProfile.createdAt || new Date().toISOString(),
    lastUsedAt: rawProfile.lastUsedAt || new Date().toISOString(),
  };
}

function defaultRules(defaultSign = 'auto') {
  return {
    defaultSign,
    removePipes: true,
    collapseSpaces: true,
    customReplaceFrom: '',
    customReplaceTo: '',
  };
}

export function loadAiMemory() {
  try {
    if (!hasLocalStorage()) return createDefaultMemory();
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return adoptLegacyMemory() || createDefaultMemory();
    return normalizeMemory(JSON.parse(raw));
  } catch {
    return createDefaultMemory();
  }
}

/** Lista as chaves do armazenamento (Storage nativo ou dublê de teste). */
function storageKeys(store) {
  const keys = [];
  try {
    if (typeof store.key === 'function' && typeof store.length === 'number') {
      for (let index = 0; index < store.length; index += 1) {
        const key = store.key(index);
        if (typeof key === 'string') keys.push(key);
      }
      return keys;
    }
  } catch {
    /* cai no plano B */
  }
  try {
    return Object.keys(store);
  } catch {
    return [];
  }
}

/**
 * Migração silenciosa: se a memória estiver só numa chave antiga, ela é lida,
 * normalizada e regravada na chave atual — a antiga fica intacta como reserva.
 */
function adoptLegacyMemory() {
  try {
    if (!hasLocalStorage()) return null;
    for (const key of storageKeys(localStorage)) {
      if (key === STORAGE_KEY || !LEGACY_MEMORY_KEY.test(key)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      const adopted = normalizeMemory(parsed);
      saveAiMemory(adopted);
      return adopted;
    }
  } catch {
    /* qualquer falha aqui só significa "começar do zero" */
  }
  return null;
}

/**
 * Valida e normaliza qualquer objeto de memória (localStorage ou backup JSON).
 * Nunca lança: em caso de payload inválido devolve a memória padrão.
 */
export function normalizeMemory(rawMemory) {
  if (!isPlainObject(rawMemory)) return createDefaultMemory();

  const profiles = Array.isArray(rawMemory.learnedProfiles)
    ? rawMemory.learnedProfiles
        .map(sanitizeProfile)
        .filter(Boolean)
        .slice(0, MAX_PROFILES)
    : [];

  const log = Array.isArray(rawMemory.learningLog)
    ? rawMemory.learningLog
        .filter((entry) => isPlainObject(entry) && entry.message)
        .slice(0, MAX_LOG_ENTRIES)
        .map((entry, index) => ({
          id: String(entry.id || `log-imported-${index}`),
          timestamp: entry.timestamp || new Date().toISOString(),
          type: String(entry.type || 'info'),
          message: String(entry.message),
          details: String(entry.details ?? ''),
        }))
    : [];

  const stats = isPlainObject(rawMemory.stats) ? rawMemory.stats : {};
  const llm = isPlainObject(rawMemory.optionalLlm) ? rawMemory.optionalLlm : {};

  return {
    version: MEMORY_VERSION,
    tokenWeights: sanitizeTokenWeights(rawMemory.tokenWeights),
    learnedProfiles: profiles,
    learningLog: log.length > 0 ? log : createDefaultMemory().learningLog,
    stats: {
      totalFilesProcessed: Math.max(0, Number(stats.totalFilesProcessed) || 0),
      autoMatchedCount: Math.max(0, Number(stats.autoMatchedCount) || 0),
      correctionsLearned: Math.max(0, Number(stats.correctionsLearned) || 0),
    },
    optionalLlm: {
      provider: ['none', 'openai', 'gemini'].includes(llm.provider) ? llm.provider : 'none',
      apiKey: typeof llm.apiKey === 'string' ? llm.apiKey : '',
      model: typeof llm.model === 'string' ? llm.model : '',
    },
    counterparties: sanitizeCounterparties(rawMemory.counterparties),
  };
}

/** Salva a memória. Retorna false se o navegador não permitir (modo privado, cota etc.). */
export function saveAiMemory(memory) {
  if (!hasLocalStorage()) return false;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(memory));
    return true;
  } catch (error) {
    console.warn('Não foi possível salvar a memória da IA no localStorage:', error);
    return false;
  }
}

export function resetAiMemory() {
  const fresh = createDefaultMemory();
  saveAiMemory(fresh);
  return fresh;
}

/* -------------------------------------------------------------------------- */
/*                        Estatística das colunas                              */
/* -------------------------------------------------------------------------- */

function isDcText(text) {
  return /^(d|c|deb|debito|cred|credito|entrada|saida|pago|recebido|pagar|receber)$/.test(
    normalizeText(text)
  );
}

/**
 * Calcula estatísticas semânticas de cada coluna a partir de uma amostra de linhas.
 * Datas nativas (Date) são contadas como data; números, como valor monetário.
 */
export function computeColumnProfiles(headers, rows, { sampleSize = 120 } = {}) {
  const sample = rows.slice(0, sampleSize);
  const totalRows = Math.max(1, sample.length);

  return headers.map((header, colIdx) => {
    let nonEmpty = 0;
    let dateCount = 0;
    let moneyCount = 0;
    let negCount = 0;
    let posCount = 0;
    let explicitSignCount = 0;
    let dcCount = 0;
    let totalLen = 0;
    let integerCount = 0;
    let nonZeroCount = 0;
    let sequencePairs = 0;
    let sequenceRises = 0;
    let lastMoney = null;
    const uniqueSet = new Set();
    const samples = [];
    const moneyValues = [];

    for (const row of sample) {
      const cell = row?.[colIdx];
      const text = cell instanceof Date ? formatIsoToBrDate(parseDateValue(cell)) : cleanWhitespace(cell);
      if (!text) continue;

      nonEmpty++;
      totalLen += text.length;
      uniqueSet.add(text);
      if (samples.length < 4 && !samples.includes(text)) samples.push(text);

      if (cell instanceof Date || (typeof cell === 'string' && parseDateValue(cell) !== null)) {
        dateCount++;
        continue;
      }

      const money = cell == null ? null : parseMoneyValue(cell);
      if (money !== null) {
        moneyCount++;
        moneyValues.push(money.value);
        if (money.value < 0) negCount++;
        if (money.value > 0) posCount++;
        if (money.hasExplicitSign) explicitSignCount++;
        if (Number.isInteger(money.value)) integerCount++;
        if (money.value !== 0) nonZeroCount++;
        // Sequências (1, 2, 3...) crescem linha a linha; montantes, não.
        if (lastMoney !== null) {
          sequencePairs++;
          if (money.value > lastMoney) sequenceRises++;
        }
        lastMoney = money.value;
      } else if (isDcText(text)) {
        dcCount++;
        lastMoney = null;
      } else {
        lastMoney = null;
      }
    }

    const active = Math.max(1, nonEmpty);

    return {
      colIdx,
      header,
      normHeader: normalizeText(header),
      tokens: tokenizeHeader(header),
      nonEmpty,
      nonEmptyRatio: nonEmpty / totalRows,
      pctDate: dateCount / active,
      pctMoney: moneyCount / active,
      pctNegative: negCount / active,
      pctPositive: posCount / active,
      pctExplicitSign: explicitSignCount / Math.max(1, moneyCount),
      pctDC: dcCount / active,
      avgLen: totalLen / active,
      uniqueRatio: uniqueSet.size / active,
      // Fração de linhas com valor diferente de zero (uma coluna de "Débito"
      // preenchida com 0,00 nas linhas de crédito continua esparsa na prática).
      pctNonZeroMoney: nonZeroCount / totalRows,
      // Fração de valores "redondos" (sem centavos) — típico de documentos/IDs.
      integerMoneyRatio: moneyCount ? integerCount / moneyCount : 0,
      // Fração de pares consecutivos crescentes — típico de numeração sequencial.
      sequenceRatio: sequencePairs ? sequenceRises / sequencePairs : 0,
      samples,
      moneyCount,
      dateCount,
      moneyValues,
    };
  });
}

/* -------------------------------------------------------------------------- */
/*                         Classificação de papéis                            */
/* -------------------------------------------------------------------------- */

/**
 * Sequência numérica (1, 2, 3...): inteiros, sem sinal e crescentes.
 * Relatórios agrupados reiniciam a numeração a cada grupo, por isso a
 * unicidade não é exigida — só o padrão de crescimento.
 */
function looksLikeSequenceColumn(colStat) {
  return (
    colStat.moneyCount >= 5 &&
    colStat.integerMoneyRatio >= 0.99 &&
    colStat.pctExplicitSign === 0 &&
    colStat.sequenceRatio >= 0.8
  );
}

/**
 * Coluna de identificação (nº do lançamento, documento, código): parece valor
 * pelos dados, mas nunca é montante.
 */
function isIdentifierColumn(colStat) {
  if (!colStat) return false;
  if (AMOUNT_HEADER_RE.test(colStat.normHeader)) return false;
  return (
    SEQUENCE_HEADER_RE.test(colStat.normHeader) ||
    DOCUMENT_HEADER_RE.test(colStat.normHeader) ||
    looksLikeSequenceColumn(colStat)
  );
}

/**
 * Pontua cada função candidata combinando pesos léxicos aprendidos e evidência
 * estatística extraída dos dados reais da coluna.
 */
export function scoreColumnRoles(colStat, tokenWeights) {
  const scores = {
    [ROLES.DATE]: 0,
    [ROLES.VALUE_AUTO]: 0,
    [ROLES.VALUE_OUT]: 0,
    [ROLES.VALUE_IN]: 0,
    [ROLES.DC_FLAG]: 0,
    [ROLES.HISTORY]: 0,
    [ROLES.IGNORE]: 0,
  };

  // 1) Evidência léxica (vocabulário aprendido).
  for (const token of colStat.tokens) {
    const weights = tokenWeights?.[token];
    if (!weights) continue;
    for (const [role, weight] of Object.entries(weights)) {
      if (scores[role] !== undefined) scores[role] += Number(weight) || 0;
    }
  }

  // 2) Cabeçalhos compostos ("D/C", "Valor Líquido") contam uma única vez.
  const compoundKey = colStat.normHeader;
  if (tokenWeights?.[compoundKey] && !colStat.tokens.includes(compoundKey)) {
    for (const [role, weight] of Object.entries(tokenWeights[compoundKey])) {
      if (scores[role] !== undefined) scores[role] += (Number(weight) || 0) * 0.8;
    }
  }

  // 3) Evidência estatística.
  if (colStat.pctDate >= 0.65) scores[ROLES.DATE] += 6.5;
  else if (colStat.pctDate >= 0.3) scores[ROLES.DATE] += 2.5;
  else scores[ROLES.DATE] -= 3;

  // Data do fato (recebimento/pagamento/movimento) vale mais que vencimento.
  if (colStat.pctDate >= 0.3) {
    if (EVENT_DATE_HEADER_RE.test(colStat.normHeader)) scores[ROLES.DATE] += 3;
    else if (DUE_DATE_HEADER_RE.test(colStat.normHeader)) scores[ROLES.DATE] -= 1.5;
  }

  const looksLikeBalance =
    /\b(saldo|acumulado|subtotal|total)\b/.test(colStat.normHeader) && !/valor/.test(colStat.normHeader);

  if (colStat.pctMoney >= 0.6) {
    scores[ROLES.VALUE_AUTO] += 5;
    scores[ROLES.VALUE_OUT] += 4.2;
    scores[ROLES.VALUE_IN] += 4.2;
    if (colStat.pctNegative >= 0.8 && colStat.pctExplicitSign >= 0.8) {
      scores[ROLES.VALUE_AUTO] += 1.5;
    }
    if (looksLikeBalance) scores[ROLES.IGNORE] += 5;
  } else if (colStat.pctMoney >= 0.2 && colStat.nonEmptyRatio < 0.85) {
    // Coluna esparsa: típico de Crédito/Débito separados.
    scores[ROLES.VALUE_AUTO] += 2.5;
    scores[ROLES.VALUE_OUT] += 2.8;
    scores[ROLES.VALUE_IN] += 2.8;
  } else {
    scores[ROLES.VALUE_AUTO] -= 3.5;
    scores[ROLES.VALUE_OUT] -= 3.5;
    scores[ROLES.VALUE_IN] -= 3.5;
  }

  // 3.1) Identificadores: "Lancto", "Documento", "Nº" e sequências numéricas
  // (inteiros e crescentes) nunca são montantes — sem esta penalidade,
  // somaríamos o número do lançamento ao valor da linha.
  const isAmountHeader = AMOUNT_HEADER_RE.test(colStat.normHeader);
  const looksLikeIdentifier = isIdentifierColumn(colStat);

  // 3.2) Em relatórios de contas recebidas/pagas convivem o valor previsto
  // (vencimento) e o realizado (recebido/pago): o realizado é o que importa.
  if (!isAmountHeader && FORECAST_AMOUNT_RE.test(colStat.normHeader)) {
    for (const role of VALUE_ROLES) scores[role] -= 3;
    scores[ROLES.IGNORE] += 1.5;
  }
  if (REALIZED_AMOUNT_RE.test(colStat.normHeader)) {
    scores[ROLES.VALUE_AUTO] += 2;
    scores[ROLES.VALUE_OUT] += 1;
    scores[ROLES.VALUE_IN] += 1;
  }

  if (looksLikeIdentifier) {
    for (const role of VALUE_ROLES) scores[role] -= 7;
    if (SEQUENCE_HEADER_RE.test(colStat.normHeader) || looksLikeSequenceColumn(colStat)) {
      scores[ROLES.IGNORE] += 3.2;
    }
    scores[ROLES.HISTORY] += 1.5;
  }

  if (colStat.pctDC >= 0.7 && colStat.avgLen <= 8) scores[ROLES.DC_FLAG] += 5.5;

  // Textos descritivos são candidatos naturais a histórico.
  if (colStat.pctDate < 0.2 && colStat.pctMoney < 0.2 && colStat.pctDC < 0.5) {
    scores[ROLES.HISTORY] += 3.5;
    if (colStat.avgLen >= 8) scores[ROLES.HISTORY] += 1.5;
  }

  if (looksLikeBalance && colStat.pctMoney < 0.2) scores[ROLES.IGNORE] += 2.5;

  // Coluna sem nenhum dado é sempre ignorada.
  if (colStat.nonEmpty === 0) scores[ROLES.IGNORE] += 20;

  return scores;
}

function headerSimilarity(headerA, headerB) {
  if (!headerA && !headerB) return 1;
  if (normalizeText(headerA) === normalizeText(headerB)) return 1;
  const tokensA = new Set(tokenizeHeader(headerA));
  const tokensB = new Set(tokenizeHeader(headerB));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const token of tokensA) if (tokensB.has(token)) intersection++;
  const union = new Set([...tokensA, ...tokensB]).size;
  return intersection / union;
}

function computeProfileMatchScore(headers, fileType, profile) {
  const current = headers.map((header) => normalizeText(header)).filter(Boolean);
  const stored = (profile.headers || []).map((header) => normalizeText(header)).filter(Boolean);
  if (current.length === 0 || stored.length === 0) return 0;

  const coverage = (from, to) => {
    let total = 0;
    for (const header of from) {
      let best = 0;
      for (const other of to) best = Math.max(best, headerSimilarity(header, other));
      total += best;
    }
    return total / from.length;
  };

  const precision = coverage(current, stored);
  const recall = coverage(stored, current);
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const typeBonus = profile.fileType === fileType ? 0.03 : 0;
  return Math.min(1, f1 + typeBonus);
}

/**
 * Infere o sinal padrão do documento pelo nome do arquivo, banners e cabeçalhos.
 */
export function inferDocumentDefaultSign(parsedFile, colProfiles) {
  const fileName = parsedFile?.fileName || '';
  const bannerLines = Array.isArray(parsedFile?.bannerLines) ? parsedFile.bannerLines : [];
  const headers = Array.isArray(parsedFile?.headers) ? parsedFile.headers : [];
  const context = normalizeText([fileName, ...bannerLines, ...headers].join(' '));

  const moneyColumns = (Array.isArray(colProfiles) ? colProfiles : []).filter(
    (column) => column.pctMoney >= 0.5 && !/\b(saldo|total|subtotal)\b/.test(column.normHeader)
  );
  if (moneyColumns.some((column) => column.pctNegative > 0.05)) return 'auto';

  const hasOutHint = /\b(pagamento|pagamentos|pago|pagar|a pagar|despesa|despesas|saidas|debito)\b/.test(
    context
  );
  const hasInHint = /\b(recebimento|recebimentos|recebido|receber|a receber|receita|entradas|credito)\b/.test(
    context
  );

  if (hasOutHint && !hasInHint) return 'negative';
  if (hasInHint && !hasOutHint) return 'positive';
  return 'auto';
}

/* -------------------------------------------------------------------------- */
/*                       Análise de layout do arquivo                         */
/* -------------------------------------------------------------------------- */

function pickWinner(scores) {
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [role, topScore] = ranked[0];
  return { role, topScore, margin: topScore - ranked[1][1] };
}

/* -------------------------------------------------------------------------- */
/*                   Pares de colunas: entradas × saídas                      */
/* -------------------------------------------------------------------------- */

/**
 * Bancos e sistemas contábeis costumam separar o movimento em duas colunas
 * ("Pagto./Recbto.", "Débito/Crédito", "Saídas/Entradas"): cada linha traz o
 * valor em UMA delas. Sem reconhecer o par, as duas viram "valor (+/-)" e os
 * montantes são somados — produzindo números sem nenhum sentido.
 *
 * Aqui detectamos o par pela estrutura dos dados (exclusividade mútua entre as
 * duas colunas) e decidimos qual é saída e qual é entrada por três sinais, em
 * ordem de confiança: correlação com a coluna de saldo, semântica do cabeçalho
 * e, por último, a posição (coluna mais à esquerda = saída).
 */

/** Valor monetário "com conteúdo" (ignora vazio e zeros). */
function meaningfulMoney(cell) {
  const money = parseMoneyValue(cell);
  if (money === null) return null;
  const value = Math.abs(money.value);
  return value === 0 ? null : value;
}

function isBalanceColumn(colStat) {
  if (!colStat) return false;
  return BALANCE_HEADER_RE.test(colStat.normHeader) && !/valor/.test(colStat.normHeader);
}

/** Coluna que pode fazer parte de um par entradas × saídas. */
function isPairCandidate(colStat, role) {
  if (!colStat || role === ROLES.DATE) return false;
  if (isBalanceColumn(colStat)) return false;
  if (colStat.moneyCount < 3) return false;
  if (colStat.pctMoney < 0.4) return false;
  // Uma coluna praticamente sempre preenchida (com valor real, sem zeros)
  // representa o valor da linha sozinha — não é metade de um par.
  const meaningfulRatio = Number.isFinite(colStat.pctNonZeroMoney)
    ? colStat.pctNonZeroMoney
    : colStat.nonEmptyRatio;
  return meaningfulRatio <= 0.97;
}

/** Evidência léxica de saída/entrada de uma coluna. */
function lexicalSignEvidence(colStat, tokenWeights) {
  const evidence = { out: 0, in: 0 };
  const add = (token, factor = 1) => {
    const weights = tokenWeights?.[token];
    if (!weights) return;
    evidence.out += (Number(weights[ROLES.VALUE_OUT]) || 0) * factor;
    evidence.in += (Number(weights[ROLES.VALUE_IN]) || 0) * factor;
  };
  for (const token of colStat.tokens || []) add(token);
  const compound = colStat.normHeader;
  if (tokenWeights?.[compound] && !(colStat.tokens || []).includes(compound)) {
    add(compound, 0.8);
  }
  return evidence;
}

/** Quão exclusivas são duas colunas (cada linha preenche só uma delas). */
function pairExclusivity(rows, idxA, idxB) {
  let onlyA = 0;
  let onlyB = 0;
  let both = 0;

  for (const row of rows) {
    const a = meaningfulMoney(row?.[idxA]) !== null;
    const b = meaningfulMoney(row?.[idxB]) !== null;
    if (a && b) both++;
    else if (a) onlyA++;
    else if (b) onlyB++;
  }

  const total = onlyA + onlyB + both;
  return {
    onlyA,
    onlyB,
    both,
    total,
    exclusivity: total ? (onlyA + onlyB) / total : 0,
  };
}

/**
 * Descobre o sentido de cada coluna comparando a variação do saldo entre
 * linhas consecutivas com o valor lançado — o sinal mais confiável de todos,
 * porque vem dos dados e não do texto do cabeçalho.
 */
function inferPairDirectionFromBalance(rows, idxA, idxB, balanceIdx) {
  if (balanceIdx == null) return null;

  let previous = null;
  let votesA = 0;
  let votesB = 0;

  for (const row of rows) {
    const balance = parseMoneyValue(row?.[balanceIdx]);
    const current = balance === null ? null : round2(balance.value);
    if (current === null) continue;

    if (previous !== null) {
      const delta = round2(current - previous);
      const a = meaningfulMoney(row?.[idxA]) || 0;
      const b = meaningfulMoney(row?.[idxB]) || 0;
      const tolerance = 0.05;

      if (a > 0 && b === 0) {
        if (Math.abs(delta - a) <= tolerance) votesA += 1;
        else if (Math.abs(delta + a) <= tolerance) votesA -= 1;
      } else if (b > 0 && a === 0) {
        if (Math.abs(delta - b) <= tolerance) votesB += 1;
        else if (Math.abs(delta + b) <= tolerance) votesB -= 1;
      }
    }

    previous = current;
  }

  const informative = Math.abs(votesA) + Math.abs(votesB);
  if (informative < 4) return null;

  // Votos positivos = a coluna aumenta o saldo (entrada/crédito).
  const aIsCredit = votesA >= 2 && votesB <= -2;
  const bIsCredit = votesB >= 2 && votesA <= -2;
  if (!aIsCredit && !bIsCredit) return null;

  return aIsCredit
    ? { outIdx: idxB, inIdx: idxA, method: 'balance', strength: informative }
    : { outIdx: idxA, inIdx: idxB, method: 'balance', strength: informative };
}

function resolvePairDirection(colStats, idxA, idxB, rows, balanceIdx, tokenWeights) {
  const fromBalance = inferPairDirectionFromBalance(rows, idxA, idxB, balanceIdx);
  if (fromBalance) return fromBalance;

  const evidenceA = lexicalSignEvidence(colStats[idxA], tokenWeights);
  const evidenceB = lexicalSignEvidence(colStats[idxB], tokenWeights);
  const aAsOut = evidenceA.out + evidenceB.in; // A = saída, B = entrada
  const bAsOut = evidenceA.in + evidenceB.out; // A = entrada, B = saída

  if (Math.abs(aAsOut - bAsOut) >= 0.5) {
    const strength = Math.abs(aAsOut - bAsOut);
    return aAsOut > bAsOut
      ? { outIdx: idxA, inIdx: idxB, method: 'lexical', strength }
      : { outIdx: idxB, inIdx: idxA, method: 'lexical', strength };
  }

  // Convenção mais comum nos extratos brasileiros: débito à esquerda.
  return {
    outIdx: Math.min(idxA, idxB),
    inIdx: Math.max(idxA, idxB),
    method: 'position',
    strength: 0,
  };
}

/**
 * Encontra pares de colunas que representam entradas e saídas separadamente.
 * @returns {Array<{outIdx:number,inIdx:number,method:string,exclusivity:number}>}
 */
export function detectCreditDebitPairs(mappings, rows, tokenWeights) {
  const safeMappings = Array.isArray(mappings) ? mappings : [];
  const safeRows = Array.isArray(rows) ? rows : [];
  const colStats = safeMappings.map((mapping) => mapping.stats);

  const candidates = safeMappings
    .filter((mapping) => isPairCandidate(mapping.stats, mapping.role))
    .map((mapping) => mapping.colIdx);
  if (candidates.length < 2) return [];

  const balanceCandidates = safeMappings.filter(
    (mapping) => isBalanceColumn(mapping.stats) && mapping.stats.moneyCount >= 3
  );
  balanceCandidates.sort((a, b) => b.stats.nonEmptyRatio - a.stats.nonEmptyRatio);
  const balanceIdx = balanceCandidates.length > 0 ? balanceCandidates[0].colIdx : null;

  const scored = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const info = pairExclusivity(safeRows, candidates[i], candidates[j]);
      if (info.total < 6) continue;
      if (info.onlyA < 2 || info.onlyB < 2) continue;
      if (info.exclusivity < 0.85) continue;
      scored.push({ a: candidates[i], b: candidates[j], info });
    }
  }
  if (scored.length === 0) return [];

  scored.sort(
    (first, second) =>
      second.info.exclusivity - first.info.exclusivity || second.info.total - first.info.total
  );

  const used = new Set();
  const pairs = [];
  for (const entry of scored) {
    if (used.has(entry.a) || used.has(entry.b)) continue;
    const direction = resolvePairDirection(
      colStats,
      entry.a,
      entry.b,
      safeRows,
      balanceIdx,
      tokenWeights
    );
    used.add(entry.a);
    used.add(entry.b);
    pairs.push({ ...direction, exclusivity: entry.info.exclusivity, coverage: entry.info.total });
  }
  return pairs;
}

const PAIR_REASON = {
  balance: (other) => `Par entradas/saídas com "${other}" — sinal confirmado pelo saldo`,
  lexical: (other) => `Par entradas/saídas com "${other}" — reconhecido pelo cabeçalho`,
  position: (other) => `Par entradas/saídas com "${other}" — sentido presumido pela posição`,
};

const PAIR_CONFIDENCE = { balance: 93, lexical: 90, position: 70 };

/**
 * Analisa um arquivo extraído (.pdf ou .xlsx) usando a memória da IA.
 * Retorna o mapeamento sugerido, a confiança e as mudanças de layout detectadas.
 */
export function analyzeFileLayout(parsedFile, memory) {
  const safeMemory = memory || createDefaultMemory();
  const headers = Array.isArray(parsedFile.headers) ? parsedFile.headers : [];
  const rows = Array.isArray(parsedFile.rows) ? parsedFile.rows : [];

  const colStats = computeColumnProfiles(headers, rows);
  const defaultSign = inferDocumentDefaultSign(parsedFile, colStats);

  // 1) Melhor perfil memorizado.
  let matchedProfile = null;
  let bestScore = 0;
  for (const profile of safeMemory.learnedProfiles || []) {
    const similarity = computeProfileMatchScore(headers, parsedFile.fileType, profile);
    if (similarity > bestScore) {
      bestScore = similarity;
      matchedProfile = profile;
    }
  }
  const isExactMatch = bestScore >= 0.96;
  const isEvolvedMatch = !!matchedProfile && !isExactMatch && bestScore >= 0.65;
  if (!isExactMatch && !isEvolvedMatch) matchedProfile = null;

  const changesDetected = [];
  const warnings = [];
  const roleScoresList = colStats.map((stats) => scoreColumnRoles(stats, safeMemory.tokenWeights));
  const usedProfileHeaders = new Set();
  const mappings = [];

  for (let idx = 0; idx < colStats.length; idx++) {
    const stats = colStats[idx];
    const scores = roleScoresList[idx];

    if (stats.nonEmpty === 0) {
      mappings.push({
        colIdx: idx,
        header: stats.header,
        role: ROLES.IGNORE,
        historyOrder: 0,
        confidence: 100,
        source: 'semantic_ai',
        changeType: null,
        reason: 'Coluna vazia',
        stats,
        scores,
      });
      continue;
    }

    let predictedRole = ROLES.HISTORY;
    let predictedHistoryOrder = 0;
    let confidence = 0;
    let source = 'semantic_ai';
    let changeType = null;
    let reason = '';

    if (matchedProfile) {
      let bestProfileMapping = null;
      let bestSimilarity = 0;
      for (const profileMapping of matchedProfile.mappings) {
        const similarity = headerSimilarity(stats.normHeader, profileMapping.header);
        if (similarity > bestSimilarity) {
          bestSimilarity = similarity;
          bestProfileMapping = profileMapping;
        }
      }

      if (bestProfileMapping && bestSimilarity >= 0.72) {
        predictedRole = bestProfileMapping.role;
        predictedHistoryOrder = bestProfileMapping.historyOrder || 0;
        confidence = Math.round(Math.min(99, 55 + bestSimilarity * 44));
        source = 'learned_profile';
        reason = `Reconhecida no perfil "${matchedProfile.name}"`;
        usedProfileHeaders.add(bestProfileMapping.header);
        if (bestSimilarity < 1) {
          changeType = 'renamed';
          changesDetected.push(`Coluna adaptada: "${bestProfileMapping.header}" → "${stats.header}"`);
        }
      } else {
        changeType = 'added';
        changesDetected.push(`Nova coluna detectada: "${stats.header}"`);
      }
    }

    if (source === 'semantic_ai') {
      const winner = pickWinner(scores);
      predictedRole = winner.role;
      confidence = Math.max(40, Math.min(97, Math.round(52 + winner.margin * 7)));
      if (winner.role === ROLES.IGNORE) {
        reason = isIdentifierColumn(stats)
          ? 'Coluna de identificação (nº/sequência) — não é valor'
          : isBalanceColumn(stats)
            ? 'Padrão típico de saldo/total'
            : 'Sem papel definido — coluna ignorada';
      } else {
        reason = `Maior evidência semântica (${winner.topScore.toFixed(1)} pts)`;
      }
    }

    mappings.push({
      colIdx: idx,
      header: stats.header,
      role: predictedRole,
      historyOrder: predictedHistoryOrder,
      confidence,
      source,
      changeType,
      reason,
      stats,
      scores,
    });
  }

  // 2) Garantias globais: ao menos uma data e ao menos um valor.
  const dateMappings = mappings.filter((mapping) => mapping.role === ROLES.DATE);
  if (dateMappings.length === 0) {
    let bestIdx = -1;
    let bestValue = -Infinity;
    mappings.forEach((mapping, index) => {
      if (mapping.stats.nonEmpty === 0) return;
      if (mapping.scores[ROLES.DATE] > bestValue) {
        bestValue = mapping.scores[ROLES.DATE];
        bestIdx = index;
      }
    });
    if (bestIdx >= 0 && bestValue > -Infinity) {
      mappings[bestIdx].role = ROLES.DATE;
      mappings[bestIdx].confidence = Math.max(55, mappings[bestIdx].confidence);
      warnings.push(
        `Nenhuma coluna de data teve evidência forte; usando "${mappings[bestIdx].header}".`
      );
    }
  } else if (dateMappings.length > 1) {
    // Mantém a data do fato (ou a de maior evidência). As demais são previsão
    // (vencimento) e não entram no histórico — senão todo lançamento ficaria
    // com uma data extra colada na descrição.
    dateMappings.sort((a, b) => b.scores[ROLES.DATE] - a.scores[ROLES.DATE]);
    for (let i = 1; i < dateMappings.length; i++) {
      dateMappings[i].role = ROLES.IGNORE;
      dateMappings[i].reason = `Data secundária ("${dateMappings[i].header}") — não entra no histórico`;
    }
    warnings.push(
      `Mais de uma coluna parece data; foi usada "${dateMappings[0].header}". ` +
        'Se precisar da outra no histórico, mude a função dela.'
    );
  }

  // 2.1) Colunas separadas de entradas e saídas (débito × crédito): cada linha
  // traz o valor em uma OU outra. Reconhecer o par evita somar as duas colunas.
  const creditDebitPairs = detectCreditDebitPairs(mappings, rows, safeMemory.tokenWeights);
  for (const pair of creditDebitPairs) {
    const outMapping = mappings.find((mapping) => mapping.colIdx === pair.outIdx);
    const inMapping = mappings.find((mapping) => mapping.colIdx === pair.inIdx);
    if (!outMapping || !inMapping) continue;

    const describe = PAIR_REASON[pair.method] || PAIR_REASON.position;
    const confidence = PAIR_CONFIDENCE[pair.method] || PAIR_CONFIDENCE.position;

    outMapping.role = ROLES.VALUE_OUT;
    outMapping.reason = describe(inMapping.header);
    outMapping.confidence = Math.max(outMapping.confidence, confidence);

    inMapping.role = ROLES.VALUE_IN;
    inMapping.reason = describe(outMapping.header);
    inMapping.confidence = Math.max(inMapping.confidence, confidence);

    if (pair.method === 'position') {
      warnings.push(
        `Não foi possível confirmar qual coluna é entrada e qual é saída (` +
          `"${outMapping.header}" × "${inMapping.header}"); confira o mapeamento.`
      );
    }
  }

  // 2.2) Somar duas colunas "valor (+/-)" é sempre um erro de leitura: mantém
  // apenas a de maior evidência e avisa o usuário.
  const autoValueMappings = mappings.filter((mapping) => mapping.role === ROLES.VALUE_AUTO);
  if (autoValueMappings.length > 1) {
    autoValueMappings.sort(
      (first, second) =>
        second.scores[ROLES.VALUE_AUTO] - first.scores[ROLES.VALUE_AUTO] ||
        second.confidence - first.confidence
    );
    const keptValue = autoValueMappings[0];
    for (const mapping of autoValueMappings.slice(1)) {
      mapping.role = ROLES.IGNORE;
      mapping.reason = `Segunda coluna de valor — ignorada (usando "${keptValue.header}")`;
      mapping.confidence = Math.min(mapping.confidence, 55);
      warnings.push(
        `Mais de uma coluna parecia valor; "${mapping.header}" foi ignorada e vale ` +
          `"${keptValue.header}". Ajuste o mapeamento se ela também precisar entrar no total.`
      );
    }
  }

  const hasValue = mappings.some((mapping) => VALUE_ROLES.includes(mapping.role));
  if (!hasValue) {
    let bestIdx = -1;
    let bestScore = -Infinity;
    mappings.forEach((mapping, index) => {
      if (mapping.role === ROLES.DATE || mapping.stats.nonEmpty === 0) return;
      const score = Math.max(...VALUE_ROLES.map((role) => mapping.scores[role]));
      if (score > bestScore) {
        bestScore = score;
        bestIdx = index;
      }
    });
    if (bestIdx >= 0) {
      mappings[bestIdx].role =
        defaultSign === 'negative'
          ? ROLES.VALUE_OUT
          : defaultSign === 'positive'
            ? ROLES.VALUE_IN
            : ROLES.VALUE_AUTO;
      mappings[bestIdx].confidence = Math.max(50, mappings[bestIdx].confidence);
      warnings.push(`Nenhuma coluna de valor clara; usando "${mappings[bestIdx].header}".`);
    } else {
      warnings.push('Não foi possível identificar uma coluna de valor.');
    }
  }

  if (!mappings.some((mapping) => mapping.role === ROLES.DATE)) {
    warnings.push('Nenhuma coluna de data identificada — o arquivo ficará sem lançamentos.');
  }

  const lowConfidence = mappings.filter(
    (mapping) => mapping.role !== ROLES.IGNORE && mapping.confidence < 65
  );
  if (lowConfidence.length > 0) {
    warnings.push(
      `${lowConfidence.length} coluna(s) com baixa confiança — revise o mapeamento antes de treinar.`
    );
  }

  // 3) Colunas do perfil que desapareceram.
  if (matchedProfile) {
    for (const profileMapping of matchedProfile.mappings) {
      const stillThere = [...usedProfileHeaders].some(
        (header) => headerSimilarity(header, profileMapping.header) >= 0.72
      );
      if (!stillThere) {
        changesDetected.push(`Coluna ausente do modelo anterior: "${profileMapping.header}"`);
      }
    }
  }

  // 4) Ordem do histórico: preserva a ordem aprendida no perfil e, para
  // colunas novas, mantém a ordem em que aparecem no arquivo.
  const historyMappings = mappings
    .map((mapping, index) => ({ mapping, index }))
    .filter((entry) => entry.mapping.role === ROLES.HISTORY)
    .sort(
      (a, b) =>
        (a.mapping.historyOrder || Number.MAX_SAFE_INTEGER) -
          (b.mapping.historyOrder || Number.MAX_SAFE_INTEGER) || a.index - b.index
    );

  historyMappings.forEach((entry, position) => {
    entry.mapping.historyOrder = position + 1;
  });
  for (const mapping of mappings) {
    if (mapping.role !== ROLES.HISTORY) mapping.historyOrder = 0;
  }

  const evaluated = mappings.filter((mapping) => mapping.role !== ROLES.IGNORE);
  const avgConfidence = evaluated.length
    ? Math.round(evaluated.reduce((sum, mapping) => sum + mapping.confidence, 0) / evaluated.length)
    : 0;

  const rules = matchedProfile
    ? { ...defaultRules(defaultSign), ...matchedProfile.rules }
    : defaultRules(defaultSign);

  const status = isExactMatch ? 'matched' : isEvolvedMatch ? 'evolved' : 'new_layout';

  return {
    status,
    matchedProfileId: matchedProfile?.id || null,
    matchedProfileName: matchedProfile?.name || null,
    matchSimilarity: Math.round(bestScore * 100),
    avgConfidence,
    changesDetected: [...new Set(changesDetected)],
    warnings,
    mappings,
    rules,
    defaultSign,
    aiPredictedRoles: mappings.map((mapping) => mapping.role),
  };
}

/* -------------------------------------------------------------------------- */
/*                          Aprendizado supervisionado                        */
/* -------------------------------------------------------------------------- */

function pruneTokens(tokenWeights) {
  const entries = Object.entries(tokenWeights);
  if (entries.length <= MAX_TOKENS) return tokenWeights;

  const scored = entries.map(([token, roles]) => {
    const score = Object.values(roles).reduce((sum, value) => sum + (Number(value) || 0), 0);
    const isBase = Object.prototype.hasOwnProperty.call(BASE_TOKEN_WEIGHTS, token);
    return { token, roles, score, keep: isBase };
  });

  // Mantém todo o vocabulário base + os tokens aprendidos com maior evidência.
  const learned = scored
    .filter((entry) => !entry.keep)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, MAX_TOKENS - scored.filter((entry) => entry.keep).length));

  const result = {};
  for (const entry of [...scored.filter((entry) => entry.keep), ...learned]) {
    result[entry.token] = entry.roles;
  }
  return result;
}

/**
 * Treina a IA com o mapeamento confirmado/corrigido pelo usuário:
 *  - reforça os tokens das colunas confirmadas e penaliza os errados;
 *  - cria ou atualiza o perfil do layout na memória;
 *  - registra o evento no log de aprendizado.
 *
 * Retorna a memória atualizada (não muta a original).
 */
export function trainAiWithLayout(parsedFile, currentAnalysis, layoutName, memory) {
  const updated = JSON.parse(JSON.stringify(memory || createDefaultMemory()));
  updated.learningLog = Array.isArray(updated.learningLog) ? updated.learningLog : [];
  updated.learnedProfiles = Array.isArray(updated.learnedProfiles) ? updated.learnedProfiles : [];
  updated.stats = updated.stats || {};
  updated.tokenWeights = updated.tokenWeights || {};

  const mappings = Array.isArray(currentAnalysis?.mappings) ? currentAnalysis.mappings : [];
  const predicted = Array.isArray(currentAnalysis?.aiPredictedRoles)
    ? currentAnalysis.aiPredictedRoles
    : [];

  const REINFORCE = 1.4;
  const CONFIRM = 0.45;
  const PENALTY = 0.7;
  let corrections = 0;

  for (let index = 0; index < mappings.length; index++) {
    const mapping = mappings[index];
    if (!mapping || !ALL_ROLES.includes(mapping.role) || mapping.role === ROLES.IGNORE) continue;

    const originalRole = predicted[index];
    const wasCorrected = !!originalRole && originalRole !== mapping.role;
    if (wasCorrected) corrections++;

    for (const token of tokenizeHeader(mapping.header)) {
      if (token.length < 2) continue;
      const roles = { ...(updated.tokenWeights[token] || {}) };
      roles[mapping.role] = clampWeight(
        (Number(roles[mapping.role]) || 0) + (wasCorrected ? REINFORCE : CONFIRM)
      );
      if (wasCorrected && roles[originalRole] !== undefined) {
        roles[originalRole] = clampWeight((Number(roles[originalRole]) || 0) - PENALTY);
      }
      updated.tokenWeights[token] = roles;
    }
  }

  updated.tokenWeights = pruneTokens(updated.tokenWeights);

  const profileMappings = mappings.map((mapping) => ({
    header: mapping.header,
    role: mapping.role,
    historyOrder: mapping.historyOrder || 0,
  }));
  const headerSignature = (parsedFile.headers || []).map((header) => normalizeText(header)).join('|');

  const cleanName =
    cleanWhitespace(layoutName) ||
    `${String(parsedFile.fileType || 'arq').toUpperCase()} — ${(parsedFile.headers || [])
      .slice(0, 3)
      .join(' / ')}`;

  const now = new Date().toISOString();
  const logEntry = (type, message, details) => ({
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: now,
    type,
    message,
    details,
  });

  // Reaproveita perfil idêntico (mesmo tipo + mesmas colunas) para não acumular duplicatas.
  const existingIndex = updated.learnedProfiles.findIndex((profile) => {
    if (currentAnalysis.matchedProfileId && profile.id === currentAnalysis.matchedProfileId) return true;
    const sameType = profile.fileType === parsedFile.fileType;
    const sameHeaders = (profile.headers || []).join('|') === headerSignature;
    return sameType && sameHeaders;
  });

  if (existingIndex >= 0) {
    const profile = updated.learnedProfiles[existingIndex];
    profile.name = cleanName || profile.name;
    profile.headers = (parsedFile.headers || []).map((header) => normalizeText(header));
    profile.mappings = profileMappings;
    profile.rules = { ...defaultRules(), ...currentAnalysis.rules };
    profile.usageCount = (Number(profile.usageCount) || 1) + 1;
    profile.correctionsCount = (Number(profile.correctionsCount) || 0) + corrections;
    profile.lastUsedAt = now;

    updated.learningLog.unshift(
      logEntry(
        'profile_updated',
        `Perfil "${profile.name}" atualizado (${corrections} ajuste(s)).`,
        `${profileMappings.length} colunas sincronizadas.`
      )
    );
    currentAnalysis.matchedProfileId = profile.id;
    currentAnalysis.matchedProfileName = profile.name;
  } else {
    const newProfile = {
      id: `prof-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: cleanName,
      fileType: parsedFile.fileType === 'pdf' ? 'pdf' : 'xlsx',
      headers: (parsedFile.headers || []).map((header) => normalizeText(header)),
      mappings: profileMappings,
      rules: { ...defaultRules(), ...currentAnalysis.rules },
      usageCount: 1,
      correctionsCount: corrections,
      createdAt: now,
      lastUsedAt: now,
    };
    updated.learnedProfiles.unshift(newProfile);
    updated.learnedProfiles = updated.learnedProfiles.slice(0, MAX_PROFILES);

    updated.learningLog.unshift(
      logEntry(
        currentAnalysis.status === 'evolved' ? 'layout_evolved' : 'profile_created',
        currentAnalysis.status === 'evolved'
          ? `Layout evoluído aprendido: "${cleanName}".`
          : `Novo layout aprendido pela IA: "${cleanName}".`,
        (currentAnalysis.changesDetected || []).length > 0
          ? currentAnalysis.changesDetected.join(' • ')
          : `${profileMappings.length} colunas mapeadas.`
      )
    );

    currentAnalysis.matchedProfileId = newProfile.id;
    currentAnalysis.matchedProfileName = cleanName;
  }

  updated.learningLog = updated.learningLog.slice(0, MAX_LOG_ENTRIES);
  updated.stats.correctionsLearned = (Number(updated.stats.correctionsLearned) || 0) + corrections;
  updated.stats.totalFilesProcessed = Number(updated.stats.totalFilesProcessed) || 0;

  // Depois de treinar, o mapeamento atual passa a ser a "verdade": um novo
  // treinamento sem novas correções não deve contar ajustes novamente.
  currentAnalysis.aiPredictedRoles = mappings.map((mapping) => mapping.role);
  currentAnalysis.status = 'matched';
  currentAnalysis.matchSimilarity = 100;
  currentAnalysis.changesDetected = [];
  currentAnalysis.warnings = [];

  saveAiMemory(updated);
  return updated;
}

/* -------------------------------------------------------------------------- */
/*                         Transformação das linhas                           */
/* -------------------------------------------------------------------------- */

const DC_NEGATIVE = /^(d|db|deb|debito|debitos|saida|saidas|pago|pag|pagar|-)\.?$/;
const DC_POSITIVE = /^(c|cr|cred|credito|creditos|entrada|entradas|recebido|rec|receber|\+)\.?$/;

function normalizeHistoryCell(cell, rules) {
  let text;
  if (cell instanceof Date) {
    text = formatIsoToBrDate(parseDateValue(cell));
  } else if (typeof cell === 'number') {
    text = Number.isInteger(cell) ? String(cell) : formatValuePlainBr(cell);
  } else {
    text = String(cell ?? '');
  }

  if (!text) return '';
  if (rules.removePipes !== false) text = text.replace(/[|¦]/g, ' ');
  const from = rules.customReplaceFrom;
  if (from) text = text.split(from).join(rules.customReplaceTo ?? ' ');
  text = cleanWhitespace(text);
  return text;
}

/**
 * Converte todas as linhas de um arquivo para o padrão
 * data (ISO) | valor (número) | histórico (texto).
 */
export function transformRowsWithConfig(parsedFile, config) {
  const mappings = Array.isArray(config?.mappings) ? config.mappings : [];
  const rules = { ...defaultRules(), ...(config?.rules || {}) };

  const dateMappings = mappings.filter((mapping) => mapping.role === ROLES.DATE);
  const autoMappings = mappings.filter((mapping) => mapping.role === ROLES.VALUE_AUTO);
  const outMappings = mappings.filter((mapping) => mapping.role === ROLES.VALUE_OUT);
  const inMappings = mappings.filter((mapping) => mapping.role === ROLES.VALUE_IN);
  const dcMappings = mappings.filter((mapping) => mapping.role === ROLES.DC_FLAG);
  const historyMappings = mappings
    .filter((mapping) => mapping.role === ROLES.HISTORY)
    .sort((a, b) => (a.historyOrder || 0) - (b.historyOrder || 0));

  const records = [];
  const skipped = [];
  const rows = Array.isArray(parsedFile?.rows) ? parsedFile.rows : [];

  // Relatórios agrupados ("Contas Recebidas por Cliente") trazem uma linha só
  // com o nome do cliente/fornecedor antes do bloco de lançamentos. Esse texto
  // vira prefixo do histórico de todas as linhas do grupo.
  let sectionText = '';

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex] || [];

    // 0) Cabeçalho de grupo: uma única célula com texto, sem data e sem valor.
    const filledCells = row.filter((cell) => cleanWhitespace(cell));
    const looksLikeSection =
      filledCells.length === 1 &&
      parseDateValue(filledCells[0]) === null &&
      parseMoneyValue(filledCells[0]) === null;
    if (looksLikeSection) {
      sectionText = normalizeHistoryCell(filledCells[0], rules);
      skipped.push({
        rowIdx: rowIndex + 1,
        reason: 'Cabeçalho de grupo (aplicado ao histórico das linhas seguintes)',
        raw: row,
      });
      continue;
    }

    // 1) Data: usa a primeira coluna de data que trouxer valor válido.
    let dateIso = null;
    for (const mapping of dateMappings) {
      const parsed = parseDateValue(row[mapping.colIdx]);
      if (parsed) {
        dateIso = parsed;
        break;
      }
    }
    if (!dateIso) {
      skipped.push({ rowIdx: rowIndex + 1, reason: 'Sem data válida', raw: row });
      continue;
    }

    // 2) Valor: entradas/saídas explícitas têm prioridade sobre valor com sinal.
    let cents = null;
    let explicitSign = false;

    if (inMappings.length > 0 || outMappings.length > 0) {
      let sumCents = 0;
      let found = false;
      for (const mapping of inMappings) {
        const money = parseMoneyValue(row[mapping.colIdx]);
        if (money === null) continue;
        sumCents += Math.abs(toCents(money.value));
        found = true;
      }
      for (const mapping of outMappings) {
        const money = parseMoneyValue(row[mapping.colIdx]);
        if (money === null) continue;
        sumCents -= Math.abs(toCents(money.value));
        found = true;
      }
      if (found) cents = sumCents;
    }

    if (cents === null && autoMappings.length > 0) {
      let sumCents = 0;
      let found = false;
      let dcFromCell = null;

      for (const mapping of autoMappings) {
        const money = parseMoneyValue(row[mapping.colIdx]);
        if (money === null) continue;
        sumCents += toCents(money.value);
        found = true;
        if (money.hasExplicitSign) explicitSign = true;
        if (money.dcTag) dcFromCell = money.dcTag;
      }

      if (found) {
        cents = sumCents;

        // Indicador D/C: coluna dedicada tem prioridade; senão, sufixo da célula.
        let dc = null;
        for (const mapping of dcMappings) {
          const tag = normalizeText(row[mapping.colIdx]);
          if (DC_NEGATIVE.test(tag)) dc = 'negative';
          else if (DC_POSITIVE.test(tag)) dc = 'positive';
          if (dc) break;
        }
        if (!dc && dcFromCell) dc = dcFromCell === 'D' ? 'negative' : 'positive';

        if (dc === 'negative') cents = -Math.abs(sumCents);
        else if (dc === 'positive') cents = Math.abs(sumCents);
        else if (!explicitSign) {
          if (rules.defaultSign === 'negative') cents = -Math.abs(sumCents);
          else if (rules.defaultSign === 'positive') cents = Math.abs(sumCents);
        }
      }
    }

    if (cents === null || !Number.isFinite(cents)) {
      skipped.push({ rowIdx: rowIndex + 1, reason: 'Sem valor numérico válido', raw: row });
      continue;
    }

    // 3) Histórico: grupo (se houver) + colunas marcadas na ordem escolhida.
    const parts = [];
    if (sectionText) parts.push(sectionText);
    for (const mapping of historyMappings) {
      const text = normalizeHistoryCell(row[mapping.colIdx], rules);
      if (text) parts.push(text);
    }
    const history = parts.join(' ');

    const value = fromCents(cents);
    records.push({
      dateIso,
      dateBr: formatIsoToBrDate(dateIso),
      value,
      history,
      sourceFile: parsedFile.fileName || '',
      sourceRow: rowIndex + 1,
    });
  }

  return { records, skipped };
}

/* -------------------------------------------------------------------------- */
/*                              Conector LLM                                  */
/* -------------------------------------------------------------------------- */

const LLM_TIMEOUT_MS = 30000;

function extractJsonPayload(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function sanitizeLlmResult(parsed, headerCount) {
  if (!isPlainObject(parsed) || !Array.isArray(parsed.roles)) return null;
  const roles = parsed.roles
    .slice(0, headerCount)
    .map((role) => (ALL_ROLES.includes(role) ? role : ROLES.HISTORY));
  if (roles.length !== headerCount) return null;

  return {
    layoutName: typeof parsed.layoutName === 'string' ? parsed.layoutName.slice(0, 80) : '',
    defaultSign: ['auto', 'negative', 'positive'].includes(parsed.defaultSign)
      ? parsed.defaultSign
      : 'auto',
    roles,
  };
}

/**
 * Analisa um layout inédito via LLM (OpenAI ou Gemini) usando a chave do usuário.
 * A chave nunca sai do navegador para outro destino além do provedor escolhido.
 */
export async function analyzeWithOptionalLlm(parsedFile, llmConfig) {
  if (!llmConfig || llmConfig.provider === 'none' || !llmConfig.apiKey) {
    throw new Error('Nenhum provedor LLM externo configurado.');
  }

  const headers = parsedFile.headers || [];
  const previewRows = (parsedFile.rows || []).slice(0, 6);
  const prompt = [
    'Analise esta tabela financeira e retorne APENAS um JSON válido com a estrutura:',
    '{"layoutName":"string","defaultSign":"auto|negative|positive","roles":["..."]}',
    `Arquivo: ${parsedFile.fileName}`,
    `Cabeçalhos (${headers.length}): ${JSON.stringify(headers)}`,
    `Amostra de linhas: ${JSON.stringify(previewRows)}`,
    `Papéis permitidos (um por coluna, na mesma ordem): ${ALL_ROLES.join(', ')}.`,
  ].join('\n');

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), LLM_TIMEOUT_MS) : null;

  try {
    let rawText = '';

    if (llmConfig.provider === 'openai') {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${llmConfig.apiKey}`,
        },
        body: JSON.stringify({
          model: llmConfig.model || 'gpt-4o-mini',
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: controller?.signal,
      });
      if (!response.ok) {
        throw new Error(`Erro OpenAI (${response.status}): ${(await response.text()).slice(0, 200)}`);
      }
      const data = await response.json();
      rawText = data.choices?.[0]?.message?.content || '';
    } else if (llmConfig.provider === 'gemini') {
      const model = llmConfig.model || 'gemini-2.0-flash';
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(llmConfig.apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0, responseMimeType: 'application/json' },
          }),
          signal: controller?.signal,
        }
      );
      if (!response.ok) {
        throw new Error(`Erro Gemini (${response.status}): ${(await response.text()).slice(0, 200)}`);
      }
      const data = await response.json();
      rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } else {
      throw new Error('Provedor LLM não suportado.');
    }

    const parsed = extractJsonPayload(rawText);
    const result = sanitizeLlmResult(parsed, headers.length);
    if (!result) {
      throw new Error('Resposta do LLM não correspondeu ao número de colunas do arquivo.');
    }
    return result;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('O provedor LLM não respondeu em 30 segundos. Tente novamente.');
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
