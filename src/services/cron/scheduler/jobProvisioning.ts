import mongoose from 'mongoose'
import { SyncType } from '../../../models/SyncModels/CronJobConfig'

const SYSTEM_CRON_ADMIN_ID = new mongoose.Types.ObjectId('000000000000000000000001')

export interface CronProvisioningJob {
  name: string
  schedule: { cronExpression: string }
  nextRun?: Date
  save(): Promise<unknown>
}

export interface CronJobSeed {
  name: string
  description: string
  syncType: SyncType
  schedule: { cronExpression: string; timezone: string; enabled: boolean }
  syncConfig: { fullSync: boolean; includeProgress: boolean; includeTags: boolean; batchSize: number }
  tagRules: mongoose.Types.ObjectId[]
  tagRuleOptions: { enabled: boolean; executeAllRules: boolean; runInParallel: boolean; stopOnError: boolean }
  notifications: { enabled: boolean; emailOnSuccess: boolean; emailOnFailure: boolean; recipients: string[] }
  retryPolicy: { maxRetries: number; retryDelayMinutes: number; exponentialBackoff: boolean }
  nextRun: Date
  createdBy: mongoose.Types.ObjectId
  isActive: boolean
  totalRuns: number
  successfulRuns: number
  failedRuns: number
}

export interface CronProvisioningRepository {
  findByName(name: string): Promise<CronProvisioningJob | null>
  create(seed: CronJobSeed): Promise<unknown>
}

interface SystemJobDefinition {
  name: string
  description: string
  cronExpression: string
  enabled: boolean
  updateSchedule: boolean
  maxRetries: number
  exponentialBackoff: boolean
}

const JOBS: readonly SystemJobDefinition[] = [
  {
    name: 'RenewalOfferSync',
    description: 'Sincroniza diariamente ofertas de renovação OGI a partir da Hotmart',
    cronExpression: '0 5 * * *',
    enabled: true,
    updateSchedule: true,
    maxRetries: 2,
    exponentialBackoff: true
  },
  {
    name: 'AchievementEvaluation',
    description: 'Avalia diariamente conquistas OGI para manter o cache atualizado',
    cronExpression: '30 4 * * *',
    enabled: true,
    updateSchedule: true,
    maxRetries: 2,
    exponentialBackoff: true
  },
  {
    name: 'RenewalAcSync',
    description: 'Renovação OGI → ActiveCampaign (Fase B): gera plano de alterações (data de expiração + tags de turma + reversões por reembolso) e, só com os switches RENEWAL_AC_* ligados, executa-o. Ver docs/reference/renewal/RENOVACAO_OGI_BO_PLAN.md.',
    cronExpression: '30 7 * * *',
    enabled: false,
    updateSchedule: false,
    maxRetries: 1,
    exponentialBackoff: false
  },
  {
    name: 'DiscordRolesSync',
    description: 'Reconciliação nocturna dos cargos de renovação Discord (R. Janeiro…R. Dezembro) com base na turma Hotmart de cada aluno. Gera plano revisável; só executa com os switches DISCORD_ROLES_* ligados. Ver docs/reference/renewal/RENOVACAO_DISCORD_CARGOS_PLAN.md.',
    cronExpression: '30 5 * * *',
    enabled: false,
    updateSchedule: false,
    maxRetries: 1,
    exponentialBackoff: false
  },
  {
    name: 'DiscordScheduledMessages',
    description: 'Mensagens agendadas de renovação no Discord: dia 8 lembrete e dia 15 último aviso, mencionando o cargo R.{mês anterior}. Só envia com DISCORD_SCHEDULED_MESSAGES_ENABLED=true + regra ligada; salta meses sem renovações (cargo sem membros). Ver secção 12 do docs/reference/renewal/RENOVACAO_DISCORD_CARGOS_PLAN.md.',
    cronExpression: '0 10 * * *',
    enabled: false,
    updateSchedule: false,
    maxRetries: 1,
    exponentialBackoff: false
  },
  {
    name: 'RenewalCycleInactivation',
    description:
      'A partir do dia 16: inactiva quem terminou o acesso ao OGI no ciclo anterior. Escolhe por aluno, pelo fim de acesso canónico (nome da turma + data de compra), não por turma — o nome da turma fica desactualizado numa renovação e inactivava gente com um mês de antecedência. Recalcula no momento, por isso quem renovou entretanto sai do grupo sozinho. Corre todos os dias e pára assim que o ciclo estiver feito: se o HotmartSync não estiver recente, adia para o dia seguinte em vez de deixar o mês por inactivar. Pára acima de 200 alunos. Nasce desligado.',
    cronExpression: '0 7 * * *',
    enabled: false,
    updateSchedule: false,
    maxRetries: 1,
    exponentialBackoff: false
  },
  {
    name: 'RenewalReactivation',
    description:
      'Diária: repõe o acesso a quem foi inactivado por nós e entretanto renovou — o fim de acesso voltou a estar no futuro. Repõe estado, produtos, histórico e troca o cargo Inativo por Ativo no Discord. Sem limiar de anomalia: repor acesso a quem pagou é benigno e não deve esperar por aprovação. É a rede de segurança da inactivação do dia 16. Nasce desligado.',
    cronExpression: '30 7 * * *',
    enabled: false,
    updateSchedule: false,
    maxRetries: 1,
    exponentialBackoff: false
  },
  {
    name: 'AcTagWatch',
    description:
      'Lê as tags obrigatórias da AC e regista quem as mexeu fora do nosso sistema. NÃO escreve na ActiveCampaign — só lê e grava em actagevents. Trigger próprio, independente do RenewalPipeline/RenewalAcSync. Nasce desligado.',
    cronExpression: '0 3 * * *',
    enabled: false,
    updateSchedule: false,
    maxRetries: 1,
    exponentialBackoff: false
  },
  {
    name: 'HotmartOgiProgressRefresh',
    description:
      'Captura diariamente (06:00) a % oficial de progresso OGI do Hotmart Club, aluno a aluno (endpoint /club/api/v1/users?email=), só para inscrições ACTIVE. Grava em userProduct.progress.hotmart* sem tocar na % calculada pelo sync nocturno. Concorrência 3 + retry/backoff para respeitar o rate limit da Hotmart.',
    cronExpression: '0 6 * * *',
    enabled: true,
    updateSchedule: true,
    maxRetries: 2,
    exponentialBackoff: true
  }
]

