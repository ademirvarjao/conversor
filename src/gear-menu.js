/**
 * Conversor — menu da engrenagem (universal)
 *
 * A engrenagem existe nas duas páginas e abre o **mesmo** menu: um painel
 * flutuante com seções, ícones, título e uma linha de explicação em cada opção.
 * É aqui que se chega ao painel do administrador, à memória da IA, ao backup e
 * à nuvem.
 *
 * O módulo é dividido em três partes testáveis:
 *   `gearSections()` → o modelo do menu (o que aparece, em que ordem);
 *   `gearMenuMarkup()` → o HTML (sem evento nenhum);
 *   `createGearMenu()` → o comportamento (abrir, fechar, teclado, foco).
 */

/** Ícones (traço de 1.7, 24×24) usados nas opções do menu. */
export const GEAR_ICONS = {
  panel:
    '<path d="M4 13h6V4H4v9Zm0 7h6v-4H4v4Zm10 0h6v-9h-6v9Zm0-16v4h6V4h-6Z"/>',
  memory:
    '<path d="M12 4a4 4 0 0 0-4 4 3.5 3.5 0 0 0-1 6.8V17a3 3 0 0 0 5 2.2A3 3 0 0 0 17 17v-2.2A3.5 3.5 0 0 0 16 8a4 4 0 0 0-4-4Z"/><path d="M12 8v10"/>',
  download: '<path d="M12 4v11"/><path d="m7.5 11 4.5 4.5L16.5 11"/><path d="M4 19h16"/>',
  upload: '<path d="M12 20V9"/><path d="m7.5 13 4.5-4.5L16.5 13"/><path d="M4 5h16"/>',
  cloud:
    '<path d="M7.5 18h9a3.5 3.5 0 0 0 .4-6.98A5.5 5.5 0 0 0 6.4 9.6 3.7 3.7 0 0 0 7.5 18Z"/>',
  key: '<circle cx="8" cy="8" r="3.2"/><path d="M10.4 10.4 20 20"/><path d="M15.5 15.5 18 13"/><path d="M18 18l1.5-1.5"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  unlock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 6.7-1.5"/>',
  info: '<circle cx="12" cy="12" r="8"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  book: '<path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H19v15H7.5A2.5 2.5 0 0 0 5 20.5v-15Z"/><path d="M5 20.5A2.5 2.5 0 0 1 7.5 18H19"/>',
};

/**
 * Opções do menu.
 *
 * @param {object} ctx
 * @param {boolean} [ctx.unlocked]         administrador já liberado nesta aba?
 * @param {boolean} [ctx.hasMemoryModal]   a página tem o modal completo da memória?
 * @param {number}  [ctx.profiles]         quantos layouts a IA aprendeu
 * @param {string}  [ctx.accessCode]       chave de acesso da nuvem (mascarada)
 * @param {string}  [ctx.version]          versão do app
 */
export function gearSections(ctx = {}) {
  const { unlocked = false, hasMemoryModal = false, profiles = 0, accessCode = '', version = '' } = ctx;

  const adminHint = unlocked
    ? 'Liberado nesta aba por 1 hora'
    : 'Protegido por senha — a mesma da aba Nuvem';

  const admin = {
    id: 'admin',
    icon: 'panel',
    label: 'Painel do administrador',
    hint: adminHint,
    badge: unlocked ? 'Aberto' : 'Senha',
    tone: unlocked ? 'ok' : 'locked',
  };

  const sections = [
    {
      id: 'admin',
      label: 'Administração',
      items: [admin, { id: 'admin-usage', icon: 'info', label: 'Uso, tempo e logs', hint: 'Atalho direto para a aba Uso do painel' }],
    },
  ];

  const memory = [
    {
      id: 'memory',
      icon: 'memory',
      label: 'Memória da IA',
      hint: hasMemoryModal ? 'Layouts, vocabulário e log de aprendizado' : 'O que a IA aprendeu neste navegador',
      badge: profiles > 0 ? `${profiles}` : '',
    },
  ];
  if (hasMemoryModal) {
    memory.push(
      { id: 'memory-export', icon: 'download', label: 'Exportar memória (.json)', hint: 'Backup sem a chave do LLM' },
      { id: 'memory-import', icon: 'upload', label: 'Importar memória (.json)', hint: 'Restaura layouts de outro computador' }
    );
  }
  sections.push({ id: 'memory', label: 'Memória da IA', items: memory });

  if (hasMemoryModal) {
    sections.push({
      id: 'settings',
      label: 'Configurações',
      items: [
        { id: 'settings', icon: 'key', label: 'Backup e chave do LLM', hint: 'Conector opcional (OpenAI / Gemini)' },
        {
          id: 'cloud',
          icon: 'cloud',
          label: 'Nuvem e conta',
          hint: accessCode ? `Chave ${accessCode}` : 'Chave de acesso dos modelos',
        },
      ],
    });
  }

  const help = [
    { id: 'docs', icon: 'book', label: 'Como funciona', hint: 'Manual e limitações no repositório' },
  ];
  sections.push({ id: 'help', label: 'Ajuda', items: help });

  if (unlocked) {
    sections.push({
      id: 'session',
      label: 'Sessão',
      items: [{ id: 'lock', icon: 'lock', label: 'Bloquear administrador', hint: 'Pedir a senha de novo', tone: 'danger' }],
    });
  }

  return { sections, version };
}

