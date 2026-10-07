import { buildAllowedOrigins } from '../security/cors'
import { freezeRecursively } from './runtimeConfig'
import type {
  ActiveCampaignIntegration,
  AppConfig,
  CurseducaIntegration,
  DiscordIntegration,
  FmpIntegration,
  GuruIntegration,
  HotmartIntegration,
  IntegrationConfig,
  IntegrationConfigs,
  LegacyApiIntegration,
  NodeEnvironment,
  ObservabilityConfig,
  RailwayIntegration,
  OperationalControlsConfig,
  RedisConfig,
  RenewalConfig,
  SlackIntegration,
  StudentSummaryIntegration,
} from './configTypes'

export type { AppConfig } from './configTypes'

import {
  configuredCredentialGroup,
  DEFAULT_LOG_DIRECTORY,
  hasAnyValue,
  LOG_LEVELS,
  parseBooleanFlag,
  parseBoundedInteger,
  parseOptionalUrl,
  parsePort,
  parseRequiredUrl,
  parseStrongSecret,
  readOptionalString
} from './configPrimitives'

export {
  configuredCredentialGroup,
  parseBooleanFlag,
  parseBoundedInteger,
  parseOptionalUrl,
  parsePort,
  parseRequiredUrl,
  parseStrongSecret
} from './configPrimitives'
export type { BoundedIntegerOptions } from './configPrimitives'
function parseActiveCampaign(
  env: NodeJS.ProcessEnv,
  webhookSecret: string,
): IntegrationConfig<ActiveCampaignIntegration> {
  const debugEnabled = parseBooleanFlag(env.AC_DEBUG, 'AC_DEBUG')
  const verifyDeleteEnabled = parseBooleanFlag(env.AC_DEBUG_VERIFY_DELETE, 'AC_DEBUG_VERIFY_DELETE')
  const names = ['AC_API_URL', 'AC_API_KEY', 'AC_LIST_CLAREZA', 'AC_LIST_OGI'] as const
  if (!hasAnyValue(env, names)) return { configured: false }

  const apiUrl = parseRequiredUrl(env.AC_API_URL, 'AC_API_URL')
  const apiKey = readOptionalString(env, 'AC_API_KEY')
  if (!apiKey) throw new Error('CONFIG_INVALIDA: AC_API_KEY e obrigatorio')
  const clarezaList = readOptionalString(env, 'AC_LIST_CLAREZA')
  const ogiList = readOptionalString(env, 'AC_LIST_OGI')

  return {
    configured: true,
    value: {
      apiUrl,
      apiKey,
      webhookSecret,
      debugEnabled,
      verifyDeleteEnabled,
      lists: {
        ...(clarezaList !== undefined ? { clareza: clarezaList } : {}),
        ...(ogiList !== undefined ? { ogi: ogiList } : {}),
      },
    },
  }
}

function parseFmp(env: NodeJS.ProcessEnv): IntegrationConfig<FmpIntegration> {
  const apiKey = readOptionalString(env, 'FMP_API_KEY')
  return apiKey ? { configured: true, value: { apiKey } } : { configured: false }
}

// O token do Railway e de conta/equipa: da acesso a leitura de consumo e custo
// do projecto inteiro. Fica so no backend e nunca atravessa para o Front.
//
// So o token decide se a integracao esta ligada. RAILWAY_PROJECT_ID nao serve
// de gatilho porque nao e nosso: o proprio Railway injecta-o em todos os
// servicos que la correm. Tratar a sua presenca como "alguem configurou o
// Railway" fazia a API rebentar no arranque, em producao e so em producao.
function parseRailway(env: NodeJS.ProcessEnv): IntegrationConfig<RailwayIntegration> {
  const token = readOptionalString(env, 'RAILWAY_API_TOKEN')
  if (!token) return { configured: false }

  const projectId = readOptionalString(env, 'RAILWAY_PROJECT_ID')
  if (!projectId) {
    throw new Error(
      'CONFIG_INVALIDA: RAILWAY_PROJECT_ID e obrigatorio quando RAILWAY_API_TOKEN esta definido',
    )
  }

  return { configured: true, value: { token, projectId } }
}

