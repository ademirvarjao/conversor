/**
 * Menu da engrenagem — universal (as duas páginas).
 *
 * Aqui testamos o modelo (o que aparece), a marcação (como aparece) e o
 * comportamento (abrir, fechar, teclado, foco), sem navegador de verdade: um
 * DOM mínimo faz o papel dos elementos.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  GEAR_ICONS,
  createGearMenu,
  gearMenuInnerMarkup,
  gearMenuMarkup,
  gearSections,
  mountGearMenu,
} from '../src/gear-menu.js';

/* ------------------------------- DOM mínimo ------------------------------- */

function fakeElement(children = []) {
  const listeners = new Map();
  const attributes = {};
  const classes = new Set();
  const el = {
    hidden: false,
    style: {},
    dataset: {},
    attributes,
    focused: false,
    listeners,
    children,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
    },
    setAttribute: (key, value) => {
      attributes[key] = String(value);
    },
    getAttribute: (key) => (key in attributes ? attributes[key] : null),
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener: (type, fn) => {
      const list = listeners.get(type) || [];
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    },
    dispatch: (type, extra = {}) => {
      const event = { type, preventDefault() {}, stopPropagation() {}, target: el, ...extra };
      let stopped = false;
      for (const fn of listeners.get(type) || []) fn(event);
      if (!stopped) {
        // Eventos "bubbling" sobem para o documento quando o teste pede.
        el.bubbled?.forEach((parent) => parent.dispatch?.(type, { ...event, target: extra.target || el }));
      }
      return event;
    },
    focus: () => {
      el.focused = true;
      document.activeElement = el;
    },
    contains: (other) => children.includes(other),
    matches: (selector) => selector === '[data-gear-item]' && 'gearItem' in el.dataset,
    closest: (selector) => (el.matches(selector) ? el : null),
    querySelector: () => children[0] || null,
    querySelectorAll: () => children,
    getBoundingClientRect: () => ({ top: 40, bottom: 76, left: 1160, right: 1200, width: 40, height: 36 }),
  };
  return el;
}

