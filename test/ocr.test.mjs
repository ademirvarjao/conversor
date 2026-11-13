/**
 * Testes do OCR offline (PDFs digitalizados).
 *
 * O Tesseract em si roda no navegador; aqui validamos as peças puras (limpeza
 * do token, geometria das linhas) e — o mais importante — o encaixe do OCR no
 * `parsePdfFile`: um PDF sem camada de texto passa a produzir lançamentos, e a
 * leitura fica registrada em `parsedFile.ocr` para ir parar no banco.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  OCR_PAGE_SCALE,
  blocksToPdfLines,
  blocksToText,
  repairOcrDate,
  repairOcrToken,
} from '../src/ocr.js';
import { parsePdfFile } from '../src/parsers.js';

/* -------------------------------------------------------------------------- */
/*                       Token reconhecido e geometria                         */
/* -------------------------------------------------------------------------- */

describe('repairOcrToken', () => {
  it('conserta dígitos trocados por letras parecidas só em tokens numéricos', () => {
    assert.equal(repairOcrToken('1.2S0,0O'), '1.250,00');
    assert.equal(repairOcrToken('O2/O1/2O26'), '02/01/2026');
    assert.equal(repairOcrToken('-845,3O'), '-845,30');
    assert.equal(repairOcrToken('B.32O,15'), '8.320,15');
  });

  it('conserta data com dia impossível trocando um único dígito', () => {
    assert.equal(repairOcrDate('63/01/2026'), '03/01/2026');
    assert.equal(repairOcrToken('1S/01/2026'), '15/01/2026');
    // Data válida passa intacta.
    assert.equal(repairOcrDate('02/01/2026'), '02/01/2026');
    // Ambígua (várias correções possíveis) fica como veio: melhor não inventar.
    assert.equal(repairOcrDate('45/01/2026'), '45/01/2026');
    assert.equal(repairOcrDate('32/13/2026'), '32/13/2026');
  });

  it('rasteriza em 3x — a escala em que a data sai correta', () => {
    assert.equal(OCR_PAGE_SCALE, 3);
  });

  it('não mexe em palavras do histórico', () => {
    assert.equal(repairOcrToken('SALDO'), 'SALDO');
    assert.equal(repairOcrToken('PIX'), 'PIX');
    assert.equal(repairOcrToken('Historico'), 'Historico');
    assert.equal(repairOcrToken('  TED  '), 'TED');
    assert.equal(repairOcrToken(''), '');
  });
});

describe('blocksToPdfLines', () => {
  const word = (text, x0, y0, x1, y1) => ({
    text,
    bbox: { x0, y0, x1, y1 },
    confidence: 90,
  });
  const line = (words) => ({ words });
  const blocks = [
    {
      paragraphs: [
        { lines: [line([word('Data', 80, 20, 130, 40), word('Valor', 400, 20, 470, 40)])] },
        {
          lines: [
            line([
              word('02/01/2026', 80, 100, 220, 120),
              word('R$', 380, 100, 400, 120),
              word('1.250,00', 410, 100, 500, 120),
            ]),
          ],
        },
      ],
    },
  ];

  it('inverte o Y (OCR cresce para baixo, PDF para cima) e ordena as linhas', () => {
    const lines = blocksToPdfLines(blocks, { page: 2, pageHeight: 700 });
    assert.equal(lines.length, 2);
    // A linha de cima do documento (y0 menor no OCR) tem Y maior no PDF.
    assert.ok(lines[0].y > lines[1].y);
    assert.equal(lines[0].items.map((item) => item.str).join(' '), 'Data Valor');
    assert.equal(lines[0].page, 2);
  });

  it('junta o símbolo de moeda ao número da direita', () => {
    const lines = blocksToPdfLines(blocks, { page: 1, pageHeight: 700 });
    const data = lines.find((item) => item.items.some((word) => word.str.startsWith('02/01')));
    assert.deepEqual(
      data.items.map((item) => item.str),
      ['02/01/2026', 'R$ 1.250,00']
    );
  });

  it('converte as coordenadas do canvas (pixels) para pontos do PDF', () => {
    // Em 3x, uma palavra em (300, 900) de um canvas de 3000 px de altura fica em
    // x=100 e y=(3000-900)/3=700 no espaço do PDF.
    const [pdfLine] = blocksToPdfLines(
      [{ paragraphs: [{ lines: [line([word('SALDO', 300, 880, 420, 900)])] }] }],
      { page: 1, pageHeight: 3000, scale: 3 }
    );
    assert.equal(pdfLine.items[0].x, 100);
    assert.equal(pdfLine.y, 700);
    assert.equal(pdfLine.items[0].w, 40);
    assert.ok(Math.abs(pdfLine.items[0].h - 20 / 3) < 1e-9);
  });

  it('ignora palavra sem coordenada válida e devolve texto legível', () => {
    const lines = blocksToPdfLines(
      [{ paragraphs: [{ lines: [line([{ text: 'X', bbox: {} }, word('SALDO', 10, 10, 60, 30)])] }] }],
      { pageHeight: 100 }
    );
    assert.equal(lines.length, 1);
    assert.equal(lines[0].items[0].str, 'SALDO');
    assert.equal(blocksToText(blocks).split('\n')[0], 'Data Valor');
  });
});