function parseHotmart(env: NodeJS.ProcessEnv): IntegrationConfig<HotmartIntegration> {
  const credentialNames = ['HOTMART_CLIENT_ID', 'HOTMART_CLIENT_SECRET'] as const
  const configuredNames = [
    ...credentialNames,
    'HOTMART_SUBDOMAIN',
    'COURSE_LESSON_SUBDOMAIN',
    'COURSE_LESSON_SYNC_USER_ID',
    'subdomain',
  ] as const
  if (!hasAnyValue(env, configuredNames)) return { configured: false }

  const subdomain =
    readOptionalString(env, 'COURSE_LESSON_SUBDOMAIN')
    || readOptionalString(env, 'HOTMART_SUBDOMAIN')
    || readOptionalString(env, 'subdomain')
  const syncUserId = readOptionalString(env, 'COURSE_LESSON_SYNC_USER_ID')

  const group = configuredCredentialGroup(env, credentialNames, (values) => ({
    clientId: values.HOTMART_CLIENT_ID,
    clientSecret: values.HOTMART_CLIENT_SECRET,
    ...(subdomain ? { subdomain } : {}),
    ...(syncUserId ? { syncUserId } : {}),
  }))

  if (!group.configured) {
    throw new Error(
      'CONFIG_INVALIDA: HOTMART_CLIENT_ID e HOTMART_CLIENT_SECRET sao obrigatorios',
    )
  }
  return group
}

function parseCurseduca(env: NodeJS.ProcessEnv): IntegrationConfig<CurseducaIntegration> {
  return configuredCredentialGroup(
    env,
    ['CURSEDUCA_API_URL', 'CURSEDUCA_API_KEY', 'CURSEDUCA_AccessToken'],
    (values) => ({
      apiUrl: parseRequiredUrl(values.CURSEDUCA_API_URL, 'CURSEDUCA_API_URL'),
      apiKey: values.CURSEDUCA_API_KEY,
      accessToken: values.CURSEDUCA_AccessToken,
    }),
  )
}

function parseGuru(env: NodeJS.ProcessEnv): IntegrationConfig<GuruIntegration> {
  const names = ['GURU_USER_TOKEN', 'GURU_ACCOUNT_TOKEN'] as const
  if (!hasAnyValue(env, names)) return { configured: false }

  return {
    configured: true,
    value: {
      ...(readOptionalString(env, 'GURU_USER_TOKEN')
        ? { userToken: readOptionalString(env, 'GURU_USER_TOKEN') }
        : {}),
      ...(readOptionalString(env, 'GURU_ACCOUNT_TOKEN')
        ? { accountToken: readOptionalString(env, 'GURU_ACCOUNT_TOKEN') }
        : {}),
    },
  }
}

function parseDiscord(env: NodeJS.ProcessEnv): IntegrationConfig<DiscordIntegration> {
  const names = [
    'DISCORD_BOT_URL',
    'BOT_SHARED_SECRET',
    'DISCORD_MESSAGE_CHANNEL_ID',
    'DISCORD_MESSAGE_CHANNELS',
  ] as const
  if (!hasAnyValue(env, names)) return { configured: false }

  const botUrl = parseRequiredUrl(env.DISCORD_BOT_URL, 'DISCORD_BOT_URL')
  const channelId = readOptionalString(env, 'DISCORD_MESSAGE_CHANNEL_ID')
  if (channelId && !/^\d+$/.test(channelId)) {
    throw new Error('CONFIG_INVALIDA: DISCORD_MESSAGE_CHANNEL_ID deve conter apenas digitos')
  }

  const channelsValue = readOptionalString(env, 'DISCORD_MESSAGE_CHANNELS')
  const messageChannels = channelsValue
    ? channelsValue.split(',').map((entry) => {
        const [id, ...nameParts] = entry.split(':')
        if (!/^\d+$/.test(id.trim()) || nameParts.length === 0 || !nameParts.join(':').trim()) {
          throw new Error('CONFIG_INVALIDA: DISCORD_MESSAGE_CHANNELS contem entrada invalida')
        }
        return `${id.trim()}:${nameParts.join(':').trim()}`
      })
    : []

  return {
    configured: true,
    value: {
      botUrl,
      ...(readOptionalString(env, 'BOT_SHARED_SECRET')
        ? { sharedSecret: readOptionalString(env, 'BOT_SHARED_SECRET') }
        : {}),
      ...(channelId ? { messageChannelId: channelId } : {}),
      messageChannels,
    },
  }
}

function parseSlack(env: NodeJS.ProcessEnv): IntegrationConfig<SlackIntegration> {
  const webhookUrl = parseOptionalUrl(env.SLACK_WEBHOOK_URL, 'SLACK_WEBHOOK_URL')
  return webhookUrl ? { configured: true, value: { webhookUrl } } : { configured: false }
}

