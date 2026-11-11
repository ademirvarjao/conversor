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
- Opção de **exportar apenas o resultado filtrado** (busca + filtro de sinal).

### IA Adaptativa de Layouts
- **Inferência semântica multi-sinal**: pesos léxicos PT-BR + análise estatística dos dados (datas reais, valores, colunas separadas de Entrada/Crédito e Saída/Débito, indicadores `D/C`, colunas esparsas) e exclusão automática de colunas de `Saldo`/`Total`/vazias.
- **Entradas e saídas em colunas separadas**: reconhece layouts em que o valor de cada linha aparece em **uma de duas colunas** (`Pagto.`/`Recbto.`, `Débito`/`Crédito`, `Saídas`/`Entradas`) — inclusive abreviações. O par é identificado pela exclusividade mútua dos dados e o sentido de cada coluna é confirmado pela **variação do saldo** linha a linha; na falta do saldo, vale o cabeçalho e, por último, a posição. O resultado é um único lançamento assinado por linha, em vez de duas colunas somadas.
- **Relatórios agrupados por cliente/fornecedor**: o nome do grupo (uma linha só com texto, alinhada à margem esquerda) é reconhecido e usado como **prefixo do histórico** dos lançamentos seguintes — típico de "Contas Recebidas por Cliente".
- **Previsto × realizado**: quando o arquivo traz `Data Venc`/`Valor Venc` e `Data Rec`/`Valor Recebido`, a conciliação usa **a data e o valor do fato** (recebimento/pagamento) e ignora o previsto, com aviso no Painel da IA.
- **Colunas de identificação não viram valor**: `Lancto`, `Documento`, `Nº`, `Código` e sequências numéricas (inteiros, únicos e crescentes) são ignorados automaticamente — antes o número do lançamento entraria na soma.
- **Detecção de evolução de layout**: aponta exatamente o que mudou (`NOVA`, `RENOMEADA`, `AUSENTE`) e aplica o melhor mapeamento.
- **Aprendizado supervisionado**: ao confirmar/corrigir o mapeamento, o motor reforça ou penaliza os pesos dos tokens (com limites para evitar "explosão" de pesos), atualiza o perfil do layout e registra o evento.
- **Memória persistente** em `localStorage`, com exportação/importação de `conversor-ia-memoria.json` para versionar no repositório ou compartilhar entre máquinas. Backups inválidos são normalizados/descartados sem quebrar a aplicação.
- **Conector LLM opcional** (OpenAI ou Gemini, com chave do próprio usuário) para layouts inéditos, com timeout, validação da resposta e fallback para a IA local.

### Conciliação de clientes/fornecedores (v1.8.0)
O **ícone da marca** na barra superior leva para uma **página própria** (`conciliador.html`), com fluxo separado da conciliação unificada para cruzar o **cadastro de contatos do Questor** com o extrato bancário. O ícone de volta (e o botão *Conversor*) retornam à página principal — as duas telas compartilham a mesma memória da IA.

- **Página dedicada**: `conciliador.html` tem espaço para a tabela inteira (sem painel apertado), estado de processamento, atalho de volta e o estado dos modelos da nuvem no topo, com botões **Enviar/Baixar modelos** usando a chave já criada.
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
- **Backup sem segredo**: a exportação da memória (`.json`) sai **sem a chave do LLM** e a importação não sobrescreve a configuração local do provedor — o arquivo pode ir para o GitHub sem vazar chave.
- **Edição e exclusão na planilha consolidada**: o **histórico é editável** linha a linha (clique no texto, Enter confirma, Esc cancela) e o texto corrigido vale para as exportações; o **✕** exclui um lançamento e o checkbox do cabeçalho marca **todos os lançamentos do filtro** (não só os da página) para **Excluir selecionados**. Nada é definitivo: **Restaurar excluídas (N)** devolve as linhas e as edições de histórico sobrevivem a remapear/treinar a IA. O seletor **Linhas por página** oferece **50**, **100** (padrão), **300**, **1000** ou **todas**, e os totais do resumo saem com separador de milhar — `1.128.118,12`.
- **Exportação ao concluir**: **`.xlsx`**, **`.pdf`** e **`.csv`** no mesmo layout de cinco colunas, com linha de `TOTAIS` (soma só do `valor`). As contas saem como **texto** no Excel, para não perder zeros à esquerda. O CSV usa `;` como separador e vírgula decimal (abre direto no Excel em português), com BOM UTF-8 para preservar acentos.
- **Tudo local**: os contatos e os lançamentos ficam no navegador. Só os modelos aprendidos (apelidos/pesos dessa conciliação) entram no pacote cifrado da nuvem, junto com o restante da memória da IA.