/* -------------------------------------------------------------------------- */
/*                        Encaixe do OCR no parsePdfFile                      */
/* -------------------------------------------------------------------------- */

const fakePdfjs = (pages) => ({
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: pages,
      getPage: async () => ({
        getTextContent: async () => ({ items: [] }),
        cleanup() {},
      }),
      destroy: async () => {},
    }),
  }),
});

const ocrLine = (page, y, tokens) => ({
  page,
  y,
  h: 9,
  items: tokens.map(([str, x], index) => ({ str, x: x ?? index * 60, w: 40, h: 9 })),
});

/** Engine de OCR falsa: devolve as linhas de um extrato já reconhecido. */
function fakeOcrEngine(lines, extra = {}) {
  const calls = [];
  const engine = async (_buffer, _pdfjs, options) => {
    calls.push(options);
    options.onProgress?.(1, 1);
    return {
      pageCount: 1,
      pagesRead: 1,
      truncated: false,
      confidence: 93.4,
      pages: [{ page: 1, chars: 120, confidence: 93.4 }],
      lines,
      ...extra,
    };
  };
  engine.calls = calls;
  return engine;
}

describe('parsePdfFile com OCR', () => {
  const scannedLines = [
    ocrLine(1, 700, [['Data', 60], ['Historico', 180], ['Valor', 460]]),
    ocrLine(1, 660, [['02/01/2026', 60], ['PIX RECEBIDO JOAO', 180], ['1.250,00', 460]]),
    ocrLine(1, 620, [['03/01/2026', 60], ['PAGTO FORNECEDOR ABC', 180], ['-845,30', 460]]),
  ];

  it('usa o OCR quando o PDF não tem camada de texto', async () => {
    const engine = fakeOcrEngine(scannedLines);
    const parsed = await parsePdfFile(new Uint8Array([1]), 'escaneado.pdf', fakePdfjs(1), {
      ocrEngine: engine,
    });

    assert.equal(engine.calls.length, 1);
    assert.equal(parsed.ocr.used, true);
    assert.equal(parsed.ocr.confidence, 93.4);
    assert.equal(parsed.rows.length, 2);
    assert.equal(parsed.rows[0][0], '02/01/2026');
    assert.equal(String(parsed.rows[0][2]).includes('1.250'), true);
  });

  it('repassa o progresso do OCR para a interface', async () => {
    const pages = [];
    await parsePdfFile(new Uint8Array([1]), 'escaneado.pdf', fakePdfjs(1), {
      ocrEngine: fakeOcrEngine(scannedLines),
      onOcrProgress: (page, total) => pages.push(`${page}/${total}`),
    });
    assert.deepEqual(pages, ['1/1']);
  });

  it('não chama o OCR quando o PDF já tem texto utilizável', async () => {
    const engine = fakeOcrEngine(scannedLines);
    const items = [
      ['Data', 60, 700],
      ['Historico', 180, 700],
      ['Valor', 460, 700],
      ...[1, 2, 3].flatMap((index) => [
        ['05/01/2026', 60, 700 - index * 20],
        ['PIX RECEBIDO MARIA', 180, 700 - index * 20],
        ['1.000,00', 460, 700 - index * 20],
      ]),
    ];
    const pdfjs = {
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: 1,
          getPage: async () => ({
            getTextContent: async () => ({
              items: Array.from(items, ([str, x, y]) => ({
                str,
                transform: [9, 0, 0, 9, x, y],
                width: 40,
                height: 9,
              })),
            }),
            cleanup() {},
          }),
          destroy: async () => {},
        }),
      }),
    };

    const parsed = await parsePdfFile(new Uint8Array([1]), 'digital.pdf', pdfjs, {
      ocrEngine: engine,
    });
    assert.equal(engine.calls.length, 0);
    assert.equal(parsed.ocr, null);
    assert.equal(parsed.rows.length, 3);
  });

  it('explica quando nem o OCR consegue ler', async () => {
    const engine = async () => {
      throw new Error('leitor indisponível');
    };
    await assert.rejects(
      () =>
        parsePdfFile(new Uint8Array([1]), 'foto.jpg.pdf', fakePdfjs(1), {
          ocrEngine: engine,
        }),
      (error) => {
        assert.match(error.message, /OCR/);
        assert.match(error.message, /\.xlsx\/\.csv/);
        return true;
      }
    );
  });

  it('mantém a mensagem anterior quando o OCR é desligado por opção', async () => {
    const engine = fakeOcrEngine(scannedLines);
    await assert.rejects(
      () =>
        parsePdfFile(new Uint8Array([1]), 'escaneado.pdf', fakePdfjs(1), {
          ocr: false,
          ocrEngine: engine,
        }),
      /escaneado/
    );
    assert.equal(engine.calls.length, 0);
  });
});
