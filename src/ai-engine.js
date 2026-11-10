/**
 * Conversor Custódio — Motor de IA Adaptativa para Layouts
 *
 * Combina:
 * 1. Classificador semântico multi-sinal (análise estatística de colunas + pesos léxicos aprendidos)
 * 2. Detector de evolução de layout (compara com perfis aprendidos e destaca colunas novas/alteradas)
 * 3. Aprendizado supervisionado online (atualiza pesos de tokens e perfis de layout no localStorage)
 * 4. Conector LLM opcional (OpenAI/Gemini via chave própria do usuário, 100% opcional)
 */

import {
  cleanWhitespace,
  normalizeText,
  tokenizeHeader,
  parseDateValue,
  formatIsoToBrDate,
  parseMoneyValue,
} from './parsers.js';

export const STORAGE_KEY = 'conversor_custodio_ai_memory_v1';

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

  // Saídas / Pagamentos / Débitos
  pago: { value_out: 3.8 },
  pagar: { value_out: 3.5 },
  debito: { value_out: 4.2 },
  deb: { value_out: 3.5 },
  saida: { value_out: 4.0 },
  despesa: { value_out: 3.5 },

  // Entradas / Recebimentos / Créditos
  recebido: { value_in: 3.8 },
  receber: { value_in: 3.5 },
  credito: { value_in: 4.2 },
  cred: { value_in: 3.5 },
  entrada: { value_in: 4.0 },
  receita: { value_in: 3.5 },

  // Indicador D/C
  dc: { dc_flag: 4.5 },
  'd/c': { dc_flag: 4.5 },
  sinal: { dc_flag: 3.5 },
  operacao: { dc_flag: 1.8, history: 1.5 },

  // Histórico / Textos descritivos
  historico: { history: 4.5 },
  descricao: { history: 4.2 },
  desc: { history: 3.5 },
  titulo: { history: 3.8 },
  documento: { history: 3.5 },
  doc: { history: 3.2 },
  nf: { history: 3.5 },
  nota: { history: 3.0 },
  tipo: { history: 3.5 },
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
  obs: { history: 3.5 },
  complemento: { history: 3.8 },
  detalhe: { history: 3.5 },
  detalhes: { history: 3.5 },
  parcela: { history: 3.2 },
  obra: { history: 3.5 },
  projeto: { history: 3.5 },
  banco: { history: 2.5 },
  conta: { history: 2.5 },

  // Ignorar (saldos, totais acumulados)
  saldo: { ignore: 4.8 },
  acumulado: { ignore: 4.2 },
  total: { ignore: 3.0 },
  subtotal: { ignore: 4.0 },
  anterior: { ignore: 2.5 },
  disponivel: { ignore: 2.2 },
};

function createDefaultMemory() {
  return {
    version: 1,
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

export function loadAiMemory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createDefaultMemory();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return createDefaultMemory();

    // Mesclar novos tokens base caso tenham sido adicionados
    const mergedWeights = JSON.parse(JSON.stringify(BASE_TOKEN_WEIGHTS));
    if (parsed.tokenWeights) {
      for (const [tok, rolesObj] of Object.entries(parsed.tokenWeights)) {
        mergedWeights[tok] = { ...(mergedWeights[tok] || {}), ...rolesObj };
      }
    }

    return {
      version: 1,
      tokenWeights: mergedWeights,
      learnedProfiles: Array.isArray(parsed.learnedProfiles) ? parsed.learnedProfiles : [],
      learningLog: Array.isArray(parsed.learningLog) ? parsed.learningLog : [],
      stats: {
        totalFilesProcessed: parsed.stats?.totalFilesProcessed || 0,
        autoMatchedCount: parsed.stats?.autoMatchedCount || 0,
        correctionsLearned: parsed.stats?.correctionsLearned || 0,
      },
      optionalLlm: parsed.optionalLlm || { provider: 'none', apiKey: '', model: '' },
    };
  } catch {
    return createDefaultMemory();
  }
}

export function saveAiMemory(memory) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(memory));
  } catch (err) {
    console.warn('Não foi possível salvar memória da IA no localStorage:', err);
  }
}

