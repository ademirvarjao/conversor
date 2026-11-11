/**
 * Fixtures dos dois layouts treinados — geometria real, valores fictícios.
 *
 * Cada linha abaixo imita o que o PDF.js entrega (texto + x + largura) para os
 * extratos usados no treinamento. Nenhum dado de cliente real entra aqui: os
 * valores e as descrições são inventados, mas as POSIÇÕES são as do arquivo
 * original, que é o que o parser precisa entender.
 */

const line = (page, y, items) => ({
  page,
  y,
  h: 9,
  items: items.map(([str, x, w = 40]) => ({ str, x, y, w, h: 9 })),
});

/* -------------------------------------------------------------------------- */
/*  Bradesco — extrato mensal: Data | Lançamento | Dcto. | Crédito | Débito   */
/*  | Saldo. Data só na primeira linha do dia; descrição quebrada em 2 linhas  */
/*  (uma acima e outra abaixo dos valores); valores alinhados à direita.       */
/* -------------------------------------------------------------------------- */
const bradesco = [
  line(1, 746.2, [
    ['Data', 44, 22],
    ['Lançamento', 104, 50],
    ['Dcto.', 270, 26],
    ['Crédito (R$)', 340, 55],
    ['Débito (R$)', 431, 45],
    ['Saldo (R$)', 523, 45],
  ]),
  line(1, 728.1, [
    ['30/09/2026', 41, 42],
    ['SALDO ANTERIOR', 101, 60],
    ['1.500,00', 536.5, 29.6],
  ]),
  // Primeiro lançamento do dia: descrição em cima e embaixo.
  line(1, 717.7, [['RECEBIMENTO FORNECEDOR', 101, 100]]),
  line(1, 713.3, [
    ['05/10/2026', 41, 42],
    ['102805', 267.4, 25.4],
    ['120,00', 370.5, 19],
    ['1.620,00', 536.5, 29.6],
  ]),
  line(1, 708.9, [['ALELO INSTITUICAO DE PAGAMENTO S', 101, 150]]),
  // Mesmo dia, SEM data (herda 05/10/2026).
  line(1, 698.6, [['RECEBIMENTO FORNECEDOR', 101, 100]]),
  line(1, 694.2, [
    ['7727668', 267.4, 25.4],
    ['30,00', 366.3, 23.3],
    ['1.650,00', 536.5, 29.6],
  ]),
  line(1, 689.7, [['TICKET SERVICOS S A', 101, 90]]),
  // Débito: número negativo largo, alinhado à direita na coluna de débito.
  line(1, 679.4, [['TARIFA BANCARIA', 101, 80]]),
  line(1, 675, [
    ['08/10/2026', 41, 42],
    ['61026', 267.4, 25.4],
    ['-45,90', 445.7, 32.1],
    ['1.604,10', 536.5, 29.6],
  ]),
  // Rodapé de total: não é lançamento.
  line(1, 47.6, [['Total', 41, 24], ['150,00', 366.3, 23.3], ['-45,90', 452, 25.8], ['1.604,10', 536.5, 29.6]]),
  // ---- página 2: virada de página sem cabeçalho e com lançamento sem data --
  line(2, 850, [['Folha 2/2', 547, 30]]),
  line(2, 825.5, [['RECEBIMENTO FORNECEDOR', 101, 100]]),
  line(2, 821.1, [
    ['8554385', 267.4, 25.4],
    ['22,08', 370.5, 19],
    ['1.626,18', 536.5, 29.6],
  ]),
  line(2, 816.6, [['TICKET SERVICOS S A', 101, 90]]),
  line(2, 806.3, [['RECEBIMENTO FORNECEDOR', 101, 100]]),
  line(2, 801.9, [
    ['09/10/2026', 41, 42],
    ['8698071', 267.4, 25.4],
    ['335,56', 366.3, 23.3],
    ['1.961,74', 536.5, 29.6],
  ]),
];

/* -------------------------------------------------------------------------- */
/*  Itaú — conta PJ: Data | Lançamentos | Razão Social | CNPJ/CPF | Valor |   */
/*  Saldo, com cada lançamento em bloco de 3 linhas e a data no MEIO.         */
/* -------------------------------------------------------------------------- */
const itau = [
  line(1, 712.1, [
    ['Saldo total', 35, 60],
    ['Limite da conta', 167, 70],
  ]),
  line(1, 691.8, [
    ['R$ 2.520,90', 35, 60],
    ['R$ 0,00', 167, 40],
  ]),
  line(1, 654.5, [
    ['Lançamentos do período:', 34, 120],
    ['01/10/2026 até 31/10/2026', 131, 120],
  ]),
  line(1, 628.1, [
    ['Data', 35, 22],
    ['Lançamentos', 90, 52],
    ['Razão Social', 226, 60],
    ['CNPJ/CPF', 363, 48],
    ['Valor (R$)', 470, 40],
    ['Saldo (R$)', 521, 42],
  ]),
  line(1, 615.3, [
    ['30/09/2026', 35, 42],
    ['SALDO ANTERIOR', 90, 62],
    ['244.600,52', 518, 41],
  ]),
  // Bloco 1 — crédito
  line(1, 602.5, [
    ['01/10/2026', 35, 42],
    ['PIX RECEBIDO ALELO 01/10', 90, 100],
    ['ALELO SA', 226, 40],
    ['04.740.876/0001-25', 363, 76],
    ['216,64', 483, 24],
  ]),
  line(1, 589.7, [
    ['RECEBIMENTO REDE ELO', 90, 84],
    ['REDECARD INSTITUICAO DE', 226, 92],
  ]),
  // Bloco 2 — crédito com data na linha do meio
  line(1, 584.4, [
    ['01/10/2026', 35, 42],
    ['01.425.787/0001-04', 363, 76],
    ['90,21', 487, 20],
  ]),
  line(1, 579.1, [
    ['DB0094977224', 90, 52],
    ['PAGAMENTO S.A.', 226, 50],
  ]),
  // Bloco 3 — débito (valor negativo)
  line(1, 566.3, [
    ['PAGAMENTO FORNECEDOR', 90, 88],
    ['FORNECEDOR EXEMPLO LTDA', 226, 92],
  ]),
  line(1, 561, [
    ['02/10/2026', 35, 42],
    ['12.345.678/0001-99', 363, 76],
    ['-1371,46', 470, 32],
  ]),
  line(1, 555.7, [
    ['SISPAG FORNECEDORES', 90, 52],
  ]),
  // Rodapé do extrato: hyperlink + aviso legal. Não são lançamento.
  line(1, 40, [['novos lançamentos', 35, 90]]),
  line(1, 25, [
    [
      'atualizado em 06/11/2026 16:05:21 Em caso de dúvidas, de posse do comprovante, contate seu gerente ou a Central no 40901685 ou 0800 7701685. SAC 0800 728',
      35,
      500,
    ],
  ]),
];

export const SEED_LOG_LAYOUTS = { bradesco, itau };
