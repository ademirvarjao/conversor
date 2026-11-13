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
import { formatAccessCode } from './sync-crypto.js';
import { formatDateTime, formatDuration, shortDay, usageSummary } from './admin-usage.js';

/** Abas do painel, na ordem em que aparecem. */
export const ADMIN_TABS = [
  { id: 'overview', label: 'Visão geral' },
  { id: 'usage', label: 'Uso' },
  { id: 'vaults', label: 'Códigos de acesso' },
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
          <span class="cp-admin-bar-col" aria-hidden="true"><i style="height:${height}%"></i></span>
          <em>${escapeHtml(day.label)}</em>
        </div>`;
    })
    .join('');
  return `<div class="cp-admin-chart" role="img" aria-label="Tempo de uso nos últimos 14 dias">${bars}</div>`;
}

function counterList(counters) {
  const labels = [
    ['filesLoaded', 'Arquivos importados'],
    ['rowsProcessed', 'Lançamentos gerados'],
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

/**
 * Resumo da memória da IA — o texto que antes ficava na barra do conciliador e
 * agora aparece **só aqui dentro** do painel.
 */
function memorySummaryCard(ctx) {
  const summary = ctx.memorySummary || { byHistory: 0, byContact: 0, contacts: 0, text: '' };
  return `<div class="cp-admin-summary" role="note">
      <span>Memória da IA</span>
      <strong>${escapeHtml(summary.text || 'Memória: nenhuma conta memorizada ainda')}</strong>
      <small>${summary.byHistory} conta(s) por histórico • ${summary.byContact} por contato • ${summary.contacts} contato(s) no cadastro</small>
    </div>`;
}

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
    ${memorySummaryCard(ctx)}
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

/* ----------------------------- códigos de acesso -------------------------- */

const SOURCE_LABELS = {
  criada: 'Criada neste navegador',
  recuperada: 'Recuperada aqui',
  colada: 'Colada aqui',
  banco: 'Só vista no banco',
};

function vaultButton(label, attrs, { kind = 'outline', disabled = false, title = '' } = {}) {
  const classes = kind === 'danger' ? 'btn btn-sm btn-danger-outline' : kind === 'primary' ? 'btn btn-sm btn-navy' : 'btn btn-sm btn-outline-dark';
  return `<button class="${classes}" type="button" ${attrs}${disabled ? ' disabled' : ''}${
    title ? ` title="${escapeHtml(title)}"` : ''
  }>${escapeHtml(label)}</button>`;
}

function vaultItem(item, ctx) {
  const vaults = ctx.vaults || {};
  const revealed = (vaults.revealed || []).includes(item.slot);
  const busy = vaults.busy === item.slot;
  const confirming = vaults.confirmDelete === item.slot;
  const blocked = Boolean(item.blockedAt);
  const code = item.code ? (revealed ? formatAccessCode(item.code) : item.masked) : item.shortSlot;

  const badges = [];
  if (blocked) badges.push('<span class="cp-vault-badge is-blocked">Bloqueado</span>');
  else if (item.inDb) badges.push('<span class="cp-vault-badge is-open">Liberado</span>');
  if (item.isCurrent) badges.push('<span class="cp-vault-badge is-current">Em uso agora</span>');
  badges.push(`<span class="cp-vault-badge">${escapeHtml(SOURCE_LABELS[item.source] || item.source)}</span>`);
  badges.push(
    item.inDb
      ? '<span class="cp-vault-badge is-cloud">No banco</span>'
      : '<span class="cp-vault-badge is-local">Só neste navegador</span>'
  );

  const meta = [
    `Criada em ${escapeHtml(formatDateTime(item.createdAt))}`,
    item.lastSeenAt ? `último uso ${escapeHtml(formatDateTime(item.lastSeenAt))}` : 'sem uso registrado',
    item.inDb && item.dbUpdatedAt ? `banco ${escapeHtml(formatDateTime(item.dbUpdatedAt))}` : null,
    item.inDb ? (item.ownerId ? 'dono: conta logada' : 'dono: sem conta (legado/anônimo)') : null,
    blocked && item.blockedAt ? `bloqueado em ${escapeHtml(formatDateTime(item.blockedAt))}` : null,
    item.code ? null : `slot ${escapeHtml(item.shortSlot)}`,
  ].filter(Boolean);

  const actions = [];
  actions.push(
    item.code
      ? vaultButton(revealed ? 'Ocultar' : 'Ver código', `data-cp-vault-reveal="${escapeHtml(item.slot)}" aria-pressed="${revealed}"`)
      : vaultButton('Ver código', '', { disabled: true, title: 'Esta chave não está anotada neste navegador — o banco guarda só o slot.' })
  );
  if (item.code) {
    actions.push(vaultButton('Copiar', `data-cp-vault-copy="${escapeHtml(item.slot)}"`));
  }
  actions.push(
    vaultButton(
      blocked ? 'Desbloquear' : 'Bloquear',
      `data-cp-vault-block="${escapeHtml(item.slot)}" data-cp-vault-target="${blocked ? 'open' : 'blocked'}"`,
      {
        kind: blocked ? 'primary' : 'outline',
        disabled: busy || !item.inDb || !vaults.configured,
        title: item.inDb ? 'Grava o bloqueio no banco (vale para todos os navegadores)' : 'Só é possível bloquear um cofre que está no banco.',
      }
    )
  );
  if (confirming) {
    actions.push(vaultButton('Confirmar exclusão', `data-cp-vault-delete="${escapeHtml(item.slot)}"`, { kind: 'danger', disabled: busy }));
    actions.push(vaultButton('Cancelar', 'data-cp-vault-cancel=""'));
  } else {
    actions.push(
      vaultButton('Excluir do banco', `data-cp-vault-ask="${escapeHtml(item.slot)}"`, {
        kind: 'danger',
        disabled: busy || !item.inDb || !vaults.configured,
        title: 'Apaga a linha do cofre no banco (o conteúdo cifrado some)',
      })
    );
  }
  if (!item.inDb && item.code) {
    actions.push(vaultButton('Esquecer aqui', `data-cp-vault-forget="${escapeHtml(item.slot)}"`));
  }

  return `<article class="cp-vault-item${blocked ? ' is-blocked' : ''}${busy ? ' is-busy' : ''}" data-cp-vault-row="${escapeHtml(item.slot)}">
      <div class="cp-vault-main">
        <code class="cp-vault-code">${escapeHtml(code)}</code>
        <div class="cp-vault-badges">${badges.join('')}</div>
        <p class="cp-vault-meta">${meta.join(' • ')}</p>
        ${
          confirming
            ? '<p class="cp-vault-confirm" role="alert">Excluir apaga a linha do cofre no banco: o conteúdo cifrado não volta.</p>'
            : ''
        }
      </div>
      <div class="cp-vault-actions">${actions.join('')}</div>
    </article>`;
}

function vaultsTab(ctx) {
  const vaults = ctx.vaults || {};
  const list = Array.isArray(vaults.list) ? vaults.list : [];
  const configured = Boolean(vaults.configured);

  const notices = [];
  if (vaults.notice?.text) {
    notices.push(`<p class="cp-vault-notice is-${escapeHtml(vaults.notice.kind || 'ok')}" role="status">${escapeHtml(vaults.notice.text)}</p>`);
  }
  if (!configured) {
    notices.push(
      '<p class="cp-vault-notice is-warn" role="note">Banco compartilhado não configurado: a lista mostra só os códigos que este navegador conhece, e bloquear/excluir fica desligado.</p>'
    );
  }
  if (vaults.schemaOutdated) {
    notices.push(
      '<p class="cp-vault-notice is-warn" role="alert">O banco está sem a migração de bloqueio. Abra a aba Nuvem, copie o SQL de instalação e rode uma vez no SQL Editor para liberar bloquear e excluir.</p>'
    );
  }
  if (vaults.error) {
    notices.push(`<p class="cp-vault-notice is-error" role="alert">${escapeHtml(vaults.error)}</p>`);
  }

  const blocked = list.filter((item) => item.blockedAt).length;
  const inDb = list.filter((item) => item.inDb).length;

  const body = `
    <div class="cp-vault-toolbar">
      <div class="cp-admin-grid cp-admin-grid-3 cp-vault-stats">
        ${info('Códigos conhecidos', String(list.length), `${vaults.localCount ?? 0} anotado(s) neste navegador`)}
        ${info('No banco', String(inDb), 'linha do cofre encontrada')}
        ${info('Bloqueados', String(blocked), blocked ? 'envio e download suspensos' : 'nenhum bloqueio ativo')}
      </div>
      ${vaultButton(vaults.loading ? 'Consultando…' : 'Recarregar do banco', 'data-cp-vault-reload=""', {
        disabled: vaults.loading || !configured,
        title: 'Lê de novo os cofres que aparecem no banco',
      })}
    </div>
    ${
      vaults.loading && list.length === 0
        ? '<p class="cp-admin-empty">Consultando o banco…</p>'
        : list.length === 0
          ? '<p class="cp-admin-empty">Nenhum código de acesso ainda. Crie uma chave na aba Nuvem e ela aparece aqui.</p>'
          : `<div class="cp-vault-list">${list.map((item) => vaultItem(item, ctx)).join('')}</div>`
    }
  `;

  return `
    ${notices.join('')}
    ${section('Códigos de acesso gerados', body, 'A chave em si só existe neste navegador — o banco guarda apenas o slot e o conteúdo cifrado. Bloquear e excluir valem para o banco, portanto para todos os navegadores.')}
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
    ${memorySummaryCard(ctx)}
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
    case 'vaults':
      return vaultsTab(full);
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

/* -------------------------------------------------------------------------- */
/*                       Marcação do painel (qualquer página)                 */
/* -------------------------------------------------------------------------- */

/**
 * HTML do painel. Fica aqui — e não nas páginas — para o painel ser **o mesmo**
 * no Conversor e no Conciliador, sem duas cópias para manter sincronizadas.
 * A página só injeta este texto e liga os botões (ver `src/admin-console.js`).
 */
export function adminPanelMarkup() {
  const tabs = ADMIN_TABS.map(
    (tab, index) =>
      `<button class="mtab${index === 0 ? ' active' : ''}" type="button" role="tab" ` +
      `data-cp-admin-tab="${tab.id}" aria-selected="${index === 0 ? 'true' : 'false'}" ` +
      `id="tab-cp-admin-${tab.id}" aria-controls="cp-admin-body">${escapeHtml(tab.label)}</button>`
  ).join('\n        ');

  return `<div
    id="cp-admin-panel"
    class="modal-backdrop hidden"
    role="dialog"
    aria-modal="true"
    aria-labelledby="cp-admin-title"
    aria-hidden="true"
  >
    <div class="modal-card cp-admin-panel-card">
      <div class="modal-header">
        <div>
          <h2 id="cp-admin-title">Painel do administrador</h2>
          <p class="modal-sub" id="cp-admin-headline">—</p>
        </div>
        <button id="btn-cp-admin-close" class="icon-btn" type="button" aria-label="Fechar painel">✕</button>
      </div>

      <div class="modal-tabs cp-admin-tabs" role="tablist" aria-label="Seções do painel">
        ${tabs}
      </div>

      <div class="modal-body" id="cp-admin-body" role="tabpanel" tabindex="0"></div>

      <div class="cp-admin-actions">
        <button id="btn-cp-admin-lock" class="btn btn-sm btn-outline-dark" type="button" title="Pedir a senha de novo">Bloquear acesso</button>
        <span class="cp-admin-spacer"></span>
        <button id="btn-cp-admin-refresh" class="btn btn-sm btn-outline-dark" type="button">Atualizar</button>
        <button id="btn-cp-admin-export" class="btn btn-sm btn-navy" type="button">Relatório .json</button>
        <button id="btn-cp-admin-logs" class="btn btn-sm btn-outline-dark" type="button">Logs .csv</button>
        <button id="btn-cp-admin-reset" class="btn btn-sm btn-danger-outline" type="button">Limpar histórico</button>
      </div>
    </div>
  </div>`;
}

/**
 * Diálogo de senha do administrador. Só aparece quando alguém tenta abrir o
 * painel sem o desbloqueio válido (1 hora por aba, `src/cloud-lock.js`).
 */
export function adminGateMarkup() {
  return `<div
    id="admin-gate"
    class="modal-backdrop hidden"
    role="dialog"
    aria-modal="true"
    aria-labelledby="admin-gate-title"
    aria-hidden="true"
  >
    <form id="admin-gate-form" class="modal-card admin-gate-card" autocomplete="off" novalidate>
      <div class="modal-header">
        <div>
          <h2 id="admin-gate-title">Acesso do administrador</h2>
          <p class="modal-sub">Painel de uso, códigos de acesso, memória da IA e logs — liberado por 1 hora nesta aba</p>
        </div>
        <button id="btn-admin-gate-close" class="icon-btn" type="button" aria-label="Fechar">✕</button>
      </div>

      <div class="modal-body">
        <div class="admin-gate-fields">
          <div class="field-group">
            <label for="admin-gate-user">Login</label>
            <input id="admin-gate-user" type="text" autocomplete="username" spellcheck="false" placeholder="login do administrador" />
          </div>
          <div class="field-group">
            <label for="admin-gate-password">Senha</label>
            <input id="admin-gate-password" type="password" autocomplete="current-password" placeholder="senha" />
          </div>
        </div>
        <p id="admin-gate-error" class="cloud-lock-error hidden" role="alert"></p>
        <p class="admin-gate-note">
          É a mesma senha da conexão do banco. Quem não é administrador pode usar o app inteiro — só este painel fica fechado.
        </p>
      </div>

      <div class="admin-gate-actions">
        <button id="btn-admin-gate-enter" class="btn btn-primary" type="submit">Entrar</button>
      </div>
    </form>
  </div>`;
}
