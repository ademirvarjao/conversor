/**
 * Conversor — Configuração pública do banco compartilhado
 *
 * Preencha uma única vez (administrador) e faça commit: a URL do projeto e a
 * chave **anônima** do Supabase são públicas por natureza — a proteção dos
 * dados vem da criptografia feita no navegador (ver `sync-crypto.js`).
 *
 * Nunca coloque aqui a `service_role` key: ela ignora o RLS e dá acesso total.
 *
 * O que cada usuário informar na tela "Nuvem" (URL/chave diferente) tem
 * prioridade sobre estes valores, que servem de padrão para a equipe.
 */
export const DEFAULT_CLOUD_CONFIG = {
  url: '',
  anonKey: '',
};
