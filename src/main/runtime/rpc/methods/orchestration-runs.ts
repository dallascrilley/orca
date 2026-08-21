import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalBoolean, OptionalString, requiredString } from '../schemas'
import { ORCHESTRATION_RUN_PAGE_LIMIT } from '../../../../shared/orchestration-run-pagination'
import type {
  OrcaRuntimeService,
  OrchestrationCompatibilityCallerAuthority
} from '../../orca-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { assertCallerHandleMatchesEvidence } from './orchestration-run-scope'

const RunCreateParams = z
  .object({
    objective: requiredString('Missing --objective'),
    from: OptionalString,
    external: OptionalBoolean
  })
  .superRefine((params, ctx) => {
    if ((params.external === true) === Boolean(params.from)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Choose exactly one coordinator identity: --from or --external.'
      })
    }
  })

const RunUseParams = z.object({
  id: requiredString('Missing --id'),
  from: requiredString('Missing coordinator terminal'),
  takeoverLegacy: OptionalBoolean
})

const RunCurrentParams = z.object({ from: OptionalString })
const RunListParams = z.object({
  limit: z.number().int().min(1).max(ORCHESTRATION_RUN_PAGE_LIMIT).optional(),
  cursor: z.string().min(1).optional()
})
const RunShowParams = z.object({ id: requiredString('Missing --id'), from: OptionalString })

function requireCallerPane(
  runtime: OrcaRuntimeService,
  handle: string,
  callerAuthority?: OrchestrationCompatibilityCallerAuthority
): string {
  const paneKey =
    callerAuthority?.terminalHandle === handle
      ? callerAuthority.paneKey
      : runtime.getTerminalPaneKey(handle)
  if (!paneKey) {
    throw new OrchestrationError(
      'stable_pane_required',
      'The coordinator terminal has no stable pane identity. Run this command inside a live Orca terminal.'
    )
  }
  return paneKey
}

export const ORCHESTRATION_RUN_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.runCreate',
    params: RunCreateParams,
    handler: (
      params,
      { externalCoordinatorAuthority, orchestrationCompatibilityEvidence, runtime }
    ) => {
      const db = runtime.getOrchestrationDb()
      if (externalCoordinatorAuthority?.kind === 'create') {
        const priorRun = db.getCurrentRunForExternalCoordinator(
          externalCoordinatorAuthority.clientFingerprint
        )
        const run = db.createExternalRun({
          objective: params.objective,
          clientFingerprint: externalCoordinatorAuthority.clientFingerprint
        })
        if (priorRun) {
          runtime.cancelMessageWaiters(`run:${priorRun.id}`)
        }
        return { run, binding: { consumerGeneration: run.consumer_generation } }
      }
      if (!params.from) {
        throw new OrchestrationError(
          'external_coordinator_unsupported',
          'External coordinator authority was not established.',
          { effectsApplied: false }
        )
      }
      assertCallerHandleMatchesEvidence(runtime, params.from, orchestrationCompatibilityEvidence)
      const paneKey = requireCallerPane(runtime, params.from)
      const priorRun = db.getCurrentRunForPane(paneKey)
      const run = db.createRun({
        objective: params.objective,
        coordinatorHandle: params.from,
        coordinatorPaneKey: paneKey
      })
      runtime.cancelMessageWaiters(params.from)
      if (priorRun) {
        runtime.cancelMessageWaiters(`run:${priorRun.id}`)
      }
      return { run, binding: { consumerGeneration: run.consumer_generation } }
    }
  }),
  defineMethod({
    name: 'orchestration.runUse',
    params: RunUseParams,
    handler: (
      params,
      {
        runtime,
        legacyCoordinatorAuthority,
        orchestrationCompatibilityEvidence,
        orchestrationCompatibilityCallerAuthority: callerAuthority
      }
    ) => {
      const paneKey = requireCallerPane(runtime, params.from, callerAuthority)
      if (
        params.takeoverLegacy &&
        (callerAuthority?.terminalHandle !== params.from || callerAuthority.paneKey !== paneKey)
      ) {
        throw new OrchestrationError(
          'legacy_read_only',
          'Legacy takeover must be invoked by the live coordinator agent terminal it will bind. No effects were applied.',
          { effectsApplied: false }
        )
      }
      assertCallerHandleMatchesEvidence(runtime, params.from, orchestrationCompatibilityEvidence)
      const db = runtime.getOrchestrationDb()
      const priorRun = db.getCurrentRunForPane(paneKey)
      const run = db.bindRun({
        runId: params.id,
        coordinatorHandle: params.from,
        coordinatorPaneKey: paneKey,
        takeoverLegacy: params.takeoverLegacy,
        legacyCoordinatorAuthority
      })
      if (!run) {
        throw new OrchestrationError(
          'run_not_found',
          `Run ${params.id} was not found or is inspect-only.`
        )
      }
      runtime.cancelMessageWaiters(params.from)
      runtime.cancelMessageWaiters(`run:${params.id}`)
      if (priorRun && priorRun.id !== params.id) {
        runtime.cancelMessageWaiters(`run:${priorRun.id}`)
      }
      return { run, binding: { consumerGeneration: run.consumer_generation } }
    }
  }),
  defineMethod({
    name: 'orchestration.runCurrent',
    params: RunCurrentParams,
    handler: (
      params,
      { externalCoordinatorAuthority, orchestrationCompatibilityEvidence, runtime }
    ) => {
      if (externalCoordinatorAuthority?.kind === 'bound') {
        return { run: externalCoordinatorAuthority.revalidate() }
      }
      if (externalCoordinatorAuthority?.kind === 'unbound') {
        return { run: null }
      }
      if (!params.from) {
        throw new OrchestrationError(
          'external_coordinator_unsupported',
          'External coordinator authority was not established.',
          { effectsApplied: false }
        )
      }
      assertCallerHandleMatchesEvidence(runtime, params.from, orchestrationCompatibilityEvidence)
      const paneKey = requireCallerPane(runtime, params.from)
      return { run: runtime.getOrchestrationDb().getCurrentRunForPane(paneKey) ?? null }
    }
  }),
  defineMethod({
    name: 'orchestration.runList',
    params: RunListParams,
    handler: (params, { runtime }) => runtime.getOrchestrationDb().listRuns(params)
  }),
  defineMethod({
    name: 'orchestration.runShow',
    params: RunShowParams,
    handler: (params, { runtime }) => {
      const run = runtime.getOrchestrationDb().getRun(params.id)
      if (!run) {
        throw new OrchestrationError('run_not_found', `Run ${params.id} was not found.`)
      }
      return { run }
    }
  })
]
