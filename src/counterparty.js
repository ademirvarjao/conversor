/**
 * Conversor — Conciliação de clientes e fornecedores (cadastro Questor)
 *
 * O banco/ERP exporta um PDF de contatos ("Questor_Exportacao") com as colunas
 * `contactb`, `nomepessoa` e `natureza` (além de `classificacao`, `tipoconta` e
 * `inscrfederal`). Esse cadastro diz quem são os fornecedores (natureza
 * **Credora**, conta 2.x) e os clientes (natureza **Devedora**, conta 1.x).
 *
 * A conciliação liga cada lançamento do extrato ao contato certo pelo nome que
 * aparece no histórico:
 *   - saída de caixa (pagamento)  → procura fornecedor (natureza Credora) e
 *     lança o valor em **débito** (baixa da obrigação);
 *   - entrada de caixa (recebimento) → procura cliente (natureza Devedora) e
 *     lança o valor em **crédito** (baixa do direito).
 *
 * O layout de saída é `data, debito, credito, valor, historico`, sempre com
 * valores positivos (o sinal fica implícito na coluna usada).
 *
 * A cada uso o módulo aprende: vínculos confirmados viram apelidos
 * (histórico → contato) e os tokens do nome ganham peso. Nada aqui toca no DOM
 * nem no localStorage — é tudo função pura, testável no Node.
 */

import { formatIsoToBrDate, toCents } from './format.js';
import { cleanWhitespace, normalizeText, parseDateValue, parseMoneyValue } from './parsers.js';

/* -------------------------------------------------------------------------- */
/*                                  Constantes                                */
/* -------------------------------------------------------------------------- */

export const NATUREZA = {
  CREDORA: 'credora',
  DEVEDORA: 'devedora',
};

export const NATUREZA_LABELS = {
  [NATUREZA.CREDORA]: 'Credora (fornecedores)',
  [NATUREZA.DEVEDORA]: 'Devedora (clientes)',
};

/** Direção do caixa, derivada do sinal do lançamento. */
export const DIRECTION = {
  PAYMENT: 'payment',
  RECEIPT: 'receipt',
};

/** Rótulos aceitos no cabeçalho de cada coluna (já normalizados). */
const COLUMN_ALIASES = {
  classificacao: ['classificacao', 'classific', 'contacontabil', 'planodecontas'],
  contactb: ['contactb', 'contato', 'codcontato', 'codigocontato', 'codigo', 'cod'],
  nomepessoa: ['nomepessoa', 'nome', 'nomerazao', 'razaosocial', 'nomefantasia', 'pessoa'],
  natureza: ['natureza', 'naturezaconta', 'naturezadaconta'],
  tipoconta: ['tipoconta', 'tipo', 'tipodeconta'],
  documento: ['inscrfederal', 'inscricaofederal', 'cnpjcpf', 'cnpj', 'cpf', 'documento', 'cpfcnpj'],
};

/** Palavras que não ajudam a identificar a pessoa (sufixos e conectivos). */
const STOP_WORDS = new Set([
  'ltda', 'ltd', 'sa', 's', 'a', 'me', 'epp', 'eireli', 'mei', 'cia', 'e',
  'de', 'da', 'do', 'das', 'dos', 'em', 'para', 'com', 'por', 'the',
  'cpq', 'cwb', 'filial', 'matriz', 'grupo',
]);

/** Limiares de decisão do casamento nome × histórico. */
const MATCH_THRESHOLD = 0.62;
const AMBIGUOUS_THRESHOLD = 0.55;
const AMBIGUITY_MARGIN = 0.06;

/**
 * Peso do casamento por CPF/CNPJ. Documento no histórico é **identidade**, não
 * semelhança de nome: quando bate com o cadastro, vale mais que qualquer
 * coincidência de palavras (PIX e TED às vezes trazem só o documento).
 */
const DOCUMENT_MATCH_SCORE = 0.99;

/** Tamanhos válidos de documento: CPF (11) e CNPJ (14). */
const DOCUMENT_LENGTHS = new Set([11, 14]);

/** CNPJ mascarado (`12.345.678/0001-99`) ou só os 14 dígitos. */
const CNPJ_PATTERN = /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b|\b\d{14}\b/;

/** CPF mascarado (`123.456.789-09`) ou só os 11 dígitos. */
const CPF_PATTERN = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b|\b\d{11}\b/;

const MAX_ALIASES = 800;
const MAX_KNOWN_CONTACTS = 4000;
const MAX_TOKEN_WEIGHT = 6;
/** Quantos históricos/contatos com conta memorizada ficam guardados. */
const MAX_ACCOUNT_ENTRIES = 600;
/**
 * A partir de quantas confirmações a conta aprendida é aplicada sozinha. Com
 * uma só confirmação ela aparece como **sugestão** clicável.
 */
const ACCOUNT_AUTO_CONFIRM_HITS = 2;

/* -------------------------------------------------------------------------- */
/*                             Texto e normalização                          */
/* -------------------------------------------------------------------------- */

/** Chave de comparação: sem acento, minúscula e sem pontuação. */
export function normalizeKey(value) {
  return normalizeText(value)
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Remove ruído comum do PDF (encoding quebrado virou "?"). */
export function cleanName(value) {
  return cleanWhitespace(String(value ?? '').replace(/[?¿]/g, ' '));
}

/**
 * Tokens que identificam a pessoa: sem sufixos societários, conectivos,
 * números de documento e pedaços com menos de 3 letras.
 */
export function significantTokens(value) {
  return normalizeKey(cleanName(value))
    .split(' ')
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token) && !/^\d+$/.test(token));
}

/** Nome sem espaços, usado para o teste de "nome inteiro dentro do histórico". */
function compactName(value) {
  return normalizeKey(cleanName(value)).replace(/ /g, '');
}

/**
 * "Núcleo" do histórico: os primeiros tokens significativos, sem números de
 * nota/documento. É a chave dos apelidos aprendidos.
 */
export function historyCore(history) {
  return significantTokens(history).slice(0, 3).join(' ');
}

/* -------------------------------------------------------------------------- */
/*                        CPF / CNPJ (identidade forte)                       */
/* -------------------------------------------------------------------------- */

/**
 * Só os dígitos de um CPF/CNPJ — ou `null` quando o valor não é documento.
 *
 * O cadastro do Questor às vezes traz o campo vazio como `-`, `0` ou com o
 * clássico documento de teste `111.111.111-11`; nenhum deles identifica
 * ninguém, então todos caem fora (só valem 11 ou 14 dígitos, nunca repetidos).
 */
export function documentDigits(value) {
  const digits = String(value ?? '').replace(/\D+/g, '');
  if (!DOCUMENT_LENGTHS.has(digits.length)) return null;
  if (/^(\d)\1+$/.test(digits)) return null;
  return digits;
}

