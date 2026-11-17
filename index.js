'use strict';
const express = require('express');
const {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  ChannelType,
  AttachmentBuilder,
  MessageFlags,
} = require('discord.js');

const config = require('./config.json');
const DB = require('./database');
const wy = require('./wyvipay');

const PREFIX = String(config.PREFIX || 's').toLowerCase();
const EPH = { flags: MessageFlags.Ephemeral };
const COR = { roxo: 0x7c3aed, verde: 0x22c55e, vermelho: 0xef4444, amarelo: 0xf59e0b, azul: 0x3b82f6, cinza: 0x6b7280 };

const PLANOS = {
  '1d': { nome: 'Key de 1 dia', label: 'Key de 1 dias. 1 R$', valor: 1.0, dias: 1 },
  '7d': { nome: 'Key de 7 dias', label: 'Key de 7 dias. 9 R$', valor: 9.0, dias: 7 },
  '30d': { nome: 'Key de 1 mês', label: 'Key de 1 mes. 20 R$', valor: 20.0, dias: 30 },
  perm: { nome: 'Key permanente', label: 'Key permanente. 50 R$', valor: 50.0, dias: 0 },
};

const TIPOS_KEY = {
  '1d': { tipo: 'temporaria', dias: 1 },
  '7d': { tipo: 'temporaria', dias: 7 },
  '30d': { tipo: 'temporaria', dias: 30 },
  perm: { tipo: 'permanente', dias: 0 },
};

const COMANDOS_ADMIN = new Set(['painel', 'gerarkey', 'revogarkey', 'addtempo', 'resethwid', 'criarcupom', 'deletarcupom', 'info']);
const COMANDOS_MEMBRO = new Set(['resgatar', 'status', 'script', 'ajuda']);

// ===========================================================================
// Helpers gerais
// ===========================================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

function ts(ms) {
  return ms ? `<t:${Math.floor(ms / 1000)}:f>` : '-';
}

function brl(v) {
  return `R$ ${Number(v || 0).toFixed(2).replace('.', ',')}`;
}

function emb(titulo, cor, descricao) {
  const e = new EmbedBuilder().setColor(cor).setTitle(titulo).setTimestamp();
  if (descricao) e.setDescription(descricao);
  return e;
}

function pedacos(texto, tam = 1900) {
  const out = [];
  let atual = '';
  for (const linha of texto.split('\n')) {
    if ((atual + '\n' + linha).length > tam) {
      out.push(atual);
      atual = linha;
    } else {
      atual = atual ? atual + '\n' + linha : linha;
    }
  }
  if (atual) out.push(atual);
  return out;
}

async function enviarWebhook(url, embed) {
  if (!url || url.includes('COLE_')) return;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'SukyWare Logs', embeds: [embed.toJSON ? embed.toJSON() : embed] }),
    });
    if (!r.ok) console.error('[webhook] falhou', r.status);
  } catch (e) {
    console.error('[webhook] erro:', e.message);
  }
}

function ehAdminId(userId) {
  return (config.ADMIN_AUTHORIZED_IDS || []).includes(String(userId));
}

function ehAdmin(userId, member) {
  if (ehAdminId(userId)) return true;
  return !!(member && member.roles && member.roles.cache && member.roles.cache.has(config.OWNER_ROLE_ID));
}

function linhaCampo(id, label, ph, extra = {}) {
  return { id, label, ph, ...extra };
}

function criarModal(customId, titulo, campos) {
  const m = new ModalBuilder().setCustomId(customId).setTitle(titulo);
  for (const c of campos) {
    const input = new TextInputBuilder()
      .setCustomId(c.id)
      .setLabel(c.label)
      .setStyle(TextInputStyle.Short)
      .setRequired(c.required !== false)
      .setMaxLength(c.max || 100);
    if (c.ph) input.setPlaceholder(c.ph);
    m.addComponents(new ActionRowBuilder().addComponents(input));
  }
  return m;
}

const SNOWFLAKE = /^\d{17,20}$/;

function embedKey(k) {
  const e = emb('🔑 Informações da Key', k.status === 'ativa' ? COR.verde : k.status === 'disponivel' ? COR.azul : COR.vermelho);
  e.addFields(
    { name: 'Key', value: `\`${k.key_code}\``, inline: false },
    { name: 'Tipo', value: k.tipo === 'permanente' ? 'Permanente' : `Temporária (${k.duracao_dias}d)`, inline: true },
    { name: 'Status', value: k.status, inline: true },
    { name: 'Tempo restante', value: DB.formatarRestante(k), inline: true },
    { name: 'Usuário', value: k.user_id ? `<@${k.user_id}> (${k.user_id})` : 'Ninguém', inline: true },
    { name: 'HWID', value: k.hwid ? `\`${k.hwid}\`` : 'Não vinculado', inline: false },
    { name: 'Código de indicação', value: k.codigo_indicacao || '-', inline: true },
    { name: 'Notificações', value: k.notificar ? 'Sim' : 'Não', inline: true },
    { name: 'Criada em', value: ts(k.criada_em), inline: true },
    { name: 'Resgatada em', value: ts(k.resgatada_em), inline: true }
  );
  return e;
}

async function logResgate(titulo, k, userId, executor, extras = []) {
  const e = emb(titulo, COR.verde).addFields(
    { name: 'Key', value: `\`${k.key_code}\``, inline: false },
    { name: 'Tipo', value: k.tipo === 'permanente' ? 'Permanente' : `Temporária (${k.duracao_dias}d)`, inline: true },
    { name: 'Usuário que recebeu', value: `<@${userId}> (${userId})`, inline: true },
    { name: 'Resgatado por', value: `<@${executor}> (${executor})`, inline: true },
    { name: 'Expira em', value: k.tipo === 'permanente' ? 'Nunca' : ts(k.expires_at), inline: true },
    ...extras
  );
  await enviarWebhook(config.WEBHOOK_LOGS_RESGATE, e);
}

async function enviarScriptDM(user) {
  const k = DB.keyAtivaDoUsuario(user.id);
  if (!k) return { ok: false, motivo: 'Você não possui nenhuma key ativa. Resgate ou compre uma key primeiro.' };
  try {
    await user.send({
      embeds: [
        emb('📜 Seu script', COR.roxo, 'Cole no seu executor:\n```lua\n' + config.SCRIPT_LOADSTRING + '\n```\nSua key: `' + k.key_code + '`'),
      ],
    });
    return { ok: true };
  } catch {
    return { ok: false, motivo: 'Não consegui enviar DM. Abra suas mensagens diretas e tente novamente.' };
  }
}

