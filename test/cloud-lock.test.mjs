import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLOUD_LOCK,
  LOCKOUT_MS,
  MAX_ATTEMPTS,
  UNLOCK_KEY,
  UNLOCK_TTL_MS,
  clearUnlock,
  loadUnlock,
  saveUnlock,
  verifyCloudCredentials,
} from '../src/cloud-lock.js';

/** Senha usada apenas neste teste, com salt/hash próprios (não é a do app). */
const TEST_LOCK = { user: 'teste', salt: 'AAAAAAAAAAAAAAAAAAAAAA==', iterations: 1000, hash: '' };

const base64 = (bytes) => Buffer.from(bytes).toString('base64');

async function hashPassword(password, lock) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: Buffer.from(lock.salt, 'base64'), iterations: lock.iterations },
    key,
    256
  );
  return base64(new Uint8Array(bits));
}

function fakeStorage() {
  const data = new Map();
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

const lock = { ...TEST_LOCK, hash: await hashPassword('Senha#123', TEST_LOCK) };

test('aceita a senha certa e recusa a errada', async () => {
  assert.equal(await verifyCloudCredentials('teste', 'Senha#123', { lock }), true);
  assert.equal(await verifyCloudCredentials('TESTE', 'Senha#123', { lock }), true, 'login sem caixa');
  assert.equal(await verifyCloudCredentials('teste', 'senha#123', { lock }), false);
  assert.equal(await verifyCloudCredentials('teste', 'Senha#1234', { lock }), false);
  assert.equal(await verifyCloudCredentials('outro', 'Senha#123', { lock }), false);
  assert.equal(await verifyCloudCredentials('', '', { lock }), false);
  assert.equal(await verifyCloudCredentials('teste', '', { lock }), false);
});

test('a senha publicada no app não é texto puro e tem parâmetros fortes', () => {
  assert.ok(CLOUD_LOCK.hash.length > 20, 'hash presente');
  assert.ok(CLOUD_LOCK.salt.length > 10, 'salt presente');
  assert.ok(!/senha|password/i.test(CLOUD_LOCK.hash), 'hash não contém a senha');
  assert.ok(CLOUD_LOCK.iterations >= 200000, 'muitas iterações de PBKDF2');
  assert.equal(CLOUD_LOCK.iterations, 210000);
  // A senha em si nunca aparece no módulo.
  assert.ok(!JSON.stringify(CLOUD_LOCK).includes('Gogita'), 'nenhum texto da senha no módulo');
});

test('login errado no app real não abre a aba', async () => {
  assert.equal(await verifyCloudCredentials('gogita', 'senha-errada'), false);
  assert.equal(await verifyCloudCredentials('gogita', '', ), false);
});

test('desbloqueio vale por 1 hora e é por aba do navegador', () => {
  const storage = fakeStorage();
  const now = 1_000_000;
  assert.equal(loadUnlock(storage, now), null, 'começa bloqueado');

  assert.equal(saveUnlock(storage, { now }), true);
  const saved = JSON.parse(storage.data.get(UNLOCK_KEY));
  assert.equal(saved.expiresAt, now + UNLOCK_TTL_MS);

  assert.equal(loadUnlock(storage, now + 1000)?.user, CLOUD_LOCK.user);
  assert.equal(loadUnlock(storage, now + UNLOCK_TTL_MS + 1), null, 'expira');
  assert.equal(storage.data.has(UNLOCK_KEY), false, 'registro vencido é removido');

  saveUnlock(storage, { now });
  clearUnlock(storage);
  assert.equal(loadUnlock(storage, now), null, 'bloquear limpa o registro');
});

test('registro quebrado no armazenamento não libera a aba', () => {
  const storage = fakeStorage();
  storage.setItem(UNLOCK_KEY, '{oops');
  assert.equal(loadUnlock(storage), null);
  storage.setItem(UNLOCK_KEY, JSON.stringify({ user: 'gogita' }));
  assert.equal(loadUnlock(storage), null, 'sem expiração válida = bloqueado');
});

test('limites de tentativa e espera são explícitos', () => {
  assert.equal(MAX_ATTEMPTS, 5);
  assert.equal(LOCKOUT_MS, 30_000);
});
