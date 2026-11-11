import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { defaultRecordKey, describeExportScope, resolveExportRows } from '../src/export-scope.js';

const row = (dateIso, value, history, sourceRow) => ({
  dateIso,
  dateBr: dateIso.split('-').reverse().join('/'),
  value,
  history,
  sourceFile: 'extrato.pdf',
  sourceRow,
});

const allRows = [
  row('2026-10-01', 100, 'PIX A', 1),
  row('2026-10-02', -50, 'PIX B', 2),
  row('2026-10-03', 25, 'PIX C', 3),
];
const filteredRows = [allRows[1], allRows[2]];

describe('escopo da exportação', () => {
  it('sem seleção exporta tudo', () => {
    const result = resolveExportRows({ allRows, filteredRows, selected: [] });
    assert.equal(result.scope, 'all');
    assert.deepEqual(result.rows, allRows);
  });

  it('sem seleção e com “somente filtrado” exporta o filtro', () => {
    const result = resolveExportRows({ allRows, filteredRows, selected: [], onlyFiltered: true });
    assert.equal(result.scope, 'filtered');
    assert.deepEqual(result.rows, filteredRows);
  });

  it('com seleção exporta só o que está marcado, na ordem da planilha', () => {
    const selected = [defaultRecordKey(allRows[2]), defaultRecordKey(allRows[0])];
    const result = resolveExportRows({ allRows, filteredRows, selected, onlyFiltered: true });

    assert.equal(result.scope, 'selection');
    assert.deepEqual(
      result.rows.map((item) => item.history),
      ['PIX A', 'PIX C']
    );
  });

  it('a seleção ganha do filtro (inclui linha fora do filtro atual)', () => {
    const selected = new Set([defaultRecordKey(allRows[0])]);
    const result = resolveExportRows({ allRows, filteredRows, selected, onlyFiltered: true });

    assert.equal(result.scope, 'selection');
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].history, 'PIX A');
  });

  it('seleção obsoleta (linha excluída) volta para tudo em vez de exportar vazio', () => {
    const result = resolveExportRows({
      allRows,
      filteredRows,
      selected: ['chave-que-nao-existe'],
    });
    assert.equal(result.scope, 'all');
    assert.equal(result.rows.length, 3);
  });

  it('lista vazia não quebra', () => {
    const result = resolveExportRows({});
    assert.deepEqual(result.rows, []);
    assert.equal(result.scope, 'all');
  });

  it('descreve o escopo para o usuário', () => {
    assert.match(
      describeExportScope({ scope: 'selection', count: 2, selectedCount: 2, totalCount: 10 }),
      /Exportando os 2 selecionados \(de 10\)/
    );
    assert.match(
      describeExportScope({ scope: 'filtered', count: 4, totalCount: 10 }),
      /exporta o resultado filtrado \(4 de 10\)/
    );
    assert.match(describeExportScope({ scope: 'all', count: 10, totalCount: 10 }), /exporta todos os 10/);
  });
});
