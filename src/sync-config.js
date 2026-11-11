/**
 * Conversor — Configuração pública do banco compartilhado
 *
 * O app já vem apontando para o projeto Supabase oficial do Conversor: a URL do
 * projeto e a chave **anônima** são públicas por natureza (a proteção dos dados
 * vem da criptografia feita no navegador — ver `sync-crypto.js`). Por isso não
 * existe passo de configuração: quem abre o app já pode criar a chave de acesso
 * e sincronizar os modelos.
 *
 * Nunca coloque aqui a `service_role` key: ela ignora o RLS e dá acesso total.
 *
 * O que cada usuário informar na tela "Nuvem" (URL/chave diferente) continua
 * tendo prioridade sobre estes valores — serve para quem quer apontar para um
 * projeto próprio (por exemplo, uma equipe com banco separado).
 */
export const DEFAULT_CLOUD_CONFIG = {
  /** Project URL do Supabase (sem o sufixo /rest/v1/). */
  url: 'https://byqhiewzkbqvvmldnwky.supabase.co',
  /**
   * Chave pública do projeto (publishable key `sb_publishable_...`, ou a
   * `anon public` legada). É pública por design: quem a tiver lê apenas o
   * conteúdo cifrado no navegador. Nunca use aqui a service_role/secret key.
   */
  anonKey: 'sb_publishable_FUMOIC2IPZZz2SweB_g6Ag_SMJfFvO3',
};
