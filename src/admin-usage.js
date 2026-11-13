/**
 * Conversor — registro de uso do administrador
 *
 * O app é estático e sem servidor: não existe "usuário" para consultar no banco.
 * O que dá para mostrar com honestidade é o que acontece **neste navegador** —
 * quantas sessões, quanto tempo de uso, quantas conciliações, o que a IA
 * aprendeu e o histórico de eventos. Tudo fica no `localStorage`, nada sai
 * daqui, e o painel só abre com a senha do administrador
 * (`src/cloud-lock.js`).
 *
 * Este módulo é só dado (sem DOM), para poder ser testado sozinho.
 */

/** Onde o resumo de uso é guardado. */
export const USAGE_KEY = 'conversor_admin_usage_v1';

/** Quantos eventos ficam no histórico (os mais antigos caem primeiro). */
export const MAX_EVENTS = 300;

/** Quantos dias de atividade são mantidos. */
export const MAX_DAYS = 60;

/** Contadores exibidos no painel (sempre todos presentes, mesmo em zero). */
export const COUNTER_KEYS = [
  'filesLoaded',
  'rowsProcessed',
  'contactsFiles',
  'ledgerFiles',
  'reconciliations',
  'rowsReconciled',
  'rowsReview',
  'rowsUnmatched',
  'exports',
  'manualLinks',
  'accountEdits',
  'suggestionsApplied',
  'cloudPush',
  'cloudPull',
  'errors',
];

/** Tipos de evento aceitos (o painel filtra por eles). */
export const EVENT_TYPES = ['sessao', 'arquivo', 'conciliacao', 'vinculo', 'conta', 'exportacao', 'memoria', 'nuvem', 'erro'];

const MAX_TEXT = 180;
const MAX_DETAILS = 400;

function n(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return number;
}

function text(value, limit) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

/** Data local em `AAAA-MM-DD` (o dia do usuário, não o UTC). */
export function dayKey(now = Date.now()) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) return '1970-01-01';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** ISO com segundos, para carimbar sessões e eventos. */
function isoTimestamp(now) {
  const date = now instanceof Date ? now : new Date(now);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

export function emptyUsage(now = Date.now()) {
  return {
    version: 1,
    firstSeenAt: isoTimestamp(now),
    lastSeenAt: isoTimestamp(now),
    sessions: 0,
    activeMs: 0,
    days: {},
    counters: Object.fromEntries(COUNTER_KEYS.map((key) => [key, 0])),
    events: [],
  };
}

function normalizeDays(raw, now) {
  const days = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return days;
  for (const [key, value] of Object.entries(raw)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    if (!value || typeof value !== 'object') continue;
    days[key] = { ms: n(value.ms), events: n(value.events) };
  }
  const keys = Object.keys(days).sort();
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_DAYS))) delete days[key];
  // Garante o dia de hoje mesmo numa memória antiga.
  if (!days[dayKey(now)]) days[dayKey(now)] = { ms: 0, events: 0 };
  return days;
}

function normalizeEvents(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry) => entry && typeof entry === 'object' && entry.message)
    .slice(-MAX_EVENTS)
    .map((entry, index) => ({
      id: String(entry.id || `ev-${index}`),
      at: isoTimestamp(entry.at || Date.now()),
      type: EVENT_TYPES.includes(entry.type) ? entry.type : 'sessao',
      message: text(entry.message, MAX_TEXT),
      details: text(entry.details, MAX_DETAILS),
    }));
}

/** Limpa o que veio do `localStorage` (versão antiga, valor quebrado, à mão). */
export function normalizeUsage(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyUsage(now);
  const base = emptyUsage(now);
  const counters = { ...base.counters };
  for (const key of COUNTER_KEYS) counters[key] = n(raw.counters?.[key]);
  return {
    version: 1,
    firstSeenAt: isoTimestamp(raw.firstSeenAt || now),
    lastSeenAt: isoTimestamp(raw.lastSeenAt || now),
    sessions: n(raw.sessions),
    activeMs: n(raw.activeMs),
    days: normalizeDays(raw.days, now),
    counters,
    events: normalizeEvents(raw.events),
  };
}

