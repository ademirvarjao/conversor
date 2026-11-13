/**
 * Painel da memória do conciliador — visível só para o administrador.
 *
 * O resumo "Memória: N históricos • N contatos…" mostra quanto a IA já aprendeu
 * e é informação de administração: fica escondido (e sem texto no DOM) até o
 * dono entrar com login e senha, na mesma trava usada para a conexão do banco.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { CLOUD_LOCK, MAX_ATTEMPTS, UNLOCK_KEY, clearUnlock, loadUnlock, saveUnlock } from '../src/cloud-lock.js';

const html = await readFile(new URL('../conciliador.html', import.meta.url), 'utf8');
const page = await readFile(new URL('../src/counterparty-page.js', import.meta.url), 'utf8');
const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');

function fakeStorage() {
  const data = new Map();
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

describe('o resumo da memória é só do administrador', () => {
  it('o HTML entrega o resumo vazio e escondido', () => {
    const tag = /<span[^>]*id="cp-memory-state"[^>]*>/.exec(html)?.[0] || '';
    assert.ok(tag, '#cp-memory-state existe');
    assert.match(tag, /\bhidden\b/, 'começa escondido');
    assert.match(html, /<span[^>]*id="cp-memory-state"[^>]*>\s*<\/span>/, 'sem texto antes do login');
    assert.equal(/Memória: carregando/.test(html), false, 'nada de resumo na entrega');
  });

  it('há um portão de login e senha no topo', () => {
    for (const id of ['btn-cp-admin', 'cp-admin-gate', 'cp-admin-user', 'cp-admin-password', 'btn-cp-admin-enter', 'cp-admin-error']) {
      assert.match(html, new RegExp(`id="${id}"`), `falta #${id}`);
    }
    const gate = /<form[^>]*id="cp-admin-gate"[^>]*>/.exec(html)?.[0] || '';
    assert.match(gate, /class="[^"]*hidden/, 'o formulário começa fechado');
    // O campo de senha é do tipo password (nada de senha à mostra).
    assert.match(html, /id="cp-admin-password"[^>]*type="password"|type="password"[^>]*id="cp-admin-password"/);
  });

  it('o controlador só mostra o resumo depois de validar a senha', () => {
    const render = page.slice(page.indexOf('function renderMemoryState'), page.indexOf('function renderMemoryState') + 900);
    assert.match(render, /adminUnlocked\(\)/, 'consulta o desbloqueio antes de mostrar');
    assert.match(render, /element\.textContent = '';/, 'limpa o texto quando está bloqueado');
    assert.match(render, /classList\.toggle\('hidden', !show\)/);

    assert.match(page, /function adminUnlocked\(\)[\s\S]{0,220}loadUnlock\(\)/, 'expira junto com a trava');
    assert.match(page, /await verifyCloudCredentials\(user, password\)/, 'confere login e senha');
    assert.match(page, /saveUnlock\(\)/, 'guarda o desbloqueio na sessão da aba');
    assert.match(page, /MAX_ATTEMPTS/, 'usa o mesmo limite de tentativas');
    assert.match(page, new RegExp(`LOCKOUT_MS`), 'e a mesma espera');
  });

  it('a página principal continua publicando o desbloqueio', () => {
    // Mesma trava: quem libera na aba Nuvem vê o painel aqui (mesma sessão).
    assert.match(app, /saveUnlock\(\)/);
    assert.equal(CLOUD_LOCK.user, 'gogita');
    assert.ok(MAX_ATTEMPTS >= 3);
  });

  it('o desbloqueio vale 1 hora e é descartado quando expira', () => {
    const storage = fakeStorage();
    const agora = 1_800_000_000_000;
    saveUnlock(storage, { now: agora });
    assert.ok(loadUnlock(storage, agora + 1000), 'válido logo depois');
    assert.equal(loadUnlock(storage, agora + 60 * 60 * 1000 + 1), null, 'expira em 1 hora');
    assert.equal(storage.data.has(UNLOCK_KEY), false, 'registro vencido é apagado');

    saveUnlock(storage, { now: agora });
    clearUnlock(storage);
    assert.equal(loadUnlock(storage, agora + 1000), null, 'bloquear na página principal esconde aqui também');
  });
});
