import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_KEY,
  clearSession,
  currentAccessToken,
  describeSession,
  isSessionExpired,
  loadSession,
  normalizeSession,
  refreshSession,
  saveSession,
  signIn,
  signOut,
  signUp,
} from '../src/cloud-auth.js';
import { fetchRemoteVault, saveRemoteVault } from '../src/sync-client.js';

const CONFIG = { url: 'https://projeto.supabase.co', anonKey: 'chave-publica-de-teste-1234567890' };

function fakeStorage() {
  const data = new Map();
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

/** Backend falso do GoTrue: registra a requisição e devolve o que o teste mandar. */
function fakeAuth(responder) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body });
    const { status = 200, body = {} } = responder(url, init) || {};
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
  return { calls, fetchImpl };
}

const sessionBody = (overrides = {}) => ({
  access_token: 'token-abc',
  refresh_token: 'refresh-abc',
  expires_in: 3600,
  user: { id: 'user-1', email: 'eu@exemplo.com' },
  ...overrides,
});

test('entrar manda e-mail/senha para o GoTrue e guarda a sessão', async () => {
  const storage = fakeStorage();
  const backend = fakeAuth(() => ({ body: sessionBody() }));

  const session = await signIn(CONFIG, '  Eu@Exemplo.com ', 'segredo123', {
    fetchImpl: backend.fetchImpl,
    storage,
    now: 1_000,
  });

  assert.equal(session.accessToken, 'token-abc');
  assert.equal(session.email, 'eu@exemplo.com');
  assert.equal(session.expiresAt, 1_000 + 3600 * 1000);

  const call = backend.calls[0];
  assert.equal(call.url, 'https://projeto.supabase.co/auth/v1/token?grant_type=password');
  assert.equal(call.headers.apikey, CONFIG.anonKey);
  assert.deepEqual(JSON.parse(call.body), { email: 'eu@exemplo.com', password: 'segredo123' });

  const saved = loadSession(storage);
  assert.equal(saved.accessToken, 'token-abc');
  // A senha nunca é guardada.
  assert.equal(JSON.stringify(storage.data.get(SESSION_KEY)).includes('segredo123'), false);
});

test('senha errada vira mensagem clara em português', async () => {
  const backend = fakeAuth(() => ({
    status: 400,
    body: { error_code: 'invalid_credentials', msg: 'Invalid login credentials' },
  }));

  await assert.rejects(
    () => signIn(CONFIG, 'eu@exemplo.com', 'errada', { fetchImpl: backend.fetchImpl, storage: fakeStorage() }),
    /E-mail ou senha incorretos/i
  );
});

test('e-mail ainda não confirmado tem instrução própria', async () => {
  const backend = fakeAuth(() => ({
    status: 400,
    body: { error_code: 'email_not_confirmed', msg: 'Email not confirmed' },
  }));

  await assert.rejects(
    () => signIn(CONFIG, 'eu@exemplo.com', 'senha1234', { fetchImpl: backend.fetchImpl, storage: fakeStorage() }),
    /Confirme o e-mail/i
  );
});

test('criar conta sem sessão = precisa confirmar e-mail', async () => {
  const storage = fakeStorage();
  const backend = fakeAuth(() => ({ body: { id: 'user-1', email: 'eu@exemplo.com' } }));

  const result = await signUp(CONFIG, 'eu@exemplo.com', 'senha12345', {
    fetchImpl: backend.fetchImpl,
    storage,
  });

  assert.equal(result.needsConfirmation, true);
  assert.equal(result.session, null);
  assert.equal(backend.calls[0].url, 'https://projeto.supabase.co/auth/v1/signup');
  assert.equal(loadSession(storage), null);
});

test('criar conta com sessão (confirmação desligada) já entra', async () => {
  const storage = fakeStorage();
  const backend = fakeAuth(() => ({ body: sessionBody() }));

  const result = await signUp(CONFIG, 'eu@exemplo.com', 'senha12345', { fetchImpl: backend.fetchImpl, storage });

  assert.equal(result.needsConfirmation, false);
  assert.equal(result.session.accessToken, 'token-abc');
  assert.equal(loadSession(storage)?.userId, 'user-1');
});

test('senha curta é recusada antes de chamar a rede', async () => {
  const backend = fakeAuth(() => ({ body: sessionBody() }));
  await assert.rejects(
    () => signUp(CONFIG, 'eu@exemplo.com', 'curta', { fetchImpl: backend.fetchImpl, storage: fakeStorage() }),
    /pelo menos 8/i
  );
  assert.equal(backend.calls.length, 0);
});

