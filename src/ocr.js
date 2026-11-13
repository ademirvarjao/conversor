/**
 * Conversor — OCR offline de PDFs digitalizados
 *
 * Extratos baixados como imagem (foto do caixa, PDF "escaneado") não têm
 * camada de texto: o PDF.js devolve zero linhas e a conversão travava. Aqui a
 * página é rasterizada em um canvas e lida pelo Tesseract.js, que está
 * vendorizado em `vendor/tesseract/` — nada vem de CDN e nada sai do
 * navegador (funciona offline depois do primeiro carregamento).
 *
 * O resultado é convertido para o mesmo formato de linhas que o PDF.js produz
 * (`{ page, y, h, items[] }`, com Y crescendo para cima, como no PDF), então a
 * reconstrução de colunas continua sendo feita por `buildTableFromTextLines`.
 */

import { cleanWhitespace, groupItemsIntoLines, mergeCurrencyTokens } from './parsers.js';

/** Idioma do OCR: português do Brasil (traineddata `por`). */
export const OCR_LANGUAGE = 'por';

/** Base dos arquivos do Tesseract, relativa a `src/ocr.js`. */
export const OCR_ASSET_BASE = '../vendor/tesseract/';

/**
 * Cores do Tesseract em ordem de preferência: o build SIMD é ~2x mais rápido;
 * o segundo é o plano B para navegadores sem WebAssembly SIMD.
 */
export const OCR_CORE_FILES = [
  'tesseract-core-simd-lstm.wasm.js',
  'tesseract-core-lstm.wasm.js',
];

/**
 * Escala de rasterização. Medido em um extrato digitalizado: com 2x o `03` da
 * data virava `63`; com 3x a leitura saiu limpa (e a confiança subiu). O custo
 * é memória/tempo, então páginas gigantes são reduzidas por `MAX_CANVAS_PIXELS`.
 */
export const OCR_PAGE_SCALE = 3;

/** Teto de pixels por página (~16 MP) para não estourar a memória do celular. */
export const MAX_CANVAS_PIXELS = 16_000_000;

/** Limite de páginas lidas por OCR (extratos grandes demorariam minutos). */
export const OCR_MAX_PAGES = 40;

/** Confiança média (0-100) abaixo da qual o aviso pede revisão. */
export const OCR_MIN_CONFIDENCE = 70;

let workerPromise = null;
let workerCore = '';

function assetUrl(name) {
  return new URL(`${OCR_ASSET_BASE}${name}`, import.meta.url).href;
}

/**
 * Traduz o token reconhecido para algo que o parser entenda.
 * Números são os que mais sofrem: `0`/`O`, `1`/`l`/`I`, `5`/`S`, `8`/`B`.
 * A troca só acontece quando o token JÁ tem dígito e é feito apenas de
 * caracteres "de número" — palavras como SALDO ou HISTORICO ficam intactas.
 */
/** Dígitos que o OCR troca entre si com mais frequência. */
const DIGIT_CONFUSIONS = {
  0: ['0', '6', '8', '9'],
  1: ['1', '7'],
  2: ['2', '7'],
  3: ['3', '8', '9'],
  4: ['4', '9'],
  5: ['5', '6', '8'],
  6: ['6', '0', '5', '8'],
  7: ['7', '1'],
  8: ['8', '0', '6', '9', '3'],
  9: ['9', '8', '0', '4'],
};

const DATE_TOKEN = /^(\d{2})\/(\d{2})\/(\d{2,4})$/;

function isValidDateParts(day, month) {
  return day >= 1 && day <= 31 && month >= 1 && month <= 12;
}

/**
 * Conserta data com dia/mês impossível trocando UM dígito por um parecido
 * (`63/01/2026` → `03/01/2026`). Só age quando a data é inválida e existe uma
 * única correção plausível — nunca "inventa" data em token ambíguo.
 */
export function repairOcrDate(token) {
  const match = DATE_TOKEN.exec(token || '');
  if (!match) return token;
  const [, dayText, monthText, yearText] = match;
  if (isValidDateParts(Number(dayText), Number(monthText))) return token;

  const candidates = new Set();
  const variants = (text) => {
    const out = [];
    for (let index = 0; index < text.length; index++) {
      for (const digit of DIGIT_CONFUSIONS[Number(text[index])] || []) {
        if (digit === text[index]) continue;
        out.push(text.slice(0, index) + digit + text.slice(index + 1));
      }
    }
    return out;
  };

  for (const day of variants(dayText)) {
    if (isValidDateParts(Number(day), Number(monthText))) {
      candidates.add(`${day}/${monthText}/${yearText}`);
    }
  }
  for (const month of variants(monthText)) {
    if (isValidDateParts(Number(dayText), Number(month))) {
      candidates.add(`${dayText}/${month}/${yearText}`);
    }
  }
  // Ano com dois dígitos (raro): só corrige se um dígito trocado vierar 20xx.
  if (yearText.length === 2) {
    for (const year of variants(yearText)) {
      if (Number(year) >= 20) candidates.add(`${dayText}/${monthText}/${year}`);
    }
  }

  return candidates.size === 1 ? [...candidates][0] : token;
}

