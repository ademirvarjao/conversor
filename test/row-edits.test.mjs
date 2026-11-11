/**
 * Edições manuais da planilha consolidada: histórico digitado e linhas
 * excluídas. As edições ficam por chave de origem (arquivo + linha) e são
 * reaplicadas a cada reconstrução do resultado.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyRowEdits, recordKey, setHistoryOverride } from '../src/row-edits.js';

const record = (row, { file = 'extrato.pdf', history = `Histórico ${row}`, value = -10 } = {}) => ({
  sourceFile: file,
  sourceRow: row,
  dateIso: '2026-10-01',
  dateBr: '01/10/2026',
  history,
  value,
});

const newState = () => ({ historyOverrides: new Map(), removedKeys: new Set() });

describe('edição manual das linhas da planilha consolidada', () => {
  it('usa arquivo + linha como chave estável', () => {
    assert.equal(recordKey(record(3)), 'extrato.pdf#3');
    assert.equal(recordKey({ sourceFile: 'a.xlsx' }), 'a.xlsx#0');
    assert.equal(recordKey(null), '');
  });

  it('aplica o histórico digitado sem tocar nas outras linhas', () => {
    const state = newState();
    setHistoryOverride(state, record(2), '  Pagamento   fornecedor  X ');

    const { rows: applied, edited } = applyRowEdits([record(1), record(2)], state);
    assert.equal(edited, 1);
    assert.equal(applied[1].history, 'Pagamento fornecedor X', 'espaços extras são normalizados');
    assert.equal(applied[0].history, 'Histórico 1');
  });

  it('regera o resultado e mantém a edição (o histórico do arquivo volta ao original)', () => {
    const state = newState();
    const first = record(1);
    setHistoryOverride(state, first, 'Texto corrigido');

    // Nova extração do arquivo: o registro vem "cru" e a edição é reaplicada.
    const again = applyRowEdits([record(1)], state);
    assert.equal(again.rows[0].history, 'Texto corrigido');
    assert.equal(again.rows[0].originalHistory, 'Histórico 1');
  });

  it('texto vazio desfaz a edição e devolve o histórico do arquivo', () => {
    const state = newState();
    const row = record(1);
    setHistoryOverride(state, row, 'Corrigido');
    assert.equal(state.historyOverrides.size, 1);

    const changed = setHistoryOverride(state, row, '   ');
    assert.equal(changed, false);
    assert.equal(state.historyOverrides.size, 0);
    assert.equal(row.history, 'Histórico 1');
  });

  it('digitar exatamente o texto original não cria edição', () => {
    const state = newState();
    const row = record(2);
    setHistoryOverride(state, row, 'Histórico 2');
    assert.equal(state.historyOverrides.size, 0);
  });

  it('exclui as linhas marcadas e devolve a contagem', () => {
    const state = newState();
    const rows = [record(1), record(2), record(3)];
    state.removedKeys.add(recordKey(rows[1]));

    const result = applyRowEdits(rows, state);
    assert.equal(result.rows.length, 2);
    assert.equal(result.removed, 1);
    assert.deepEqual(
      result.rows.map((item) => item.sourceRow),
      [1, 3]
    );
  });

  it('restaurar é só limpar a lista de excluídas', () => {
    const state = newState();
    const rows = [record(1), record(2)];
    state.removedKeys.add(recordKey(rows[0]));
    assert.equal(applyRowEdits(rows, state).rows.length, 1);

    state.removedKeys.clear();
    assert.equal(applyRowEdits(rows, state).rows.length, 2);
    assert.equal(applyRowEdits(rows, state).removed, 0);
  });

  it('edição e exclusão convivem: excluir não perde o histórico digitado', () => {
    const state = newState();
    const rows = [record(1), record(2)];
    setHistoryOverride(state, rows[0], 'Editado');
    state.removedKeys.add(recordKey(rows[0]));

    const result = applyRowEdits(rows, state);
    assert.equal(result.removed, 1);
    assert.equal(result.rows[0].sourceRow, 2);

    state.removedKeys.clear();
    const restored = applyRowEdits([record(1), record(2)], state);
    assert.equal(restored.rows[0].history, 'Editado');
  });
});
