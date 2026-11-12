/**
 * Conversor — Treinador automático (“faça o que o analista faz”)
 *
 * Quando um extrato ou relatório novo chega, o trabalho de treinar o conversor
 * é sempre o mesmo:
 *
 *   1. conferir se as colunas foram entendidas (data, valor, crédito/débito,
 *      histórico, documento, saldo);
 *   2. ver se alguma linha perdeu a data (lançamento de continuação/virada de
 *      página) e se todas as datas são válidas;
 *   3. conferir o SINAL: negativo só em débito, positivo só em crédito;
 *   4. ver o que foi descartado como cabeçalho/rodapé e o que foi ignorado;
 *   5. FECHAR O SALDO linha a linha (saldo anterior + lançamentos = saldo);
 *   6. apontar as linhas que não fecham e propor correções de mapeamento.
 *
 * Este módulo faz exatamente isso, de forma pura (sem DOM), para que o próprio
 * usuário rode a análise no app em vez de mandar o arquivo para alguém olhar.
 * A saída é um relatório + uma lista de correções que ele aplica com um clique.
 */

import { transformRowsWithConfig, ROLES } from './ai-engine.js';
import { diffRoles, recognizeLayout } from './bank-layouts.js';
import { fromCents, toCents } from './format.js';
import { cleanWhitespace, normalizeText, parseMoneyValue } from './parsers.js';
import { esc } from './html.js';

/** § Etapas do relatório. */
export const CHECK_STATUS = {
  OK: 'ok',
  WARN: 'warn',
  FAIL: 'fail',
  SKIP: 'skip',
};

const SALDO_RE = /\bsaldo\b/;
const DOCUMENT_RE = /\b(dcto|docto|documento|doc|autenticacao|autentic|nosso numero|lote|nr doc|n doc|numero do documento)\b/;
const TOTAL_RE = /\b(total|totais|resumo|acumulado)\b/;
const DC_CELL_RE = /^(d|c|débito|debito|crédito|credito)$/;

/* -------------------------------------------------------------------------- */
/*                             Coluna de saldo                                */
/* -------------------------------------------------------------------------- */

/**
 * Descobre a coluna de SALDO do arquivo (a âncora da conferência).
 * Preferimos a coluna marcada como “Ignorar” — é o que a IA faz — mas aceitamos
 * qualquer coluna cujo cabeçalho fale de saldo: se ela estiver entrando como
 * valor, isso vira uma correção proposta.
 */
export function findBalanceMapping(analysis) {
  const mappings = Array.isArray(analysis?.mappings) ? analysis.mappings : [];
  const candidates = mappings.filter((mapping) => SALDO_RE.test(normalizeText(mapping?.header || '')));
  if (candidates.length === 0) return null;
  const ignored = candidates.find((mapping) => mapping.role === ROLES.IGNORE);
  return ignored || candidates[0];
}

/* -------------------------------------------------------------------------- */
/*                          Conferência do saldo                              */
/* -------------------------------------------------------------------------- */

/**
 * Fecha o saldo linha a linha, nos dois formatos que aparecem na vida real:
 *
 *  - **corrente** (Bradesco): toda linha de lançamento traz o saldo;
 *    `saldo_anterior + valor = saldo`.
 *  - **por checkpoint** (Itaú): o saldo aparece em linhas de resumo
 *    (“SALDO TOTAL DISPONÍVEL DIA”); somamos os lançamentos do período e
 *    comparamos com a diferença entre dois checkpoints.
 *
 * Linhas de resumo com saldo (SALDO ANTERIOR, SALDO INVEST FÁCIL…) servem de
 * âncora nova: é assim que o próprio extrato reinicia a conta na seção
 * “Últimos Lançamentos” — sem isso a quebra de seção apareceria como erro.
 *
 * @returns {{
 *   available: boolean,
 *   reason?: string,
 *   columnHeader?: string,
 *   checked: number,
 *   matched: number,
 *   divergences: Array<object>,
 *   anchors: Array<object>,
 *   firstSaldoCents: number|null,
 *   lastSaldoCents: number|null,
 * }}
 */
