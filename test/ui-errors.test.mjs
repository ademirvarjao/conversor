import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { installGlobalErrorReporting, reportStartupFailure } from '../src/ui-errors.js';

/** Alvo de eventos falso: guarda ouvintes e permite disparar eventos na mão. */
function fakeTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    emit(type, event) {
      for (const handler of [...(listeners.get(type) || [])]) handler(event);
    },
    count(type) {
      return (listeners.get(type) || new Set()).size;
    },
  };
}

describe('rede de proteção contra erros inesperados', () => {
  it('transforma promessa rejeitada em aviso legível', () => {
    const target = fakeTarget();
    const avisos = [];
    const uninstall = installGlobalErrorReporting({
      notify: (message, type) => avisos.push([message, type]),
      scope: 'Conversor',
      target,
    });

    target.emit('unhandledrejection', { reason: new Error('PDF corrompido') });
    target.emit('error', { message: 'Falha ao ler planilha' });

    assert.deepEqual(avisos, [
      ['Conversor: PDF corrompido', 'error'],
      ['Conversor: Falha ao ler planilha', 'error'],
    ]);

    uninstall();
    assert.equal(target.count('unhandledrejection'), 0);
    assert.equal(target.count('error'), 0);
  });

  it('não repete a mesma mensagem nem passa de três avisos', () => {
    const target = fakeTarget();
    const avisos = [];
    installGlobalErrorReporting({ notify: (m) => avisos.push(m), target });

    target.emit('unhandledrejection', { reason: new Error('igual') });
    target.emit('unhandledrejection', { reason: new Error('igual') });
    for (const texto of ['um', 'dois', 'três', 'quatro']) {
      target.emit('error', { message: texto });
    }

    assert.equal(avisos.length, 3);
    assert.equal(avisos.filter((mensagem) => mensagem.endsWith('igual')).length, 1);
  });

  it('ignora falha opaca do navegador e evento vazio', () => {
    const target = fakeTarget();
    const avisos = [];
    installGlobalErrorReporting({ notify: (m) => avisos.push(m), target });

    target.emit('error', { message: 'Script error.' });
    target.emit('unhandledrejection', { reason: undefined });
    target.emit('error', {});

    // Nem o "Script error." opaco nem o evento vazio geram mensagem inventada:
    // os dois casos genéricos aparecem, o texto opaco não.
    assert.equal(avisos.length, 2);
    assert.match(avisos[0], /interrompida por um erro/);
    assert.match(avisos[1], /erro inesperado/);
    assert.equal(avisos.some((mensagem) => /Script error/i.test(mensagem)), false);
  });

  it('continua funcionando quando o próprio aviso falha', () => {
    const target = fakeTarget();
    installGlobalErrorReporting({
      notify: () => {
        throw new Error('toast quebrado');
      },
      target,
    });

    assert.doesNotThrow(() => target.emit('error', { message: 'algo deu errado' }));
  });

  it('não instala nada quando o alvo não tem addEventListener', () => {
    const uninstall = installGlobalErrorReporting({ target: null });
    assert.equal(typeof uninstall, 'function');
    assert.doesNotThrow(() => uninstall());
  });
});

describe('falha na inicialização', () => {
  function fakeDocument() {
    const appended = [];
    const container = { appendChild: (node) => appended.push(node) };
    return {
      appended,
      getElementById: (id) => (id === 'toast-container' ? container : null),
      createElement: () => {
        const node = { className: '', textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
        return node;
      },
    };
  }

  it('mostra um aviso com a mensagem do erro', () => {
    const doc = fakeDocument();
    reportStartupFailure({ scope: 'Conversor', label: 'a aplicação', error: new Error('PDF.js ausente'), document: doc });

    assert.equal(doc.appended.length, 1);
    assert.equal(doc.appended[0].className, 'toast error');
    assert.equal(doc.appended[0].attrs.role, 'alert');
    assert.match(doc.appended[0].textContent, /Falha ao iniciar a aplicação: PDF\.js ausente/);
  });

  it('não quebra quando não existe o contêiner de avisos', () => {
    assert.doesNotThrow(() =>
      reportStartupFailure({ error: new Error('sem DOM'), document: { getElementById: () => null } })
    );
  });
});