export function resetAiMemory() {
  const fresh = createDefaultMemory();
  saveAiMemory(fresh);
  return fresh;
}

/**
 * Calcula estatísticas semânticas de cada coluna a partir de uma amostra de linhas.
 */
export function computeColumnProfiles(headers, rows) {
  const sample = rows.slice(0, 120);
  const n = Math.max(1, sample.length);

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
    const moneySeq = [];

    for (const row of sample) {
      const cell = row[colIdx];
      const str = cell instanceof Date ? formatIsoToBrDate(parseDateValue(cell)) : cleanWhitespace(cell);
      if (!str) continue;

      nonEmpty++;
      totalLen += str.length;
      uniqueSet.add(str);
      if (samples.length < 4 && !samples.includes(str)) samples.push(str);

      if (parseDateValue(cell) !== null) {
        dateCount++;
      } else {
        const m = parseMoneyValue(cell);
        if (m !== null) {
          moneyCount++;
          moneySeq.push(m.value);
          if (m.value < 0) negCount++;
          if (m.value > 0) posCount++;
          if (m.hasExplicitSign) explicitSignCount++;
        } else if (/^(d|c|debito|débito|credito|crédito|entrada|saida|saída)$/i.test(str)) {
          dcCount++;
        }
      }
    }

    const active = Math.max(1, nonEmpty);
    const normH = normalizeText(header);
    const tokens = tokenizeHeader(header);

    return {
      colIdx,
      header,
      normHeader: normH,
      tokens,
      nonEmptyRatio: nonEmpty / n,
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
    };
  });
}

function headerSimilarity(hA, hB) {
  if (!hA && !hB) return 1;
  if (hA === hB) return 1;
  const tokA = new Set(tokenizeHeader(hA));
  const tokB = new Set(tokenizeHeader(hB));
  if (tokA.size === 0 || tokB.size === 0) return 0;
  let inter = 0;
  for (const t of tokA) if (tokB.has(t)) inter++;
  const union = new Set([...tokA, ...tokB]).size;
  return inter / union;
}

function computeProfileMatchScore(headers, fileType, profile) {
  const normList = headers.map((h) => normalizeText(h));
  const profList = profile.headers || [];
  if (normList.length === 0 || profList.length === 0) return 0;

  let matchedCols = 0;
  for (const h of normList) {
    let best = 0;
    for (const ph of profList) {
      best = Math.max(best, headerSimilarity(h, ph));
    }
    matchedCols += best;
  }
  const precision = matchedCols / normList.length;

  let revMatched = 0;
  for (const ph of profList) {
    let best = 0;
    for (const h of normList) {
      best = Math.max(best, headerSimilarity(ph, h));
    }
    revMatched += best;
  }
  const recall = revMatched / profList.length;

  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const typeBonus = profile.fileType === fileType ? 0.03 : 0;
  return Math.min(1, f1 + typeBonus);
}

/**
 * Infere o sinal padrão do arquivo pelo nome, cabeçalho e linhas de banner.
 */
function inferDocumentDefaultSign(parsedFile, colProfiles) {
  const contextText = normalizeText(
    [parsedFile.fileName, ...(parsedFile.bannerLines || []), ...parsedFile.headers].join(' ')
  );

  // Verificar se valores já trazem sinais negativos explícitos
  const moneyCols = colProfiles.filter((c) => c.pctMoney >= 0.5 && !/\bsaldo\b|\btotal\b/.test(c.normHeader));
  const hasExplicitNeg = moneyCols.some((c) => c.pctNegative > 0.05);
  if (hasExplicitNeg) return 'auto';

  // Se houver colunas separadas de crédito/débito, não forçar sinal global
  const hasOutHint = /\b(pagamento|pagamentos|pago|pagar|contas a pagar|despesa|despesas|saidas|debito)\b/.test(contextText);
  const hasInHint = /\b(recebimento|recebimentos|recebido|receber|contas a receber|receita|entradas|credito)\b/.test(contextText);

  if (hasOutHint && !hasInHint) return 'negative';
  if (hasInHint && !hasOutHint) return 'positive';
  return 'auto';
}

