/**
 * Conversor Custódio — Utilidades de formatação e aritmética monetária.
 *
 * Todos os valores financeiros circulam em "centavos inteiros" para evitar
 * erros de ponto flutuante (0.1 + 0.2 !== 0.3), que são inaceitáveis em
 * conciliação contábil.
 */

const BR_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Converte um valor monetário em centavos inteiros arredondando "metade para
 * longe do zero" (a regra esperada em relatórios financeiros: -1,005 → -1,01).
 */
export function toCents(value) {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return 0;
  const scaled = num * 100;
  const rounded = Math.round(Math.abs(scaled) + 1e-9) * Math.sign(scaled);
  return rounded === 0 ? 0 : rounded;
}

/** Converte centavos inteiros de volta para um número com 2 casas decimais. */
export function fromCents(cents) {
  return Math.round(cents) / 100;
}

/** Arredonda para 2 casas decimais tratando corretamente valores negativos. */
export function round2(value) {
  return fromCents(toCents(value));
}

/** Soma uma lista de valores monetários sem acumular erro de ponto flutuante. */
export function sumValues(values) {
  let cents = 0;
  for (const value of values) cents += toCents(value);
  return fromCents(cents);
}

/**
 * Formato exigido pela exportação: sem símbolo de moeda e sem separador de
 * milhar. Ex.: 1234.5 -> "1234,50" | -42 -> "-42,00" | 0 -> "0,00".
 */
export function formatValuePlainBr(value) {
  const cents = toCents(value);
  const abs = Math.abs(cents);
  const integer = Math.floor(abs / 100);
  const decimals = String(abs % 100).padStart(2, '0');
  return `${cents < 0 ? '-' : ''}${integer},${decimals}`;
}

/** Formato de exibição com símbolo de moeda e separador de milhar. */
export function formatValueCurrencyBr(value) {
  const cents = toCents(value);
  const abs = Math.abs(cents);
  const integer = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const decimals = String(abs % 100).padStart(2, '0');
  const body = `R$ ${integer},${decimals}`;
  return cents < 0 ? `-${body}` : body;
}

/** Converte 'YYYY-MM-DD' em 'DD/MM/AAAA'. Retorna '' quando inválido. */
export function formatIsoToBrDate(iso) {
  if (typeof iso !== 'string') return '';
  const match = BR_DATE_RE.exec(iso);
  if (!match) return '';
  return `${match[3]}/${match[2]}/${match[1]}`;
}

/** Converte 'YYYY-MM-DD' em Date UTC (meia-noite), evitando deslocamento de fuso. */
export function isoToUtcDate(iso) {
  const match = BR_DATE_RE.exec(String(iso ?? ''));
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

/** Formata uma data local (não UTC) como 'dd/mm/aaaa hh:mm'. */
export function formatLocalDateTime(dateInput) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return date.toISOString();
  }
}