// ===========================================================================
// Vendas / Pix
// ===========================================================================
const sessoes = new Map(); // threadId -> { userId, cupom }
const pollers = new Map(); // transactionId -> intervalo
const emExecucao = new Set();

function pararPolling(tx) {
  const iv = pollers.get(tx);
  if (iv) clearInterval(iv);
  pollers.delete(tx);
}

function iniciarPolling(tx) {
  pararPolling(tx);
  const iv = setInterval(async () => {
    if (emExecucao.has(tx)) return;
    emExecucao.add(tx);
    try {
      const venda = DB.getVenda(tx);
      if (!venda || venda.status !== 'pending') return pararPolling(tx);
      if (venda.expira_em && Date.now() > venda.expira_em) return await finalizarExpirada(tx, 'Tempo para pagamento esgotado.');
      const st = await wy.consultarStatusPix(tx);
      if (st.status === 'paid') await processarPagamento(tx);
      else if (st.status === 'expired') await finalizarExpirada(tx, 'Cobrança expirada ou cancelada na WyviPay.');
    } catch (e) {
      console.error('[polling]', tx, e.message);
    } finally {
      emExecucao.delete(tx);
    }
  }, 5000);
  pollers.set(tx, iv);
}

async function pegarThread(id) {
  if (!id) return null;
  try {
    return await client.channels.fetch(id);
  } catch {
    return null;
  }
}

async function processarPagamento(tx) {
  const venda = DB.getVenda(tx);
  if (!venda) return;
  if (!DB.marcarVendaPaga(tx)) return; // já processada (webhook + polling não duplicam)
  pararPolling(tx);

  const tipo = venda.dias > 0 ? 'temporaria' : 'permanente';
  const key = DB.criarKey({ tipo, dias: venda.dias, codigoIndicacao: venda.codigo_indicacao });

  if (venda.cupom) DB.consumirCupom(venda.cupom);

  // Comissão de indicação
  let comissao = 0;
  const ind = DB.getIndicacao(venda.user_id);
  if (ind && ind.indicado_por) {
    comissao = Number(((venda.valor * Number(config.COMISSAO_INDICACAO_PERCENT || 0)) / 100).toFixed(2));
    if (comissao > 0) DB.creditarComissao(ind.indicado_por, comissao);
  }

  const resgate =
    tipo === 'permanente'
      ? 'Use o botão **🎟️ Resgatar KEY** no painel (ou `' + PREFIX + 'resgatar ' + key + '`).'
      : 'Use o botão **⏳ KEY temporária** no painel. O tempo só começa a contar quando você resgatar.';

  const eKey = emb('✅ Pagamento aprovado!', COR.verde, 'Sua key foi gerada:\n```\n' + key + '\n```\n' + resgate).addFields(
    { name: 'Plano', value: venda.plano, inline: true },
    { name: 'Valor', value: brl(venda.valor), inline: true }
  );

  const thread = await pegarThread(venda.thread_id);
  if (thread) await thread.send({ content: `<@${venda.user_id}>`, embeds: [eKey] }).catch((e) => console.error(e.message));

  try {
    const u = await client.users.fetch(venda.user_id);
    await u.send({ embeds: [eKey] });
  } catch {
    if (thread) await thread.send('⚠️ Não consegui enviar a key na sua DM. Guarde a key acima!').catch(() => {});
  }

  const eLog = emb('💸 Venda aprovada', COR.verde).addFields(
    { name: 'Comprador', value: `<@${venda.user_id}> (${venda.user_id})`, inline: true },
    { name: 'Plano', value: venda.plano, inline: true },
    { name: 'Valor', value: brl(venda.valor), inline: true },
    { name: 'Cupom', value: venda.cupom || '-', inline: true },
    { name: 'Código de indicação', value: venda.codigo_indicacao || '-', inline: true },
    { name: 'Comissão creditada', value: comissao > 0 ? `${brl(comissao)} → <@${ind.indicado_por}>` : '-', inline: true },
    { name: 'Key entregue', value: `\`${key}\``, inline: false },
    { name: 'Transação', value: `\`${tx}\``, inline: false }
  );
  await enviarWebhook(config.WEBHOOK_LOGS_VENDAS, eLog);
}

async function finalizarExpirada(tx, motivo) {
  const venda = DB.getVenda(tx);
  if (!venda) return;
  if (!DB.marcarVendaExpirada(tx)) return;
  pararPolling(tx);

  const thread = await pegarThread(venda.thread_id);
  if (thread) {
    await thread
      .send({ content: `<@${venda.user_id}>`, embeds: [emb('⌛ Pix expirado', COR.vermelho, motivo + '\nSelecione um plano novamente para gerar outro Pix.')] })
      .catch(() => {});
  }
  const eLog = emb('❌ Venda expirada / falhou', COR.vermelho).addFields(
    { name: 'Comprador', value: `<@${venda.user_id}> (${venda.user_id})`, inline: true },
    { name: 'Plano', value: venda.plano, inline: true },
    { name: 'Valor', value: brl(venda.valor), inline: true },
    { name: 'Motivo', value: motivo, inline: false },
    { name: 'Transação', value: `\`${tx}\``, inline: false }
  );
  await enviarWebhook(config.WEBHOOK_LOGS_VENDAS, eLog);
}

