/**
 * Contrato da página do conciliador (`conciliador.html`): ela precisa existir,
 * carregar as bibliotecas offline, ter os controles que o módulo procura e
 * oferecer o caminho de volta para a conciliação unificada.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const page = await readFile(path.join(ROOT, 'conciliador.html'), 'utf8');
const module = await readFile(path.join(ROOT, 'src/counterparty-page.js'), 'utf8');
const pageIds = [...page.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);

describe('página do conciliador', () => {
  it('é uma página própria, aberta pelo ícone da marca', () => {
    assert.match(page, /<title>[^<]*Conciliador/i);
    assert.match(page, /<a[^>]+href="\.\/index\.html"/, 'falta o caminho de volta');
    assert.equal(page.includes('cp-drawer'), false, 'a página não usa a barra lateral');
    assert.equal(page.includes('modal-backdrop'), false, 'a página não usa modal');
  });

  it('carrega as bibliotecas offline e o módulo da página como módulo', () => {
    for (const source of [
      './vendor/exceljs/exceljs.min.js',
      './vendor/jspdf/jspdf.umd.min.js',
      './vendor/jspdf/jspdf.plugin.autotable.min.js',
    ]) {
      assert.ok(page.includes(`src="${source}"`), `falta ${source}`);
    }
    assert.ok(page.includes('src="./src/counterparty-page.js"'));
    assert.ok(page.includes('type="module"'));
    assert.ok(page.includes('href="./src/styles.css"'));
  });

  it('tem os controles que o módulo procura', () => {
    const used = [...module.matchAll(/dom\['([^']+)'\]/g)].map((match) => match[1]);
    const missing = [...new Set(used)].filter((id) => !pageIds.includes(id));
    assert.deepEqual(missing, [], `IDs usados pelo módulo e ausentes na página: ${missing.join(', ')}`);

    for (const id of ['cp-contacts-input', 'cp-ledger-input', 'btn-cp-run', 'cp-tbody', 'cp-link-panel']) {
      assert.ok(pageIds.includes(id), `falta #${id}`);
    }
  });

  it('mantém o layout de cinco colunas e os três formatos de exportação', () => {
    for (const column of ['data', 'debito', 'credito', 'valor', 'historico']) {
      assert.ok(page.includes(`>${column}<`), `falta a coluna ${column}`);
    }
    for (const id of ['btn-cp-export-xlsx', 'btn-cp-export-pdf', 'btn-cp-export-csv']) {
      assert.ok(page.includes(`id="${id}"`), `falta #${id}`);
    }
  });

  it('aceita mais de um arquivo em cada campo', () => {
    for (const id of ['cp-contacts-input', 'cp-ledger-input']) {
      const tag = page.slice(page.indexOf(`id="${id}"`));
      const input = tag.slice(0, tag.indexOf('>') + 1);
      assert.match(input, /\bmultiple\b/, `#${id} precisa aceitar vários arquivos`);
      assert.match(input, /accept="\.pdf,\.xlsx"/, `#${id} precisa aceitar PDF e XLSX`);
    }
  });

  it('permite informar a conta de contrapartida em lote e por lançamento', () => {
    // em lote: um campo para os débitos vazios, outro para os créditos vazios
    assert.ok(page.includes('id="cp-debit-account-input"'));
    assert.ok(page.includes('id="cp-credit-account-input"'));
    assert.ok(page.includes('Débitos vazios'));
    assert.ok(page.includes('Créditos vazios'));
    assert.equal(page.includes('id="cp-account-input"'), false, 'o campo único foi separado em dois');
    assert.ok(page.includes('id="btn-cp-account-apply"'));
    for (const scope of ['selected', 'filtered', 'empty']) {
      assert.ok(page.includes(`value="${scope}"`), `falta o escopo ${scope}`);
    }
    assert.ok(page.includes('id="cp-selected-count"'));

    // por lançamento: campo dentro do painel de vínculo
    assert.ok(page.includes('id="cp-link-account-input"'));
    assert.ok(page.includes('id="btn-cp-link-account"'));

    // seleção na tabela: cabeçalho no HTML, caixas geradas pelo controlador
    assert.ok(page.includes('id="cp-select-all"'));
    assert.match(module, /data-cp-select/);
    assert.match(module, /data-cp-link/);
  });

  it('descreve o escopo do lote pela contrapartida, não pela conta do contato', () => {
    assert.ok(page.includes('só os sem contrapartida'));
    assert.ok(!page.includes('só os sem conta'));
    assert.match(module, /scope === 'empty'[\s\S]{0,120}counterpartAccount/);
  });

  it('aplica cada campo do lote só na sua coluna, sem tocar na conta do contato', () => {
    assert.match(module, /cp-debit-account-input/);
    assert.match(module, /cp-credit-account-input/);
    assert.match(module, /setRowCellAccount\(row, side, account\)/);
    assert.equal(/applyRowAccount\(row, account\)/.test(module.split('function applyAccountBatch')[1].split('function applyCellAccount')[0]), false);
  });

  it('deixa as células vazias de débito e crédito editáveis na tabela', () => {
    assert.match(module, /data-cp-cell/);
    assert.match(module, /function accountCell/);
    assert.match(module, /setRowCellAccount/);
    assert.match(module, /isManualAccountCell/);
    assert.ok(page.includes('células vazias aceitam digitação'));
    assert.ok(page.includes('.cp-cell-account') === false, 'o estilo fica no CSS');
  });

  it('mostra o estado dos modelos da nuvem no topo', () => {
    assert.ok(page.includes('id="cp-cloud-state"'));
    assert.ok(page.includes('id="btn-cp-cloud-push"'));
    assert.ok(page.includes('id="btn-cp-cloud-pull"'));
  });
});
