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
    // Nem modal: o painel do administrador é injetado pelo JS (universal, igual
    // nas duas páginas) e só existe no DOM depois que a página carrega.
    assert.equal(page.includes('modal-backdrop'), false, 'a entrega é só a página');
    assert.match(page, /id="btn-gear"/, 'as opções ficam na engrenagem');
  });

  it('o caminho de volta é só o ícone da marca (sem botão redundante)', () => {
    const topbar = page.slice(page.indexOf('class="topbar-actions"'), page.indexOf('</header>'));
    assert.equal([...topbar.matchAll(/<a\b/g)].length, 0, 'nada de link de texto no canto direito');
    assert.equal(page.includes('>Conversor</a>'), false, 'o botão "Conversor" saiu');
    assert.match(
      page,
      /class="brand-icon brand-back"\s+href="\.\/index\.html"/,
      'o ícone da marca é o caminho de volta'
    );
    assert.match(page, /aria-label="Voltar para a conciliação unificada"/, 'e continua acessível');
  });

  it('carrega as bibliotecas offline e o módulo da página como módulo', () => {
    for (const source of [
      './vendor/exceljs/exceljs.min.js',
      './vendor/jspdf/jspdf.umd.min.js',
      './vendor/jspdf/jspdf.plugin.autotable.min.js',
    ]) {
      assert.ok(page.includes(`src="${source}"`), `falta ${source}`);
    }
    assert.match(page, /src="\.\/src\/counterparty-page\.js(\?v=[\d.]+)?"/);
    assert.ok(page.includes('type="module"'));
    assert.match(page, /href="\.\/src\/styles\.css(\?v=[\d.]+)?"/);
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

  it('treina a IA com as contas preenchidas e mostra as sugestões', () => {
    for (const id of ['btn-cp-apply-suggestions', 'cp-link-memory', 'btn-gear']) {
      assert.ok(pageIds.includes(id), `falta #${id}`);
    }
    // O resumo da memória saiu da página: vive no painel do administrador.
    assert.equal(/Memória: /.test(module), false, 'nada de resumo na barra do conciliador');
    assert.match(module, /learnRowAccount/);
    assert.match(module, /data-cp-suggest/);
    assert.match(module, /function applySuggestion/);
    assert.match(module, /function applySuggestionsBatch/);
    // Toda conta aplicada precisa reforçar a memória.
    assert.match(module, /rememberAccount\(row, side, account/);
  });

  it('aplica cada campo do lote só na sua coluna, sem tocar na conta do contato', () => {
    assert.match(module, /cp-debit-account-input/);
    assert.match(module, /cp-credit-account-input/);
    assert.match(module, /setRowCellAccount\(row, side, account\)/);
    assert.equal(/applyRowAccount\(row, account\)/.test(module.split('function applyAccountBatch')[1].split('function applyCellAccount')[0]), false);
  });

  it('seleciona todos os lançamentos do filtro, não só os da página', () => {
    assert.ok(page.includes('id="cp-select-all"'));
    assert.match(page, /aria-label="Selecionar todos os lançamentos do filtro atual"/);
    assert.ok(page.includes('id="btn-cp-clear-selection"'));

    // O handler do cabeçalho percorre visibleRows(), sem recortar por página.
    const handler = module.slice(module.indexOf("dom['cp-select-all']?.addEventListener"));
    const body = handler.slice(0, handler.indexOf('});') + 3);
    assert.match(body, /visibleRows\(\)/);
    assert.equal(/slice\(/.test(body), false, 'selecionar tudo não pode ficar preso à página');
    assert.match(module, /btn-cp-clear-selection/);
  });

  it('oferece escolha de linhas por página (50, 100, 300, 1000 e todas)', () => {
    assert.ok(page.includes('id="cp-page-size"'));
    for (const value of ['50', '100', '300', '1000', 'all']) {
      assert.match(page, new RegExp(`<option value="${value}"`), `falta a opção ${value}`);
    }
    assert.match(module, /PAGE_SIZE_OPTIONS = \[50, 100, 300, 1000, 'all'\]/);
    assert.match(module, /cp-page-size/);
  });

  it('deixa as células vazias de débito e crédito editáveis na tabela', () => {
    assert.match(module, /data-cp-cell/);
    assert.match(module, /function accountCell/);
    assert.match(module, /setRowCellAccount/);
    assert.match(module, /isManualAccountCell/);
    assert.ok(page.includes('células vazias aceitam digitação'));
    assert.ok(page.includes('.cp-cell-account') === false, 'o estilo fica no CSS');
  });

  it('mostra os totais dos cartões com separador de milhar, como no conversor', () => {
    for (const id of ['cp-kpi-debit', 'cp-kpi-credit', 'cp-kpi-value']) {
      assert.match(
        module,
        new RegExp(`set\\('${id}', formatValueGroupedBr\\(`),
        `o cartão ${id} precisa do formato com milhar`
      );
    }
    assert.equal(
      /set\('cp-kpi-(?:debit|credit|value)', formatValuePlainBr/.test(module),
      false,
      'nenhum total de cartão pode ficar sem o ponto de milhar'
    );
    assert.match(
      module,
      /import \{[^}]*formatValueGroupedBr[^}]*\} from '\.\/format\.js'/,
      'o módulo precisa importar o formatador com milhar'
    );
  });

  it('mostra o estado dos modelos da nuvem no topo, sem botões de sincronizar', () => {
    assert.ok(page.includes('id="cp-cloud-state"'), 'o estado continua visível');
    // A sincronização é automática: nenhum botão de enviar/baixar no topo.
    assert.equal(page.includes('btn-cp-cloud-push'), false);
    assert.equal(page.includes('btn-cp-cloud-pull'), false);
    assert.equal(/Enviar modelos|Baixar modelos/.test(page), false);
  });
});