function itemMarkup(item) {
  return `<button
      class="gear-item${item.tone ? ` is-${item.tone}` : ''}"
      type="button"
      role="menuitem"
      data-gear-item="${item.id}"
    >
      <span class="gear-item-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${GEAR_ICONS[item.icon] || GEAR_ICONS.info}</svg>
      </span>
      <span class="gear-item-text">
        <span class="gear-item-label">${item.label}${item.badge ? `<span class="gear-item-badge">${item.badge}</span>` : ''}</span>
        ${item.hint ? `<span class="gear-item-hint">${item.hint}</span>` : ''}
      </span>
    </button>`;
}

/** Miolo do menu (cabeçalho, grupos e rodapé), sem o elemento externo. */
export function gearMenuInnerMarkup(ctx = {}) {
  const { sections, version } = gearSections(ctx);
  const body = sections
    .map(
      (section) => `<div class="gear-group" role="group" aria-label="${section.label}">
        <p class="gear-group-label">${section.label}</p>
        ${section.items.map(itemMarkup).join('')}
      </div>`
    )
    .join('');

  return `<div class="gear-menu-head">
      <span class="gear-menu-title">Opções</span>
      <span class="gear-menu-version">${version ? `v${version}` : ''}</span>
    </div>
    <div class="gear-menu-body">${body}</div>
    <p class="gear-menu-foot">Tudo roda neste navegador — nenhum arquivo sai daqui.</p>`;
}

/** HTML completo do menu (sem eventos). `ctx` é o mesmo de `gearSections`. */
export function gearMenuMarkup(ctx = {}) {
  return `<div id="gear-menu" class="gear-menu hidden" role="menu" aria-labelledby="btn-gear" aria-hidden="true" tabindex="-1">${gearMenuInnerMarkup(ctx)}</div>`;
}

/**
 * Liga o menu ao botão da engrenagem.
 *
 * @param {object} options
 * @param {HTMLElement} options.button   botão da engrenagem
 * @param {HTMLElement} options.menu     o menu (já no DOM)
 * @param {(id: string, item: HTMLElement) => void} options.onAction
 * @param {() => void} [options.onOpen]  gancho ao abrir (para atualizar textos)
 */