/**
 * Pontua todas as funções candidatas para uma coluna combinando pesos aprendidos + evidência estatística.
 */
function scoreColumnRoles(colStat, tokenWeights) {
  const scores = {
    [ROLES.DATE]: 0,
    [ROLES.VALUE_AUTO]: 0,
    [ROLES.VALUE_OUT]: 0,
    [ROLES.VALUE_IN]: 0,
    [ROLES.DC_FLAG]: 0,
    [ROLES.HISTORY]: 0,
    [ROLES.IGNORE]: 0,
  };

  // 1. Evidência léxica (pesos aprendidos + base)
  for (const tok of colStat.tokens) {
    const w = tokenWeights[tok];
    if (w) {
      for (const [role, weight] of Object.entries(w)) {
        if (scores[role] !== undefined) scores[role] += weight;
      }
    }
  }
  // Verificar header composto (ex: "d/c")
  if (tokenWeights[colStat.normHeader]) {
    for (const [role, weight] of Object.entries(tokenWeights[colStat.normHeader])) {
      if (scores[role] !== undefined) scores[role] += weight * 1.2;
    }
  }

  // 2. Evidência estatística dos valores reais da coluna
  if (colStat.pctDate >= 0.65) {
    scores[ROLES.DATE] += 6.5;
  } else if (colStat.pctDate >= 0.3) {
    scores[ROLES.DATE] += 2.5;
  } else {
    scores[ROLES.DATE] -= 3.0;
  }

  if (colStat.pctMoney >= 0.6) {
    scores[ROLES.VALUE_AUTO] += 5.0;
    scores[ROLES.VALUE_OUT] += 4.2;
    scores[ROLES.VALUE_IN] += 4.2;
    if (colStat.pctNegative >= 0.8 && colStat.pctExplicitSign >= 0.8) {
      scores[ROLES.VALUE_AUTO] += 1.5;
    }
    if (/\bsaldo\b|\bacumulado\b|\bsubtotal\b/.test(colStat.normHeader)) {
      scores[ROLES.IGNORE] += 5.0;
    }
  } else if (colStat.pctMoney >= 0.2 && colStat.nonEmptyRatio < 0.85) {
    // Coluna esparsa (ex: Crédito/Débito separado preenchido só em parte das linhas)
    scores[ROLES.VALUE_AUTO] += 2.5;
    scores[ROLES.VALUE_OUT] += 2.8;
    scores[ROLES.VALUE_IN] += 2.8;
  } else {
    scores[ROLES.VALUE_AUTO] -= 3.5;
    scores[ROLES.VALUE_OUT] -= 3.5;
    scores[ROLES.VALUE_IN] -= 3.5;
  }

  if (colStat.pctDC >= 0.7 && colStat.avgLen <= 8) {
    scores[ROLES.DC_FLAG] += 5.5;
  }

  // Textos descritivos -> forte candidato a Histórico
  if (colStat.pctDate < 0.2 && colStat.pctMoney < 0.2 && colStat.pctDC < 0.5) {
    scores[ROLES.HISTORY] += 3.5;
    if (colStat.avgLen >= 8) scores[ROLES.HISTORY] += 1.5;
  }

  // Coluna completamente vazia -> ignorar
  if (colStat.nonEmptyRatio === 0) {
    scores[ROLES.IGNORE] += 8.0;
  }

  return scores;
}

/**
 * Analisa um arquivo extraído (.pdf ou .xlsx) usando a Memória da IA.
 * Retorna configuração sugerida + métricas de confiança + mudanças detectadas em relação a layouts aprendidos.
 */
