'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const db = new Database(path.join(__dirname, 'database.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------------------------------------------------------------------------
// Tabelas (criadas automaticamente)
// ---------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_code TEXT NOT NULL UNIQUE,
  tipo TEXT NOT NULL CHECK (tipo IN ('permanente','temporaria')),
  duracao_dias INTEGER NOT NULL DEFAULT 0,
  user_id TEXT,
  hwid TEXT,
  status TEXT NOT NULL DEFAULT 'disponivel' CHECK (status IN ('disponivel','ativa','expirada')),
  expires_at INTEGER,
  notificar INTEGER NOT NULL DEFAULT 0,
  codigo_indicacao TEXT,
  criada_em INTEGER NOT NULL,
  resgatada_em INTEGER
);

CREATE TABLE IF NOT EXISTS vendas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  plano TEXT NOT NULL,
  valor REAL NOT NULL,
  cupom TEXT,
  codigo_indicacao TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','expired')),
  criada_em INTEGER NOT NULL,
  paga_em INTEGER,
  thread_id TEXT,
  dias INTEGER NOT NULL DEFAULT 0,
  expira_em INTEGER
);

CREATE TABLE IF NOT EXISTS indicacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL UNIQUE,
  codigo TEXT NOT NULL UNIQUE,
  indicado_por TEXT,
  saldo_comissao REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo TEXT NOT NULL UNIQUE,
  desconto_percentual REAL NOT NULL,
  usos_restantes INTEGER NOT NULL DEFAULT 999
);