function parseStudentSummary(
  env: NodeJS.ProcessEnv,
): IntegrationConfig<StudentSummaryIntegration> {
  const token = readOptionalString(env, 'STUDENT_SUMMARY_TOKEN')
  return token ? { configured: true, value: { token } } : { configured: false }
}

function parseLegacyApi(env: NodeJS.ProcessEnv): IntegrationConfig<LegacyApiIntegration> {
  const apiUrl = parseOptionalUrl(env.OLD_API_URL, 'OLD_API_URL')
  return apiUrl ? { configured: true, value: { apiUrl } } : { configured: false }
}

function parseIntegrations(
  env: NodeJS.ProcessEnv,
  webhookSecret: string,
): IntegrationConfigs {
  return {
    activeCampaign: parseActiveCampaign(env, webhookSecret),
    fmp: parseFmp(env),
    railway: parseRailway(env),
    hotmart: parseHotmart(env),
    curseduca: parseCurseduca(env),
    guru: parseGuru(env),
    discord: parseDiscord(env),
    slack: parseSlack(env),
    studentSummary: parseStudentSummary(env),
    legacyApi: parseLegacyApi(env),
  }
}

// O nome da variável vem de fora porque esta validação serve mais do que uma.
// Com o nome fixo na mensagem, um ID mal escrito no cargo de chamada fazia a
// API rebentar no arranque a queixar-se de outra variável — e quem fosse ler o
// log ia procurar ao sítio errado.
function parseDiscordSnowflake(
  value: string | undefined,
  name: string,
): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim()
  if (!normalized) throw new Error(`CONFIG_INVALIDA: ${name} e obrigatorio`)
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`CONFIG_INVALIDA: ${name} deve conter apenas digitos`)
  }
  return normalized
}

function parseMessageChannels(value: string | undefined): readonly string[] {
  if (value === undefined) return []
  const normalized = value.trim()
  if (!normalized) throw new Error('CONFIG_INVALIDA: DISCORD_MESSAGE_CHANNELS e obrigatorio')

  return normalized.split(',').map((entry) => {
    const [id, ...nameParts] = entry.split(':')
    if (!/^\d+$/.test(id.trim()) || nameParts.length === 0 || !nameParts.join(':').trim()) {
      throw new Error('CONFIG_INVALIDA: DISCORD_MESSAGE_CHANNELS contem entrada invalida')
    }
    return `${id.trim()}:${nameParts.join(':').trim()}`
  })
}