// ===========================================================================
// Painel
// ===========================================================================
function painelPayload() {
  const embed = new EmbedBuilder()
    .setColor(COR.roxo)
    .setTitle('⚡ SukyWare • Central de Keys')
    .setDescription(
      [
        'Gerencie sua key, HWID, indicações e compras automáticas por **Pix**.',
        '',
        '🎟️ **Resgatar KEY** — ative uma key permanente',
        '⏳ **KEY temporária** — ative uma key de 1/7/30 dias',
        '📜 **Pegar script** — receba o loadstring na DM',
        '🛒 **Comprar key** — pagamento Pix com entrega automática',
      ].join('\n')
    )
    .setFooter({ text: 'SukyWare • Suporte via tópico privado' })
    .setTimestamp();

  const B = (id, label, style) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
  const rows = [
    new ActionRowBuilder().addComponents(
      B('btn_hwid', '📋 Copiar HWID', ButtonStyle.Secondary),
      B('btn_resgatar', '🎟️ Resgatar KEY', ButtonStyle.Success),
      B('btn_temp', '⏳ KEY temporária', ButtonStyle.Primary)
    ),
    new ActionRowBuilder().addComponents(
      B('btn_script', '📜 Pegar script', ButtonStyle.Success),
      B('btn_status', '🔍 Meu status', ButtonStyle.Secondary),
      B('btn_reset', '🔄 Reset HWID', ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      B('btn_indicacao', '🎁 Meu código de indicação', ButtonStyle.Primary),
      B('btn_saldo', '💰 Ver meu saldo', ButtonStyle.Success),
      B('btn_extrato', '🧾 Meu extrato', ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(B('btn_comprar', '🛒 Comprar key', ButtonStyle.Success)),
  ];
  return { embeds: [embed], components: rows };
}

function painelAdminPayload() {
  const s = DB.statsKeys();
  const tot = DB.totalVendasPagas();
  DB.expirarVencidas();
  const ativas = DB.listarPorStatus('ativa', 15);
  const expiradas = DB.listarPorStatus('expirada', 15);
  const fmt = (arr) =>
    arr.length ? arr.map((k) => `\`${k.key_code}\` • ${k.user_id ? `<@${k.user_id}>` : '-'} • ${DB.formatarRestante(k)}`).join('\n').slice(0, 1000) : 'Nenhuma';

  const embed = emb('🛠️ Painel Administrativo', COR.amarelo).addFields(
    { name: 'Disponíveis', value: String(s.disponiveis), inline: true },
    { name: 'Ativas', value: String(s.ativas), inline: true },
    { name: 'Esgotadas/Expiradas', value: String(s.expiradas), inline: true },
    { name: 'Vendas aprovadas', value: `${tot.qtd} • ${brl(tot.total)}`, inline: false },
    { name: 'Keys ativas (até 15)', value: fmt(ativas), inline: false },
    { name: 'Keys esgotadas (até 15)', value: fmt(expiradas), inline: false }
  );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('admin_resetall').setLabel('🗑️ Reset all').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('admin_resethwid').setLabel('🔓 Resetar HWID Específico').setStyle(ButtonStyle.Primary)
  );
  return { embeds: [embed], components: [row], ...EPH };
}

// ===========================================================================
// Botões
// ===========================================================================
const CODIGO_HWID = 'setclipboard(tostring(gethwid and gethwid() or game:GetService("RbxAnalyticsService"):GetClientId()))';

async function onButton(i) {
  const id = i.customId;

  if (id === 'btn_hwid') {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('hwid_cel').setLabel('📱 Celular').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('hwid_pc').setLabel('💻 PC').setStyle(ButtonStyle.Secondary)
    );
    return i.reply({ content: 'Em qual dispositivo você vai executar o script?', components: [row], ...EPH });
  }

  if (id === 'hwid_cel' || id === 'hwid_pc') {
    const cel = id === 'hwid_cel';
    const passos = cel
      ? ['1. Abra o Roblox e entre em qualquer jogo.', '2. Abra o executor no celular.', '3. Cole o código abaixo e execute.', '4. Segure no campo de texto do Discord e toque em **Colar** para ver seu HWID.']
      : ['1. Abra o Roblox e entre em qualquer jogo.', '2. Abra seu executor no PC.', '3. Cole o código abaixo e execute.', '4. Use **Ctrl+V** em qualquer lugar para ver seu HWID.'];
    const e = emb(`📋 Copiar HWID — ${cel ? 'Celular' : 'PC'}`, COR.azul, passos.join('\n') + '\n\n```lua\n' + CODIGO_HWID + '\n```');
    return i.update({ content: '', embeds: [e], components: [] });
  }

  if (id === 'btn_resgatar') {
    return i.showModal(
      criarModal('modal_resgatar', 'Resgatar Key Permanente', [
        linhaCampo('key', 'Digite sua Key Permanente', 'SUKY-XXXX-XXXX'),
        linhaCampo('uid', 'ID do Discord que receberá o acesso', 'Ex.: 123456789012345678', { max: 20 }),
      ])
    );
  }

  if (id === 'btn_temp') {
    return i.showModal(
      criarModal('modal_temp', 'Resgatar Key Temporária', [
        linhaCampo('ind', 'Código de Indicação (0 para null/sem)', '0'),
        linhaCampo('key', 'Key do usuário', 'SUKY-XXXX-XXXX'),
        linhaCampo('uid', 'ID do usuário', 'Ex.: 123456789012345678', { max: 20 }),
        linhaCampo('notif', 'Receber notificações? (0 para null/sem)', '0 ou sim', { max: 10 }),
      ])
    );
  }

  if (id === 'btn_script') {
    await i.deferReply(EPH);
    const r = await enviarScriptDM(i.user);
    return i.editReply(r.ok ? '✅ Enviei o script na sua DM!' : `❌ ${r.motivo}`);
  }

  if (id === 'btn_status') {
    return i.showModal(
      criarModal('modal_status', 'Consultar Status', [
        linhaCampo('key', 'Digite sua Key', 'SUKY-XXXX-XXXX'),
        linhaCampo('uid', 'Seu ID do Discord', 'Ex.: 123456789012345678', { max: 20 }),
      ])
    );
  }

  if (id === 'btn_reset') {
    return i.showModal(
      criarModal('modal_reset', 'Painel Administrativo', [
        linhaCampo('uid', 'ID do Discord do usuário', 'Seu ID de administrador', { max: 20 }),
        linhaCampo('senha', 'Senha do HWID', 'Senha administrativa', { max: 60 }),
      ])
    );
  }

  if (id === 'btn_indicacao') {
    const atual = DB.getIndicacao(i.user.id);
    return i.showModal(
      criarModal('modal_indicacao', 'Código de Indicação', [
        linhaCampo('quem', 'Quem te indicou?', 'Código ou ID de quem indicou (0 para ninguém)'),
        linhaCampo('codigo', 'Código de indicação', 'Seu código personalizado', { max: 20, ...(atual ? {} : {}) }),
        linhaCampo('uid', 'ID do usuário', 'Seu ID do Discord', { max: 20 }),
      ])
    );
  }

  if (id === 'btn_saldo') {
    const tot = DB.totalVendasPagas();
    const ind = DB.getIndicacao(i.user.id);
    const e = emb('💰 Seu saldo', COR.verde).addFields(
      { name: 'Total de vendas aprovadas (bot)', value: `${brl(tot.total)} (${tot.qtd} venda(s))`, inline: false },
      { name: 'Saldo de indicações', value: brl(ind ? ind.saldo_comissao : 0), inline: true },
      { name: 'Seu código', value: ind ? `\`${ind.codigo}\`` : 'Não registrado', inline: true }
    );
    return i.reply({ embeds: [e], ...EPH });
  }

  if (id === 'btn_extrato') {
    const vendas = DB.ultimasVendas(i.user.id, 10);
    const linhas = vendas.length
      ? vendas.map((v) => `${ts(v.criada_em)} • **${v.plano}** • ${brl(v.valor)} • \`${v.status}\``).join('\n')
      : 'Nenhum lançamento encontrado.';
    return i.reply({ embeds: [emb('🧾 Seu extrato (últimos 10)', COR.azul, linhas)], ...EPH });
  }

  if (id === 'btn_comprar') return abrirCompra(i);

  if (id === 'promo_cupom') {
    return i.showModal(criarModal('modal_cupom', 'Código Promocional', [linhaCampo('codigo', 'Digite o código promocional', 'EX: SUKY10', { max: 30 })]));
  }

  if (id === 'close_thread') {
    const sess = sessoes.get(i.channelId);
    const permitido = ehAdmin(i.user.id, i.member) || (sess && sess.userId === i.user.id);
    if (!permitido) return i.reply({ content: '❌ Apenas o comprador ou um dono pode fechar este tópico.', ...EPH });
    await i.reply('🔒 Tópico fechado. Obrigado!');
    sessoes.delete(i.channelId);
    for (const v of DB.vendasPendentes()) if (v.thread_id === i.channelId) await finalizarExpirada(v.transaction_id, 'Tópico fechado antes do pagamento.');
    await i.channel.setLocked(true).catch(() => {});
    return i.channel.setArchived(true).catch(() => {});
  }

  if (id === 'admin_resetall') {
    if (!ehAdminId(i.user.id)) return i.reply({ content: '❌ Sem permissão.', ...EPH });
    DB.expirarVencidas();
    const removidas = DB.removerExpiradas();
    const texto = removidas.length
      ? removidas.map((k) => `${k.key_code} | user:${k.user_id || '-'} | hwid:${k.hwid || '-'} | ${k.tipo}`).join('\n')
      : 'Nenhuma key removida.';
    const partes = pedacos(texto, 3900);
    for (let n = 0; n < partes.length; n++) {
      const e = emb(`🗑️ Reset all — keys esgotadas removidas (${removidas.length})${partes.length > 1 ? ` [${n + 1}/${partes.length}]` : ''}`, COR.vermelho, '```\n' + partes[n] + '\n```').addFields({
        name: 'Executado por',
        value: `<@${i.user.id}> (${i.user.id})`,
      });
      await enviarWebhook(config.WEBHOOK_LOGS_KEYS_USADAS, e);
    }
    return i.reply({ content: `✅ ${removidas.length} key(s) esgotada(s)/expirada(s) removida(s). Log enviado.`, ...EPH });
  }

  if (id === 'admin_resethwid') {
    if (!ehAdminId(i.user.id)) return i.reply({ content: '❌ Sem permissão.', ...EPH });
    return i.showModal(criarModal('modal_hwid_especifico', 'Resetar HWID Específico', [linhaCampo('key', 'Key para limpar o HWID', 'SUKY-XXXX-XXXX')]));
  }
}

// ===========================================================================
// Compra (tópico privado + Pix)
// ===========================================================================
async function abrirCompra(i) {
  const canal = i.channel;
  if (!canal || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(canal.type)) {
    return i.reply({ content: '❌ Use este botão em um canal de texto do servidor.', ...EPH });
  }
  await i.deferReply(EPH);

  const nome = `🛒-${i.user.username}`.slice(0, 80);
  const thread = await canal.threads.create({
    name: `${nome}-${String(Date.now()).slice(-4)}`,
    type: ChannelType.PrivateThread,
    autoArchiveDuration: 1440,
    invitable: false,
    reason: `Compra de key — ${i.user.tag}`,
  });
  await thread.members.add(i.user.id).catch(() => {});

  // Adiciona os donos (cargo OWNER_ROLE_ID) ao tópico privado
  try {
    await i.guild.members.fetch();
    const role = await i.guild.roles.fetch(config.OWNER_ROLE_ID);
    if (role) {
      let n = 0;
      for (const m of role.members.values()) {
        if (m.user.bot || n >= 25) continue;
        await thread.members.add(m.id).catch(() => {});
        n++;
      }
    }
  } catch (e) {
    console.error('[compra] não consegui adicionar os donos:', e.message);
  }

  sessoes.set(thread.id, { userId: i.user.id, cupom: null });

  const menu = new StringSelectMenuBuilder()
    .setCustomId('select_plano')
    .setPlaceholder('Escolha o seu plano')
    .addOptions(Object.entries(PLANOS).map(([valor, p]) => ({ label: p.label, value: valor })));
  const botoes = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('promo_cupom').setLabel('🎟️ Código Promocional').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('close_thread').setLabel('🔒 Fechar Tópico').setStyle(ButtonStyle.Danger)
  );

  await thread.send({
    content: `<@${i.user.id}>`,
    embeds: [emb('🛒 Comprar key', COR.roxo, 'Olá escolha o plano a baixo, e se possivel resgate um codigo promocional!')],
    components: [new ActionRowBuilder().addComponents(menu), botoes],
  });
  return i.editReply(`✅ Tópico criado: ${thread}`);
}

