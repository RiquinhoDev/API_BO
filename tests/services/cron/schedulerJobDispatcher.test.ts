import {
  CronDispatchDependencies,
  CronDispatchJob,
  CronJobDispatcher,
  UniversalSyncRequest
} from '../../../src/services/cron/scheduler/jobDispatcher'

const emptyStats = { total: 0, inserted: 0, updated: 0, errors: 0, skipped: 0 }

const job = (name: string, syncType: CronDispatchJob['syncType'] = 'hotmart'): CronDispatchJob => ({
  _id: { toString: () => 'job-id' },
  name,
  syncType
})

const createDependencies = (): jest.Mocked<CronDispatchDependencies> => ({
  evaluateRules: jest.fn(async () => ({ success: true, total: 4, tagsApplied: 2 })),
  resetCounters: jest.fn(async () => ({ success: true, usersUpdated: 3 })),
  rebuildDashboardStats: jest.fn(async () => ({ success: true, totalStudents: 5 })),
  cleanupExecutions: jest.fn(async () => ({ success: true, deleted: 6 })),
  weeklyTagSnapshot: jest.fn(async () => ({ success: true, total: 7 })),
  clarezaRefresh: jest.fn(async () => ({ success: true, updated: 8 })),
  guruTrialCheck: jest.fn(async () => ({ success: true, skipped: 9 })),
  syncRenewalOffers: jest.fn(async () => ({ upserted: 2, deactivated: 1, unknownNames: ['x'] })),
  runScheduledMessages: jest.fn(async () => ({ checked: 5, sent: 2, skipped: [{ rule: 'r', reason: 'x' }] })),
  runDiscordRolesSync: jest.fn(async () => ({
    plan: { anomalyAborted: false, accountsDesired: 5, planned: 3, skippedDuplicates: 1 },
    execution: { applied: 2, failed: 1, notInGuild: 1 }
  })),
  runRenewalAcSync: jest.fn(async () => ({
    plan: { anomalyAborted: false, classChangesSeen: 5, planned: 3, blocked: 1, skippedDuplicates: 1 },
    execution: { applied: 2, failed: 1 }
  })),
  runAcTagWatch: jest.fn(async () => ({
    alunosLidos: 5,
    eventosGravados: 3,
    jaExistiam: 2,
    errors: [{ contexto: 'x', error: 'boom' }]
  })),
  runCycleInactivation: jest.fn(async () => ({
    cycleKey: '2026-09', cohort: 3, applied: 3, discordApplied: 3, discordFailed: 0,
    skipped: null, listId: 'abc'
  })),
  runRenewalReactivation: jest.fn(async () => ({
    cycleKey: '2026-09', cohort: 1, applied: 1, discordApplied: 1, discordFailed: 0,
    skipped: null, listId: null
  })),
  isRenewalPipelineEnabled: jest.fn(async () => false),
  runRenewalPipeline: jest.fn(async () => ({ ok: true })),
  refreshHotmartOgiProgress: jest.fn(async () => ({ total: 12, updated: 9, skipped: 2, errors: 1 })),
  evaluateAchievements: jest.fn(async () => ({ total: 5, evaluated: 4, errors: 1 })),
  executeDailyPipeline: jest.fn(async () => ({
    success: true,
    summary: { totalUsers: 3, totalUserProducts: 4, engagementUpdated: 2 },
    errors: []
  })),
  fetchHotmart: jest.fn(async () => []),
  fetchCurseduca: jest.fn(async () => []),
  executeUniversalSync: jest.fn<Promise<unknown>, [UniversalSyncRequest]>(async () => ({
    success: true,
    stats: { ...emptyStats, total: 10 }
  }))
})

