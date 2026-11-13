/**
 * Melhorias do conciliador: nomes dos campos, filtro por CPF/CNPJ, selo na
 * linha, contadores no aviso e busca que acha também por conta e documento.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const page = await readFile(path.join(ROOT, 'conciliador.html'), 'utf8');
const module = await readFile(path.join(ROOT, 'src/counterparty-page.js'), 'utf8');
const styles = await readFile(path.join(ROOT, 'src/styles.css'), 'utf8');

describe('nomes dos campos de arquivo', () => {
  it('chama o primeiro de "Cadastro Cliente e Fornecedores"', () => {
    assert.match(page, /<span class="cp-file-title">Cadastro Cliente e Fornecedores<\/span>/);
    assert.equal(/Cadastro de contatos/.test(page), false, 'o nome antigo não deve sobrar');
  });

  it('chama o segundo de "Conciliação bancária Conversor"', () => {
    assert.match(page, /<span class="cp-file-title">Conciliação bancária Conversor<\/span>/);
    assert.equal(/Extrato \/ conciliação bancária/.test(page), false, 'o nome antigo não deve sobrar');
  });

  it('o título da seção acompanha os nomes dos cartões', () => {
    assert.match(page, /Carregue o cadastro e a conciliação bancária/);
  });
});

describe('conciliação por CPF/CNPJ na tela', () => {
  it('tem o filtro "CPF/CNPJ" e o módulo sabe filtrar por ele', () => {
    assert.match(page, /data-cp-filter="document"/);
    assert.match(module, /state\.filter === 'document'[\s\S]{0,60}matchReason !== 'document'/);
  });

  it('mostra o selo na linha quando o vínculo veio do documento', () => {
    assert.match(module, /matchReason === 'document'/);
    assert.match(module, /cp-badge is-doc/);
    assert.match(styles, /\.cp-badge\.is-doc\s*\{/);
  });

  it('explica no selo por que a linha foi vinculada', () => {
    assert.match(module, /Math\.round\(row\.score \* 100\)/);
    assert.match(module, /CPF\/CNPJ igual ao do cadastro/);
    assert.match(module, /Há mais de um contato parecido/);
  });

  it('avisa quantos contatos e lançamentos trazem CPF/CNPJ', () => {
    assert.match(module, /const withDocument = contacts\.filter\(\(contact\) => documentDigits\(contact\.document\)\)/);
    assert.match(module, /com CPF\/CNPJ/);
    assert.match(module, /nenhum CPF\/CNPJ no cadastro/);
    assert.match(module, /historyHasDocument\(item\.history\)/);
  });

  it('conta na notificação os vínculos feitos pelo documento', () => {
    assert.match(module, /stats\.byDocument/);
    assert.match(module, /pelo CPF\/CNPJ do histórico/);
  });

  it('mostra o documento e o aviso "mesmo CPF/CNPJ" ao escolher o contato', () => {
    assert.match(module, /formatDocument\(entry\.contact\.document\)/);
    assert.match(module, /historyContainsDocument\(row\.rawHistory, entry\.contact\.document\)/);
    assert.match(module, /mesmo CPF\/CNPJ/);
  });
});

describe('busca da conciliação', () => {
  it('procura por histórico, contato, código, documento, data e contas', () => {
    const trecho = module.slice(module.indexOf('function visibleRows'), module.indexOf('function statusBadge'));
    for (const campo of ['row.history', 'row.contact?.name', 'row.contact?.code', 'row.contact?.document', 'row.date', 'row.debitAccount', 'row.creditAccount']) {
      assert.ok(trecho.includes(campo), `a busca deveria considerar ${campo}`);
    }
  });

  it('continua ignorando acento e caixa', () => {
    assert.match(module, /normalizeText\(haystack\)\.includes\(term\)/);
  });
});
