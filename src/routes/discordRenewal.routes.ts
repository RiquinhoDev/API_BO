// ════════════════════════════════════════════════════════════
// 📁 src/routes/discordRenewal.routes.ts
// Gestão dos cargos de renovação Discord + mensagens do bot.
// Ver docs/reference/renewal/RENOVACAO_DISCORD_CARGOS_PLAN.md.
//
// Endpoints manuais do Backoffice. A execução contra o Discord exige
// os switches DISCORD_* ligados (verificados em runtime no serviço).
// ════════════════════════════════════════════════════════════

import { asyncRoute } from '../security/asyncRoute'
import { successResponse } from '../contracts/responseContract'
import { Router, type Request, type Response } from 'express'
import { DiscordMessageLog, DiscordMessageTemplate, DiscordRoleChange } from '../models/discordRenewal'
import CronJobConfig from '../models/SyncModels/CronJobConfig'
import {
  discordRenewalExecuteInput,
  discordRenewalMessageSendInput,
  discordRenewalScheduledRunInput,
  discordRenewalScheduledTestInput,
} from '../security/discordRenewalDestructiveInput'
import { withValidatedInput } from '../security/validatedInput'
import {
  approveRoleChanges,
  ensureDefaultTemplates,
  executeDiscordRolesPlan,
  generateDiscordRolesPlan,
  getDiscordRenewalStatus,
  renderMessage,
  sendDiscordMessage
} from '../services/renewal/discordRolesSync.service'

const router = Router()

function actor(req: Pick<Request, 'user'>, validatedActor?: string): string {
  return req.user?.email || validatedActor || 'backoffice'
}

/** GET /api/discord-renewal/status */
router.get('/status', asyncRoute(async (_req: Request, res: Response) => {
  const status = await getDiscordRenewalStatus()
  const cronJob = await CronJobConfig.findOne({ name: 'DiscordRolesSync' })
    .select('schedule.enabled schedule.cronExpression isActive lastRun nextRun')
    .lean()
    .exec()
  res.json({ success: true, data: { ...status, cronJob: cronJob || null } })
}))

/** GET /api/discord-renewal/changes?status=&batchId=&search=&limit=&skip=
 *  search: parcial e case-insensitive sobre email OU discordUserId.
 *  Devolve total (contagem completa do filtro) para paginação. */
router.get('/changes', asyncRoute(async (req: Request, res: Response) => {
  const { status, batchId, search } = req.query
  const limit = Math.min(Number(req.query.limit) || 50, 500)
  const skip = Math.max(Number(req.query.skip) || 0, 0)

  const query: Record<string, unknown> = {}
  if (status) query.status = status
  if (batchId) query.planBatchId = batchId
  if (search && String(search).trim()) {
    const escaped = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    query.$or = [
      { email: { $regex: escaped, $options: 'i' } },
      { discordUserId: { $regex: escaped } }
    ]
  }

  const [total, changes] = await Promise.all([
    DiscordRoleChange.countDocuments(query),
    DiscordRoleChange.find(query).sort({ plannedAt: -1 }).skip(skip).limit(limit).lean().exec()
  ])

  res.json({ success: true, data: { total, skip, limit, changes } })
}))

/** POST /api/discord-renewal/plan — reconciliação (dry-run, só BD) */
router.post('/plan', asyncRoute(async (_req: Request, res: Response) => {
  const report = await generateDiscordRolesPlan()
  const outcome = report.anomalyAborted ? 'anomaly-aborted' : 'planned'
  res.json(successResponse({ outcome, report }))
}))

/** POST /api/discord-renewal/approve  { ids: string[] } */
router.post('/approve', asyncRoute(async (req: Request, res: Response) => {
  const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : []
  if (ids.length === 0) {
    res.status(400).json({ success: false, message: 'ids obrigatório (array)' })
    return
  }
  const approved = await approveRoleChanges(
    ids,
    actor(req, typeof req.body?.actor === 'string' ? req.body.actor : undefined)
  )
  res.json({ success: true, data: { approved } })
}))

/** POST /api/discord-renewal/execute  { batchId?, includePlanned?, limit? } — limit é clampado ao cap do env */
router.post('/execute', withValidatedInput(discordRenewalExecuteInput, async (input, req, res) => {
  const report = await executeDiscordRolesPlan({
    includePlanned: input.body.includePlanned === true,
    batchId: input.body.batchId,
    limit: input.body.limit,
    executedBy: actor(req, input.body.actor)
  })
  res.json(successResponse({ report }))
}))

// ─────────────────────────────────────────────────────────────
// MENSAGENS
// ─────────────────────────────────────────────────────────────

/** GET /api/discord-renewal/templates (semeia os defaults na 1ª chamada) */
router.get('/templates', asyncRoute(async (_req: Request, res: Response) => {
  await ensureDefaultTemplates()
  const templates = await DiscordMessageTemplate.find({}).sort({ key: 1 }).lean().exec()
  res.json({ success: true, data: { templates } })
}))

/** PUT /api/discord-renewal/templates/:key  { name?, content } */
router.put('/templates/:key', asyncRoute(async (req: Request, res: Response) => {
  const { content, name } = req.body || {}
  if (!content || !String(content).trim()) {
    res.status(400).json({ success: false, message: 'content obrigatório' })
    return
  }
  const updated = await DiscordMessageTemplate.findOneAndUpdate(
    { key: String(req.params.key) },
    {
      $set: {
        content,
        ...(name ? { name } : {}),
        updatedBy: actor(
          req,
          typeof req.body?.actor === 'string' ? req.body.actor : undefined
        ),
      },
    },
    { new: true }
  ).lean().exec()
  if (!updated) {
    res.status(404).json({ success: false, message: 'template não encontrado' })
    return
  }
  res.json({ success: true, data: { template: updated } })
}))