function parseRenewal(env: NodeJS.ProcessEnv, integrations: IntegrationConfigs): RenewalConfig {
  const acSyncEnabled = parseBooleanFlag(env.RENEWAL_AC_SYNC_ENABLED, 'RENEWAL_AC_SYNC_ENABLED')
  const writeDatesEnabled = parseBooleanFlag(env.RENEWAL_AC_WRITE_DATES, 'RENEWAL_AC_WRITE_DATES')
  const writeTagsEnabled = parseBooleanFlag(env.RENEWAL_AC_WRITE_TAGS, 'RENEWAL_AC_WRITE_TAGS')
  const processRefundsEnabled = parseBooleanFlag(
    env.RENEWAL_AC_PROCESS_REFUNDS,
    'RENEWAL_AC_PROCESS_REFUNDS',
  )
  const autoExecute = parseBooleanFlag(env.RENEWAL_AC_AUTO_EXECUTE, 'RENEWAL_AC_AUTO_EXECUTE')
  const expiryFieldId = parseBoundedInteger(env.RENEWAL_AC_EXPIRY_FIELD_ID, 'RENEWAL_AC_EXPIRY_FIELD_ID', {
    min: 1,
    max: 1_000_000,
    defaultValue: 332,
  })
  const maxChangesPerRun = parseBoundedInteger(
    env.RENEWAL_AC_MAX_CHANGES_PER_RUN,
    'RENEWAL_AC_MAX_CHANGES_PER_RUN',
    { min: 1, max: 10_000, defaultValue: 50 },
  )
  const hotmartOgiProductId = readOptionalString(env, 'HOTMART_OGI_PRODUCT_ID')

  const discordRolesSyncEnabled = parseBooleanFlag(
    env.DISCORD_ROLES_SYNC_ENABLED,
    'DISCORD_ROLES_SYNC_ENABLED',
  )
  const discordRolesAutoExecute = parseBooleanFlag(
    env.DISCORD_ROLES_AUTO_EXECUTE,
    'DISCORD_ROLES_AUTO_EXECUTE',
  )
  const discordMessagesEnabled = parseBooleanFlag(
    env.DISCORD_MESSAGES_ENABLED,
    'DISCORD_MESSAGES_ENABLED',
  )
  const discordScheduledMessagesEnabled = parseBooleanFlag(
    env.DISCORD_SCHEDULED_MESSAGES_ENABLED,
    'DISCORD_SCHEDULED_MESSAGES_ENABLED',
  )
  const discordRolesMaxOpsPerRun = parseBoundedInteger(
    env.DISCORD_ROLES_MAX_OPS_PER_RUN,
    'DISCORD_ROLES_MAX_OPS_PER_RUN',
    { min: 1, max: 10_000, defaultValue: 100 },
  )
  const discordMessageChannelId = parseDiscordSnowflake(
    env.DISCORD_MESSAGE_CHANNEL_ID,
    'DISCORD_MESSAGE_CHANNEL_ID',
  )
  const discordCallRoleId = parseDiscordSnowflake(
    env.DISCORD_RENEWAL_CALL_ROLE_ID,
    'DISCORD_RENEWAL_CALL_ROLE_ID',
  )
  const discordMessageChannels = parseMessageChannels(env.DISCORD_MESSAGE_CHANNELS)

  if (
    (acSyncEnabled || writeDatesEnabled || writeTagsEnabled || autoExecute) &&
    !integrations.activeCampaign.configured
  ) {
    throw new Error('CONFIG_INVALIDA: AC_API_URL e AC_API_KEY sao obrigatorios para renewal')
  }

  if (processRefundsEnabled && !integrations.hotmart.configured) {
    throw new Error(
      'CONFIG_INVALIDA: HOTMART_CLIENT_ID e HOTMART_CLIENT_SECRET sao obrigatorios para renewal',
    )
  }

  if (
    (discordRolesSyncEnabled ||
      discordRolesAutoExecute ||
      discordMessagesEnabled ||
      discordScheduledMessagesEnabled) &&
    !integrations.discord.configured
  ) {
    throw new Error('CONFIG_INVALIDA: DISCORD_BOT_URL e obrigatorio para renewal')
  }

  if (
    (discordRolesSyncEnabled || discordRolesAutoExecute || discordMessagesEnabled || discordScheduledMessagesEnabled) &&
    integrations.discord.configured &&
    !integrations.discord.value.sharedSecret
  ) {
    throw new Error('CONFIG_INVALIDA: BOT_SHARED_SECRET e obrigatorio para renewal')
  }

  return {
    acSyncEnabled,
    writeDatesEnabled,
    writeTagsEnabled,
    processRefundsEnabled,
    autoExecute,
    expiryFieldId,
    maxChangesPerRun,
    ...(hotmartOgiProductId ? { hotmartOgiProductId } : {}),
    discordRolesSyncEnabled,
    discordRolesAutoExecute,
    discordMessagesEnabled,
    discordScheduledMessagesEnabled,
    discordRolesMaxOpsPerRun,
    ...(discordMessageChannelId ? { discordMessageChannelId } : {}),
    ...(discordCallRoleId ? { discordCallRoleId } : {}),
    discordMessageChannels,
  }
}

function parseObservability(
  env: NodeJS.ProcessEnv,
  nodeEnv: NodeEnvironment,
): ObservabilityConfig {
  const logLevel = env.LOG_LEVEL === undefined ? 'info' : env.LOG_LEVEL.trim()
  if (!LOG_LEVELS.has(logLevel)) {
    throw new Error('CONFIG_INVALIDA: LOG_LEVEL deve ser um nivel Winston valido')
  }

  const metricsEnabled = parseBooleanFlag(env.LOG_METRICS, 'LOG_METRICS')
  const logDirectory =
    env.LOG_DIRECTORY === undefined ? DEFAULT_LOG_DIRECTORY : env.LOG_DIRECTORY.trim()
  if (!logDirectory) throw new Error('CONFIG_INVALIDA: LOG_DIRECTORY e obrigatorio')

  return {
    logLevel,
    metricsEnabled,
    logDirectory,
    fileLoggingEnabled: nodeEnv !== 'test',
    // Console is what Railway actually captures — file logging alone writes
    // into the container's ephemeral filesystem, invisible outside it and
    // wiped on every redeploy. Off only in test, same as file logging.
    consoleLoggingEnabled: nodeEnv !== 'test',
  }
}