/**
 * Índice dos documentos que aparecem num histórico.
 *
 * O banco imprime o documento das duas formas (`123.456.789-09` e
 * `12345678909`), então os pedaços de dígitos são reunidos na ordem em que
 * aparecem: assim a versão com pontos, barra e traço também é encontrada.
 * A busca é por conteúdo (`includes`), porque o histórico pode trazer o
 * documento grudado em outro número ("NF 1234 CPF 123.456.789-09").
 */
function indexHistoryDocuments(history) {
  const text = String(history ?? '');
  if (!/\d{11}/.test(text.replace(/[^\d]+/g, ''))) return { blob: '', runs: new Set() };
  const runs = new Set();
  let blob = '';
  for (const chunk of text.split(/[^\d]+/)) {
    if (!chunk) continue;
    if (DOCUMENT_LENGTHS.has(chunk.length)) runs.add(chunk);
    blob += chunk;
  }
  return { blob, runs };
}

/** Cache do documento por contato (a mesma lista é pontuada linha a linha). */
const documentCache = new WeakMap();

function contactDocument(contact) {
  if (!contact || typeof contact !== 'object') return null;
  if (documentCache.has(contact)) return documentCache.get(contact);
  const digits = documentDigits(contact.document);
  documentCache.set(contact, digits);
  return digits;
}

/** O histórico desta transação traz o CPF/CNPJ deste contato? */
export function documentMatches(contact, context) {
  const digits = contactDocument(contact);
  if (!digits) return false;
  const documents = context?.documents;
  if (!documents || !documents.blob) return false;
  if (documents.runs?.has(digits)) return true;
  return documents.blob.includes(digits);
}

/** O histórico traz algum CPF/CNPJ? (usado para avisar o usuário na tela) */
export function historyHasDocument(history) {
  const { blob } = indexHistoryDocuments(history);
  return blob.length >= 11;
}

/** O histórico contém **este** CPF/CNPJ? (usado no painel de vínculo) */
export function historyContainsDocument(history, document) {
  const digits = documentDigits(document);
  if (!digits) return false;
  const { blob } = indexHistoryDocuments(history);
  return blob.includes(digits);
}

/**
 * Primeiro CPF/CNPJ que aparece num histórico, já formatado (ou `''`).
 * Serve para explicar na tela por que um vínculo foi automático.
 */
export function findDocumentInHistory(history) {
  const text = String(history ?? '');
  // CNPJ primeiro (14 dígitos): é o formato que mais aparece em pagamento a
  // empresa. `\b` impede recortar um pedaço de um número maior.
  for (const pattern of [CNPJ_PATTERN, CPF_PATTERN]) {
    const match = pattern.exec(text);
    if (match) {
      const digits = documentDigits(match[0]);
      if (digits) return formatDocument(digits);
    }
  }
  return '';
}