export function analyzeFileLayout(parsedFile, memory) {
  const colStats = computeColumnProfiles(parsedFile.headers, parsedFile.rows);
  const defaultSign = inferDocumentDefaultSign(parsedFile, colStats);

  // 1. Verificar perfis aprendidos na Memória da IA
  let bestProfile = null;
  let bestScore = 0;
  for (const prof of memory.learnedProfiles) {
    const sim = computeProfileMatchScore(parsedFile.headers, parsedFile.fileType, prof);
    if (sim > bestScore) {
      bestScore = sim;
      bestProfile = prof;
    }
  }

  const matchedProfile = bestScore >= 0.65 ? bestProfile : null;
  const isExactMatch = bestScore >= 0.96;
  const isEvolvedMatch = matchedProfile && !isExactMatch;

  const mappings = [];
  const changesDetected = [];
  const roleScoresList = colStats.map((cs) => scoreColumnRoles(cs, memory.tokenWeights));

  // Se houver match com perfil aprendido, mapear colunas conhecidas e marcar novas/alteradas
  const matchedProfileColsUsed = new Set();

  for (let idx = 0; idx < colStats.length; idx++) {
    const cs = colStats[idx];
    const scores = roleScoresList[idx];

    let predictedRole = ROLES.HISTORY;
    let confidence = 0;
    let source = 'semantic_ai';
    let changeType = null;

    if (matchedProfile) {
      // Procurar melhor coluna correspondente no perfil aprendido
      let bestProfCol = null;
      let bestColSim = 0;
      for (const pm of matchedProfile.mappings) {
        const sim = headerSimilarity(cs.normHeader, normalizeText(pm.header));
        if (sim > bestColSim) {
          bestColSim = sim;
          bestProfCol = pm;
        }
      }

      if (bestProfCol && bestColSim >= 0.72) {
        predictedRole = bestProfCol.role;
        confidence = Math.round(Math.min(99, bestColSim * 98));
        source = 'learned_profile';
        matchedProfileColsUsed.add(bestProfCol.header);
        if (bestColSim < 1) {
          changeType = 'renamed';
          changesDetected.push(`Coluna adaptada: "${bestProfCol.header}" → "${cs.header}"`);
        }
      } else {
        // Nova coluna que apareceu em um layout conhecido!
        changeType = 'added';
        changesDetected.push(`Nova coluna detectada: "${cs.header}"`);
      }
    }

    if (source === 'semantic_ai') {
      // Escolher papel com maior pontuação semântica
      const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
      predictedRole = ranked[0][0];
      const margin = ranked[0][1] - ranked[1][1];
      confidence = Math.round(Math.max(42, Math.min(97, 60 + margin * 8)));
    }

    mappings.push({
      colIdx: idx,
      header: cs.header,
      role: predictedRole,
      historyOrder: idx,
      confidence,
      source,
      changeType,
      stats: cs,
      scores,
    });
  }

  // Garantir consistência global se foi inferência semântica:
  // Pelo menos 1 DATE e ao menos 1 coluna de VALOR (ou par IN/OUT)
  const hasDate = mappings.some((m) => m.role === ROLES.DATE);
  if (!hasDate) {
    let bestDateIdx = 0;
    let bestDateVal = -Infinity;
    mappings.forEach((m, i) => {
      if (m.scores[ROLES.DATE] > bestDateVal) {
        bestDateVal = m.scores[ROLES.DATE];
        bestDateIdx = i;
      }
    });
    if (mappings[bestDateIdx]) {
      mappings[bestDateIdx].role = ROLES.DATE;
      mappings[bestDateIdx].confidence = Math.max(55, mappings[bestDateIdx].confidence);
    }
  }

  const hasValue = mappings.some((m) =>
    [ROLES.VALUE_AUTO, ROLES.VALUE_OUT, ROLES.VALUE_IN].includes(m.role)
  );
  if (!hasValue) {
    let bestValIdx = mappings.length - 1;
    let bestValScore = -Infinity;
    mappings.forEach((m, i) => {
      if (m.role === ROLES.DATE) return;
      const s = Math.max(m.scores[ROLES.VALUE_AUTO], m.scores[ROLES.VALUE_OUT], m.scores[ROLES.VALUE_IN]);
      if (s > bestValScore) {
        bestValScore = s;
        bestValIdx = i;
      }
    });
    if (mappings[bestValIdx]) {
      mappings[bestValIdx].role =
        defaultSign === 'negative'
          ? ROLES.VALUE_OUT
          : defaultSign === 'positive'
          ? ROLES.VALUE_IN
          : ROLES.VALUE_AUTO;
    }
  }

  // Evitar duplicidade acidental de DATE (manter a de maior score; outra vira HISTORY)
  const dateMaps = mappings.filter((m) => m.role === ROLES.DATE);
  if (dateMaps.length > 1) {
    dateMaps.sort((a, b) => b.scores[ROLES.DATE] - a.scores[ROLES.DATE]);
    for (let i = 1; i < dateMaps.length; i++) {
      dateMaps[i].role = ROLES.HISTORY;
    }
  }

  // Verificar colunas removidas se evoluiu de perfil aprendido
  if (matchedProfile) {
    for (const pm of matchedProfile.mappings) {
      if (!matchedProfileColsUsed.has(pm.header)) {
        changesDetected.push(`Coluna ausente do modelo anterior: "${pm.header}"`);
      }
    }
  }

  // Ordenar historyOrder limpo
  let hOrd = 1;
  for (const m of mappings) {
    m.historyOrder = hOrd++;
  }

  const avgConfidence = Math.round(
    mappings.reduce((acc, m) => acc + m.confidence, 0) / Math.max(1, mappings.length)
  );

  const rules = matchedProfile
    ? { ...matchedProfile.rules }
    : {
        defaultSign,
        removePipes: true,
        collapseSpaces: true,
        customReplaceFrom: '',
        customReplaceTo: '',
      };

  let status = 'new_layout';
  if (isExactMatch) status = 'matched';
  else if (isEvolvedMatch) status = 'evolved';

  return {
    status,
    matchedProfileId: matchedProfile?.id || null,
    matchedProfileName: matchedProfile?.name || null,
    matchSimilarity: Math.round(bestScore * 100),
    avgConfidence,
    changesDetected,
    mappings,
    rules,
    aiPredictedRoles: mappings.map((m) => m.role),
  };
}

