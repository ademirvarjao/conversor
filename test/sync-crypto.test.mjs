import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CODE_ALPHABET,
  CODE_LENGTH,
  PBKDF2_ITERATIONS,
  decryptPayload,
  deriveAccessKeys,
  encryptPayload,
  formatAccessCode,
  generateAccessCode,
  normalizeAccessCode,
} from '../src/sync-crypto.js';

/** Iterações baixas deixam o teste rápido (o valor de produção é conferido abaixo). */
const FAST = 1000;

test('alfabeto não tem caracteres ambíguos (0 O 1 I)', () => {
  assert.equal(CODE_LENGTH, 8);
  for (const char of ['0', 'O', '1', 'I']) {
    assert.equal(CODE_ALPHABET.includes(char), false, `alfabeto não deve conter ${char}`);
  }
  assert.equal(new Set(CODE_ALPHABET).size, CODE_ALPHABET.length, 'alfabeto sem repetição');
  assert.equal(CODE_ALPHABET.length, 32, '32 símbolos = 40 bits em 8 caracteres');
});

test('produção usa PBKDF2 caro', () => {
  assert.ok(PBKDF2_ITERATIONS >= 300000, `iterações de produção: ${PBKDF2_ITERATIONS}`);
});

test('generateAccessCode devolve chave válida e diferente a cada chamada', () => {
  const codes = new Set();
  for (let i = 0; i < 40; i += 1) {
    const code = generateAccessCode();
    assert.equal(code.length, CODE_LENGTH);
    assert.equal(normalizeAccessCode(code), code);
    codes.add(code);
  }
  // Com 32^8 possibilidades, 40 chaves devem ser todas distintas.
  assert.equal(codes.size, 40);
});

test('normalizeAccessCode aceita digitação livre', () => {
  assert.equal(normalizeAccessCode('abcd-efgh'), 'ABCDEFGH');
  assert.equal(normalizeAccessCode(' abcd efgh '), 'ABCDEFGH');
  assert.equal(normalizeAccessCode('ABCD_EFGH'), 'ABCDEFGH');
  assert.equal(normalizeAccessCode('abcd.efgh'), 'ABCDEFGH');
  // L existe no alfabeto (o dígito 1 não), então "l" minúsculo é L.
  assert.equal(normalizeAccessCode('abcd-efgl'), 'ABCDEFGL');
});

test('normalizeAccessCode recusa símbolos ambíguos em vez de adivinhar', () => {
  // 0, O, 1 e I nunca aparecem numa chave: são erro de digitação.
  assert.equal(normalizeAccessCode('A0CD-EFGH'), null);
  assert.equal(normalizeAccessCode('AOCD-EFGH'), null);
  assert.equal(normalizeAccessCode('AB1D-EFGH'), null);
  assert.equal(normalizeAccessCode('ABID-EFGH'), null);
  // Tamanho errado também é recusado.
  assert.equal(normalizeAccessCode('ABCD-EFG'), null);
  assert.equal(normalizeAccessCode('ABCD-EFGHJ'), null);
  assert.equal(normalizeAccessCode('ABCD-EF#H'), null);
  assert.equal(normalizeAccessCode(''), null);
  assert.equal(normalizeAccessCode(null), null);
});

test('formatAccessCode mostra no formato ABCD-EFGH', () => {
  assert.equal(formatAccessCode('ABCDEFGH'), 'ABCD-EFGH');
  assert.equal(formatAccessCode('abcd-efgh'), 'ABCD-EFGH');
  assert.equal(formatAccessCode('invalida'), '');
});

test('derivação é determinística e o slot não revela a chave', async () => {
  const a = await deriveAccessKeys('ABCDEFGH', { iterations: FAST });
  const b = await deriveAccessKeys('abcd-efgh', { iterations: FAST });

  assert.equal(a.code, 'ABCDEFGH');
  assert.equal(a.slot, b.slot, 'mesma chave sempre gera o mesmo slot');
  assert.match(a.slot, /^[0-9a-f]{32}$/);
  assert.equal(a.slot.includes('ABCDEFGH'), false);

  const outro = await deriveAccessKeys('ZZZZZZZZ', { iterations: FAST });
  assert.notEqual(outro.slot, a.slot, 'chaves diferentes caem em slots diferentes');
});

test('cifra e decifra um pacote com AES-GCM', async () => {
  const { aesKey } = await deriveAccessKeys('ABCDEFGH', { iterations: FAST });
  const payload = { v: 1, profiles: [{ nome: 'Itaú — Recebimentos' }], total: 293 };

  const envelope = await encryptPayload(aesKey, payload);
  assert.equal(typeof envelope, 'string');
  assert.ok(envelope.startsWith('v1.'), `envelope: ${envelope.slice(0, 12)}…`);
  assert.equal(envelope.includes('Recebimentos'), false, 'texto claro não aparece');

  const back = await decryptPayload(aesKey, envelope);
  assert.deepEqual(back, payload);
});

test('dois envelopes do mesmo pacote são diferentes (IV aleatório)', async () => {
  const { aesKey } = await deriveAccessKeys('ABCDEFGH', { iterations: FAST });
  const first = await encryptPayload(aesKey, { a: 1 });
  const second = await encryptPayload(aesKey, { a: 1 });
  assert.notEqual(first, second);
  assert.deepEqual(await decryptPayload(aesKey, first), { a: 1 });
  assert.deepEqual(await decryptPayload(aesKey, second), { a: 1 });
});

test('chave errada não abre o envelope', async () => {
  const right = await deriveAccessKeys('ABCDEFGH', { iterations: FAST });
  const wrong = await deriveAccessKeys('ZZZZZZZZ', { iterations: FAST });
  const envelope = await encryptPayload(right.aesKey, { segredo: true });

  await assert.rejects(() => decryptPayload(wrong.aesKey, envelope));
});

test('envelope corrompido é recusado com mensagem clara', async () => {
  const { aesKey } = await deriveAccessKeys('ABCDEFGH', { iterations: FAST });
  await assert.rejects(() => decryptPayload(aesKey, 'lixo'), /formato desconhecido/i);
  await assert.rejects(() => decryptPayload(aesKey, 'v2.abc'), /formato desconhecido/i);
  await assert.rejects(() => decryptPayload(aesKey, 'v1.###'), /Não foi possível abrir/i);
});

test('alterar as iterações muda o slot (sal e custo fazem parte da identidade)', async () => {
  const slow = await deriveAccessKeys('ABCDEFGH', { iterations: FAST });
  const faster = await deriveAccessKeys('ABCDEFGH', { iterations: FAST * 2 });
  assert.notEqual(slow.slot, faster.slot);
});
