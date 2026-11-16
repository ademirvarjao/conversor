/**
 * Conversor — Conciliador Bancário (alternativa JR)
 *
 * Interface alternativa ao conciliador de clientes/fornecedores, inspirada no
 * layout do "Conciliador Bancário - JR Gestão e Contabilidade":
 *  - Código empresa + conta bancária
 *  - Upload de planilha Excel de conciliação
 *  - Período (data início / data final)
 *  - Processamento 100% no navegador (ExcelJS)
 *  - Download em duas modalidades: Entrada/Saída e Positivo/Negativo
 *
 * Não depende de servidor: tudo roda localmente, nada sai do navegador.
 */

import { parseMoneyValue, cleanWhitespace, parseDateValue } from './parsers.js';
import { formatValuePlainBr, formatIsoToBrDate } from './format.js';
import { APP_VERSION } from './ui-contract.js';
import {
  isInternalNetwork,
  onInternalNetworkChange,
  internalApiUrl,
} from './internal-network.js';

const STATE = {
  empresa: { codigo: '', nome: '' },
  conta: { codigo: '', descricao: '' },
  file: null,
  workbook: null,
  rows: [], // linhas brutas da planilha
  filtered: [], // linhas após filtro de data
  mode: 'entrada-saida', // 'entrada-saida' | 'positivo-negativo'
};

const DOM = {};

function cacheDom() {
  const ids = [
    'jr-cod-empresa',
    'jr-empresa-nome',
    'jr-conta-banco-select',
    'jr-conta-banco-manual-div',
    'jr-conta-banco-manual',
    'jr-conta-banco',
    'jr-planilha',
    'jr-data-inicio',
    'jr-data-final',
    'jr-btn-processar',
    'jr-download-dropdown',
    'jr-download-entrada-saida',
    'jr-download-positivo-negativo',
    'jr-alert',
    'jr-result',
    'jr-result-thead',
    'jr-result-tbody',
    'jr-empty',
    'jr-totals',
    'jr-btn-limpar',
    'app-version',
  ];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) console.warn(`[Conciliador JR] Elemento #${id} não encontrado.`);
    DOM[id] = el;
  }
}

function showAlert(message, tone = 'error') {
  const box = DOM['jr-alert'];
  if (!box) return;
  box.classList.remove('hidden');
  box.className = `ai-alert ${tone === 'error' ? 'is-error' : 'is-warn'} mt-3`;
  box.textContent = message;
}

function clearAlert() {
  const box = DOM['jr-alert'];
  if (box) { box.classList.add('hidden'); box.textContent = ''; }
}

function setProcessing(active) {
  const btn = DOM['jr-btn-processar'];
  if (!btn) return;
  if (active) {
    btn.disabled = true;
    btn.textContent = 'Processando...';
  } else {
    btn.disabled = false;
    btn.textContent = 'Processar';
  }
}

/* ------------------------------------------------------------------ */
/*                   API da empresa (interna ou simulada)             */
/* ------------------------------------------------------------------ */

/** Busca o nome da empresa no site interno, com fallback para simulação. */
async function buscarEmpresa(codigo) {
  if (isInternalNetwork()) {
    try {
      const response = await fetch(internalApiUrl(`/api/empresa/${codigo}`), {
        mode: 'cors',
        cache: 'no-store',
      });
      const data = await response.json().catch(() => ({}));
      const nome = data.nome ?? null;
      return { nome };
    } catch {
      // Se a rede interna caiu no meio da chamada, segue com a simulação.
    }
  }
  return buscarEmpresaSimulado(codigo);
}

/** Busca as contas bancárias da empresa no site interno, com fallback. */
async function buscarContasBanco(codigo) {
  if (isInternalNetwork()) {
    try {
      const response = await fetch(internalApiUrl(`/api/contas-banco/${codigo}`), {
        mode: 'cors',
        cache: 'no-store',
      });
      const data = await response.json().catch(() => ({}));
      return { contas: data.contas ?? [] };
    } catch {
      // Segue com a simulação quando o site interno não responde.
    }
  }
  return buscarContasBancoSimulado(codigo);
}

/* ------------------------------------------------------------------ */
/*                   Simulação de API (fallback offline)              */
/* ------------------------------------------------------------------ */

