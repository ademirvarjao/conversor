/**
 * Conversor — painel do administrador (dashboard, uso, memória, logs)
 *
 * Monta o HTML do painel que abre no conciliador depois do login do
 * administrador. Recebe os dados já prontos (uso, memória, dispositivo, nuvem)
 * e devolve texto — quem injeta na tela é `src/counterparty-page.js`.
 *
 * Tudo é local: nada aqui busca dado de servidor. O que aparece é o que este
 * navegador registrou (ver `src/admin-usage.js`).
 */

import { escapeHtml } from './html.js';
import { formatDateTime, formatDuration, shortDay, usageSummary } from './admin-usage.js';

/** Abas do painel, na ordem em que aparecem. */
export const ADMIN_TABS = [
  { id: 'overview', label: 'Visão geral' },
  { id: 'usage', label: 'Uso' },
  { id: 'memory', label: 'Memória da IA' },
  { id: 'logs', label: 'Logs' },
  { id: 'device', label: 'Dispositivo e conta' },
];

/** Nome legível de cada tipo de evento. */
const TYPE_LABELS = {
  sessao: 'Sessão',
  arquivo: 'Arquivo',
  conciliacao: 'Conciliação',
  vinculo: 'Vínculo',
  conta: 'Conta',
  exportacao: 'Exportação',
  memoria: 'Memória',
  nuvem: 'Nuvem',
  erro: 'Erro',
};

function info(label, value, hint = '') {
  return `<div class="cp-admin-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      ${hint ? `<small>${escapeHtml(hint)}</small>` : ''}
    </div>`;
}

function section(title, body, hint = '') {
  return `<section class="cp-admin-section">
      <h3>${escapeHtml(title)}</h3>
      ${hint ? `<p class="cp-admin-hint">${escapeHtml(hint)}</p>` : ''}
      ${body}
    </section>`;
}

/** Gráfico de barras dos últimos 14 dias (tempo ativo por dia). */
function activityChart(days) {
  const max = Math.max(...days.map((day) => day.ms), 1);
  const bars = days
    .map((day) => {
      const height = Math.max(2, Math.round((day.ms / max) * 100));
      const label = `${day.label}: ${formatDuration(day.ms)} em ${day.events} evento(s)`;
      return `<div class="cp-admin-bar" title="${escapeHtml(label)}">
          <span style="height:${height}%" aria-hidden="true"></span>
          <em>${escapeHtml(day.label)}</em>
        </div>`;
    })
    .join('');
  return `<div class="cp-admin-chart" role="img" aria-label="Tempo de uso nos últimos 14 dias">${bars}</div>`;
}

function counterList(counters) {
  const labels = [
    ['contactsFiles', 'Cadastros carregados'],
    ['ledgerFiles', 'Extratos carregados'],
    ['reconciliations', 'Conciliações rodadas'],
    ['rowsReconciled', 'Lançamentos vinculados'],
    ['rowsReview', 'Lançamentos para revisar'],
    ['rowsUnmatched', 'Lançamentos sem contato'],
    ['exports', 'Exportações geradas'],
    ['manualLinks', 'Vínculos feitos à mão'],
    ['accountEdits', 'Contas digitadas'],
    ['suggestionsApplied', 'Sugestões aceitas'],
    ['cloudPush', 'Envios para a nuvem'],
    ['cloudPull', 'Sincronizações recebidas'],
    ['errors', 'Erros registrados'],
  ];
  return `<div class="cp-admin-grid cp-admin-grid-3">
      ${labels
        .map(([key, label]) => info(label, String(counters[key] ?? 0)))
        .join('')}
    </div>`;
}

