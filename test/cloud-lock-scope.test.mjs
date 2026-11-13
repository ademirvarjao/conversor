import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { CLOUD_LOCK } from '../src/cloud-lock.js';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const conciliador = await readFile(new URL('../src/counterparty-page.js', import.meta.url), 'utf8');

/** Recorta o trecho do HTML entre a abertura de um id e o fechamento do bloco. */
function blockOf(id) {
  const start = html.indexOf(`id="${id}"`);
  assert.ok(start > 0, `#${id} existe no HTML`);
  return html.slice(start, start + 4000);
}

test('a aba Nuvem abre sem login (a trava não esconde mais a nuvem)', () => {
  assert.match(html, /<div id="cloud-panel">/, 'painel sem classe hidden');
  assert.doesNotMatch(html, /<div id="cloud-panel" class="hidden">/);
  // Nada de esconder a chave de acesso.
  assert.doesNotMatch(app, /••••-••••/);
  assert.match(app, /codeEl\.textContent = hasKey \? shown : 'criar agora';/);
});

test('a trava protege a conexão do banco (área administrativa)', () => {
  const admin = blockOf('cloud-admin-panel');
  assert.match(admin, /class="hidden"/, 'painel administrativo começa escondido');

  const adminStart = html.indexOf('id="cloud-admin-panel"');
  const gateStart = html.indexOf('id="cloud-lock-gate"');
  const urlIndex = html.indexOf('id="cloud-url"');
  const keyIndex = html.indexOf('id="cloud-anon-key"');

  assert.ok(gateStart > 0 && gateStart < adminStart, 'formulário vem antes do painel');
  assert.ok(urlIndex > adminStart, 'Project URL dentro da área protegida');
  assert.ok(keyIndex > adminStart, 'chave pública dentro da área protegida');
  // Os campos escondidos estão antes do fim do bloco administrativo (o detalhe
  // de fechamento vem depois do botão de bloquear).
  const adminEnd = html.indexOf('id="btn-cloud-lock"') + 200;
  assert.ok(urlIndex < adminEnd && keyIndex < adminEnd, 'área administrativa contém só a conexão');

  // A chave continua fora da área protegida (e a sincronização não pede senha:
  // ela é automática desde a v1.23, sem botões).
  assert.ok(html.indexOf('id="cloud-code-display"') < adminStart, 'chave de acesso visível para todos');
  assert.equal(html.includes('btn-cloud-push'), false, 'não há mais botão de enviar');
  assert.equal(html.includes('btn-cloud-pull'), false, 'não há mais botão de baixar');
});

test('os cliques na chave e a sincronização não passam pela trava', () => {
  const keyHandler = app.slice(
    app.indexOf("dom['btn-cloud-key']?.addEventListener"),
    app.indexOf("dom['btn-cloud-key']?.addEventListener") + 600
  );
  assert.ok(keyHandler.length > 50);
  assert.doesNotMatch(keyHandler, /cloud\.locked/, 'clique na chave não pede senha');

  assert.doesNotMatch(app, /if \(cloud\.locked\) \{\s*if \(!silent\)/, 'envio não é barrado pela trava');
  assert.match(app, /function scheduleCloudPush\(\) \{\n  if \(!cloud\.config \|\| !cloud\.identity\) return;/);
  assert.match(app, /function scheduleCloudPull\(/, 'o download também é automático');
  // No conciliador a trava não fica no caminho da sincronização: ela só abre o
  // painel da memória (informação de administração).
  const pushBody = conciliador.slice(conciliador.indexOf('async function pushModels'), conciliador.indexOf('async function pullModels'));
  const pullBody = conciliador.slice(conciliador.indexOf('async function pullModels'), conciliador.indexOf('function describeIdentity'));
  for (const [nome, corpo] of [['envio', pushBody], ['download', pullBody]]) {
    assert.ok(corpo.length > 200, `corpo do ${nome} encontrado`);
    assert.doesNotMatch(corpo, /adminConsole|loadUnlock|verifyCloudCredentials/, `${nome} não passa pela senha`);
  }
  assert.match(conciliador, /createAdminConsole\(/, 'a trava do conciliador é só do painel do administrador');
});

test('a configuração da trava continua sendo só hash (sem senha em texto puro)', () => {
  assert.equal(CLOUD_LOCK.user, 'gogita');
  assert.ok(CLOUD_LOCK.iterations >= 200000);
  assert.doesNotMatch(JSON.stringify(CLOUD_LOCK), /Gmj63975/);
});