async function onSelect(i) {
  if (i.customId !== 'select_plano') return;
  const plano = PLANOS[i.values[0]];
  if (!plano) return i.reply({ content: '❌ Plano inválido.', ...EPH });

  const sess = sessoes.get(i.channelId) || { userId: i.user.id, cupom: null };
  if (sess.userId !== i.user.id) return i.reply({ content: '❌ Apenas o comprador pode escolher o plano.', ...EPH });
  sessoes.set(i.channelId, sess);

  await i.deferReply(EPH);

  // Cupom
  let valor = plano.valor;
  let cupomUsado = null;
  let descontoTxt = '';
  if (sess.cupom) {
    const c = DB.getCupom(sess.cupom);
    if (c && c.usos_restantes > 0) {
      valor = Math.max(0.01, Number((plano.valor * (1 - c.desconto_percentual / 100)).toFixed(2)));
      cupomUsado = c.codigo;
      descontoTxt = ` (cupom **${c.codigo}** −${c.desconto_percentual}%)`;
    }
  }

  // Cancela cobrança pendente anterior deste tópico
  for (const v of DB.vendasPendentes()) {
    if (v.thread_id === i.channelId) {
      DB.marcarVendaExpirada(v.transaction_id);
      pararPolling(v.transaction_id);
    }
  }

  // Aviso aos donos
  try {
    const canalAdmin = await client.channels.fetch(config.ADMIN_NOTIFY_CHANNEL_ID);
    const link = `https://discord.com/channels/${i.guildId}/${i.channelId}`;
    await canalAdmin.send({
      content: config.OWNER_ROLE_ID ? `<@&${config.OWNER_ROLE_ID}>` : undefined,
      embeds: [
        emb('🛎️ Novo atendimento de compra', COR.amarelo, 'Algum dono, por favor, atenda o tópico privado.').addFields(
          { name: 'Cliente', value: `<@${i.user.id}> (${i.user.id})`, inline: true },
          { name: 'Plano', value: plano.nome, inline: true },
          { name: 'Valor', value: brl(valor), inline: true }
        ),
      ],
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Abrir tópico').setStyle(ButtonStyle.Link).setURL(link))],
    });
  } catch (e) {
    console.error('[compra] aviso aos donos falhou:', e.message);
  }

  // Pix
  let cobranca;
  try {
    cobranca = await wy.criarCobrancaPix({ valor, descricao: `SukyWare - ${plano.nome}`, compradorId: i.user.id });
  } catch (e) {
    console.error('[pix] erro ao criar cobrança:', e.message);
    return i.editReply('❌ Não consegui gerar o Pix agora. Tente novamente em instantes ou chame um dono.');
  }

  const minutos = Number(config.PIX_EXPIRA_MINUTOS || 15);
  const ind = DB.getIndicacao(i.user.id);
  const indicador = ind && ind.indicado_por ? DB.getIndicacao(ind.indicado_por) : null;

  DB.criarVenda({
    transaction_id: cobranca.transactionId,
    user_id: i.user.id,
    plano: plano.nome,
    valor,
    cupom: cupomUsado,
    codigo_indicacao: indicador ? indicador.codigo : null,
    thread_id: i.channelId,
    dias: plano.dias,
    expira_em: Date.now() + minutos * 60000,
  });
  iniciarPolling(cobranca.transactionId);

  const arquivo = new AttachmentBuilder(cobranca.qrBuffer, { name: 'qrcode.png' });
  const e = emb('💳 Pagamento via Pix', COR.verde, `**${plano.nome}** — ${brl(valor)}${descontoTxt}\n\nPix Copia e Cola:\n\`\`\`\n${cobranca.copiaECola}\n\`\`\`\nEscaneie o QR Code ou copie o código acima.`)
    .setImage('attachment://qrcode.png')
    .setFooter({ text: `Expira em ${minutos} min • A key é entregue automaticamente após o pagamento` });

  await i.channel.send({ content: `<@${i.user.id}>`, embeds: [e], files: [arquivo] });
  return i.editReply('✅ Pix gerado! Veja a mensagem acima no tópico.');
}

