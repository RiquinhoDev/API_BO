// ════════════════════════════════════════════════════════════
// 📁 src/models/discordRenewal.ts
// Modelos do sistema de cargos de renovação no Discord (R. {Mês})
// e das mensagens do bot. Ver docs/reference/renewal/RENOVACAO_DISCORD_CARGOS_PLAN.md.
//
// Mesmo padrão do RenewalAcChange (sync AC): plano persistido e
// revisável ANTES de qualquer execução; execução gated por switches.
// ════════════════════════════════════════════════════════════

import mongoose, { Document, Schema } from 'mongoose'

// ─────────────────────────────────────────────────────────────
// 1. DiscordRoleChange — 1 doc = 1 operação de cargo planeada
// ─────────────────────────────────────────────────────────────

export type DiscordRoleAction = 'SET_ROLE' // aplica o cargo alvo e remove os outros R.* num só passo
export type DiscordRoleStatus =
  | 'PLANNED'
  | 'APPROVED'
  | 'APPLIED'
  | 'FAILED'
  | 'REVERTED'
  | 'EXPIRED'
  | 'BLOCKED'

export interface IDiscordRoleChange extends Document {
  email: string
  userId?: mongoose.Types.ObjectId
  discordUserId: string

  action: DiscordRoleAction
  status: DiscordRoleStatus

  payload: {
    addRoleId: string | null // cargo R.* alvo (null = só remover)
    addRoleName?: string | null
    removeRoleIds: string[] // cargos R.* a retirar (estado anterior registado)
    removeRoleNames?: string[]
  }

  context: {
    className?: string
    accessEndMonth?: number // 1-12
    note?: string
  }

  planBatchId: string
  sourceRef: string // `${discordUserId}` — 1 change viva por conta Discord

  plannedAt: Date
  approvedAt?: Date
  approvedBy?: string
  appliedAt?: Date
  notInGuild?: boolean
  blockedReason?: string
  error?: string
  attempts: number

  createdAt: Date
  updatedAt: Date
}

const discordRoleChangeSchema = new Schema<IDiscordRoleChange>(
  {
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    discordUserId: { type: String, required: true, index: true },

    action: { type: String, enum: ['SET_ROLE'], default: 'SET_ROLE' },
    status: {
      type: String,
      enum: ['PLANNED', 'APPROVED', 'APPLIED', 'FAILED', 'REVERTED', 'EXPIRED', 'BLOCKED'],
      default: 'PLANNED',
      index: true
    },

    payload: {
      addRoleId: { type: String, default: null },
      addRoleName: { type: String, default: null },
      removeRoleIds: [{ type: String }],
      removeRoleNames: [{ type: String }]
    },

    context: {
      className: { type: String },
      accessEndMonth: { type: Number },
      note: { type: String }
    },

    planBatchId: { type: String, required: true, index: true },
    sourceRef: { type: String, required: true, index: true },

    plannedAt: { type: Date, required: true, default: Date.now },
    approvedAt: { type: Date },
    approvedBy: { type: String },
    appliedAt: { type: Date },
    notInGuild: { type: Boolean },
    blockedReason: { type: String },
    error: { type: String },
    attempts: { type: Number, default: 0 }
  },
  { timestamps: true, collection: 'discordrolechanges' }
)

discordRoleChangeSchema.index({ status: 1, plannedAt: -1 })

// ─────────────────────────────────────────────────────────────
// 2. DiscordRoleState — estado APLICADO por conta Discord
// (fonte da reconciliação; 1 cargo de renovação por conta — D3)
// ─────────────────────────────────────────────────────────────

export interface IDiscordRoleState extends Document {
  discordUserId: string
  userId?: mongoose.Types.ObjectId
  email: string
  roleId: string
  roleName: string
  appliedAt: Date
  lastChangeId?: string
}