export function reconcileBalances(parsedFile, analysis, transform = null) {
  const mapping = findBalanceMapping(analysis);
  const rows = Array.isArray(parsedFile?.rows) ? parsedFile.rows : [];

  if (!mapping) {
    // Extratos “em lista” (Sicoob) não têm coluna de saldo: o saldo vem em
    // linhas próprias (“SALDO ANTERIOR”, “SALDO DO DIA ===== >”) na mesma coluna
    // dos valores. O parser guarda essas linhas como *checkpoints* e a conta
    // fecha do mesmo jeito: saldo anterior + lançamentos = próximo saldo.
    const checkpoints = (parsedFile?.checkpoints || []).filter(
      (checkpoint) =>
        Number.isFinite(checkpoint?.value) &&
        !/\b(bloqueado|investimento|limite|cheque especial|previsao|previsão|disponivel|disponível|em conta)\b/.test(
          normalizeText(checkpoint.label)
        )
    );

    if (checkpoints.length >= 2) {
      return reconcileCheckpoints(parsedFile, checkpoints, transform, analysis);
    }

    return {
      available: false,
      reason: 'O arquivo não tem coluna de saldo — a conferência linha a linha fica de fora.',
      checked: 0,
      matched: 0,
      divergences: [],
      anchors: [],
      firstSaldoCents: null,
      lastSaldoCents: null,
    };
  }

  if (mapping.role !== ROLES.IGNORE) {
    return {
      available: false,
      reason: `A coluna “${mapping.header}” tem saldo mas está entrando como valor — corrija o mapeamento antes de conferir.`,
      columnHeader: mapping.header,
      checked: 0,
      matched: 0,
      divergences: [],
      anchors: [],
      firstSaldoCents: null,
      lastSaldoCents: null,
    };
  }

  const { records } = transform || transformRowsWithConfig(parsedFile, analysis);
  const recordByRow = new Map(records.map((record) => [Number(record.sourceRow) - 1, record]));

  // A coluna existe, mas é saldo de outra coisa? No extrato mensal do Itaú a
  // coluna "saldo R$" só aparece em algumas linhas (saldo da aplicação
  // automática), nunca como saldo corrente da conta. Conferir contra ela gera
  // divergência falsa em tudo.
  let saldoCells = 0;
  let labelledSaldoCells = 0;
  for (const row of rows) {
    if (parseMoneyValue(row?.[mapping.colIdx]) === null) continue;
    saldoCells += 1;
    if (row.some((cell) => SALDO_RE.test(normalizeText(cell)))) labelledSaldoCells += 1;
  }
  // Quando a coluna de saldo não é o saldo corrente da conta:
  //  - extrato de verdade tem saldo em quase toda linha (Itaú Sul: 295 de 296;
  //    Caixa: 65 de 68) ou, quando é só o saldo do dia, no mínimo todo valor
  //    vem rotulado (Itaú ICS: 21 de 21 “SALDO TOTAL DISPONÍVEL DIA”);
  //  - no extrato mensal do Itaú são 15 valores soltos em 326 linhas, nenhum
  //    com rótulo de saldo — é o saldo da aplicação automática.
  const saldoEsparso = saldoCells < rows.length * 0.3;
  const saldoSemRotulo = labelledSaldoCells < saldoCells / 2;
  if (saldoCells >= 3 && saldoEsparso && saldoSemRotulo) {
    return {
      available: false,
      reason: `A coluna “${mapping.header}” não é o saldo corrente da conta (os valores aparecem soltos, como saldo de aplicação) — a conferência de saldo fica de fora.`,
      columnHeader: mapping.header,
      checked: 0,
      matched: 0,
      divergences: [],
      anchors: [],
      firstSaldoCents: null,
      lastSaldoCents: null,
    };
  }

  const divergences = [];
  const anchors = [];
  const otherSeries = [];
  let baseCents = null;
  let pendingCents = 0;
  let pendingCount = 0;
  let checked = 0;
  let matched = 0;
  let firstSaldoCents = null;
  let lastSaldoCents = null;
  // “Série principal” = o saldo da conta. Um extrato pode trazer outros saldos
  // (SALDO INVEST FÁCIL, SALDO BLOQUEADO…): eles não fecham com os lançamentos
  // da conta e não podem virar divergência.
  let principalLabel = null;

  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx] || [];
    const record = recordByRow.get(rowIdx);
    const saldoMoney = parseMoneyValue(row[mapping.colIdx]);
    const saldoCell = row.find((cell) => SALDO_RE.test(normalizeText(cell)));
    const label = saldoCell ? normalizeText(saldoCell) : '';
    const isBalanceSummary = !record && Boolean(label);

    // Saldo de APLICAÇÃO/INVESTIMENTO não é o saldo da conta: no extrato mensal
    // do Itaú a coluna "saldo R$" traz quase sempre "SALDO APLIC AUT MAIS" e,
    // conferindo contra ele, 4 de 14 linhas davam divergência falsa.
    if (saldoMoney !== null && label && OUTRA_CONTA_RE.test(label) && !OUTRA_CONTA_RE.test(principalLabel || '')) {
      otherSeries.push({ rowIdx: rowIdx + 1, label: cleanWhitespace(saldoCell || ''), saldoCents: toCents(saldoMoney.value) });
      if (firstSaldoCents === null) firstSaldoCents = toCents(saldoMoney.value);
      lastSaldoCents = toCents(saldoMoney.value);
      continue;
    }

    if (record) {
      pendingCents += toCents(record.value);
      pendingCount += 1;
    }

    if (saldoMoney === null) continue;

    const saldoCents = toCents(saldoMoney.value);
    if (firstSaldoCents === null) firstSaldoCents = saldoCents;
    lastSaldoCents = saldoCents;

    // “SALDO ANTERIOR” no meio do arquivo = o extrato reiniciou a conta
    // (seção “Últimos Lançamentos”). Serve de âncora nova, não de erro.
    if (/^saldo\s+anterior\b/.test(label) || baseCents === null) {
      anchors.push({
        rowIdx: rowIdx + 1,
        label: label || 'Primeiro saldo',
        saldoCents,
        kind: 'inicial',
      });
      baseCents = saldoCents;
      pendingCents = 0;
      pendingCount = 0;
      continue;
    }

    // Outro saldo (investimento, aplicação, bloqueado): fora da conferência.
    if (label && principalLabel !== null && label !== principalLabel) {
      otherSeries.push({ rowIdx: rowIdx + 1, label: saldoCell ? cleanWhitespace(saldoCell) : label, saldoCents });
      baseCents = saldoCents;
      pendingCents = 0;
      pendingCount = 0;
      continue;
    }
    if (!label && principalLabel === null) principalLabel = '';
    if (label && principalLabel === null) principalLabel = label;

    const expectedCents = baseCents + pendingCents;
    checked += 1;

    if (expectedCents === saldoCents) {
      matched += 1;
    } else {
      const lastRecord = pendingCount > 0 ? record : null;
      divergences.push({
        rowIdx: rowIdx + 1,
        dateBr: lastRecord?.dateBr || '',
        history: lastRecord?.history || cleanWhitespace(row.filter(Boolean).join(' ')),
        valueCents: lastRecord ? toCents(lastRecord.value) : 0,
        saldoCents,
        expectedCents,
        deltaCents: expectedCents - saldoCents,
        transactions: pendingCount,
        kind: pendingCount > 0 ? 'lancamento' : 'checkpoint',
      });
    }

    baseCents = saldoCents;
    pendingCents = 0;
    pendingCount = 0;

    if (isBalanceSummary) {
      anchors.push({
        rowIdx: rowIdx + 1,
        label: cleanWhitespace(saldoCell || 'Saldo'),
        saldoCents,
        kind: 'resumo',
      });
    }
  }

  return {
    available: true,
    columnHeader: mapping.header,
    checked,
    matched,
    divergences,
    anchors,
    otherSeries,
    firstSaldoCents,
    lastSaldoCents,
  };
}

