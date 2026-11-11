import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatIsoToBrDate,
  formatLocalDateTime,
  formatValueCurrencyBr,
  formatValueGroupedBr,
  formatValuePlainBr,
  fromCents,
  isoToUtcDate,
  round2,
  sumValues,
  toCents,
} from '../src/format.js';

describe('aritmética monetária em centavos', () => {
  it('converte para centavos sem erro de ponto flutuante', () => {
    assert.equal(toCents(0.1), 10);
    assert.equal(toCents(0.2), 20);
    assert.equal(toCents(-42.567), -4257);
    assert.equal(toCents('1234.56'), 123456);
    assert.equal(toCents(undefined), 0);
    assert.equal(toCents(Number.NaN), 0);
    assert.equal(fromCents(123456), 1234.56);
  });

  it('soma valores sem acumular dízimas', () => {
    assert.equal(sumValues([0.1, 0.2]), 0.3);
    assert.equal(sumValues([1.005, 2.005]), 3.02);
    assert.equal(sumValues([]), 0);
    assert.equal(sumValues([-10.5, 10.5]), 0);
  });

  it('arredonda valores negativos corretamente', () => {
    assert.equal(round2(-1.005), -1.01);
    assert.equal(round2(1.005), 1.01);
    assert.equal(round2(-0.004), 0);
  });
});

describe('formatValuePlainBr', () => {
  it('usa vírgula decimal e nenhum separador de milhar', () => {
    assert.equal(formatValuePlainBr(1234.5), '1234,50');
    assert.equal(formatValuePlainBr(1234567.891), '1234567,89');
    assert.equal(formatValuePlainBr(0), '0,00');
  });

  it('preserva o sinal negativo', () => {
    assert.equal(formatValuePlainBr(-42), '-42,00');
    assert.equal(formatValuePlainBr(-0.5), '-0,50');
    assert.equal(formatValuePlainBr(-1234.56), '-1234,56');
  });

  it('nunca devolve NaN/undefined para entradas inválidas', () => {
    assert.equal(formatValuePlainBr(undefined), '0,00');
    assert.equal(formatValuePlainBr('texto'), '0,00');
    assert.equal(formatValuePlainBr(Number.POSITIVE_INFINITY), '0,00');
  });
});

describe('formatValueCurrencyBr', () => {
  it('formata com símbolo e separador de milhar', () => {
    assert.equal(formatValueCurrencyBr(1234.5), 'R$ 1.234,50');
    assert.equal(formatValueCurrencyBr(-1234.5), '-R$ 1.234,50');
    assert.equal(formatValueCurrencyBr(1000000), 'R$ 1.000.000,00');
    assert.equal(formatValueCurrencyBr(0), 'R$ 0,00');
  });
});

describe('formatValueGroupedBr', () => {
  it('usa ponto de milhar sem símbolo de moeda', () => {
    assert.equal(formatValueGroupedBr(1128118.12), '1.128.118,12');
    assert.equal(formatValueGroupedBr(1600389.76), '1.600.389,76');
    assert.equal(formatValueGroupedBr(-1128118.12), '-1.128.118,12');
    assert.equal(formatValueGroupedBr(472271.64), '472.271,64');
    assert.equal(formatValueGroupedBr(999), '999,00');
    assert.equal(formatValueGroupedBr(0), '0,00');
  });
});

describe('datas', () => {
  it('converte ISO em dd/mm/aaaa', () => {
    assert.equal(formatIsoToBrDate('2026-09-02'), '02/09/2026');
    assert.equal(formatIsoToBrDate('2026-13-40'), '40/13/2026');
    assert.equal(formatIsoToBrDate('02/09/2026'), '');
    assert.equal(formatIsoToBrDate(null), '');
  });

  it('cria Date em UTC (meia-noite) sem deslocar o dia', () => {
    const date = isoToUtcDate('2026-01-05');
    assert.equal(date.toISOString(), '2026-01-05T00:00:00.000Z');
    assert.equal(isoToUtcDate('05/01/2026'), null);
  });

  it('formata data/hora local para exibição', () => {
    assert.equal(formatLocalDateTime('2026-01-05T10:30:00.000Z').length > 0, true);
    assert.equal(formatLocalDateTime('data inválida'), '');
  });
});
