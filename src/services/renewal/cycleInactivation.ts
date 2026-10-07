// Inactivação do ciclo e reposição de quem renovou depois.
//
// Até aqui, inactivar era escolher turmas à mão no backoffice. O nome da turma
// é a camada que envelhece pior: a Hotmart nem sempre o actualiza numa
// renovação, e nesta base há oito alunos cujo nome diz Setembro mas cuja compra
// diz Outubro. Escolher por turma inactivava-os com um mês de antecedência.
//
// Passa a escolher-se por aluno, pelo fim de acesso canónico — o mesmo
// `resolveAccessEnd` que alimenta o campo de expiração do ActiveCampaign, com o
// `max()` que nunca encurta o acesso de ninguém por um dos lados estar velho.
//
// A escolha é recalculada no momento da execução, e é isso que torna a
// verificação de "já renovou?" desnecessária como passo separado: quem renovou
// tem o fim de acesso no futuro e sai do grupo por construção.

import mongoose from 'mongoose'
import logger from '../../utils/logger'
import { resolveAccessEnd } from './turmaParser'

/** Acima disto o grupo pára e avisa, em vez de inactivar meia comunidade. */
export const COHORT_ANOMALY_THRESHOLD = 200

/**
 * Idade máxima da última sincronização com a Hotmart para a inactivação poder
 * correr. Sem dados frescos, uma renovação de ontem ainda não chegou cá e o
 * aluno parece expirado — inactivá-lo seria tirar acesso a quem pagou.
 */
export const SYNC_FRESHNESS_HOURS = 12

export interface CycleStudent {
  readonly userId: mongoose.Types.ObjectId
  readonly email: string
  readonly discordIds: readonly string[]
  readonly accessEnd: Date
  readonly className: string
}

export interface CohortPort {
  ogiProductId(): Promise<mongoose.Types.ObjectId | null>
  /** Alunos com turma, com o estado combinado pedido. */
  studentsByStatus(status: 'active' | 'inactive'): Promise<Array<{
    _id: mongoose.Types.ObjectId
    email?: string
    discord?: { discordIds?: string[] }
    hotmart?: { enrolledClasses?: Array<{ className?: string; isActive?: boolean }> }
    inactivation?: { isManuallyInactivated?: boolean }
  }>>
  purchaseDates(
    productId: mongoose.Types.ObjectId,
    userIds: mongoose.Types.ObjectId[],
  ): Promise<Map<string, Date | null>>
  /** Última execução bem sucedida de um cron, para o travão de frescura. */
  lastSuccessfulRun(jobName: string): Promise<Date | null>
}

export function createCohortPort(): CohortPort {
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
    studentsByStatus: async (status) => {
      const filter = status === 'inactive'
        ? { 'combined.status': 'INACTIVE', 'inactivation.isManuallyInactivated': true }
        : { 'combined.status': { $ne: 'INACTIVE' } }
      return db().collection('users')
        .find(filter)
        .project({
          email: 1,
          'discord.discordIds': 1,
          'hotmart.enrolledClasses': 1,
          'inactivation.isManuallyInactivated': 1,
        })
        .toArray() as never
    },
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
    lastSuccessfulRun: async (jobName) => {
      const job = await db().collection('cronjobconfigs').findOne(
        { name: jobName },
        { projection: { 'lastRun.startedAt': 1, 'lastRun.status': 1 } },
      )
      const run = (job as { lastRun?: { startedAt?: Date; status?: string } } | null)?.lastRun
      if (!run || run.status !== 'success' || !run.startedAt) return null
      return new Date(run.startedAt)
    },
  }
}

/** Mês anterior ao corrente, em UTC: o ciclo que acabou de passar. */
export function previousCycleKey(now: Date = new Date()): string {
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth()
  const target = month === 0 ? { y: year - 1, m: 12 } : { y: year, m: month }
  return `${target.y}-${String(target.m).padStart(2, '0')}`
}

function activeClassName(student: {
  hotmart?: { enrolledClasses?: Array<{ className?: string; isActive?: boolean }> }
}): string {
  const classes = student.hotmart?.enrolledClasses || []
  const active = classes.find((c) => c.className && c.isActive !== false)
    || classes.find((c) => c.className)
  return active?.className || ''
}

/**
 * Quem deve ser inactivado neste ciclo: alunos ainda activos cujo acesso ao OGI
 * terminou no mês que acabou de passar.
 */
export async function computeInactivationCohort(
  port: CohortPort,
  now: Date = new Date(),
): Promise<readonly CycleStudent[]> {
  const cycleKey = previousCycleKey(now)
  const productId = await port.ogiProductId()
  if (!productId) {
    logger.warn('[Inactivação] produto OGI não encontrado — grupo vazio')
    return []
  }

  const students = await port.studentsByStatus('active')
  const dates = await port.purchaseDates(productId, students.map((s) => s._id))
  const cohort: CycleStudent[] = []

  for (const student of students) {
    const className = activeClassName(student)
    if (!className) continue
    const accessEnd = resolveAccessEnd(dates.get(String(student._id)) ?? null, className)
    if (!accessEnd || accessEnd.toISOString().slice(0, 7) !== cycleKey) continue

    cohort.push({
      userId: student._id,
      email: (student.email || '').toLowerCase(),
      discordIds: (student.discord?.discordIds || []).map(String).filter(Boolean),
      accessEnd,
      className,
    })
  }

  return cohort
}