// ===========================================================================
// Modais
// ===========================================================================
async function onModal(i) {
  const id = i.customId;
  const f = (n) => (i.fields.getTextInputValue(n) || '').trim();

  if (id === 'modal_resgatar') {
    const uid = f('uid');
    if (!SNOWFLAKE.test(uid)) return i.reply({ content: '❌ ID do Discord inválido.', ...EPH });
    const k = DB.buscarKey(f('key'));
    if (!k) return i.reply({ content: '❌ Key não encontrada.', ...EPH });
    if (k.tipo !== 'permanente') return i.reply({ content: '❌ Essa não é uma key permanente. Use o botão **⏳ KEY temporária**.', ...EPH });
    if (k.status !== 'disponivel') return i.reply({ content: '❌ Essa key já foi resgatada ou não está disponível.', ...EPH });
    const ativa = DB.ativarKey(k.key_code, uid);
    if (!ativa) return i.reply({ content: '❌ Essa key acabou de ser resgatada por outra pessoa.', ...EPH });
    await i.reply({ content: `✅ Key permanente ativada para <@${uid}>! Use **📜 Pegar script** para receber o script.`, ...EPH });
    return logResgate('🎟️ Key permanente resgatada', ativa, uid, i.user.id);
  }

  if (id === 'modal_temp') {
    const uid = f('uid');
    if (!SNOWFLAKE.test(uid)) return i.reply({ content: '❌ ID do usuário inválido.', ...EPH });
    const indTxt = f('ind');
    let codigoInd = null;
    if (indTxt && indTxt !== '0') {
      const r = DB.getIndicacaoPorCodigo(indTxt);
      if (!r) return i.reply({ content: '❌ Código de indicação não encontrado. Digite 0 se não tiver.', ...EPH });
      if (r.user_id === uid) return i.reply({ content: '❌ Você não pode usar o seu próprio código de indicação.', ...EPH });
      codigoInd = r.codigo;
    }
    const nt = f('notif').toLowerCase();
    const notificar = nt !== '' && nt !== '0' && nt !== 'null' && nt !== 'nao' && nt !== 'não' ? 1 : 0;

    const k = DB.buscarKey(f('key'));
    if (!k) return i.reply({ content: '❌ Key não encontrada.', ...EPH });
    if (k.tipo !== 'temporaria') return i.reply({ content: '❌ Essa é uma key permanente. Use o botão **🎟️ Resgatar KEY**.', ...EPH });
    if (k.status !== 'disponivel') return i.reply({ content: '❌ Essa key já foi resgatada ou expirou.', ...EPH });
    const ativa = DB.ativarKey(k.key_code, uid, { codigoIndicacao: codigoInd, notificar });
    if (!ativa) return i.reply({ content: '❌ Essa key acabou de ser resgatada por outra pessoa.', ...EPH });
    await i.reply({ content: `✅ Key temporária ativada para <@${uid}>! Expira ${ts(ativa.expires_at)}.`, ...EPH });
    return logResgate('⏳ Key temporária resgatada', ativa, uid, i.user.id, [
      { name: 'Código de indicação', value: codigoInd || '-', inline: true },
      { name: 'Notificações', value: notificar ? 'Sim' : 'Não', inline: true },
    ]);
  }

  if (id === 'modal_status') {
    DB.expirarVencidas();
    const uid = f('uid');
    const k = DB.buscarKey(f('key'));
    if (!k || (k.user_id && k.user_id !== uid && !ehAdmin(i.user.id, i.member)) || (!k.user_id && !ehAdmin(i.user.id, i.member))) {
      return i.reply({ content: '❌ Key não encontrada ou não pertence a esse ID.', ...EPH });
    }
    const e = emb('🔍 Status da Key', k.status === 'ativa' ? COR.verde : COR.vermelho).addFields(
      { name: 'Status', value: k.status, inline: true },
      { name: 'HWID vinculado', value: k.hwid ? `\`${k.hwid}\`` : 'Não vinculado', inline: false },
      { name: 'Tempo restante', value: DB.formatarRestante(k), inline: true }
    );
    return i.reply({ embeds: [e], ...EPH });
  }

  if (id === 'modal_reset') {
    const uid = f('uid');
    if (uid !== i.user.id || !ehAdminId(uid) || f('senha') !== String(config.ADMIN_HWID_PASSWORD)) {
      return i.reply({ content: '❌ Acesso negado.', ...EPH });
    }
    return i.reply(painelAdminPayload());
  }

  if (id === 'modal_hwid_especifico') {
    if (!ehAdminId(i.user.id)) return i.reply({ content: '❌ Sem permissão.', ...EPH });
    const k = DB.buscarKey(f('key'));
    if (!k) return i.reply({ content: '❌ Key não encontrada.', ...EPH });
    DB.limparHwid(k.key_code);
    return i.reply({ content: `✅ HWID da key \`${k.key_code}\` foi limpo.`, ...EPH });
  }

  if (id === 'modal_indicacao') {
    const uid = f('uid');
    if (!SNOWFLAKE.test(uid)) return i.reply({ content: '❌ ID do usuário inválido.', ...EPH });
    if (uid !== i.user.id && !ehAdmin(i.user.id, i.member)) return i.reply({ content: '❌ Você só pode registrar o código para o seu próprio ID.', ...EPH });
    const codigo = f('codigo');
    if (!/^[A-Za-z0-9_-]{3,20}$/.test(codigo)) return i.reply({ content: '❌ O código deve ter de 3 a 20 caracteres (letras, números, - ou _).', ...EPH });
    const quem = DB.resolverIndicador(f('quem'));
    if (!quem.ok) return i.reply({ content: '❌ Não encontrei quem te indicou. Use o código/ID dele ou 0.', ...EPH });
    const r = DB.registrarIndicacao(uid, codigo, quem.id);
    if (!r.ok) return i.reply({ content: `❌ ${r.erro}`, ...EPH });
    await i.reply({ content: `✅ Código de indicação **${r.registro.codigo}** registrado!`, ...EPH });
    const e = emb('🎁 Indicação registrada', COR.azul).addFields(
      { name: 'Usuário', value: `<@${uid}> (${uid})`, inline: true },
      { name: 'Código', value: `\`${r.registro.codigo}\``, inline: true },
      { name: 'Indicado por', value: quem.id ? `<@${quem.id}>` : 'Ninguém', inline: true }
    );
    return enviarWebhook(config.WEBHOOK_LOGS_RESGATE, e);
  }

  if (id === 'modal_cupom') {
    const sess = sessoes.get(i.channelId) || { userId: i.user.id, cupom: null };
    if (sess.userId !== i.user.id) return i.reply({ content: '❌ Apenas o comprador pode aplicar cupons.', ...EPH });
    const c = DB.getCupom(f('codigo'));
    if (!c || c.usos_restantes <= 0) return i.reply({ content: '❌ Cupom inválido ou esgotado.', ...EPH });
    sess.cupom = c.codigo;
    sessoes.set(i.channelId, sess);
    return i.reply({ content: `✅ Cupom **${c.codigo}** aplicado: **${c.desconto_percentual}%** de desconto. Agora escolha o plano.`, ...EPH });
  }
}

