/**
 * Painel do administrador — acesso universal pela engrenagem.
 *
 * Até a v1.25 o painel vivia só no conciliador, atrás de um botão "Administrador"
 * e de um resumo da memória no topo. Agora:
 *   • a **engrenagem** aparece nas duas páginas e abre o mesmo menu;
 *   • o painel é o mesmo nas duas (marcação injetada por `adminPanelMarkup`);
 *   • o resumo "Memória: N históricos…" **só** existe dentro do painel;
 *   • sem o desbloqueio (1 hora por aba) o painel não abre — e o HTML entregue
 *     ao navegador não traz número nenhum.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { CLOUD_LOCK, MAX_ATTEMPTS, UNLOCK_KEY, clearUnlock, loadUnlock, saveUnlock } from '../src/cloud-lock.js';
import { adminGateMarkup, adminPanelMarkup } from '../src/admin-panel.js';
import { memorySummary } from '../src/admin-console.js';

const index = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const conciliador = await readFile(new URL('../conciliador.html', import.meta.url), 'utf8');
const page = await readFile(new URL('../src/counterparty-page.js', import.meta.url), 'utf8');
const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const console_ = await readFile(new URL('../src/admin-console.js', import.meta.url), 'utf8');
const panel = await readFile(new URL('../src/admin-panel.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

function fakeStorage() {
  const data = new Map();
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

describe('a engrenagem está nas duas páginas', () => {
  it('as duas páginas têm o botão da engrenagem com o mesmo contrato', () => {
    for (const [nome, html] of [['index.html', index], ['conciliador.html', conciliador]]) {
      const tag = /<button[^>]*id="btn-gear"[^>]*>/.exec(html)?.[0] || '';
      assert.ok(tag, `${nome} sem #btn-gear`);
      assert.match(tag, /aria-haspopup="menu"/, `${nome}: o botão abre um menu`);
      assert.match(tag, /aria-controls="gear-menu"/, `${nome}: aponta para o menu`);
      assert.match(tag, /aria-expanded="false"/, `${nome}: começa fechado`);
      assert.match(html, /class="btn-gear"/);
    }
  });

  it('a engrenagem mostra o ícone e não depende de texto', () => {
    assert.match(conciliador, /id="btn-gear"[\s\S]{0,2000}?class="gear-icon"/, 'ícone no conciliador');
    assert.match(index, /class="gear-icon"/, 'ícone na página principal');
    assert.match(index, /id="ai-profiles-badge"/, 'o contador de perfis continua no botão');
  });

  it('o botão antigo "Administrador" e o formulário no topo saíram do conciliador', () => {
    for (const id of ['btn-cp-admin', 'cp-admin-gate', 'cp-admin-user', 'cp-admin-password', 'cp-admin-error']) {
      assert.equal(conciliador.includes(`id="${id}"`), false, `#${id} não deveria existir`);
    }
    assert.equal(conciliador.includes('>Administrador<'), false, 'sem botão "Administrador"');
  });

  it('a engrenagem existe no contrato das duas páginas', () => {
    assert.ok(app.includes("'btn-gear'") || index.includes('id="btn-gear"'));
    assert.match(page, /'btn-gear'/, 'o conciliador confere o id no cache do DOM');
    assert.match(page, /mountGearMenu\(/, 'e monta o menu');
    assert.match(app, /mountGearMenu\(/, 'a página principal também monta o menu');
  });
});

describe('o resumo da memória vive só dentro do painel', () => {
  it('o conciliador não tem mais o resumo na barra', () => {
    assert.equal(conciliador.includes('cp-memory-state'), false, 'nenhum resumo no HTML do conciliador');
    assert.equal(conciliador.includes('Memória: '), false, 'nenhum número de memória na entrega');
    assert.equal(page.includes('cp-memory-state'), false, 'o controlador não procura mais o elemento');
  });

  it('o painel monta o resumo a partir da memória', () => {
    const memory = {
      counterparties: {
        contacts: {
          '1': { name: 'Fornecedor A', natureza: 'credora', hits: 2 },
          '2': { name: 'Cliente B', natureza: 'devedora', hits: 1 },
        },
        aliases: { 'pagamento fornecedor a': '1' },
        accounts: {
          byHistory: { 'pagamento fornecedor a': { debit: '', credit: '500046', hits: 2 } },
          byContact: { '1': { debit: '', credit: '500046', hits: 2 } },
        },
      },
    };
    const summary = memorySummary(memory);
    assert.equal(summary.byHistory, 1);
    assert.equal(summary.byContact, 1);
    assert.equal(summary.contacts, 2);
    assert.equal(summary.text, 'Memória: 1 histórico(s) • 1 contato(s) com conta • 2 contato(s) conciliado(s)');
    assert.match(panel, /memorySummaryCard/, 'o painel desenha o resumo');
    assert.match(panel, /Memória: nenhuma conta memorizada ainda/);
  });

  it('memória sem nada aprendido tem texto próprio (sem zeros soltos)', () => {
    const summary = memorySummary({ counterparties: {} });
    assert.equal(summary.text, 'Memória: nenhuma conta memorizada ainda');
    assert.equal(summary.total, 0);
  });

  it('o resumo aparece na visão geral e na aba da memória', () => {
    const overview = panel.slice(panel.indexOf('function overviewTab'), panel.indexOf('function usageTab'));
    const memoryTab = panel.slice(panel.indexOf('function memoryTab'), panel.indexOf('function logsTab'));
    assert.match(overview, /memorySummaryCard\(ctx\)/);
    assert.match(memoryTab, /memorySummaryCard\(ctx\)/);
  });
});

describe('acesso: senha do administrador, 1 hora por aba', () => {
  it('o painel e o portão começam fechados e sem dados', () => {
    const painel = adminPanelMarkup();
    const portao = adminGateMarkup();
    assert.match(painel, /id="cp-admin-panel"[\s\S]{0,120}class="modal-backdrop hidden"/);
    assert.match(painel, /aria-hidden="true"/);
    assert.match(portao, /id="admin-gate"[\s\S]{0,120}class="modal-backdrop hidden"/);
    assert.match(portao, /id="admin-gate-password"[^>]*type="password"/);
    assert.equal(/Memória: \d/.test(painel), false, 'nenhum número na marcação');
    assert.match(painel, /id="cp-admin-body"[^>]*>\s*<\/div>/, 'corpo vazio até alguém entrar');
  });

  it('o console confere a senha e guarda o desbloqueio', () => {
    assert.match(console_, /await verifyCloudCredentials\(user, password\)/);
    assert.match(console_, /saveUnlock\(\)/);
    assert.match(console_, /MAX_ATTEMPTS/);
    assert.match(console_, /LOCKOUT_MS/);
    assert.match(console_, /clearUnlock\(\)/, 'dá para bloquear de novo');
  });

  it('sem desbloqueio o painel não abre: abre o portão', () => {
    assert.match(console_, /function open\(tab\) \{\s*if \(!isUnlocked\(\)\)/);
    assert.match(console_, /openGate\(\)/);
  });

  it('quem desbloqueou em outra página não digita de novo', () => {
    const storage = fakeStorage();
    const agora = Date.now();
    saveUnlock(storage, { now: agora });
    assert.ok(loadUnlock(storage, agora + 1000), 'desbloqueio válido');
    assert.equal(loadUnlock(storage, agora + 60 * 60 * 1000 + 1), null, 'expira em 1 hora');
    saveUnlock(storage, { now: agora });
    clearUnlock(storage);
    assert.equal(loadUnlock(storage, agora + 1000), null, 'bloquear vale para as duas páginas');
    assert.match(console_, /adoptStoredUnlock\(\)/);
  });

  it('o console é o mesmo nas duas páginas', () => {
    assert.match(app, /createAdminConsole\(\{[\s\S]{0,200}page: 'conversor'/);
    assert.match(page, /createAdminConsole\(\{[\s\S]{0,200}page: 'conciliador'/);
    assert.equal(page.includes('verifyCloudCredentials'), false, 'o conciliador não confere senha por conta própria');
    assert.equal(app.split('verifyCloudCredentials').length - 1, 2, 'na página principal: import + uso na aba Nuvem');
  });

  it('a senha em texto puro continua fora do repositório', () => {
    assert.equal(CLOUD_LOCK.user, 'gogita');
    assert.ok(MAX_ATTEMPTS >= 3);
    assert.doesNotMatch(JSON.stringify(CLOUD_LOCK), /Gmj63975/);
    assert.doesNotMatch(panel + console_, /Gmj63975/);
  });

  it('o menu mostra o estado do acesso (fechado × aberto) e a opção de bloquear', () => {
    assert.match(styles, /\.gear-item\.is-locked/);
    assert.match(styles, /\.gear-item\.is-ok/);
    assert.match(panel, /id="btn-cp-admin-lock"/, 'botão de bloquear dentro do painel');
  });
});
