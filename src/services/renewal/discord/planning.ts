// ════════════════════════════════════════════════════════════
// 📁 src/services/renewal/discordRolesSync.service.ts
// Reconciliação nocturna dos cargos de renovação no Discord (R. {Mês})
// + envio de mensagens do bot. Ver docs/reference/renewal/RENOVACAO_DISCORD_CARGOS_PLAN.md.
//
// Regra de ouro (D3): o cargo espelha SEMPRE a turma actual na Hotmart.
//   desejado  = mês do fim de acesso (parseTurmaName → accessEndOgi)
//   aplicado  = DiscordRoleState (registado pelo próprio executor)
//   diff      → DiscordRoleChange PLANNED (zero chamadas ao Discord)
//   execução  → POST ao bot (repo API), fila lenta, gated por switches
//
// Kill switches (todos default FALSE — nasce desligado):
//   DISCORD_ROLES_SYNC_ENABLED   master dos cargos: sem isto nada executa
//   DISCORD_ROLES_AUTO_EXECUTE   cron executa sem aprovação manual
//   DISCORD_MESSAGES_ENABLED     master das mensagens do bot
// ════════════════════════════════════════════════════════════

import logger from '../../../utils/logger'
import mongoose from 'mongoose'
import { getRuntimeConfig } from '../../../config/runtimeConfig'
import { IntegrationUnavailableError } from '../../../errors/integrationUnavailableError'
import {
  DiscordRoleChange,
  DiscordRoleState,
} from '../../../models/discordRenewal'
import User from '../../../models/user'
import { parseTurmaName } from '../turmaParser'

// ─────────────────────────────────────────────────────────────
// SWITCHES E CONFIG (runtime)
// ─────────────────────────────────────────────────────────────

const renewalConfig = () => getRuntimeConfig().renewal
const discordIntegration = () => getRuntimeConfig().integrations.discord

export const isRolesSyncEnabled = () => renewalConfig().discordRolesSyncEnabled
export const isRolesAutoExecuteEnabled = () => renewalConfig().discordRolesAutoExecute
export const isMessagesEnabled = () => renewalConfig().discordMessagesEnabled

export const configuredBotUrl = (): string | null => {
  const integration = discordIntegration()
  return integration.configured ? integration.value.botUrl.replace(/\/$/, '') : null
}
export const botUrl = () => {
  const url = configuredBotUrl()
  if (!url) throw new IntegrationUnavailableError('discord')
  return url
}
export const maxOpsPerRun = () => renewalConfig().discordRolesMaxOpsPerRun
export const botHeaders = () => {
  const integration = discordIntegration()
  if (!integration.configured) throw new IntegrationUnavailableError('discord')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (integration.value.sharedSecret) headers['X-Bot-Auth'] = integration.value.sharedSecret
  return headers
}

export const PLANNED_TTL_HOURS = 24
export const APPROVED_TTL_HOURS = 48
const NOT_IN_GUILD_RETRY_DAYS = 7 // não re-planear todas as noites quem saiu do servidor

// Cargos R.{Mês} — IDs verificados por leitura à API Discord (2026-07-10).
export const RENEWAL_ROLES: Record<number, { roleId: string; roleName: string }> = {
  1: { roleId: '1525119563182772385', roleName: 'R. Janeiro' },
  2: { roleId: '1525119750030495745', roleName: 'R. Fevereiro' },
  3: { roleId: '1525119843806875868', roleName: 'R. Março' },
  4: { roleId: '1525119885867352105', roleName: 'R. Abril' },
  5: { roleId: '1525119933300740156', roleName: 'R. Maio' },
  6: { roleId: '1525119979500998818', roleName: 'R. Junho' },
  7: { roleId: '1525120024681910424', roleName: 'R. Julho' },
  8: { roleId: '1525120114918166638', roleName: 'R. Agosto' },
  9: { roleId: '1525120320225149108', roleName: 'R. Setembro' },
  10: { roleId: '1525120518695682199', roleName: 'R. Outubro' },
  11: { roleId: '1525120372071202827', roleName: 'R. Novembro' },
  12: { roleId: '1525120419768696872', roleName: 'R. Dezembro' }
}

export const ALL_RENEWAL_ROLE_IDS = Object.values(RENEWAL_ROLES).map((r) => r.roleId)
export const ROLE_NAME_BY_ID = new Map(Object.values(RENEWAL_ROLES).map((r) => [r.roleId, r.roleName]))

export const getDefaultMessageChannelId = (): string | undefined =>
  renewalConfig().discordMessageChannelId

