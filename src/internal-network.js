/**
 * Conversor — Detecção de rede interna
 *
 * Descobre em tempo real se o navegador está na rede interna (onde está o
 * site/JJR da contabilidade) tentando contactar o endereço do banco de dados
 * local. Quando está na rede interna, o ícone e a função do conciliador JR são
 * liberados; caso contrário, ficam desabilitados.
 *
 * Tudo roda no navegador: nenhum dado sai para fora da rede local.
 */

/** Endereço do site interno (banco de dados da contabilidade JR). */
export const INTERNAL_ADDRESS = 'http://192.168.0.201:8090';

/** Intervalo entre as verificações automáticas (ms). */
const CHECK_INTERVAL_MS = 8000;

/** Tempo máximo de espera por resposta do host interno (ms). */
const TIMEOUT_MS = 3000;

let listeners = new Set();
let isInternal = false;
let timer = null;
let checking = false;

/**
 * Tenta contactar o endereço interno para saber se estamos na rede interna.
 * Qualquer resposta HTTP (mesmo erro de status) prova que alcançamos o host.
 * Um erro de rede (TipoError: Failed to fetch) significa que não estamos lá.
 */
async function probe() {
  if (checking) return isInternal;
  checking = true;
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
    await fetch(`${INTERNAL_ADDRESS}/api/empresa/0`, {
      method: 'GET',
      mode: 'no-cors', // só interessa saber se o host responde, não ler o corpo
      signal: controller.signal,
      cache: 'no-store',
    });
    clearTimeout(id);
    isInternal = true;
  } catch {
    isInternal = false;
  } finally {
    checking = false;
    notify();
  }
  return isInternal;
}

function notify() {
  const current = isInternal;
  for (const cb of listeners) {
    try { cb(current); } catch { /* listeners que falham não derrubam os outros */ }
  }
}

/**
 * Verifica imediatamente e agenda verificações periódicas (tempo real).
 * Deve ser chamado na inicialização de cada página.
 */
export async function startInternalNetworkDetection() {
  await probe();
  if (timer) clearInterval(timer);
  timer = setInterval(() => void probe(), CHECK_INTERVAL_MS);
  return isInternal;
}

export function stopInternalNetworkDetection() {
  if (timer) { clearInterval(timer); timer = null; }
}

/** Retorna se estamos na rede interna agora. */
export function isInternalNetwork() {
  return isInternal;
}

/**
 * Registra um callback chamado sempre que o status muda (e imediatamente com
 * o estado atual). Devolve uma função para remover o listener.
 */
export function onInternalNetworkChange(cb) {
  listeners.add(cb);
  cb(isInternal);
  return () => listeners.delete(cb);
}

/** Monta a URL completa de um recurso da API interna. */
export function internalApiUrl(path) {
  return `${INTERNAL_ADDRESS}${path}`;
}
