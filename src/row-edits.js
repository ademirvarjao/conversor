/**
 * Conversor — Edições feitas à mão na planilha consolidada.
 *
 * O resultado unificado é **regenerado** a partir dos arquivos sempre que o
 * mapeamento, a memória da IA ou a lista de arquivos muda. Para que o que o
 * usuário digitou (histórico) e o que ele excluiu não se percam nesse caminho,
 * as edições ficam em mapas à parte, presas a uma chave estável de origem
 * (arquivo + linha do arquivo), e são reaplicadas a cada reconstrução.
 */

/** Chave estável de um lançamento: arquivo de origem + linha do arquivo. */
export function recordKey(record) {
  if (!record) return '';
  return `${record.sourceFile ?? ''}#${record.sourceRow ?? 0}`;
}

/**
 * Reaplica as edições do usuário na lista de lançamentos.
 *
 * @param {Array<object>} records lançamentos recém-extraídos dos arquivos
 * @param {{historyOverrides?: Map<string,string>, removedKeys?: Set<string>}} edits
 * @returns {{rows: Array<object>, removed: number, edited: number}}
 */
export function applyRowEdits(records, edits = {}) {
  const historyOverrides = edits.historyOverrides instanceof Map ? edits.historyOverrides : new Map();
  const removedKeys = edits.removedKeys instanceof Set ? edits.removedKeys : new Set();

  const rows = [];
  let removed = 0;
  let edited = 0;

  for (const record of records || []) {
    const key = recordKey(record);
    const override = historyOverrides.get(key);

    if (typeof override === 'string' && override) {
      if (record.originalHistory === undefined) record.originalHistory = record.history;
      if (override !== record.history) {
        record.history = override;
        edited += 1;
      }
    }

    if (removedKeys.has(key)) {
      removed += 1;
      continue;
    }

    rows.push(record);
  }

  return { rows, removed, edited };
}

/**
 * Guarda (ou remove) o histórico digitado para um lançamento.
 *
 * Texto vazio, igual ao original ou só com espaços desfaz a edição e devolve o
 * histórico que veio do arquivo.
 *
 * @returns {boolean} `true` quando o histórico do lançamento mudou
 */
export function setHistoryOverride(state, record, rawHistory) {
  const key = recordKey(record);
  if (!key) return false;

  const original = record.originalHistory ?? record.history ?? '';
  if (record.originalHistory === undefined) record.originalHistory = original;
  const text = String(rawHistory ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);

  const overrides = state.historyOverrides;
  if (!text || text === original) {
    overrides.delete(key);
    record.history = original;
    return false;
  }

  overrides.set(key, text);
  record.history = text;
  return true;
}