describe('CronJobDispatcher', () => {
  it.each([
    ['EvaluateRules', 'evaluateRules'],
    ['ResetCounters', 'resetCounters'],
    ['RebuildDashboardStats', 'rebuildDashboardStats'],
    ['CronExecutionCleanup', 'cleanupExecutions'],
    ['WeeklyTagSnapshot', 'weeklyTagSnapshot'],
    ['ClarezaDailyRefresh', 'clarezaRefresh'],
    ['GuruTrialCheck', 'guruTrialCheck'],
    ['HotmartOgiProgressRefresh', 'refreshHotmartOgiProgress']
  ] as const)('dispatches %s to its dedicated runner', async (name, dependency) => {
    const dependencies = createDependencies()
    const dispatcher = new CronJobDispatcher(dependencies)

    await dispatcher.execute(job(`Nightly${name}`))

    expect(dependencies[dependency]).toHaveBeenCalledTimes(1)
  })

  it('normalizes renewal offers', async () => {
    const dispatcher = new CronJobDispatcher(createDependencies())

    await expect(dispatcher.execute(job('RenewalOfferSync'))).resolves.toEqual({
      success: true,
      stats: { total: 3, inserted: 0, updated: 2, errors: 0, skipped: 1 },
      errorMessage: undefined
    })
  })

  it('dispatches scheduled Discord messages instead of the synthetic Discord sync', async () => {
    const dependencies = createDependencies()
    const dispatcher = new CronJobDispatcher(dependencies)

    const result = await dispatcher.execute(job('DiscordScheduledMessages', 'discord'))

    expect(dependencies.runScheduledMessages).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      success: true,
      stats: { total: 5, inserted: 2, updated: 0, errors: 0, skipped: 1 },
      errorMessage: 'r: x'
    })
  })

  it('normalizes Discord roles, renewal AC and achievements', async () => {
    const dependencies = createDependencies()
    const dispatcher = new CronJobDispatcher(dependencies)

    await expect(dispatcher.execute(job('DiscordRolesSync'))).resolves.toMatchObject({
      success: true,
      stats: { total: 5, inserted: 3, updated: 2, errors: 1, skipped: 2 }
    })
    await expect(dispatcher.execute(job('RenewalAcSync'))).resolves.toMatchObject({
      success: true,
      stats: { total: 5, inserted: 3, updated: 2, errors: 1, skipped: 2 }
    })
    await expect(dispatcher.execute(job('AchievementEvaluation'))).resolves.toMatchObject({
      success: false,
      stats: { total: 5, inserted: 0, updated: 4, errors: 1, skipped: 1 }
    })
    await expect(dispatcher.execute(job('AcTagWatch'))).resolves.toMatchObject({
      success: false,
      stats: { total: 5, inserted: 3, updated: 0, errors: 1, skipped: 2 },
      errorMessage: 'x: boom'
    })
  })

  it('normalizes the Hotmart OGI progress refresh report', async () => {
    const dispatcher = new CronJobDispatcher(createDependencies())

    await expect(dispatcher.execute(job('HotmartOgiProgressRefresh'))).resolves.toEqual({
      success: false,
      stats: { total: 12, inserted: 0, updated: 9, errors: 1, skipped: 2 },
      errorMessage: undefined
    })
  })

  it.each([
    ['hotmart', 'fetchHotmart'],
    ['curseduca', 'fetchCurseduca']
  ] as const)('uses the %s adapter and exact Universal Sync envelope', async (syncType, fetchDependency) => {
    const dependencies = createDependencies()
    const dispatcher = new CronJobDispatcher(dependencies)

    await dispatcher.execute(job('StandardSync', syncType))

    expect(dependencies[fetchDependency]).toHaveBeenCalledTimes(1)
    expect(dependencies.executeUniversalSync).toHaveBeenCalledWith({
      syncType,
      jobName: 'StandardSync',
      jobId: 'job-id',
      triggeredBy: 'CRON',
      fullSync: true,
      includeProgress: true,
      includeTags: false,
      batchSize: 50,
      sourceData: []
    } satisfies UniversalSyncRequest)
  })

  it('preserves the synthetic Discord fallback', async () => {
    const dispatcher = new CronJobDispatcher(createDependencies())

    await expect(dispatcher.execute(job('StandardDiscord', 'discord'))).resolves.toEqual({
      success: true,
      stats: { total: 200, inserted: 20, updated: 180, errors: 0, skipped: 0 }
    })
  })

  it('aggregates fulfilled all-sync results and ignores rejected stats', async () => {
    const dependencies = createDependencies()
    dependencies.executeUniversalSync
      .mockResolvedValueOnce({ success: true, stats: { total: 3, inserted: 1, updated: 2, errors: 0, skipped: 0 } })
      .mockRejectedValueOnce(new Error('curseduca failed'))
    const dispatcher = new CronJobDispatcher(dependencies)

    await expect(dispatcher.execute(job('AllSync', 'all'))).resolves.toEqual({
      success: false,
      stats: { total: 203, inserted: 21, updated: 182, errors: 0, skipped: 0 }
    })
  })

  it('normalizes the daily pipeline result', async () => {
    const dispatcher = new CronJobDispatcher(createDependencies())

    await expect(dispatcher.execute(job('Daily', 'pipeline'))).resolves.toEqual({
      success: true,
      stats: { total: 7, inserted: 0, updated: 2, errors: 0, skipped: 0 },
      errorMessage: undefined
    })
  })

  it('fails closed for an unsupported sync type', async () => {
    const dispatcher = new CronJobDispatcher(createDependencies())

    await expect(dispatcher.execute(job('Unknown', 'guru'))).rejects.toThrow('Tipo de sync desconhecido: guru')
  })

  it('normalizes non-Error runner rejections', async () => {
    const dependencies = createDependencies()
    dependencies.evaluateRules.mockRejectedValue('broken')
    const dispatcher = new CronJobDispatcher(dependencies)

    await expect(dispatcher.execute(job('EvaluateRules'))).resolves.toEqual({
      success: false,
      stats: { ...emptyStats, errors: 1 },
      errorMessage: 'broken'
    })
  })
})