### Nuvem dos modelos aprendidos (v1.5.0)
Compartilhar o que a IA aprendeu entre computadores **sem senha e sem cadastro**:

- **Só os modelos sobem.** Vão para o banco apenas `tokenWeights`, `learnedProfiles`, `learningLog` e `stats`. Arquivos, lançamentos financeiros e a chave do conector LLM **nunca** saem do navegador.
- **Chave de acesso de 8 caracteres** (`ABCD-EFGH`), em alfabeto de 32 símbolos sem `0`, `O`, `1` e `I` — fácil de ditar, copiar ou guardar num cartão. A chave é a identidade: em outra máquina, basta digitá-la para recuperar os modelos.
- **A chave fica sempre à vista na barra superior**: um clique copia, e o botão avisa que ela é necessária para abrir os modelos em outro computador (o `?` ao lado explica; sem chave, o mesmo botão a cria e já copia).
- **Entrar em outro computador direto pelo topo**: cole a chave no campo `Colar chave de outro PC` e confirme com `Usar` (ou `Enter`) — os modelos descem na hora.
- **Cifrado no navegador.** A chave passa por PBKDF2-SHA256 com 310.000 iterações e gera duas coisas: um `slot` opaco (HMAC) que identifica a linha no banco e uma chave AES-GCM-256 que cifra o conteúdo. Nem quem tem a chave anônima do projeto lê ou correlaciona usuários.
- **Envio automático** depois de cada treinamento, mais botões de **Enviar modelos** e **Baixar modelos**.
- **O LLM continua local:** ao baixar, a chave do conector já configurada nesta máquina é preservada.

#### Trava de acesso à Nuvem (v1.11.0)
A aba **Nuvem** — criar/entrar com a chave de acesso, enviar/baixar modelos e trocar o banco —
fica atrás de **login e senha** ([`src/cloud-lock.js`](src/cloud-lock.js)):

- a senha **não existe em texto puro no repositório**: ficam só o `salt` aleatório, 210.000
  iterações de **PBKDF2-SHA256** e o hash; a conferência roda no navegador (WebCrypto);
- a liberação vale para **aquela aba do navegador** e expira em **1 hora** (ou ao clicar em
  *Bloquear acesso agora*); fechar o navegador volta a bloquear;
- **5 tentativas erradas** → 30 segundos de espera; a mensagem de erro conta as tentativas;
- com a aba bloqueada a **chave de acesso aparece mascarada** (`••••-••••`) na barra superior, e
  os botões de enviar/baixar da **conciliação** (`conciliador.html`) ficam desativados — inclusive
  o envio automático, para ninguém usar a nuvem por essa página.

> **Alcance real:** o Conversor é um site estático, então a trava é um **deterrente local** (protege
> contra quem usa o computador/navegador, não contra alguém que altere o JavaScript). A barreira de
> **servidor** é a conta na nuvem (Supabase Auth + RLS), descrita abaixo.

#### Conta na nuvem — Supabase Auth + RLS (v1.12.1)
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
(coluna + políticas) e
[`20261111180000_conversor_models_adopt.sql`](supabase/migrations/20261111180000_conversor_models_adopt.sql)
(adoção das linhas antigas), aplicadas pela integração Supabase + GitHub como as demais. Para trocar a senha da conta use
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

A suíte cobre aritmética monetária em centavos, parsers de data/valor, leitura real de `.xlsx` gerados em memória, geometria de reconstrução de tabelas de PDF (com coordenadas sintéticas), motor de IA (classificação, treino, memória, importação de backups) e exportação (ida e volta `.xlsx` + geração de `.pdf` com jsPDF real).

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
│   ├── counterparty.js           # Conciliação clientes/fornecedores (cadastro Questor)
│   ├── counterparty-page.js      # Controlador da página conciliador.html
│   ├── exporters.js              # Exportação .xlsx, .pdf e .csv
│   ├── format.js                 # Formatação e aritmética em centavos
│   ├── summary.js                # Totalizadores (KPIs)
│   ├── ui-contract.js            # IDs exigidos pelo controlador + versão
│   ├── sync-crypto.js            # Chave de acesso, PBKDF2, AES-GCM (puro)
│   ├── sync-client.js            # Cliente REST do Supabase (só chave anônima)
│   ├── sync-vault.js             # Identidade, pacote de modelos e sincronização
│   ├── sync-config.js            # URL + chave anônima padrão (públicas)
│   └── styles.css                # Estilos responsivos + acessibilidade
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

MIT — veja [`LICENSE`](./LICENSE).
