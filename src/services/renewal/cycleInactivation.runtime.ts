// As duas rotinas do ciclo, já ligadas à base de dados e ao bot.
//
//   • runCycleInactivation  — dia 16, inactiva quem terminou no ciclo anterior
//   • runRenewalReactivation — diária, repõe quem renovou depois de inactivado
//
// A segunda é a rede de segurança da primeira: se a inactivação apanhar alguém
// a mais, a reconciliação da noite seguinte corrige sem ninguém ter de reparar.
// Por isso a inactivação pode correr sozinha sem ser temerária.

import mongoose from 'mongoose'
import axios from 'axios'
import logger from '../../utils/logger'
import User from '../../models/user'
import UserProduct from '../../models/UserProduct'
import UserHistory from '../../models/UserHistory'
import InactivationList from '../../models/InactivationList'
import { botHeaders, botUrl } from './discord/planning'
import {
  checkSyncFreshness,
  COHORT_ANOMALY_THRESHOLD,
  computeInactivationCohort,
  computeReactivationCohort,
  createCohortPort,
  previousCycleKey,
  swapStatusRoles,
  type CycleJobReport,
  type CycleStudent,
  type RoleSwapPort,
} from './cycleInactivation'

const botRoleSwap: RoleSwapPort = {
  apply: async (operations) => {
    await axios.post(
      `${botUrl()}/renewal/roles/apply`,
      { operations },
      { headers: botHeaders(), timeout: 120_000 },
    )
  },
}

async function marcarInactivos(
  students: readonly CycleStudent[],
  reason: string,
  now: Date,
): Promise<number> {
  let total = 0
  for (const student of students) {
    try {
      await User.findByIdAndUpdate(student.userId, {
        $set: {
          'combined.status': 'INACTIVE',
          'hotmart.status': 'INACTIVE',
          'discord.isActive': false,
          'inactivation.isManuallyInactivated': true,
          'inactivation.inactivatedAt': now,
          'inactivation.inactivatedBy': 'cron:RenewalCycleInactivation',
          'inactivation.reason': reason,
          'inactivation.platforms': ['hotmart', 'discord'],
          'metadata.updatedAt': now,
        },
      })
      await UserProduct.updateMany({ userId: student.userId }, { $set: { status: 'INACTIVE' } })
      await UserHistory.create({
        userId: student.userId,
        userEmail: student.email,
        changeType: 'INACTIVATION',
        previousValue: { status: 'ACTIVE' },
        newValue: { status: 'INACTIVE' },
        source: 'SYSTEM',
        changedBy: 'cron:RenewalCycleInactivation',
        reason,
      })
      total += 1
    } catch (error) {
      logger.error('[Inactivação] falhou num aluno', { email: student.email, error })
    }
  }
  return total
}

async function marcarActivos(
  students: readonly CycleStudent[],
  reason: string,
): Promise<number> {
  let total = 0
  for (const student of students) {
    try {
      await User.findByIdAndUpdate(student.userId, {
        $set: {
          'combined.status': 'ACTIVE',
          'hotmart.status': 'ACTIVE',
          'discord.isActive': true,
          'inactivation.isManuallyInactivated': false,
        },
      })
      await UserProduct.updateMany({ userId: student.userId }, { $set: { status: 'ACTIVE' } })
      await UserHistory.create({
        userId: student.userId,
        userEmail: student.email,
        changeType: 'STATUS_CHANGE',
        previousValue: { status: 'INACTIVE' },
        newValue: { status: 'ACTIVE' },
        source: 'SYSTEM',
        changedBy: 'cron:RenewalReactivation',
        reason,
      })
      total += 1
    } catch (error) {
      logger.error('[Reactivação] falhou num aluno', { email: student.email, error })
    }
  }
  return total
}

/** Fica no histórico do backoffice, e é por aqui que a reversão manual funciona. */
async function registarLista(
  students: readonly CycleStudent[],
  name: string,
  now: Date,
): Promise<string | null> {
  try {
    const doc = await InactivationList.create({
      name,
      status: 'COMPLETED',
      classIds: [...new Set(students.map((s) => s.className))],
      students: students.map((s) => ({
        studentId: s.userId,
        email: s.email,
        discordIds: [...s.discordIds],
        classId: s.className,
        previousState: 'ativo',
        processed: true,
      })),
      createdAt: now,
    })
    return String((doc as unknown as { _id: mongoose.Types.ObjectId })._id)
  } catch (error) {
    logger.warn('[Inactivação] não foi possível registar a lista', { error })
    return null
  }
}

