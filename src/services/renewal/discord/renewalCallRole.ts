// Cargo de chamada: quem é mencionado no aviso deste ciclo.
//
// As etiquetas R.{mês} são permanentes e deliberadamente largas — marcam em
// que mês do ano cada aluno renova e cobrem todas as coortes, activos
// incluídos. Mencionar uma delas chama três gerações ao mesmo tempo: quem
// terminou em Setembro de 2026, quem terminou em Setembro de 2025, e quem só
// termina em Setembro de 2027 por ter renovado.
//
// Este cargo resolve isso sem tocar nas etiquetas: é posto antes de cada aviso
// em quem é mesmo para chamar, e retirado a quem já lá não pertence. O aviso
// menciona este, e só este.
//
// O critério do ciclo usa o fim de acesso CANÓNICO — `resolveAccessEnd`, que
// cruza o nome da turma com a data de compra do UserProduct do OGI — e não o
// nome sozinho. A Hotmart nem sempre actualiza um dos dois numa renovação, e
// para 8 dos 445 alunos de Setembro as duas camadas discordam.

import mongoose from 'mongoose'
import logger from '../../../utils/logger'
import { resolveAccessEnd } from '../turmaParser'

export interface CallAudience {
  /** Chave 'YYYY-MM' do ciclo que acabou de passar. */
  readonly cycleKey: string
  /** Contas Discord a chamar. Um aluno pode ter mais do que uma. */
  readonly discordUserIds: readonly string[]
  /** Alunos distintos por trás dessas contas. */
  readonly students: number
}

interface StudentRow {
  _id: mongoose.Types.ObjectId
  email?: string
  discord?: { discordIds?: string[] }
  hotmart?: { enrolledClasses?: Array<{ className?: string; isActive?: boolean }> }
}

/** Mês anterior ao corrente, em UTC — o ciclo que o aviso anuncia. */
export function currentCycleKey(now: Date = new Date()): string {
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth() // 0-11; já é o mês anterior em base 1
  const target = month === 0 ? { y: year - 1, m: 12 } : { y: year, m: month }
  return `${target.y}-${String(target.m).padStart(2, '0')}`
}

function activeClassName(student: StudentRow): string {
  const classes = student.hotmart?.enrolledClasses || []
  const active = classes.find((c) => c.className && c.isActive !== false)
    || classes.find((c) => c.className)
  return active?.className || ''
}

export interface CallAudiencePort {
  ogiProductId(): Promise<mongoose.Types.ObjectId | null>
  studentsWithDiscord(): Promise<StudentRow[]>
  purchaseDates(
    productId: mongoose.Types.ObjectId,
    userIds: mongoose.Types.ObjectId[],
  ): Promise<Map<string, Date | null>>
}

export function createCallAudiencePort(): CallAudiencePort {
  const db = () => {
    const connection = mongoose.connection.db
    if (!connection) throw new Error('Mongo is not connected')
    return connection
  }

  return {
    ogiProductId: async () => {
      const product = await db().collection('products').findOne(
        {
          platform: 'hotmart',
          isActive: true,
          $or: [{ code: /^OGI/i }, { courseCode: /^OGI/i }, { name: /Grande Investimento/i }],
        },
        { projection: { _id: 1 } },
      )
      return (product?._id as mongoose.Types.ObjectId) ?? null
    },
    studentsWithDiscord: async () =>
      db().collection('users')
        .find({ 'discord.discordIds.0': { $exists: true } })
        .project({ email: 1, 'discord.discordIds': 1, 'hotmart.enrolledClasses': 1 })
        .toArray() as unknown as Promise<StudentRow[]>,
    purchaseDates: async (productId, userIds) => {
      const rows = await db().collection('userproducts')
        .find({ userId: { $in: userIds }, productId, platform: 'hotmart' })
        .project({ userId: 1, 'metadata.purchaseDate': 1 })
        .toArray()
      const dates = new Map<string, Date | null>()
      for (const row of rows) {
        const raw = (row as { metadata?: { purchaseDate?: Date } }).metadata?.purchaseDate
        dates.set(String(row.userId), raw ? new Date(raw) : null)
      }
      return dates
    },
  }
}

/**
 * Quem deve ser chamado neste ciclo: alunos com Discord ligado cujo acesso ao
 * OGI terminou no mês que acabou de passar.
 *
 * Não filtra por etiqueta R.{mês} de propósito. A etiqueta é derivada do nome
 * da turma e, quando as duas camadas discordam, é o fim de acesso canónico que
 * manda — filtrar também pela etiqueta deixaria de fora exactamente os casos
 * em que o nome está desactualizado.
 */