CREATE INDEX IF NOT EXISTS idx_keys_user ON keys(user_id);
CREATE INDEX IF NOT EXISTS idx_vendas_user ON vendas(user_id);
`);

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const DIA_MS = 86400000;
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 caracteres (sem I, O, 0, 1)

function agora() {
  return Date.now();
}

function bloco(n) {
  const bytes = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += ALFABETO[bytes[i] % ALFABETO.length];
  return s;
}

function gerarKeyUnica() {
  for (;;) {
    const codigo = `SUKY-${bloco(4)}-${bloco(4)}`;
    if (!db.prepare('SELECT 1 FROM keys WHERE key_code = ?').get(codigo)) return codigo;
  }
}

function formatarRestante(k) {
  if (!k) return '-';
  if (k.tipo === 'permanente') return 'Permanente';
  if (k.status === 'disponivel') return `Não resgatada (${k.duracao_dias} dia(s) após resgate)`;
  if (!k.expires_at) return '-';
  const diff = k.expires_at - agora();
  if (diff <= 0) return 'Expirada';
  const d = Math.floor(diff / DIA_MS);
  const h = Math.floor((diff % DIA_MS) / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const partes = [];
  if (d) partes.push(`${d}d`);
  if (h || d) partes.push(`${h}h`);
  partes.push(`${m}min`);
  return partes.join(' ');
}

// ---------------------------------------------------------------------------
// KEYS
// ---------------------------------------------------------------------------
function criarKey({ tipo, dias = 0, codigoIndicacao = null }) {
  const codigo = gerarKeyUnica();
  db.prepare(
    `INSERT INTO keys (key_code, tipo, duracao_dias, status, codigo_indicacao, criada_em)
     VALUES (?, ?, ?, 'disponivel', ?, ?)`
  ).run(codigo, tipo, tipo === 'permanente' ? 0 : dias, codigoIndicacao, agora());
  return codigo;
}

function buscarKey(codigo) {
  if (!codigo) return null;
  return db.prepare('SELECT * FROM keys WHERE key_code = ? COLLATE NOCASE').get(String(codigo).trim()) || null;
}

function keysDoUsuario(userId) {
  return db.prepare('SELECT * FROM keys WHERE user_id = ? ORDER BY criada_em DESC').all(String(userId));
}

function keyAtivaDoUsuario(userId) {
  return (
    db
      .prepare(
        `SELECT * FROM keys
         WHERE user_id = ? AND status = 'ativa'
           AND (tipo = 'permanente' OR expires_at IS NULL OR expires_at > ?)
         ORDER BY (tipo = 'permanente') DESC, expires_at DESC LIMIT 1`
      )
      .get(String(userId), agora()) || null
  );
}

// Retorna a key atualizada ou null se não estava disponível
function ativarKey(codigo, userId, { codigoIndicacao = null, notificar = 0 } = {}) {
  const k = buscarKey(codigo);
  if (!k) return null;
  const exp = k.tipo === 'temporaria' ? agora() + k.duracao_dias * DIA_MS : null;
  const r = db
    .prepare(
      `UPDATE keys SET user_id = ?, status = 'ativa', expires_at = ?, notificar = ?,
         codigo_indicacao = COALESCE(?, codigo_indicacao), resgatada_em = ?
       WHERE key_code = ? AND status = 'disponivel'`
    )
    .run(String(userId), exp, notificar ? 1 : 0, codigoIndicacao, agora(), k.key_code);
  return r.changes === 1 ? buscarKey(k.key_code) : null;
}

function setHwid(codigo, hwid) {
  db.prepare('UPDATE keys SET hwid = ? WHERE key_code = ?').run(hwid, codigo);
}

function limparHwid(codigo) {
  const r = db.prepare('UPDATE keys SET hwid = NULL WHERE key_code = ? COLLATE NOCASE').run(String(codigo).trim());
  return r.changes === 1;
}

function removerKey(codigo) {
  const r = db.prepare('DELETE FROM keys WHERE key_code = ? COLLATE NOCASE').run(String(codigo).trim());
  return r.changes === 1;
}

function adicionarDias(codigo, dias) {
  const k = buscarKey(codigo);
  if (!k || k.tipo !== 'temporaria' || k.status !== 'ativa') return null;
  const base = Math.max(k.expires_at || 0, agora());
  db.prepare('UPDATE keys SET expires_at = ? WHERE key_code = ?').run(base + dias * DIA_MS, k.key_code);
  return buscarKey(k.key_code);
}

function marcarExpirada(codigo) {
  db.prepare("UPDATE keys SET status = 'expirada' WHERE key_code = ?").run(codigo);
}

// Marca como expiradas todas as temporárias vencidas e devolve a lista
function expirarVencidas() {
  const vencidas = db
    .prepare("SELECT * FROM keys WHERE status = 'ativa' AND tipo = 'temporaria' AND expires_at IS NOT NULL AND expires_at <= ?")
    .all(agora());
  const upd = db.prepare("UPDATE keys SET status = 'expirada' WHERE id = ?");
  const tx = db.transaction((rows) => rows.forEach((r) => upd.run(r.id)));
  tx(vencidas);
  return vencidas;
}

function listarPorStatus(status, limite = 500) {
  return db.prepare('SELECT * FROM keys WHERE status = ? ORDER BY criada_em DESC LIMIT ?').all(status, limite);
}

function removerExpiradas() {
  const rows = db.prepare("SELECT * FROM keys WHERE status = 'expirada'").all();
  db.prepare("DELETE FROM keys WHERE status = 'expirada'").run();
  return rows;
}

function statsKeys() {
  const q = (s) => db.prepare('SELECT COUNT(*) AS c FROM keys WHERE status = ?').get(s).c;
  return { disponiveis: q('disponivel'), ativas: q('ativa'), expiradas: q('expirada') };
}

// ---------------------------------------------------------------------------
// INDICAÇÕES
// ---------------------------------------------------------------------------
function getIndicacao(userId) {
  return db.prepare('SELECT * FROM indicacoes WHERE user_id = ?').get(String(userId)) || null;
}

function getIndicacaoPorCodigo(codigo) {
  if (!codigo) return null;
  return db.prepare('SELECT * FROM indicacoes WHERE codigo = ? COLLATE NOCASE').get(String(codigo).trim()) || null;
}

function garantirIndicacao(userId) {
  let r = getIndicacao(userId);
  if (r) return r;
  let codigo;
  do {
    codigo = `REF${bloco(6)}`;
  } while (getIndicacaoPorCodigo(codigo));
  db.prepare('INSERT INTO indicacoes (user_id, codigo, indicado_por, saldo_comissao) VALUES (?, ?, NULL, 0)').run(
    String(userId),
    codigo
  );
  return getIndicacao(userId);
}

// Interpreta o campo "quem te indicou": 0/vazio = ninguém; código existente; ou ID numérico do Discord
function resolverIndicador(texto) {
  const t = String(texto || '').trim();
  if (!t || t === '0') return { ok: true, id: null };
  const porCodigo = getIndicacaoPorCodigo(t);
  if (porCodigo) return { ok: true, id: porCodigo.user_id };
  const m = t.match(/\d{17,20}/);
  if (m) return { ok: true, id: m[0] };
  return { ok: false, id: null };
}

function registrarIndicacao(userId, codigo, indicadoPor) {
  const cod = String(codigo).trim().toUpperCase();
  const dono = getIndicacaoPorCodigo(cod);
  if (dono && dono.user_id !== String(userId)) return { ok: false, erro: 'Esse código de indicação já está em uso por outra pessoa.' };
  if (indicadoPor && indicadoPor === String(userId)) return { ok: false, erro: 'Você não pode indicar a si mesmo.' };

  const existente = getIndicacao(userId);
  if (existente) {
    db.prepare('UPDATE indicacoes SET codigo = ?, indicado_por = COALESCE(?, indicado_por) WHERE user_id = ?').run(
      cod,
      indicadoPor,
      String(userId)
    );
  } else {
    db.prepare('INSERT INTO indicacoes (user_id, codigo, indicado_por, saldo_comissao) VALUES (?, ?, ?, 0)').run(
      String(userId),
      cod,
      indicadoPor
    );
  }
  return { ok: true, registro: getIndicacao(userId) };
}

function creditarComissao(userIndicador, valor) {
  garantirIndicacao(userIndicador);
  db.prepare('UPDATE indicacoes SET saldo_comissao = saldo_comissao + ? WHERE user_id = ?').run(valor, String(userIndicador));
}

// ---------------------------------------------------------------------------
// CUPONS
// ---------------------------------------------------------------------------
function criarCupom(codigo, pct, usos = 999) {
  try {
    db.prepare('INSERT INTO cupons (codigo, desconto_percentual, usos_restantes) VALUES (?, ?, ?)').run(
      String(codigo).trim().toUpperCase(),
      pct,
      usos
    );
    return true;
  } catch (e) {
    return false;
  }
}

function getCupom(codigo) {
  if (!codigo) return null;
  return db.prepare('SELECT * FROM cupons WHERE codigo = ? COLLATE NOCASE').get(String(codigo).trim()) || null;
}

function deletarCupom(codigo) {
  return db.prepare('DELETE FROM cupons WHERE codigo = ? COLLATE NOCASE').run(String(codigo).trim()).changes === 1;
}

function consumirCupom(codigo) {
  return (
    db.prepare('UPDATE cupons SET usos_restantes = usos_restantes - 1 WHERE codigo = ? COLLATE NOCASE AND usos_restantes > 0').run(
      String(codigo).trim()
    ).changes === 1
  );
}

// ---------------------------------------------------------------------------
// VENDAS
// ---------------------------------------------------------------------------
function criarVenda(v) {
  db.prepare(
    `INSERT INTO vendas (transaction_id, user_id, plano, valor, cupom, codigo_indicacao, status, criada_em, thread_id, dias, expira_em)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
  ).run(
    v.transaction_id,
    String(v.user_id),
    v.plano,
    v.valor,
    v.cupom || null,
    v.codigo_indicacao || null,
    agora(),
    v.thread_id || null,
    v.dias || 0,
    v.expira_em || null
  );
}