/**
 * Conferência por checkpoints (extratos sem coluna de saldo).
 *
 * Soma os lançamentos entre dois saldos impressos e compara com a diferença:
 * `saldo(checkpoint N) - saldo(checkpoint N-1) = soma dos lançamentos no meio`.
 */
/**
 * Rótulos de saldo que pertencem a outra conta/série (aplicação, investimento,
 * poupança, bloqueado, limite): não podem ser conferidos contra os lançamentos
 * da conta corrente.
 */
const OUTRA_CONTA_RE = /\b(aplic|aplicacao|invest|investimento|poupanc|bloquead|limite|cdb|resgat)\b/;

function reconcileCheckpoints(parsedFile, checkpoints, transform = null, analysis = null) {
  const { records } = transform || transformRowsWithConfig(parsedFile, analysis);
  const sorted = [...checkpoints].sort((a, b) => (a.rowIdx ?? 0) - (b.rowIdx ?? 0));

  // Saldo de aplicação/investimento não é o saldo da conta corrente: somar os
  // lançamentos da conta contra ele nunca fecha.
  const daConta = sorted.filter((checkpoint) => !OUTRA_CONTA_RE.test(normalizeText(checkpoint.label || '')));

  if (daConta.length < 2 && sorted.length >= 2) {
    return {
      available: false,
      reason:
        'Os saldos impressos neste arquivo são de aplicação/investimento, não da conta corrente — ' +
        'a conferência de saldo não se aplica.',
      checked: 0,
      matched: 0,
      divergences: [],
      anchors: [],
      firstSaldoCents: null,
      lastSaldoCents: null,
    };
  }

  const usable = daConta.length >= 2 ? daConta : sorted;
  const anchora = usable.find((checkpoint) => /^saldo\s+anterior\b/.test(normalizeText(checkpoint.label)));
  const serie = anchora ? usable.slice(usable.indexOf(anchora)) : usable;

  if (serie.length < 2) {
    return {
      available: false,
      reason: 'Só apareceu um saldo no arquivo — sem dois checkpoints não há o que conferir.',
      checked: 0,
      matched: 0,
      divergences: [],
      anchors: [],
      firstSaldoCents: null,
      lastSaldoCents: null,
    };
  }

  const anchors = [];
  const divergences = [];
  let checked = 0;
  let matched = 0;
  let baseCents = toCents(serie[0].value);

  anchors.push({
    rowIdx: serie[0].rowIdx,
    label: serie[0].label || 'Saldo anterior',
    saldoCents: baseCents,
    kind: 'inicial',
  });

  for (let index = 1; index < serie.length; index++) {
    const checkpoint = serie[index];
    const startRow = serie[index - 1].rowIdx ?? 0;
    const endRow = checkpoint.rowIdx ?? Number.POSITIVE_INFINITY;

    const between = records.filter((record) => {
      const row = Number(record.sourceRow) - 1;
      return row >= startRow && row < endRow;
    });

    const sumCents = between.reduce((total, record) => total + toCents(record.value), 0);
    const saldoCents = toCents(checkpoint.value);
    const expectedCents = baseCents + sumCents;
    checked += 1;

    if (expectedCents === saldoCents) {
      matched += 1;
      anchors.push({
        rowIdx: checkpoint.rowIdx,
        label: checkpoint.label || 'Saldo',
        saldoCents,
        kind: 'checkpoint',
      });
    } else {
      const lastRecord = between[between.length - 1] || null;
      divergences.push({
        rowIdx: (checkpoint.rowIdx ?? 0) + 1,
        dateBr: lastRecord?.dateBr || '',
        history: lastRecord?.history || checkpoint.label || '',
        valueCents: lastRecord ? toCents(lastRecord.value) : 0,
        saldoCents,
        expectedCents,
        deltaCents: saldoCents - expectedCents,
        transactions: between.length,
        kind: between.length > 0 ? 'lancamento' : 'checkpoint',
      });
    }

    baseCents = saldoCents;
  }

  return {
    available: true,
    columnHeader: 'Saldos impressos no extrato',
    checked,
    matched,
    divergences,
    anchors,
    otherSeries: [],
    firstSaldoCents: toCents(serie[0].value),
    lastSaldoCents: baseCents,
    mode: 'checkpoint',
  };
}

/* -------------------------------------------------------------------------- */
/*                              Correções                                     */
/* -------------------------------------------------------------------------- */

function columnValues(rows, colIdx) {
  return rows.map((row) => row?.[colIdx]).filter((cell) => cleanWhitespace(cell));
}