/** Já corremos a inactivação neste ciclo? Evita repetir se o cron disparar duas vezes. */
async function jaCorreuNesteCiclo(cycleKey: string): Promise<boolean> {
  const existente = await InactivationList.findOne({ name: new RegExp(`ciclo ${cycleKey}`, 'i') })
    .select('_id')
    .lean()
    .exec()
  return Boolean(existente)
}

export async function runCycleInactivation(now: Date = new Date()): Promise<CycleJobReport> {
  const cycleKey = previousCycleKey(now)
  const report: CycleJobReport = {
    cycleKey,
    cohort: 0,
    applied: 0,
    discordApplied: 0,
    discordFailed: 0,
    skipped: null,
    listId: null,
  }

  if (await jaCorreuNesteCiclo(cycleKey)) {
    report.skipped = `já corrida neste ciclo (${cycleKey})`
    logger.info(`[Inactivação] ${report.skipped}`)
    return report
  }

  const port = createCohortPort()

  // Sem dados frescos não se inactiva: uma renovação de ontem que ainda não
  // chegou cá faz o aluno parecer expirado.
  const frescura = await checkSyncFreshness(port, now)
  if (!frescura.fresh) {
    report.skipped = frescura.reason ?? 'sincronização não é recente'
    logger.warn(`[Inactivação] recusada: ${report.skipped}`)
    return report
  }

  const cohort = await computeInactivationCohort(port, now)
  report.cohort = cohort.length

  if (cohort.length === 0) {
    report.skipped = `ciclo ${cycleKey} sem ninguém a inactivar`
    return report
  }

  if (cohort.length > COHORT_ANOMALY_THRESHOLD) {
    report.skipped = `${cohort.length} alunos acima do limiar de ${COHORT_ANOMALY_THRESHOLD} — provável anomalia, nada inactivado`
    logger.error(`🚨 [Inactivação] ${report.skipped}`)
    return report
  }

  const reason = `Inactivação automática do ciclo ${cycleKey}`
  report.applied = await marcarInactivos(cohort, reason, now)
  report.listId = await registarLista(cohort, `Inactivação automática — ciclo ${cycleKey}`, now)

  const discordIds = cohort.flatMap((s) => s.discordIds)
  if (discordIds.length > 0) {
    const resultado = await swapStatusRoles(discordIds, 'inactivate', botRoleSwap)
    report.discordApplied = resultado.applied
    report.discordFailed = resultado.failed
  }

  logger.info(
    `[Inactivação] ciclo ${cycleKey}: ${report.applied} alunos, `
    + `${report.discordApplied} cargos trocados${report.discordFailed ? `, ${report.discordFailed} falhas` : ''}`,
  )
  return report
}

export async function runRenewalReactivation(now: Date = new Date()): Promise<CycleJobReport> {
  const report: CycleJobReport = {
    cycleKey: previousCycleKey(now),
    cohort: 0,
    applied: 0,
    discordApplied: 0,
    discordFailed: 0,
    skipped: null,
    listId: null,
  }

  const port = createCohortPort()
  const cohort = await computeReactivationCohort(port, now)
  report.cohort = cohort.length

  if (cohort.length === 0) {
    report.skipped = 'ninguém inactivo renovou'
    return report
  }

  // Sem limiar de anomalia: repor acesso é benigno, e travar aqui deixaria
  // alunos que pagaram sem acesso à espera de uma aprovação.
  const reason = 'Renovação detectada após inactivação — acesso reposto'
  report.applied = await marcarActivos(cohort, reason)

  const discordIds = cohort.flatMap((s) => s.discordIds)
  if (discordIds.length > 0) {
    const resultado = await swapStatusRoles(discordIds, 'reactivate', botRoleSwap)
    report.discordApplied = resultado.applied
    report.discordFailed = resultado.failed
  }

  logger.info(
    `[Reactivação] ${report.applied} alunos repostos, ${report.discordApplied} cargos trocados`,
  )
  return report
}
