/**
 * Conversor — Manual do usuário (página própria, servida junto do app)
 *
 * A página é estática: sem JavaScript ela continua legível, com a versão e o
 * ano já escritos no HTML. Este módulo só mantém esses dados sincronizados com
 * o `APP_VERSION` do app (para o manual nunca anunciar uma versão diferente da
 * que está no ar) e destaca no sumário a seção que está na tela.
 */

import { APP_VERSION } from './ui-contract.js';

/** Nome exibido no bloco "Sobre". */
export const MANUAL_APP_NAME = 'Conversor — Conciliação Financeira';

/** Autor do projeto (crédito pedido no "Sobre"). */
export const MANUAL_AUTHOR = 'Ademir Varjão';

/**
 * Dados do "Sobre".
 * @param {Date} [now] data de referência (injetada nos testes)
 */
export function manualMeta(now = new Date()) {
  return {
    name: MANUAL_APP_NAME,
    version: APP_VERSION,
    author: MANUAL_AUTHOR,
    year: now.getFullYear(),
    copyright: `© ${now.getFullYear()} ${MANUAL_AUTHOR}. Todos os direitos reservados.`,
  };
}

/**
 * Escreve versão, ano e créditos no documento.
 * Nunca lança: se um elemento não existir (página incompleta), segue em frente.
 */
export function applyManualMeta(doc, now = new Date()) {
  if (!doc) return manualMeta(now);
  const meta = manualMeta(now);

  const setText = (id, text) => {
    const element = doc.getElementById?.(id);
    if (element) element.textContent = text;
  };

  setText('manual-version', `v${meta.version}`);
  setText('app-version', `v${meta.version}`);
  setText('manual-year', String(meta.year));
  setText('manual-copyright', meta.copyright);

  return meta;
}

/**
 * Marca no sumário o item da seção visível.
 * Usa `IntersectionObserver` quando existe e cai num clique simples quando não.
 */
export function setupManualNav(doc, win, Observer = win?.IntersectionObserver) {
  if (!doc) return () => {};
  const links = [...doc.querySelectorAll('.manual-nav a[href^="#"]')];
  if (links.length === 0) return () => {};

  const byId = new Map(
    links.map((link) => [decodeURIComponent(link.getAttribute('href').slice(1)), link])
  );

  const mark = (id) => {
    for (const link of links) {
      const active = link === byId.get(id);
      link.classList.toggle('is-current', active);
      if (active) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    }
  };

  if (typeof Observer !== 'function' || !doc.querySelectorAll) {
    for (const link of links) {
      link.addEventListener?.('click', () => mark(decodeURIComponent(link.getAttribute('href').slice(1))));
    }
    return mark;
  }

  const sections = [...doc.querySelectorAll('.manual-section[id]')];
  const observer = new Observer(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (visible?.target?.id) mark(visible.target.id);
    },
    { rootMargin: '-15% 0px -65% 0px', threshold: [0, 0.25, 0.6] }
  );

  for (const section of sections) observer.observe(section);
  // Antes da primeira rolagem nenhuma seção entrou na faixa do observador:
  // marca a primeira para o sumário nunca ficar "sem nada selecionado".
  mark(sections[0]?.id);
  return () => observer.disconnect();
}

/* -------------------------------------------------------------------------- */
/*                         Ligação com a página (navegador)                   */
/* -------------------------------------------------------------------------- */

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  const start = () => {
    applyManualMeta(document);
    setupManualNav(document, window);

    // Âncoras longas (#problemas) precisam de folga por causa da barra fixa.
    if (window.location.hash) {
      const target = document.querySelector(window.location.hash);
      target?.scrollIntoView?.({ block: 'start' });
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
}