const discordRoleStateSchema = new Schema<IDiscordRoleState>(
  {
    discordUserId: { type: String, required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    email: { type: String, lowercase: true, trim: true, index: true },
    roleId: { type: String, required: true },
    roleName: { type: String, required: true },
    appliedAt: { type: Date, required: true },
    lastChangeId: { type: String }
  },
  { timestamps: true, collection: 'discordrolestates' }
)

// ─────────────────────────────────────────────────────────────
// 2b. DiscordCallRoleState — quem tem o cargo de chamada deste ciclo
// ─────────────────────────────────────────────────────────────
// Espelho do cargo transitório que o aviso menciona. Separado do estado das
// etiquetas R.{mês} de propósito: aquelas são permanentes, esta rota-se a cada
// ciclo, e misturar as duas tornaria impossível saber a quem tirar o cargo.

export interface IDiscordCallRoleState extends Document {
  discordUserId: string
  /** Ciclo 'YYYY-MM' em que o cargo foi posto nesta conta. */
  cycleKey: string
  appliedAt: Date
}

const discordCallRoleStateSchema = new Schema<IDiscordCallRoleState>(
  {
    discordUserId: { type: String, required: true, unique: true },
    cycleKey: { type: String, required: true, index: true },
    appliedAt: { type: Date, required: true }
  },
  { timestamps: true, collection: 'discordcallrolestates' }
)

// ─────────────────────────────────────────────────────────────
// 3. DiscordMessageTemplate — textos editáveis na UI
// ─────────────────────────────────────────────────────────────

export interface IDiscordMessageTemplate extends Document {
  key: string // 'aviso-importante' | 'ultimo-dia' | outros futuros
  name: string
  content: string // com placeholders {cargos} e {dataFim}
  updatedBy?: string
  createdAt: Date
  updatedAt: Date
}

const discordMessageTemplateSchema = new Schema<IDiscordMessageTemplate>(
  {
    key: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    content: { type: String, required: true },
    updatedBy: { type: String }
  },
  { timestamps: true, collection: 'discordmessagetemplates' }
)

// ─────────────────────────────────────────────────────────────
// 4. DiscordMessageLog — registo de cada envio (auditável)
// ─────────────────────────────────────────────────────────────

export interface IDiscordMessageLog extends Document {
  channelId: string
  content: string
  mentionRoleIds: string[]
  mentionRoleNames: string[]
  templateKey?: string
  sentBy: string
  messageIds: string[]
  parts: number
  sentAt: Date
}

const discordMessageLogSchema = new Schema<IDiscordMessageLog>(
  {
    channelId: { type: String, required: true },
    content: { type: String, required: true },
    mentionRoleIds: [{ type: String }],
    mentionRoleNames: [{ type: String }],
    templateKey: { type: String },
    sentBy: { type: String, required: true },
    messageIds: [{ type: String }],
    parts: { type: Number, default: 1 },
    sentAt: { type: Date, required: true, default: Date.now }
  },
  { timestamps: true, collection: 'discordmessagelogs' }
)

// ─────────────────────────────────────────────────────────────
// 5. DiscordScheduledRule — regras de mensagens agendadas de renovação
//    (plano na secção 12 do docs/reference/renewal/RENOVACAO_DISCORD_CARGOS_PLAN.md).
//    O mês alvo NUNCA é guardado: é derivado na execução = mês anterior
//    à data de envio → cargo R.{mêsAnterior}. Uma regra dispara 12×/ano.
// ─────────────────────────────────────────────────────────────

export interface IDiscordScheduledRule extends Document {
  key: string // 'lembrete-dia-8' | 'ultimo-aviso-dia-15'
  label: string
  dayOfMonth: number // 1-28 (dia do mês em que dispara, Europe/Lisbon)
  templateKey: string // referência a DiscordMessageTemplate.key
  channelId?: string // vazio = canal default
  enabled: boolean // por regra; além do master DISCORD_SCHEDULED_MESSAGES_ENABLED
  lastSentMonth?: string // 'YYYY-MM' — idempotência: máx. 1 envio por regra/mês
  lastRunAt?: Date
  lastResult?: string // 'enviada' | razão do skip/falha (para a UI)
  createdBy: string
  createdAt: Date
  updatedAt: Date
}

const discordScheduledRuleSchema = new Schema<IDiscordScheduledRule>(
  {
    key: { type: String, required: true, unique: true },
    label: { type: String, required: true },
    dayOfMonth: { type: Number, required: true, min: 1, max: 28 },
    templateKey: { type: String, required: true },
    channelId: { type: String },
    enabled: { type: Boolean, default: false }, // ⛔ nasce desligada
    lastSentMonth: { type: String },
    lastRunAt: { type: Date },
    lastResult: { type: String },
    createdBy: { type: String, required: true }
  },
  { timestamps: true, collection: 'discordscheduledrules' }
)

// Tipos explícitos (padrão do projecto — evita o union type não-callable)
export const DiscordRoleChange: mongoose.Model<IDiscordRoleChange> = mongoose.models.DiscordRoleChange ||
  mongoose.model<IDiscordRoleChange>('DiscordRoleChange', discordRoleChangeSchema)

export const DiscordRoleState: mongoose.Model<IDiscordRoleState> = mongoose.models.DiscordRoleState ||
  mongoose.model<IDiscordRoleState>('DiscordRoleState', discordRoleStateSchema)

export const DiscordCallRoleState: mongoose.Model<IDiscordCallRoleState> = mongoose.models.DiscordCallRoleState ||
  mongoose.model<IDiscordCallRoleState>('DiscordCallRoleState', discordCallRoleStateSchema)

export const DiscordMessageTemplate: mongoose.Model<IDiscordMessageTemplate> = mongoose.models.DiscordMessageTemplate ||
  mongoose.model<IDiscordMessageTemplate>('DiscordMessageTemplate', discordMessageTemplateSchema)

export const DiscordMessageLog: mongoose.Model<IDiscordMessageLog> = mongoose.models.DiscordMessageLog ||
  mongoose.model<IDiscordMessageLog>('DiscordMessageLog', discordMessageLogSchema)

export const DiscordScheduledRule: mongoose.Model<IDiscordScheduledRule> = mongoose.models.DiscordScheduledRule ||
  mongoose.model<IDiscordScheduledRule>('DiscordScheduledRule', discordScheduledRuleSchema)