function getVenda(transactionId) {
  return db.prepare('SELECT * FROM vendas WHERE transaction_id = ?').get(String(transactionId)) || null;
}

// Atômico: só retorna true para quem de fato mudou de pending -> paid (evita entrega dupla)
function marcarVendaPaga(transactionId) {
  return (
    db.prepare("UPDATE vendas SET status = 'paid', paga_em = ? WHERE transaction_id = ? AND status = 'pending'").run(
      agora(),
      String(transactionId)
    ).changes === 1
  );
}

function marcarVendaExpirada(transactionId) {
  return (
    db.prepare("UPDATE vendas SET status = 'expired' WHERE transaction_id = ? AND status = 'pending'").run(String(transactionId))
      .changes === 1
  );
}

function vendasPendentes() {
  return db.prepare("SELECT * FROM vendas WHERE status = 'pending'").all();
}

function ultimasVendas(userId, limite = 10) {
  return db.prepare('SELECT * FROM vendas WHERE user_id = ? ORDER BY criada_em DESC LIMIT ?').all(String(userId), limite);
}

function totalVendasPagas() {
  return db.prepare("SELECT COALESCE(SUM(valor), 0) AS total, COUNT(*) AS qtd FROM vendas WHERE status = 'paid'").get();
}

module.exports = {
  db,
  DIA_MS,
  agora,
  formatarRestante,
  // keys
  criarKey,
  buscarKey,
  keysDoUsuario,
  keyAtivaDoUsuario,
  ativarKey,
  setHwid,
  limparHwid,
  removerKey,
  adicionarDias,
  marcarExpirada,
  expirarVencidas,
  listarPorStatus,
  removerExpiradas,
  statsKeys,
  // indicações
  getIndicacao,
  getIndicacaoPorCodigo,
  garantirIndicacao,
  resolverIndicador,
  registrarIndicacao,
  creditarComissao,
  // cupons
  criarCupom,
  getCupom,
  deletarCupom,
  consumirCupom,
  // vendas
  criarVenda,
  getVenda,
  marcarVendaPaga,
  marcarVendaExpirada,
  vendasPendentes,
  ultimasVendas,
  totalVendasPagas,
};