// ===========================================================================
// Comandos com prefixo
// ===========================================================================
async function dmOuResponder(m, conteudo) {
  try {
    await m.author.send(conteudo);
    return true;
  } catch {
    await m.reply('❌ Não consegui enviar DM. Abra suas mensagens diretas e tente de novo.').catch(() => {});
    return false;
  }
}

async function onMessage(m) {
  if (m.author.bot) return;
  const texto = m.content || '';
  if (!texto.toLowerCase().startsWith(PREFIX)) return;

  const [cmdRaw, ...args] = texto.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = (cmdRaw || '').toLowerCase();
  const admin = COMANDOS_ADMIN.has(cmd);
  if (!admin && !COMANDOS_MEMBRO.has(cmd)) return; // ignora mensagens normais que começam com "s"

  if (admin && !ehAdmin(m.author.id, m.member)) return m.reply('❌ Você não tem permissão para usar este comando.');

  switch (cmd) {
    case 'painel': {
      if (!m.guild) return m.reply('❌ Use este comando em um servidor.');
      await m.channel.send(painelPayload());
      return m.delete().catch(() => {});
    }

    case 'gerarkey': {
      const t = TIPOS_KEY[(args[0] || '').toLowerCase()];
      if (!t) return m.reply(`❌ Uso: \`${PREFIX}gerarkey <1d|7d|30d|perm> [quantidade]\``);
      const qtd = Math.min(Math.max(parseInt(args[1] || '1', 10) || 1, 1), 100);
      const keys = [];
      for (let n = 0; n < qtd; n++) keys.push(DB.criarKey({ tipo: t.tipo, dias: t.dias }));
      const rotulo = t.tipo === 'permanente' ? 'Permanente' : `${t.dias} dia(s)`;
      const partes = pedacos(keys.join('\n'), 1800);
      let ok = true;
      for (let n = 0; n < partes.length && ok; n++) {
        ok = await dmOuResponder(m, { content: `🔑 **${qtd} key(s) — ${rotulo}**${partes.length > 1 ? ` [${n + 1}/${partes.length}]` : ''}\n\`\`\`\n${partes[n]}\n\`\`\`` });
      }
      if (ok && m.guild) await m.reply(`✅ ${qtd} key(s) gerada(s) e enviada(s) na sua DM.`);
      return;
    }

    case 'revogarkey': {
      if (!args[0]) return m.reply(`❌ Uso: \`${PREFIX}revogarkey <key>\``);
      return m.reply(DB.removerKey(args[0]) ? `✅ Key \`${args[0]}\` revogada e removida.` : '❌ Key não encontrada.');
    }

    case 'addtempo': {
      const dias = parseInt(args[1], 10);
      if (!args[0] || !dias || dias <= 0) return m.reply(`❌ Uso: \`${PREFIX}addtempo <key> <dias>\``);
      const k = DB.adicionarDias(args[0], dias);
      return m.reply(k ? `✅ +${dias} dia(s) na key \`${k.key_code}\`. Nova validade: ${ts(k.expires_at)}` : '❌ Key não encontrada, não é temporária ou não está ativa.');
    }

    case 'resethwid': {
      if (!args[0]) return m.reply(`❌ Uso: \`${PREFIX}resethwid <key>\``);
      return m.reply(DB.limparHwid(args[0]) ? `✅ HWID da key \`${args[0]}\` limpo.` : '❌ Key não encontrada.');
    }

    case 'criarcupom': {
      const pct = parseFloat(args[1]);
      const usos = args[2] ? parseInt(args[2], 10) : 999;
      if (!args[0] || !(pct > 0 && pct <= 100) || !(usos > 0)) return m.reply(`❌ Uso: \`${PREFIX}criarcupom <codigo> <porcentagem 1-100> [usos]\``);
      return m.reply(DB.criarCupom(args[0], pct, usos) ? `✅ Cupom **${args[0].toUpperCase()}** criado: ${pct}% • ${usos} uso(s).` : '❌ Já existe um cupom com esse código.');
    }

    case 'deletarcupom': {
      if (!args[0]) return m.reply(`❌ Uso: \`${PREFIX}deletarcupom <codigo>\``);
      return m.reply(DB.deletarCupom(args[0]) ? `✅ Cupom **${args[0].toUpperCase()}** removido.` : '❌ Cupom não encontrado.');
    }

    case 'info': {
      DB.expirarVencidas();
      const alvo = args[0];
      if (!alvo) return m.reply(`❌ Uso: \`${PREFIX}info <key ou @usuario/ID>\``);
      if (/^suky-/i.test(alvo)) {
        const k = DB.buscarKey(alvo);
        return k ? m.reply({ embeds: [embedKey(k)] }) : m.reply('❌ Key não encontrada.');
      }
      const idm = alvo.match(/\d{17,20}/);
      if (!idm) return m.reply('❌ Informe uma key (SUKY-...) ou um @usuário/ID válido.');
      const uid = idm[0];
      const keys = DB.keysDoUsuario(uid);
      const ind = DB.getIndicacao(uid);
      const vendas = DB.ultimasVendas(uid, 5);
      const e = emb('👤 Informações do usuário', COR.azul).addFields(
        { name: 'Usuário', value: `<@${uid}> (${uid})`, inline: false },
        {
          name: `Keys (${keys.length})`,
          value: keys.length ? keys.slice(0, 8).map((k) => `\`${k.key_code}\` • ${k.status} • ${DB.formatarRestante(k)}\nHWID: ${k.hwid ? '`' + k.hwid + '`' : 'Não vinculado'}`).join('\n').slice(0, 1024) : 'Nenhuma',
          inline: false,
        },
        { name: 'Código de indicação', value: ind ? `\`${ind.codigo}\`` : '-', inline: true },
        { name: 'Saldo de comissão', value: brl(ind ? ind.saldo_comissao : 0), inline: true },
        { name: 'Indicado por', value: ind && ind.indicado_por ? `<@${ind.indicado_por}>` : '-', inline: true },
        { name: 'Últimas compras', value: vendas.length ? vendas.map((v) => `${v.plano} • ${brl(v.valor)} • ${v.status}`).join('\n') : 'Nenhuma', inline: false }
      );
      return m.reply({ embeds: [e] });
    }

    case 'resgatar': {
      if (!args[0]) return m.reply(`❌ Uso: \`${PREFIX}resgatar <key>\``);
      m.delete().catch(() => {}); // evita deixar a key visível no chat
      const k = DB.buscarKey(args[0]);
      if (!k) return m.channel.send(`❌ <@${m.author.id}> Key não encontrada.`);
      if (k.status !== 'disponivel') return m.channel.send(`❌ <@${m.author.id}> Essa key já foi resgatada ou não está disponível.`);
      const ativa = DB.ativarKey(k.key_code, m.author.id);
      if (!ativa) return m.channel.send(`❌ <@${m.author.id}> Não foi possível resgatar essa key.`);
      await m.channel.send(`✅ <@${m.author.id}> Key resgatada com sucesso! Use \`${PREFIX}script\` para receber o script.`);
      return logResgate('🎟️ Key resgatada por comando', ativa, m.author.id, m.author.id);
    }

    case 'status': {
      DB.expirarVencidas();
      let k;
      if (args[0]) {
        k = DB.buscarKey(args[0]);
        if (k && k.user_id !== m.author.id && !ehAdmin(m.author.id, m.member)) k = null;
        m.delete().catch(() => {});
      } else {
        k = DB.keysDoUsuario(m.author.id)[0] || null;
      }
      if (!k) return m.channel.send(`❌ <@${m.author.id}> Nenhuma key encontrada para você.`);
      const e = emb('🔍 Status da Key', k.status === 'ativa' ? COR.verde : COR.vermelho).addFields(
        { name: 'Key', value: `\`${k.key_code.slice(0, 9)}••••\``, inline: true },
        { name: 'Status', value: k.status, inline: true },
        { name: 'HWID vinculado', value: k.hwid ? `\`${k.hwid}\`` : 'Não vinculado', inline: false },
        { name: 'Tempo restante', value: DB.formatarRestante(k), inline: true }
      );
      return m.channel.send({ content: `<@${m.author.id}>`, embeds: [e] });
    }

    case 'script': {
      const r = await enviarScriptDM(m.author);
      return m.reply(r.ok ? '✅ Enviei o script na sua DM!' : `❌ ${r.motivo}`);
    }

    case 'ajuda': {
      const p = PREFIX;
      const e = emb('📖 Comandos — SukyWare', COR.roxo)
        .addFields(
          {
            name: '👤 Membros',
            value: [`\`${p}resgatar <key>\` — resgata uma key`, `\`${p}status [key]\` — status, HWID e tempo restante`, `\`${p}script\` — recebe o script na DM`, `\`${p}ajuda\` — esta lista`].join('\n'),
          },
          {
            name: '🛠️ Admin / Dono',
            value: [
              `\`${p}painel\` — envia o painel principal`,
              `\`${p}gerarkey <1d|7d|30d|perm> [qtd]\``,
              `\`${p}revogarkey <key>\``,
              `\`${p}addtempo <key> <dias>\``,
              `\`${p}resethwid <key>\``,
              `\`${p}criarcupom <codigo> <%> [usos]\``,
              `\`${p}deletarcupom <codigo>\``,
              `\`${p}info <key ou @usuario/ID>\``,
            ].join('\n'),
          }
        );
      return m.reply({ embeds: [e] });
    }
  }
}

