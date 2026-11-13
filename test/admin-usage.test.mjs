/**
 * Registro de uso do administrador (`src/admin-usage.js`).
 *
 * O app é estático: o painel mostra o que aconteceu **neste navegador**. Estes
 * testes cobrem as garantias que importam para o dono — os números não estouram,
 * o histórico não cresce sem limite, o CSV abre no Excel em português sem virar
 * fórmula e o relatório nunca carrega a chave do LLM.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COUNTER_KEYS,
  EVENT_TYPES,
  MAX_DAYS,
  MAX_EVENTS,
  USAGE_KEY,
  addActiveTime,
  bumpCounter,
  dayKey,
  eventsToCsv,
  formatDateTime,
  formatDuration,
  loadUsage,
  normalizeUsage,
  recordEvent,
  resetUsage,
  saveUsage,
  shortDay,
  startSession,
  usageReport,
  usageSummary,
} from '../src/admin-usage.js';

const NOW = Date.parse('2026-11-11T14:30:00.000Z');

function fakeStorage() {
  const data = new Map();
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

describe('registro de uso: base', () => {
  it('começa com todos os contadores e nenhum evento', () => {
    const usage = normalizeUsage(null, NOW);
    assert.equal(usage.sessions, 0);
    assert.equal(usage.activeMs, 0);
    assert.deepEqual(Object.keys(usage.counters).sort(), [...COUNTER_KEYS].sort());
    assert.deepEqual(usage.events, []);
  });

  it('aguenta lixo no localStorage sem explodir', () => {
    for (const raw of [null, 42, 'texto', [], { counters: 'x', events: 'y', days: [] }]) {
      const usage = normalizeUsage(raw, NOW);
      assert.equal(usage.sessions, 0);
      assert.equal(typeof usage.counters.exports, 'number');
      assert.ok(Array.isArray(usage.events));
    }
  });

  it('descarta contador e evento com tipo inventado', () => {
    const usage = normalizeUsage(
      { counters: { exports: 3, inventado: 99, reconciliations: -5 }, events: [{ type: 'hack', message: 'oi' }] },
      NOW
    );
    assert.equal(usage.counters.exports, 3);
    assert.equal('inventado' in usage.counters, false, 'contador desconhecido não entra');
    assert.equal(usage.counters.reconciliations, 0, 'número negativo vira zero');
    assert.equal(usage.events[0].type, 'sessao', 'tipo fora da lista cai em "sessao"');
  });

  it('guarda no localStorage e volta igual', () => {
    const storage = fakeStorage();
    const usage = normalizeUsage(null, NOW);
    startSession(usage, NOW);
    recordEvent(usage, { type: 'conciliacao', message: 'rodou' }, NOW);
    assert.equal(saveUsage(usage, storage), true);
    assert.ok(storage.data.has(USAGE_KEY));
    const back = loadUsage(storage, NOW);
    assert.equal(back.sessions, 1);
    assert.equal(back.events.length, 1);
    assert.equal(back.events[0].message, 'rodou');
  });

  it('não quebra quando o navegador bloqueia a gravação', () => {
    const blocked = {
      getItem: () => {
        throw new Error('modo privado');
      },
      setItem: () => {
        throw new Error('cota');
      },
    };
    assert.deepEqual(loadUsage(blocked, NOW).events, []);
    assert.equal(saveUsage(normalizeUsage(null, NOW), blocked), false);
  });
});

describe('registro de uso: sessões, tempo e contadores', () => {
  it('cada abertura soma uma sessão e marca o dia', () => {
    const usage = normalizeUsage(null, NOW);
    startSession(usage, NOW);
    startSession(usage, NOW + 1000);
    assert.equal(usage.sessions, 2);
    assert.ok(usage.days[dayKey(NOW)], 'o dia de hoje existe');
  });

  it('o tempo entra no total e no dia, ignorando valores inválidos', () => {
    const usage = normalizeUsage(null, NOW);
    addActiveTime(usage, 90_000, NOW);
    addActiveTime(usage, -5, NOW);
    addActiveTime(usage, 'abc', NOW);
    assert.equal(usage.activeMs, 90_000);
    assert.equal(usage.days[dayKey(NOW)].ms, 90_000);
  });

  it('só aceita contadores conhecidos', () => {
    const usage = normalizeUsage(null, NOW);
    bumpCounter(usage, 'reconciliations', 2, NOW);
    bumpCounter(usage, 'chaveQueNaoExiste', 5, NOW);
    assert.equal(usage.counters.reconciliations, 2);
    assert.equal('chaveQueNaoExiste' in usage.counters, false);
  });

  it(`mantém no máximo ${MAX_EVENTS} eventos (os mais antigos caem)`, () => {
    const usage = normalizeUsage(null, NOW);
    for (let index = 0; index < MAX_EVENTS + 25; index += 1) {
      recordEvent(usage, { type: 'arquivo', message: `evento ${index}` }, NOW + index);
    }
    assert.equal(usage.events.length, MAX_EVENTS);
    assert.equal(usage.events.at(-1).message, `evento ${MAX_EVENTS + 24}`);
    assert.equal(usage.events[0].message, 'evento 25');
    assert.equal(usage.days[dayKey(NOW)].events, MAX_EVENTS + 25, 'o dia conta todos');
  });

  it(`guarda no máximo ${MAX_DAYS} dias de atividade`, () => {
    const days = {};
    for (let index = 0; index < MAX_DAYS + 10; index += 1) {
      const key = dayKey(NOW - index * 86_400_000);
      days[key] = { ms: 1000, events: 1 };
    }
    const usage = normalizeUsage({ days }, NOW);
    assert.ok(Object.keys(usage.days).length <= MAX_DAYS);
    assert.ok(usage.days[dayKey(NOW)], 'o dia de hoje nunca é descartado');
  });

  it('limpar o histórico zera tudo e reabre a sessão atual', () => {
    const usage = normalizeUsage(null, NOW);
    startSession(usage, NOW);
    addActiveTime(usage, 60_000, NOW);
    bumpCounter(usage, 'exports', 4, NOW);
    recordEvent(usage, { type: 'exportacao', message: 'baixou' }, NOW);

    const fresh = resetUsage(NOW);
    assert.equal(fresh.sessions, 1);
    assert.equal(fresh.activeMs, 0);
    assert.equal(fresh.counters.exports, 0);
    assert.deepEqual(fresh.events, []);
    assert.deepEqual(Object.keys(fresh.days), [dayKey(NOW)]);
  });

  it('o texto do evento é limpo e limitado', () => {
    const usage = normalizeUsage(null, NOW);
    recordEvent(usage, { type: 'arquivo', message: `linha\nquebrada ${'x'.repeat(400)}` }, NOW);
    assert.equal(/[\r\n]/.test(usage.events[0].message), false);
    assert.ok(usage.events[0].message.length <= 180);
  });
});

describe('resumo do dashboard', () => {
  it('devolve 14 dias, com hoje no fim', () => {
    const usage = normalizeUsage(null, NOW);
    addActiveTime(usage, 120_000, NOW);
    const summary = usageSummary(usage, NOW);
    assert.equal(summary.days.length, 14);
    assert.equal(summary.days.at(-1).key, dayKey(NOW));
    assert.equal(summary.days.at(-1).ms, 120_000);
    assert.equal(summary.todayMs, 120_000);
  });

  it('conta os eventos por tipo e a média por sessão', () => {
    const usage = normalizeUsage(null, NOW);
    startSession(usage, NOW);
    startSession(usage, NOW);
    addActiveTime(usage, 600_000, NOW);
    recordEvent(usage, { type: 'conciliacao', message: 'a' }, NOW);
    recordEvent(usage, { type: 'conciliacao', message: 'b' }, NOW);
    recordEvent(usage, { type: 'exportacao', message: 'c' }, NOW);

    const summary = usageSummary(usage, NOW);
    assert.equal(summary.sessions, 2);
    assert.equal(summary.avgSessionMs, 300_000);
    assert.equal(summary.byType.conciliacao, 2);
    assert.equal(summary.byType.exportacao, 1);
    assert.equal(summary.totalEvents, 3);
    for (const type of EVENT_TYPES) assert.equal(typeof summary.byType[type], 'number');
  });

  it('os últimos 7 dias somam só a última semana', () => {
    const usage = normalizeUsage(null, NOW);
    addActiveTime(usage, 60_000, NOW);
    addActiveTime(usage, 60_000, NOW - 3 * 86_400_000);
    addActiveTime(usage, 500_000, NOW - 20 * 86_400_000);
    const summary = usageSummary(usage, NOW);
    assert.equal(summary.last7Ms, 120_000);
    assert.equal(summary.activeMs, 620_000);
  });
});

describe('formatação', () => {
  it('tempo em segundos, minutos, horas e dias', () => {
    assert.equal(formatDuration(9_000), '9 s');
    assert.equal(formatDuration(59_000), '59 s');
    assert.equal(formatDuration(8 * 60_000), '8 min');
    assert.equal(formatDuration(3 * 3_600_000 + 12 * 60_000), '3 h 12 min');
    assert.equal(formatDuration(2 * 3_600_000), '2 h');
    assert.equal(formatDuration(50 * 3_600_000), '2 d 2 h');
    assert.equal(formatDuration(48 * 3_600_000), '2 d');
    assert.equal(formatDuration(undefined), '0 s');
    assert.equal(formatDuration(-10), '0 s');
  });

  it('data e hora legíveis, sem "Invalid Date"', () => {
    assert.equal(formatDateTime('2026-11-11T14:30:00.000Z').includes('2026'), true);
    assert.equal(formatDateTime('nada'), '—');
    assert.equal(formatDateTime(undefined), '—');
  });

  it('dia curto no formato do gráfico', () => {
    assert.equal(shortDay('2026-11-03'), '03/11');
    assert.equal(shortDay('2026-11-03').length, 5);
    assert.equal(shortDay(''), '');
  });
});

describe('exportação', () => {
  it('o CSV usa ponto e vírgula e traz o cabeçalho', () => {
    const usage = normalizeUsage(null, NOW);
    recordEvent(usage, { type: 'conciliacao', message: 'Conciliação: 12 de 30', details: '3 para revisar' }, NOW);
    const csv = eventsToCsv(usage);
    const [header, line] = csv.split('\r\n');
    assert.equal(header, 'data;hora;tipo;mensagem;detalhes');
    assert.match(line, /^"[^"]+";"[^"]+";"conciliacao";"Conciliação: 12 de 30";"3 para revisar"$/);
    assert.ok(line.includes(';"conciliacao";'), 'o tipo vai entre aspas');
  });

  it('neutraliza fórmula e escapa aspas', () => {
    const usage = normalizeUsage(null, NOW);
    recordEvent(usage, { type: 'erro', message: '=HYPERLINK("x")', details: '+1-800' }, NOW);
    const csv = eventsToCsv(usage);
    assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`), 'fórmula vira texto');
    assert.ok(csv.includes(`"'+1-800"`), 'sinal de mais vira texto');
  });

  it('o relatório junta uso, memória e dispositivo', () => {
    const usage = normalizeUsage(null, NOW);
    startSession(usage, NOW);
    addActiveTime(usage, 3_600_000, NOW);
    bumpCounter(usage, 'exports', 2, NOW);
    const report = usageReport(
      {
        usage,
        appVersion: '1.25.0',
        memory: {
          learnedProfiles: [{ id: 'a' }, { id: 'b', builtIn: true }],
          tokenWeights: { banco: 3, itau: 5 },
          learningLog: [{ timestamp: new Date(NOW).toISOString(), message: 'aprendeu' }],
          counterparties: { contacts: { '1': {} }, aliases: { x: '1' }, accounts: { byHistory: {}, byContact: { a: '1' } } },
        },
        device: { navegador: 'Chrome' },
        cloud: { remote: 'sincronizado' },
      },
      NOW
    );

    assert.equal(report.app.versao, '1.25.0');
    assert.equal(report.uso.sessoes, 1);
    assert.equal(report.uso.tempoTotal, '1 h');
    assert.equal(report.uso.contadores.exports, 2);
    assert.equal(report.memoria.perfisDeLayout, 2);
    assert.equal(report.memoria.perfisAprendidos, 1);
    assert.equal(report.memoria.vocabularioTokens, 2);
    assert.equal(report.memoria.contatos, 1);
    assert.equal(report.memoria.contasPorContato, 1);
    assert.equal(report.dispositivo.navegador, 'Chrome');
    assert.equal(report.uso.dias.length, 14);
    assert.ok(Array.isArray(report.logs));
  });

  it('o relatório não carrega a chave do LLM nem segredo nenhum', () => {
    const usage = normalizeUsage(null, NOW);
    const report = usageReport(
      {
        usage,
        cloud: { accessCode: 'GOG-1234', host: 'abc.supabase.co', remote: 'sincronizado' },
        memory: { counterparties: {} },
      },
      NOW
    );
    const json = JSON.stringify(report);
    for (const forbidden of ['apiKey', 'api_key', 'llmKey', 'password', 'senha', 'botToken', 'GOG-1234']) {
      assert.equal(json.includes(forbidden), false, `o relatório não pode trazer ${forbidden}`);
    }
    assert.equal(report.nuvem.accessCode, 'GOG•••••', 'a chave de acesso vai mascarada (mesmo tamanho)');
    assert.equal(report.nuvem.accessCode.length, 'GOG-1234'.length);
    assert.equal(report.nuvem.host, 'abc.supabase.co', 'o endereço do banco não é segredo');
  });
});
