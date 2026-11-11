/**
 * Conversor — Escopo da exportação
 *
 * Regra pedida pelo usuário, em uma frase:
 *   **exporta o que estiver marcado; se nada estiver marcado, exporta tudo.**
 *
 * A caixa “exportar apenas o resultado filtrado” continua valendo como escolha
 * do usuário para o caso sem seleção (marcada = filtro atual, desmarcada =
 * todos os lançamentos). Com seleção, a seleção manda — inclusive linhas que
 * estão fora do filtro/página atual.
 *
 * Este módulo é puro de propósito: a regra fica testável sem DOM.
 */

/** Chave estável de um lançamento (mesma usada pela planilha consolidada). */
export function defaultRecordKey(record) {
  if (!record) return '';
  return [
    record.dateIso || '',
    Number(record.value) || 0,
    record.sourceFile || '',
    record.sourceRow ?? record.history ?? '',
  ].join('|');
}

/**
 * @param {object} options
 * @param {Array<object>} options.allRows      todos os lançamentos da conciliação
 * @param {Array<object>} options.filteredRows lançamentos do filtro/busca atual
 * @param {Iterable<string>} options.selected  chaves marcadas na planilha
 * @param {boolean} options.onlyFiltered       caixa “somente o resultado filtrado”
 * @param {(row: object) => string} [options.keyOf]
 * @returns {{ rows: Array<object>, scope: 'selection'|'filtered'|'all' }}
 */
export function resolveExportRows({
  allRows = [],
  filteredRows = [],
  selected = [],
  onlyFiltered = false,
  keyOf = defaultRecordKey,
} = {}) {
  const selectedSet = selected instanceof Set ? selected : new Set(selected || []);

  if (selectedSet.size > 0) {
    // Mantém a ordem da planilha (data/valor/histórico), não a ordem dos cliques.
    const rows = allRows.filter((row) => selectedSet.has(keyOf(row)));
    if (rows.length > 0) return { rows, scope: 'selection' };
  }

  if (onlyFiltered) return { rows: filteredRows.slice(), scope: 'filtered' };
  return { rows: allRows.slice(), scope: 'all' };
}

/**
 * Texto curto para a dica ao lado dos botões de exportação.
 * @returns {string}
 */
export function describeExportScope({ scope, count = 0, selectedCount = 0, totalCount = 0 }) {
  const n = (value) => Number(value || 0).toLocaleString('pt-BR');
  if (scope === 'selection') {
    return `Exportando os ${n(selectedCount || count)} selecionados (de ${n(totalCount)}).`;
  }
  if (scope === 'filtered') {
    return `Nada selecionado: exporta o resultado filtrado (${n(count)} de ${n(totalCount)}).`;
  }
  return `Nada selecionado: exporta todos os ${n(count)} lançamentos.`;
}
