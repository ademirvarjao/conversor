# Conversor

[![Testes](https://github.com/ademirvarjao/conversor/actions/workflows/tests.yml/badge.svg)](https://github.com/ademirvarjao/conversor/actions/workflows/tests.yml)
[![Deploy](https://github.com/ademirvarjao/conversor/actions/workflows/deploy.yml/badge.svg)](https://github.com/ademirvarjao/conversor/actions/workflows/deploy.yml)

**▶ Abrir o app: <https://ademirvarjao.github.io/conversor/>**

Aplicação web **100% client-side** (pronta para GitHub Pages) para importar, padronizar, unificar cronologicamente e exportar relatórios financeiros de pagamentos e recebimentos nos formatos **`.xlsx`** e **`.pdf`**.

O diferencial é o motor de **IA Adaptativa de Layouts**: ele infere o papel de cada coluna por semântica + estatística, aprende com as correções do usuário e reconhece variações de layout em arquivos futuros.

> **Privacidade:** nenhum arquivo sai do navegador. Toda a leitura, o aprendizado e a exportação acontecem localmente. O conector LLM (opcional) é a única exceção — e só é usado se você configurar sua própria chave.

---

## Recursos

### Importação (`.pdf` e `.xlsx`)
- **PDF (PDF.js)**: extração geométrica adaptativa — descobre colunas pelo alinhamento das coordenadas X, combina cabeçalhos em múltiplas linhas, recompõe descrições quebradas em duas linhas e descarta banners, CNPJ, totais e cabeçalhos repetidos de página.
- **Blocos de histórico com 2–3 linhas**: quando a data fica na linha do meio do bloco (extrato ICS do Itaú) ou a descrição quebra acima/abaixo dela, cada linha é ligada ao lançamento a que pertence e o texto de cada coluna é remontado na ordem vertical — data e histórico nunca viram uma coluna só (`Data Lançamentos`). O suporte de cada coluna é contado em todas as linhas do documento, não apenas nas que têm data. Rótulos de cabeçalho de colunas numéricas alinhadas à direita são ligados à coluna dos números (nada de `data valor`).
- **XLSX (ExcelJS)**: múltiplas abas (com seletor manual), datas nativas ali preservadas, fórmulas resolvidas, células mescladas sem duplicação, banners e linhas de resumo removidos automaticamente.
- **Relatórios de contas recebidas/pagas**: validação cruzada em julho/2026 — o arquivo "Contas Recebidas por Cliente" e o extrato de recebimentos do mesmo período geram **99 lançamentos, R$ 1.180.552,88 e as mesmas 99 combinações data+valor** (diferença zero).
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
- **Exporta o que estiver marcado** na planilha; **sem seleção, exporta tudo** (a opção “somente o resultado filtrado” vale como escolha para o caso sem seleção). A dica ao lado dos botões diz exatamente o que vai sair: `Exportando os 12 selecionados (de 567).` Vale para `.xlsx` e `.pdf`, e também para os três formatos do conciliador de clientes/fornecedores.

### IA Adaptativa de Layouts
- **Inferência semântica multi-sinal**: pesos léxicos PT-BR + análise estatística dos dados (datas reais, valores, colunas separadas de Entrada/Crédito e Saída/Débito, indicadores `D/C`, colunas esparsas) e exclusão automática de colunas de `Saldo`/`Total`/vazias.
- **Entradas e saídas em colunas separadas**: reconhece layouts em que o valor de cada linha aparece em **uma de duas colunas** (`Pagto.`/`Recbto.`, `Débito`/`Crédito`, `Saídas`/`Entradas`) — inclusive abreviações. O par é identificado pela exclusividade mútua dos dados e o sentido de cada coluna é confirmado pela **variação do saldo** linha a linha; na falta do saldo, vale o cabeçalho e, por último, a posição. O resultado é um único lançamento assinado por linha, em vez de duas colunas somadas.
- **Relatórios agrupados por cliente/fornecedor**: o nome do grupo (uma linha só com texto, alinhada à margem esquerda) é reconhecido e usado como **prefixo do histórico** dos lançamentos seguintes — típico de "Contas Recebidas por Cliente".
- **Previsto × realizado**: quando o arquivo traz `Data Venc`/`Valor Venc` e `Data Rec`/`Valor Recebido`, a conciliação usa **a data e o valor do fato** (recebimento/pagamento) e ignora o previsto, com aviso no Painel da IA.
- **Colunas de identificação não viram valor**: `Lancto`, `Documento`, `Nº`, `Código` e sequências numéricas (inteiros, únicos e crescentes) são ignorados automaticamente — antes o número do lançamento entraria na soma.
- **Extratos de banco já vêm treinados (v1.14.0)**: os layouts do **Itaú** (`Data | Lançamentos | Razão Social | CNPJ/CPF | Valor (R$) | Saldo (R$)`) e do **Bradesco** (`Data | Lançamento | Dcto. | Crédito (R$) | Débito (R$) | Saldo (R$)`) são reconhecidos na primeira importação, por perfil de fábrica (`src/seed-profiles.js`) — ninguém precisa treinar à mão. Esses perfis chegam à memória de qualquer usuário novo e sobrevivem a reset/importação de backup.
- **Crédito e débito pelo sinal e pela coluna**: no Bradesco o valor vem negativo na coluna de débito e positivo na de crédito; as âncoras de borda direita dos números separam `-4.100,00` de um crédito de mesmo tamanho. No Itaú o valor é único (sem sinal de coluna) e o **CNPJ/CPF em coluna própria** não vira histórico duplicado — ele é concatenado depois da razão social, na ordem do extrato.
- **Lançamento sem data**: linha de continuação (documento + valor + saldo, sem data) herda o dia do lançamento anterior, inclusive na **virada de página** — no extrato do Bradesco 22,08 de 05/10 estava sendo perdido. Faixas de resumo no topo da página (`R$ 2.520,90 R$ 0,00…`) continuam sendo banner, porque só aceitamos a linha numérica quando ela está colada (≤30 pt) acima de um lançamento com data.
- **Rodapé do extrato não é lançamento**: `novos lançamentos`, `atualizado em …` e o aviso de SAC/0800 do Itaú deixam de entrar como linha (eram 2 linhas de lixo nas 590 do arquivo).
- **Detecção de evolução de layout**: aponta exatamente o que mudou (`NOVA`, `RENOMEADA`, `AUSENTE`) e aplica o melhor mapeamento.
- **Aprendizado supervisionado**: ao confirmar/corrigir o mapeamento, o motor reforça ou penaliza os pesos dos tokens (com limites para evitar "explosão" de pesos), atualiza o perfil do layout e registra o evento.
- **Memória persistente** em `localStorage`, com exportação/importação de `conversor-ia-memoria.json` para versionar no repositório ou compartilhar entre máquinas. Backups inválidos são normalizados/descartados sem quebrar a aplicação.
- **Conector LLM opcional** (OpenAI ou Gemini, com chave do próprio usuário) para layouts inéditos, com timeout, validação da resposta e fallback para a IA local.

### Treinador automático de extratos (v1.15.0)
Todo extrato novo passa pelo mesmo roteiro de análise que um especialista faria à mão — e agora isso roda **dentro do app**, no painel de treino, sem mandar arquivo para ninguém:

- **Colunas entendidas**: data, valor (único ou crédito/débito), histórico, documento e saldo — com a amostra de cada coluna e a confiança da classificação.
- **Datas**: quantos lançamentos saíram com data válida e quantas linhas ficaram de fora (cabeçalho, total, rodapé, resumo).
- **Sinal**: negativo só em débito e positivo só em crédito; se houver valor do lado errado, o app propõe a troca das colunas.
- **Descartes**: quantas linhas foram ignoradas e quantas âncoras de saldo foram usadas.
- **Saldo conferido linha a linha** — o coração da análise: `saldo anterior + lançamentos = saldo`, em dois formatos: **corrente** (extrato com saldo em cada linha, como o Bradesco) e **checkpoint** (saldo só no fechamento do dia, como o Itaú). `SALDO ANTERIOR` no meio do arquivo é tratado como reinício de seção (não como erro) e saldos de outra série (`SALDO INVEST FÁCIL`, aplicação, bloqueado) ficam fora da conferência. As linhas que não fecham aparecem com valor, saldo, valor esperado e diferença.
- **Duplicados**: mesma data + valor + histórico, com a contagem (pode ser legítimo ou arquivo repetido).
- **Correções com um clique**: saldo ou nº de documento entrando como valor, crédito/débito trocados, coluna D/C ignorada, e sinal padrão quando os valores vêm todos positivos mas o saldo do período caiu exatamente a soma (extrato de pagamentos). O botão **Aplicar correções e treinar** aplica as correções no mapeamento, memoriza o perfil e reconfere o saldo.
- **Copiar diagnóstico**: o relatório em texto, para colar num e-mail ou no chat.
- Selo no cartão do arquivo com o resultado (`✓ saldo conferido 71/71`), para saber em qual arquivo vale a pena olhar antes de exportar.

Nos dois extratos usados como referência — **Itaú (567 lançamentos)** e **Bradesco (71 lançamentos)** — o treinador fecha o saldo em **todas** as conferências (20 checkpoints diários no Itaú; 71 linhas no Bradesco).

### Banco reconhecido na hora: catálogo + comunidade (v1.16.0)
O treinador passou a **reconhecer de quem é o extrato** antes de pedir qualquer coisa ao usuário. Três camadas, nesta ordem:

1. **Catálogo embutido — 18 bancos brasileiros** (`src/bank-layouts.js`): Itaú, Bradesco, Banco do Brasil, Caixa, Santander, Sicoob, Sicredi, Nubank, Inter, C6, BTG, Safra, Banrisul, Mercado Pago, PagBank, Stone, Original e Agibank. Cada um traz o apelido usado no cabeçalho (`Itaú Unibanco`, `CAIXA ECONÔMICA FEDERAL`…) e as regras de coluna do seu extrato. Se o banco e a estrutura de colunas batem, o layout **entra mapeado na primeira importação** — sem treino, sem LLM.
2. **Assinaturas aprendidas**: todo perfil memorizado guarda também a assinatura dos cabeçalhos (`layoutSignatures`, até 120, sem nenhum valor do extrato). Um extrato com o mesmo formato de um banco que você já treinou é reconhecido por semelhança de cabeçalhos (≥ 70%) e ganha o selo *Layout reaproveitado de um treino anterior*.
3. **Sinônimos genéricos**: quando não é banco conhecido, vale a heurística de sempre (`Dt. Mov.` → data, `Histórico` → histórico, `Nº Doc`/`Dcto.` → documento, `Valor` → valor, `Saldo` → conferência).

O reconhecimento vira a **primeira conferência do painel** (abaixo, *Banco e layout*), com a evidência: nome do banco encontrado no arquivo, quantas colunas batem com o padrão e a confiança. As divergências entre o padrão do banco e a leitura da IA aparecem como **correções de um clique** — o caso clássico é o `Dcto.` da Caixa entrando como valor.

**Catálogo da comunidade, opcional e anônimo** (detalhes na seção seguinte): o app faz **um GET** em `layouts/comunidade.json` e guarda a lista no navegador. Só a lista de bancos desce — **nada do seu arquivo sobe**: a comparação é local, o pedido não tem query string nem corpo (`credentials: 'omit'`). A atualização automática pode ser desligada no painel. Para contribuir com um banco novo, basta um PR acrescentando a entrada em `layouts/comunidade.json` — `id`, `name` e as colunas (`match` + `role`), sem nenhum dado de cliente; o app valida o arquivo antes de usar (`test/layout-registry.test.mjs` confere que ele não tem datas nem valores).

### Catálogo sempre atualizado, sem depender de ninguém (v1.17.0)
Atualizar um layout de banco **não exige publicar versão nova do app**: o catálogo é um arquivo do repositório, lido em tempo de execução. A v1.17.0 fechou o ciclo com quatro garantias:

- **Três fontes, com failover automático.** A primeira tentativa é o **próprio site** (`layouts/comunidade.json`, caminho relativo): mesma origem, zero CORS, zero terceiros — funciona no Pages oficial, em qualquer fork e em auto-hospedagem. (O workflow de deploy publica `layouts/` junto com `src/` e `vendor/`; um teste em `test/ui-contract.test.mjs` impede que essa cópia desapareça do deploy.) Se não responder, o app tenta o espelho **jsDelivr** e, por último, o **raw.githubusercontent**. A fonte que funcionou é lembrada e tentada primeiro na próxima vez. Em `file://` (HTML aberto do disco) só o GitHub raw é usado, porque CDN e mesma origem não valem nesse contexto.
- **Sempre atualizado, sem atrapalhar.** Revalida **sozinho ao abrir** o app, **de hora em hora** enquanto estiver em uso, **quando a aba volta a ficar visível** e **quando a internet volta** — sempre em segundo plano, 1,2 s depois do primeiro desenho. Como o pedido manda `Accept: application/json` e `cache: 'no-cache'`, o navegador revalida por ETag: catálogo igual custa um **304**, não um download. O status no painel mostra `N layouts • fonte: próprio site • verificado há 12 min`.
- **Nunca depende da rede para funcionar.** Os 18 bancos embutidos estão no pacote; o catálogo baixado é complemento. Sem internet, sem o arquivo no repositório ou com o `fetch` bloqueado, o reconhecimento continua igual. O catálogo salvo tem **cópia de segurança** em outra chave do `localStorage` (registro corrompido não zera nada) e uma falha de rede **nunca apaga** o catálogo bom.
- **Portátil de verdade.** **Importar catálogo (.json)** e **Exportar catálogo** permitem levar a lista de um navegador para outro, distribuir um kit para a equipe ou atualizar uma máquina sem internet. A exportação leva só `id`, `name`, `updatedAt`, colunas e quirks — nenhum lançamento.
- **Merge determinístico**: catálogos se juntam por `id`; em empate vale o publicado e, com `updatedAt` diferentes, o mais novo vence. Um layout do catálogo só substitui um **embutido** de mesmo `id` quando declara `"override": true` — o catálogo pode corrigir um banco sem publicar versão, mas um JSON qualquer não sequestra o layout que já funciona.

**Quirks por banco** que o reconhecimento já carrega: valor com sufixo `D`/`C` grudado no número (Banco do Brasil, Caixa), extrato do Itaú em **blocos de 3 linhas** com saldo só no fechamento do dia, seções de saldo que não entram na conferência (`SALDO INVEST FÁCIL`, `SALDO TOTAL DISPONÍVEL DIA`) e o Nubank sem coluna de saldo.

### Conciliação por CPF/CNPJ e nomes claros na tela (v1.22.0)

O conciliador de clientes/fornecedores passou a usar o **CPF/CNPJ** como identidade, e os dois campos
de arquivo ganharam nomes que dizem o que entra em cada um.

- **Casamento pelo CPF/CNPJ**, com ou sem máscara (`12.345.678/0001-99` = `12345678000199`), tanto
  quando o documento está no histórico (`PIX ENVIADO 12.345.678/0001-99`) quanto numa **coluna própria
  do extrato** — o Itaú ICS, por exemplo, imprime `CNPJ/CPF` ao lado da razão social. Documento igual é
  identidade: vale mais que qualquer semelhança de nome, e resolve o PIX/TED que só traz o número.
- **Extrato com duas colunas de texto** (`Lançamentos` + `Razão Social`) passou a virar um histórico só
  (`RECEBIMENTO REDE ELO — REDECARD INSTITUICAO DE PAGAMENTO S.A.`), sem repetir a parte que já estava
  na descrição. Antes o nome da contraparte era perdido e nada casava.
- **Selo `CPF/CNPJ` na linha** e **filtro `CPF/CNPJ`** para auditar de onde veio cada vínculo; o selo
  `conciliado` agora explica no `title` se o casamento foi por documento ou por nome (com o percentual),
  e o `revisar` avisa que há mais de um contato parecido.
- **Contadores na tela**: o aviso do cadastro mostra quantos contatos têm CPF/CNPJ (ou avisa que nenhum
  tem); o do extrato, quantos lançamentos trazem documento; a notificação final e o KPI dizem quantos
  vínculos vieram do documento.
- **Painel de vínculo** mostra o CPF/CNPJ do histórico, o documento de cada candidato e destaca
  `mesmo CPF/CNPJ` quando o do candidato aparece no lançamento.
- **Busca da conciliação** passou a considerar contato, código, CPF/CNPJ e as contas de débito/crédito —
  procurar `5086959` mostra onde a conta foi usada.
- Nomes dos campos: **Cadastro Cliente e Fornecedores** e **Conciliação bancária Conversor** (antes
  "Cadastro de contatos" e "Extrato / conciliação bancária"), com o título da seção acompanhando.
- Verificado com os arquivos reais: `Questor_Exportacao.pdf` (486 contatos, todos com CPF/CNPJ) e o
  extrato ICS de outubro (567 lançamentos, 484 com documento na coluna) — usando os documentos do
  próprio extrato no cadastro, **151 lançamentos** foram vinculados só pelo CPF/CNPJ.

### Correções de leitura e endurecimento do código (v1.21.0)

Rodada de revisão de todo o código, **sem tirar nenhuma função** do app: o que estava certo continua
igual, o que podia perder lançamento ou confundir o usuário foi corrigido.

- **Lançamento com nome de fornecedor "Total…" não é mais descartado.** A regra que tirava linhas de
  total/resumo olhava só a primeira palavra: `TOTAL EXPRESS LTDA`, `Total Distribuidora` e
  `Resumo do pedido 123` sumiam em silêncio (na planilha, mesmo com data e valor na linha). Agora o
  rótulo precisa ser um total de verdade — "Total do dia", "Parcial Cliente", "TOTAIS 45 1.234,56" — e
  **linha com data e valor é sempre lançamento**. Mesma regra na importação de PDF e de .xlsx.
- **Dois arquivos com o mesmo nome não se misturam.** A chave de cada lançamento (usada para editar o
  histórico, excluir e restaurar) passou a ser o **id da importação**; antes era o nome do arquivo, e
  dois "extrato.pdf" de meses diferentes compartilhavam a mesma linha 7. Ao remover um arquivo, as
  edições dele vão junto (senão voltariam a valer num novo import do mesmo nome).
- **CSV à prova de fórmula.** Histórico começando com `=`, `+`, `@`, `-` (seguido de texto), tabulação
  ou CR é exportado com apóstrofo na frente: o Excel/Sheets mostra o texto em vez de tentar executar.
- **Fim dos erros silenciosos.** Uma promessa rejeitada fora de `try/catch` (PDF interrompido, cota do
  `localStorage` estourada, resposta estranha da nuvem) agora aparece como aviso curto — no máximo três
  por página, sem repetir a mesma mensagem — e o detalhe continua no console. A falha de inicialização
  usa o mesmo mecanismo nas duas páginas.
- **PDF escaneado agora se explica.** Se o arquivo tem pouquíssimo texto selecionável (média abaixo de
  120 caracteres por página), a mensagem diz que o documento parece digitalizado e sugere baixar o
  extrato em .xlsx/.csv ou o PDF do internet banking — em vez de "não foi possível identificar linhas".
- **Planilha com "merge" gigante não trava mais a aba.** Intervalos mesclados com mais de 5.000 células
  são ignorados (relatórios antigos às vezes marcam a aba inteira como mesclada).
- **Um escape de HTML só, em `src/html.js`.** Importação, conciliador e treinador montavam cada um a
  sua cópia da função (uma delas sem uso nenhum). Agora os três importam a mesma, e um teste impede que
  alguém volte a duplicar a função. Nenhum texto de arquivo, banco ou usuário entra na tela sem escape.
- Limpeza: import morto (`CLOUD_LOCK`) removido, `src/ui-errors.js` e `src/html.js` novos, **401 testes**
  na suíte (todos os 11 PDFs reais continuam com a mesma contagem de lançamentos: Caixa 51, SISPAG 45,
  Itaú mensal 324, Itaú ICS 567, Itaú Sul 294, Bradesco 71, Sicoob 8).

### Treinador automático no fundo, interface mais limpa (v1.20.0)

- O **treinador automático** continua conferindo cada arquivo (colunas, sinais, datas, descartes e
  saldo), mas o relatório deixou de ocupar espaço: fica numa **barra de uma linha** com o placar
  (`8/8 conferências ✓`) e o resumo, e o detalhamento abre em **“Detalhes”**.
- O painel **não abre sozinho em nenhuma situação** (v1.20.1): fica recolhido em todo arquivo e só
  abre pelo botão. Quando há correção esperando decisão, o próprio botão avisa
  (`Detalhes • 1 correção`); trocar de arquivo recolhe de novo.
- Botões de catálogo (atualizar/importar/exportar), “Reanalisar” e “Copiar diagnóstico” passaram para
  dentro do detalhamento.
- Correção de estrutura: o `#toast-container` e os `<script>` estavam **dentro** do modal de opções
  (faltava um `</div>`), então os avisos de rodapé não apareciam. Agora o modal fecha no lugar certo.

### Mais três extratos reais: Caixa, SISPAG e o extrato mensal do Itaú (v1.19.0)

- **Cabeçalho quebrado em várias linhas** (SISPAG: `referência da` / `empresa`, `data do` / `pagamento`)
  agora monta as colunas pela posição dos rótulos em todas as linhas do cabeçalho, não só na do meio.
- **Valor com o status colado** (`749,60 efetuado`, `1.200,00 agendado`) é lido normalmente — antes o
  relatório inteiro saía vazio.
- **Favorecido quebrado em duas linhas** em volta da linha do valor volta a ser montado inteiro.
- **CPF/CNPJ** do favorecido deixou de entrar no histórico: é identificador, não descrição.
- **Extrato mensal do Itaú**: data só com dia/mês (`01/10`) — o ano é completado pela data do documento,
  com ajuste na virada dez → jan; colunas separadas de `entradas R$` / `saídas R$`; e o PDF traz
  **várias tabelas** (movimentação, aplicações automáticas, CDB): só a principal vira lançamento.
- **Legendas na margem** (`D = débito a compensar`, `Explicativas no final do extrato`) e o rodapé da
  página não se colam mais no histórico.
- **Caixa**: a linha `000000 | SALDO DIA | 0,00 C` deixou de virar lançamento de R$ 0,00.
- **Conferência de saldo honesta**: quando a coluna de saldo é de aplicação (15 valores soltos em 326
  linhas) ou o saldo impresso é de investimento, o treinador diz que não se aplica em vez de acusar
  divergência falsa.

Resultado nos 10 PDFs de referência: Caixa 51 lançamentos, SISPAG 45, extrato mensal 324 — e os quatro
bancos que já funcionavam (Itaú ICS 567, Itaú Sul 294, Bradesco 71, Sicoob 8) seguem com saldo fechando.

### Extratos “em lista”: qualquer banco, qualquer layout (v1.18.0)
O extrato do **Sicoob** derrubou a v1.17: o PDF vem num formato “em lista” — 4 colunas (`DATA | DOCUMENTO | HISTÓRICO | VALOR`), valor com `C`/`D` colado no número, **descrição quebrada em várias linhas depois do valor** e o saldo em linhas próprias (`SALDO ANTERIOR`, `SALDO DO DIA ===== >`), não em coluna. O app montava 6 colunas fantasma, jogava o valor na coluna errada e transformava resumo/rodapé em lançamento. O que mudou:

- **As colunas vêm do cabeçalho, não da sorte.** O parser procura a linha de cabeçalho (só texto, ≥ 2 rótulos conhecidos), traça as fronteiras entre os rótulos e ancora os dados nelas. Se não houver cabeçalho confiável, cai no agrupamento por posição de antes. É o que impede a coluna fantasma quando um pedaço da descrição (“- STR”) começa 45 pt à direita do rótulo.
- **Descrição em várias linhas** (antes ou depois do valor, como no Itaú e no Sicoob) é montada no bloco certo, na ordem vertical, e o documento pode ficar no histórico ou fora dele conforme o catálogo do banco.
- **Sufixo `C`/`D`** (`54.607,59C`, `39,00D`) define o sentido do lançamento — e `0,00*` é zero, não código.
- **Saldo em linha própria = checkpoint.** Quando o extrato não tem coluna de saldo, `SALDO ANTERIOR` / `SALDO DO DIA` viram checkpoints, e o treinador confere **saldo anterior + lançamentos = próximo saldo** (no Sicoob de set/2022: **7 conferências, todas fechando**, saldo final 0,20). As linhas de saldo também deixaram de virar lançamento quando o valor cai na mesma coluna dos movimentos.
- **Ruído fora**: `RESUMO`, “SALDO EM CONTA CORRENTE(+)”, “TAXA CHEQUE ESPECIAL”, ouvidoria com telefone colado, `Page 2 of 2`, `about:blank` e a linha digitável da TED (20 dígitos) não entram mais — nem como linha, nem como “valor”.
- **Duas correções no diagnóstico** que apareceram na revisão: o check de **sinal** só reclama de sinal *explícito* contrário à coluna (extratos imprimem `Pagto.`/`Recbto.` ambos positivos — eram 166 falsos positivos no Itaú Sul), e linha de **total/parcial** (“Parcial Cliente”) deixou de contar como falha de data.
- **O reconhecimento do banco não estraga o que a IA já acertou.** Ele só reescreve colunas que estão **no padrão do banco**; coluna fora do padrão (`Pagto.`, `Recbto.`) mantém o papel que a análise local encontrou, e há uma rede de segurança que nunca deixa o arquivo terminar sem data ou sem valor. Foi o que apareceu no **Itaú Sul**: banco reconhecido, mas o extrato usa colunas próprias — antes o reconhecimento zerava os valores e o arquivo saía vazio (294 → 0 lançamentos). Agora: 294 lançamentos, saldo 291/291.
- **PDF que não é extrato** (cadastro do Questor, por exemplo) agora explica o motivo em vez de só falhar.

Números depois da revisão: **Itaú 567** lançamentos (saldo 20/20), **Bradesco 71** (saldo 71/71), **Itaú Sul 294** (saldo 291/291), **Sicoob 8** (saldo 7/7), todos os 8 arquivos de referência com as conferências em `ok`.

### Conciliação de clientes/fornecedores (v1.8.0)
O **ícone da marca** na barra superior leva para uma **página própria** (`conciliador.html`), com fluxo separado da conciliação unificada para cruzar o **cadastro de contatos do Questor** com o extrato bancário. O **ícone da marca** no canto esquerdo é o caminho de volta para a página principal (o antigo botão *Conversor* do canto direito saiu na v1.26.1: fazia a mesma coisa) — as duas telas compartilham a mesma memória da IA.

- **Página dedicada**: `conciliador.html` tem espaço para a tabela inteira (sem painel apertado), estado de processamento, atalho de volta e o estado dos modelos da nuvem no topo — a sincronização é automática, sem botões (v1.23.0).
- **Duas entradas, vários arquivos**: (1) um ou mais cadastros `Questor_Exportacao` (`.pdf`/`.xlsx`) com as colunas `contactb`, `nomepessoa` e `natureza`; (2) um ou mais extratos com data, valor assinado e histórico. Os cadastros são consolidados por `contactb` (grafias diferentes viram apelidos do mesmo contato) e os extratos são unidos em ordem de data, sem repetir o mesmo lançamento quando um arquivo é enviado duas vezes — repetições legítimas dentro do mesmo arquivo (duas taxas iguais no mesmo dia) são preservadas.
- **Fornecedores × clientes pelo cadastro**: natureza **Credora** (contas `2.x`) são fornecedores; natureza **Devedora** (contas `1.x`) são clientes. Quando a coluna `natureza` vem vazia, o plano de contas decide. Grafias diferentes do mesmo `contactb` são unificadas.
- **Regra de vínculo**: **pagamento** (saída de caixa) casa com fornecedor de natureza **credora** e vai para a coluna **débito**; **recebimento** (entrada) casa com cliente de natureza **devedora** e vai para **crédito**.
- **Layout de saída**: `data | debito | credito | valor | historico`. Nas colunas **débito** e **crédito** vai a **conta do contato** da coluna `contactb`, escolhida pela natureza (pagamento → fornecedor credora; recebimento → cliente devedora), **sem pontuação** — `5.00.046` vira `500046`. O **valor** é sempre positivo (o sinal fica implícito na coluna) e é a única coluna monetária nesta função.
- **Casamento tolerante, mas conservador**: compara o nome do contato com o histórico ignorando acentos, sufixos societários (`LTDA`, `S/A`, `EIRELI`, `ME`…) e conectivos; aceita plural, abreviação em 3–4 letras (`Com.`, `Ind.`, `Mat.`) e um erro de digitação em palavras longas. Para evitar vínculo errado, exige uma palavra “cheia” (6+ letras) do cadastro no histórico, usa pesos de raridade do cadastro e trata empates como **revisar** em vez de chutar.
- **Aprendizado a cada uso**: cada vínculo aceito vira um **apelido** (histórico → `contactb`) e reforça os pesos dos tokens daquele contato. Na rodada seguinte os mesmos históricos são reconhecidos mesmo truncados — medido nos arquivos reais: 1ª passada **312 conciliados / 35 para revisar**; 2ª passada com memória **347 conciliados / 0 para revisar** (mesmos 132 sem cadastro correspondente).
- **Correção manual que ensina**: cada linha tem o botão **Vincular/Trocar**, que sugere candidatos (com %) e permite buscar no cadastro por nome, código ou CPF/CNPJ. Ao escolher, o vínculo é aplicado e memorizado na hora.
- **Conta de contrapartida digitada à mão**: a barra do lote tem **dois campos** — **Débitos vazios** e **Créditos vazios** —, cada um preenchendo só a sua coluna, e só onde ela está vazia (com ou sem pontos: `500046`, `5.00.046`). A aplicação vale para os lançamentos marcados, para todos os filtrados ou só para os que ainda estão sem contrapartida; um campo em branco não mexe na coluna do outro e, com os dois em branco, a ação limpa o que foi digitado à mão. Cada linha também tem o seu próprio campo, no painel de vínculo. A contrapartida **não substitui** a conta do contato: ela completa a **coluna oposta** (pagamento: débito tem o fornecedor → contrapartida no crédito; recebimento: crédito tem o cliente → contrapartida no débito). As colunas **debito** e **credito** da tabela também são editáveis **somente onde estão vazias** — clique na célula e digite a conta (com ou sem pontos) para completar o lançamento; contas que vieram do cadastro do contato não são sobrescritas por ali e o que foi digitado à mão continua reeditável para correção. O valor entra normalmente nas exportações.
- **Seleção em massa e tamanho da página**: o checkbox do cabeçalho marca **todos os lançamentos do filtro atual** (não só os da página) e o botão **Limpar seleção** desfaz tudo de uma vez; ao lado da paginação há o seletor **Linhas por página** — **50**, **100**, **300**, **1000** ou **todas**. O contador `selecionados (N)` acompanha a seleção, que sobrevive à troca de página e de tamanho.
- **Treino de contas no conciliador**: toda conta digitada — em lote, célula a célula ou no painel de vínculo — é memorizada **pelo histórico e pelo contato**. Na conciliação seguinte, o histórico já conhecido vem com a conta aplicada (2+ confirmações) ou como **chip de sugestão** clicável (1 confirmação), e o botão **Aplicar sugeridas** resolve o filtro inteiro. As sugestões aparecem também no painel de vínculo. O memorizado viaja no pacote cifrado da nuvem (`accounts`), então outra máquina com a mesma chave já recebe as contas.
- **Resumo da memória só para o administrador** (v1.24.0 · movido para o painel na v1.26.0): o resumo “Memória: N históricos • N contatos com conta • N contatos conciliados” deixou de aparecer para todo mundo. Desde a v1.26.0 ele **existe apenas dentro do painel do administrador** — a barra do conciliador não mostra número nenhum, e sem o desbloqueio o painel não abre. O limite de tentativas (5) e a espera de 30 s são os mesmos da aba Nuvem, e o desbloqueio feito em qualquer página vale para o site inteiro (mesma aba).
- **Painel do administrador** (v1.25.0 · revisado na v1.27.0): com o desbloqueio do administrador, o botão **Administrador** abre um painel com **seis abas** — **Visão geral** (tempo nesta sessão, tempo total, média por sessão, gráfico dos últimos 14 dias, conciliações e últimos eventos), **Uso** (13 contadores: cadastros e extratos carregados, conciliações, lançamentos vinculados/para revisar/sem contato, exportações, vínculos à mão, contas digitadas, sugestões aceitas, envios e sincronizações da nuvem, erros), **Códigos de acesso** (ver, bloquear e excluir do banco — seção própria abaixo), **Memória da IA** (perfis, vocabulário, assinaturas, contatos, apelidos, contas memorizadas, espaço usado no navegador e o histórico de aprendizado), **Logs** (até 300 eventos com filtro por tipo) e **Dispositivo e conta** (navegador, sistema, tela, fuso e o estado da chave/nuvem). O tempo só conta com a aba visível; nada sai do navegador. Sai um **relatório `.json`** completo (a chave de acesso à nuvem vai mascarada e a chave do LLM nunca aparece) e os **logs em `.csv`** com separador `;`, prontos para o Excel — e **Limpar histórico** (com confirmação) zera só o uso, sem tocar na memória da IA. O código está em [`src/admin-usage.js`](src/admin-usage.js) (dados) e [`src/admin-panel.js`](src/admin-panel.js) (telas).
- **Backup sem segredo**: a exportação da memória (`.json`) sai **sem a chave do LLM** e a importação não sobrescreve a configuração local do provedor — o arquivo pode ir para o GitHub sem vazar chave.
- **Edição e exclusão na planilha consolidada**: o **histórico é editável** linha a linha (clique no texto, Enter confirma, Esc cancela) e o texto corrigido vale para as exportações; o **✕** exclui um lançamento e o checkbox do cabeçalho marca **todos os lançamentos do filtro** (não só os da página) para **Excluir selecionados**. Nada é definitivo: **Restaurar excluídas (N)** devolve as linhas e as edições de histórico sobrevivem a remapear/treinar a IA. O seletor **Linhas por página** oferece **50**, **100** (padrão), **300**, **1000** ou **todas**, e os totais do resumo saem com separador de milhar — `1.128.118,12`.
- **Exportação ao concluir**: **`.xlsx`**, **`.pdf`** e **`.csv`** no mesmo layout de cinco colunas, com linha de `TOTAIS` (soma só do `valor`). As contas saem como **texto** no Excel, para não perder zeros à esquerda. O CSV usa `;` como separador e vírgula decimal (abre direto no Excel em português), com BOM UTF-8 para preservar acentos.
- **Tudo local**: os contatos e os lançamentos ficam no navegador. Só os modelos aprendidos (apelidos/pesos dessa conciliação) entram no pacote cifrado da nuvem, junto com o restante da memória da IA.

### Engrenagem e painel do administrador em todo o site (v1.26.0)
A **engrenagem** (⚙) fica na barra superior das **duas páginas** — Conversor e Conciliador — e abre o mesmo menu flutuante, com seções, ícone e uma linha de explicação em cada opção:

| Seção | Opções | Onde |
| --- | --- | --- |
| **Administração** | Painel do administrador • atalho para Uso, tempo e logs | as duas |
| **Memória da IA** | Memória e aprendizado • Exportar `.json` • Importar `.json` | as duas (backup só no Conversor) |
| **Configurações** | Backup e chave do LLM • Nuvem e conta | Conversor |
| **Ajuda** | Como funciona (README) | as duas |
| **Sessão** | Bloquear administrador (só aparece quando está liberado) | as duas |

- **Um painel, duas páginas**: a marcação do painel vem de `src/admin-panel.js` e o comportamento de `src/admin-console.js` — nenhuma página repete HTML. O menu é o mesmo: `src/gear-menu.js`.
- **Acesso universal, com senha**: o painel abre pela engrenagem em qualquer página, mas só depois do login do administrador (a **mesma trava** da conexão do banco): 1 hora por aba, 5 tentativas e espera de 30 s. Quem entrou numa página já entra na outra; o ícone ganha um anel verde e a opção **Bloquear administrador** devolve o pedido de senha.
- **Layout do menu**: `340 px` (ou a largura da tela no celular), posicionado abaixo do botão e nunca fora da janela; navegação por `↑` `↓` `Home` `End` `Esc` e clique fora para fechar, com foco devolvido à engrenagem.
- **O uso agora é do site inteiro**: as duas páginas gravam no mesmo registro local — arquivos importados, lançamentos gerados, exportações, memória, nuvem e erros aparecem juntos nos contadores e no histórico.
- **O resumo da memória vive no painel**: a visão geral e a aba **Memória da IA** mostram “Memória: N históricos • N contatos com conta • N contatos conciliados” — e a barra do conciliador não tem mais o texto.

### Códigos de acesso: ver, bloquear e excluir do banco (v1.27.0)
A aba **Códigos de acesso** do painel é a lista de todas as chaves de acesso que já passaram por este
navegador, cruzada com o que existe no banco:

- **Ver** — a lista mostra a chave mascarada (`ABCD-••••`), a origem (*criada aqui*, *recuperada aqui*,
  *colada aqui* ou *só vista no banco*), a data de criação, o último uso, se está **no banco** ou só neste
  navegador, se é a **chave em uso agora**, de quem é o cofre (conta logada ou sem dono, o caso legado) e o
  **estado** (liberado/bloqueado, com a data do bloqueio). **Ver código** revela a chave inteira e **Copiar**
  leva o `ABCD-EFGH` para a área de transferência.
- **Bloquear** — grava o bloqueio **no banco**, então vale para todos os navegadores: a partir daí o app
  **recusa enviar e baixar** por aquela chave (o download barrado nem decifra o pacote) e o próprio banco
  recusa qualquer gravação de conteúdo na linha bloqueada, inclusive por uma versão antiga do app em cache.
  **Desbloquear** limpa o bloqueio e o cofre volta a sincronizar. Clicar em bloquear a chave que está em uso
  deixa o aviso na hora — o estado da nuvem passa a mostrar o erro em vez de insistir.
- **Excluir do banco** — pede confirmação em dois toques e então **apaga a linha** com o conteúdo cifrado
  (função `conversor_delete_vault`), além de tirar a chave da lista deste navegador. Sem a linha, o código não
  recupera mais nada em máquina nenhuma. Existe também **Esquecer aqui**, que só apaga a anotação local.
- **Por que a lista local**: o banco guarda apenas o **slot** (HMAC da chave) e o pacote cifrado — não há como
  voltar do slot para o código. Por isso `src/vault-registry.js` anota cada chave criada/colada **neste
  navegador** (até 50, em `conversor_admin_vaults_v1`); as linhas que só existem no banco aparecem pelo slot,
  sem chave, e mesmo assim podem ser bloqueadas ou excluídas.
- **Quem pode o quê**: bloquear e excluir passam por funções `security definer` que só aceitam cofre **sem
  dono** ou **da própria conta** — cofre de outra conta é recusado (`42501`) e não aparece para quem não é dono.
  A chave anônima continua **sem** permissão de `DELETE` direto na tabela: a exclusão só acontece pela função.
- **O que isso não é**: o app é estático e usa a chave anônima pública, então a trava do painel é do navegador.
  O bloqueio, porém, é um dado do banco e vale para todos; e o conteúdo continua **cifrado** (AES-GCM com a
  chave de acesso) até alguém excluir a linha.

A migração nova é
[`20261112100000_conversor_models_block.sql`](supabase/migrations/20261112100000_conversor_models_block.sql)
(colunas `blocked_at`/`blocked_reason`, o gatilho que barra escrita em cofre bloqueado e as funções
`conversor_block_vault`/`conversor_delete_vault`). Ela entra sozinha pela integração Supabase + GitHub; se o
banco ainda não a tiver, a própria aba avisa e pede o **SQL de instalação** da aba **Nuvem** (o mesmo texto de
[`src/sql-setup.js`](src/sql-setup.js)) — que agora já inclui esse trecho.

### Layout do painel (v1.27.0)
- **Abas em uma linha só**: as seis abas não quebram mais em duas fileiras (o que desalinhava o cabeçalho);
  em tela estreita elas **rolam na horizontal**, com o mesmo comportamento de teclado (`←` `→` `Home` `End`).
- **Nada mais cortado**: o corpo do painel agora encolhe de verdade (`min-height: 0`) e rola dentro do cartão —
  antes o conteúdo longo empurrava a barra de ações para fora e os botões sumiam.
- **Grade fluida**: `auto-fit` no lugar de 4 colunas fixas — 4 no desktop, 2 no tablet e 1 no celular, sem
  cartão espremido.
- **Gráfico dos 14 dias**: a barra cresce dentro da coluna e o rótulo fica fora da área medida (antes a barra
  em `%` + o rótulo estouravam o gráfico); no celular os rótulos `dd/mm` saem e ficam no `title`/`aria-label`.
- **Barra de ações no celular**: dois botões por linha, com **Limpar histórico** ocupando a linha inteira.

### Nuvem dos modelos aprendidos (v1.5.0)
Compartilhar o que a IA aprendeu entre computadores **sem senha e sem cadastro**:

- **Só os modelos sobem.** Vão para o banco apenas `tokenWeights`, `learnedProfiles`, `learningLog` e `stats`. Arquivos, lançamentos financeiros e a chave do conector LLM **nunca** saem do navegador.
- **Chave de acesso de 8 caracteres** (`ABCD-EFGH`), em alfabeto de 32 símbolos sem `0`, `O`, `1` e `I` — fácil de ditar, copiar ou guardar num cartão. A chave é a identidade: em outra máquina, basta digitá-la para recuperar os modelos.
- **A chave fica sempre à vista na barra superior**: um clique copia, e o botão avisa que ela é necessária para abrir os modelos em outro computador (o `?` ao lado explica; sem chave, o mesmo botão a cria e já copia).
- **Entrar em outro computador direto pelo topo**: cole a chave no campo `Colar chave de outro PC` e confirme com `Usar` (ou `Enter`) — os modelos descem na hora.
- **Cifrado no navegador.** A chave passa por PBKDF2-SHA256 com 310.000 iterações e gera duas coisas: um `slot` opaco (HMAC) que identifica a linha no banco e uma chave AES-GCM-256 que cifra o conteúdo. Nem quem tem a chave anônima do projeto lê ou correlaciona usuários.
- **Sincronização automática, sem botões** (v1.23.0): o envio acontece sozinho depois de cada treinamento (e o download na abertura do app, ao adotar uma chave e quando a aba volta ao foco). **Não há mais os botões "Enviar modelos"/"Baixar modelos"** — o que a nuvem tem é **somado** ao que existe na máquina (perfis por `id`, histórico por `id`, maior peso por token, contas pelo registro mais recente), então nada do que foi aprendido offline se perde.
- **O LLM continua local:** ao baixar, a chave do conector já configurada nesta máquina é preservada.

#### Sincronização automática (v1.23.0)
A aba **Nuvem** deixou de ter botões de sincronizar: quem tem chave de acesso vê os modelos chegarem
e partirem sozinhos.

- **Envio**: agendado 1,2 s depois de qualquer mudança na memória (treinar um layout, corrigir conta,
  aceitar sugestão) — várias alterações seguidas geram **um** envio, não um por alteração.
- **Download**: na abertura do app, ao adotar uma chave e quando a aba volta ao foco (`visibilitychange`),
  sempre em segundo plano e sem travar a tela.
- **Soma, não substituição**: o pacote baixado é unido à memória local (`mergeVaultPayload`) — perfis e
  histórico pelo `id` (em conflito, fica o usado mais recentemente), pesos por token pelo maior valor,
  contas pelo registro mais recente e `uses`/`hits` pelo maior. Assim duas máquinas com a mesma chave
  terminam com os modelos das duas, e um treinamento feito sem internet não é apagado pelo download.
- **O que é local continua local**: a chave do LLM, as assinaturas de layout e a preferência do catálogo
  da comunidade nunca sobem e nunca são sobrescritas pelo que vem da nuvem.
- **Interface discreta**: a aba Nuvem mostra só o estado ("Modelos em dia com a nuvem", "Sincronizando…")
  e o painel do conciliador mantém a chave e o estado no topo. Na v1.23.1 os botões foram **removidos do
  HTML** de vez (antes ficaram com o atributo `hidden`, que o `display: inline-flex` do `.btn` vencia e
  eles continuavam aparecendo no topo do conciliador) — junto com os ids, os ouvintes de clique e o
  CSS `[hidden] { display: none !important }` passou a garantir que o atributo funcione em qualquer
  elemento.

#### Trava da conexão do banco (v1.11.0 · reescopada na v1.13.0)
A aba **Nuvem** é aberta para todo mundo: consultar a chave de acesso, criar/recuperar chave,
enviar e baixar modelos não pede senha nenhuma. O que fica atrás de **login e senha**
([`src/cloud-lock.js`](src/cloud-lock.js)) é só a **conexão do banco** — a *Project URL* e a
chave pública do Supabase, o único ponto capaz de desviar os dados de todos os usuários:

- a senha **não existe em texto puro no repositório**: ficam só o `salt` aleatório, 210.000
  iterações de **PBKDF2-SHA256** e o hash; a conferência roda no navegador (WebCrypto);
- a liberação vale para **aquela aba do navegador** e expira em **1 hora** (ou ao clicar em
  *Bloquear conexão agora*); fechar o navegador volta a bloquear;
- **5 tentativas erradas** → 30 segundos de espera; a mensagem de erro conta as tentativas.

> **Alcance real:** o Conversor é um site estático, então a trava é um **deterrente local** (protege
> contra quem usa o computador/navegador, não contra alguém que altere o JavaScript). A barreira de
> **servidor** é a conta na nuvem (Supabase Auth + RLS), descrita abaixo.

#### Conta na nuvem — Supabase Auth + RLS (v1.12.0)
A chave de acesso protege o **conteúdo**; a conta protege o **acesso**. Com uma conta do
Supabase Auth ([`src/cloud-auth.js`](src/cloud-auth.js)), cada consulta ao banco vai com o
`Authorization: Bearer <token do usuário>` e o **Row Level Security** passa a valer por dono:

- a conta vê e grava **apenas os cofres dela** (`owner_id = auth.uid()`);
- cofre com dono **não** pode ser lido, sobrescrito ou apagado por quem não é o dono — nem
  com a chave pública do projeto, nem sabendo o `slot`;
- linhas antigas (sem dono) continuam funcionando e são **adotadas** no primeiro envio autenticado
  — quem faz isso é o gatilho `conversor_models_touch()`, porque o upsert do PostgREST só atualiza
  as colunas enviadas no corpo do POST (o `owner_id` não vai no JSON; o banco decide);
- a coluna nasce com `default auth.uid()`, então o app não escolhe o dono: quem escolhe é o token;
- sem conta, o app segue exatamente como antes (chave anônima, cofres sem dono).

Na interface (**Memória da IA → Nuvem → Conta na nuvem**) há **Entrar**, **Criar conta** e
**Sair da conta**. A senha da conta não é guardada em nenhum lugar: o que fica no
`localStorage` são só os tokens da sessão, renovados automaticamente antes de vencer
(`expires_in` + refresh token). Se o projeto estiver com *Confirm email* ligado, o app avisa que
é preciso confirmar o e-mail antes do primeiro login.

As migrações que ligam isso são
[`20261111160000_conversor_models_owner.sql`](supabase/migrations/20261111160000_conversor_models_owner.sql)
(coluna + políticas),
[`20261111180000_conversor_models_adopt.sql`](supabase/migrations/20261111180000_conversor_models_adopt.sql)
(adoção das linhas antigas) e
[`20261112100000_conversor_models_block.sql`](supabase/migrations/20261112100000_conversor_models_block.sql)
(bloqueio e exclusão pelo painel do administrador), aplicadas pela integração Supabase + GitHub como as demais. Para trocar a senha da conta use
**Sair da conta** e o painel do Supabase (**Authentication → Users**), onde também dá para
desligar o cadastro público se você for o único usuário.

#### Banco de dados (sem passo manual)
O banco é **do repositório**: o schema mora em
[`supabase/migrations/`](supabase/migrations/) (tabela + cofre por dono) e a integração **Supabase + GitHub** aplica a migração sozinha a cada push na `main` —
não é preciso abrir o SQL Editor. A migração é idempotente (`create table if not exists`,
`drop policy if exists`), então pode rodar quantas vezes for preciso.

Para a integração aplicar as migrações, o repositório precisa do folder do projeto **com
[`supabase/config.toml`](supabase/config.toml)** — sem esse arquivo a integração nunca roda os
SQLs (era o que deixava a tabela ausente). No painel: **Project Settings → Integrations → GitHub**,
*Working directory* `.`, *Deploy to production* ligado e *Production branch* `main`.

Se a tabela ainda não existir, o próprio app resolve em dois cliques: a aba **Nuvem** detecta o
erro do PostgREST (`PGRST205`), mostra **Copiar SQL de instalação** (o mesmo SQL da migração,
embarcado em [`src/sql-setup.js`](src/sql-setup.js)), **Abrir SQL Editor** já no projeto certo e
**Verificar de novo** — que recheca o banco sem recarregar a página. Instruções e diagnóstico
completo ficam em [`supabase/README.md`](supabase/README.md).

A conexão do cliente (Project URL + chave **anon public**/**publishable**) é pública por natureza
e fica embutida em [`src/sync-config.js`](src/sync-config.js): o app já abre conectado e a tela
**Memória da IA → Nuvem (Equipe)** mostra o estado do banco e checa a conexão sozinha na
primeira abertura. O único passo do usuário é **criar a chave de acesso** (o segredo da
criptografia) — no primeiro clique ela já sobe os modelos locais.

Quem quiser apontar para um projeto próprio abre **Conexão com o banco (avançado)**, cola
os dois valores e salva; **Usar o banco oficial** volta ao padrão. Se a tabela ainda não
existir (projeto criado no mesmo instante), o app avisa que a migração está a caminho e
oferece [`supabase/schema.sql`](supabase/schema.sql) como aplicação manual de emergência.

Nunca use a chave `service_role` no app: ela ignora o RLS.

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

A suíte cobre aritmética monetária em centavos, parsers de data/valor, leitura real de `.xlsx` gerados em memória, geometria de reconstrução de tabelas de PDF (com coordenadas sintéticas), motor de IA (classificação, treino, memória, importação de backups), exportação (ida e volta `.xlsx` + geração de `.pdf` com jsPDF real) e a área do administrador (registro de uso, painel, menu da engrenagem — inclusive teclado e foco — e a trava de acesso).

---

## Publicar no GitHub Pages

1. Envie o repositório para o GitHub:
   ```bash
   git init
   git add .
   git commit -m "feat: Conversor"
   git branch -M main
   git remote add origin https://github.com/SEU-USUARIO/conversor.git
   git push -u origin main
   ```
2. **Habilite o GitHub Pages** em **Settings → Pages → Build and deployment → Source** e escolha **GitHub Actions**.
   > Esse passo é obrigatório e só pode ser feito por quem administra o repositório. Sem ele, o workflow de deploy não encontra o site do Pages e para (o log mostra exatamente esse aviso).
   > Alternativa automatizada: crie um secret `PAGES_TOKEN` com um PAT que tenha permissão de Pages — o workflow então habilita o site sozinho.
3. Em ~30 segundos o app estará em `https://SEU-USUARIO.github.io/conversor/`.

O workflow `.github/workflows/tests.yml` roda a suíte automaticamente em push e pull request.

---

## Estrutura

```text
conversor/
├── index.html                    # Conciliação unificada (HTML semântico + ARIA)
├── conciliador.html              # Página do conciliador de clientes/fornecedores
├── package.json                  # Scripts de dev/teste (sem dependências)
├── scripts/serve.mjs             # Servidor estático de desenvolvimento
├── src/
│   ├── app.js                    # Controlador de UI, upload, filtros, modal
│   ├── parsers.js                # PDF (extração + geometria) e XLSX
│   ├── ai-engine.js              # Classificação, treino e memória da IA
│   ├── seed-profiles.js          # Perfis de fábrica (extratos Itaú e Bradesco)
│   ├── training-coach.js         # Treinador automático (diagnóstico + conferência de saldo)
│   ├── bank-layouts.js           # Catálogo de 18 bancos, reconhecimento e assinaturas
│   ├── layout-registry.js        # Catálogo público da comunidade (download + cache)
│   ├── export-scope.js           # Regra de exportação (seleção → tudo)
│   ├── counterparty.js           # Conciliação clientes/fornecedores (cadastro Questor)
│   ├── counterparty-page.js      # Controlador da página conciliador.html
│   ├── exporters.js              # Exportação .xlsx, .pdf e .csv
│   ├── format.js                 # Formatação e aritmética em centavos
│   ├── summary.js                # Totalizadores (KPIs)
│   ├── ui-contract.js            # IDs exigidos pelo controlador + versão
│   ├── sync-crypto.js            # Chave de acesso, PBKDF2, AES-GCM (puro)
│   ├── sync-client.js            # Cliente REST do Supabase (só chave anônima)
│   ├── sync-vault.js             # Identidade, pacote de modelos e sincronização
│   ├── vault-registry.js         # Códigos de acesso conhecidos (ver/bloquear/excluir)
│   ├── sync-config.js            # URL + chave anônima padrão (públicas)
│   ├── admin-usage.js            # Uso do navegador: sessões, tempo, contadores e logs
│   ├── admin-panel.js            # Painel do administrador (dashboard, abas, tabelas)
│   ├── admin-console.js          # Monta o painel em qualquer página + senha do administrador
│   ├── gear-menu.js              # Menu da engrenagem (universal, com teclado e foco)
│   └── styles.css                # Estilos responsivos + acessibilidade
├── layouts/
│   └── comunidade.json           # Catálogo público de bancos (contribuição por PR)
├── supabase/
│   ├── migrations/               # Migração aplicada sozinha pela integração Supabase + GitHub
│   └── schema.sql                # Mesmo schema, para aplicação manual de emergência
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

**Uso restrito — todos os direitos reservados.** © 2026 **Ademir Varjão**.

O código é público **para leitura e estudo**, e o link pode ser compartilhado à vontade. O **uso** não é
livre: sem autorização prévia e por escrito do autor, não é permitido executar o app para processar
arquivos (próprios ou de terceiros), copiar, clonar, fazer fork, modificar, redistribuir, vender,
incorporar a outro produto ou serviço, nem usar o código para treinar modelos de IA. Também não se pode
remover o aviso de copyright do repositório.

Pedidos de autorização: **Ademir Varjão** — <https://github.com/ademirvarjao>. O texto completo, com as
condições e a ausência de garantias, está em [`LICENSE`](./LICENSE).