// Canais onde o BO pode publicar comunicados: "id:nome,id:nome".
// ⚠️ Ao acrescentar um canal aqui, acrescentar o ID também no env
// RENEWAL_MESSAGE_CHANNEL_IDS do serviço do bot (allowlist do lado de lá).
export function getMessageChannels(): Array<{ channelId: string; name: string }> {
  return renewalConfig().discordMessageChannels
    .map((entry) => {
      const [channelId, ...nameParts] = entry.trim().split(':')
      return { channelId: (channelId || '').trim(), name: nameParts.join(':').trim() || channelId }
    })
    .filter((c) => c.channelId)
}

// ─────────────────────────────────────────────────────────────
// EXPIRAÇÃO DE PLANOS VELHOS
// ─────────────────────────────────────────────────────────────

export async function expireStaleRoleChanges(): Promise<number> {
  const now = Date.now()
  const res = await DiscordRoleChange.updateMany(
    {
      $or: [
        { status: 'PLANNED', plannedAt: { $lt: new Date(now - PLANNED_TTL_HOURS * 3600e3) } },
        { status: 'APPROVED', plannedAt: { $lt: new Date(now - APPROVED_TTL_HOURS * 3600e3) } }
      ]
    },
    { $set: { status: 'EXPIRED' } }
  )
  return res.modifiedCount || 0
}

// ─────────────────────────────────────────────────────────────
// GERAR PLANO (reconciliação — zero chamadas ao Discord)
// ─────────────────────────────────────────────────────────────

export interface DiscordPlanReport {
  batchId: string
  isBackfill: boolean
  studentsWithClass: number
  studentsLinked: number
  accountsDesired: number
  invalidTurma: number
  planned: number
  newAssignments: number // contas sem cargo registado → primeira atribuição (nunca é anomalia)
  realChanges: number // cargos já aplicados que mudariam/seriam removidos (sujeitos ao detector)
  removals: number
  skippedDuplicates: number
  anomalyAborted: boolean
  anomalyDetail?: string
  overCap: boolean
}

