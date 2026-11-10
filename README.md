# Conversor Custódio

Aplicação web estática (100% client-side, pronta para **GitHub Pages**) para importação, padronização, unificação cronológica e exportação de relatórios financeiros de pagamentos e recebimentos nos formatos **`.xlsx`** e **`.pdf`**, equipada com um motor de **IA Adaptativa de Layouts** que aprende mudanças estruturais em arquivos futuros.

---

## Principais Funcionalidades

- **Importação múltipla (`.pdf` e `.xlsx`)**:
  - Extrator geométrico adaptativo para PDFs via **PDF.js** (descobre colunas automaticamente por alinhamento de coordenadas, combina cabeçalhos em múltiplas linhas e recupera textos longos cortados visualmente).
  - Leitor de planilhas **ExcelJS** (suporte a múltiplas abas, datas nativas, fórmulas e remoção automática de banners/totais).
- **Padronização para 3 colunas**:
  - **`data`**: formato `dd/mm/aaaa`, ordenada em ordem crescente.
  - **`valor`**: numérico (`0000,00` se positivo / `-0000,00` se negativo, sem símbolo `R$` e sem separador de milhar).
  - **`historico`**: formato texto (`@`), concatenando todas as colunas descritivas disponíveis e substituindo caracteres `|` por espaço (configurável).
- **Exportação em `.xlsx` e `.pdf`**:
  - **`.xlsx`**: aba única `Conciliacao` com tipagem nativa de data, número (`0.00`) e texto (`@`), pronta para Excel ou importação contábil.
  - **`.pdf`**: relatório A4 paisagem paginado com totalizadores de entradas, saídas e saldo líquido.
- **IA Adaptativa de Layouts**:
  - **Inferência Semântica Multi-Sinal**: classifica automaticamente colunas por pesos léxicos + análise estatística dos dados (detecta datas, valores únicos, colunas separadas de Entrada/Crédito e Saída/Débito, indicadores `D/C`, e ignora automaticamente colunas de `Saldo`/`Subtotal`).
  - **Detecção de Evolução de Layout**: ao receber um arquivo parecido com um layout conhecido que ganhou novas colunas ou teve títulos alterados, a IA sinaliza exatamente o que mudou (`NOVA` / `RENOMEADA`) e aplica o melhor mapeamento sugerido.
  - **Aprendizado Supervisionado Contínuo**: ao confirmar ou corrigir o mapeamento no painel **"Treinar IA e Aplicar Layout"**, a IA reforça os pesos do vocabulário e salva o perfil localmente (`localStorage`), além de permitir **exportar/importar `custodio-ia-memoria.json`** para versionar o conhecimento no próprio repositório GitHub.
  - **Conector LLM Opcional**: funciona 100% offline sem chave de API, mas permite opcionalmente configurar uma chave própria (OpenAI ou Google Gemini) para analisar layouts inéditos.

---

## Como Hospedar no GitHub Pages

1. Crie um repositório no GitHub (por exemplo, `conversor-custodio`) e envie os arquivos desta pasta:
   ```bash
   git init
   git add .
   git commit -m "feat: publicar Conversor Custódio"
   git branch -M main
   git remote add origin https://github.com/SEU-USUARIO/conversor-custodio.git
   git push -u origin main
   ```
2. No GitHub, acesse **Settings → Pages**.
3. Em **Build and deployment**, escolha **GitHub Actions** (o workflow `.github/workflows/deploy.yml` já está configurado) **ou** **Deploy from a branch** → branch `main` → pasta `/ (root)`.
4. Em ~30 segundos sua aplicação estará online em `https://SEU-USUARIO.github.io/conversor-custodio/`.

---

## Como Executar Localmente

Como o app utiliza módulos ES6 e Web Workers do PDF.js, execute via qualquer servidor HTTP estático (não abra diretamente via `file://`):

```bash
python3 -m http.server 8080
```
Acesse `http://localhost:8080`.

---

## Estrutura do Repositório

```text
conversor-custodio/
├── index.html                   # Interface principal
├── package.json                 # Script opcional de servidor local
├── .github/workflows/deploy.yml # Deploy automático no GitHub Pages
├── src/
│   ├── app.js                   # Controlador de interface, filtros e estado
│   ├── parsers.js               # Extração geométrica de PDFs e leitura de XLSX
│   ├── ai-engine.js             # Motor de IA adaptativa e memória persistente
│   ├── exporters.js             # Exportadores padronizados .xlsx e .pdf
│   └── styles.css               # Estilos responsivos
└── vendor/                      # Dependências empacotadas offline (PDF.js, ExcelJS, jsPDF)
```