export function repairOcrToken(rawToken) {
  const token = cleanWhitespace(rawToken);
  if (!token) return '';
  if (!/\d/.test(token)) return token;

  let repaired = token;
  if (/^[\dOoIlSsBbZz.,:+\-/()R$%]+$/.test(token)) {
    const mapped = token
      .replace(/[Oo]/g, '0')
      .replace(/[Il|]/g, '1')
      .replace(/[Ss]/g, '5')
      .replace(/[Bb]/g, '8')
      .replace(/[Zz]/g, '2');
    // Só aceita a correção se o resultado parece mesmo um número/dado.
    if (/\d/.test(mapped)) repaired = mapped;
  }

  // Data com dia/mês impossível ganha uma segunda chance (um dígito trocado).
  return DATE_TOKEN.test(repaired) ? repairOcrDate(repaired) : repaired;
}

/**
 * Converte os blocos do Tesseract em linhas no formato do PDF.js.
 * O Y do OCR cresce para baixo; o do PDF, para cima — daí a inversão.
 *
 * As coordenadas do OCR estão em PIXELS do canvas (3x); voltamos para pontos do
 * PDF dividindo pela escala, que é a unidade que o resto do parser usa para
 * agrupar linhas (tolerância de 2,5 pt) e alinhar colunas.
 *
 * @param {Array} blocks blocos de `data.blocks` (com `paragraphs[].lines[].words[]`)
 * @param {{page?: number, pageHeight: number, scale?: number}} pageInfo
 */
export function blocksToPdfLines(blocks, pageInfo = {}) {
  const pageHeight = Number(pageInfo.pageHeight) || 0;
  const page = Number(pageInfo.page) || 1;
  const factor = 1 / (Number(pageInfo.scale) || 1);
  const items = [];

  for (const block of blocks || []) {
    for (const paragraph of block?.paragraphs || []) {
      for (const line of paragraph?.lines || []) {
        for (const word of line?.words || []) {
          const str = repairOcrToken(word?.text);
          const bbox = word?.bbox || {};
          if (!str) continue;
          const x = Number(bbox.x0);
          const top = Number(bbox.y0);
          const bottom = Number(bbox.y1);
          if (!Number.isFinite(x) || !Number.isFinite(top) || !Number.isFinite(bottom)) continue;
          items.push({
            str,
            x: x * factor,
            y: (pageHeight - bottom) * factor,
            w: Math.max(0, (Number(bbox.x1) - x) * factor),
            h: Math.max(0, (bottom - top) * factor),
          });
        }
      }
    }
  }

  return groupItemsIntoLines(items).map((line) => ({
    page,
    y: line.y,
    h: line.h,
    items: mergeCurrencyTokens(line.items),
  }));
}

/** Texto de uma página, reconstruído a partir dos blocos (para depurar/relatar). */
export function blocksToText(blocks) {
  return (blocks || [])
    .flatMap((block) => block?.paragraphs || [])
    .flatMap((paragraph) => paragraph?.lines || [])
    .map((line) => cleanWhitespace((line?.words || []).map((word) => word?.text).join(' ')))
    .filter(Boolean)
    .join('\n');
}

async function loadTesseractModule() {
  const module = await import(`${OCR_ASSET_BASE}tesseract.esm.min.js`);
  // A build ESM do tesseract.js publica só `default`; versões antigas exportam
  // `createWorker` direto. Aceitamos as duas formas.
  return module.createWorker ? module : module.default || module;
}

async function createWorkerWithCore(api, coreFile, { onProgress }) {
  return api.createWorker(OCR_LANGUAGE, api.OEM?.LSTM_ONLY ?? 1, {
    workerPath: assetUrl('worker.min.js'),
    corePath: assetUrl(coreFile),
    langPath: new URL(`${OCR_ASSET_BASE}lang/`, import.meta.url).href,
    workerBlobURL: false,
    logger: (message) => {
      if (typeof onProgress === 'function' && message?.status) {
        onProgress({ status: String(message.status), progress: Number(message.progress) || 0 });
      }
    },
  });
}

/**
 * Cria (uma única vez) o worker do Tesseract. O download do idioma e do core
 * acontece do próprio site; depois disso o OCR funciona sem rede.
 */
export async function getOcrWorker(options = {}) {
  if (workerPromise) return workerPromise;

  workerPromise = (async () => {
    if (typeof document === 'undefined') {
      throw new Error('O OCR só funciona no navegador.');
    }
    const api = await loadTesseractModule();
    const failures = [];
    for (const coreFile of OCR_CORE_FILES) {
      try {
        const worker = await createWorkerWithCore(api, coreFile, options);
        workerCore = coreFile;
        return worker;
      } catch (error) {
        failures.push(`${coreFile}: ${error?.message || error}`);
      }
    }
    throw new Error(`Não foi possível iniciar o leitor de OCR (${failures.join(' | ')}).`);
  })();

  try {
    return await workerPromise;
  } catch (error) {
    workerPromise = null;
    throw error;
  }
}

