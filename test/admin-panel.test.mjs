/**
 * Painel do administrador (`src/admin-panel.js`) e a porta de entrada dele no
 * conciliador.
 *
 * O painel é a entrega da tarefa: dashboard, uso, memória da IA, logs e dados do
 * dispositivo — tudo local e só depois do login do administrador. Aqui testamos
 * o HTML gerado (inclusive o escape do que o usuário digitou) e o que o
 * controlador precisa fazer para ele funcionar.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  ADMIN_TABS,
  adminGateMarkup,
  adminPanelHeadline,
  adminPanelMarkup,
  lastActiveDay,
  renderAdminPanel,
} from '../src/admin-panel.js';
import { normalizeUsage, recordEvent, addActiveTime, bumpCounter, startSession } from '../src/admin-usage.js';

const ROOT = new URL('../', import.meta.url);
const html = await readFile(new URL('conciliador.html', ROOT), 'utf8');
const indexHtml = await readFile(new URL('index.html', ROOT), 'utf8');
const page = await readFile(new URL('src/counterparty-page.js', ROOT), 'utf8');
const styles = await readFile(new URL('src/styles.css', ROOT), 'utf8');

const NOW = Date.parse('2026-11-11T14:30:00.000Z');

function sampleUsage() {
  const usage = normalizeUsage(null, NOW);
  startSession(usage, NOW);
  addActiveTime(usage, 90 * 60_000, NOW);
  bumpCounter(usage, 'reconciliations', 3, NOW);
  bumpCounter(usage, 'rowsReconciled', 120, NOW);
  bumpCounter(usage, 'exports', 2, NOW);
  recordEvent(usage, { type: 'conciliacao', message: 'Conciliação: 120 de 180', details: '12 para revisar' }, NOW);
  recordEvent(usage, { type: 'exportacao', message: 'PDF gerado', details: '180 lançamento(s)' }, NOW);
  return usage;
}

function baseCtx(overrides = {}) {
  return {
    tab: 'overview',
    usage: sampleUsage(),
    memory: {
      learnedProfiles: [{ id: 'a' }, { id: 'b', builtIn: true }],
      tokenWeights: { banco: 2 },
      layoutSignatures: [{ id: 'x' }],
      learningLog: [{ timestamp: new Date(NOW).toISOString(), message: 'Layout aprendido', details: 'Itaú' }],
      counterparties: { contacts: { 1: {} }, aliases: { x: '1' }, accounts: { byHistory: {}, byContact: { a: '1' } } },
    },
    device: { rows: [['Navegador', 'Chrome'], ['Sistema', 'Linux']] },
    cloud: { accessCode: 'GOG•••', lastSync: '11/11/2026, 14:00', host: 'abc.supabase.co', account: 'a@b.c', remote: 'sincronizado', auto: true },
    storage: { memory: '12,3 KB', usage: '4,1 KB', total: '40 KB', keys: 7 },
    sessionStartedAt: NOW - 10 * 60_000,
    logFilter: 'all',
    now: NOW,
    ...overrides,
  };
}

describe('painel do administrador: abas', () => {
  it('são seis, na ordem da marcação', () => {
    assert.deepEqual(
      ADMIN_TABS.map((tab) => tab.id),
      ['overview', 'usage', 'vaults', 'memory', 'logs', 'device']
    );
    const markup = adminPanelMarkup();
    const order = [
      'Visão geral',
      'Uso',
      'Códigos de acesso',
      'Memória da IA',
      'Logs',
      'Dispositivo e conta',
    ];
    let cursor = -1;
    for (const label of order) {
      const position = markup.indexOf(`>${label}<`, cursor + 1);
      assert.ok(position > cursor, `a aba "${label}" aparece na ordem certa`);
      cursor = position;
    }
  });

  it('cada aba tem o botão que o console procura', () => {
    const markup = adminPanelMarkup();
    for (const tab of ADMIN_TABS) {
      assert.match(markup, new RegExp(`data-cp-admin-tab="${tab.id}"`), `falta a aba ${tab.id}`);
    }
    assert.equal([...markup.matchAll(/data-cp-admin-tab="/g)].length, ADMIN_TABS.length);
  });

  it('as duas páginas recebem o mesmo painel (sem cópia no HTML)', () => {
    assert.equal(html.includes('id="cp-admin-panel"'), false, 'o conciliador não repete a marcação');
    assert.equal(indexHtml.includes('id="cp-admin-panel"'), false, 'a página principal também não');
    assert.match(html, /id="btn-gear"/, 'mas as duas têm a engrenagem');
    assert.match(indexHtml, /id="btn-gear"/);
  });

  it('cada aba gera conteúdo próprio', () => {
    const rendered = ADMIN_TABS.map((tab) => renderAdminPanel(baseCtx({ tab: tab.id })));
    rendered.forEach((body, index) => {
      assert.ok(body.length > 200, `a aba ${ADMIN_TABS[index].id} tem conteúdo`);
      assert.equal(/undefined|NaN|\[object Object\]/.test(body), false, `a aba ${ADMIN_TABS[index].id} não mostra undefined`);
    });
    assert.equal(new Set(rendered).size, ADMIN_TABS.length, 'as abas não repetem o mesmo conteúdo');
  });

  it('aba desconhecida cai na visão geral', () => {
    assert.equal(renderAdminPanel(baseCtx({ tab: 'inventada' })), renderAdminPanel(baseCtx({ tab: 'overview' })));
  });

  it('a visão geral traz os números do dashboard', () => {
    const body = renderAdminPanel(baseCtx());
    assert.match(body, /Tempo total de uso/);
    assert.match(body, /1 h 30 min/, 'tempo acumulado');
    assert.match(body, /Tempo nesta sessão/);
    assert.match(body, /10 min/, 'tempo da sessão aberta');
    assert.match(body, /Atividade dos últimos 14 dias/);
    assert.equal([...body.matchAll(/class="cp-admin-bar"/g)].length, 14, '14 barras no gráfico');
    assert.match(body, /Conciliações rodadas/);
    assert.match(body, /Últimos eventos/);
  });

  it('a aba de uso mostra contadores e o tempo por período', () => {
    const body = renderAdminPanel(baseCtx({ tab: 'usage' }));
    for (const label of [
      'Cadastros carregados',
      'Extratos carregados',
      'Conciliações rodadas',
      'Lançamentos vinculados',
      'Exportações geradas',
      'Erros registrados',
    ]) {
      assert.ok(body.includes(label), `falta o contador "${label}"`);
    }
    assert.match(body, /Últimos 7 dias/);
    assert.match(body, /Por tipo de evento/);
  });

  it('a aba da memória mostra o que a IA aprendeu e o espaço usado', () => {
    const body = renderAdminPanel(baseCtx({ tab: 'memory' }));
    assert.match(body, /O que a IA aprendeu/);
    assert.match(body, /Perfis de layout/);
    assert.match(body, /1 aprendido\(s\) aqui/, 'conta só os perfis não nativos');
    assert.match(body, /Armazenamento neste navegador/);
    assert.match(body, /12,3 KB/);
    assert.match(body, /Layout aprendido/);
    assert.match(body, /Só o tamanho dos dados/, 'avisa que o conteúdo não é guardado');
  });

  it('a aba de logs traz filtros e a tabela de eventos', () => {
    const body = renderAdminPanel(baseCtx({ tab: 'logs' }));
    assert.match(body, /id="cp-admin-log-table"/);
    assert.match(body, /data-cp-admin-log="all"/);
    assert.match(body, /data-cp-admin-log="conciliacao"/);
    assert.match(body, /data-cp-admin-log="exportacao"/);
    assert.equal([...body.matchAll(/<tr data-cp-admin-type=/g)].length, 2);
  });

  it('o filtro escolhido volta marcado e filtra as linhas', () => {
    const body = renderAdminPanel(baseCtx({ tab: 'logs', logFilter: 'exportacao' }));
    assert.match(body, /data-cp-admin-log="exportacao" aria-pressed="true"/);
    assert.match(body, /data-cp-admin-log="all" aria-pressed="false"/);
    const rows = [...body.matchAll(/<tr data-cp-admin-type="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(rows, ['exportacao'], 'só a exportação aparece');
  });

  it('a aba do dispositivo mostra navegador, nuvem e conta', () => {
    const body = renderAdminPanel(baseCtx({ tab: 'device' }));
    assert.match(body, /Este dispositivo/);
    assert.match(body, /Chrome/);
    assert.match(body, /Nuvem e conta/);
    assert.match(body, /abc\.supabase\.co/);
    assert.match(body, /sincronizado/);
  });

  it('aguenta dados vazios (primeiro uso)', () => {
    for (const tab of ADMIN_TABS.map((entry) => entry.id)) {
      const body = renderAdminPanel({ tab, usage: null });
      assert.ok(body.length > 100);
      assert.equal(/undefined|\bNaN\b/.test(body), false, `aba ${tab} limpa no primeiro uso`);
    }
    assert.match(renderAdminPanel({ tab: 'logs', usage: null }), /Nenhum evento registrado ainda/);
  });
});

describe('painel do administrador: segurança do conteúdo', () => {
  it('escapa o que veio do arquivo do usuário', () => {
    const usage = normalizeUsage(null, NOW);
    recordEvent(usage, { type: 'arquivo', message: '<img src=x onerror=alert(1)>', details: '"aspas" & <b>' }, NOW);
    const body = renderAdminPanel(baseCtx({ tab: 'logs', usage }));
    assert.equal(body.includes('<img src=x'), false, 'a mensagem não vira HTML');
    assert.ok(body.includes('&lt;img src=x'), 'o texto aparece escapado');
    assert.equal(body.includes('<b>'), false, 'os detalhes também são escapados');
  });

  it('escapa o nome do navegador e do aparelho', () => {
    const body = renderAdminPanel(
      baseCtx({ tab: 'device', device: { rows: [['Navegador', '<script>x</script>']] } })
    );
    assert.equal(body.includes('<script>'), false);
  });

  it('o cabeçalho resume sessões e tempo', () => {
    assert.equal(adminPanelHeadline(sampleUsage(), NOW), '1 sessão(ões) • 1 h 30 min de uso • 1 dia(s) com atividade');
    assert.equal(lastActiveDay(sampleUsage(), NOW), '11/11');
    assert.equal(lastActiveDay(normalizeUsage(null, NOW), NOW), '—');
  });
});

describe('painel do administrador: porta de entrada universal', () => {
  it('a marcação entrega o painel fechado e com todos os controles', () => {
    const markup = adminPanelMarkup();
    assert.match(markup, /id="cp-admin-panel"[\s\S]{0,120}aria-hidden="true"/);
    assert.match(markup, /id="cp-admin-panel"[\s\S]{0,80}class="modal-backdrop hidden"/);
    for (const id of [
      'cp-admin-title',
      'cp-admin-headline',
      'cp-admin-body',
      'btn-cp-admin-close',
      'btn-cp-admin-refresh',
      'btn-cp-admin-export',
      'btn-cp-admin-logs',
      'btn-cp-admin-reset',
      'btn-cp-admin-lock',
    ]) {
      assert.match(markup, new RegExp(`id="${id}"`), `falta #${id}`);
    }
  });

  it('sem login não vaza conteúdo: o corpo vem vazio', () => {
    assert.match(adminPanelMarkup(), /id="cp-admin-body"[^>]*>\s*<\/div>/, 'sem números na entrega');
  });

  it('o portão de senha também vem pronto do módulo', () => {
    const gate = adminGateMarkup();
    for (const id of ['admin-gate', 'admin-gate-form', 'admin-gate-user', 'admin-gate-password', 'admin-gate-error', 'btn-admin-gate-enter', 'btn-admin-gate-close']) {
      assert.match(gate, new RegExp(`id="${id}"`), `falta #${id}`);
    }
    assert.match(gate, /type="password"/);
  });

  it('o CSS do painel acompanha o HTML', () => {
    for (const rule of [
      '.cp-admin-panel-card',
      '.cp-admin-grid',
      '.cp-admin-card',
      '.cp-admin-chart',
      '.cp-admin-bar',
      '.cp-admin-table',
      '.cp-admin-tag',
      '.cp-admin-filters',
      '.cp-admin-dl',
      '.cp-admin-actions',
      '.cp-admin-summary',
      '.gear-menu',
      '.gear-item',
      '.admin-gate-card',
    ]) {
      assert.ok(styles.includes(rule), `falta ${rule} em styles.css`);
    }
    // A grade é fluida (auto-fit): era o `repeat(4, …)` fixo que espremia os
    // cartões no tablet e estourava no celular.
    assert.match(styles, /\.cp-admin-grid \{[^}]*auto-fit/);
    // O corpo que rola precisa poder encolher, senão a barra de ações é cortada.
    assert.match(styles, /#cp-admin-body \{[^}]*min-height: 0/);
    assert.match(styles, /@media \(max-width: 560px\)[\s\S]*\.cp-admin-bar em \{[^}]*display: none/);
    for (const rule of ['.cp-vault-item', '.cp-vault-actions', '.cp-vault-notice', '.cp-vault-badge']) {
      assert.ok(styles.includes(rule), `falta ${rule} em styles.css`);
    }
  });
});