function moneyStats(rows, colIdx) {
  let moneyCount = 0;
  let negativeCount = 0;
  let positiveCount = 0;
  let explicitSigns = 0;
  let explicitNegative = 0;
  let explicitPositive = 0;
  for (const row of rows) {
    const money = parseMoneyValue(row?.[colIdx]);
    if (money === null) continue;
    moneyCount += 1;
    const explicit = typeof money === 'object' && money.hasExplicitSign;
    if (explicit) {
      explicitSigns += 1;
      if (money.value < 0) explicitNegative += 1;
      else if (money.value > 0) explicitPositive += 1;
    }
    const value = typeof money === 'object' ? money.value : money;
    if (value < 0) negativeCount += 1;
    else if (value > 0) positiveCount += 1;
  }
  return { moneyCount, negativeCount, positiveCount, explicitSigns, explicitNegative, explicitPositive };
}

/**
 * Correções que o treinador propõe depois de olhar os dados.
 * Cada uma é uma ação explícita (`kind`) — nada é aplicado sem o usuário
 * confirmar no botão “Aplicar correções e treinar”.
 */
export function proposeFixes(parsedFile, analysis, reconciliation = null, transform = null) {
  const rows = Array.isArray(parsedFile?.rows) ? parsedFile.rows : [];
  const mappings = Array.isArray(analysis?.mappings) ? analysis.mappings : [];
  const rules = analysis?.rules || {};
  const fixes = [];
  const balance = reconciliation || reconcileBalances(parsedFile, analysis, transform);

  const valueMappings = mappings.filter((mapping) =>
    [ROLES.VALUE_AUTO, ROLES.VALUE_IN, ROLES.VALUE_OUT].includes(mapping.role)
  );

  // 1) Coluna de saldo entrando como valor: tira da soma.
  for (const mapping of valueMappings) {
    if (!SALDO_RE.test(normalizeText(mapping.header))) continue;
    fixes.push({
      id: `saldo-como-valor-${mapping.colIdx}`,
      kind: 'set_role',
      colIdx: mapping.colIdx,
      header: mapping.header,
      from: mapping.role,
      to: ROLES.IGNORE,
      label: `“${mapping.header}” é saldo, não lançamento`,
      reason: 'Saldo é a âncora da conferência; somá-lo duplicaria todo o período.',
    });
  }

  // 2) Documento/autenticação entrando como valor.
  for (const mapping of valueMappings) {
    const norm = normalizeText(mapping.header);
    if (SALDO_RE.test(norm) || !DOCUMENT_RE.test(norm)) continue;
    const stats = moneyStats(rows, mapping.colIdx);
    if (stats.moneyCount === 0) continue;
    fixes.push({
      id: `documento-como-valor-${mapping.colIdx}`,
      kind: 'set_role',
      colIdx: mapping.colIdx,
      header: mapping.header,
      from: mapping.role,
      to: ROLES.IGNORE,
      label: `“${mapping.header}” é número de documento`,
      reason: 'Documento/autenticação identifica o lançamento; não é dinheiro.',
    });
  }

  // 3) Crédito e débito trocados (sinal no lado errado).
  const inMappings = mappings.filter((mapping) => mapping.role === ROLES.VALUE_IN);
  const outMappings = mappings.filter((mapping) => mapping.role === ROLES.VALUE_OUT);
  for (const inMapping of inMappings) {
    const inStats = moneyStats(rows, inMapping.colIdx);
    const outMapping = outMappings[0];
    if (!outMapping) break;
    const outStats = moneyStats(rows, outMapping.colIdx);
    const inMostlyNegative = inStats.negativeCount > inStats.positiveCount;
    const outMostlyPositive = outStats.positiveCount > outStats.negativeCount;
    if (inMostlyNegative && outMostlyPositive) {
      fixes.push({
        id: `trocar-credito-debito`,
        kind: 'swap_roles',
        colIdx: inMapping.colIdx,
        otherColIdx: outMapping.colIdx,
        label: `Trocar “${inMapping.header}” e “${outMapping.header}”`,
        reason: `Os valores negativos estão em “${inMapping.header}” (que está como crédito) e os positivos em “${outMapping.header}” (que está como débito).`,
      });
    }
  }

  // 4) Sinal padrão: valores todos positivos, mas o dinheiro saiu da conta.
  if (valueMappings.length === 1 && valueMappings[0].role === ROLES.VALUE_AUTO) {
    const stats = moneyStats(rows, valueMappings[0].colIdx);
    const unsigned = stats.explicitSigns === 0 && stats.negativeCount === 0 && stats.moneyCount >= 2;
    if (unsigned && balance.available && balance.firstSaldoCents !== null && balance.lastSaldoCents !== null) {
      const saldoDelta = balance.lastSaldoCents - balance.firstSaldoCents;
      const records = (transform || transformRowsWithConfig(parsedFile, analysis)).records;
      const valuesCents = records.reduce((sum, record) => sum + Math.abs(toCents(record.value)), 0);
      if (valuesCents > 0) {
        const sameDirection = saldoDelta >= 0 ? 1 : -1;
        const magnitudeOk = Math.abs(Math.abs(saldoDelta) - valuesCents) <= Math.max(100, valuesCents * 0.02);
        if (magnitudeOk && sameDirection < 0) {
          fixes.push({
            id: 'sinal-padrao-negativo',
            kind: 'set_default_sign',
            to: 'negative',
            label: 'Forçar sinal de SAÍDA (-) nos valores sem sinal',
            reason: 'Os valores vêm todos positivos, mas o saldo do período CAIU exatamente o valor da soma — é um extrato de pagamentos.',
          });
        } else if (magnitudeOk && sameDirection > 0) {
          fixes.push({
            id: 'sinal-padrao-positivo',
            kind: 'set_default_sign',
            to: 'positive',
            label: 'Forçar sinal de ENTRADA (+) nos valores sem sinal',
            reason: 'Os valores vêm todos positivos e o saldo do período subiu exatamente o valor da soma — é um extrato de recebimentos.',
          });
        }
      }
    }
  }

  // 5) Coluna D/C sem função: o sinal já está no arquivo, só não foi lido.
  if (!mappings.some((mapping) => mapping.role === ROLES.DC_FLAG)) {
    for (const mapping of mappings) {
      if (![ROLES.IGNORE, ROLES.HISTORY].includes(mapping.role)) continue;
      const values = columnValues(rows, mapping.colIdx);
      if (values.length < 3) continue;
      const hits = values.filter((cell) => DC_CELL_RE.test(normalizeText(cell))).length;
      if (hits / values.length < 0.8) continue;
      fixes.push({
        id: `dc-flag-${mapping.colIdx}`,
        kind: 'set_role',
        colIdx: mapping.colIdx,
        header: mapping.header,
        from: mapping.role,
        to: ROLES.DC_FLAG,
        label: `“${mapping.header}” traz o indicador D/C`,
        reason: 'A coluna marca débito/crédito — usar isso evita adivinhar o sinal.',
      });
      break;
    }
  }

  return fixes;
}

