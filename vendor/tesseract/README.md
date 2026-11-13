# Tesseract.js vendorizado (OCR offline)

Arquivos usados pelo OCR de PDFs digitalizados (`src/ocr.js`). Nada é baixado de CDN:
o worker, o core WebAssembly e o idioma são servidos pelo próprio site.

| Arquivo | Pacote | Versão |
| --- | --- | --- |
| `tesseract.esm.min.js`, `worker.min.js` | `tesseract.js` | 7.0.0 |
| `tesseract-core-simd-lstm.wasm.js`, `tesseract-core-lstm.wasm.js` | `tesseract.js-core` | 6.1.2 |
| `lang/por.traineddata.gz` | `@tesseract.js-data/por` | 1.0.0 (variante `4.0.0_best_int`) |

- O core **SIMD** é o primeiro da fila; o `lstm` sem SIMD é o plano B para navegadores
  sem WebAssembly SIMD (a ordem está em `OCR_CORE_FILES`, em `src/ocr.js`).
- `langPath` precisa apontar para a **pasta** (`…/vendor/tesseract/lang/`): o worker
  resolve o `.traineddata.gz` a partir dela.
- Para atualizar: `npm pack tesseract.js`, `npm pack tesseract.js-core`,
  `npm pack @tesseract.js-data/por` e copiar os arquivos acima (mantendo as licenças).

Licenças: `LICENSE-tesseract-js.md` (Apache-2.0) e `LICENSE-tesseract-core.txt`.
