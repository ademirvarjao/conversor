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
const conciliador = await readFile(path.join(ROOT, 'conciliador.html'), 'utf8');
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
      // A URL do módulo pode ir com a versão (`?v=1.2.3`) para furar o cache.
      assert.ok(
        html.includes(`src="${source}"`) || html.includes(`src="${source}?v=`),
        `index.html não referencia ${source}`
      );
    }
    assert.ok(html.includes('type="module"'), 'app.js precisa ser carregado como módulo');
  });

  it('permite colar a chave de outro computador na barra superior', () => {
    const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    assert.ok(header.includes('id="cloud-key-top-input"'), 'falta o campo para colar a chave');
    assert.ok(header.includes('id="btn-cloud-key-use"'), 'falta o botão que usa a chave colada');
    assert.match(header, /Colar chave/i);
  });

  it('oferece seleção, exclusão e linhas por página na planilha consolidada', () => {
    for (const id of [
      'preview-select-all',
      'preview-page-size',
      'btn-delete-selected',
      'btn-restore-deleted',
      'btn-clear-preview-selection',
    ]) {
      assert.ok(htmlIds.includes(id), `falta #${id}`);
    }
    for (const value of ['50', '100', '300', '1000', 'all']) {
      assert.match(html, new RegExp(`<option value="${value}"`), `falta a opção ${value} em #preview-page-size`);
    }
    assert.ok(html.includes('col-hist'), 'falta a coluna de histórico');
    assert.ok(html.includes('class="col-actions"'), 'falta a coluna de ações (excluir linha)');
  });

  it('leva para a página do conciliador pelo ícone da marca', () => {
    const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    assert.match(
      header,
      /<a[^>]+href="\.\/conciliador\.html"/,
      'o ícone da marca precisa levar para conciliador.html'
    );
    assert.ok(header.includes('brand-back'), 'o ícone precisa da classe de atalho');
    assert.ok(header.includes('Conciliar clientes/fornecedores'), 'falta o rótulo acessível do atalho');

    // A conciliação não é mais um modal/drawer dentro da página principal.
    assert.equal(html.includes('cp-modal'), false, 'o painel embutido saiu do index.html');
    assert.equal(html.includes('action-tile'), false, 'o cartão antigo saiu do topo da página');
  });

  it('não expõe mais o botão de exemplo simulado', async () => {
    const app = await readFile(path.join(ROOT, 'src/app.js'), 'utf8');
    assert.equal(html.includes('btn-demo'), false, 'o botão de demonstração saiu do HTML');
    assert.equal(app.includes('btn-demo'), false, 'o controlador não deve ligar eventos do botão removido');
    assert.equal(app.includes('runDemo'), false, 'a função de demonstração foi removida');
  });

  it('mostra a chave de acesso na barra superior, com aviso de uso em outro computador', () => {
    const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    assert.ok(header.includes('id="btn-cloud-key"'), 'a chave deve ficar visível no topo');
    assert.ok(header.includes('id="cloud-key-code"'), 'o código da chave aparece no topo');
    assert.match(header, /outro computador/i, 'o aviso precisa citar o uso em outro computador');
  });

  it('oferece provedores de LLM com plano gratuito e campo de modelo', () => {
    const select = html.slice(html.indexOf('id="llm-provider"'), html.indexOf('</select>', html.indexOf('id="llm-provider"')));
    for (const provider of ['none', 'groq', 'openrouter', 'gemini', 'openai']) {
      assert.match(select, new RegExp(`value="${provider}"`), `falta a opção ${provider}`);
    }
    assert.match(select, /Groq/);
    assert.match(select, /OpenRouter/);
    assert.match(select, /grátis/i);
    assert.equal(select.includes('gemini-2.0-flash'), false, 'Gemini 2.0 foi descontinuado');
    assert.ok(html.includes('id="llm-model"'), 'falta o campo de modelo (opcional)');
    assert.ok(html.includes('id="llm-hint"'), 'falta a dica do provedor');
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
    const sources = [...html.matchAll(/src="\.\/([^"]+)"/g)]
      .map((match) => match[1])
      .map((source) => source.split('?')[0]); // `?v=` é cache busting, não faz parte do arquivo
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

    // O CSS e o módulo de entrada vão com a versão na URL: sem isso o navegador
    // pode servir a folha antiga por até 10 min depois do deploy (foi o que fez
    // a correção de layout parecer que não tinha entrado).
    for (const page of [html, conciliador]) {
      const assets = [
        page.match(/href="\.\/src\/styles\.css\?v=([\d.]+)"/)?.[1],
        page.match(/src="\.\/src\/(?:app|counterparty-page)\.js\?v=([\d.]+)"/)?.[1],
      ];
      assert.deepEqual(assets, [APP_VERSION, APP_VERSION], 'as URLs de CSS/JS precisam da versão atual');
    }
  });

  it('não depende de nenhum recurso externo (funciona offline)', () => {
    assert.doesNotMatch(html, /<script[^>]+src="https?:/i);
    assert.doesNotMatch(html, /<link[^>]+href="https?:/i);
    assert.doesNotMatch(html, /@import\s+url\(['"]?https?:/i);
  });
});

describe('publicação no GitHub Pages', () => {
  it('publica o catálogo de layouts (mesma origem do app)', async () => {
    const workflow = await readFile(path.join(ROOT, '.github/workflows/deploy.yml'), 'utf8');
    const copia = /cp[^\n]*\blayouts\b/.test(workflow);
    assert.ok(copia, 'o deploy precisa copiar layouts/ para o site');

    const catalogo = await readFile(path.join(ROOT, 'layouts/comunidade.json'), 'utf8');
    assert.ok(JSON.parse(catalogo).layouts.length > 0, 'o catálogo publicado não pode ir vazio');
  });

  it('copia todas as páginas HTML da raiz para o site', async () => {
    const workflow = await readFile(path.join(ROOT, '.github/workflows/deploy.yml'), 'utf8');
    const htmlFiles = (await readdir(ROOT)).filter((name) => name.endsWith('.html'));

    assert.ok(htmlFiles.includes('index.html'), 'a página principal precisa existir');
    assert.ok(htmlFiles.includes('conciliador.html'), 'a página do conciliador precisa existir');

    for (const file of htmlFiles) {
      const explicit = new RegExp(`cp[^\\n]*\\b${file.replace('.', '\\.')}\\b`).test(workflow);
      const wildcard = /cp[^\n]*\.\/\*\.html/.test(workflow);
      assert.ok(explicit || wildcard, `o deploy não publica ${file}`);
    }
  });
});
