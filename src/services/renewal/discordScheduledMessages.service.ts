// src/services/renewal/discordScheduledMessages.service.ts
// Mensagens agendadas de renovação — plano na secção 12 do docs/reference/renewal/RENOVACAO_DISCORD_CARGOS_PLAN.md.
//
// Cadência (confirmada pelo João 2026-07-11): a turma cujo acesso terminou no fim do mês M
// tem o cargo R.{M}; a janela de renovação são os 15 dias de M+1. Cada dia tem a SUA mensagem:
//   dia 8 de M+1  → lembrete       → menciona @R.{M}   (template 'aviso-importante')
//   dia 15 de M+1 → último aviso   → menciona @R.{M}   (template 'ultimo-dia')
// Na noite de dia 15 a inativação dos não-renovados continua a ser o processo EXISTENTE
// do BO (manual) — este automatismo só trata das mensagens.
//
// Salvaguardas:
// - Master switch DISCORD_SCHEDULED_MESSAGES_ENABLED (runtime, default false) + enabled por regra.
// - Idempotência: lastSentMonth ('YYYY-MM') garante máx. 1 envio por regra/mês (re-runs e
//   redeploys não duplicam).
// - GUARD DE MÊS VAZIO (pedida pelo João): há meses sem nenhuma turma a renovar (verificado
//   2026-07-11: Agosto e Outubro = 0 alunos). Se o cargo alvo não tem NINGUÉM com ele
//   aplicado (DiscordRoleState), a mensagem NÃO sai — evita anunciar renovações a um cargo
//   vazio no canal público.
// - Envio passa pelo sendDiscordMessage existente: allowlist dos 12 cargos R.*, allowlist de
//   canais, switch DISCORD_MESSAGES_ENABLED, e registo em DiscordMessageLog.

import logger from '../../utils/logger'
import { getRuntimeConfig } from '../../config/runtimeConfig'
import {
  DiscordMessageTemplate,
  DiscordScheduledRule,
  DiscordRoleState,
  IDiscordScheduledRule
} from '../../models/discordRenewal'
import axios from 'axios'
import {
  RENEWAL_ROLES,
  renderMessage,
  sendDiscordMessage
} from './discordRolesSync.service'
import { botHeaders, botUrl, callRoleId } from './discord/planning'
import {
  computeCallAudience,
  createCallAudiencePort,
  syncCallRole
} from './discord/renewalCallRole'

export const isScheduledMessagesEnabled = () =>
  getRuntimeConfig().renewal.discordScheduledMessagesEnabled

const LISBON_TZ = 'Europe/Lisbon'

// ─────────────────────────────────────────────────────────────
// DATAS (tudo em Europe/Lisbon — o servidor pode estar em UTC)
// ─────────────────────────────────────────────────────────────

/** { year, month (1-12), day } da data dada, no fuso de Lisboa */
export function lisbonParts(now: Date = new Date()): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: LISBON_TZ,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric'
  }).formatToParts(now)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  return { year: get('year'), month: get('month'), day: get('day') }
}

/** Mês alvo = mês ANTERIOR à data de envio (turma R.{M} recebe as mensagens em M+1) */
export function getTargetMonth(now: Date = new Date()): {
  month: number
  year: number
  roleId: string
  roleName: string
  dataFim: string // último dia do mês alvo, dd/mm/yyyy — para o placeholder {dataFim}
  monthKey: string // 'YYYY-MM' do mês CORRENTE (chave de idempotência do envio)
} {
  const { year, month } = lisbonParts(now)
  const targetMonth = month === 1 ? 12 : month - 1
  const targetYear = month === 1 ? year - 1 : year
  const role = RENEWAL_ROLES[targetMonth]
  const lastDay = new Date(targetYear, targetMonth, 0).getDate() // dia 0 do mês seguinte ao alvo
  const dataFim = `${String(lastDay).padStart(2, '0')}/${String(targetMonth).padStart(2, '0')}/${targetYear}`
  return {
    month: targetMonth,
    year: targetYear,
    roleId: role.roleId,
    roleName: role.roleName,
    dataFim,
    monthKey: `${year}-${String(month).padStart(2, '0')}`
  }
}

