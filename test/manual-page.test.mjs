/**
 * Manual do usuário (manual.html) — página própria do app.
 *
 * Garante que o manual existe, é servido junto com o aplicativo (sem link para
 * repositório ou site externo), que todo item do sumário aponta para uma seção
 * real e que o bloco "Sobre" mostra nome, versão, autor e ano.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { APP_VERSION } from '../src/ui-contract.js';
import {
  MANUAL_APP_NAME,
  MANUAL_AUTHOR,
  applyManualMeta,
  manualMeta,
  setupManualNav,
} from '../src/manual.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = await readFile(path.join(ROOT, 'manual.html'), 'utf8');
const htmlIds = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);

/** Menu de ajuda das duas páginas (index e conciliador). */
const gearMenu = await readFile(path.join(ROOT, 'src/gear-menu.js'), 'utf8');
const app = await readFile(path.join(ROOT, 'src/app.js'), 'utf8');
const counterpartyPage = await readFile(path.join(ROOT, 'src/counterparty-page.js'), 'utf8');

/** O deploy publica todas as páginas HTML da raiz — o manual precisa entrar. */
const deployWorkflow = await readFile(
  path.join(ROOT, '.github/workflows/deploy.yml'),
  'utf8'
);

describe('manual.html', () => {
  it('é uma página do app, com cabeçalho próprio e caminho de volta', () => {
    assert.match(html, /<html lang="pt-BR">/);
    assert.match(html, /<title>Manual do Conversor/);
    assert.match(html, /name="description"/);
    assert.match(html, /name="viewport"/);
    assert.match(html, /href="\.\/index\.html"/, 'falta o caminho de volta para o Conversor');
    assert.match(html, /href="\.\/conciliador\.html"/, 'falta o atalho para o conciliador');
    assert.ok(html.includes('class="skip-link"'), 'a página mantém o atalho de acessibilidade');
  });

  it('não depende de repositório nem de página externa', () => {
    assert.equal(/github\.com|githubusercontent|readme/i.test(html), false, 'o manual não cita o repositório');
    const externalLinks = [...html.matchAll(/<a\b[^>]*href="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((href) => /^https?:|^\/\//i.test(href));
    assert.deepEqual(externalLinks, [], 'nenhum link externo no manual');
    assert.equal(
      /github\.com\/ademirvarjao\/conversor#readme/.test(app + counterpartyPage),
      false,
      'as páginas não abrem mais o README do repositório'
    );
    assert.match(app, /window\.open\('\.\/manual\.html'/);
    assert.match(counterpartyPage, /window\.open\('\.\/manual\.html'/);
  });

  it('o menu da engrenagem aponta para o manual e para o Sobre', () => {
    assert.match(gearMenu, /id: 'docs'[\s\S]{0,120}Manual completo/);
    assert.match(gearMenu, /id: 'about'[\s\S]{0,120}Sobre/);
    assert.equal(/Manual e limitações no repositório/.test(gearMenu), false);
    assert.match(app, /case 'about':[\s\S]{0,120}manual\.html#sobre/);
    assert.match(counterpartyPage, /id === 'about'[\s\S]{0,80}manual\.html#sobre/);
  });

  it('todo item do sumário leva a uma seção que existe', () => {
    const links = [...html.matchAll(/class="manual-nav"[\s\S]*?<\/nav>/g)].join('');
    const targets = [...links.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
    assert.ok(targets.length >= 10, 'o sumário cobre o manual inteiro');
    for (const target of targets) {
      assert.ok(htmlIds.includes(target), `o sumário aponta para #${target}, que não existe`);
    }
    for (const target of targets) {
      assert.match(html, new RegExp(`<section id="${target}"`), `#${target} precisa ser uma seção`);
    }
  });

  it('cobre importação, OCR, IA, conciliador, nuvem, LLM, painel e limitações', () => {
    for (const snippet of [
      /Importar arquivos/,
      /PDF escaneado \(OCR\)/,
      /IA de layouts/,
      /Conciliação de clientes e fornecedores/,
      /Memória da IA e nuvem/,
      /Conector LLM/,
      /Painel do administrador/,
      /Limitações conhecidas/,
      /Solução de problemas/,
    ]) {
      assert.match(html, snippet);
    }
    assert.match(html, /200 dpi/, 'o manual explica a resolução que o OCR precisa');
  });

  it('vai para o ar junto com o app (o deploy copia as páginas HTML da raiz)', () => {
    assert.match(deployWorkflow, /cp -R \.\/\*\.html/, 'o workflow precisa publicar os .html da raiz');
    assert.ok(html.includes('href="./src/styles.css'), 'o manual usa o CSS publicado');
  });

  it('o Sobre mostra nome do app, versão, autor e ano', () => {
    const sobre = html.slice(html.indexOf('id="sobre"'), html.indexOf('</main>'));
    assert.ok(sobre.includes('Conversor — Conciliação Financeira'), 'falta o nome do app');
    assert.ok(sobre.includes('Ademir Varjão'), 'falta o autor');
    assert.ok(sobre.includes('id="manual-version"'), 'falta o campo da versão');
    assert.ok(sobre.includes('id="manual-year"'), 'falta o campo do ano');
    assert.match(sobre, /Versão/);
    assert.match(sobre, /Ano:/);
    assert.match(sobre, /© \d{4} Ademir Varjão/, 'falta o crédito de copyright');
  });

  it('versão do CSS, do módulo e do rodapé acompanham o app', () => {
    assert.match(html, new RegExp(`href="\\./src/styles\\.css\\?v=${APP_VERSION.replace(/\./g, '\\.')}"`));
    assert.match(html, new RegExp(`src="\\./src/manual\\.js\\?v=${APP_VERSION.replace(/\./g, '\\.')}"`));
    assert.match(html, new RegExp(`id="app-version"[^>]*>v${APP_VERSION.replace(/\./g, '\\.')}<`));
    assert.match(html, new RegExp(`id="manual-version"[^>]*>v${APP_VERSION.replace(/\./g, '\\.')}<`));
  });
});

/* -------------------------------------------------------------------------- */
/*                      Dados do "Sobre" e sumário ativo                      */
/* -------------------------------------------------------------------------- */

describe('manualMeta', () => {
  it('devolve nome, versão do app, autor e ano', () => {
    const meta = manualMeta(new Date('2026-11-13T12:00:00Z'));
    assert.equal(meta.name, MANUAL_APP_NAME);
    assert.equal(meta.version, APP_VERSION);
    assert.equal(meta.author, MANUAL_AUTHOR);
    assert.equal(meta.year, 2026);
    assert.match(meta.copyright, /© 2026 Ademir Varjão/);
  });
});

describe('applyManualMeta', () => {
  const fakeDoc = () => {
    const elements = new Map(
      ['manual-version', 'app-version', 'manual-year', 'manual-copyright'].map((id) => [
        id,
        { id, textContent: '' },
      ])
    );
    return { getElementById: (id) => elements.get(id) || null, elements };
  };

  it('escreve versão, ano e crédito no documento', () => {
    const doc = fakeDoc();
    const meta = applyManualMeta(doc, new Date('2027-03-01T00:00:00Z'));

    assert.equal(doc.elements.get('manual-version').textContent, `v${APP_VERSION}`);
    assert.equal(doc.elements.get('app-version').textContent, `v${APP_VERSION}`);
    assert.equal(doc.elements.get('manual-year').textContent, '2027');
    assert.equal(doc.elements.get('manual-copyright').textContent, meta.copyright);
    assert.match(doc.elements.get('manual-copyright').textContent, /2027/);
  });

  it('não quebra quando a página não tem os elementos', () => {
    assert.doesNotThrow(() => applyManualMeta({ getElementById: () => null }));
    assert.doesNotThrow(() => applyManualMeta(null));
  });
});

describe('setupManualNav', () => {
  const fakeLink = (href) => {
    const classes = new Set();
    const attributes = new Map([['href', href]]);
    return {
      classes,
      attributes,
      getAttribute: (name) => attributes.get(name) ?? null,
      setAttribute: (name, value) => attributes.set(name, value),
      removeAttribute: (name) => attributes.delete(name),
      classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) },
    };
  };

  const fakeObserver = () => {
    const calls = [];
    class Observer {
      constructor(callback) {
        this.callback = callback;
        calls.push(this);
      }
      observe() {}
      disconnect() {
        this.disconnected = true;
      }
    }
    return { Observer, calls };
  };

  const fakeDoc = () => {
    const links = [fakeLink('#importar'), fakeLink('#sobre')];
    const sections = [{ id: 'importar' }, { id: 'sobre' }];
    return {
      querySelectorAll: (selector) =>
        selector === '.manual-nav a[href^="#"]' ? links : sections,
      links,
    };
  };

  it('marca no sumário a seção que está na tela', () => {
    const doc = fakeDoc();
    const { Observer, calls } = fakeObserver();
    setupManualNav(doc, {}, Observer);

    assert.equal(calls.length, 1, 'cria um observador');
    calls[0].callback([
      { isIntersecting: true, intersectionRatio: 0.8, target: { id: 'sobre' } },
      { isIntersecting: false, intersectionRatio: 0, target: { id: 'importar' } },
    ]);

    assert.equal(doc.links[1].classes.has('is-current'), true);
    assert.equal(doc.links[1].attributes.get('aria-current'), 'true');
    assert.equal(doc.links[0].classes.has('is-current'), false);
    assert.equal(doc.links[0].attributes.has('aria-current'), false);
  });

  it('sem IntersectionObserver ainda marca a seção ao clicar', () => {
    const doc = fakeDoc();
    const handlers = [];
    for (const link of doc.links) {
      link.addEventListener = (_event, handler) => handlers.push(handler);
      link.getAttribute = (name) => (name === 'href' ? link.attributes.get('href') : null);
    }

    setupManualNav(doc, {}, undefined);
    handlers[0]();
    assert.equal(doc.links[0].classes.has('is-current'), true);
  });
});