/** Simula a busca do nome da empresa pelo código. */
function buscarEmpresaSimulado(codigo) {
  return new Promise((resolve) => {
    setTimeout(() => {
      if (!codigo || codigo.length < 2) {
        resolve({ nome: null });
        return;
      }
      // Simulação: nomes fictícios baseados no código.
      const nomes = {
        '1': 'Lanchonete da Esquina LTDA',
        '10': 'Mercede Comércio de Peças',
        '25': 'Transportadora Sul Brasil',
        '42': 'Distribuidora Alimentos SA',
        '99': 'Serviços Gerais Contábil',
        '9999': 'Empresa Exemplo S/A',
      };
      const nome = nomes[String(codigo)] || `Empresa ${codigo} Ltda`;
      resolve({ nome });
    }, 400);
  });
}

/** Simula a busca de contas bancárias da empresa. */
function buscarContasBancoSimulado(codigo) {
  return new Promise((resolve) => {
    setTimeout(() => {
      if (!codigo) { resolve({ contas: [] }); return; }
      // Simulação: contas fictícias.
      const contas = [
        { contactb: '1001', descrconta: 'Conta Corrente Principal' },
        { contactb: '1002', descrconta: 'Conta Poupança' },
        { contactb: '2005', descrconta: 'Conta Salário' },
      ];
      resolve({ contas });
    }, 400);
  });
}

/* ------------------------------------------------------------------ */
/*                         Eventos do formulário                      */
/* ------------------------------------------------------------------ */

function bindFormEvents() {
  const codInput = DOM['jr-cod-empresa'];
  const nomeDisplay = DOM['jr-empresa-nome'];
  const contaSelect = DOM['jr-conta-banco-select'];
  const contaManualDiv = DOM['jr-conta-banco-manual-div'];
  const contaManualInput = DOM['jr-conta-banco-manual'];
  const contaHidden = DOM['jr-conta-banco'];
  const planilhaInput = DOM['jr-planilha'];
  const btnProcessar = DOM['jr-btn-processar'];

  let debounceTimer = null;

  /** Atualiza conta bancária oculta conforme seleção/manual. */
  function syncContaBanco() {
    const selected = contaSelect.value;
    if (selected === '__outra__') {
      contaManualDiv.style.display = '';
      contaHidden.value = contaManualInput.value || '';
    } else {
      contaManualDiv.style.display = 'none';
      contaHidden.value = selected || '';
    }
    STATE.conta.codigo = contaHidden.value;
    STATE.conta.descricao = contaSelect.options[contaSelect.selectedIndex]?.text || '';
  }

  contaSelect.addEventListener('change', syncContaBanco);
  contaManualInput.addEventListener('input', function () {
    if (this.value.length > 7) this.value = this.value.slice(0, 7);
    contaHidden.value = this.value;
    STATE.conta.codigo = this.value;
    syncContaBanco();
  });

  /** Busca empresa e contas ao digitar o código. */
  codInput.addEventListener('input', async function () {
    const codigo = this.value.trim();
    if (debounceTimer) clearTimeout(debounceTimer);

    if (!nomeDisplay) return;
    if (codigo && codigo.length >= 2) {
      nomeDisplay.classList.remove('d-none');
      nomeDisplay.textContent = 'Carregando...';
      contaSelect.innerHTML = '<option value="">Carregando...</option>';
      contaSelect.disabled = true;

      debounceTimer = setTimeout(async () => {
        try {
          const emp = await buscarEmpresa(codigo);
          if (emp.nome) {
            const exibir = emp.nome.length > 30 ? emp.nome.substring(0, 30) + '...' : emp.nome;
            nomeDisplay.textContent = exibir;
            nomeDisplay.style.color = '#000000';
            nomeDisplay.style.fontStyle = 'normal';
            STATE.empresa = { codigo, nome: emp.nome };
          } else {
            nomeDisplay.textContent = 'Empresa não encontrada';
            nomeDisplay.style.color = '#dc3545';
            STATE.empresa = { codigo, nome: '' };
          }
        } catch {
          nomeDisplay.textContent = 'Erro ao buscar';
          nomeDisplay.style.color = '#dc3545';
        }

        try {
          const contasResp = await buscarContasBanco(codigo);
          contaSelect.innerHTML = '<option value="">Selecione a conta bancária</option>';
          if (contasResp.contas && contasResp.contas.length > 0) {
            for (const conta of contasResp.contas) {
              const opt = document.createElement('option');
              opt.value = conta.contactb;
              opt.textContent = `${conta.contactb} - ${conta.descrconta}`;
              contaSelect.appendChild(opt);
            }
            const optOutra = document.createElement('option');
            optOutra.value = '__outra__';
            optOutra.textContent = 'Outra conta...';
            contaSelect.appendChild(optOutra);
            contaSelect.disabled = false;
          } else {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = 'Nenhuma conta encontrada';
            contaSelect.appendChild(opt);
          }
        } catch {
          contaSelect.innerHTML = '<option value="">Erro ao carregar contas</option>';
        }
      }, 500);
    } else {
      if (nomeDisplay) {
        nomeDisplay.classList.add('d-none');
        nomeDisplay.textContent = '';
      }
      contaSelect.innerHTML = '<option value="">Primeiro, digite o código empresa</option>';
      contaSelect.disabled = true;
      STATE.empresa = { codigo: '', nome: '' };
    }
  });

  /** Processa a planilha. */
  btnProcessar.addEventListener('click', async () => {
    clearAlert();

    const codigo = codInput.value.trim();
    if (!codigo) {
      showAlert('Informe o código da empresa.');
      codInput.focus();
      return;
    }
    if (contaHidden.value === '') {
      showAlert('Selecione ou informe a conta bancária.');
      contaSelect.focus();
      return;
    }
    if (!planilhaInput.files?.length) {
      showAlert('Selecione a planilha de conciliação (.xlsx).');
      planilhaInput.focus();
      return;
    }
    const dataInicio = DOM['jr-data-inicio'].value;
    const dataFinal = DOM['jr-data-final'].value;
    if (!dataInicio || !dataFinal) {
      showAlert('Informe o período (data início e data final).');
      return;
    }
    if (dataFinal < dataInicio) {
      showAlert('A data final não pode ser anterior à data inicial.');
      return;
    }

    setProcessing(true);
    try {
      const file = planilhaInput.files[0];
      const buffer = await file.arrayBuffer();
      const ExcelJS = typeof window !== 'undefined' ? window.ExcelJS : undefined;
      if (!ExcelJS) throw new Error('Biblioteca ExcelJS não carregada.');

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);
      STATE.workbook = workbook;
      STATE.file = file;

      // Lê a primeira aba com dados.
      let headers = [];
      let rawRows = [];
      for (const worksheet of workbook.worksheets) {
        const rows = [];
        worksheet.eachRow((row, rowNumber) => {
          const values = [];
          row.eachCell((cell) => {
            values.push(cell.value);
          });
          rows.push(values);
        });
        if (rows.length > 1) {
          headers = rows[0].map((v) => String(v ?? '')).map((v) => cleanWhitespace(v));
          rawRows = rows.slice(1);
          break;
        }
      }

      if (headers.length === 0) {
        throw new Error('Não foi possível ler cabeçalhos da planilha.');
      }

      STATE.rows = rawRows.map((row) => ({
        headers,
        values: row.map((v) => v ?? ''),
      }));

      processarDados(dataInicio, dataFinal);
    } catch (error) {
      console.error(error);
      showAlert(`Falha ao processar a planilha: ${error.message}`);
    } finally {
      setProcessing(false);
    }
  });

  /** Download dos resultados. */
  DOM['jr-download-entrada-saida']?.addEventListener('click', (e) => {
    e.preventDefault();
    STATE.mode = 'entrada-saida';
    baixarResultado();
  });
  DOM['jr-download-positivo-negativo']?.addEventListener('click', (e) => {
    e.preventDefault();
    STATE.mode = 'positivo-negativo';
    baixarResultado();
  });

  DOM['jr-btn-limpar']?.addEventListener('click', () => {
    STATE.filtered = [];
    STATE.rows = [];
    DOM['jr-result']?.classList.add('d-none');
    DOM['jr-empty']?.style.setProperty('display', 'none');
    DOM['jr-result-tbody'].innerHTML = '';
    DOM['jr-totals'].innerHTML = '';
    DOM['jr-download-dropdown'].disabled = true;
  });
}

