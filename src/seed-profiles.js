/**
 * Conversor — Layouts de extrato que já vêm treinados ("de fábrica")
 *
 * Estes perfis são o resultado do treinamento feito com extratos reais: cada
 * linha registra o cabeçalho exato do arquivo e o papel de cada coluna. Eles
 * entram na memória da IA de qualquer usuário (novo navegador, memória zerada
 * ou backup restaurado) e fazem o app reconhecer o layout na primeira
 * importação, sem precisar treinar de novo.
 *
 * Regras de ouro usadas aqui:
 *  - `value_in`  = coluna de CRÉDITO  (entrada, soma +)
 *  - `value_out` = coluna de DÉBITO   (saída, soma -)
 *  - `value_auto` = coluna única de valor cujo sinal vem do próprio número
 *  - saldo/total  = `ignore` (não é lançamento)
 *  - nº de documento (Dcto., autenticação, lote) = `ignore`
 *  - descrição/razão social/CNPJ = `history`, na ordem em que aparecem
 *
 * Os testes `test/seed-profiles.test.mjs` conferem que estes perfis batem com
 * o que o parser realmente extrai dos exemplos de extrato.
 */

export const SEED_PROFILES = [
  {
    id: 'seed-extrato-itau',
    name: 'Extrato Itaú — conta PJ (Data / Lançamentos / Razão Social / CNPJ)',
    fileType: 'pdf',
    // Cabeçalho extraído do extrato: "Data | Lançamentos | Razão Social |
    // CNPJ/CPF | Valor (R$) | Saldo (R$)".
    headers: ['Data', 'Lançamentos', 'Razão Social', 'CNPJ/CPF', 'Valor (R$)', 'Saldo (R$)'],
    mappings: [
      { header: 'Data', role: 'date', historyOrder: 0 },
      { header: 'Lançamentos', role: 'history', historyOrder: 1 },
      { header: 'Razão Social', role: 'history', historyOrder: 2 },
      { header: 'CNPJ/CPF', role: 'history', historyOrder: 3 },
      { header: 'Valor (R$)', role: 'value_auto', historyOrder: 0 },
      { header: 'Saldo (R$)', role: 'ignore', historyOrder: 0 },
    ],
    rules: { defaultSign: 'auto', removePipes: true, collapseSpaces: true },
    builtIn: true,
  },
  {
    id: 'seed-extrato-bradesco',
    name: 'Extrato Bradesco — extrato mensal (Crédito / Débito / Saldo)',
    fileType: 'pdf',
    // Cabeçalho: "Data | Lançamento | Dcto. | Crédito (R$) | Débito (R$) | Saldo (R$)".
    headers: ['Data', 'Lançamento', 'Dcto.', 'Crédito (R$)', 'Débito (R$)', 'Saldo (R$)'],
    mappings: [
      { header: 'Data', role: 'date', historyOrder: 0 },
      { header: 'Lançamento', role: 'history', historyOrder: 1 },
      { header: 'Dcto.', role: 'ignore', historyOrder: 0 },
      { header: 'Crédito (R$)', role: 'value_in', historyOrder: 0 },
      { header: 'Débito (R$)', role: 'value_out', historyOrder: 0 },
      { header: 'Saldo (R$)', role: 'ignore', historyOrder: 0 },
    ],
    rules: { defaultSign: 'auto', removePipes: true, collapseSpaces: true },
    builtIn: true,
  },
];

export const SEED_PROFILE_IDS = SEED_PROFILES.map((profile) => profile.id);
