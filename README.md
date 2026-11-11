# Conversor

[![Testes](https://github.com/ademirvarjao/conversor-custodio/actions/workflows/tests.yml/badge.svg)](https://github.com/ademirvarjao/conversor-custodio/actions/workflows/tests.yml)
[![Deploy](https://github.com/ademirvarjao/conversor-custodio/actions/workflows/deploy.yml/badge.svg)](https://github.com/ademirvarjao/conversor-custodio/actions/workflows/deploy.yml)

**▶ Abrir o app: <https://ademirvarjao.github.io/conversor-custodio/>**

Aplicação web **100% client-side** (pronta para GitHub Pages) para importar, padronizar, unificar cronologicamente e exportar relatórios financeiros de pagamentos e recebimentos nos formatos **`.xlsx`** e **`.pdf`**.

O diferencial é o motor de **IA Adaptativa de Layouts**: ele infere o papel de cada coluna por semântica + estatística, aprende com as correções do usuário e reconhece variações de layout em arquivos futuros.

> **Privacidade:** nenhum arquivo sai do navegador. Toda a leitura, o aprendizado e a exportação acontecem localmente. O conector LLM (opcional) é a única exceção — e só é usado se você configurar sua própria chave.

---

## Recursos

### Importação (`.pdf` e `.xlsx`)
- **PDF (PDF.js)**: extração geométrica adaptativa — descobre colunas pelo alinhamento das coordenadas X, combina cabeçalhos em múltiplas linhas, recompõe descrições quebradas em duas linhas e descarta banners, CNPJ, totais e cabeçalhos repetidos de página.
- **XLSX (ExcelJS)**: múltiplas abas (com seletor manual), datas nativas ali preservadas, fórmulas resolvidas, células mescladas sem duplicação, banners e linhas de resumo removidos automaticamente.
- **Extratos paginados**: o cabeçalho/rodapé repetido em cada página é descartado (inclusive a linha `Conta Corrente :`), sem contaminar a última linha da página anterior — validado em extrato real de 6 páginas com reconciliação total contra o saldo (293 lançamentos, diferença zero).
- Vários arquivos ao mesmo tempo (ex.: Pagamentos + Recebimentos), com detecção de duplicados, limite de tamanho e progresso de leitura por página.

### Padronização em 3 colunas
| Coluna | Formato |
| --- | --- |
| `data` | `dd/mm/aaaa`, ordenada de forma crescente |
| `valor` | numérico, sem `R$` e sem separador de milhar — `0000,00` (positivo) / `-0000,00` (negativo) |
| `historico` | texto (`@`), concatenando as colunas descritivas na ordem escolhida, com limpeza de pipes e espaços |

### Exportação
- **`.xlsx`**: aba única `Conciliacao`, cabeçalho congelado, filtro automático, data tipada (`dd/mm/yyyy`), valor numérico (`#,##0.00`) e histórico como texto — pronto para Excel/importação contábil. Valida o limite de linhas do Excel.
- **`.pdf`**: relatório A4 paisagem paginado, com cabeçalho institucional em todas as páginas, totalizadores, linhas negativas destacadas e rodapé com data/hora e numeração.
- Opção de **exportar apenas o resultado filtrado** (busca + filtro de sinal).

### IA Adaptativa de Layouts
- **Inferência semântica multi-sinal**: pesos léxicos PT-BR + análise estatística dos dados (datas reais, valores, colunas separadas de Entrada/Crédito e Saída/Débito, indicadores `D/C`, colunas esparsas) e exclusão automática de colunas de `Saldo`/`Total`/vazias.
- **Entradas e saídas em colunas separadas**: reconhece layouts em que o valor de cada linha aparece em **uma de duas colunas** (`Pagto.`/`Recbto.`, `Débito`/`Crédito`, `Saídas`/`Entradas`) — inclusive abreviações. O par é identificado pela exclusividade mútua dos dados e o sentido de cada coluna é confirmado pela **variação do saldo** linha a linha; na falta do saldo, vale o cabeçalho e, por último, a posição. O resultado é um único lançamento assinado por linha, em vez de duas colunas somadas.
- **Colunas de identificação não viram valor**: `Lancto`, `Documento`, `Nº`, `Código` e sequências numéricas (inteiros, únicos e crescentes) são ignorados automaticamente — antes o número do lançamento entraria na soma.
- **Detecção de evolução de layout**: aponta exatamente o que mudou (`NOVA`, `RENOMEADA`, `AUSENTE`) e aplica o melhor mapeamento.
- **Aprendizado supervisionado**: ao confirmar/corrigir o mapeamento, o motor reforça ou penaliza os pesos dos tokens (com limites para evitar "explosão" de pesos), atualiza o perfil do layout e registra o evento.
- **Memória persistente** em `localStorage`, com exportação/importação de `custodio-ia-memoria.json` para versionar no repositório ou compartilhar entre máquinas. Backups inválidos são normalizados/descartados sem quebrar a aplicação.
- **Conector LLM opcional** (OpenAI ou Gemini, com chave do próprio usuário) para layouts inéditos, com timeout, validação da resposta e fallback para a IA local.

---

## Como executar localmente

Requisitos: **Node.js ≥ 20** (nenhuma dependência para instalar) ou qualquer servidor estático.

```bash
npm run dev          # http://localhost:3000
PORT=8080 npm run dev
```

> ES Modules e Web Workers do PDF.js não funcionam abrindo o arquivo via `file://` — use sempre um servidor HTTP.

### Testes

```bash
npm test             # suíte completa (node:test), sem dependências externas
npm run test:watch   # modo observador durante o desenvolvimento
```

A suíte cobre aritmética monetária em centavos, parsers de data/valor, leitura real de `.xlsx` gerados em memória, geometria de reconstrução de tabelas de PDF (com coordenadas sintéticas), motor de IA (classificação, treino, memória, importação de backups) e exportação (ida e volta `.xlsx` + geração de `.pdf` com jsPDF real).

---

## Publicar no GitHub Pages

1. Envie o repositório para o GitHub:
   ```bash
   git init
   git add .
   git commit -m "feat: Conversor"
   git branch -M main
   git remote add origin https://github.com/SEU-USUARIO/conversor-custodio.git
   git push -u origin main
   ```
2. **Habilite o GitHub Pages** em **Settings → Pages → Build and deployment → Source** e escolha **GitHub Actions**.
   > Esse passo é obrigatório e só pode ser feito por quem administra o repositório. Sem ele, o workflow de deploy não encontra o site do Pages e para (o log mostra exatamente esse aviso).
   > Alternativa automatizada: crie um secret `PAGES_TOKEN` com um PAT que tenha permissão de Pages — o workflow então habilita o site sozinho.
3. Em ~30 segundos o app estará em `https://SEU-USUARIO.github.io/conversor-custodio/`.

O workflow `.github/workflows/tests.yml` roda a suíte automaticamente em push e pull request.

---

## Estrutura

```text
conversor-custodio/
├── index.html                    # Interface (HTML semântico + ARIA)
├── package.json                  # Scripts de dev/teste (sem dependências)
├── scripts/serve.mjs             # Servidor estático de desenvolvimento
├── src/
│   ├── app.js                    # Controlador de UI, upload, filtros, modal
│   ├── parsers.js                # PDF (extração + geometria) e XLSX
│   ├── ai-engine.js              # Classificação, treino e memória da IA
│   ├── exporters.js              # Exportação .xlsx e .pdf
│   ├── format.js                 # Formatação e aritmética em centavos
│   ├── summary.js                # Totalizadores (KPIs)
│   ├── ui-contract.js            # IDs exigidos pelo controlador + versão
│   └── styles.css                # Estilos responsivos + acessibilidade
├── test/                         # Suíte node:test
├── vendor/                       # PDF.js, ExcelJS, jsPDF (offline, sem CDN)
└── .github/workflows/            # deploy (Pages) + testes
```

---

## Boas práticas aplicadas

- **Dinheiro nunca em `float` solto**: somas e comparações passam por centavos inteiros (`format.js`), com arredondamento "metade para longe do zero".
- **Parsers puros e testáveis**: a geometria do PDF é uma função pura (`buildTableFromTextLines`) independente do PDF.js; o leitor de planilhas aceita um workbook já carregado.
- **Falhas isoladas por arquivo**: um PDF escaneado ou uma planilha corrompida não derrubam o lote; cada erro vira uma notificação objetiva.
- **Acessibilidade**: navegação por teclado, foco visível, `aria-live` para resultados, modal com foco controlado/`Esc`, tabelas com `scope` e legendas, respeito a `prefers-reduced-motion`.
- **Segurança**: todo conteúdo de arquivo é escapado antes de ir para o DOM (`escapeHtml`), chaves de API ficam apenas no `localStorage` do usuário e a importação de memória é validada.
- **Sem build, sem CDN**: bibliotecas vendorizadas, módulos ES nativos — o deploy é um `git push`.

## Solução de problemas

| Sintoma | Causa | Como resolver |
| --- | --- | --- |
| O workflow de deploy falha em **“Configurar GitHub Pages”** com `Get Pages site failed ... Not Found` | O site do Pages nunca foi habilitado no repositório | **Settings → Pages → Source: GitHub Actions** e rode o workflow novamente |
| A página do Pages abre sem estilo / sem funcionar | O deploy publicou apenas parte dos arquivos | Rode o workflow novamente; ele publica `index.html`, `src/` e `vendor/` (incluindo `src/parsers.js`) |
| “Nenhum texto extraível encontrado” ao importar PDF | PDF escaneado (sem camada de texto) | Use um PDF exportado do sistema de origem ou aplique OCR antes |
| Valores de entrada e saída aparecem com o mesmo sinal | As duas colunas foram marcadas com a mesma função | Marque uma como *Valor Recebido / Crédito (+)* e a outra como *Valor Pago / Débito (-)* no Passo 2 |
| Planilha importa muitas linhas ignoradas | Linhas sem data ou sem valor na coluna mapeada | Ajuste o mapeamento no **Passo 2** — a IA aprende com a correção |

## Limitações conhecidas

- PDFs **escaneados (imagem)** não possuem camada de texto e precisam de OCR — a aplicação informa isso com uma mensagem clara.
- Planilhas com layout realmente atípico podem exigir ajuste manual no **Passo 2** (é justamente esse ajuste que alimenta o aprendizado).
- A memória da IA é **por navegador**: use exportar/importar JSON para compartilhar entre máquinas.
- O conector LLM depende de CORS e da cota da sua conta no provedor; sem ele, tudo continua funcionando offline.

## Licença

MIT — veja [`LICENSE`](./LICENSE).
