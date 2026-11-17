'use strict';
/**
 * Integração com a API Pix da WyviPay.
 *
 * ATENÇÃO: não encontrei documentação pública da WyviPay. Os caminhos e nomes
 * de campos abaixo seguem o padrão comum de gateways Pix. Se a documentação
 * oficial for diferente, ajuste APENAS o bloco "ENDPOINTS" e as funções
 * `normalizarCobranca` / `normalizarStatus` / `extrairTransactionId`.
 */
const QRCode = require('qrcode');
const config = require('./config.json');

// ----------------------------- ENDPOINTS (ajuste aqui) ----------------------
const ENDPOINTS = {
  criar: { method: 'POST', path: '/pix/charges' },
  consultar: { method: 'GET', path: (id) => `/pix/charges/${encodeURIComponent(id)}` },
};
// ---------------------------------------------------------------------------

const BASE = String(config.WYVIPAY_BASE_URL).replace(/\/+$/, '');

async function chamar(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${config.WYVIPAY_API_KEY}`,
      'X-API-Key': config.WYVIPAY_API_KEY,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const texto = await res.text();
  let json;
  try {
    json = texto ? JSON.parse(texto) : {};
  } catch {
    json = { raw: texto };
  }
  if (!res.ok) {
    const msg = json.message || json.error || texto.slice(0, 200) || `HTTP ${res.status}`;
    throw new Error(`WyviPay ${res.status}: ${msg}`);
  }
  return json;
}

function pegar(obj, chaves) {
  for (const k of chaves) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return null;
}

function normalizarStatus(bruto) {
  const s = String(bruto || '').toLowerCase();
  if (['paid', 'approved', 'completed', 'confirmed', 'concluida', 'concluded', 'success', 'succeeded'].includes(s)) return 'paid';
  if (['expired', 'cancelled', 'canceled', 'failed', 'refused', 'removed', 'expirada', 'cancelada'].includes(s)) return 'expired';
  return 'pending';
}

function extrairTransactionId(obj) {
  const raiz = obj && (obj.data || obj.charge || obj.transaction || obj.payment) ? obj.data || obj.charge || obj.transaction || obj.payment : obj;
  return pegar(raiz, ['transaction_id', 'transactionId', 'transactionID', 'id', 'txid', 'identifier']) || pegar(obj, ['transaction_id', 'transactionId', 'id']);
}

function normalizarCobranca(resp) {
  const raiz = resp.data || resp.charge || resp.transaction || resp.payment || resp;
  return {
    transactionId: String(extrairTransactionId(resp)),
    copiaECola: pegar(raiz, ['pix_copia_e_cola', 'pix_copia_cola', 'copia_e_cola', 'copy_paste', 'qrCodeText', 'qr_code_text', 'brcode', 'brCode', 'emv', 'pix_code', 'payload']),
    qrBase64: pegar(raiz, ['qr_code_base64', 'qrCodeBase64', 'qrcode_base64', 'qr_code_image', 'qrCodeImage']),
    status: normalizarStatus(pegar(raiz, ['status'])),
    bruto: resp,
  };
}

/**
 * Cria uma cobrança Pix.
 * @param {{valor:number, descricao:string, compradorId:string}} p  valor em reais (ex.: 9.00)
 * @returns {Promise<{transactionId:string, copiaECola:string, qrBuffer:Buffer}>}
 */
async function criarCobrancaPix({ valor, descricao, compradorId }) {
  const corpo = {
    amount: Number(valor.toFixed(2)), // em reais
    description: descricao,
    external_reference: `suky-${compradorId}-${Date.now()}`,
    expires_in: Number(config.PIX_EXPIRA_MINUTOS || 15) * 60,
  };
  const resp = await chamar(ENDPOINTS.criar.method, ENDPOINTS.criar.path, corpo);
  const c = normalizarCobranca(resp);
  if (!c.transactionId || c.transactionId === 'null') throw new Error('WyviPay não retornou o ID da transação.');
  if (!c.copiaECola && !c.qrBase64) throw new Error('WyviPay não retornou o código Pix.');

  let qrBuffer;
  if (c.qrBase64) {
    qrBuffer = Buffer.from(String(c.qrBase64).replace(/^data:image\/\w+;base64,/, ''), 'base64');
  } else {
    qrBuffer = await QRCode.toBuffer(c.copiaECola, { type: 'png', width: 512, margin: 2 });
  }
  // Se a API só devolveu a imagem, ainda precisamos de um texto: usa o que houver
  return { transactionId: c.transactionId, copiaECola: c.copiaECola || '(use o QR Code acima)', qrBuffer };
}

/**
 * Consulta o status de uma cobrança.
 * @returns {Promise<{status:'pending'|'paid'|'expired'}>}
 */
async function consultarStatusPix(transactionId) {
  const resp = await chamar(ENDPOINTS.consultar.method, ENDPOINTS.consultar.path(transactionId));
  const raiz = resp.data || resp.charge || resp.transaction || resp.payment || resp;
  return { status: normalizarStatus(pegar(raiz, ['status'])), bruto: resp };
}

module.exports = { criarCobrancaPix, consultarStatusPix, extrairTransactionId };