// ===========================================================================
// Discord: eventos
// ===========================================================================
client.on(Events.MessageCreate, (m) => onMessage(m).catch((e) => console.error('[cmd]', e)));

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isButton()) return await onButton(i);
    if (i.isStringSelectMenu()) return await onSelect(i);
    if (i.isModalSubmit()) return await onModal(i);
  } catch (e) {
    console.error('[interaction]', e);
    const msg = { content: '❌ Ocorreu um erro interno. Tente novamente.', ...EPH };
    if (i.replied || i.deferred) i.followUp(msg).catch(() => {});
    else i.reply(msg).catch(() => {});
  }
});

client.once(Events.ClientReady, async (c) => {
  console.log(`[bot] online como ${c.user.tag}`);

  // Retoma cobranças Pix pendentes após reinício
  for (const v of DB.vendasPendentes()) {
    if (v.expira_em && Date.now() > v.expira_em) await finalizarExpirada(v.transaction_id, 'Tempo para pagamento esgotado.');
    else iniciarPolling(v.transaction_id);
  }
});

// Varredura periódica: expira keys temporárias vencidas e registra no log
setInterval(async () => {
  try {
    for (const k of DB.expirarVencidas()) await logKeyExpirada(k, 'Varredura automática');
  } catch (e) {
    console.error('[sweep]', e.message);
  }
}, 60000);