export async function computeCallAudience(
  port: CallAudiencePort,
  now: Date = new Date(),
): Promise<CallAudience> {
  const cycleKey = currentCycleKey(now)
  const productId = await port.ogiProductId()
  if (!productId) {
    logger.warn('[CargoChamada] produto OGI não encontrado — audiência vazia')
    return { cycleKey, discordUserIds: [], students: 0 }
  }

  const students = await port.studentsWithDiscord()
  const dates = await port.purchaseDates(productId, students.map((s) => s._id))

  const discordUserIds: string[] = []
  let matched = 0

  for (const student of students) {
    const accessEnd = resolveAccessEnd(dates.get(String(student._id)) ?? null, activeClassName(student))
    if (!accessEnd) continue
    if (accessEnd.toISOString().slice(0, 7) !== cycleKey) continue

    matched += 1
    for (const discordUserId of student.discord?.discordIds || []) {
      const id = String(discordUserId).trim()
      if (id) discordUserIds.push(id)
    }
  }

  return { cycleKey, discordUserIds: [...new Set(discordUserIds)], students: matched }
}

// ─────────────────────────────────────────────────────────────
// APLICAÇÃO DO CARGO
// ─────────────────────────────────────────────────────────────

export interface CallRoleSyncReport {
  cycleKey: string
  roleId: string | null
  desired: number
  added: number
  removed: number
  failed: number
  /** Falso quando o cargo não está configurado — o aviso não pode sair. */
  configured: boolean
}

export interface CallRoleApplyPort {
  apply(operations: ReadonlyArray<{
    discordUserId: string
    addRoleIds: string[]
    removeRoleIds: string[]
  }>): Promise<void>
}

const BATCH = 50

/**
 * Põe o cargo em quem é para chamar e tira-o a quem já lá não pertence.
 *
 * Idempotente: quem já o tem e continua elegível não gera operação nenhuma, por
 * isso correr duas vezes no mesmo dia não custa chamadas ao bot. O espelho só é
 * actualizado depois de a aplicação correr sem erro — se o bot falhar a meio,
 * a passagem seguinte volta a tentar o que ficou por fazer.
 */
export async function syncCallRole(
  audience: CallAudience,
  roleId: string | null,
  port: CallRoleApplyPort,
): Promise<CallRoleSyncReport> {
  const report: CallRoleSyncReport = {
    cycleKey: audience.cycleKey,
    roleId,
    desired: audience.discordUserIds.length,
    added: 0,
    removed: 0,
    failed: 0,
    configured: Boolean(roleId),
  }

  if (!roleId) {
    logger.warn('[CargoChamada] DISCORD_RENEWAL_CALL_ROLE_ID por configurar — nada aplicado')
    return report
  }

  const { DiscordCallRoleState } = await import('../../../models/discordRenewal')
  const current = await DiscordCallRoleState.find({}).lean().exec()
  const currentIds = new Set(current.map((row) => String(row.discordUserId)))
  const desiredIds = new Set(audience.discordUserIds)

  const toAdd = [...desiredIds].filter((id) => !currentIds.has(id))
  const toRemove = [...currentIds].filter((id) => !desiredIds.has(id))

  const operations = [
    ...toAdd.map((discordUserId) => ({ discordUserId, addRoleIds: [roleId], removeRoleIds: [] })),
    ...toRemove.map((discordUserId) => ({ discordUserId, addRoleIds: [], removeRoleIds: [roleId] })),
  ]

  for (let index = 0; index < operations.length; index += BATCH) {
    const batch = operations.slice(index, index + BATCH)
    try {
      await port.apply(batch)
    } catch (error) {
      report.failed += batch.length
      logger.error('[CargoChamada] lote falhou', { error })
      continue
    }

    const adicionados = batch.filter((op) => op.addRoleIds.length > 0).map((op) => op.discordUserId)
    const removidos = batch.filter((op) => op.removeRoleIds.length > 0).map((op) => op.discordUserId)

    if (adicionados.length > 0) {
      await DiscordCallRoleState.bulkWrite(adicionados.map((discordUserId) => ({
        updateOne: {
          filter: { discordUserId },
          update: { $set: { cycleKey: audience.cycleKey, appliedAt: new Date() } },
          upsert: true,
        },
      })))
      report.added += adicionados.length
    }
    if (removidos.length > 0) {
      await DiscordCallRoleState.deleteMany({ discordUserId: { $in: removidos } })
      report.removed += removidos.length
    }
  }

  logger.info(
    `[CargoChamada] ciclo ${audience.cycleKey}: ${report.desired} a chamar `
    + `(+${report.added} / -${report.removed}${report.failed ? ` / ${report.failed} falhas` : ''})`,
  )
  return report
}
