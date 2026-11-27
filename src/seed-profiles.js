/**
 * Conversor — Layouts que já vêm treinados ("de fábrica")
 *
 * Estes perfis são o resultado do treinamento feito com arquivos reais: cada
 * linha registra o cabeçalho exato do layout e o papel de cada coluna. Eles
 * entram na memória da IA de qualquer usuário (novo navegador, memória zerada
 * ou backup restaurado) e fazem o app reconhecer o layout na primeira
 * importação, sem precisar treinar de novo. Nenhum dado de cliente fica aqui.
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
    id: 'seed-extrato-itau-mensal',
    name: 'Extrato Itaú — mensal (Data / Descrição / Entradas / Saídas / Saldo)',
    fileType: 'pdf',
    // Layout do extrato mensal Itaú: a tabela principal separa créditos e
    // débitos em colunas distintas. Saldo anterior e checkpoints de aplicação
    // não são movimentações; entradas/saídas determinam o sinal.
    headers: ['Data', 'Descrição', 'Entradas R$ (créditos)', 'Saídas R$ (débitos)', 'Saldo R$'],
    mappings: [
      { header: 'Data', role: 'date', historyOrder: 0 },
      { header: 'Descrição', role: 'history', historyOrder: 1 },
      { header: 'Entradas R$ (créditos)', role: 'value_in', historyOrder: 0 },
      { header: 'Saídas R$ (débitos)', role: 'value_out', historyOrder: 0 },
      { header: 'Saldo R$', role: 'ignore', historyOrder: 0 },
    ],
    rules: { defaultSign: 'auto', removePipes: true, collapseSpaces: true },
    builtIn: true,
  },
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
  {
    id: 'seed-contas-pagar-apropriacao',
    name: 'Conciliação de pagamentos Itaú — Contas a Pagar por Local com Apropriação (90ti)',
    fileType: 'pdf',
    // O leitor dedicado em `parsers.js` reconstrói este cabeçalho a partir das
    // 3 linhas do PDF, junta as linhas de rateio e remove o título repetido na
    // virada de página. A data/valor do fato são PAGAMENTO/PAGO; EMISSÃO e
    // ORIGINAL são só previsto e ficam fora da soma.
    headers: [
      'FORNECEDOR',
      'TÍTULO',
      'DATA EMISSÃO',
      'DATA PAGAMENTO',
      'VALOR ORIGINAL',
      'VALOR PAGO',
      'TIPO',
      'APROPRIAÇÃO',
    ],
    mappings: [
      { header: 'FORNECEDOR', role: 'history', historyOrder: 1 },
      { header: 'TÍTULO', role: 'history', historyOrder: 2 },
      { header: 'DATA EMISSÃO', role: 'ignore', historyOrder: 0 },
      { header: 'DATA PAGAMENTO', role: 'date', historyOrder: 0 },
      { header: 'VALOR ORIGINAL', role: 'ignore', historyOrder: 0 },
      { header: 'VALOR PAGO', role: 'value_out', historyOrder: 0 },
      { header: 'TIPO', role: 'history', historyOrder: 3 },
      { header: 'APROPRIAÇÃO', role: 'history', historyOrder: 4 },
    ],
    rules: { defaultSign: 'negative', removePipes: true, collapseSpaces: true },
    builtIn: true,
  },
  {
    id: 'seed-recebimentos-conta-bancaria',
    name: 'Conciliação de recebimentos Itaú — Recebimentos por Conta Bancária (90ti)',
    fileType: 'pdf',
    // O leitor dedicado em `parsers.js` separa o código da conta ("01/01/0445")
    // e descarta o subtotal puramente numérico e o TOTAL geral. O fato é
    // Data Recebimento / Vr. Recebido (entrada positiva); amortizado,
    // acréscimo e dedução ficam fora da soma.
    headers: [
      'Cliente',
      'No.Título',
      'Local',
      'Data Recebimento',
      'Forma Pagto.',
      'Vr. Amortizado',
      'Vr. Acréscimo',
      'Vr. Dedução',
      'Vr. Recebido',
    ],
    mappings: [
      { header: 'Cliente', role: 'history', historyOrder: 1 },
      { header: 'No.Título', role: 'history', historyOrder: 2 },
      { header: 'Local', role: 'history', historyOrder: 3 },
      { header: 'Data Recebimento', role: 'date', historyOrder: 0 },
      { header: 'Forma Pagto.', role: 'history', historyOrder: 4 },
      { header: 'Vr. Amortizado', role: 'ignore', historyOrder: 0 },
      { header: 'Vr. Acréscimo', role: 'ignore', historyOrder: 0 },
      { header: 'Vr. Dedução', role: 'ignore', historyOrder: 0 },
      { header: 'Vr. Recebido', role: 'value_in', historyOrder: 0 },
    ],
    rules: { defaultSign: 'positive', removePipes: true, collapseSpaces: true },
    builtIn: true,
  },
];

export const SEED_PROFILE_IDS = SEED_PROFILES.map((profile) => profile.id);