async function logKeyExpirada(k, origem, extras = []) {
  const e = emb('⌛ Key expirada', COR.vermelho).addFields(
    { name: 'Key', value: `\`${k.key_code}\``, inline: false },
    { name: 'Usuário', value: k.user_id ? `<@${k.user_id}> (${k.user_id})` : '-', inline: true },
    { name: 'HWID', value: k.hwid ? `\`${k.hwid}\`` : '-', inline: true },
    { name: 'Origem', value: origem, inline: true },
    ...extras
  );
  await enviarWebhook(config.WEBHOOK_LOGS_KEYS_USADAS, e);
}

// ===========================================================================
// API Express (validação Roblox + webhook WyviPay)
// ===========================================================================
const app = express();
app.use(express.json({ limit: '200kb' }));

// Rate limit simples por IP (60 req/min)
const hits = new Map();
setInterval(() => hits.clear(), 60000);
function limitar(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress;
  const n = (hits.get(ip) || 0) + 1;
  hits.set(ip, n);
  if (n > 60) return res.status(429).json({ valid: false, message: 'Muitas requisições' });
  next();
}

app.get('/', (req, res) => res.json({ ok: true, service: 'SukyWare API' }));

app.get('/api/verificar', limitar, async (req, res) => {
  const key = String(req.query.key || '').trim();
  const hwid = String(req.query.hwid || '').trim().slice(0, 200);
  const user = String(req.query.user || '-').slice(0, 60);
  const userid = String(req.query.userid || '-').slice(0, 30);
  const executor = String(req.query.executor || '-').slice(0, 60);

  let resultado;
  let k = null;
  let hwidSalvoAgora = false;

  try {
    if (!key || !hwid) {
      resultado = { valid: false, message: 'Key ou HWID ausentes' };
    } else {
      k = DB.buscarKey(key);
      if (!k) resultado = { valid: false, message: 'Key inválida' };
      else if (k.status === 'disponivel') resultado = { valid: false, message: 'Key ainda não foi resgatada' };
      else if (k.status === 'expirada') resultado = { valid: false, message: 'Key expirada' };
      else if (k.tipo === 'temporaria' && k.expires_at && k.expires_at <= Date.now()) {
        DB.marcarExpirada(k.key_code);
        resultado = { valid: false, message: 'Key expirada' };
        await logKeyExpirada(k, 'Detectada na verificação', [{ name: 'Executor', value: executor, inline: true }]);
      } else if (!k.hwid) {
        DB.setHwid(k.key_code, hwid);
        hwidSalvoAgora = true;
        resultado = { valid: true, message: 'HWID vinculado com sucesso' };
      } else if (k.hwid !== hwid) {
        resultado = { valid: false, message: 'HWID Incorreto' };
      } else {
        resultado = { valid: true, message: 'Key válida' };
      }
      if (resultado.valid) {
        resultado.tipo = k.tipo;
        resultado.expires_at = k.expires_at || null;
        resultado.restante = DB.formatarRestante(k);
      }
    }
  } catch (e) {
    console.error('[verificar]', e);
    resultado = { valid: false, message: 'Erro interno' };
  }

  const e = emb(resultado.valid ? '✅ Execução autorizada' : '🚫 Execução negada', resultado.valid ? COR.verde : COR.vermelho).addFields(
    { name: 'Key', value: key ? `\`${key.slice(0, 80)}\`` : '-', inline: false },
    { name: 'Resultado', value: resultado.message + (hwidSalvoAgora ? ' (HWID Lock)' : ''), inline: true },
    { name: 'Usuário Roblox', value: `${user} (${userid})`, inline: true },
    { name: 'Executor', value: executor, inline: true },
    { name: 'HWID', value: hwid ? `\`${hwid}\`` : '-', inline: false },
    { name: 'Dono da key', value: k && k.user_id ? `<@${k.user_id}>` : '-', inline: true },
    { name: 'IP', value: String(req.ip || '-'), inline: true }
  );
  enviarWebhook(config.WEBHOOK_LOGS_SCRIPT, e);

  res.json(resultado);
});

// Webhook de pagamento. Nunca confiamos no corpo: reconsultamos o status na API.
app.post('/api/webhook-wyvipay', async (req, res) => {
  try {
    if (config.WYVIPAY_WEBHOOK_SECRET) {
      const recebido = req.get('x-webhook-secret') || req.get('x-wyvipay-secret') || req.query.secret;
      if (recebido !== config.WYVIPAY_WEBHOOK_SECRET) return res.status(401).json({ ok: false });
    }
    res.json({ ok: true }); // responde rápido
    const tx = wy.extrairTransactionId(req.body);
    if (!tx) return;
    const venda = DB.getVenda(String(tx));
    if (!venda || venda.status !== 'pending') return;
    const st = await wy.consultarStatusPix(String(tx));
    if (st.status === 'paid') await processarPagamento(String(tx));
    else if (st.status === 'expired') await finalizarExpirada(String(tx), 'Cobrança expirada ou cancelada na WyviPay.');
  } catch (e) {
    console.error('[webhook-wyvipay]', e.message);
  }
});

app.listen(config.PORT || 3000, () => console.log(`[api] rodando na porta ${config.PORT || 3000}`));

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

client.login(config.TOKEN);