/**
 * Treina a IA com as confirmações/correções do usuário:
 * 1. Atualiza os pesos globais de tokens (aprendizado supervisionado online)
 * 2. Salva ou atualiza o perfil de layout na memória persistente
 * 3. Registra o evento no histórico de aprendizado
 */
export function trainAiWithLayout(parsedFile, currentAnalysis, layoutName, memory) {
  const updated = JSON.parse(JSON.stringify(memory));
  const lrPositive = 1.6;
  const lrNegative = 0.6;
  let correctionsCount = 0;

  for (let i = 0; i < currentAnalysis.mappings.length; i++) {
    const m = currentAnalysis.mappings[i];
    const origRole = currentAnalysis.aiPredictedRoles?.[i];
    const wasCorrected = origRole && origRole !== m.role;
    if (wasCorrected) correctionsCount++;

    const tokens = tokenizeHeader(m.header);
    for (const tok of tokens) {
      if (tok.length < 2) continue;
      if (!updated.tokenWeights[tok]) updated.tokenWeights[tok] = {};
      updated.tokenWeights[tok][m.role] = (updated.tokenWeights[tok][m.role] || 0) + (wasCorrected ? lrPositive * 1.4 : lrPositive * 0.5);

      if (wasCorrected && updated.tokenWeights[tok][origRole]) {
        updated.tokenWeights[tok][origRole] = Math.max(0, updated.tokenWeights[tok][origRole] - lrNegative);
      }
    }
  }

  const profileMappings = currentAnalysis.mappings.map((m) => ({
    header: m.header,
    role: m.role,
    historyOrder: m.historyOrder,
  }));

  const cleanName =
    cleanWhitespace(layoutName) ||
    `${parsedFile.fileType.toUpperCase()} - ${parsedFile.headers.slice(0, 3).join(' / ')}`;

  const existingIdx = currentAnalysis.matchedProfileId
    ? updated.learnedProfiles.findIndex((p) => p.id === currentAnalysis.matchedProfileId)
    : -1;

  const now = new Date().toISOString();

  if (existingIdx >= 0 && currentAnalysis.matchSimilarity >= 92) {
    const prof = updated.learnedProfiles[existingIdx];
    prof.name = cleanName;
    prof.headers = parsedFile.headers.map((h) => normalizeText(h));
    prof.mappings = profileMappings;
    prof.rules = { ...currentAnalysis.rules };
    prof.usageCount = (prof.usageCount || 1) + 1;
    prof.correctionsCount = (prof.correctionsCount || 0) + correctionsCount;
    prof.lastUsedAt = now;

    updated.learningLog.unshift({
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: now,
      type: 'profile_updated',
      message: `Perfil "${cleanName}" reforçado (${correctionsCount} ajuste(s)).`,
      details: `${parsedFile.headers.length} colunas sincronizadas.`,
    });
  } else {
    const newProf = {
      id: `prof-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: cleanName,
      fileType: parsedFile.fileType,
      headers: parsedFile.headers.map((h) => normalizeText(h)),
      mappings: profileMappings,
      rules: { ...currentAnalysis.rules },
      usageCount: 1,
      correctionsCount,
      createdAt: now,
      lastUsedAt: now,
    };
    updated.learnedProfiles.unshift(newProf);
    currentAnalysis.matchedProfileId = newProf.id;
    currentAnalysis.matchedProfileName = cleanName;

    updated.learningLog.unshift({
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: now,
      type: currentAnalysis.status === 'evolved' ? 'layout_evolved' : 'profile_created',
      message:
        currentAnalysis.status === 'evolved'
          ? `Novo layout evoluído aprendido: "${cleanName}".`
          : `Novo layout aprendido pela IA: "${cleanName}".`,
      details:
        currentAnalysis.changesDetected.length > 0
          ? currentAnalysis.changesDetected.join(' • ')
          : `${parsedFile.headers.length} colunas mapeadas.`,
    });
  }

  updated.learningLog = updated.learningLog.slice(0, 60);
  updated.stats.correctionsLearned = (updated.stats.correctionsLearned || 0) + correctionsCount;
  saveAiMemory(updated);
  return updated;
}

/**
 * Converte todas as linhas de um arquivo usando o mapeamento e regras da IA.
 */
export function transformRowsWithConfig(parsedFile, config) {
  const { mappings, rules } = config;
  const dateCol = mappings.find((m) => m.role === ROLES.DATE);
  const valAutoCols = mappings.filter((m) => m.role === ROLES.VALUE_AUTO);
  const valOutCols = mappings.filter((m) => m.role === ROLES.VALUE_OUT);
  const valInCols = mappings.filter((m) => m.role === ROLES.VALUE_IN);
  const dcCols = mappings.filter((m) => m.role === ROLES.DC_FLAG);
  const histCols = mappings
    .filter((m) => m.role === ROLES.HISTORY)
    .sort((a, b) => a.historyOrder - b.historyOrder);

  const records = [];
  const skipped = [];

  for (let rIdx = 0; rIdx < parsedFile.rows.length; rIdx++) {
    const row = parsedFile.rows[rIdx];
    const dateIso = dateCol ? parseDateValue(row[dateCol.colIdx]) : null;
    if (!dateIso) {
      skipped.push({ rowIdx: rIdx + 1, reason: 'Sem data válida', raw: row });
      continue;
    }

    // Calcular valor
    let amount = null;

    if (valInCols.length > 0 || valOutCols.length > 0) {
      let sum = 0;
      let foundAny = false;
      for (const vc of valInCols) {
        const m = parseMoneyValue(row[vc.colIdx]);
        if (m !== null) {
          sum += Math.abs(m.value);
          foundAny = true;
        }
      }
      for (const vc of valOutCols) {
        const m = parseMoneyValue(row[vc.colIdx]);
        if (m !== null) {
          sum -= Math.abs(m.value);
          foundAny = true;
        }
      }
      if (foundAny) amount = Math.round(sum * 100) / 100;
    }

    if (amount === null && valAutoCols.length > 0) {
      let sum = 0;
      let foundAny = false;
      let explicitSign = false;
      for (const vc of valAutoCols) {
        const m = parseMoneyValue(row[vc.colIdx]);
        if (m !== null) {
          sum += m.value;
          foundAny = true;
          if (m.hasExplicitSign) explicitSign = true;
        }
      }
      if (foundAny) {
        amount = Math.round(sum * 100) / 100;
        // Aplicar coluna D/C se existir
        let dcForced = null;
        for (const dc of dcCols) {
          const tag = normalizeText(row[dc.colIdx]);
          if (/^(d|deb|debito|saida|pago|pag)$/.test(tag)) dcForced = 'negative';
          else if (/^(c|cred|credito|entrada|recebido|rec)$/.test(tag)) dcForced = 'positive';
        }
        if (dcForced === 'negative') {
          amount = -Math.abs(amount);
        } else if (dcForced === 'positive') {
          amount = Math.abs(amount);
        } else if (!explicitSign) {
          if (rules.defaultSign === 'negative') amount = -Math.abs(amount);
          else if (rules.defaultSign === 'positive') amount = Math.abs(amount);
        }
      }
    }

    if (amount === null || Number.isNaN(amount)) {
      skipped.push({ rowIdx: rIdx + 1, reason: 'Sem valor numérico válido', raw: row });
      continue;
    }

    // Concatenar histórico com todas as colunas marcadas
    const parts = [];
    for (const hc of histCols) {
      const rawCell = row[hc.colIdx];
      let str = rawCell instanceof Date ? formatIsoToBrDate(parseDateValue(rawCell)) : String(rawCell ?? '');
      if (rules.removePipes) {
        str = str.replace(/\|/g, ' ');
      }
      if (rules.customReplaceFrom) {
        str = str.split(rules.customReplaceFrom).join(rules.customReplaceTo ?? ' ');
      }
      str = rules.collapseSpaces !== false ? cleanWhitespace(str) : str.trim();
      if (str) parts.push(str);
    }

    let history = parts.join(' ');
    if (rules.removePipes) history = history.replace(/\|/g, ' ');
    if (rules.collapseSpaces !== false) history = cleanWhitespace(history);

    records.push({
      dateIso,
      dateBr: formatIsoToBrDate(dateIso),
      value: amount,
      history,
      sourceFile: parsedFile.fileName,
    });
  }

  return { records, skipped };
}

/**
 * Conector LLM opcional (OpenAI ou Gemini) caso o usuário configure uma API key própria
 * para analisar layouts completamente inéditos/complexos.
 */
export async function analyzeWithOptionalLlm(parsedFile, llmConfig) {
  if (!llmConfig || llmConfig.provider === 'none' || !llmConfig.apiKey) {
    throw new Error('Nenhum provedor LLM externo configurado.');
  }

  const previewRows = parsedFile.rows.slice(0, 6);
  const prompt = [
    'Analise esta tabela financeira e retorne APENAS um JSON válido com a estrutura:',
    '{"layoutName":"string","defaultSign":"auto|negative|positive","roles":["date|value_auto|value_out|value_in|dc_flag|history|ignore"]}',
    `Arquivo: ${parsedFile.fileName}`,
    `Cabeçalhos (${parsedFile.headers.length}): ${JSON.stringify(parsedFile.headers)}`,
    `Amostra de linhas: ${JSON.stringify(previewRows)}`,
  ].join('\n');

  let rawJsonText = '';

  if (llmConfig.provider === 'openai') {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
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
    });
    if (!resp.ok) throw new Error(`Erro OpenAI (${resp.status}): ${await resp.text()}`);
    const data = await resp.json();
    rawJsonText = data.choices?.[0]?.message?.content || '';
  } else if (llmConfig.provider === 'gemini') {
    const model = llmConfig.model || 'gemini-2.0-flash';
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(llmConfig.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, responseMimeType: 'application/json' },
        }),
      }
    );
    if (!resp.ok) throw new Error(`Erro Gemini (${resp.status}): ${await resp.text()}`);
    const data = await resp.json();
    rawJsonText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  const parsed = JSON.parse(rawJsonText);
  if (!Array.isArray(parsed.roles) || parsed.roles.length !== parsedFile.headers.length) {
    throw new Error('Resposta do LLM não correspondeu ao número de colunas.');
  }
  return parsed;
}
