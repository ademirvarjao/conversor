/**
 * Conversor — Edições feitas à mão na planilha consolidada.
 *
 * O resultado unificado é **regenerado** a partir dos arquivos sempre que o
 * mapeamento, a memória da IA ou a lista de arquivos muda. Para que o que o
 * usuário digitou (histórico) e o que ele excluiu não se percam nesse caminho,
 * as edições ficam em mapas à parte, presas a uma chave estável de origem
 * (arquivo + linha do arquivo), e são reaplicadas a cada reconstrução.
 */

/**
 * Chave estável de um lançamento: origem + linha do arquivo.
 *
 * A origem é o **id da importação** (`sourceFileId`) e só cai para o nome do
 * arquivo quando ele não existe (chamadas antigas e testes). Isso importa
 * porque dois extratos podem chegar com o mesmo nome — "extrato.pdf" de
 * outubro e de novembro, por exemplo. Com o nome, editar ou excluir a linha 7
 * de um mexeria na linha 7 do outro.
 */
export function recordKey(record) {
  if (!record) return '';
  const origem = record.sourceFileId || record.sourceFile || '';
  return `${origem}#${record.sourceRow ?? 0}`;
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

/**
 * Esquece as edições presas a um arquivo que saiu da conciliação.
 *
 * A chave de um lançamento é `nome do arquivo # linha`, então as edições e
 * exclusões feitas à mão continuam "vivas" depois que o arquivo é removido —
 * e voltariam a valer se o mesmo nome fosse importado de novo (por exemplo,
 * depois de corrigir e reenviar o extrato), fazendo linhas desaparecerem sem
 * explicação. Aqui elas são descartadas junto com o arquivo.
 *
 * @param {{historyOverrides?: Map<string,string>, removedKeys?: Set<string>}} state
 * @param {...string} origins id da importação e/ou nome do arquivo
 * @returns {number} quantas chaves foram descartadas
 */
export function forgetFileEdits(state, ...origins) {
  const prefixes = origins
    .filter((origin) => typeof origin === 'string' && origin !== '')
    .map((origin) => `${origin}#`);
  if (prefixes.length === 0) return 0;

  const matches = (key) => prefixes.some((prefix) => key.startsWith(prefix));
  let dropped = 0;

  for (const key of [...(state.historyOverrides?.keys?.() || [])]) {
    if (!matches(key)) continue;
    state.historyOverrides.delete(key);
    dropped += 1;
  }
  for (const key of [...(state.removedKeys || [])]) {
    if (!matches(key)) continue;
    state.removedKeys.delete(key);
    dropped += 1;
  }
  return dropped;
}