// ─────────────────────────────────────────────────────────────
// SEEDS (create-only — nunca reactiva regras desligadas)
// ─────────────────────────────────────────────────────────────

const DEFAULT_RULES = [
  {
    key: 'lembrete-dia-8',
    label: 'Lembrete de renovação (dia 8 — ~1 semana após o fim do acesso)',
    dayOfMonth: 8,
    templateKey: 'aviso-importante'
  },
  {
    key: 'ultimo-aviso-dia-15',
    label: 'Último aviso (dia 15 — nessa noite os não-renovados são inativados)',
    dayOfMonth: 15,
    templateKey: 'ultimo-dia'
  }
]

export async function ensureDefaultScheduledRules(): Promise<void> {
  for (const r of DEFAULT_RULES) {
    await DiscordScheduledRule.updateOne(
      { key: r.key },
      { $setOnInsert: { ...r, enabled: false, createdBy: 'seed' } },
      { upsert: true }
    )
  }
}

// ─────────────────────────────────────────────────────────────
// EXECUÇÃO (chamada pelo cron diário DiscordScheduledMessages às 10:00)
// ─────────────────────────────────────────────────────────────

export interface ScheduledMessagesReport {
  masterEnabled: boolean
  today: number
  targetRole: string
  checked: number
  sent: number
  skipped: Array<{ rule: string; reason: string }>
}

/**
 * Garante que o cargo de chamada está em quem é para chamar neste ciclo, e
 * devolve o relatório mais o número de contas. Corre antes de cada envio: é
 * idempotente, por isso o dia 8 e o dia 15 do mesmo ciclo custam uma passagem
 * sem operações se nada mudou entretanto.
 */
async function prepararChamada(now: Date) {
  const audiencia = await computeCallAudience(createCallAudiencePort(), now)
  const chamada = await syncCallRole(audiencia, callRoleId(), {
    apply: async (operations) => {
      await axios.post(
        `${botUrl()}/renewal/roles/apply`,
        { operations },
        { headers: botHeaders(), timeout: 120000 },
      )
    },
  })
  return { chamada, membros: audiencia.discordUserIds.length, audiencia }
}

export async function runScheduledMessagesJob(): Promise<ScheduledMessagesReport> {
  await ensureDefaultScheduledRules()

  const now = new Date()
  const { day } = lisbonParts(now)
  const target = getTargetMonth(now)

  const report: ScheduledMessagesReport = {
    masterEnabled: isScheduledMessagesEnabled(),
    today: day,
    targetRole: target.roleName,
    checked: 0,
    sent: 0,
    skipped: []
  }

  const rules = await DiscordScheduledRule.find({}).exec()

  for (const rule of rules) {
    if (rule.dayOfMonth !== day) continue // hoje não é o dia desta regra
    report.checked++

    const skip = async (reason: string) => {
      report.skipped.push({ rule: rule.key, reason })
      rule.lastRunAt = now
      rule.lastResult = reason
      await rule.save()
    }

    if (!rule.enabled) {
      await skip('regra desligada')
      continue
    }
    if (!report.masterEnabled) {
      await skip('DISCORD_SCHEDULED_MESSAGES_ENABLED != true — envio recusado')
      continue
    }
    if (rule.lastSentMonth === target.monthKey) {
      await skip(`já enviada este mês (${target.monthKey})`)
      continue
    }

    // O aviso menciona o cargo de chamada, não a etiqueta R.{mês}. A etiqueta é
    // permanente e cobre todas as coortes — mencioná-la chamaria quem terminou
    // há dois anos e quem já renovou, a par de quem é mesmo para chamar.
    const { chamada, membros } = await prepararChamada(now)
    if (!chamada.configured) {
      await skip('DISCORD_RENEWAL_CALL_ROLE_ID por configurar — aviso não sai sem audiência definida')
      continue
    }
    if (chamada.failed > 0) {
      await skip(`${chamada.failed} contas falharam ao receber o cargo — aviso adiado para não sair incompleto`)
      continue
    }

    // GUARD: ciclo sem ninguém a renovar → não anunciar nada
    const members = membros
    if (members === 0) {
      await skip(`ciclo ${chamada.cycleKey} sem ninguém por renovar — nada enviado`)
      continue
    }

    const template = await DiscordMessageTemplate.findOne({ key: rule.templateKey }).lean().exec()
    if (!template) {
      await skip(`template '${rule.templateKey}' não encontrado`)
      continue
    }

    const result = await sendDiscordMessage({
      content: template.content,
      mentionRoleIds: [chamada.roleId as string],
      dataFim: target.dataFim,
      channelId: rule.channelId || undefined,
      templateKey: rule.templateKey,
      sentBy: 'cron:DiscordScheduledMessages'
    })

    rule.lastRunAt = now
    if (result.success) {
      rule.lastSentMonth = target.monthKey
      rule.lastResult = `enviada a ${target.roleName} (${members} membros)`
      report.sent++
      logger.info(`📨 [ScheduledMessages] ${rule.key} → ${target.roleName} (${members} membros): OK`)
    } else {
      rule.lastResult = `FALHOU: ${result.message}`
      report.skipped.push({ rule: rule.key, reason: result.message })
      logger.error(`❌ [ScheduledMessages] ${rule.key}: ${result.message}`)
    }
    await rule.save()
  }

  logger.info(
    `📅 [ScheduledMessages] dia ${day} — ${report.checked} regra(s) para hoje, ${report.sent} enviada(s), ${report.skipped.length} skip(s)`
  )
  return report
}

