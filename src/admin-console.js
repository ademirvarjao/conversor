/**
 * Conversor — console do administrador (universal)
 *
 * O painel de uso/memória/logs nasceu dentro do conciliador. Este módulo o
 * transforma em algo que **qualquer página** monta: injeta a marcação
 * (`adminPanelMarkup` + `adminGateMarkup`), cuida do desbloqueio por senha,
 * registra sessão e tempo de uso, exporta `.json`/`.csv` e limpa o histórico.
 *
 * Quem usa (ver `src/app.js` e `src/counterparty-page.js`):
 *
 * ```js
 * const admin = createAdminConsole({ page: 'conversor', getMemory: () => state.memory, getCloud });
 * admin.mount();                       // injeta painel + diálogo de senha
 * admin.open('memory');                // abre (pede a senha se necessário)
 * admin.track('arquivo', 'Cadastro lido: 120 contatos', '', 'contactsFiles');
 * ```
 *
 * Nada aqui fala com servidor: o painel mostra **este navegador**.
 */

import {
  LOCKOUT_MS,
  MAX_ATTEMPTS,
  clearUnlock,
  loadUnlock,
  saveUnlock,
  verifyCloudCredentials,
} from './cloud-lock.js';
import {
  ADMIN_TABS,
  adminGateMarkup,
  adminPanelHeadline,
  adminPanelMarkup,
  renderAdminPanel,
} from './admin-panel.js';
import {
  USAGE_KEY,
  addActiveTime,
  bumpCounter,
  eventsToCsv,
  loadUsage,
  recordEvent,
  resetUsage,
  saveUsage,
  startSession,
  usageReport,
} from './admin-usage.js';
import { STORAGE_KEY as AI_MEMORY_KEY } from './ai-engine.js';
import { accountMemorySummary, sanitizeCounterparties } from './counterparty.js';
import { APP_VERSION } from './ui-contract.js';

/** De quanto em quanto tempo o tempo de uso é gravado enquanto a aba está aberta. */
const USAGE_TICK_MS = 30_000;

