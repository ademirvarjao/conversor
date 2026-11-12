import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { escapeHtml, esc } from '../src/html.js';

const SRC_DIR = path.join(import.meta.dirname, '..', 'src');

describe('escapeHtml', () => {
  it('escapa os cinco caracteres perigosos, inclusive dentro de atributos', () => {
    assert.equal(escapeHtml('<b>"x" & \'y\'</b>'), '&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;');
    assert.equal(
      escapeHtml('<img src=x onerror="alert(1)">'),
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'
    );
  });

  it('não escapa duas vezes o que já veio escapado de forma errada', () => {
    // O & precisa ser o primeiro: `&` de `&lt;` não pode virar `&amp;lt;` duas vezes.
    assert.equal(escapeHtml('&lt;'), '&amp;lt;');
  });

  it('trata nulo, indefinido e tipos não textuais', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(0), '0');
    assert.equal(escapeHtml(-12.5), '-12.5');
    assert.equal(escapeHtml(false), 'false');
  });

  it('mantém acentos e símbolos do dia a dia', () => {
    assert.equal(escapeHtml('Histórico • R$ 1.234,56'), 'Histórico • R$ 1.234,56');
  });

  it('esc é o mesmo atalho de escapeHtml', () => {
    assert.equal(esc, escapeHtml);
  });
});

describe('fonte única de escape', () => {
  it('nenhum módulo define a sua própria função de escape', () => {
    const offenders = [];
    for (const file of fs.readdirSync(SRC_DIR).filter((name) => name.endsWith('.js'))) {
      if (file === 'html.js') continue;
      const source = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
      if (/function\s+(escapeHtml|esc)\s*\(/.test(source)) offenders.push(file);
    }
    assert.deepEqual(offenders, [], `módulos com escape próprio: ${offenders.join(', ')}`);
  });

  it('quem monta HTML importa o escape compartilhado', () => {
    for (const file of ['app.js', 'counterparty-page.js', 'training-coach.js']) {
      const source = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
      assert.match(source, /from '\.\/html\.js'/, `${file} deveria importar src/html.js`);
    }
  });
});
