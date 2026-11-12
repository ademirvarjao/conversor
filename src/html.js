/**
 * Conversor — Escape de HTML (fonte única)
 *
 * Todo o app monta HTML em pedaços (`innerHTML` com template literal) porque é
 * estático e sem framework. Isso é rápido, mas exige uma regra só: **nenhum
 * texto que venha de arquivo, de memória ou do usuário entra na string sem
 * escape**. Antes cada módulo tinha a sua própria cópia da função (e um deles
 * não escapava nada); agora todos importam daqui, então um ajuste vale para a
 * tela de importação, o conciliador e o treinador ao mesmo tempo.
 *
 * Uso:
 *   import { escapeHtml } from './html.js';
 *   `<span title="${escapeHtml(nome)}">${escapeHtml(nome)}</span>`
 *
 * Regras:
 *  - o `&` é escapado primeiro (senão os escapes criados depois viravam `&amp;lt;`);
 *  - aspas duplas e simples são escapadas porque o texto entra em atributos;
 *  - `null`, `undefined` e objetos sem sentido viram string vazia/representação
 *    segura, nunca "null" na tela.
 */

const ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Troca os cinco caracteres perigosos pelas entidades HTML correspondentes.
 * @param {unknown} value qualquer valor (número, data, nulo…)
 * @returns {string} texto seguro para interpolar em HTML ou atributo
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/** Alias curto usado nos módulos que montam muito HTML. */
export const esc = escapeHtml;