function eventsTable(events, { limit = 0, filter = 'all' } = {}) {
  const list = (filter === 'all' ? events : events.filter((event) => event.type === filter)).slice(
    limit > 0 ? -limit : 0
  );

  if (list.length === 0) {
    return '<p class="cp-admin-empty">Nenhum evento registrado ainda. Use o conciliador e volte aqui.</p>';
  }

  const rows = list
    .slice()
    .reverse()
    .map(
      (event) => `<tr data-cp-admin-type="${escapeHtml(event.type)}">
          <td class="cp-admin-when">${escapeHtml(formatDateTime(event.at))}</td>
          <td><span class="cp-admin-tag is-${escapeHtml(event.type)}">${escapeHtml(TYPE_LABELS[event.type] || event.type)}</span></td>
          <td>${escapeHtml(event.message)}</td>
          <td class="cp-admin-details">${escapeHtml(event.details || '—')}</td>
        </tr>`
    )
    .join('');

  return `<div class="cp-admin-table-wrap">
      <table class="cp-admin-table">
        <thead><tr><th>Quando</th><th>Tipo</th><th>Evento</th><th>Detalhes</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function logFilters(events, active = 'all') {
  const counts = {};
  for (const event of events) counts[event.type] = (counts[event.type] || 0) + 1;
  const chip = (value, label) =>
    `<button class="pill cp-admin-log-filter${value === active ? ' active' : ''}" type="button" ` +
    `data-cp-admin-log="${escapeHtml(value)}" aria-pressed="${value === active}">${escapeHtml(label)}</button>`;
  const chips = [chip('all', `Todos (${events.length})`)];
  for (const [type, label] of Object.entries(TYPE_LABELS)) {
    if (!counts[type]) continue;
    chips.push(chip(type, `${label} (${counts[type]})`));
  }
  return `<div class="cp-admin-filters" role="group" aria-label="Filtrar os logs">${chips.join('')}</div>`;
}

/* -------------------------------------------------------------------------- */
/*                                   Abas                                     */
/* -------------------------------------------------------------------------- */

/** Data/hora de um instante em ms, sem estourar quando o valor não existe. */
function clockOf(ms) {
  const time = Number(ms);
  if (!Number.isFinite(time)) return '—';
  return formatDateTime(new Date(time).toISOString());
}

function overviewTab(ctx) {
  const { summary, now } = ctx;
  const startedAt = Number(ctx.sessionStartedAt);
  const atual = Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : 0;
  return `
    <div class="cp-admin-grid">
      ${info('Tempo nesta sessão', formatDuration(atual), `aberta em ${clockOf(startedAt)}`)}
      ${info('Tempo total de uso', formatDuration(summary.activeMs), `em ${summary.sessions} sessão(ões)`)}
      ${info('Média por sessão', formatDuration(summary.avgSessionMs), `hoje: ${formatDuration(summary.todayMs)}`)}
      ${info('Primeiro uso', formatDateTime(summary.firstSeenAt), `${summary.totalEvents} evento(s) no histórico`)}
    </div>
    ${section('Atividade dos últimos 14 dias', activityChart(summary.days), 'Altura da barra = tempo com a página aberta e visível.')}
    ${section(
      'Conciliações',
      `<div class="cp-admin-grid cp-admin-grid-3">
        ${info('Conciliações rodadas', String(summary.counters.reconciliations))}
        ${info('Lançamentos vinculados', String(summary.counters.rowsReconciled))}
        ${info('Para revisar', String(summary.counters.rowsReview))}
      </div>`
    )}
    ${section('Últimos eventos', eventsTable(summary.events, { limit: 6 }))}
  `;
}

function usageTab(ctx) {
  const { summary } = ctx;
  return `
    ${section('Contadores', counterList(summary.counters))}
    ${section(
      'Tempo',
      `<div class="cp-admin-grid">
        ${info('Tempo total', formatDuration(summary.activeMs), `${summary.sessions} sessão(ões)`)}
        ${info('Hoje', formatDuration(summary.todayMs), `${summary.todayEvents} evento(s)`)}
        ${info('Últimos 7 dias', formatDuration(summary.last7Ms))}
        ${info('Média por sessão', formatDuration(summary.avgSessionMs))}
      </div>`,
      'Só conta o tempo com a aba visível — segundo plano e tela travada ficam de fora.'
    )}
    ${section(
      'Por tipo de evento',
      `<div class="cp-admin-grid cp-admin-grid-3">
        ${Object.entries(summary.byType)
          .map(([type, total]) => info(TYPE_LABELS[type] || type, String(total)))
          .join('')}
      </div>`
    )}
  `;
}

function memoryTab(ctx) {
  const { memory, storage } = ctx;
  const profiles = Array.isArray(memory?.learnedProfiles) ? memory.learnedProfiles : [];
  const learned = profiles.filter((profile) => !profile.builtIn);
  const log = Array.isArray(memory?.learningLog) ? memory.learningLog : [];
  const counterparties = memory?.counterparties || {};
  const accounts = counterparties.accounts || {};

  const lastLog = log
    .slice(-8)
    .reverse()
    .map(
      (entry) => `<li>
        <span class="cp-admin-when">${escapeHtml(formatDateTime(entry.timestamp))}</span>
        ${escapeHtml(entry.message || '')}
        ${entry.details ? `<em>${escapeHtml(String(entry.details).slice(0, 160))}</em>` : ''}
      </li>`
    )
    .join('');

  return `
    ${section(
      'O que a IA aprendeu',
      `<div class="cp-admin-grid cp-admin-grid-3">
        ${info('Perfis de layout', String(profiles.length), `${learned.length} aprendido(s) aqui`)}
        ${info('Palavras no vocabulário', String(Object.keys(memory?.tokenWeights || {}).length))}
        ${info('Assinaturas de layout', String((memory?.layoutSignatures || []).length))}
        ${info('Contatos conhecidos', String(Object.keys(counterparties.contacts || {}).length))}
        ${info('Apelidos histórico → contato', String(Object.keys(counterparties.aliases || {}).length))}
        ${info('Contas memorizadas', String(Object.keys(accounts.byHistory || {}).length + Object.keys(accounts.byContact || {}).length))}
      </div>`
    )}
    ${section(
      'Armazenamento neste navegador',
      `<div class="cp-admin-grid cp-admin-grid-3">
        ${info('Memória da IA', storage.memory, 'localStorage')}
        ${info('Histórico de uso', storage.usage, 'este painel')}
        ${info('Total do site', storage.total, `${storage.keys} chave(s)`)}
      </div>`,
      'Só o tamanho dos dados — o conteúdo dos arquivos nunca é guardado.'
    )}
    ${section(
      'Histórico de aprendizado',
      lastLog ? `<ul class="cp-admin-log-list">${lastLog}</ul>` : '<p class="cp-admin-empty">Nada registrado ainda.</p>',
      'Últimas 8 entradas da memória da IA.'
    )}
  `;
}

function logsTab(ctx) {
  const events = ctx.summary.events;
  const filter = ctx.logFilter || 'all';
  return `
    ${section(
      'Histórico de eventos',
      `${logFilters(events, filter)}<div id="cp-admin-log-table">${eventsTable(events, { filter })}</div>`,
      `Até ${ctx.maxEvents} eventos ficam guardados neste navegador (os mais antigos caem).`
    )}
  `;
}

function deviceTab(ctx) {
  const { device, cloud } = ctx;
  const rows = device.rows
    .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`)
    .join('');

  return `
    ${section('Este dispositivo', `<dl class="cp-admin-dl">${rows}</dl>`)}
    ${section(
      'Nuvem e conta',
      `<div class="cp-admin-grid cp-admin-grid-3">
        ${info('Chave de acesso', cloud.accessCode || 'nenhuma')}
        ${info('Última sincronização', cloud.lastSync || '—')}
        ${info('Banco', cloud.host || 'não configurado')}
        ${info('Conta Supabase', cloud.account || 'sem conta')}
        ${info('Modelos na nuvem', cloud.remote || 'não verificado')}
        ${info('Sincronização', cloud.auto ? 'automática' : 'manual')}
      </div>`,
      'A chave do conector LLM nunca é exibida nem exportada — ela é segredo deste navegador.'
    )}
  `;
}