/** POST /api/discord-renewal/messages/preview  { content, mentionRoleIds, dataFim?, mentionEveryone? } */
router.post('/messages/preview', asyncRoute(async (req: Request, res: Response) => {
  const { content, dataFim } = req.body || {}
  const mentionRoleIds: string[] = Array.isArray(req.body?.mentionRoleIds) ? req.body.mentionRoleIds : []
  const rendered = renderMessage(String(content || ''), mentionRoleIds, dataFim, req.body?.mentionEveryone === true)
  res.json({ success: true, data: { rendered, length: rendered.length, parts: Math.max(1, Math.ceil(rendered.length / 1990)) } })
}))

/** POST /api/discord-renewal/messages/send  { content, mentionRoleIds, dataFim?, channelId?, templateKey?, mentionEveryone? } */
router.post('/messages/send', withValidatedInput(discordRenewalMessageSendInput, async (input, req, res) => {
  const result = await sendDiscordMessage({
    content: input.body.content,
    mentionRoleIds: input.body.mentionRoleIds,
    dataFim: input.body.dataFim,
    channelId: input.body.channelId,
    templateKey: input.body.templateKey,
    mentionEveryone: input.body.mentionEveryone === true,
    sentBy: actor(req, input.body.actor)
  })
  if (!result.success) {
    res.status(400).json(result)
    return
  }
  res.status(200).json(successResponse({ messageIds: result.messageIds }, { message: result.message }))
}))

/** GET /api/discord-renewal/messages/logs?limit= */
router.get('/messages/logs', asyncRoute(async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100)
  const logs = await DiscordMessageLog.find({}).sort({ sentAt: -1 }).limit(limit).lean().exec()
  res.json({ success: true, data: { logs } })
}))

// ─────────────────────────────────────────────────────────────
// MENSAGENS AGENDADAS (secção 12 do plano Discord)
// ─────────────────────────────────────────────────────────────

/** GET /api/discord-renewal/scheduled — regras + alvo corrente + switch */
router.get('/scheduled', asyncRoute(async (_req: Request, res: Response) => {
  const { getScheduledStatus } = await import('../services/renewal/discordScheduledMessages.service')
  const cronJob = await CronJobConfig.findOne({ name: 'DiscordScheduledMessages' })
    .select('schedule.enabled schedule.cronExpression isActive lastRun nextRun')
    .lean()
    .exec()
  const status = await getScheduledStatus()
  res.json({ success: true, data: { ...status, cronJob: cronJob || null } })
}))

/** PATCH /api/discord-renewal/scheduled/:key  { enabled } — liga/desliga uma regra */
router.patch('/scheduled/:key', asyncRoute(async (req: Request, res: Response) => {
  const { setScheduledRuleEnabled } = await import('../services/renewal/discordScheduledMessages.service')
  const rule = await setScheduledRuleEnabled(String(req.params.key), req.body?.enabled === true)
  if (!rule) return res.status(404).json({ success: false, message: 'Regra não encontrada' })
  res.json({ success: true, data: { rule } })
}))

/** GET /api/discord-renewal/scheduled/:key/preview — texto como sairia hoje (não envia) */
router.get('/scheduled/:key/preview', asyncRoute(async (req: Request, res: Response) => {
  const { previewScheduledRule } = await import('../services/renewal/discordScheduledMessages.service')
  const result = await previewScheduledRule(String(req.params.key))
  if (!result.success) return res.status(404).json(result)
  res.json(successResponse({ preview: result.preview, target: result.target }))
}))

/** POST /api/discord-renewal/scheduled/:key/test — envia SEM menções (ninguém notificado) */
router.post('/scheduled/:key/test', withValidatedInput(discordRenewalScheduledTestInput, async (input, req, res) => {
  const { testScheduledRule } = await import('../services/renewal/discordScheduledMessages.service')
  const result = await testScheduledRule(input.params.key, actor(req, input.body.actor))
  if (!result.success) return res.status(400).json(result)
  res.json(successResponse({ result }))
}))

/** POST /api/discord-renewal/scheduled/run — corre o job já (respeita switches/idempotência) */
router.post('/scheduled/run', withValidatedInput(discordRenewalScheduledRunInput, async (_input, _req, res) => {
  const { runScheduledMessagesJob } = await import('../services/renewal/discordScheduledMessages.service')
  const report = await runScheduledMessagesJob()
  res.json({ success: true, data: report })
}))

/** POST /api/discord-renewal/scheduled/:key/send-now — "enviar agora" uma regra,
 *  ignorando só o gate do dia-do-mês (para quando o cron não correu no dia).
 *  Mantém switches, idempotência mensal, guard de mês vazio e menção ao cargo. */
router.post('/scheduled/:key/send-now', asyncRoute(async (req: Request, res: Response) => {
  const { sendScheduledRuleNow } = await import('../services/renewal/discordScheduledMessages.service')
  const result = await sendScheduledRuleNow(String(req.params.key), actor(req))
  res.status(result.success ? 200 : 400).json(result)
}))

export default router
