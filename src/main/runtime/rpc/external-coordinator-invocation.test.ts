import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ORCHESTRATION_EXTERNAL_COORDINATOR_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { OrchestrationDb } from '../orchestration/db'
import Database from '../../sqlite/sync-database'
import { createOrchestrationRpcHarness } from './methods/orchestration-rpc-test-harness'
import { createExternalCoordinatorInvocation } from './external-coordinator-invocation'

const fingerprint = 'authenticated-saved-environment-fingerprint'
const capabilities = [ORCHESTRATION_EXTERNAL_COORDINATOR_RUNTIME_CAPABILITY]

describe('external coordinator invocation', () => {
  const harness = createOrchestrationRpcHarness()

  afterEach(() => {
    harness.cleanup()
  })

  it('requires an authenticated runtime client that negotiated the feature', () => {
    const { runtime } = harness.setup(false)

    expect(() =>
      createExternalCoordinatorInvocation({
        runtime,
        method: 'orchestration.runCreate',
        params: { objective: 'mobile', external: true },
        clientKind: 'mobile',
        clientCapabilities: capabilities,
        authenticatedCallerFingerprint: fingerprint
      })
    ).toThrow(expect.objectContaining({ code: 'external_coordinator_unsupported' }))
    expect(() =>
      createExternalCoordinatorInvocation({
        runtime,
        method: 'orchestration.runCreate',
        params: { objective: 'unnegotiated', external: true },
        clientKind: 'runtime',
        clientCapabilities: [],
        authenticatedCallerFingerprint: fingerprint
      })
    ).toThrow(expect.objectContaining({ code: 'external_coordinator_unsupported' }))
  })

  it('returns an unbound authority for external run-current discovery', () => {
    const { runtime } = harness.setup(false)

    expect(
      createExternalCoordinatorInvocation({
        runtime,
        method: 'orchestration.runCurrent',
        params: {},
        clientKind: 'runtime',
        clientCapabilities: capabilities,
        authenticatedCallerFingerprint: fingerprint
      })
    ).toMatchObject({ kind: 'unbound', clientFingerprint: fingerprint })
  })

  it('rejects remote terminal-shaped coordinator requests without trusted attestation', () => {
    const { runtime } = harness.setup(false)
    const request = {
      runtime,
      method: 'orchestration.runUse',
      params: { id: 'run_target', from: 'term_attacker' },
      clientKind: 'runtime' as const,
      clientCapabilities: capabilities,
      authenticatedCallerFingerprint: fingerprint
    }

    expect(() => createExternalCoordinatorInvocation(request)).toThrow(
      expect.objectContaining({ code: 'consumer_fenced' })
    )
    expect(
      createExternalCoordinatorInvocation({
        ...request,
        attestedTerminalHandle: 'term_attacker'
      })
    ).toBeUndefined()
  })

  it('binds mutation identity to the Run generation and revalidates after fencing', () => {
    const { db, runtime } = harness.setup(false)
    const create = createExternalCoordinatorInvocation({
      runtime,
      method: 'orchestration.runCreate',
      params: { objective: 'external', external: true },
      clientKind: 'runtime',
      clientCapabilities: capabilities,
      authenticatedCallerFingerprint: fingerprint
    })
    expect(create).toMatchObject({ kind: 'create', clientFingerprint: fingerprint })

    const run = db.createExternalRun({ objective: 'external', clientFingerprint: fingerprint })
    const bound = createExternalCoordinatorInvocation({
      runtime,
      method: 'orchestration.check',
      params: { run: run.id, peek: true },
      clientKind: 'runtime',
      clientCapabilities: capabilities,
      authenticatedCallerFingerprint: fingerprint
    })
    expect(bound).toMatchObject({ kind: 'bound', run: { id: run.id } })
    expect(bound?.mutationCallerFingerprint).not.toBe(create?.mutationCallerFingerprint)

    db.unbindOtherRunsForExternalCoordinator(fingerprint)
    expect(() => bound?.kind === 'bound' && bound.revalidate()).toThrow(
      expect.objectContaining({ code: 'consumer_fenced' })
    )
  })

  it('revokes external authority when an older binary writes a terminal binding', () => {
    const { db } = harness.setup(false)
    const run = db.createExternalRun({
      objective: 'rollback safety',
      clientFingerprint: fingerprint
    })

    db.db
      .prepare(
        `UPDATE runs
         SET coordinator_handle = ?, coordinator_pane_key = ?,
             consumer_generation = consumer_generation + 1
         WHERE id = ?`
      )
      .run('term_old_binary', 'tab_old:leaf_old', run.id)

    expect(db.getRun(run.id)).toMatchObject({
      coordinator_handle: 'term_old_binary',
      coordinator_pane_key: 'tab_old:leaf_old',
      coordinator_client_fingerprint: null,
      consumer_generation: run.consumer_generation + 1
    })
  })

  it('rejects a different saved-environment fingerprint', () => {
    const { db, runtime } = harness.setup(false)
    const run = db.createExternalRun({ objective: 'external', clientFingerprint: fingerprint })

    expect(() =>
      createExternalCoordinatorInvocation({
        runtime,
        method: 'orchestration.check',
        params: { run: run.id, peek: true },
        clientKind: 'runtime',
        clientCapabilities: capabilities,
        authenticatedCallerFingerprint: 'different-fingerprint'
      })
    ).toThrow(expect.objectContaining({ code: 'consumer_fenced' }))
  })

  it('restores the external coordinator binding after database restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-external-coordinator-'))
    const dbPath = join(directory, 'orchestration.db')
    try {
      const first = new OrchestrationDb(dbPath)
      const created = first.createExternalRun({
        objective: 'survive restart',
        clientFingerprint: fingerprint
      })
      first.close()

      const restored = new OrchestrationDb(dbPath)
      expect(restored.getCurrentRunForExternalCoordinator(fingerprint)).toMatchObject({
        id: created.id,
        coordinator_client_fingerprint: fingerprint,
        consumer_generation: created.consumer_generation
      })
      restored.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('migrates an existing v29 database before creating the external coordinator index', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-external-coordinator-v29-'))
    const dbPath = join(directory, 'orchestration.db')
    try {
      const current = new OrchestrationDb(dbPath)
      current.close()
      const old = new Database(dbPath)
      old.exec(`
        DROP TRIGGER IF EXISTS trg_runs_terminal_binding_revokes_external;
        DROP INDEX IF EXISTS idx_runs_external_coordinator;
        ALTER TABLE runs DROP COLUMN coordinator_client_fingerprint;
      `)
      old.pragma('user_version = 29')
      old.close()

      const migrated = new OrchestrationDb(dbPath)
      const columns = migrated.db.pragma('table_info(runs)') as { name: string }[]
      expect(columns.map((column) => column.name)).toContain('coordinator_client_fingerprint')
      expect(
        migrated.db
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'index' AND name = 'idx_runs_external_coordinator'`
          )
          .get()
      ).toEqual({ name: 'idx_runs_external_coordinator' })
      migrated.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