function storageOf(storage) {
  if (storage) return storage;
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function loadUsage(storage, now = Date.now()) {
  const store = storageOf(storage);
  if (!store) return emptyUsage(now);
  try {
    const raw = store.getItem(USAGE_KEY);
    return normalizeUsage(raw ? JSON.parse(raw) : null, now);
  } catch {
    return emptyUsage(now);
  }
}

/** Grava o resumo. `false` quando o navegador bloqueia (modo privado, cota). */
export function saveUsage(usage, storage) {
  const store = storageOf(storage);
  if (!store) return false;
  try {
    store.setItem(USAGE_KEY, JSON.stringify(usage));
    return true;
  } catch {
    return false;
  }
}

/** Marca a abertura da página: soma uma sessão e cria o dia de hoje. */
export function startSession(usage, now = Date.now()) {
  const target = usage && typeof usage === 'object' ? usage : emptyUsage(now);
  target.sessions = n(target.sessions) + 1;
  target.lastSeenAt = isoTimestamp(now);
  target.days = normalizeDays(target.days, now);
  return target;
}

/**
 * Soma tempo de uso ativo (a página fica "ativa" enquanto a aba está visível).
 * O tempo é acumulado no total e no dia de hoje.
 */
export function addActiveTime(usage, ms, now = Date.now()) {
  const amount = Math.round(n(ms));
  if (!usage || amount <= 0) return usage;
  usage.activeMs = n(usage.activeMs) + amount;
  usage.lastSeenAt = isoTimestamp(now);
  usage.days = normalizeDays(usage.days, now);
  const key = dayKey(now);
  usage.days[key].ms = n(usage.days[key].ms) + amount;
  return usage;
}

/** Guarda um evento no histórico e, de quebra, atualiza o dia. */
export function recordEvent(usage, { type = 'sessao', message, details = '' } = {}, now = Date.now()) {
  if (!usage || !message) return usage;
  usage.events = Array.isArray(usage.events) ? usage.events : [];
  usage.events.push({
    id: `ev-${now.toString(36)}-${(usage.events.length + 1).toString(36)}`,
    at: isoTimestamp(now),
    type: EVENT_TYPES.includes(type) ? type : 'sessao',
    message: text(message, MAX_TEXT),
    details: text(details, MAX_DETAILS),
  });
  if (usage.events.length > MAX_EVENTS) usage.events = usage.events.slice(-MAX_EVENTS);

  usage.days = normalizeDays(usage.days, now);
  usage.days[dayKey(now)].events = n(usage.days[dayKey(now)].events) + 1;
  usage.lastSeenAt = isoTimestamp(now);
  return usage;
}

/** Soma um contador do painel (arquivos, conciliações, exportações…). */
export function bumpCounter(usage, key, amount = 1, now = Date.now()) {
  if (!usage || !COUNTER_KEYS.includes(key)) return usage;
  usage.counters = usage.counters && typeof usage.counters === 'object' ? usage.counters : {};
  usage.counters[key] = n(usage.counters[key]) + n(amount);
  usage.lastSeenAt = isoTimestamp(now);
  return usage;
}

/** Limpa o histórico de uso (o painel pede confirmação antes). */
export function resetUsage(now = Date.now()) {
  const usage = emptyUsage(now);
  usage.sessions = 1;
  usage.days = { [dayKey(now)]: { ms: 0, events: 0 } };
  return usage;
}

/** "3 h 12 min", "8 min", "45 s" — leitura rápida de tempo. */
export function formatDuration(ms) {
  const total = Math.round(n(ms) / 1000);
  if (total < 60) return `${total} s`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours > 0 ? `${days} d ${restHours} h` : `${days} d`;
}

/** "13/11" a partir de `2026-11-13`. */
export function shortDay(key) {
  const [, month, day] = String(key).split('-');
  return month && day ? `${day}/${month}` : String(key);
}

/**
 * Números do dashboard: tempo, sessões, eventos por tipo e os últimos 14 dias.
 *
 * `now` é injetável para os testes ficarem determinísticos.
 *
 * `options.liveMs` é o tempo decorrido desde a última gravação (a sessão aberta,
 * ainda não somada ao `localStorage`). O painel usa isso para o relógio andar a
 * cada segundo sem gravar no navegador a cada segundo — e o dia de hoje, no
 * gráfico, cresce junto.
 */
export function usageSummary(usage, now = Date.now(), options = {}) {
  const data = normalizeUsage(usage, now);
  const liveMs = Math.max(0, Math.round(n(options.liveMs) || 0));
  const today = dayKey(now);
  const byType = Object.fromEntries(EVENT_TYPES.map((type) => [type, 0]));
  for (const event of data.events) byType[event.type] = (byType[event.type] || 0) + 1;

  const days = [];
  const cursor = new Date(now);
  for (let offset = 13; offset >= 0; offset -= 1) {
    const date = new Date(cursor.getTime());
    date.setDate(date.getDate() - offset);
    const key = dayKey(date.getTime());
    const bucket = data.days[key] || { ms: 0, events: 0 };
    const extra = key === today ? liveMs : 0;
    days.push({ key, label: shortDay(key), ms: n(bucket.ms) + extra, events: n(bucket.events) });
  }

  const last7 = days.slice(-7).reduce((sum, day) => sum + day.ms, 0);
  const activeMs = data.activeMs + liveMs;
  return {
    firstSeenAt: data.firstSeenAt,
    lastSeenAt: data.lastSeenAt,
    sessions: data.sessions,
    activeMs,
    liveMs,
    todayMs: n(data.days[today]?.ms) + liveMs,
    todayEvents: n(data.days[today]?.events),
    last7Ms: last7,
    avgSessionMs: data.sessions > 0 ? Math.round(activeMs / data.sessions) : 0,
    counters: data.counters,
    events: data.events,
    totalEvents: data.events.length,
    byType,
    days,
  };
}

/* -------------------------------------------------------------------------- */
/*                              Exportação                                    */
/* -------------------------------------------------------------------------- */

const DATE_TIME = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** Data e hora legíveis; valor inválido vira "—" em vez de "Invalid Date". */
export function formatDateTime(iso) {
  const time = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(time)) return '—';
  return DATE_TIME.format(new Date(time));
}