function installDom({ items = 3 } = {}) {
  const documentListeners = new Map();
  const document_ = {
    activeElement: null,
    addEventListener: (type, fn) => {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(fn);
    },
    removeEventListener: (type, fn) => {
      const list = documentListeners.get(type) || [];
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    },
    dispatch: (type, extra = {}) => {
      for (const fn of [...(documentListeners.get(type) || [])]) fn({ type, preventDefault() {}, ...extra });
    },
    count: (type) => (documentListeners.get(type) || []).length,
  };
  const window_ = {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.document = document_;
  globalThis.window = window_;
  return { document: document_, window: window_, items };
}

function uninstallDom() {
  delete globalThis.document;
  delete globalThis.window;
}

function makeMenu(items) {
  const menuItems = Array.from({ length: items }, (_, index) => {
    const item = fakeElement();
    item.dataset.gearItem = `item-${index}`;
    item.setAttribute('role', 'menuitem');
    return item;
  });
  const menu = fakeElement(menuItems);
  menu.classList.add('hidden');
  menu.hidden = true;
  menu.setAttribute('role', 'menu');
  // `querySelector('[role="menuitem"]')` devolve o primeiro item.
  menu.querySelector = () => menuItems[0] || null;
  return { menu, menuItems };
}

/* --------------------------------- testes --------------------------------- */

describe('modelo do menu da engrenagem', () => {
  it('abre com o painel do administrador em destaque', () => {
    const { sections } = gearSections({ unlocked: false, version: '1.26.0' });
    assert.equal(sections[0].label, 'Administração');
    const first = sections[0].items[0];
    assert.equal(first.id, 'admin');
    assert.equal(first.label, 'Painel do administrador');
    assert.equal(first.badge, 'Senha');
    assert.equal(first.tone, 'locked');
    assert.match(first.hint, /senha/i);
  });

  it('quando o administrador já entrou, avisa que está liberado', () => {
    const { sections } = gearSections({ unlocked: true });
    const first = sections[0].items[0];
    assert.equal(first.badge, 'Aberto');
    assert.equal(first.tone, 'ok');
    assert.match(first.hint, /1 hora/);
    const last = sections.at(-1);
    assert.equal(last.label, 'Sessão');
    assert.equal(last.items[0].id, 'lock', 'dá para bloquear de novo');
  });

  it('a página com o modal da memória ganha as opções de backup e nuvem', () => {
    const completo = gearSections({ hasMemoryModal: true, profiles: 3, accessCode: 'ABCD-EFGH' });
    const ids = completo.sections.flatMap((section) => section.items.map((item) => item.id));
    for (const id of ['admin', 'admin-usage', 'memory', 'memory-export', 'memory-import', 'settings', 'cloud', 'docs']) {
      assert.ok(ids.includes(id), `falta a opção ${id}`);
    }
    const memoria = completo.sections.find((section) => section.id === 'memory');
    assert.equal(memoria.items[0].badge, '3', 'mostra quantos layouts a IA aprendeu');
    const nuvem = completo.sections.find((section) => section.id === 'settings').items.find((item) => item.id === 'cloud');
    assert.match(nuvem.hint, /ABCD-EFGH/, 'mostra a chave de acesso');
  });

  it('a página sem o modal (conciliador) não inventa opções que não existem', () => {
    const simples = gearSections({ hasMemoryModal: false });
    const ids = simples.sections.flatMap((section) => section.items.map((item) => item.id));
    assert.deepEqual(ids, ['admin', 'admin-usage', 'memory', 'docs']);
    assert.equal(ids.includes('memory-export'), false);
    assert.equal(ids.includes('settings'), false);
  });

  it('toda opção tem ícone conhecido', () => {
    for (const section of gearSections({ hasMemoryModal: true, unlocked: true }).sections) {
      for (const item of section.items) {
        assert.ok(GEAR_ICONS[item.icon], `ícone ${item.icon} não existe`);
        assert.ok(item.label.length > 3);
      }
    }
  });
});

describe('marcação do menu', () => {
  it('traz estrutura acessível de menu', () => {
    const markup = gearMenuMarkup({ unlocked: false, version: '1.26.0' });
    assert.match(markup, /id="gear-menu"/);
    assert.match(markup, /role="menu"/);
    assert.match(markup, /aria-labelledby="btn-gear"/);
    assert.match(markup, /aria-hidden="true"/);
    assert.match(markup, /class="gear-menu hidden"/);
    assert.match(markup, /role="menuitem"/);
    assert.match(markup, /class="gear-menu-version">v1\.26\.0</);
  });

  it('mostra o aviso de privacidade no rodapé', () => {
    assert.match(gearMenuMarkup({}), /Tudo roda neste navegador — nenhum arquivo sai daqui\./);
  });

  it('o miolo é a mesma coisa sem o elemento externo', () => {
    const inner = gearMenuInnerMarkup({ unlocked: true });
    assert.equal(inner.includes('id="gear-menu"'), false);
    assert.match(inner, /class="gear-menu-head"/);
    assert.match(inner, /class="gear-menu-foot"/);
  });

  it('o HTML não vaza chave nem número de memória', () => {
    const markup = gearMenuMarkup({ hasMemoryModal: true, profiles: 0 });
    assert.equal(/apiKey|Gmj63975/.test(markup), false);
  });
});

describe('comportamento do menu', () => {
  it('abre no clique, posiciona e leva o foco ao primeiro item', () => {
    installDom();
    const button = fakeElement();
    const { menu, menuItems } = makeMenu(3);
    const gear = createGearMenu({ button, menu, onAction: () => {} });

    button.dispatch('click');
    assert.equal(gear.isOpen(), true);
    assert.equal(menu.classList.contains('hidden'), false);
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    assert.equal(menuItems[0].focused, true, 'foco no primeiro item');
    assert.match(menu.style.width, /px$/);
    assert.match(menu.style.left, /px$/);
    assert.match(menu.style.top, /px$/);
    uninstallDom();
  });

  it('fecha no segundo clique e devolve o foco ao botão', () => {
    installDom();
    const button = fakeElement();
    const { menu } = makeMenu(2);
    const gear = createGearMenu({ button, menu, onAction: () => {} });

    button.dispatch('click');
    button.dispatch('click');
    assert.equal(gear.isOpen(), false);
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.equal(button.focused, true);
    uninstallDom();
  });

  it('Esc fecha; setas andam entre as opções', () => {
    installDom();
    const button = fakeElement();
    const { menu, menuItems } = makeMenu(3);
    createGearMenu({ button, menu, onAction: () => {} });

    button.dispatch('click');
    globalThis.document.activeElement = menuItems[0];
    globalThis.document.dispatch('keydown', { key: 'ArrowDown' });
    assert.equal(menuItems[1].focused, true, 'seta para baixo');

    globalThis.document.activeElement = menuItems[1];
    globalThis.document.dispatch('keydown', { key: 'End' });
    assert.equal(menuItems[2].focused, true, 'End vai ao último');

    globalThis.document.dispatch('keydown', { key: 'Escape' });
    assert.equal(menu.classList.contains('hidden'), true, 'Esc fecha');
    assert.equal(button.focused, true, 'e o foco volta ao botão');
    uninstallDom();
  });

  it('clicar numa opção avisa a página e fecha o menu', () => {
    installDom();
    const button = fakeElement();
    const { menu, menuItems } = makeMenu(2);
    const acoes = [];
    createGearMenu({ button, menu, onAction: (id) => acoes.push(id) });

    button.dispatch('click');
    menu.dispatch('click', { target: menuItems[1] });
    assert.deepEqual(acoes, ['item-1']);
    assert.equal(menu.classList.contains('hidden'), true);
    uninstallDom();
  });

  it('sem botão nem menu, não quebra', () => {
    const vazio = createGearMenu({ button: null, menu: null, onAction: () => {} });
    assert.equal(vazio.isOpen(), false);
    vazio.open();
    vazio.close();
  });

  it('fora do navegador, montar o menu devolve null', () => {
    assert.equal(mountGearMenu({ ctx: {}, onAction: () => {} }), null);
  });
});