/** Encerra o worker (libera ~40 MB). A próxima conversão cria outro. */
export async function disposeOcrWorker() {
  const current = workerPromise;
  workerPromise = null;
  workerCore = '';
  if (!current) return;
  try {
    const worker = await current;
    await worker?.terminate?.();
  } catch {
    /* worker que nunca subiu não tem o que encerrar */
  }
}

/** Nome do core em uso (diagnóstico/telas de status). */
export function currentOcrCore() {
  return workerCore;
}

function meanConfidence(blocks) {
  let sum = 0;
  let count = 0;
  for (const block of blocks || []) {
    for (const paragraph of block?.paragraphs || []) {
      for (const line of paragraph?.lines || []) {
        for (const word of line?.words || []) {
          const confidence = Number(word?.confidence);
          if (!Number.isFinite(confidence) || confidence <= 0) continue;
          sum += confidence;
          count += 1;
        }
      }
    }
  }
  return count > 0 ? Math.round((sum / count) * 10) / 10 : 0;
}

function friendlyOcrFailure(error) {
  const message = String(error?.message || error || '');
  if (/PasswordException|senha/i.test(message)) {
    return new Error('O PDF está protegido por senha. Remova a proteção e tente novamente.');
  }
  if (/worker|importScripts|wasm|core|fetch|404|Failed to load/i.test(message)) {
    return new Error(
      'Não foi possível carregar o leitor de OCR (arquivos em vendor/tesseract). ' +
        'Recarregue a página e tente de novo.'
    );
  }
  return new Error(`Falha no OCR do PDF: ${message || 'erro desconhecido'}`);
}

async function openPdf(arrayBuffer, pdfjsLib) {
  if (!pdfjsLib) throw new Error('Biblioteca PDF.js não carregada.');
  const data = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
  try {
    return await pdfjsLib.getDocument({ data, verbosity: 0 }).promise;
  } catch (error) {
    if (error?.name === 'PasswordException') {
      throw new Error('O PDF está protegido por senha. Remova a proteção e tente novamente.');
    }
    throw new Error(
      `Não foi possível abrir o PDF para OCR: ${error?.message || 'arquivo inválido ou corrompido'}.`
    );
  }
}

/**
 * Lê um PDF digitalizado por OCR.
 *
 * @param {ArrayBuffer|Uint8Array} arrayBuffer
 * @param {object} pdfjsLib namespace do PDF.js (injetado para testes)
 * @param {{onProgress?: (page:number, total:number)=>void, onStatus?: Function,
 *          scale?: number, maxPages?: number}} [options]
 * @returns {Promise<{pageCount:number, pagesRead:number, lines:Array,
 *   confidence:number, pages:Array<{page:number, chars:number, confidence:number}>}>}
 */
export async function ocrPdfToLines(arrayBuffer, pdfjsLib, options = {}) {
  const {
    onProgress,
    onStatus,
    scale = OCR_PAGE_SCALE,
    maxPages = OCR_MAX_PAGES,
  } = options;

  if (typeof document === 'undefined') {
    throw new Error('O OCR só funciona no navegador.');
  }

  const doc = await openPdf(arrayBuffer, pdfjsLib);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const lines = [];
  const pages = [];

  try {
    const worker = await getOcrWorker({ onProgress: onStatus });
    const total = Math.min(doc.numPages, Math.max(1, maxPages));

    for (let pageNumber = 1; pageNumber <= total; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      try {
        // Página enorme em 3x estouraria a memória do celular: reduz a escala
        // só o suficiente para caber no teto de pixels.
        const base = page.getViewport({ scale: 1 });
        const maxScale = Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, base.width * base.height));
        const viewport = page.getViewport({ scale: Math.min(scale, maxScale) });
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        context.save();
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.restore();

        await page.render({ canvasContext: context, viewport, canvas }).promise;

        const { data } = await worker.recognize(canvas, {}, { blocks: true, text: true });
        const pageLines = blocksToPdfLines(data?.blocks, {
          page: pageNumber,
          pageHeight: canvas.height,
          scale: viewport.scale || 1,
        });
        lines.push(...pageLines);
        pages.push({
          page: pageNumber,
          chars: pageLines.reduce(
            (total, line) => total + line.items.reduce((sum, item) => sum + item.str.length, 0),
            0
          ),
          confidence: meanConfidence(data?.blocks),
          text: blocksToText(data?.blocks),
        });
      } finally {
        page.cleanup?.();
        if (typeof onProgress === 'function') onProgress(pageNumber, total);
      }
    }

    const confidence = pages.length
      ? Math.round((pages.reduce((sum, page) => sum + page.confidence, 0) / pages.length) * 10) / 10
      : 0;

    return {
      pageCount: doc.numPages,
      pagesRead: pages.length,
      truncated: doc.numPages > pages.length,
      lines,
      pages,
      confidence,
    };
  } catch (error) {
    throw friendlyOcrFailure(error);
  } finally {
    try {
      await doc.destroy();
    } catch {
      /* ignora falhas de limpeza */
    }
  }
}