const CSV_SEPARATOR = ';';

/** Escapa célula de CSV e neutraliza fórmula (`=`, `+`, `@`, `-texto`). */
function csvCell(value) {
  let raw = String(value ?? '').replace(/[\r\n]+/g, ' ');
  if (/^[=+@\t\r]/.test(raw) || /^-\D/.test(raw)) raw = `'${raw}`;
  return `"${raw.replace(/"/g, '""')}"`;
}

/** Logs em CSV (separador ";", pronto para o Excel em português). */
export function eventsToCsv(usage) {
  const data = normalizeUsage(usage);
  const lines = ['data;hora;tipo;mensagem;detalhes'];
  for (const event of data.events) {
    const when = formatDateTime(event.at);
    const [date = '', hour = ''] = when.split(' ');
    lines.push(
      [date, hour, event.type, event.message, event.details].map((cell) => csvCell(cell)).join(CSV_SEPARATOR)
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * Deixa a chave de acesso à nuvem ilegível (o relatório pode ser enviado por
 * e-mail: o código identifica o cofre, não precisa aparecer inteiro).
 */
function maskAccessCode(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw.length <= 4) return '•'.repeat(raw.length);
  return `${raw.slice(0, 3)}${'•'.repeat(Math.max(1, raw.length - 3))}`;
}

/** Só os campos que podem sair do navegador — e a chave mascarada. */
const CLOUD_FIELDS = ['accessCode', 'lastSync', 'host', 'account', 'remote', 'auto'];

function safeCloud(cloud) {
  if (!cloud || typeof cloud !== 'object') return {};
  const out = {};
  for (const key of CLOUD_FIELDS) {
    if (cloud[key] === undefined || cloud[key] === null) continue;
    out[key] = key === 'accessCode' ? maskAccessCode(cloud[key]) : cloud[key];
  }
  return out;
}

/**
 * Relatório completo em objeto (vira `.json` no painel).
 *
 * Nunca inclui a chave do LLM: ela é segredo do dono do navegador e não tem
 * nada a ver com uso. A chave de acesso à nuvem vai mascarada.
 */
export function usageReport({ usage, memory, device, cloud, appVersion } = {}, now = Date.now()) {
  const summary = usageSummary(usage, now);
  const counterparties = memory?.counterparties || {};
  const accounts = counterparties.accounts || {};

  return {
    geradoEm: isoTimestamp(now),
    app: { versao: appVersion || '', pagina: 'conciliador' },
    uso: {
      primeiraSessaoEm: summary.firstSeenAt,
      ultimaAtividadeEm: summary.lastSeenAt,
      sessoes: summary.sessions,
      tempoTotalMs: summary.activeMs,
      tempoTotal: formatDuration(summary.activeMs),
      tempoHojeMs: summary.todayMs,
      tempoHoje: formatDuration(summary.todayMs),
      tempoUltimos7DiasMs: summary.last7Ms,
      mediaPorSessaoMs: summary.avgSessionMs,
      mediaPorSessao: formatDuration(summary.avgSessionMs),
      contadores: summary.counters,
      eventosPorTipo: summary.byType,
      dias: summary.days,
    },
    memoria: {
      perfisDeLayout: Array.isArray(memory?.learnedProfiles) ? memory.learnedProfiles.length : 0,
      perfisAprendidos: Array.isArray(memory?.learnedProfiles)
        ? memory.learnedProfiles.filter((profile) => !profile.builtIn).length
        : 0,
      vocabularioTokens: Object.keys(memory?.tokenWeights || {}).length,
      historicoDeAprendizado: Array.isArray(memory?.learningLog) ? memory.learningLog.length : 0,
      aliases: Object.keys(counterparties.aliases || {}).length,
      contatos: Object.keys(counterparties.contacts || {}).length,
      contasPorHistorico: Object.keys(accounts.byHistory || {}).length,
      contasPorContato: Object.keys(accounts.byContact || {}).length,
    },
    dispositivo: device || {},
    nuvem: safeCloud(cloud),
    logs: summary.events,
  };
}