/** `true` no navegador, `false` no Node — o módulo é testável sem DOM. */
function hasDom() {
  return typeof document !== 'undefined' && typeof window !== 'undefined';
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1).replace('.', ',')} KB`;
  return `${(value / (1024 * 1024)).toFixed(2).replace('.', ',')} MB`;
}

/** Quanto cada coisa ocupa no navegador (só o tamanho, nunca o conteúdo). */
export function storageSizes(storage) {
  const store = storage || (hasDom() ? window.localStorage : null);
  const sizes = { memory: 0, usage: 0, total: 0, keys: 0 };
  if (!store) return { memory: '—', usage: '—', total: '—', keys: 0 };
  try {
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (!key) continue;
      const size = key.length + (store.getItem(key) || '').length;
      sizes.total += size;
      sizes.keys += 1;
      if (key === AI_MEMORY_KEY) sizes.memory = size;
      if (key === USAGE_KEY) sizes.usage = size;
    }
  } catch {
    /* modo privado: mostra "—" */
  }
  return {
    memory: sizes.memory ? formatBytes(sizes.memory) : '—',
    usage: sizes.usage ? formatBytes(sizes.usage) : '—',
    total: sizes.total ? formatBytes(sizes.total) : '—',
    keys: sizes.keys,
  };
}

/** Navegador, sistema e tela — o que o app consegue saber sem pedir permissão. */
export function deviceRows(win) {
  const view = win || (hasDom() ? window : {});
  const nav = view.navigator || {};
  const ua = String(nav.userAgent || '');
  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : 'não identificado';
  const system =
    /Windows/.test(ua) ? 'Windows'
    : /Android/.test(ua) ? 'Android'
    : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Mac OS X/.test(ua) ? 'macOS'
    : /Linux/.test(ua) ? 'Linux'
    : 'não identificado';
  const screenInfo =
    view.screen && view.innerWidth
      ? `${view.screen.width}×${view.screen.height} (janela ${view.innerWidth}×${view.innerHeight})`
      : '—';
  const timezone = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || '—';
    } catch {
      return '—';
    }
  })();

  return [
    ['Página', view.location?.pathname ? view.location.pathname.replace(/^\//, '') || 'index.html' : '—'],
    ['Navegador', browser],
    ['Sistema', system],
    ['Idioma', nav.language || '—'],
    ['Fuso horário', timezone],
    ['Tela', screenInfo],
    ['Densidade', `${view.devicePixelRatio || 1}×`],
    ['Núcleos de CPU', nav.hardwareConcurrency ? String(nav.hardwareConcurrency) : '—'],
    ['Memória do aparelho', nav.deviceMemory ? `${nav.deviceMemory} GB` : 'não informado'],
    ['Conexão', nav.connection?.effectiveType ? nav.connection.effectiveType.toUpperCase() : 'não informada'],
    ['Toque', nav.maxTouchPoints > 0 ? `sim (${nav.maxTouchPoints} ponto(s))` : 'não'],
    ['Fuso do app', Intl.DateTimeFormat().resolvedOptions().locale || 'pt-BR'],
  ];
}

/** Texto do resumo da memória (o mesmo que ficava na barra do conciliador). */
export function memorySummary(memory) {
  const summary = accountMemorySummary(memory);
  const contacts = Object.keys(sanitizeCounterparties(memory?.counterparties).contacts).length;
  if (summary.total === 0 && contacts === 0) {
    return { ...summary, contacts, text: 'Memória: nenhuma conta memorizada ainda' };
  }
  const text =
    `Memória: ${summary.byHistory} histórico(s) • ${summary.byContact} contato(s) com conta` +
    (contacts > 0 ? ` • ${contacts} contato(s) conciliado(s)` : '');
  return { ...summary, contacts, text };
}

/**
 * Cria o console de uma página.
 *
 * @param {object} options
 * @param {string} [options.page]          rótulo da página ('conversor', 'conciliador')
 * @param {() => object} [options.getMemory] memória da IA (para as abas e o relatório)
 * @param {() => object} [options.getCloud]  estado da nuvem já formatado
 * @param {(message: string, kind?: string) => void} [options.notify] aviso na tela
 */
export function createAdminConsole(options = {}) {
  const {
    page = 'conversor',
    getMemory = () => ({}),
    getCloud = () => ({}),
    notify = () => {},
    onAccessChange = null,
  } = options;

  const usage = loadUsage();
  const state = { tab: 'overview', open: false, logFilter: 'all', sessionStartedAt: Date.now(), unlocked: false };
  const admin = { attempts: 0, cooldownUntil: 0 };
  let activeAnchor = 0;
  let ticker = null;
  let mounted = false;
  let lastFocused = null;

  const dom = {};

  function cacheDom() {
    if (!hasDom()) return;
    for (const id of [
      'cp-admin-panel',
      'cp-admin-headline',
      'cp-admin-body',
      'btn-cp-admin-close',
      'btn-cp-admin-refresh',
      'btn-cp-admin-export',
      'btn-cp-admin-logs',
      'btn-cp-admin-reset',
      'btn-cp-admin-lock',
      'admin-gate',
      'admin-gate-form',
      'admin-gate-user',
      'admin-gate-password',
      'admin-gate-error',
      'btn-admin-gate-enter',
      'btn-admin-gate-close',
      'toast-container',
    ]) {
      dom[id] = document.getElementById(id);
    }
  }

  function persistUsage() {
    saveUsage(usage);
  }

  /** Registra um evento (e, se pedido, soma um contador). */
  function track(type, message, details = '', counter = null, amount = 1) {
    recordEvent(usage, { type, message, details }, Date.now());
    if (counter) bumpCounter(usage, counter, amount, Date.now());
    persistUsage();
  }

  /** Só soma contador (edições em série não viram um evento cada). */
  function count(counter, amount = 1) {
    bumpCounter(usage, counter, amount, Date.now());
    persistUsage();
  }

  /* ------------------------------ tempo de uso ----------------------------- */

  function flushActiveTime() {
    if (!activeAnchor) return;
    const now = Date.now();
    addActiveTime(usage, now - activeAnchor, now);
    activeAnchor = now;
    persistUsage();
  }

  function watchActiveTime() {
    if (!hasDom()) return () => {};
    activeAnchor = document.visibilityState === 'visible' ? Date.now() : 0;
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        activeAnchor = Date.now();
        return;
      }
      flushActiveTime();
      activeAnchor = 0;
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flushActiveTime);
    ticker = setInterval(flushActiveTime, USAGE_TICK_MS);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flushActiveTime);
      if (ticker) clearInterval(ticker);
    };
  }

  /* -------------------------------- desbloqueio ---------------------------- */

  function isUnlocked() {
    if (state.unlocked && loadUnlock()) return true;
    state.unlocked = false;
    return false;
  }

  function adoptStoredUnlock() {
    // Quem já entrou em outra página (mesma aba) não digita a senha de novo.
    if (loadUnlock()) state.unlocked = true;
    return state.unlocked;
  }

  function setGateError(message) {
    const box = dom['admin-gate-error'];
    if (!box) return;
    box.textContent = message || '';
    box.classList.toggle('hidden', !message);
  }

  function openGate() {
    if (!dom['admin-gate']) return false;
    setGateError('');
    lastFocused = document.activeElement;
    dom['admin-gate'].classList.remove('hidden');
    dom['admin-gate'].setAttribute('aria-hidden', 'false');
    dom['admin-gate-user']?.focus();
    return true;
  }

  function closeGate() {
    if (!dom['admin-gate'] || dom['admin-gate'].classList.contains('hidden')) return;
    dom['admin-gate'].classList.add('hidden');
    dom['admin-gate'].setAttribute('aria-hidden', 'true');
    if (dom['admin-gate-password']) dom['admin-gate-password'].value = '';
    setGateError('');
    if (lastFocused instanceof HTMLElement) lastFocused.focus();
  }

  async function submitGate(event) {
    event?.preventDefault?.();
    const now = Date.now();
    if (admin.cooldownUntil > now) {
      setGateError(`Muitas tentativas. Aguarde ${Math.ceil((admin.cooldownUntil - now) / 1000)}s.`);
      return;
    }

    const user = dom['admin-gate-user']?.value || '';
    const password = dom['admin-gate-password']?.value || '';
    if (!user.trim() || !password) {
      setGateError('Informe login e senha.');
      return;
    }

    const button = dom['btn-admin-gate-enter'];
    if (button) button.disabled = true;
    try {
      const ok = await verifyCloudCredentials(user, password);
      if (!ok) {
        admin.attempts += 1;
        if (admin.attempts >= MAX_ATTEMPTS) {
          admin.attempts = 0;
          admin.cooldownUntil = Date.now() + LOCKOUT_MS;
          setGateError('Muitas tentativas erradas. Aguarde 30 segundos.');
        } else {
          setGateError(`Login ou senha incorretos (${admin.attempts}/${MAX_ATTEMPTS}).`);
        }
        if (dom['admin-gate-password']) dom['admin-gate-password'].value = '';
        track('erro', 'Tentativa de acesso ao painel falhou', `tentativa ${admin.attempts || MAX_ATTEMPTS}`, 'errors');
        return;
      }

      admin.attempts = 0;
      admin.cooldownUntil = 0;
      state.unlocked = true;
      saveUnlock();
      if (dom['admin-gate-password']) dom['admin-gate-password'].value = '';
      closeGate();
      render();
      openPanel(state.tab);
      onAccessChange?.(true);
      notify('Painel do administrador liberado nesta aba por 1 hora.', 'success');
    } catch (error) {
      setGateError(error?.message || 'Não foi possível validar a senha.');
    } finally {
      if (button) button.disabled = false;
    }
  }

  /** Bloqueia de novo (some o painel e pede a senha na próxima abertura). */
  function lock() {
    clearUnlock();
    state.unlocked = false;
    closePanel();
    closeGate();
    onAccessChange?.(false);
    notify('Acesso do administrador bloqueado de novo.', 'warn');
  }

  /* --------------------------------- painel -------------------------------- */

  function cloudSummary() {
    const cloud = getCloud() || {};
    return {
      accessCode: cloud.accessCode || '',
      lastSync: cloud.lastSync || '—',
      host: cloud.host || '',
      account: cloud.account || 'sem conta',
      remote: cloud.remote || 'não verificado',
      auto: true,
    };
  }

  function render() {
    if (!hasDom() || !dom['cp-admin-body']) return;
    const memory = getMemory() || {};
    dom['cp-admin-body'].innerHTML = renderAdminPanel({
      tab: state.tab,
      usage,
      memory,
      memorySummary: memorySummary(memory),
      device: { rows: deviceRows() },
      cloud: cloudSummary(),
      storage: storageSizes(),
      logFilter: state.logFilter,
      sessionStartedAt: state.sessionStartedAt,
    });
    if (dom['cp-admin-headline']) dom['cp-admin-headline'].textContent = adminPanelHeadline(usage);
    document.querySelectorAll('[data-cp-admin-tab]').forEach((button) => {
      const active = button.dataset.cpAdminTab === state.tab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    });
  }

  function openPanel(tab) {
    if (!dom['cp-admin-panel']) return false;
    if (tab && ADMIN_TABS.some((entry) => entry.id === tab)) state.tab = tab;
    flushActiveTime();
    render();
    state.open = true;
    dom['cp-admin-panel'].classList.remove('hidden');
    dom['cp-admin-panel'].setAttribute('aria-hidden', 'false');
    lastFocused = document.activeElement;
    dom['btn-cp-admin-close']?.focus();
    track('sessao', `Painel do administrador aberto (${page})`, `aba ${state.tab}`);
    return true;
  }

  function closePanel() {
    if (!dom['cp-admin-panel'] || dom['cp-admin-panel'].classList.contains('hidden')) return;
    state.open = false;
    dom['cp-admin-panel'].classList.add('hidden');
    dom['cp-admin-panel'].setAttribute('aria-hidden', 'true');
    if (lastFocused instanceof HTMLElement) lastFocused.focus();
  }

  /** Abre o painel respeitando a senha: sem desbloqueio, abre o portão. */
  function open(tab) {
    if (!isUnlocked()) {
      if (tab && ADMIN_TABS.some((entry) => entry.id === tab)) state.tab = tab;
      openGate();
      return false;
    }
    return openPanel(tab);
  }

  function setTab(tab) {
    if (!ADMIN_TABS.some((entry) => entry.id === tab)) return;
    state.tab = tab;
    render();
  }

  /* ------------------------------- exportação ------------------------------ */

  function downloadTextFile(content, filename, mime) {
    if (!hasDom()) return;
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function fileName(extension) {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    return `painel-administrador-${stamp}.${extension}`;
  }

  function exportReport() {
    flushActiveTime();
    const report = usageReport(
      {
        usage,
        memory: getMemory(),
        device: Object.fromEntries(deviceRows()),
        cloud: cloudSummary(),
        appVersion: APP_VERSION,
      },
      Date.now()
    );
    report.app.pagina = page;
    downloadTextFile(JSON.stringify(report, null, 2), fileName('json'), 'application/json');
    track('exportacao', 'Relatório do painel exportado', '.json');
    notify('Relatório do painel exportado em .json.', 'success');
  }

  function exportLogs() {
    downloadTextFile(`\ufeff${eventsToCsv(usage)}`, fileName('csv'), 'text/csv;charset=utf-8');
    track('exportacao', 'Logs do painel exportados', '.csv');
    notify('Logs exportados em .csv (separador ";" — abre direto no Excel).', 'success');
  }

  function resetHistory() {
    if (!window.confirm('Apagar o histórico de uso e os logs deste navegador? A memória da IA não é afetada.')) return;
    Object.assign(usage, resetUsage());
    persistUsage();
    state.sessionStartedAt = Date.now();
    render();
    notify('Histórico de uso apagado.', 'warn');
  }

  /* --------------------------------- eventos ------------------------------- */

  function bind() {
    dom['btn-cp-admin-close']?.addEventListener('click', closePanel);
    dom['btn-cp-admin-refresh']?.addEventListener('click', () => {
      flushActiveTime();
      render();
      notify('Painel atualizado.', 'success');
    });
    dom['btn-cp-admin-export']?.addEventListener('click', exportReport);
    dom['btn-cp-admin-logs']?.addEventListener('click', exportLogs);
    dom['btn-cp-admin-reset']?.addEventListener('click', resetHistory);
    dom['btn-cp-admin-lock']?.addEventListener('click', lock);

    dom['cp-admin-panel']?.addEventListener('click', (event) => {
      if (event.target === dom['cp-admin-panel']) closePanel();
    });

    document.querySelectorAll('[data-cp-admin-tab]').forEach((button) => {
      button.addEventListener('click', () => setTab(button.dataset.cpAdminTab));
    });

    // Abas com as setas do teclado (padrão de tablist).
    document.querySelector('.cp-admin-tabs')?.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const tabs = [...document.querySelectorAll('[data-cp-admin-tab]')];
      const current = tabs.findIndex((tab) => tab.dataset.cpAdminTab === state.tab);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? tabs.length - 1
            : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      event.preventDefault();
      tabs[next].focus();
      setTab(tabs[next].dataset.cpAdminTab);
    });

    // Filtro dos logs: guarda o tipo e redesenha a aba.
    dom['cp-admin-body']?.addEventListener('click', (event) => {
      const chip = event.target.closest('[data-cp-admin-log]');
      if (!chip) return;
      state.logFilter = chip.dataset.cpAdminLog || 'all';
      render();
    });

    dom['admin-gate-form']?.addEventListener('submit', (event) => void submitGate(event));
    dom['btn-admin-gate-close']?.addEventListener('click', closeGate);
    dom['admin-gate']?.addEventListener('click', (event) => {
      if (event.target === dom['admin-gate']) closeGate();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (state.open) closePanel();
      else closeGate();
    });

    // Ao voltar o foco, o desbloqueio pode ter vencido com a página aberta.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (state.open && !isUnlocked()) {
        closePanel();
        notify('O acesso do administrador expirou. Entre com a senha de novo.', 'warn');
      } else if (state.open) {
        render();
      }
    });
  }

  /** Injeta a marcação do painel e do portão (uma vez por página). */
  function mount() {
    if (!hasDom()) return false;
    if (mounted) return true;
    if (!document.getElementById('cp-admin-panel')) {
      document.body.insertAdjacentHTML('beforeend', adminPanelMarkup());
    }
    if (!document.getElementById('admin-gate')) {
      document.body.insertAdjacentHTML('beforeend', adminGateMarkup());
    }
    cacheDom();
    bind();

    adoptStoredUnlock();
    startSession(usage);
    bumpCounter(usage, 'sessions', 1, Date.now());
    persistUsage();
    recordEvent(usage, { type: 'sessao', message: `Página aberta: ${page}` }, Date.now());
    persistUsage();
    watchActiveTime();

    mounted = true;
    return true;
  }

  return {
    mount,
    open,
    close: closePanel,
    toggle: (tab) => (state.open ? closePanel() : open(tab)),
    openGate,
    closeGate,
    isOpen: () => state.open,
    isUnlocked,
    lock,
    setTab,
    render,
    refresh: () => {
      flushActiveTime();
      render();
    },
    track,
    count,
    flushActiveTime,
    usage,
    memorySummary: () => memorySummary(getMemory()),
    /** Para testes: estado interno somente leitura. */
    snapshot: () => ({ ...state, mounted, page }),
  };
}