/**
 * Aplica as correções num clone da análise (nada de efeito colateral).
 * @returns {object} nova análise, pronta para `trainAiWithLayout`
 */
export function applyCoachFixes(analysis, fixes = []) {
  const next = JSON.parse(JSON.stringify(analysis || {}));
  const mappings = Array.isArray(next.mappings) ? next.mappings : [];
  next.rules = { ...(next.rules || {}) };

  for (const fix of fixes) {
    if (fix.kind === 'set_role') {
      const mapping = mappings.find((item) => item.colIdx === fix.colIdx);
      if (!mapping) continue;
      mapping.role = fix.to;
      mapping.source = 'coach';
      mapping.reason = fix.label || 'Corrigido pelo treinador automático';
    } else if (fix.kind === 'swap_roles') {
      const first = mappings.find((item) => item.colIdx === fix.colIdx);
      const second = mappings.find((item) => item.colIdx === fix.otherColIdx);
      if (!first || !second) continue;
      [first.role, second.role] = [second.role, first.role];
      first.source = 'coach';
      second.source = 'coach';
    } else if (fix.kind === 'set_default_sign') {
      next.rules.defaultSign = fix.to;
      next.defaultSign = fix.to;
    }
  }

  // Histórico sempre renumerado 1..n na ordem das colunas.
  let order = 1;
  for (const mapping of mappings) {
    mapping.historyOrder = mapping.role === ROLES.HISTORY ? order++ : 0;
  }

  return next;
}

/* -------------------------------------------------------------------------- */
/*                            Relatório completo                              */
/* -------------------------------------------------------------------------- */

function statusOf(ok, warn = false) {
  if (ok === false) return CHECK_STATUS.FAIL;
  return warn ? CHECK_STATUS.WARN : CHECK_STATUS.OK;
}

function skippedByReason(skipped) {
  const map = new Map();
  for (const item of skipped) {
    map.set(item.reason, (map.get(item.reason) || 0) + 1);
  }
  return [...map.entries()].map(([reason, count]) => ({ reason, count }));
}

/**
 * Monta o relatório do treinador automático.
 *
 * @param {object} parsedFile tabela extraída (headers/rows/fileName)
 * @param {object} analysis   saída de `analyzeFileLayout`
 * @returns {object} relatório pronto para renderizar/serializar
 */