// ─────────────────────────────────────────────────────────────
// UI: estado, preview e teste sem menções
// ─────────────────────────────────────────────────────────────

export async function getScheduledStatus() {
  await ensureDefaultScheduledRules()
  const rules = await DiscordScheduledRule.find({}).sort({ dayOfMonth: 1 }).lean().exec()
  const target = getTargetMonth()
  const members = await DiscordRoleState.countDocuments({ roleId: target.roleId })
  return {
    masterEnabled: isScheduledMessagesEnabled(),
    // Alvo se uma mensagem saísse hoje — a UI mostra "próximo alvo" e o nº de membros
    currentTarget: { ...target, members },
    rules
  }
}

/** Texto renderizado como sairia hoje (sem enviar nada) */
export async function previewScheduledRule(key: string): Promise<{
  success: boolean
  message?: string
  preview?: string
  target?: { roleName: string; members: number; dataFim: string }
}> {
  const rule = await DiscordScheduledRule.findOne({ key }).lean().exec()
  if (!rule) return { success: false, message: `Regra '${key}' não encontrada` }
  const template = await DiscordMessageTemplate.findOne({ key: rule.templateKey }).lean().exec()
  if (!template) return { success: false, message: `Template '${rule.templateKey}' não encontrado` }

  const target = getTargetMonth()
  const members = await DiscordRoleState.countDocuments({ roleId: target.roleId })
  const preview = renderMessage(template.content, [target.roleId], target.dataFim)
  return {
    success: true,
    preview,
    target: { roleName: target.roleName, members, dataFim: target.dataFim }
  }
}

/** Envio de teste SEM menções (ninguém é notificado) — modo seguro para validar texto/canal */
export async function testScheduledRule(key: string, sentBy: string) {
  const rule = await DiscordScheduledRule.findOne({ key }).lean().exec()
  if (!rule) return { success: false, message: `Regra '${key}' não encontrada` }
  const template = await DiscordMessageTemplate.findOne({ key: rule.templateKey }).lean().exec()
  if (!template) return { success: false, message: `Template '${rule.templateKey}' não encontrado` }

  const target = getTargetMonth()
  return sendDiscordMessage({
    content: `🧪 [TESTE — mensagem agendada '${rule.key}', sem menções]\n\n${template.content}`,
    mentionRoleIds: [], // sem menções = não notifica ninguém
    dataFim: target.dataFim,
    channelId: rule.channelId || undefined,
    templateKey: rule.templateKey,
    sentBy
  })
}

