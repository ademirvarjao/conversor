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
  /** Project URL do Supabase (ex.: https://abcdefgh.supabase.co). */
  url: '',
  /** Chave anônima (public) do projeto — JWT público, seguro em repositório. */
  anonKey: '',
};