/* ------------------------------------------------------------------ */
/*                        Processamento de dados                      */
/* ------------------------------------------------------------------ */

/** Detecta colunas relevantes pelos cabeçalhos. */
function detectarColunas(headers) {
  const norm = headers.map((h) => cleanWhitespace(String(h ?? '')).toLowerCase());
  const find = (patterns) => norm.findIndex((h) => patterns.some((p) => h.includes(p)));

  const dataIdx = find(['data', 'dt']);
  const historicoIdx = find(['historico', 'descricao', 'desc ', 'lancamento', 'memo']);
  const valorIdx = find(['valor', 'vlr', 'amount']);
  const debitoIdx = find(['debito', 'deb', 'saida', 'pagamento']);
  const creditoIdx = find(['credito', 'cred', 'entrada', 'recebimento']);

  return { dataIdx, historicoIdx, valorIdx, debitoIdx, creditoIdx };
}

/** Extrai um valor monetário de uma célula. */
function extrairValor(cell) {
  if (cell === null || cell === undefined || cell === '') return null;
  const parsed = parseMoneyValue(cell);
  return parsed ? parsed.value : null;
}

/** Converte data (string ou Date) para ISO yyyy-mm-dd. */
function paraIso(cell) {
  if (cell instanceof Date) {
    const d = cell;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const parsed = parseDateValue(cell);
  return parsed || '';
}

function processarDados(dataInicio, dataFinal) {
  const { dataIdx, historicoIdx, valorIdx, debitoIdx, creditoIdx } = detectarColunas(STATE.rows[0]?.headers || []);

  if (dataIdx < 0) {
    showAlert('Não foi possível encontrar uma coluna de data na planilha.');
    return;
  }

  const inicio = new Date(dataInicio);
  const final = new Date(dataFinal);
  final.setHours(23, 59, 59, 999);

  const resultados = [];
  let totalEntrada = 0;
  let totalSaida = 0;
  let totalPositivo = 0;
  let totalNegativo = 0;

  for (const row of STATE.rows) {
    const dataIso = paraIso(row.values[dataIdx]);
    if (!dataIso) continue;
    const data = new Date(dataIso + 'T00:00:00');
    if (data < inicio || data > final) continue;

    const historico = cleanWhitespace(String(row.values[historicoIdx] ?? ''));
    const valor = extrairValor(valorIdx >= 0 ? row.values[valorIdx] : null);
    const debito = extrairValor(debitoIdx >= 0 ? row.values[debitoIdx] : null);
    const credito = extrairValor(creditoIdx >= 0 ? row.values[creditoIdx] : null);

    let tipo = '';
    let valorFinal = 0;
    let badge = '';
    let classe = '';

    if (STATE.mode === 'entrada-saida') {
      // Entrada/Saída: usa colunas débito/crédito separadas, ou valor único.
      if (debito !== null && debito > 0) {
        tipo = 'Saída';
        valorFinal = -debito;
        badge = '<span class="jr-badge-saida">Saída</span>';
        classe = 'table-danger';
        totalSaida += debito;
      } else if (credito !== null && credito > 0) {
        tipo = 'Entrada';
        valorFinal = credito;
        badge = '<span class="jr-badge-entrada">Entrada</span>';
        classe = 'table-success';
        totalEntrada += credito;
      } else if (valor !== null) {
        if (valor >= 0) {
          tipo = 'Entrada';
          valorFinal = valor;
          badge = '<span class="jr-badge-entrada">Entrada</span>';
          classe = 'table-success';
          totalEntrada += valor;
        } else {
          tipo = 'Saída';
          valorFinal = valor;
          badge = '<span class="jr-badge-saida">Saída</span>';
          classe = 'table-danger';
          totalSaida += Math.abs(valor);
        }
      } else {
        continue; // sem valor utilizável
      }
    } else {
      // Positivo/Negativo: usa o valor com sinal.
      if (valor !== null) {
        if (valor > 0) {
          tipo = 'Positivo';
          valorFinal = valor;
          badge = '<span class="jr-badge-positivo">Positivo</span>';
          classe = 'table-success';
          totalPositivo += valor;
        } else {
          tipo = 'Negativo';
          valorFinal = valor;
          badge = '<span class="jr-badge-negativo">Negativo</span>';
          classe = 'table-danger';
          totalNegativo += Math.abs(valor);
        }
      } else if (debito !== null && debito > 0) {
        tipo = 'Negativo';
        valorFinal = -debito;
        badge = '<span class="jr-badge-negativo">Negativo</span>';
        classe = 'table-danger';
        totalNegativo += debito;
      } else if (credito !== null && credito > 0) {
        tipo = 'Positivo';
        valorFinal = credito;
        badge = '<span class="jr-badge-positivo">Positivo</span>';
        classe = 'table-success';
        totalPositivo += credito;
      } else {
        continue;
      }
    }

    resultados.push({
      data: formatIsoToBrDate(dataIso),
      historico,
      tipo,
      valor: valorFinal,
      badge,
      classe,
    });
  }

  STATE.filtered = resultados;
  renderResultado(resultados, totalEntrada, totalSaida, totalPositivo, totalNegativo);
}

function renderResultado(resultados, totalEntrada, totalSaida, totalPositivo, totalNegativo) {
  const thead = DOM['jr-result-thead'];
  const tbody = DOM['jr-result-tbody'];
  const resultCard = DOM['jr-result'];
  const empty = DOM['jr-empty'];
  const totals = DOM['jr-totals'];
  const download = DOM['jr-download-dropdown'];

  if (!resultados || resultados.length === 0) {
    resultCard?.classList.remove('d-none');
    empty?.style.setProperty('display', 'block');
    tbody.innerHTML = '';
    thead.innerHTML = '';
    totals.innerHTML = '';
    if (download) download.disabled = true;
    return;
  }

  resultCard?.classList.remove('d-none');
  empty?.style.setProperty('display', 'none');
  if (download) download.disabled = false;

  // Cabeçalho da tabela conforme o modo.
  let colunas = ['Data', 'Histórico', 'Tipo', 'Valor'];
  if (STATE.mode === 'entrada-saida') colunas = ['Data', 'Histórico', 'Tipo', 'Valor'];
  else colunas = ['Data', 'Histórico', 'Tipo', 'Valor'];

  thead.innerHTML = `<tr>${colunas.map((c) => `<th>${c}</th>`).join('')}</tr>`;

  tbody.innerHTML = resultados.map((r) => `
    <tr class="${r.classe}">
      <td>${r.data}</td>
      <td>${r.historico}</td>
      <td>${r.badge}</td>
      <td style="text-align:right;">${formatValuePlainBr(r.valor)}</td>
    </tr>
  `).join('');

  // Totais.
  if (STATE.mode === 'entrada-saida') {
    totals.innerHTML = `
      <div class="jr-total-item">Entradas <strong>${formatValuePlainBr(totalEntrada)}</strong></div>
      <div class="jr-total-item">Saídas <strong>${formatValuePlainBr(totalSaida)}</strong></div>
      <div class="jr-total-item">Saldo <strong>${formatValuePlainBr(totalEntrada - totalSaida)}</strong></div>
    `;
  } else {
    totals.innerHTML = `
      <div class="jr-total-item">Positivos <strong>${formatValuePlainBr(totalPositivo)}</strong></div>
      <div class="jr-total-item">Negativos <strong>${formatValuePlainBr(totalNegativo)}</strong></div>
      <div class="jr-total-item">Saldo <strong>${formatValuePlainBr(totalPositivo - totalNegativo)}</strong></div>
    `;
  }
}

/* ------------------------------------------------------------------ */
/*                        Download dos resultados                      */
/* ------------------------------------------------------------------ */

function baixarResultado() {
  if (!STATE.filtered || STATE.filtered.length === 0) return;

  const stamp = new Date().toISOString().slice(0, 10);
  const empresaRef = STATE.empresa.codigo || 'sem-empresa';
  const contaRef = STATE.conta.codigo || 'sem-conta';
  const nomeArquivo = `conciliacao_jr_${empresaRef}_${contaRef}_${stamp}.csv`;

  let linhas = [];
  if (STATE.mode === 'entrada-saida') {
    linhas = ['data;historico;tipo;valor'];
    for (const r of STATE.filtered) {
      const historico = String(r.historico).replace(/[\r\n;]+/g, ' ').replace(/\s+/g, ' ').trim();
      linhas.push([r.data, historico, r.tipo, formatValuePlainBr(r.valor)].join(';'));
    }
  } else {
    linhas = ['data;historico;tipo;valor'];
    for (const r of STATE.filtered) {
      const historico = String(r.historico).replace(/[\r\n;]+/g, ' ').replace(/\s+/g, ' ').trim();
      linhas.push([r.data, historico, r.tipo, formatValuePlainBr(r.valor)].join(';'));
    }
  }

  const csv = '\uFEFF' + linhas.join('\r\n') + '\r\n';
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nomeArquivo;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1500);
}

