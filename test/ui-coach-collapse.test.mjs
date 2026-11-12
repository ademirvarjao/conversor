/**
 * O treinador automático trabalha no fundo: a conferência continua rodando a
 * cada arquivo, mas o relatório fica dentro de um bloco recolhido. Este teste
 * garante que o painel nasce fechado e que o botão que o abre está ligado.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { REQUIRED_ELEMENT_IDS } from '../src/ui-contract.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = await readFile(path.join(ROOT, 'index.html'), 'utf8');
const app = await readFile(path.join(ROOT, 'src', 'app.js'), 'utf8');

describe('treinador automático recolhido', () => {
  it('o detalhamento nasce escondido', () => {
    const body = /<div id="coach-body" class="([^"]*)"/.exec(html);
    assert.ok(body, 'index.html não tem #coach-body');
    assert.match(body[1], /\bhidden\b/);
  });

  it('o botão de detalhes aponta para o bloco recolhido', () => {
    const button = /<button\s+id="btn-coach-toggle"[\s\S]*?>/.exec(html);
    assert.ok(button, 'index.html não tem #btn-coach-toggle');
    assert.match(button[0], /aria-controls="coach-body"/);
    assert.match(button[0], /aria-expanded="false"/);
  });

  it('a barra resumo existe e é usada pelo controlador', () => {
    assert.match(html, /id="coach-bar-text"/);
    assert.match(app, /dom\['coach-bar-text'\]/);
    assert.match(app, /dom\['btn-coach-toggle'\]\?\.addEventListener/);
  });

  it('os novos elementos entram no contrato de IDs', () => {
    for (const id of ['coach-body', 'coach-bar-text', 'btn-coach-toggle']) {
      assert.ok(REQUIRED_ELEMENT_IDS.includes(id), `${id} fora de REQUIRED_ELEMENT_IDS`);
    }
  });

  it('abre sozinho só quando há falha ou correção pendente', () => {
    assert.match(app, /const precisaAtencao =[\s\S]{0,220}?fixes\.length > 0/);
    // Avisos (duplicados, banco fora do catálogo) não abrem o painel.
    assert.ok(
      !/status !== 'ok'\)\s*;?\s*\n\s*if \(precisaAtencao\)/.test(app),
      'aviso não deve forçar a abertura do painel'
    );
  });
});