function parseRedisConfig(env: NodeJS.ProcessEnv, nodeEnv: NodeEnvironment): RedisConfig | undefined {
  const host = env.REDIS_HOST?.trim()
  const hasOtherRedisConfig = ['REDIS_PORT', 'REDIS_USERNAME', 'REDIS_PASSWORD'].some(
    (name) => env[name] !== undefined,
  )

  if (!host) {
    if (nodeEnv === 'production') {
      throw new Error(
        'CONFIG_INVALIDA: REDIS_HOST e obrigatoria em producao para rate limiting distribuido',
      )
    }
    if (env.REDIS_HOST !== undefined || hasOtherRedisConfig) {
      throw new Error('CONFIG_INVÁLIDA: REDIS_HOST é obrigatória quando Redis é configurado')
    }
    return undefined
  }

  return {
    host,
    port: parsePort(env.REDIS_PORT, 6379, 'REDIS_PORT'),
    username: readOptionalString(env, 'REDIS_USERNAME') ?? 'default',
    ...(env.REDIS_PASSWORD !== undefined
      ? { password: readOptionalString(env, 'REDIS_PASSWORD') }
      : {}),
  }
}

function parseOperationalControls(env: NodeJS.ProcessEnv): OperationalControlsConfig {
  const enabledByDefault = (name: string): boolean =>
    env[name] === undefined ? true : parseBooleanFlag(env[name], name)

  return {
    schedulerEnabled: enabledByDefault('SCHEDULER_ENABLED'),
    clarezaRefreshEnabled: enabledByDefault('CLAREZA_REFRESH_ENABLED'),
    clarezaFmpEgressEnabled: enabledByDefault('CLAREZA_FMP_EGRESS_ENABLED'),
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const mongoUri = env.MONGO_URI?.trim()
  if (!mongoUri) throw new Error('CONFIG_INVÁLIDA: MONGO_URI é obrigatória')

  const jwtSecret = parseStrongSecret(env.JWT_SECRET, 'JWT_SECRET', true)
  const oldApiJwtSecret = parseStrongSecret(env.OLD_API_JWT_SECRET, 'OLD_API_JWT_SECRET', true)
  const studentAccessJwtSecret = parseStrongSecret(
    env.STUDENT_ACCESS_JWT_SECRET,
    'STUDENT_ACCESS_JWT_SECRET',
    true,
  )
  const jwtSecrets = [jwtSecret, oldApiJwtSecret, studentAccessJwtSecret]
  if (new Set(jwtSecrets).size !== jwtSecrets.length) {
    throw new Error(
      'CONFIG_INVALIDA: JWT_SECRET, OLD_API_JWT_SECRET e STUDENT_ACCESS_JWT_SECRET devem ser distintos',
    )
  }

  const acWebhookSecret = parseStrongSecret(env.AC_WEBHOOK_SECRET, 'AC_WEBHOOK_SECRET', true)
  const rawNodeEnv = env.NODE_ENV === undefined ? 'development' : env.NODE_ENV.trim()
  if (!['development', 'test', 'production'].includes(rawNodeEnv)) {
    throw new Error('CONFIG_INVÁLIDA: NODE_ENV deve ser development, test ou production')
  }
  const nodeEnv = rawNodeEnv as NodeEnvironment
  const serverVersion = env.npm_package_version?.trim() || undefined

  const authEnforce = parseBooleanFlag(env.AUTH_ENFORCE, 'AUTH_ENFORCE', true)
  const enableDebugRoutes = parseBooleanFlag(env.ENABLE_DEBUG_ROUTES, 'ENABLE_DEBUG_ROUTES')
  if (nodeEnv === 'production' && enableDebugRoutes) {
    throw new Error('CONFIG_INVÁLIDA: ENABLE_DEBUG_ROUTES é proibida em produção')
  }

  const allowedOrigins = buildAllowedOrigins(env.ALLOWED_ORIGINS, nodeEnv)
  const port = parsePort(env.PORT, 3001, 'PORT')
  const redis = parseRedisConfig(env, nodeEnv)
  const observability = parseObservability(env, nodeEnv)
  const integrations = parseIntegrations(env, acWebhookSecret)
  const renewal = parseRenewal(env, integrations)
  const operationalControls = parseOperationalControls(env)

  const core = {
    nodeEnv,
    ...(serverVersion !== undefined ? { serverVersion } : {}),
    mongoUri,
    jwtSecret,
    oldApiJwtSecret,
    studentAccessJwtSecret,
    acWebhookSecret,
    authEnforce,
    enableDebugRoutes,
    allowedOrigins,
    port,
  }

  const config: AppConfig = {
    ...core,
    core,
    ...(redis ? { redis } : {}),
    observability,
    integrations,
    renewal,
    operationalControls,
  }

  return freezeRecursively(config)
}
