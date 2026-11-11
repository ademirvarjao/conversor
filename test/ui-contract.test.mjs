/**
 * Testes de contrato estático (sem navegador):
 *  - todo ID usado pelo controlador existe no index.html;
 *  - não há IDs duplicados;
 *  - os scripts vendorizados e os módulos referenciados existem;
 *  - a versão do package.json combina com a exibida na interface.
 */

import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { APP_VERSION, REQUIRED_ELEMENT_IDS } from '../src/ui-contract.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const html = await readFile(path.join(ROOT, 'index.html'), 'utf8');
const htmlIds = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);

describe('index.html x controlador', () => {
  it('contém todos os elementos exigidos pelo app', () => {
    const missing = REQUIRED_ELEMENT_IDS.filter((id) => !htmlIds.includes(id));
    assert.deepEqual(missing, [], `IDs ausentes no HTML: ${missing.join(', ')}`);
  });

  it('não possui IDs duplicados', () => {
    const duplicates = htmlIds.filter((id, index) => htmlIds.indexOf(id) !== index);
    assert.deepEqual([...new Set(duplicates)], []);
  });

  it('carrega as bibliotecas e o módulo principal', () => {
    for (const source of [
      './vendor/exceljs/exceljs.min.js',
      './vendor/jspdf/jspdf.umd.min.js',
      './vendor/jspdf/jspdf.plugin.autotable.min.js',
      './src/app.js',
    ]) {
      assert.ok(html.includes(`src="${source}"`), `index.html não referencia ${source}`);
    }
    assert.ok(html.includes('type="module"'), 'app.js precisa ser carregado como módulo');
  });

  it('usa o título curto do produto', () => {
    assert.match(html, /<title>Conversor — Conciliação Financeira<\/title>/);
  });

  it('não usa o nome antigo do produto em nenhum arquivo-fonte', async () => {
    const names = [...(await readdir(path.join(ROOT, 'src'))), ...(await readdir(path.join(ROOT, 'test')))];
    const files = [
      'index.html',
      'README.md',
      'package.json',
      ...names.filter((name) => /\.(m?js|css|json|md)$/.test(name)).flatMap((name) => [
        path.join('src', name),
        path.join('test', name),
      ]),
    ];

    const offenders = [];
    for (const relative of files) {
      let content;
      try {
        content = await readFile(path.join(ROOT, relative), 'utf8');
      } catch {
        continue; // arquivo do caminho cruzado (src/ vs test/) não existe
      }
      if (/cust[óo]dio/i.test(content)) offenders.push(relative);
    }

    assert.deepEqual(offenders, [], `arquivos com o nome antigo: ${offenders.join(', ')}`);
  });

  it('declara idioma, viewport e descrição', () => {
    assert.match(html, /<html lang="pt-BR">/);
    assert.match(html, /name="viewport"/);
    assert.match(html, /name="description"/);
  });
});

describe('uso do DOM pelo controlador', () => {
  it('acessa apenas IDs declarados no contrato', async () => {
    const appSource = await readFile(path.join(ROOT, 'src', 'app.js'), 'utf8');
    const accessed = [...appSource.matchAll(/dom\['([^']+)'\]/g)].map((match) => match[1]);
    const unknown = [...new Set(accessed)].filter((id) => !REQUIRED_ELEMENT_IDS.includes(id));
    assert.deepEqual(unknown, [], `IDs usados mas não declarados: ${unknown.join(', ')}`);
  });
});

describe('arquivos referenciados', () => {
  it('existe cada arquivo vendorizado do HTML', async () => {
    const sources = [...html.matchAll(/src="\.\/([^"]+)"/g)].map((match) => match[1]);
    for (const source of sources) {
      const info = await stat(path.join(ROOT, source));
      assert.ok(info.isFile(), `${source} não existe`);
    }
  });

  it('existe o worker e os assets do PDF.js usados pelo app', async () => {
    const appSource = await readFile(path.join(ROOT, 'src', 'app.js'), 'utf8');
    const workerPath = appSource.match(/workerSrc\s*=\s*'\.\/([^']+)'/)?.[1];
    assert.ok(workerPath, 'workerSrc não encontrado em app.js');
    assert.ok((await stat(path.join(ROOT, workerPath))).isFile());

    const parsersSource = await readFile(path.join(ROOT, 'src', 'parsers.js'), 'utf8');
    const cmapDir = parsersSource.match(/cMapUrl\s*=\s*'\.\/([^']+)'/)?.[1];
    assert.ok(cmapDir, 'cMapUrl não encontrado em parsers.js');
    assert.ok((await stat(path.join(ROOT, cmapDir))).isDirectory());
  });

  it('mantém a versão do package.json, do HTML e do contrato sincronizadas', async () => {
    const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.version, APP_VERSION);

    const footerVersion = html.match(/id="app-version"[^>]*>v([\d.]+)</)?.[1];
    assert.equal(footerVersion, APP_VERSION);
  });

  it('não depende de nenhum recurso externo (funciona offline)', () => {
    assert.doesNotMatch(html, /<script[^>]+src="https?:/i);
    assert.doesNotMatch(html, /<link[^>]+href="https?:/i);
    assert.doesNotMatch(html, /@import\s+url\(['"]?https?:/i);
  });
});