/**
 * HTML do corpo do painel.
 *
 * @param {object} ctx
 * @param {string} ctx.tab           aba ativa
 * @param {object} ctx.usage         estado de `admin-usage.js`
 * @param {object} ctx.memory        memória da IA
 * @param {object} ctx.device        `{ rows: [[rótulo, valor], …] }`
 * @param {object} ctx.cloud         dados da nuvem já formatados
 * @param {object} ctx.storage       `{ memory, usage, total, keys }`
 * @param {number} ctx.sessionStartedAt
 * @param {number} [ctx.now]
 */
export function renderAdminPanel(ctx) {
  const now = ctx.now || Date.now();
  const summary = usageSummary(ctx.usage, now);
  const full = {
    ...ctx,
    now,
    summary,
    maxEvents: 300,
    storage: ctx.storage || { memory: '—', usage: '—', total: '—', keys: 0 },
    cloud: ctx.cloud || {},
    memory: ctx.memory || {},
    device: ctx.device || { rows: [] },
    logFilter: ctx.logFilter || 'all',
  };

  switch (ctx.tab) {
    case 'usage':
      return usageTab(full);
    case 'memory':
      return memoryTab(full);
    case 'logs':
      return logsTab(full);
    case 'device':
      return deviceTab(full);
    default:
      return overviewTab(full);
  }
}

/** Cabeçalho do painel: resume o estado em uma linha. */
export function adminPanelHeadline(usage, now = Date.now()) {
  const summary = usageSummary(usage, now);
  const dias = summary.days.filter((day) => day.events > 0).length;
  return `${summary.sessions} sessão(ões) • ${formatDuration(summary.activeMs)} de uso • ${dias} dia(s) com atividade`;
}

/** Último dia com atividade (para o rodapé do painel). */
export function lastActiveDay(usage, now = Date.now()) {
  const summary = usageSummary(usage, now);
  const active = summary.days.filter((day) => day.events > 0 || day.ms > 0);
  return active.length ? shortDay(active[active.length - 1].key) : '—';
}
