/**
 * Conversor Custódio — Totalizadores da conciliação.
 * Centraliza o cálculo para que tela, PDF e testes usem exatamente a mesma regra.
 */

import { formatIsoToBrDate, fromCents, toCents } from './format.js';

/**
 * @param {Array<{dateIso:string,value:number}>} records
 * @param {{skippedCount?:number}} [options]
 */
export function summarizeRecords(records, { skippedCount = 0 } = {}) {
  let inCents = 0;
  let outCents = 0;
  let inCount = 0;
  let outCount = 0;
  let minDateIso = '';
  let maxDateIso = '';

  for (const record of records || []) {
    const cents = toCents(record?.value);
    if (cents >= 0) {
      inCents += cents;
      inCount++;
    } else {
      outCents += cents;
      outCount++;
    }

    const dateIso = record?.dateIso;
    if (typeof dateIso === 'string' && dateIso) {
      if (!minDateIso || dateIso < minDateIso) minDateIso = dateIso;
      if (!maxDateIso || dateIso > maxDateIso) maxDateIso = dateIso;
    }
  }

  return {
    count: Array.isArray(records) ? records.length : 0,
    totalIn: fromCents(inCents),
    inCount,
    totalOut: fromCents(outCents),
    totalOutAbs: fromCents(Math.abs(outCents)),
    outCount,
    netTotal: fromCents(inCents + outCents),
    skippedCount: Math.max(0, Number(skippedCount) || 0),
    minDateIso,
    maxDateIso,
    minDateBr: formatIsoToBrDate(minDateIso),
    maxDateBr: formatIsoToBrDate(maxDateIso),
  };
}

/** Rótulo do período para exibição/exportação. */
export function formatPeriodLabel(summary) {
  if (!summary?.minDateBr || !summary?.maxDateBr) return 'Período não identificado';
  if (summary.minDateBr === summary.maxDateBr) return `Período: ${summary.minDateBr}`;
  return `Período: ${summary.minDateBr} a ${summary.maxDateBr}`;
}