export async function setScheduledRuleEnabled(key: string, enabled: boolean): Promise<IDiscordScheduledRule | null> {
  return DiscordScheduledRule.findOneAndUpdate({ key }, { $set: { enabled } }, { new: true }).exec()
}

/**
 * "Enviar agora" — envio manual imediato de UMA regra (botão do BO para casos em que
 * o cron falhou/não correu no dia). Faz o MESMO envio real do cron (com menção ao cargo
 * R.{mês anterior}), mas IGNORA o gate do dia-do-mês. Mantém TODOS os outros guards:
 * regra ligada, master switch, idempotência mensal, guard de mês vazio e template.
 * A idempotência continua a valer: não reenvia se já saiu este mês (evita duplo @cargo).
 */
export async function sendScheduledRuleNow(
  key: string,
  sentBy: string
): Promise<{
  success: boolean
  message: string
  target?: { roleName: string; members: number; dataFim: string }
}> {
  await ensureDefaultScheduledRules()
  const rule = await DiscordScheduledRule.findOne({ key }).exec()
  if (!rule) return { success: false, message: `Regra '${key}' não encontrada` }

  const now = new Date()
  const target = getTargetMonth(now)

  if (!rule.enabled) return { success: false, message: 'Regra desligada — liga a regra primeiro' }
  if (!isScheduledMessagesEnabled()) {
    return { success: false, message: 'DISCORD_SCHEDULED_MESSAGES_ENABLED != true — envio recusado' }
  }
  if (rule.lastSentMonth === target.monthKey) {
    return { success: false, message: `Já foi enviada este mês (${target.monthKey}) — não reenvio para não duplicar` }
  }

  // Mesmo caminho do cron: o envio manual não pode mencionar a etiqueta, senão
  // o botão do BO chamava as três coortes que o cron deixou de chamar.
  const { chamada, membros: members } = await prepararChamada(now)
  if (!chamada.configured) {
    return { success: false, message: 'DISCORD_RENEWAL_CALL_ROLE_ID por configurar — aviso não sai sem audiência definida' }
  }
  if (chamada.failed > 0) {
    return { success: false, message: `${chamada.failed} contas falharam ao receber o cargo — envio recusado para não sair incompleto` }
  }
  if (members === 0) {
    return { success: false, message: `Ciclo ${chamada.cycleKey} sem ninguém por renovar — nada enviado` }
  }

  const template = await DiscordMessageTemplate.findOne({ key: rule.templateKey }).lean().exec()
  if (!template) return { success: false, message: `Template '${rule.templateKey}' não encontrado` }

  const result = await sendDiscordMessage({
    content: template.content,
    mentionRoleIds: [chamada.roleId as string],
    dataFim: target.dataFim,
    channelId: rule.channelId || undefined,
    templateKey: rule.templateKey,
    sentBy: sentBy || 'ui:enviar-agora'
  })

  rule.lastRunAt = now
  if (result.success) {
    rule.lastSentMonth = target.monthKey
    rule.lastResult = `envio manual "enviar agora" a ${target.roleName} (${members} membros)`
    console.log(`📨 [ScheduledMessages] ENVIAR-AGORA ${rule.key} → ${target.roleName} (${members} membros): OK`)
  } else {
    rule.lastResult = `FALHOU (enviar agora): ${result.message}`
    console.error(`❌ [ScheduledMessages] ENVIAR-AGORA ${rule.key}: ${result.message}`)
  }
  await rule.save()

  return {
    success: result.success,
    message: result.success
      ? `Mensagem enviada a ${target.roleName} (${members} membros)`
      : result.message,
    target: { roleName: target.roleName, members, dataFim: target.dataFim }
  }
}

export default {
  isScheduledMessagesEnabled,
  ensureDefaultScheduledRules,
  runScheduledMessagesJob,
  getScheduledStatus,
  previewScheduledRule,
  testScheduledRule,
  setScheduledRuleEnabled,
  sendScheduledRuleNow,
  getTargetMonth
}
