import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { analyzeFileLayout, loadAiMemory, normalizeMemory, transformRowsWithConfig } from '../src/ai-engine.js';
import { buildTableFromTextLines } from '../src/parsers.js';
import { SEED_LOG_LAYOUTS } from './helpers/seed-fixtures.mjs';
import { SEED_PROFILES } from '../src/seed-profiles.js';

/**
 * Geometria real dos dois extratos, com valores fictícios.
 *
 * Os layouts abaixo reproduzem o que o PDF.js entrega para:
 *  - extrato do Itaú (conta PJ): bloco de 3 linhas, data no MEIO;
 *  - extrato do Bradesco: data só na primeira linha do dia, descrição quebrada
 *    em duas linhas (acima e abaixo dos valores), colunas Crédito/Débito
 *    separadas e valores alinhados à direita.
 */

const asPdfFile = (table, fileName) => ({ ...table, fileName, fileType: 'pdf' });

describe('layouts de fábrica (treinados com extratos reais)', () => {
  it('existem dois perfis embutidos, com papéis coerentes', () => {
    assert.equal(SEED_PROFILES.length, 2);

    const itau = SEED_PROFILES.find((profile) => profile.id === 'seed-extrato-itau');
    const bradesco = SEED_PROFILES.find((profile) => profile.id === 'seed-extrato-bradesco');
    assert.ok(itau && bradesco);

    const roleOf = (profile, header) =>
      profile.mappings.find((mapping) => mapping.header === header)?.role;

    assert.deepEqual(itau.headers, ['Data', 'Lançamentos', 'Razão Social', 'CNPJ/CPF', 'Valor (R$)', 'Saldo (R$)']);
    assert.equal(roleOf(itau, 'Data'), 'date');
    assert.equal(roleOf(itau, 'Valor (R$)'), 'value_auto');
    assert.equal(roleOf(itau, 'Saldo (R$)'), 'ignore');

    assert.deepEqual(bradesco.headers, ['Data', 'Lançamento', 'Dcto.', 'Crédito (R$)', 'Débito (R$)', 'Saldo (R$)']);
    assert.equal(roleOf(bradesco, 'Data'), 'date');
    assert.equal(roleOf(bradesco, 'Crédito (R$)'), 'value_in');
    assert.equal(roleOf(bradesco, 'Débito (R$)'), 'value_out');
    assert.equal(roleOf(bradesco, 'Dcto.'), 'ignore');
    assert.equal(roleOf(bradesco, 'Saldo (R$)'), 'ignore');
  });

  it('todo perfil de fábrica chega à memória de um usuário novo', () => {
    const memory = loadAiMemory();
    const seeds = memory.learnedProfiles.filter((profile) => profile.builtIn).map((profile) => profile.id);
    assert.deepEqual(seeds.sort(), ['seed-extrato-bradesco', 'seed-extrato-itau']);

    // Importar um backup antigo não pode duplicar nem apagar os de fábrica.
    const imported = normalizeMemory({ learnedProfiles: memory.learnedProfiles });
    assert.equal(imported.learnedProfiles.filter((profile) => profile.builtIn).length, 2);
  });

  it('reconhece o extrato do Bradesco na primeira importação', () => {
    const parsed = buildTableFromTextLines(SEED_LOG_LAYOUTS.bradesco);

    assert.deepEqual(parsed.headers, [
      'Data',
      'Lançamento',
      'Dcto.',
      'Crédito (R$)',
      'Débito (R$)',
      'Saldo (R$)',
    ]);

    const analysis = analyzeFileLayout(asPdfFile(parsed, 'extrato-bradesco.pdf'), loadAiMemory());
    assert.equal(analysis.matchedProfileId, 'seed-extrato-bradesco');
    assert.equal(analysis.status, 'matched');

    const roles = Object.fromEntries(analysis.mappings.map((mapping) => [mapping.header, mapping.role]));
    assert.equal(roles.Data, 'date');
    assert.equal(roles['Crédito (R$)'], 'value_in');
    assert.equal(roles['Débito (R$)'], 'value_out');
    assert.equal(roles['Dcto.'], 'ignore');

    const { records } = transformRowsWithConfig(parsed, analysis);
    // 5 lançamentos — saldo anterior e linha de total ficam fora.
    assert.equal(records.length, 5);
    assert.deepEqual(
      records.map((record) => record.value),
      [120, 30, -45.9, 22.08, 335.56]
    );
    assert.deepEqual(
      records.map((record) => record.dateBr),
      ['05/10/2026', '05/10/2026', '08/10/2026', '08/10/2026', '09/10/2026']
    );
    // Lançamento sem data: herda o dia anterior, inclusive na virada de página.
    assert.match(records[1].history, /TICKET SERVICOS S A/, 'descrição quebrada em duas linhas é juntada');
    assert.match(records[3].history, /RECEBIMENTO FORNECEDOR TICKET/, 'linha sem data no topo da página 2');
    // Crédito positivo, débito negativo — sinal vem da coluna, não de um "-".
    assert.equal(records[0].value > 0, true);
    assert.equal(records[2].value < 0, true);
  });

  it('reconhece o extrato do Itaú na primeira importação', () => {
    const parsed = buildTableFromTextLines(SEED_LOG_LAYOUTS.itau);

    assert.deepEqual(parsed.headers, ['Data', 'Lançamentos', 'Razão Social', 'CNPJ/CPF', 'Valor (R$)', 'Saldo (R$)']);

    const analysis = analyzeFileLayout(asPdfFile(parsed, 'extrato-itau.pdf'), loadAiMemory());
    assert.equal(analysis.matchedProfileId, 'seed-extrato-itau');

    const roles = Object.fromEntries(analysis.mappings.map((mapping) => [mapping.header, mapping.role]));
    assert.equal(roles.Data, 'date');
    assert.equal(roles['Valor (R$)'], 'value_auto');
    assert.equal(roles['Saldo (R$)'], 'ignore');

    const { records } = transformRowsWithConfig(parsed, analysis);
    assert.equal(records.length, 3);
    assert.equal(records[0].value, 216.64);
    assert.equal(records[1].value, 90.21);
    assert.equal(records[2].value, -1371.46);
    assert.equal(records[2].dateBr, '02/10/2026');
    // Histórico junta lançamento + razão social + CNPJ, na ordem do extrato.
    assert.equal(records[0].history, 'PIX RECEBIDO ALELO 01/10 ALELO SA 04.740.876/0001-25');

    // Rodapé/hyperlink do extrato não pode virar lançamento.
    const texts = parsed.rows.flat().join(' ').toLowerCase();
    assert.doesNotMatch(texts, /novos lancamentos/);
    assert.doesNotMatch(texts, /sac 0800/);
  });
});
