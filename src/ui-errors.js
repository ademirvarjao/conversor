/**
 * Conversor — Rede de proteção contra erros inesperados
 *
 * O app é 100% estático e sem framework: se uma promessa rejeita fora de um
 * `try/catch` (leitura de PDF interrompida, cota do `localStorage` estourada,
 * resposta estranha da nuvem…), a tela simplesmente não faz nada e o usuário
 * fica sem saber o que aconteceu. Este módulo transforma esses casos em um
 * aviso curto e legível, sem repetir a mesma mensagem três vezes.
 *
 * Regras:
 *  - no máximo 3 avisos por sessão de página (evita tempestade de toasts);
 *  - mensagens repetidas aparecem uma vez só;
 *  - falhas opacas do próprio navegador ("Script error.") são ignoradas;
 *  - o erro original continua no console para depuração.
 */

/** Quantos avisos distintos a rede de proteção mostra antes de ficar quieta. */
const MAX_REPORTS = 3;

const OPAQUE_ERRORS = /^(script error\.?|erro desconhecido\.?)$/i;

/**
 * Instala os ouvintes de `unhandledrejection` e `error`.
 *
 * @param {object} options
 * @param {(message: string, type: 'error') => void} [options.notify] como avisar o usuário
 * @param {string} [options.scope] prefixo das mensagens ("Conversor", "Conciliador")
 * @param {EventTarget} [options.target] onde ouvir (padrão: o global; injetável nos testes)
 * @returns {() => void} função que desinstala os ouvintes
 */
export function installGlobalErrorReporting({ notify, scope = 'Conversor', target = globalThis } = {}) {
  if (!target || typeof target.addEventListener !== 'function') return () => {};

  const reported = new Set();

  const report = (message) => {
    const text = String(message ?? '').trim();
    if (!text || OPAQUE_ERRORS.test(text)) return;
    if (reported.has(text) || reported.size >= MAX_REPORTS) return;
    reported.add(text);
    console.error(`[${scope}] ${text}`);
    if (typeof notify === 'function') {
      try {
        notify(`${scope}: ${text}`, 'error');
      } catch {
        // Se até o aviso falhar, não há mais o que fazer: o console já registrou.
      }
    }
  };

  const onRejection = (event) => {
    const reason = event?.reason;
    report(reason?.message || (typeof reason === 'string' ? reason : '') || 'Uma operação foi interrompida por um erro.');
  };

  const onError = (event) => {
    report(event?.message || event?.error?.message || 'Um erro inesperado aconteceu.');
  };

  target.addEventListener('unhandledrejection', onRejection);
  target.addEventListener('error', onError);

  return () => {
    target.removeEventListener('unhandledrejection', onRejection);
    target.removeEventListener('error', onError);
  };
}

/**
 * Mostra a falha que impede a página de iniciar.
 *
 * Não usa `showToast` de propósito: se a inicialização quebrou, o próprio
 * módulo de avisos pode não ter terminado de subir — aqui só existe DOM.
 *
 * @param {object} options
 * @param {string} [options.scope] etiqueta do console
 * @param {string} [options.label] o que falhou ("a aplicação", "a página")
 * @param {unknown} options.error erro capturado
 * @param {Document} [options.document] documento onde desenhar o aviso
 */
export function reportStartupFailure({ scope = 'Conversor', label = 'a aplicação', error, document: doc } = {}) {
  console.error(`[${scope}] Falha na inicialização:`, error);
  const target = doc || (typeof globalThis.document !== 'undefined' ? globalThis.document : null);
  const container = target?.getElementById?.('toast-container');
  if (!container || typeof target.createElement !== 'function') return;

  const toast = target.createElement('div');
  toast.className = 'toast error';
  toast.setAttribute('role', 'alert');
  toast.textContent = `Falha ao iniciar ${label}: ${error?.message || 'erro desconhecido'}`;
  container.appendChild(toast);
}