export function buildCoachReport(parsedFile, analysis, transform = null, options = {}) {
  const rows = Array.isArray(parsedFile?.rows) ? parsedFile.rows : [];
  const headers = Array.isArray(parsedFile?.headers) ? parsedFile.headers : [];
  const { records, skipped } = transform || transformRowsWithConfig(parsedFile, analysis || {});
  const balance = reconcileBalances(parsedFile, analysis, transform);

  // Reconhecimento do layout: catálogo de bancos → assinaturas aprendidas →
  // sinônimos genéricos. As divergências viram correções propostas.
  const recognition = recognizeLayout(parsedFile, {
    layouts: options.layouts || null,
    learnedSignatures: options.learnedSignatures || [],
  });

  const fixes = proposeFixes(parsedFile, analysis, balance, transform);

  for (const diff of diffRoles(analysis, recognition)) {
    const id = `layout-${diff.colIdx}-${diff.to}`;
    const sameColumn = fixes.find((fix) => fix.kind === 'set_role' && fix.colIdx === diff.colIdx);
    if (sameColumn) {
      // Já havia uma correção para a coluna: acrescenta o motivo do banco.
      if (sameColumn.to === diff.to && !sameColumn.reason.includes(diff.reason)) {
        sameColumn.reason = `${sameColumn.reason} ${diff.reason}`;
      }
      continue;
    }
    fixes.push({
      id,
      kind: 'set_role',
      colIdx: diff.colIdx,
      header: diff.header,
      from: diff.from,
      to: diff.to,
      label: `“${diff.header}”: ${diff.from} → ${diff.to}`,
      reason: diff.reason,
    });
  }

  const mappings = Array.isArray(analysis?.mappings) ? analysis.mappings : [];
  const dateMappings = mappings.filter((mapping) => mapping.role === ROLES.DATE);
  const valueMappings = mappings.filter((mapping) =>
    [ROLES.VALUE_AUTO, ROLES.VALUE_IN, ROLES.VALUE_OUT].includes(mapping.role)
  );
  const ignoredMappings = mappings.filter((mapping) => mapping.role === ROLES.IGNORE);

  // Datas: tudo que é lançamento precisa ter data válida; as demais linhas
  // (cabeçalho, total, rodapé) são descartadas de propósito.
  const withoutDate = skipped.filter((item) => item.reason === 'Sem data válida').length;
  const withoutValue = skipped.filter((item) => item.reason === 'Sem valor numérico válido').length;
  // Linha com data e sem valor é o caso suspeito (lançamento que não entrou).
  const withoutValueWithDate = skipped.filter(
    (item) =>
      item.reason === 'Sem valor numérico válido' &&
      (item.raw || []).some((cell) => /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(cleanWhitespace(cell)))
  ).length;
  const sectionRows = skipped.filter((item) => /grupo/i.test(item.reason)).length;

  // Sinal: só é problema quando o valor traz um sinal EXPLÍCITO contrário à
  // coluna (crédito com “-”, débito com “+”). Extratos imprimem as duas colunas
  // positivas (Pagto./Recbto.) e o sentido vem do nome da coluna — reclamar
  // disso enchia o diagnóstico de falso positivo (166 no Itaú Sul).
  let wrongSideSigns = 0;
  for (const mapping of mappings) {
    const stats = moneyStats(rows, mapping.colIdx);
    if (mapping.role === ROLES.VALUE_IN) wrongSideSigns += stats.explicitNegative;
    if (mapping.role === ROLES.VALUE_OUT) wrongSideSigns += stats.explicitPositive;
  }

  // Duplicados exatos (mesma data, valor e histórico).
  const duplicateMap = new Map();
  for (const record of records) {
    const key = `${record.dateIso}|${record.value}|${record.history}`;
    duplicateMap.set(key, (duplicateMap.get(key) || 0) + 1);
  }
  const duplicates = [...duplicateMap.entries()]
    .filter(([, count]) => count > 1)
    .map(([key, count]) => ({ key, count }));

  const inCents = records.filter((r) => r.value > 0).reduce((sum, r) => sum + toCents(r.value), 0);
  const outCents = records.filter((r) => r.value < 0).reduce((sum, r) => sum + toCents(r.value), 0);

  const dates = records.map((record) => record.dateIso).filter(Boolean).sort();
  const period = {
    firstIso: dates[0] || '',
    lastIso: dates[dates.length - 1] || '',
    firstBr: records.find((record) => record.dateIso === dates[0])?.dateBr || '',
    lastBr: records.find((record) => record.dateIso === dates[dates.length - 1])?.dateBr || '',
  };

  const checks = [];

  const bankName = recognition.bank?.name || '';
  const layoutDetail =
    recognition.source === 'catalog'
      ? `Extrato do ${bankName} reconhecido no catálogo de bancos (${Math.round(
          recognition.confidence * 100
        )}%).`
      : recognition.source === 'learned'
        ? `Layout reaproveitado de um treino anterior: ${recognition.evidence[0]}.`
        : 'Banco não está no catálogo: o mapeamento vem dos sinônimos das colunas (data, histórico, documento, saldo, crédito/débito).';

  checks.push({
    id: 'layout',
    label: 'Banco e layout',
    status: recognition.source === 'catalog' || recognition.source === 'learned' ? CHECK_STATUS.OK : CHECK_STATUS.WARN,
    detail: [layoutDetail, ...(recognition.evidence || []).filter((item) => !layoutDetail.includes(item))]
      .slice(0, 3)
      .join(' '),
  });

  checks.push({
    id: 'colunas',
    label: 'Colunas entendidas',
    status: statusOf(
      dateMappings.length > 0 && valueMappings.length > 0,
      ignoredMappings.length === 0 && mappings.length > 3
    ),
    detail:
      dateMappings.length > 0 && valueMappings.length > 0
        ? `${mappings.length} coluna(s): ${dateMappings.length} de data, ${valueMappings.length} de valor, ${
            mappings.length - dateMappings.length - valueMappings.length
          } de histórico/descartada(s).`
        : 'Não foi possível separar data e valor — ajuste a coluna marcada como Data e a de Valor.',
  });

  checks.push({
    id: 'lancamentos',
    label: 'Lançamentos extraídos',
    status: statusOf(records.length > 0),
    detail:
      records.length > 0
        ? `${records.length.toLocaleString('pt-BR')} lançamento(s) a partir de ${rows.length.toLocaleString(
            'pt-BR'
          )} linha(s)${
            withoutValue > 0
              ? ` • ${withoutValue} linha(s) sem valor (saldo, total ou rodapé)`
              : ''
          }.`
        : 'Nenhum lançamento válido — o mapeamento precisa de revisão.',
  });

  checks.push({
    id: 'datas',
    label: 'Datas',
    status: statusOf(
      records.length > 0 && withoutDate <= Math.max(2, records.length * 0.05),
      withoutDate > 0
    ),
    detail:
      records.length > 0
        ? `Todos os ${records.length.toLocaleString('pt-BR')} lançamentos com data${
            withoutDate > 0 ? ` • ${withoutDate} linha(s) sem data (cabeçalho/rodapé/resumo)` : ''
          }${sectionRows > 0 ? ` • ${sectionRows} título(s) de grupo usados no histórico` : ''}.`
        : 'Sem data — confira a coluna de data.',
  });

  checks.push({
    id: 'sinal',
    label: 'Sinal (crédito/débito)',
    status: statusOf(wrongSideSigns === 0, wrongSideSigns > 0),
    detail:
      wrongSideSigns === 0
        ? valueMappings.length > 1
          ? 'Crédito entra positivo e débito negativo — nenhum valor no lado errado.'
          : 'Valor único: o sinal vem do próprio número ou da regra escolhida.'
        : `${wrongSideSigns} valor(es) com sinal no lado errado da coluna — veja a correção proposta.`,
  });

  if (balance.available && balance.checked > 0) {
    const unified = balance.divergences.length === 0;
    checks.push({
      id: 'saldo',
      label: `Saldo conferido linha a linha (“${balance.columnHeader}”)`,
      status: statusOf(unified, balance.matched < balance.checked),
      detail: unified
        ? `${balance.checked.toLocaleString('pt-BR')} conferência(s) e todas fecham: saldo anterior + lançamentos = saldo. Saldo final ${fromCents(
            balance.lastSaldoCents ?? 0
          ).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}.`
        : `${balance.matched} de ${balance.checked} fecham — ${balance.divergences.length} linha(s) divergente(s) abaixo.`,
    });
  } else if (balance.available) {
    checks.push({
      id: 'saldo',
      label: `Saldo conferido linha a linha (“${balance.columnHeader}”)`,
      status: CHECK_STATUS.SKIP,
      detail:
        'Só há um saldo no arquivo (ou nenhum lançamento entre dois saldos): não dá para conferir a soma. A coluna continua fora do valor.',
    });
  } else {
    checks.push({
      id: 'saldo',
      label: 'Saldo conferido linha a linha',
      status: CHECK_STATUS.SKIP,
      detail: balance.reason || 'Arquivo sem coluna de saldo.',
    });
  }

  // `skipped` é o que sobrou para o conversor avaliar; o parser já descartou
  // cabeçalho, resumo, rodapé e linhas de saldo antes disso. Somamos os dois
  // para o diagnóstico não dizer “0 linhas fora” num extrato cheio de resumo.
  const parserSkipped = Number(parsedFile?.skippedRows) || 0;
  const discardedTotal = skipped.length + parserSkipped;

  checks.push({
    id: 'descartes',
    label: 'Cabeçalho, total e rodapé descartados',
    status: CHECK_STATUS.OK,
    detail: `${discardedTotal.toLocaleString('pt-BR')} linha(s) fora do resultado${
      balance.anchors.length > 0 ? ` • ${balance.anchors.length} âncora(s) de saldo usadas na conferência` : ''
    }${
      balance.otherSeries?.length
        ? ` • ${balance.otherSeries.length} saldo(s) de outra série ignorado(s) (ex.: “${balance.otherSeries[0].label}”)`
        : ''
    }.`,
  });

  checks.push({
    id: 'duplicados',
    label: 'Lançamentos idênticos',
    status: statusOf(true, duplicates.length > 0),
    detail:
      duplicates.length === 0
        ? 'Nenhum lançamento repetido com a mesma data, valor e histórico.'
        : `${duplicates.length} combinação(ões) repetida(s) (${duplicates.reduce(
            (sum, item) => sum + item.count,
            0
          )} linhas) — pode ser legítimo (duas taxas iguais no dia) ou arquivo duplicado.`,
  });

  const okCount = checks.filter((check) => check.status === CHECK_STATUS.OK).length;
  const warnCount = checks.filter((check) => check.status === CHECK_STATUS.WARN).length;
  const failCount = checks.filter((check) => check.status === CHECK_STATUS.FAIL).length;

  return {
    fileName: parsedFile?.fileName || '',
    generatedAt: new Date().toISOString(),
    counts: {
      rows: rows.length,
      columns: headers.length,
      records: records.length,
      skipped: skipped.length,
      skippedByReason: skippedByReason(skipped),
    },
    period,
    totals: {
      inCents,
      outCents,
      netCents: inCents + outCents,
      inCount: records.filter((record) => record.value > 0).length,
      outCount: records.filter((record) => record.value < 0).length,
    },
    checks,
    balance,
    duplicates,
    fixes,
    layout: {
      source: recognition.source,
      bank: recognition.bank,
      confidence: recognition.confidence,
      evidence: recognition.evidence,
      quirks: recognition.quirks || {},
    },
    score: { ok: okCount, warn: warnCount, fail: failCount, total: checks.length },
  };
}