/** Documento pronto para mostrar na tela: `12.345.678/0001-99` ou `123.456.789-09`. */
export function formatDocument(document) {
  const digits = documentDigits(document);
  if (!digits) return '';
  if (digits.length === 14) {
    return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`;
  }
  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
}

/* -------------------------------------------------------------------------- */
/*                          Cadastro (PDF ou planilha)                        */
/* -------------------------------------------------------------------------- */

function headerKey(text) {
  const key = normalizeKey(text);
  if (!key) return null;
  for (const [column, aliases] of Object.entries(COLUMN_ALIASES)) {
    if (aliases.includes(key)) return column;
  }
  return null;
}

export function natureFromText(value) {
  const key = normalizeKey(value);
  if (!key) return null;
  if (key.startsWith('cred')) return NATUREZA.CREDORA;
  if (key.startsWith('deve')) return NATUREZA.DEVEDORA;
  return null;
}

/** Natureza deduzida pelo plano de contas quando a coluna vem vazia. */
export function natureFromClassification(code) {
  const key = String(code ?? '').trim();
  if (/^1[.\s]/.test(key)) return NATUREZA.DEVEDORA; // Ativo — clientes
  if (/^2[.\s]/.test(key)) return NATUREZA.CREDORA; // Passivo — fornecedores
  return null;
}

function linesInReadingOrder(allPageLines) {
  return [...(allPageLines || [])].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    return b.y - a.y;
  });
}

function itemsOfLine(line) {
  return [...(line.items || [])]
    .filter((item) => cleanWhitespace(item.str))
    .sort((a, b) => a.x - b.x);
}

/**
 * Lê o cadastro de contatos a partir das linhas de texto do PDF.
 *
 * Funciona sem saber a ordem das colunas: procura a linha de cabeçalho pelos
 * nomes conhecidos (`contactb`, `nomepessoa`, ...), ancora cada coluna no X do
 * próprio cabeçalho e distribui os itens seguintes por proximidade.
 *
 * @returns {{contacts: object[], header: object|null, rejected: number}}
 */
export function buildContactsFromLines(allPageLines) {
  const lines = linesInReadingOrder(allPageLines);
  const contacts = [];
  let header = null;
  let rejected = 0;

  for (const line of lines) {
    const items = itemsOfLine(line);
    if (items.length === 0) continue;

    const mapped = items.map((item) => ({ ...item, column: headerKey(item.str) })).filter((item) => item.column);
    const looksLikeHeader =
      mapped.some((item) => item.column === 'nomepessoa') && mapped.length >= 2;

    if (looksLikeHeader) {
      // Cabeçalho pode repetir a cada página: mantém o mais completo.
      if (!header || mapped.length > header.columns.length) {
        header = {
          page: line.page,
          y: line.y,
          columns: mapped.map((item) => ({ column: item.column, x: item.x })),
        };
      }
      continue;
    }

    if (!header) continue;

    const record = rowFromItems(items, header);
    const contact = contactFromRecord(record);
    if (contact) contacts.push(contact);
    else rejected += 1;
  }

  return { contacts: dedupeContacts(contacts), header, rejected };
}

function rowFromItems(items, header) {
  const columns = [...header.columns].sort((a, b) => a.x - b.x);
  const record = {};
  const extras = [];

  for (const item of items) {
    // A coluna de um item é a última âncora à esquerda dele.
    let target = null;
    for (const column of columns) {
      if (item.x >= column.x - 3) target = column;
      else break;
    }
    if (!target) {
      extras.push(item.str);
      continue;
    }
    record[target.column] = record[target.column]
      ? `${record[target.column]} ${item.str}`
      : item.str;
  }

  if (extras.length > 0) {
    // Texto à esquerda da primeira âncora costuma ser continuação do nome.
    record.__extras = extras.join(' ');
  }

  return record;
}

function contactFromRecord(record) {
  const name = cleanName(record.nomepessoa);
  if (!name || headerKey(name)) return null;

  const classification = cleanWhitespace(record.classificacao);
  const natureza = natureFromText(record.natureza) || natureFromClassification(classification);
  if (!natureza) return null;

  // Rodapés e totais não têm código de contato.
  const code = cleanWhitespace(record.contactb).replace(/[^\d./-]/g, '');
  if (!code) return null;

  return {
    code,
    name,
    natureza,
    classification,
    accountType: cleanWhitespace(record.tipoconta),
    document: cleanWhitespace(record.documento),
  };
}

/** Versão para planilhas (.xlsx) com os mesmos cabeçalhos. */
export function buildContactsFromTable(headers, rows) {
  const columns = (headers || []).map((label) => headerKey(label));
  const contacts = [];
  let rejected = 0;

  for (const row of rows || []) {
    const record = {};
    columns.forEach((column, index) => {
      if (!column) return;
      record[column] = cleanWhitespace(row[index]);
    });
    const contact = contactFromRecord(record);
    if (contact) contacts.push(contact);
    else rejected += 1;
  }

  return { contacts: dedupeContacts(contacts), header: { page: 1, columns }, rejected };
}

/**
 * Junta duplicidades do cadastro (mesmo código aparece com grafias diferentes).
 * Mantém o nome mais completo e guarda todas as variantes para o casamento.
 */
export function dedupeContacts(contacts) {
  const byKey = new Map();

  for (const contact of contacts || []) {
    const key = `${contact.natureza}|${contact.code}`;
    const incomingAliases =
      Array.isArray(contact.aliases) && contact.aliases.length > 0
        ? [...contact.aliases, contact.name]
        : [contact.name];
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, { ...contact, aliases: [...new Set(incomingAliases)] });
      continue;
    }

    for (const alias of incomingAliases) {
      if (!current.aliases.some((existing) => normalizeKey(existing) === normalizeKey(alias))) {
        current.aliases.push(alias);
      }
    }
    if (contact.name.length > current.name.length) current.name = contact.name;
    if (!current.document && contact.document) current.document = contact.document;
    if (!current.classification && contact.classification) current.classification = contact.classification;
  }

  return [...byKey.values()]
    .map((contact) => finalizeContact(contact))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

function finalizeContact(contact) {
  const tokens = new Set();
  const compact = new Set();

  for (const alias of contact.aliases || [contact.name]) {
    for (const token of significantTokens(alias)) tokens.add(token);
    const packed = compactName(alias);
    if (packed.length >= 6) compact.add(packed);
  }

  return {
    ...contact,
    tokens: [...tokens],
    compactNames: [...compact],
    label: `${contact.name}${contact.code ? ` (${contact.code})` : ''}`,
  };
}

/**
 * Junta os contatos de vários arquivos de cadastro num só, sem duplicar o mesmo
 * `contactb` e guardando as grafias de todos eles.
 */
export function mergeContacts(lists) {
  const all = [];
  for (const list of lists || []) {
    for (const contact of list || []) all.push(contact);
  }
  return dedupeContacts(all);
}

/** Chave de comparação de um lançamento (para não duplicar arquivos repetidos). */
function transactionKey(transaction) {
  return [
    transaction.dateIso || transaction.date || '',
    transaction.amountCents,
    normalizeKey(transaction.history),
  ].join('|');
}

/**
 * Junta os lançamentos de vários extratos.
 *
 * A mesma linha pode aparecer em dois arquivos (extrato do mês + cópia): nesse
 * caso fica apenas uma. Mas duas linhas idênticas dentro do mesmo arquivo são
 * legítimas (duas taxas iguais no mesmo dia), então vale a maior quantidade
 * encontrada em um único arquivo.
 */
export function mergeTransactions(lists) {
  const maxByKey = new Map();
  const sampleByKey = new Map();

  for (const list of lists || []) {
    const countByKey = new Map();
    for (const transaction of list || []) {
      const key = transactionKey(transaction);
      countByKey.set(key, (countByKey.get(key) || 0) + 1);
      if (!sampleByKey.has(key)) sampleByKey.set(key, transaction);
    }
    for (const [key, count] of countByKey) {
      maxByKey.set(key, Math.max(maxByKey.get(key) || 0, count));
    }
  }

  const merged = [];
  for (const [key, count] of maxByKey) {
    for (let index = 0; index < count; index += 1) merged.push(sampleByKey.get(key));
  }

  return merged.sort((a, b) => String(a.dateIso || a.date).localeCompare(String(b.dateIso || b.date)));
}

/* -------------------------------------------------------------------------- */
/*                                Lançamentos                                 */
/* -------------------------------------------------------------------------- */

/**
 * Converte os registros já consolidados pelo Conversor em transações da
 * conciliação, preservando data, valor e histórico.
 */
export function buildSourceTransactions(records) {
  const transactions = [];

  for (const record of records || []) {
    const numeric =
      typeof record.value === 'number' ? record.value : parseMoneyValue(record.value)?.value;
    const amountCents = Number.isFinite(numeric) ? toCents(numeric) : NaN;
    if (!Number.isFinite(amountCents) || amountCents === 0) continue;

    transactions.push({
      date: record.dateBr || formatIsoToBrDate(record.dateIso) || '',
      dateIso: record.dateIso || '',
      amountCents,
      amount: Math.abs(amountCents) / 100,
      direction: amountCents < 0 ? DIRECTION.PAYMENT : DIRECTION.RECEIPT,
      history: cleanWhitespace(record.history),
      /** CPF/CNPJ da contraparte, quando o extrato traz a coluna. */
      document: cleanWhitespace(record.document || ''),
      sourceFile: record.sourceFile || '',
    });
  }

  return transactions;
}

/**
 * Código do contato como o ERP espera nas colunas de débito/crédito: só dígitos.
 * `5.00.046` → `500046`.
 */
export function contactCode(code) {
  return String(code ?? '').replace(/[^0-9]/g, '');
}

/** Status possíveis de uma linha conciliada. */
export const ROW_STATUS = {
  MATCHED: 'matched',
  AMBIGUOUS: 'ambiguous',
  UNMATCHED: 'unmatched',
  MANUAL: 'manual',
};

/**
 * Aplica a **conta de contrapartida** digitada à mão numa linha.
 *
 * A contrapartida não substitui a conta do contato: ela complementa a coluna
 * vazia ao lado. O lançamento tem duas pontas —
 *   - pagamento: débito = fornecedor (credora), então a contrapartida vai no
 *     **crédito** (banco/caixa);
 *   - recebimento: crédito = cliente (devedora), então a contrapartida vai no
 *     **débito**.
 *
 * Sem conta informada, a contrapartida da linha é limpa.
 */
export function applyRowAccount(row, rawAccount) {
  if (!row) return row;

  const account = contactCode(rawAccount);
  const isPayment = row.direction === DIRECTION.PAYMENT;

  if (isPayment) row.creditAccount = account;
  else row.debitAccount = account;

  row.counterpartAccount = account;
  return row;
}

/** A coluna (débito/crédito) que carrega a conta do contato, pela direção. */
export function contactAccountSide(row) {
  return row?.direction === DIRECTION.PAYMENT ? 'debit' : 'credit';
}

/**
 * Recalcula a contrapartida da linha a partir das duas colunas: ela é sempre a
 * conta do **lado oposto** ao do contato.
 */
export function syncCounterpartAccount(row) {
  if (!row) return row;
  row.counterpartAccount = row[contactAccountSide(row) === 'debit' ? 'creditAccount' : 'debitAccount'] || '';
  return row;
}

/** Célula preenchida à mão pelo usuário (pode ser editada ou limpa de novo). */
export function isManualAccountCell(row, side) {
  return Boolean(row?.manualCells?.[side === 'credit' ? 'credit' : 'debit']);
}

/**
 * Preenche **uma** coluna (débito ou crédito) direto na tabela, à mão.
 *
 * Só serve para completar o que está vazio: uma conta que veio do cadastro do
 * contato (ou de um lote anterior) não é sobrescrita. O valor digitado passa a
 * contar como contrapartida quando está no lado oposto ao do contato, e a
 * célula fica reeditável para o usuário corrigir ou limpar o que digitou.
 */
export function setRowCellAccount(row, side, rawAccount) {
  if (!row) return row;

  const cell = side === 'credit' ? 'credit' : 'debit';
  const key = cell === 'credit' ? 'creditAccount' : 'debitAccount';
  const account = contactCode(rawAccount);

  if (row[key] && row[key] !== account && !isManualAccountCell(row, cell)) return row;

  row[key] = account;
  row.manualCells = { ...(row.manualCells || {}) };
  if (account) row.manualCells[cell] = true;
  else delete row.manualCells[cell];

  return syncCounterpartAccount(row);
}

/** 60%+ das palavras do nome já aparecem no texto: o nome é redundante. */
function nameMostlyPresent(name, existingText) {
  const tokens = significantTokens(name);
  if (tokens.length === 0) return true;
  const existing = new Set(significantTokens(existingText));
  const hits = tokens.filter((token) => existing.has(token)).length;
  return hits / tokens.length >= 0.6;
}

/**
 * Cabeçalhos que trazem o nome de quem está do outro lado da operação.
 *
 * Extratos como o do Itaú ICS separam a descrição ("PIX ENVIADO") do nome
 * ("Razão Social"); sem juntar os dois o histórico não tem nome nenhum e a
 * conciliação não acha contato.
 */
const NAME_COLUMN_PATTERNS = [
  'razao',
  'nome',
  'favorecido',
  'beneficiar',
  'pagador',
  'recebedor',
  'sacado',
  'cliente',
  'fornecedor',
  'contraparte',
];

/** Cabeçalhos que trazem o CPF/CNPJ da contraparte. */
const DOCUMENT_COLUMN_PATTERNS = ['cnpj', 'cpf', 'inscricao', 'inscfederal'];

/**
 * Converte a tabela do extrato (PDF ou .xlsx) em lançamentos prontos para a
 * conciliação. As colunas são achadas pelo cabeçalho e, quando ele não ajuda,
 * pelas posições clássicas (data | valor | histórico).
 *
 * Além do histórico principal, as colunas de **nome** (Razão Social,
 * Favorecido, Cliente…) entram no texto do lançamento — é o que permite achar
 * o contato — e o CPF/CNPJ fica guardado à parte para o casamento por
 * documento.
 */
export function transactionsFromTable(headers, rows, options = {}) {
  const sourceFile = options.sourceFile || '';
  const keys = (headers || []).map((header) => normalizeKey(header));
  const findCol = (patterns, exclude = []) =>
    keys.findIndex(
      (key, index) => !exclude.includes(index) && patterns.some((pattern) => key.includes(pattern))
    );
  const fallbackCol = (exclude) => [0, 1, 2].find((index) => !exclude.includes(index)) ?? 2;

  const dateCol = findCol(['data', 'dt']);
  const dateIndex = dateCol >= 0 ? dateCol : 0;
  const valueIndex = findCol(['valor', 'vlr'], [dateIndex]);
  const valueAt = valueIndex >= 0 ? valueIndex : fallbackCol([dateIndex]);

  // Extratos com débito e crédito em colunas separadas (sem coluna "valor"):
  // o crédito entra como recebimento (+) e o débito como pagamento (-).
  const debitCol = valueIndex < 0 ? findCol(['debito'], [dateIndex]) : -1;
  const creditCol = valueIndex < 0 ? findCol(['credito'], [dateIndex]) : -1;
  const splitColumns = valueIndex < 0 && (debitCol >= 0 || creditCol >= 0);

  const exclude = [dateIndex, valueAt, debitCol, creditCol].filter((index) => index >= 0);
  const historyFound = findCol(['historico', 'descri', 'lancamento'], exclude);
  const historyCol = historyFound >= 0 ? historyFound : fallbackCol(exclude);

  // Colunas extras de texto que identificam a contraparte e a de CPF/CNPJ.
  const used = new Set([...exclude, historyCol].filter((index) => index >= 0));
  const nameCols = keys
    .map((key, index) => ({ key, index }))
    .filter(({ key, index }) => !used.has(index) && key && NAME_COLUMN_PATTERNS.some((pattern) => key.includes(pattern)))
    .map(({ index }) => index);
  const documentCol = keys.findIndex(
    (key, index) => !used.has(index) && !nameCols.includes(index) && DOCUMENT_COLUMN_PATTERNS.some((pattern) => key.includes(pattern))
  );

  const readMoney = (value) => {
    const parsed = typeof value === 'number' ? value : parseMoneyValue(value)?.value;
    return Number.isFinite(parsed) ? Math.abs(parsed) : 0;
  };

  const records = [];
  for (const row of rows || []) {
    const dateIso = parseDateValue(row?.[dateIndex]);
    if (!dateIso) continue;

    let value = row?.[valueAt];
    if (splitColumns) {
      const debit = debitCol >= 0 ? readMoney(row?.[debitCol]) : 0;
      const credit = creditCol >= 0 ? readMoney(row?.[creditCol]) : 0;
      value = credit - debit;
    }

    // Histórico = descrição + nome da contraparte, sem repetir o que já está lá.
    const parts = [];
    const addPart = (raw, { tokensToo = false } = {}) => {
      const text = cleanWhitespace(raw);
      if (!text) return;
      const key = normalizeKey(text);
      if (!key) return;
      const existing = normalizeKey(parts.join(' '));
      if (existing && existing.includes(key)) return;
      const existingReversed = parts.some((part) => normalizeKey(part).includes(key));
      if (existingReversed) return;
      // Nome praticamente igual ao que já foi escrito ("PAGTO PLASTTOTAL
      // PLASTICOS" + "PLASTTOTAL PLASTICOS INDUSTRIAIS LTDA"): não repete.
      if (tokensToo && existing && nameMostlyPresent(text, existing)) return;
      parts.push(text);
    };
    addPart(row?.[historyCol]);
    for (const index of nameCols) addPart(row?.[index], { tokensToo: true });

    records.push({
      dateIso,
      dateBr: formatIsoToBrDate(dateIso),
      value,
      history: parts.join(' — '),
      document: documentCol >= 0 ? cleanWhitespace(row?.[documentCol]) : '',
      sourceFile,
    });
  }

  return buildSourceTransactions(records);
}

/* -------------------------------------------------------------------------- */
/*                                  Casamento                                 */
/* -------------------------------------------------------------------------- */

/**
 * Distância de edição com corte: cobre plural e erro de digitação leve
 * ("plastico"/"plasticos", "industria"/"industriais") sem aproximar palavras
 * diferentes ("plastico" × "plasttotal").
 */
function editDistanceAtMost(a, b, max) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > max) return false;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (current[j] < best) best = current[j];
    }
    if (best > max) return false;
    previous = current;
  }
  return previous[b.length] <= max;
}

/**
 * Reduz plural para comparar "plastico"/"plasticos" e
 * "industrial"/"industriais" sem aproximar palavras diferentes.
 */
function stemToken(token) {
  if (token.length <= 3) return token;
  return token
    .replace(/oes$/, 'ao')
    .replace(/aes$/, 'ao')
    .replace(/ais$/, 'al')
    .replace(/eis$/, 'el')
    .replace(/ois$/, 'ol')
    .replace(/ns$/, 'm')
    .replace(/s$/, '');
}

function tokensTouch(token, historyTokens) {
  if (historyTokens.has(token)) return true;

  // Abreviações ("Ind." → industria, "Imp." → importacao): prefixo exato.
  if (token.length >= 3 && token.length <= 4) {
    for (const other of historyTokens) {
      if (other.length >= 4 && other.startsWith(token)) return true;
    }
    return false;
  }

  const stem = stemToken(token);
  for (const other of historyTokens) {
    if (stemToken(other) === stem) return true;
    // O histórico costuma abreviar em 3–4 letras ("Com.", "Ind.", "Mat.").
    // Prefixos longos como "Eletr" são ambíguos demais e não entram aqui.
    if (other.length >= 3 && other.length <= 4 && token.startsWith(other)) return true;
  }

  // Um único erro de digitação, só em palavras longas: "arcelormital" não
  // pode virar "plastecno" só por ter duas letras em comum.
  if (token.length >= 9) {
    for (const other of historyTokens) {
      if (other.length >= 8 && editDistanceAtMost(token, other, 1)) return true;
    }
  }
  return false;
}

/**
 * Peso de cada token pela raridade no cadastro: "industrial" aparece em muitos
 * contatos e vale pouco; "arcelormittal" aparece em um e vale muito. Serve para
 * não casar um lançamento só porque compartilha uma palavra genérica.
 */
function buildPoolIndex(contacts) {
  const frequency = new Map();
  for (const contact of contacts) {
    for (const token of contact.tokens) {
      frequency.set(token, (frequency.get(token) || 0) + 1);
    }
  }
  const total = Math.max(1, contacts.length);
  const weight = (token) => 1 + Math.log((total + 1) / ((frequency.get(token) || 1) + 0.5));
  return { frequency, weight, total };
}

function weightsFor(contact, learned) {
  const map = learned?.tokenWeights?.[contact.code] || {};
  const weights = new Map();
  for (const token of contact.tokens) {
    const weight = Number(map[token]);
    weights.set(token, Number.isFinite(weight) && weight > 0 ? Math.min(weight, MAX_TOKEN_WEIGHT) : 1);
  }
  return weights;
}

function scoreContact(contact, context) {
  const historyTokens = context.historyTokens;
  const learned = weightsFor(contact, context.learned);

  // CPF/CNPJ igual é identidade: não depende de o banco ter escrito o nome.
  if (documentMatches(contact, context)) return DOCUMENT_MATCH_SCORE;

  // Peso final de cada token: aprendizado × raridade no cadastro.
  const entries = contact.tokens.map((token) => {
    const rarity = context.index ? context.index.weight(token) : 1;
    const learnedWeight = learned.get(token) || 1;
    return { token, weight: rarity * (0.6 + 0.4 * Math.min(learnedWeight, MAX_TOKEN_WEIGHT) / MAX_TOKEN_WEIGHT) };
  });

  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (total === 0) return 0;

  // Nome inteiro (sem espaços) dentro do histórico: casamento forte.
  if (contact.compactNames.some((name) => name.length >= 6 && context.historyCompact.includes(name))) {
    return 0.97;
  }

  // O token mais discriminativo (a "marca" do cadastro) precisa aparecer:
  // evita casar "Usr Rolamentos" com "Nasa Rolamentos" ou "Sindicato dos
  // Metalúrgicos de Três Rios" com "Três Rios Automóveis" por palavra comum.
  const ranked = [...entries].sort((a, b) => b.weight - a.weight);
  const anchorHit = tokensTouch(ranked[0].token, historyTokens);
  if (!anchorHit) return 0;

  const firstTokenHit = contact.tokens.length >= 2 && tokensTouch(contact.tokens[0], historyTokens);
  // Precisa haver ao menos uma palavra "cheia" (6+ letras) do cadastro no
  // histórico: sem ela, siglas e abreviações genéricas ("ind", "mat", "elet")
  // aproximam empresas que não têm nada a ver.
  const strongHit = contact.tokens.some(
    (token) => token.length >= 6 && tokensTouch(token, historyTokens)
  );
  if (!strongHit) return 0;

  let hit = 0;
  for (const entry of entries) {
    if (tokensTouch(entry.token, historyTokens)) hit += entry.weight;
  }

  let score = hit / total;
  if (firstTokenHit) score = Math.min(1, score + 0.06);
  // Cadastro com uma única palavra significativa ("MD DO BRASIL") informa
  // pouco: não pode virar casamento confiante só por uma palavra genérica.
  if (contact.tokens.length === 1) score = Math.min(score, 0.5);
  return score;
}

/** Nome com sufixo societário é empresa; sem sufixo, tratamos como pessoa. */
function isCompanyName(name) {
  return /\b(ltda|ltd|s\.?\s?a|s\/a|eireli|epp|me|mei|cia|companhia)\b/i.test(String(name || ''));
}

/**
 * Apelido aprendido pode vir completo ("plasttotal plastico industrial") ou
 * truncado ("plasttotal 99"): aceita quando um é prefixo do outro.
 */
function findAliasCode(aliases, key) {
  if (!aliases || !key || key.length < 5) return null;
  if (aliases[key]) return aliases[key];

  for (const [alias, code] of Object.entries(aliases)) {
    if (alias.length < 5) continue;
    if (alias.startsWith(`${key} `) || key.startsWith(`${alias} `)) return code;
  }
  return null;
}

function pickBest(transaction, contacts, context) {
  const scored = contacts
    .map((contact) => ({ contact, score: scoreContact(contact, context) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  const aliasCode = findAliasCode(context.learned?.aliases, context.aliasKey);
  if (aliasCode) {
    const fromAlias = scored.find((entry) => entry.contact.code === aliasCode);
    if (fromAlias) {
      return {
        contact: fromAlias.contact,
        score: Math.min(1, fromAlias.score + 0.25),
        status: 'matched',
        learnedAlias: true,
        reason: 'alias',
      };
    }
  }

  if (scored.length === 0) return { contact: null, score: 0, status: 'unmatched', reason: null };

  const [best, second] = scored;
  // Nome com uma ou duas palavras significativas informa pouco: só confirma
  // quando o casamento é praticamente total.
  const required =
    best.contact.tokens.length <= 2 || !isCompanyName(best.contact.name) ? 0.94 : MATCH_THRESHOLD;
  // O cadastro pode repetir a mesma pessoa em dois códigos: empate de nome
  // idêntico (ou de CPF/CNPJ) não é ambiguidade.
  const sameName =
    second && normalizeKey(second.contact.name) === normalizeKey(best.contact.name);
  const bestDocument = contactDocument(best.contact);
  const sameDocument =
    Boolean(bestDocument) && second && contactDocument(second.contact) === bestDocument;
  // De onde veio o vínculo — a tela mostra isso ao usuário.
  const reason = documentMatches(best.contact, context) ? 'document' : 'name';

  if (
    best.score >= required &&
    (sameName || sameDocument || !second || best.score - second.score >= AMBIGUITY_MARGIN)
  ) {
    return { contact: best.contact, score: best.score, status: 'matched', reason };
  }
  if (best.score >= AMBIGUOUS_THRESHOLD) {
    return { contact: best.contact, score: best.score, status: 'ambiguous', reason };
  }
  return { contact: null, score: best.score, status: 'unmatched', reason: null };
}

/**
 * Mostra os melhores candidatos para um histórico (usado nos testes e para
 * explicar na interface por que um contato foi escolhido).
 */
export function scoreCandidates(history, contacts, options = {}) {
  const learned = options.memory?.counterparties || null;
  const pool = options.natureza
    ? (contacts || []).filter((contact) => contact.natureza === options.natureza)
    : contacts || [];
  const context = {
    historyTokens: new Set(significantTokens(history)),
    historyCompact: compactName(history),
    aliasKey: historyCore(history),
    documents: indexHistoryDocuments(history),
    learned,
    index: buildPoolIndex(pool),
  };

  return pool
    .map((contact) => ({ contact, score: Number(scoreContact(contact, context).toFixed(3)) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Number(options.limit) || 5);
}

/**
 * Concilia as transações com o cadastro.
 *
 * @param {object[]} transactions saída de buildSourceTransactions
 * @param {object[]} contacts     saída de buildContactsFromLines/Table
 * @param {{memory?: object}} options memória da IA (aprendizado acumulado)
 * @returns {{rows: object[], stats: object}}
 */
export function reconcileCounterparties(transactions, contacts, options = {}) {
  const learned = options.memory?.counterparties || null;
  const suppliers = (contacts || []).filter((contact) => contact.natureza === NATUREZA.CREDORA);
  const customers = (contacts || []).filter((contact) => contact.natureza === NATUREZA.DEVEDORA);
  const supplierIndex = buildPoolIndex(suppliers);
  const customerIndex = buildPoolIndex(customers);

  const rows = [];

  for (const transaction of transactions || []) {
    const isPayment = transaction.direction === DIRECTION.PAYMENT;
    const pool = isPayment ? suppliers : customers;
    const context = {
      historyTokens: new Set(significantTokens(transaction.history)),
      historyCompact: compactName(transaction.history),
      aliasKey: historyCore(transaction.history),
      documents: indexHistoryDocuments(`${transaction.history} ${transaction.document || ''}`),
      learned,
      index: isPayment ? supplierIndex : customerIndex,
    };

    const best = pool.length > 0 ? pickBest(transaction, pool, context) : { contact: null, status: 'unmatched', score: 0 };
    const contact = best.contact;

    const amountCents = Math.abs(transaction.amountCents);
    // Débito/crédito carregam a conta do contato (coluna `contactb` do Questor,
    // sem pontuação), escolhida pela natureza: pagamento → fornecedor credora
    // (débito); recebimento → cliente devedora (crédito).
    const account = contact ? contactCode(contact.code) : '';
    const row = {
      date: transaction.date,
      dateIso: transaction.dateIso,
      direction: transaction.direction,
      debitCents: isPayment ? amountCents : 0,
      creditCents: isPayment ? 0 : amountCents,
      valueCents: amountCents,
      debitAccount: isPayment ? account : '',
      creditAccount: isPayment ? '' : account,
      counterpartAccount: '',
      history: linkHistory(transaction.history, contact),
      rawHistory: transaction.history,
      /** CPF/CNPJ que veio na coluna do extrato (se houver). */
      document: transaction.document || '',
      sourceFile: transaction.sourceFile,
      contact: contact
        ? {
            code: contact.code,
            name: contact.name,
            natureza: contact.natureza,
            classification: contact.classification,
          }
        : null,
      score: Number(best.score.toFixed(3)),
      status: best.status,
      learnedAlias: !!best.learnedAlias,
      /** `document` (CPF/CNPJ), `alias` (memória) ou `name` (semelhança). */
      matchReason: best.reason || null,
    };

    // Treino de contas: aplica a conta já confirmada; as demais ficam como
    // sugestão clicável na tabela.
    const suggestion = accountSuggestion(row, learned?.accounts);
    if (suggestion) {
      if (suggestion.hits >= ACCOUNT_AUTO_CONFIRM_HITS) {
        if (suggestion.side === 'credit') row.creditAccount = suggestion.account;
        else row.debitAccount = suggestion.account;
        row.counterpartAccount = suggestion.account;
        row.counterpartSource = 'memory';
        row.counterpartHits = suggestion.hits;
      } else {
        row.accountSuggestion = suggestion;
      }
    }

    rows.push(row);
  }

  return { rows, stats: summarizeReconciliation(rows) };
}

/**
 * Junta o nome do contato ao histórico, sem repetir quando o nome já está lá.
 * Sem contato, devolve o histórico original (o usuário decide manualmente).
 */
export function linkHistory(history, contact) {
  const original = cleanWhitespace(history);
  if (!contact) return original;

  const compactHistory = compactName(original);
  const compactNames = contact.compactNames || [compactName(contact.name)];
  if (compactNames.some((name) => name.length >= 6 && compactHistory.includes(name))) {
    return original;
  }

  // O histórico pode trazer o nome com plural/abreviação ("Plasttotal Plástico
  // Industrial"): se a maior parte das palavras do cadastro já está lá, não
  // prefixa para não repetir a informação.
  const tokens = contact.tokens || [];
  if (tokens.length > 0) {
    const historyTokens = significantTokens(original);
    const hits = tokens.filter((token) =>
      historyTokens.some((other) => stemToken(other) === stemToken(token) || historyTokens.includes(token))
    ).length;
    if (hits / tokens.length >= 0.6) return original;
  }

  return `${contact.name} — ${original}`.trim();
}

export function summarizeReconciliation(rows) {
  const stats = {
    total: rows.length,
    matched: 0,
    ambiguous: 0,
    unmatched: 0,
    payments: 0,
    receipts: 0,
    debitCents: 0,
    creditCents: 0,
    suppliers: 0,
    customers: 0,
    /** Vínculos que vieram do CPF/CNPJ do histórico. */
    byDocument: 0,
  };

  for (const row of rows) {
    if (row.status === 'matched' || row.status === 'manual' || row.status === 'learned') {
      stats.matched += 1;
      if (row.matchReason === 'document') stats.byDocument += 1;
    }
    else if (row.status === 'ambiguous') stats.ambiguous += 1;
    else stats.unmatched += 1;

    if (row.direction === DIRECTION.PAYMENT) stats.payments += 1;
    else stats.receipts += 1;

    stats.debitCents += row.debitCents;
    stats.creditCents += row.creditCents;

    if (row.contact?.natureza === NATUREZA.CREDORA) stats.suppliers += 1;
    if (row.contact?.natureza === NATUREZA.DEVEDORA) stats.customers += 1;
  }

  stats.valueCents = stats.debitCents + stats.creditCents;
  return stats;
}

/* -------------------------------------------------------------------------- */
/*                                 Aprendizado                                */
/* -------------------------------------------------------------------------- */

export function emptyCounterparties() {
  return {
    version: 2,
    aliases: {},
    tokenWeights: {},
    contacts: {},
    /**
     * Contas digitadas à mão, memorizadas por origem do histórico e por
     * contato: `{ byHistory: { chave: { debit, credit, hits, updatedAt } },
     * byContact: { contato: { debit, credit, hits, updatedAt } } }`.
     */
    accounts: { byHistory: {}, byContact: {} },
    uses: 0,
    updatedAt: null,
  };
}

/** Normaliza o bloco de contas memorizadas (nunca lança). */
function sanitizeAccounts(raw) {
  const byHistory = {};
  const byContact = {};

  const readBucket = (source, target, keyLimit) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return;
    for (const [key, info] of Object.entries(source)) {
      if (!info || typeof info !== 'object') continue;
      const cleanKey = String(key).trim().slice(0, keyLimit);
      if (!cleanKey) continue;

      const debit = contactCode(info.debit).slice(0, 40);
      const credit = contactCode(info.credit).slice(0, 40);
      if (!debit && !credit) continue;

      target[cleanKey] = {
        debit,
        credit,
        hits: Math.max(0, Math.floor(Number(info.hits) || 0)),
        updatedAt: typeof info.updatedAt === 'string' ? info.updatedAt : null,
      };
    }
  };

  readBucket(raw?.byHistory, byHistory, 80);
  readBucket(raw?.byContact, byContact, 40);
  return { byHistory, byContact };
}

/** Mantém só as entradas mais recentes, para a memória não crescer sem limite. */
function trimAccounts(accounts) {
  for (const bucket of [accounts.byHistory, accounts.byContact]) {
    const keys = Object.keys(bucket);
    if (keys.length <= MAX_ACCOUNT_ENTRIES) continue;

    keys
      .sort((a, b) => String(bucket[a].updatedAt || '').localeCompare(String(bucket[b].updatedAt || '')))
      .slice(MAX_ACCOUNT_ENTRIES)
      .forEach((key) => delete bucket[key]);
  }
}

/** Normaliza o bloco de aprendizado vindo do localStorage ou de um backup. */
export function sanitizeCounterparties(raw) {
  const base = emptyCounterparties();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;

  const aliases = {};
  if (raw.aliases && typeof raw.aliases === 'object') {
    for (const [key, code] of Object.entries(raw.aliases)) {
      const cleanKey = normalizeKey(key).slice(0, 80);
      const cleanCode = String(code ?? '').trim().slice(0, 40);
      if (cleanKey && cleanCode) aliases[cleanKey] = cleanCode;
      if (Object.keys(aliases).length >= MAX_ALIASES) break;
    }
  }

  const tokenWeights = {};
  if (raw.tokenWeights && typeof raw.tokenWeights === 'object') {
    for (const [code, tokens] of Object.entries(raw.tokenWeights)) {
      if (!tokens || typeof tokens !== 'object') continue;
      const entry = {};
      for (const [token, weight] of Object.entries(tokens)) {
        const numeric = Number(weight);
        const cleanToken = normalizeKey(token).slice(0, 40);
        if (!cleanToken || !Number.isFinite(numeric) || numeric <= 0) continue;
        entry[cleanToken] = Math.min(MAX_TOKEN_WEIGHT, Math.max(1, Number(numeric.toFixed(2))));
      }
      if (Object.keys(entry).length > 0) tokenWeights[String(code).slice(0, 40)] = entry;
    }
  }

  const contacts = {};
  if (raw.contacts && typeof raw.contacts === 'object') {
    for (const [code, info] of Object.entries(raw.contacts)) {
      if (!info || typeof info !== 'object') continue;
      const name = cleanName(info.name).slice(0, 120);
      if (!name) continue;
      contacts[String(code).slice(0, 40)] = {
        name,
        natureza: info.natureza === NATUREZA.DEVEDORA ? NATUREZA.DEVEDORA : NATUREZA.CREDORA,
        hits: Math.max(0, Math.floor(Number(info.hits) || 0)),
      };
      if (Object.keys(contacts).length >= MAX_KNOWN_CONTACTS) break;
    }
  }

  return {
    version: 2,
    aliases,
    tokenWeights,
    contacts,
    accounts: sanitizeAccounts(raw.accounts),
    uses: Math.max(0, Math.floor(Number(raw.uses) || 0)),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

/**
 * Reforça o aprendizado com o resultado de uma conciliação: cada vínculo
 * confirmado vira apelido do histórico e aumenta o peso dos tokens do contato.
 */
export function learnFromReconciliation(memory, rows, options = {}) {
  const learned = sanitizeCounterparties(memory?.counterparties);
  const now = options.now || new Date().toISOString();
  let learnedCount = 0;

  for (const row of rows || []) {
    if (!row.contact) continue;
    learnedCount += 1;
    reinforce(learned, row.rawHistory || row.history, row.contact, row.score);
  }

  learned.uses += 1;
  learned.updatedAt = now;

  return {
    counterparties: learned,
    learnedCount,
    log: {
      type: 'counterparties',
      message:
        learnedCount > 0
          ? `Conciliação clientes/fornecedores: ${learnedCount} vínculo(s) memorizado(s).`
          : 'Conciliação clientes/fornecedores executada sem novos vínculos.',
      details: `${Object.keys(learned.aliases).length} apelido(s) • ${learned.uses} uso(s)`,
    },
  };
}

function reinforce(learned, history, contact, score) {
  const aliasKey = historyCore(history);
  if (aliasKey && aliasKey.length >= 4) {
    learned.aliases[aliasKey] = contact.code;
    // Limite simples de tamanho: descarta os mais antigos quando estoura.
    const keys = Object.keys(learned.aliases);
    if (keys.length > MAX_ALIASES) delete learned.aliases[keys[0]];
  }

  const weights = learned.tokenWeights[contact.code] || {};
  for (const token of significantTokens(contact.name)) {
    const current = Number(weights[token]) || 1;
    weights[token] = Math.min(MAX_TOKEN_WEIGHT, Number((current + 0.2).toFixed(2)));
  }
  learned.tokenWeights[contact.code] = weights;

  const info = learned.contacts[contact.code] || { name: contact.name, natureza: contact.natureza, hits: 0 };
  learned.contacts[contact.code] = {
    name: contact.name,
    natureza: contact.natureza,
    hits: info.hits + 1,
  };

  if (score >= 0.95) {
    // Casamento por nome completo não precisa de reforço extra.
    return;
  }
}

/**
 * Registra uma correção manual: o histórico passa a apontar para o contato
 * escolhido pelo usuário, com peso máximo nos tokens.
 */
export function learnManualLink(memory, { history, contact }, options = {}) {
  const learned = sanitizeCounterparties(memory?.counterparties);
  if (!contact?.code || !history) return learned;

  const aliasKey = historyCore(history);
  if (aliasKey) learned.aliases[aliasKey] = contact.code;

  const weights = learned.tokenWeights[contact.code] || {};
  for (const token of significantTokens(contact.name)) {
    weights[token] = MAX_TOKEN_WEIGHT;
  }
  learned.tokenWeights[contact.code] = weights;

  learned.contacts[contact.code] = {
    name: contact.name,
    natureza: contact.natureza,
    hits: (learned.contacts[contact.code]?.hits || 0) + 1,
  };
  learned.updatedAt = options.now || new Date().toISOString();

  return learned;
}

/* -------------------------------------------------------------------------- */
/*                        Contas memorizadas (treino)                         */
/* -------------------------------------------------------------------------- */

/**
 * Memoriza a conta que o usuário digitou para um histórico/contato.
 *
 * Guarda nas duas chaves possíveis — o histórico normalizado (vale para
 * lançamentos iguais futuros) e o contato (vale para qualquer histórico
 * daquele cliente/fornecedor). Repetir a **mesma** conta soma confiança; digitar
 * outra conta reinicia a contagem daquele lado.
 *
 * @returns {object} o bloco `counterparties` já normalizado
 */
export function learnRowAccount(memory, { history, contact, side, account }, options = {}) {
  const learned = sanitizeCounterparties(memory?.counterparties);
  const cell = side === 'credit' ? 'credit' : 'debit';
  const code = contactCode(account);
  if (!code) return learned;

  const now = options.now || new Date().toISOString();
  const historyKey = historyCore(history);
  const contactKey = contactCode(contact?.code);

  const targets = [];
  if (historyKey && historyKey.length >= 4) targets.push([learned.accounts.byHistory, historyKey]);
  if (contactKey) targets.push([learned.accounts.byContact, contactKey]);

  for (const [bucket, key] of targets) {
    const current = bucket[key] || { debit: '', credit: '', hits: 0, updatedAt: null };
    const repeated = current[cell] === code;
    bucket[key] = {
      debit: current.debit || '',
      credit: current.credit || '',
      [cell]: code,
      hits: repeated ? (Number(current.hits) || 0) + 1 : 1,
      updatedAt: now,
    };
  }

  trimAccounts(learned.accounts);
  learned.updatedAt = now;
  return learned;
}

/** Quantas contas a memória já guardou (para exibir no painel). */
export function accountMemorySummary(memory) {
  const learned = sanitizeCounterparties(memory?.counterparties);
  const byHistory = Object.keys(learned.accounts.byHistory).length;
  const byContact = Object.keys(learned.accounts.byContact).length;
  return { byHistory, byContact, total: byHistory + byContact };
}

/**
 * Conta que a memória sugere para completar um lançamento.
 *
 * - Com contato: só a **coluna oposta** (a contrapartida), nunca a conta do
 *   próprio contato.
 * - Sem contato: primeiro a coluna da direção (a conta do cliente/fornecedor),
 *   depois a oposta.
 *
 * @returns {{side: 'debit'|'credit', account: string, hits: number, source: string}|null}
 */
export function accountSuggestion(row, accounts) {
  if (!row || !accounts) return null;

  const contactSide = contactAccountSide(row);
  const oppositeSide = contactSide === 'debit' ? 'credit' : 'debit';
  const sides = row.contact ? [oppositeSide] : [contactSide, oppositeSide];

  const historyKey = historyCore(row.rawHistory || row.history || '');
  const byHistory = historyKey ? accounts.byHistory?.[historyKey] : null;
  const byContact = row.contact ? accounts.byContact?.[contactCode(row.contact.code)] : null;

  for (const source of [
    { name: 'histórico', entry: byHistory },
    { name: 'contato', entry: byContact },
  ]) {
    if (!source.entry) continue;
    for (const side of sides) {
      const filled = side === 'credit' ? row.creditAccount : row.debitAccount;
      const account = contactCode(source.entry[side]);
      if (filled || !account) continue;
      return { side, account, hits: Number(source.entry.hits) || 0, source: source.name };
    }
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/*                           Helpers para a interface                         */
/* -------------------------------------------------------------------------- */

/** Contatos que podem substituir o vínculo de uma linha (mesma natureza). */
export function candidatesFor(contacts, direction) {
  const natureza = direction === DIRECTION.PAYMENT ? NATUREZA.CREDORA : NATUREZA.DEVEDORA;
  return (contacts || []).filter((contact) => contact.natureza === natureza);
}

export function contactSummary(contacts) {
  const suppliers = (contacts || []).filter((contact) => contact.natureza === NATUREZA.CREDORA).length;
  const customers = (contacts || []).filter((contact) => contact.natureza === NATUREZA.DEVEDORA).length;
  return { suppliers, customers, total: suppliers + customers };
}