test('token vencido é renovado sozinho antes de consultar o banco', async () => {
  const storage = fakeStorage();
  saveSession(
    normalizeSession({ ...sessionBody(), expires_at: 5_000 }, 0),
    storage
  );
  const backend = fakeAuth(() => ({
    body: sessionBody({ access_token: 'token-novo', refresh_token: 'refresh-novo' }),
  }));

  const token = await currentAccessToken(CONFIG, { storage, fetchImpl: backend.fetchImpl, now: 6_000 });

  assert.equal(token, 'token-novo');
  assert.equal(backend.calls[0].url, 'https://projeto.supabase.co/auth/v1/token?grant_type=refresh_token');
  assert.equal(loadSession(storage).accessToken, 'token-novo');
});

test('sem conta o app segue com a chave anônima (cofres antigos)', async () => {
  const storage = fakeStorage();
  assert.equal(await currentAccessToken(CONFIG, { storage, fetchImpl: async () => assert.fail('não deve chamar') }), '');
  assert.equal(loadSession(storage), null);
});

test('renovação recusada limpa a sessão e volta para anônimo', async () => {
  const storage = fakeStorage();
  saveSession(normalizeSession({ ...sessionBody(), expires_at: 5_000 }, 0), storage);
  const backend = fakeAuth(() => ({ status: 400, body: { error: 'invalid_grant' } }));

  const token = await currentAccessToken(CONFIG, { storage, fetchImpl: backend.fetchImpl, now: 6_000 });

  assert.equal(token, '');
  assert.equal(loadSession(storage), null, 'sessão inválida é descartada');
});

test('renovar sem refresh token não quebra: só limpa', async () => {
  const storage = fakeStorage();
  saveSession(normalizeSession({ access_token: 'x', expires_at: 1_000 }, 0), storage);

  await assert.rejects(
    () => refreshSession(CONFIG, loadSession(storage), { storage, fetchImpl: async () => assert.fail('sem rede') }),
    /entre de novo/i
  );
});

test('sair avisa o servidor e apaga a sessão local', async () => {
  const storage = fakeStorage();
  saveSession(normalizeSession(sessionBody(), 0), storage);
  const backend = fakeAuth(() => ({ status: 204, body: {} }));

  await signOut(CONFIG, loadSession(storage), { storage, fetchImpl: backend.fetchImpl });

  assert.equal(backend.calls[0].url, 'https://projeto.supabase.co/auth/v1/logout');
  assert.equal(backend.calls[0].headers.Authorization, 'Bearer token-abc');
  assert.equal(loadSession(storage), null);
  assert.equal(clearSession(storage), true);
});

test('expiração considera margem de 1 minuto e descrição da conta', () => {
  const session = normalizeSession(sessionBody(), 0);
  assert.equal(isSessionExpired(session, 0), false);
  assert.equal(isSessionExpired(session, 3600 * 1000 - 30_000), true, 'margem de segurança');
  assert.equal(isSessionExpired(null, 0), true);
  assert.match(describeSession(session), /eu@exemplo\.com/);
  assert.match(describeSession(null), /Sem conta/i);
});

test('com conta, as consultas ao banco vão com o token do usuário (RLS)', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, headers: init.headers || {} });
    return { ok: true, status: 200, json: async () => [] };
  };

  await fetchRemoteVault(CONFIG, 'slot-1', { fetchImpl, accessToken: 'token-do-dono' });
  await saveRemoteVault(CONFIG, 'slot-1', 'v1.cifrado', { fetchImpl, accessToken: 'token-do-dono' });
  await fetchRemoteVault(CONFIG, 'slot-1', { fetchImpl });

  assert.equal(calls[0].headers.Authorization, 'Bearer token-do-dono');
  assert.equal(calls[1].headers.Authorization, 'Bearer token-do-dono');
  assert.equal(calls[1].headers.apikey, CONFIG.anonKey, 'a chave pública continua no apikey');
  assert.equal(calls[2].headers.Authorization, `Bearer ${CONFIG.anonKey}`, 'sem conta vai a anônima');
});

test('cofre de outra conta (RLS) explica o que fazer', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 403,
    json: async () => ({ code: '42501', message: 'new row violates row-level security policy' }),
  });

  await assert.rejects(
    () => saveRemoteVault(CONFIG, 'slot-1', 'v1.cifrado', { fetchImpl, accessToken: 'token' }),
    /pertence a outra conta|RLS|não tem acesso/i
  );
});