export async function generateDiscordRolesPlan(): Promise<DiscordPlanReport> {
  const batchId = `discord-${new Date().toISOString().replace(/[:.]/g, '-')}`

  const report: DiscordPlanReport = {
    batchId,
    isBackfill: false,
    studentsWithClass: 0,
    studentsLinked: 0,
    accountsDesired: 0,
    invalidTurma: 0,
    planned: 0,
    newAssignments: 0,
    realChanges: 0,
    removals: 0,
    skippedDuplicates: 0,
    anomalyAborted: false,
    overCap: false
  }

  // 1. Estado desejado: alunos com turma activa + discord ligado
  const students = await (User).find({
    'hotmart.enrolledClasses.0': { $exists: true }
  })
    .select('email discord.discordIds hotmart.enrolledClasses')
    .lean()
    .exec() as Array<{
      _id: mongoose.Types.ObjectId
      email?: string
      discord?: { discordIds?: string[] }
      hotmart?: { enrolledClasses?: Array<{ className?: string; isActive?: boolean }> }
    }>

  report.studentsWithClass = students.length

  interface Desired {
    userId: mongoose.Types.ObjectId
    email: string
    className: string
    month: number
    roleId: string
    roleName: string
  }
  const desiredByAccount = new Map<string, Desired>()

  for (const s of students) {
    const discordIds = (s.discord?.discordIds || []).map(String).filter(Boolean)
    if (discordIds.length === 0) continue
    report.studentsLinked += 1

    const classes = s.hotmart?.enrolledClasses || []
    const active = classes.find((c) => c.className && c.isActive !== false) || classes.find((c) => c.className)
    const className = active?.className || ''
    const parsed = parseTurmaName(className)

    // só precisamos do período (accessEndOgi) pra saber o mês do cargo —
    // não do número de turma. "Turma Renovação | AAMM" (formato novo, sem
    // número) tem período válido na mesma, por isso NÃO usar parsed.valid
    // aqui (esse exige hasTurma, que este novo formato não tem).
    if (!parsed.hasExpiry || !parsed.accessEndOgi) {
      report.invalidTurma += 1
      continue
    }

    const month = parsed.accessEndOgi.getUTCMonth() + 1
    const role = RENEWAL_ROLES[month]
    if (!role) continue

    // D2: aplicar a TODOS os discordIds do aluno
    for (const discordUserId of discordIds) {
      desiredByAccount.set(discordUserId, {
        userId: s._id,
        email: (s.email || '').toLowerCase(),
        className,
        month,
        roleId: role.roleId,
        roleName: role.roleName
      })
    }
  }

  report.accountsDesired = desiredByAccount.size

  // 2. Estado aplicado (registado por nós)
  const states = await DiscordRoleState.find({}).lean().exec() as Array<{
    discordUserId: string
    roleId: string
  }>
  const stateByAccount = new Map(states.map((s) => [String(s.discordUserId), s.roleId]))
  report.isBackfill = states.length === 0

  // 3. Diff → changes
  interface PendingChange {
    discordUserId: string
    desired: Desired | null // null = remover qualquer cargo R.*
  }
  const pending: PendingChange[] = []

  for (const [discordUserId, desired] of desiredByAccount) {
    if (stateByAccount.get(discordUserId) === desired.roleId) continue
    pending.push({ discordUserId, desired })
  }
  // contas com estado aplicado mas que já não estão no desejado → remover (D4)
  for (const s of states) {
    if (!desiredByAccount.has(String(s.discordUserId))) {
      pending.push({ discordUserId: String(s.discordUserId), desired: null })
    }
  }

  // 4. Circuit breaker — só conta MUDANÇAS de cargos já aplicados (troca ou
  // remoção). Primeiras atribuições (conta sem estado) nunca são anomalia:
  // durante o rollout há milhares por definição, e a execução tem caps na
  // mesma. O sinal de falha da Hotmart é a massa de cargos EXISTENTES a mudar.
  report.newAssignments = pending.filter((p) => p.desired && !stateByAccount.has(p.discordUserId)).length
  report.realChanges = pending.length - report.newAssignments

  if (!report.isBackfill) {
    const threshold = Math.max(30, Math.ceil(Math.max(stateByAccount.size, 1) * 0.05))
    if (report.realChanges > threshold) {
      report.anomalyAborted = true
      report.anomalyDetail = `${report.realChanges} mudanças de cargos JÁ aplicados (> limiar ${threshold}) — provável anomalia nos dados, plano NÃO gerado (novas atribuições: ${report.newAssignments}, não contam)`
      logger.error(`🚨 [DiscordRoles] ${report.anomalyDetail}`)
      return report
    }
  }

  // 5. Persistir changes (dedupe por conta: 1 change viva por discordUserId)
  const notInGuildCutoff = new Date(Date.now() - NOT_IN_GUILD_RETRY_DAYS * 24 * 3600e3)

  for (const p of pending) {
    const addRoleId = p.desired?.roleId || null
    const living = await DiscordRoleChange.findOne({
      sourceRef: p.discordUserId,
      $or: [
        { status: { $in: ['PLANNED', 'APPROVED'] } },
        // quem saiu do servidor: não re-planear todas as noites (janela de 7 dias)
        { status: 'BLOCKED', notInGuild: true, 'payload.addRoleId': addRoleId, plannedAt: { $gte: notInGuildCutoff } }
      ]
    }).select('_id').lean().exec()

    if (living) {
      report.skippedDuplicates += 1
      continue
    }

    // remover TODOS os outros R.* (o bot só retira os que o membro tiver) —
    // auto-corrige drift de cargos postos/tirados à mão no Discord
    const removeRoleIds = ALL_RENEWAL_ROLE_IDS.filter((id) => id !== addRoleId)

    await DiscordRoleChange.create({
      email: p.desired?.email || (await emailForState(p.discordUserId)),
      userId: p.desired?.userId,
      discordUserId: p.discordUserId,
      action: 'SET_ROLE',
      status: 'PLANNED',
      payload: {
        addRoleId,
        addRoleName: addRoleId ? ROLE_NAME_BY_ID.get(addRoleId) : null,
        removeRoleIds,
        removeRoleNames: removeRoleIds.map((id) => ROLE_NAME_BY_ID.get(id) || id)
      },
      context: {
        className: p.desired?.className,
        accessEndMonth: p.desired?.month,
        note: p.desired ? undefined : 'Aluno já não elegível (sem turma activa/ligação) — remover cargo de renovação (D4)'
      },
      planBatchId: batchId,
      sourceRef: p.discordUserId,
      plannedAt: new Date()
    })

    report.planned += 1
    if (!p.desired) report.removals += 1
  }

  report.overCap = report.planned > maxOpsPerRun()
  logger.info(`📋 [DiscordRoles] Plano ${batchId}: ${report.planned} changes (${report.removals} remoções), ${report.skippedDuplicates} duplicadas, backfill=${report.isBackfill}${report.overCap ? ` — ACIMA DO CAP ${maxOpsPerRun()}` : ''}`)
  return report
}

async function emailForState(discordUserId: string): Promise<string> {
  const st = await DiscordRoleState.findOne({ discordUserId }).select('email').lean().exec() as { email?: string } | null
  return st?.email || 'desconhecido'
}

// ─────────────────────────────────────────────────────────────
// APROVAÇÃO