/* ------------------------------------------------------------------ */
/*                                  Init                              */
/* ------------------------------------------------------------------ */

function init() {
  cacheDom();
  DOM['app-version'].textContent = `v${APP_VERSION}`;

  // Datas padrão: primeiro dia do mês atual e hoje.
  const hoje = new Date();
  const inicioMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
  const paraInput = (d) => d.toISOString().slice(0, 10);
  DOM['jr-data-inicio'].value = paraInput(inicioMes);
  DOM['jr-data-final'].value = paraInput(hoje);

  bindFormEvents();

  // Detecção de rede interna: atualiza o indicador visual e o comportamento
  // da API (real quando está na rede interna, simulado quando não está).
  const redeStatus = DOM['jr-rede-status'];
  function atualizarRede(online) {
    if (!redeStatus) return;
    redeStatus.classList.toggle('rede-off', !online);
    redeStatus.classList.toggle('rede-on', online);
    redeStatus.title = online
      ? 'Rede interna detectada — usando o banco de dados do site interno'
      : 'Rede interna não detectada — usando dados simulados';
    redeStatus.removeAttribute('aria-hidden');
  }
  atualizarRede(isInternalNetwork());
  onInternalNetworkChange(atualizarRede);
  void startInternalNetworkDetection();
}

init();

if (typeof window !== 'undefined') window.__conciliadorJr = { STATE };