export function createGearMenu({ button, menu, onAction, onOpen }) {
  if (!button || !menu) {
    return { open: () => {}, close: () => {}, toggle: () => {}, isOpen: () => false, refresh: () => {} };
  }

  const isOpen = () => !menu.classList.contains('hidden');

  function place() {
    // Posiciona o menu logo abaixo do botão, sem sair da tela.
    const rect = button.getBoundingClientRect();
    const width = Math.min(340, Math.max(260, window.innerWidth - 24));
    const left = Math.min(Math.max(12, rect.right - width), window.innerWidth - width - 12);
    menu.style.width = `${width}px`;
    menu.style.left = `${left}px`;
    menu.style.top = `${Math.round(rect.bottom + 8)}px`;
    menu.dataset.placement = window.innerHeight - rect.bottom > 380 ? 'below' : 'above';
    if (menu.dataset.placement === 'above') {
      menu.style.top = `${Math.max(12, Math.round(rect.top - Math.min(window.innerHeight * 0.7, 460) - 8))}px`;
    }
  }

  function open() {
    if (isOpen()) return;
    onOpen?.();
    menu.hidden = false;
    menu.classList.remove('hidden');
    menu.setAttribute('aria-hidden', 'false');
    button.setAttribute('aria-expanded', 'true');
    place();
    const first = menu.querySelector('[role="menuitem"]');
    first?.focus();
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', place);
  }

  function close({ focusButton = false } = {}) {
    if (!isOpen()) return;
    menu.classList.add('hidden');
    menu.hidden = true;
    menu.setAttribute('aria-hidden', 'true');
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', place);
    if (focusButton) button.focus();
  }

  function toggle() {
    if (isOpen()) close({ focusButton: true });
    else open();
  }

  function onPointerDown(event) {
    if (menu.contains(event.target) || button.contains(event.target)) return;
    close();
  }

  function onKeyDown(event) {
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    const index = items.indexOf(document.activeElement);

    if (event.key === 'Escape') {
      event.preventDefault();
      close({ focusButton: true });
      return;
    }
    if (event.key === 'Tab') {
      close();
      return;
    }
    if (!items.length) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(index + 1 + items.length) % items.length].focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[(index - 1 + items.length) % items.length].focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      items[0].focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      items[items.length - 1].focus();
    } else if (event.key === 'Enter' || event.key === ' ') {
      if (index >= 0) {
        event.preventDefault();
        items[index].click();
      }
    }
  }

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    toggle();
  });
  button.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      open();
    }
  });

  menu.addEventListener('click', (event) => {
    const item = event.target.closest('[data-gear-item]');
    if (!item) return;
    close({ focusButton: true });
    onAction?.(item.dataset.gearItem, item);
  });

  // O primeiro item é o mais usado: marca como selecionado para o leitor de tela.
  menu.querySelector('[role="menuitem"]')?.setAttribute('tabindex', '0');

  return { open, close, toggle, isOpen, refresh: onOpen };
}

/**
 * Monta o menu na página, a partir do botão `#btn-gear`.
 *
 * Injeta a marcação na primeira chamada (nenhuma página precisa repetir o HTML
 * do menu) e devolve o controlador com `refresh(ctx)`, que redesenha as opções
 * quando o estado muda — por exemplo, depois do desbloqueio do administrador.
 *
 * O `ctx` pode ser um objeto (menu fixo) ou uma **função** — o caso das duas
 * páginas, que precisam recalcular “administrador liberado?” a cada abertura.
 *
 * @param {object} options
 * @param {object|(() => object)} [options.ctx] contexto de `gearSections`
 * @param {(id: string, item: HTMLElement) => void} options.onAction
 * @param {string} [options.buttonId]
 */
export function mountGearMenu({ ctx = {}, onAction, buttonId = 'btn-gear' } = {}) {
  if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return null;
  const button = document.getElementById(buttonId);
  if (!button) return null;

  const readCtx = typeof ctx === 'function' ? ctx : () => ctx;
  let menu = document.getElementById('gear-menu') || null;
  if (!menu) {
    document.body.insertAdjacentHTML('beforeend', gearMenuMarkup(readCtx()));
    menu = document.getElementById('gear-menu');
  }
  if (!menu) return null;

  const controller = createGearMenu({
    button,
    menu,
    onAction,
    onOpen: () => controller.refresh(),
  });

  controller.refresh = (next) => {
    // Redesenha só o miolo: o elemento externo e os eventos continuam valendo.
    const atual = next || readCtx();
    menu.innerHTML = gearMenuInnerMarkup(atual);
    button.setAttribute('aria-expanded', String(controller.isOpen()));
    // O ícone muda de cor quando o administrador já está liberado.
    button.dataset.state = atual.unlocked ? 'unlocked' : 'locked';
  };
  controller.refresh();

  return controller;
}