export class CronJobProvisioner {
  constructor(
    private readonly repository: CronProvisioningRepository,
    private readonly calculateNextRun: (expression: string) => Date
  ) {}

  async ensureSystemJobs(): Promise<void> {
    for (const definition of JOBS) {
      await this.ensureJob(definition)
    }
  }

  private async ensureJob(definition: SystemJobDefinition): Promise<void> {
    const existing = await this.repository.findByName(definition.name)
    if (existing) {
      if (definition.updateSchedule && existing.schedule.cronExpression !== definition.cronExpression) {
        existing.schedule.cronExpression = definition.cronExpression
        existing.nextRun = this.calculateNextRun(definition.cronExpression)
        await existing.save()
      }
      return
    }

    await this.repository.create({
      name: definition.name,
      description: definition.description,
      syncType: 'hotmart',
      schedule: {
        cronExpression: definition.cronExpression,
        timezone: 'Europe/Lisbon',
        enabled: definition.enabled
      },
      syncConfig: { fullSync: false, includeProgress: false, includeTags: false, batchSize: 100 },
      tagRules: [],
      tagRuleOptions: { enabled: false, executeAllRules: false, runInParallel: false, stopOnError: false },
      notifications: { enabled: false, emailOnSuccess: false, emailOnFailure: true, recipients: [] },
      retryPolicy: {
        maxRetries: definition.maxRetries,
        retryDelayMinutes: 30,
        exponentialBackoff: definition.exponentialBackoff
      },
      nextRun: this.calculateNextRun(definition.cronExpression),
      createdBy: SYSTEM_CRON_ADMIN_ID,
      isActive: true,
      totalRuns: 0,
      successfulRuns: 0,
      failedRuns: 0
    })
  }
}