/**
 * Quem foi inactivado por nós e entretanto renovou: o acesso voltou a estar no
 * futuro. É a leitura inversa da mesma regra, e por isso não pode divergir dela.
 */
export async function computeReactivationCohort(
  port: CohortPort,
  now: Date = new Date(),
): Promise<readonly CycleStudent[]> {
  const productId = await port.ogiProductId()
  if (!productId) return []

  const students = await port.studentsByStatus('inactive')
  const dates = await port.purchaseDates(productId, students.map((s) => s._id))
  const cohort: CycleStudent[] = []

  for (const student of students) {
    const className = activeClassName(student)
    if (!className) continue
    const accessEnd = resolveAccessEnd(dates.get(String(student._id)) ?? null, className)
    if (!accessEnd || accessEnd.getTime() <= now.getTime()) continue

    cohort.push({
      userId: student._id,
      email: (student.email || '').toLowerCase(),
      discordIds: (student.discord?.discordIds || []).map(String).filter(Boolean),
      accessEnd,
      className,
    })
  }

  return cohort
}

export interface FreshnessVerdict {
  readonly fresh: boolean
  readonly lastRun: Date | null
  readonly reason?: string
}

/** O sync da Hotmart correu com sucesso há pouco? Se não, não se inactiva. */
export async function checkSyncFreshness(
  port: CohortPort,
  now: Date = new Date(),
  jobName = 'HotmartSync',
): Promise<FreshnessVerdict> {
  const lastRun = await port.lastSuccessfulRun(jobName)
  if (!lastRun) {
    return { fresh: false, lastRun: null, reason: `${jobName} sem execução bem sucedida registada` }
  }

  const hours = (now.getTime() - lastRun.getTime()) / 3_600_000
  if (hours > SYNC_FRESHNESS_HOURS) {
    return {
      fresh: false,
      lastRun,
      reason: `${jobName} corrido há ${hours.toFixed(1)}h (máximo ${SYNC_FRESHNESS_HOURS}h) — dados podem não ter as renovações recentes`,
    }
  }

  return { fresh: true, lastRun }
}

// ─────────────────────────────────────────────────────────────
// EXECUÇÃO
// ─────────────────────────────────────────────────────────────

/** Cargos de estado na comunidade. IDs verificados no código da API antiga. */
export const DISCORD_ROLE_ATIVO = '1198928474035994624'
export const DISCORD_ROLE_INATIVO = '1198928651161452544'

export interface RoleSwapPort {
  apply(operations: ReadonlyArray<{
    discordUserId: string
    addRoleIds: string[]
    removeRoleIds: string[]
  }>): Promise<void>
}

/** O bot recusa acima de 25 por chamada. */
const BOT_BATCH = 25

/**
 * Troca os cargos de estado no Discord. A troca é feita numa só operação por
 * conta — adicionar e remover juntos — para o membro nunca ficar um instante
 * sem nenhum dos dois.
 */
export async function swapStatusRoles(
  discordIds: readonly string[],
  direction: 'inactivate' | 'reactivate',
  port: RoleSwapPort,
): Promise<{ applied: number; failed: number }> {
  const add = direction === 'inactivate' ? DISCORD_ROLE_INATIVO : DISCORD_ROLE_ATIVO
  const remove = direction === 'inactivate' ? DISCORD_ROLE_ATIVO : DISCORD_ROLE_INATIVO

  const operations = [...new Set(discordIds)].map((discordUserId) => ({
    discordUserId,
    addRoleIds: [add],
    removeRoleIds: [remove],
  }))

  let applied = 0
  let failed = 0
  for (let index = 0; index < operations.length; index += BOT_BATCH) {
    const batch = operations.slice(index, index + BOT_BATCH)
    try {
      await port.apply(batch)
      applied += batch.length
    } catch (error) {
      failed += batch.length
      logger.error('[Inactivação] lote de cargos falhou', { error })
    }
  }
  return { applied, failed }
}

export interface CycleJobReport {
  cycleKey: string
  cohort: number
  applied: number
  discordApplied: number
  discordFailed: number
  skipped: string | null
  listId: string | null
}

export interface InactivationWritePort {
  inactivateStudents(students: readonly CycleStudent[], reason: string, now: Date): Promise<number>
  reactivateStudents(students: readonly CycleStudent[], reason: string, now: Date): Promise<number>
  recordList(students: readonly CycleStudent[], name: string, now: Date): Promise<string | null>
  alreadyRanThisCycle(cycleKey: string): Promise<boolean>
}
