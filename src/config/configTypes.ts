export type NodeEnvironment = 'development' | 'test' | 'production'

export interface RedisConfig {
  readonly host: string
  readonly port: number
  readonly username: string
  readonly password?: string
}

export interface OperationalControlsConfig {
  readonly schedulerEnabled: boolean
  readonly clarezaRefreshEnabled: boolean
  readonly clarezaFmpEgressEnabled: boolean
}

export interface CoreConfig {
  readonly nodeEnv: NodeEnvironment
  readonly serverVersion?: string
  readonly mongoUri: string
  readonly jwtSecret: string
  readonly oldApiJwtSecret: string
  readonly studentAccessJwtSecret: string
  readonly acWebhookSecret: string
  readonly authEnforce: boolean
  readonly enableDebugRoutes: boolean
  readonly allowedOrigins: readonly string[]
  readonly port: number
}

export interface ObservabilityConfig {
  readonly logLevel: string
  readonly metricsEnabled: boolean
  readonly logDirectory: string
  readonly fileLoggingEnabled: boolean
  readonly consoleLoggingEnabled: boolean
}

export type IntegrationConfig<T> =
  | { readonly configured: false }
  | { readonly configured: true; readonly value: Readonly<T> }

export interface ActiveCampaignIntegration {
  readonly apiUrl: string
  readonly apiKey: string
  readonly webhookSecret: string
  readonly debugEnabled: boolean
  readonly verifyDeleteEnabled: boolean
  readonly lists: {
    readonly clareza?: string
    readonly ogi?: string
  }
}

export interface FmpIntegration {
  readonly apiKey: string
}

export interface RailwayIntegration {
  readonly token: string
  readonly projectId: string
}

export interface HotmartIntegration {
  readonly clientId: string
  readonly clientSecret: string
  readonly subdomain?: string
  readonly syncUserId?: string
}

export interface CurseducaIntegration {
  readonly apiUrl: string
  readonly apiKey: string
  readonly accessToken: string
}

export interface GuruIntegration {
  readonly userToken?: string
  readonly accountToken?: string
}

export interface DiscordIntegration {
  readonly botUrl: string
  readonly sharedSecret?: string
  readonly messageChannelId?: string
  readonly messageChannels: readonly string[]
}

export interface SlackIntegration {
  readonly webhookUrl: string
}

export interface StudentSummaryIntegration {
  readonly token: string
}

export interface LegacyApiIntegration {
  readonly apiUrl: string
}

export interface IntegrationConfigs {
  readonly activeCampaign: IntegrationConfig<ActiveCampaignIntegration>
  readonly fmp: IntegrationConfig<FmpIntegration>
  readonly railway: IntegrationConfig<RailwayIntegration>
  readonly hotmart: IntegrationConfig<HotmartIntegration>
  readonly curseduca: IntegrationConfig<CurseducaIntegration>
  readonly guru: IntegrationConfig<GuruIntegration>
  readonly discord: IntegrationConfig<DiscordIntegration>
  readonly slack: IntegrationConfig<SlackIntegration>
  readonly studentSummary: IntegrationConfig<StudentSummaryIntegration>
  readonly legacyApi: IntegrationConfig<LegacyApiIntegration>
}

export interface RenewalConfig {
  readonly acSyncEnabled: boolean
  readonly writeDatesEnabled: boolean
  readonly writeTagsEnabled: boolean
  readonly processRefundsEnabled: boolean
  readonly autoExecute: boolean
  readonly expiryFieldId: number
  readonly maxChangesPerRun: number
  readonly hotmartOgiProductId?: string
  readonly discordRolesSyncEnabled: boolean
  readonly discordRolesAutoExecute: boolean
  readonly discordMessagesEnabled: boolean
  readonly discordScheduledMessagesEnabled: boolean
  readonly discordRolesMaxOpsPerRun: number
  readonly discordMessageChannelId?: string
  /**
   * Cargo transitório que marca quem é chamado no aviso do ciclo corrente.
   * As etiquetas R.{mês} são permanentes e cobrem todas as coortes; este é
   * posto e retirado a cada ciclo, e é o único que o aviso menciona.
   */
  readonly discordCallRoleId?: string
  readonly discordMessageChannels: readonly string[]
}

/**
 * AppConfig retains the root properties used by existing runtime consumers.
 * Focused sections are additive and become the typed configuration boundary
 * for consumers migrated in later waves.
 */
export interface AppConfig extends CoreConfig {
  readonly core: Readonly<CoreConfig>
  readonly redis?: Readonly<RedisConfig>
  readonly observability: Readonly<ObservabilityConfig>
  readonly integrations: Readonly<IntegrationConfigs>
  readonly renewal: Readonly<RenewalConfig>
  readonly operationalControls?: Readonly<OperationalControlsConfig>
}