/* -------------------------------------------------------------------------- */
/*                        Renderização (HTML puro)                            */
/* -------------------------------------------------------------------------- */

const ICON = {
  [CHECK_STATUS.OK]: '✓',
  [CHECK_STATUS.WARN]: '!',
  [CHECK_STATUS.FAIL]: '✗',
  [CHECK_STATUS.SKIP]: '–',
};

function brl(cents) {
  const value = Number(cents || 0) / 100;
  const text = Math.abs(value).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${value < 0 ? '-' : ''}${text}`;
}

/** Selo de resumo: `{ tone, icon, label, title }`. */
export function coachScore(report) {
  const score = report?.score || { ok: 0, warn: 0, fail: 0, total: 0 };
  const tone = score.fail > 0 ? 'fail' : score.warn > 0 ? 'warn' : 'ok';
  const balance = report?.balance;
  const hasBalance = balance?.available && balance.checked > 0;

  return {
    tone,
    icon: ICON[tone === 'fail' ? CHECK_STATUS.FAIL : tone === 'warn' ? CHECK_STATUS.WARN : CHECK_STATUS.OK],
    label: hasBalance
      ? `saldo conferido ${balance.matched}/${balance.checked}`
      : `${score.ok}/${score.total} conferências`,
    title: (report?.checks || []).map((check) => `${ICON[check.status] || '•'} ${check.label}`).join(' • '),
    scoreLabel: `${score.ok}/${score.total} conferências ✓`,
  };
}

/** Cartões do resumo (lançamentos, período, entradas, saídas, líquido, saldo). */
export function coachSummaryHtml(report) {
  if (!report) return '';
  const balance = report.balance;
  const stats = [
    ['Lançamentos', Number(report.counts?.records || 0).toLocaleString('pt-BR')],
    [
      'Período',
      report.period?.firstBr ? `${report.period.firstBr} → ${report.period.lastBr}` : '—',
    ],
    ['Entradas', brl(report.totals?.inCents)],
    ['Saídas', brl(report.totals?.outCents)],
    ['Líquido', brl(report.totals?.netCents)],
    [
      'Saldo conferido',
      balance?.available && balance.checked > 0 ? `${balance.matched}/${balance.checked}` : 'não se aplica',
    ],
  ];

  return stats
    .map(
      ([label, value]) =>
        `<div class="coach-stat"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`
    )
    .join('');
}

/** Lista de conferências, cada uma com o seu ícone e o seu tom. */
export function coachChecksHtml(report) {
  if (!report) return '';
  return (report.checks || [])
    .map(
      (check) => `
        <li class="coach-check status-${esc(check.status)}" data-check="${esc(check.id)}">
          <span class="coach-icon" aria-hidden="true">${ICON[check.status] || '•'}</span>
          <div class="coach-check-body">
            <strong>${esc(check.label)}</strong>
            <p>${esc(check.detail)}</p>
          </div>
        </li>`
    )
    .join('');
}

/** Correções propostas (vazio quando o layout já está certo). */
export function coachFixesHtml(report) {
  const fixes = report?.fixes || [];
  if (fixes.length === 0) return '';
  return `<h4>Correções propostas (${fixes.length})</h4><ul>${fixes
    .map((fix) => `<li><strong>${esc(fix.label)}</strong> <span>${esc(fix.reason)}</span></li>`)
    .join('')}</ul>`;
}

/** Linhas que não fecham o saldo (até 12 na tela). */
export function coachDivergencesHtml(report) {
  const divergences = report?.balance?.divergences || [];
  if (divergences.length === 0) return '';

  const items = divergences.slice(0, 12).map(
    (item) => `<li>
        <span class="coach-divergence-row">linha ${esc(item.rowIdx)}${
          item.dateBr ? ` • ${esc(item.dateBr)}` : ''
        }</span>
        ${esc(item.history || '')} — saldo ${esc(brl(item.saldoCents))},
        esperado ${esc(brl(item.expectedCents))} (diferença ${esc(brl(item.deltaCents))})
      </li>`
  );
  if (divergences.length > 12) {
    items.push(`<li><span>… e mais ${divergences.length - 12} linha(s).</span></li>`);
  }

  return `<h4>Linhas que não fecham o saldo (${divergences.length})</h4><ul>${items.join('')}</ul>`;
}

/* -------------------------------------------------------------------------- */
/*                        Relatório em texto (copiar)                         */
/* -------------------------------------------------------------------------- */

const STATUS_ICON = {
  [CHECK_STATUS.OK]: '✓',
  [CHECK_STATUS.WARN]: '!',
  [CHECK_STATUS.FAIL]: '✗',
  [CHECK_STATUS.SKIP]: '–',
};

/** Formata o relatório em texto — dá para colar num e-mail ou mandar para alguém. */
export function formatCoachReport(report) {
  if (!report) return '';
  const money = (cents) =>
    fromCents(cents || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const lines = [];

  lines.push(`Diagnóstico do arquivo: ${report.fileName || '(sem nome)'}`);
  lines.push(
    `${report.counts.records} lançamento(s) • ${report.period.firstBr || '-'} a ${report.period.lastBr || '-'}`
  );
  lines.push(`Entradas ${money(report.totals.inCents)} • Saídas ${money(report.totals.outCents)} • Líquido ${money(report.totals.netCents)}`);
  lines.push('');
  for (const check of report.checks) {
    lines.push(`${STATUS_ICON[check.status] || '•'} ${check.label}: ${check.detail}`);
  }

  if (report.balance.divergences.length > 0) {
    lines.push('');
    lines.push('Linhas que não fecham o saldo:');
    for (const item of report.balance.divergences.slice(0, 20)) {
      lines.push(
        `  linha ${item.rowIdx}: ${item.dateBr || '-'} ${item.history || ''} — valor ${money(
          item.valueCents
        )}, saldo ${money(item.saldoCents)}, esperado ${money(item.expectedCents)} (diferença ${money(
          item.deltaCents
        )})`
      );
    }
    if (report.balance.divergences.length > 20) {
      lines.push(`  … e mais ${report.balance.divergences.length - 20} linha(s).`);
    }
  }

  if (report.fixes.length > 0) {
    lines.push('');
    lines.push('Correções propostas:');
    for (const fix of report.fixes) lines.push(`  • ${fix.label} — ${fix.reason}`);
  }

  return lines.join('\n');
}
