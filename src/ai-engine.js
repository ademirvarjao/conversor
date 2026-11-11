/**
 * Conversor Custódio — Motor de IA Adaptativa para Layouts
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

export const STORAGE_KEY = 'conversor_custodio_ai_memory_v1';
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
    if (!raw) return createDefaultMemory();
    return normalizeMemory(JSON.parse(raw));
  } catch {
    return createDefaultMemory();
  }
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
      } else if (isDcText(text)) {
        dcCount++;
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
      reason =
        winner.role === ROLES.IGNORE
          ? 'Padrão típico de saldo/total'
          : `Maior evidência semântica (${winner.topScore.toFixed(1)} pts)`;
    }

    mappings.push({
      colIdx: idx,
      header: stats.header,
      role: predictedRole,
      historyOrder: 0,
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
    // Mantém a data de maior evidência; as demais viram histórico.
    dateMappings.sort((a, b) => b.scores[ROLES.DATE] - a.scores[ROLES.DATE]);
    for (let i = 1; i < dateMappings.length; i++) {
      dateMappings[i].role = ROLES.HISTORY;
      dateMappings[i].reason = 'Data secundária incorporada ao histórico';
    }
    warnings.push('Mais de uma coluna parece data; foi usada apenas a mais evidente.');
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

  // 4) Ordem do histórico (somente colunas de histórico).
  let order = 1;
  for (const mapping of mappings) {
    mapping.historyOrder = mapping.role === ROLES.HISTORY ? order++ : 0;
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

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex] || [];

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

    // 3) Histórico: concatena as colunas marcadas na ordem escolhida.
    const parts = [];
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
