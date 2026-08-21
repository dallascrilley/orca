import { createHash } from 'node:crypto'
import { ORCHESTRATION_EXTERNAL_COORDINATOR_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { RunRow } from '../orchestration/types'
import { OrchestrationError } from '../orchestration/orchestration-error'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RuntimeCapability } from '../../../shared/protocol-version'

export type ExternalCoordinatorAuthority =
  | {
      kind: 'create'
      clientFingerprint: string
      mutationCallerFingerprint: string
    }
  | {
      kind: 'unbound'
      clientFingerprint: string
      mutationCallerFingerprint: string
    }
  | {
      kind: 'bound'
      clientFingerprint: string
      run: RunRow
      mutationCallerFingerprint: string
      revalidate: () => RunRow
    }

const COORDINATOR_TERMINAL_METHODS: Record<string, true> = {
  'orchestration.runCreate': true,
  'orchestration.runUse': true,
  'orchestration.runCurrent': true,
  'orchestration.check': true,
  'orchestration.reply': true,
  'orchestration.send': true,
  'orchestration.ask': true,
  'orchestration.taskCreate': true,
  'orchestration.taskList': true,
  'orchestration.taskUpdate': true,
  'orchestration.dispatch': true,
  'orchestration.workerStart': true,
  'orchestration.gateCreate': true,
  'orchestration.gateResolve': true,
  'orchestration.gateList': true
}
type CandidateParams = Record<string, unknown>

function isExternalCoordinatorCandidate(method: string, params: CandidateParams): boolean {
  return (
    (method === 'orchestration.runCreate' && params.external === true) ||
    (method === 'orchestration.runCurrent' && params.from === undefined) ||
    (method === 'orchestration.check' && params.terminal === undefined) ||
    (method === 'orchestration.reply' && params.from === undefined)
  )
}

function declaredCoordinatorTerminal(params: CandidateParams): string | undefined {
  for (const key of ['from', 'terminal', 'callerTerminalHandle']) {
    const value = params[key]
    if (typeof value === 'string' && value.length > 0) {
      return value
    }
  }
  return undefined
}

function mutationFingerprint(clientFingerprint: string, run?: RunRow): string {
  return createHash('sha256')
    .update(
      run
        ? `external-coordinator:${clientFingerprint}:${run.id}:${run.consumer_generation}`
        : `external-coordinator:${clientFingerprint}:create`
    )
    .digest('hex')
}

function requireEligibleExternalClient(args: {
  clientKind?: 'mobile' | 'runtime'
  clientCapabilities?: readonly RuntimeCapability[]
  authenticatedCallerFingerprint?: string
}): string {
  if (
    args.clientKind !== 'runtime' ||
    !args.authenticatedCallerFingerprint ||
    !args.clientCapabilities?.includes(ORCHESTRATION_EXTERNAL_COORDINATOR_RUNTIME_CAPABILITY)
  ) {
    throw new OrchestrationError(
      'external_coordinator_unsupported',
      'External orchestration requires an authenticated saved runtime environment that negotiated orchestration.external-coordinator.v1.',
      { effectsApplied: false }
    )
  }
  return args.authenticatedCallerFingerprint
}

function resolveRequestedRunId(
  runtime: OrcaRuntimeService,
  method: string,
  params: CandidateParams
): string | undefined {
  if (method === 'orchestration.reply' && typeof params.id === 'string') {
    const messageRunId = runtime.getOrchestrationDb().getMessageById(params.id)?.run_id
    if (
      messageRunId &&
      typeof params.run === 'string' &&
      params.run.length > 0 &&
      params.run !== messageRunId
    ) {
      throw new OrchestrationError(
        'consumer_fenced',
        `Message ${params.id} does not belong to Run ${params.run}.`,
        { effectsApplied: false }
      )
    }
    return messageRunId
  }
  return typeof params.run === 'string' && params.run.length > 0 ? params.run : undefined
}

export function rejectUnauthenticatedExternalCoordinator(
  runtime: OrcaRuntimeService,
  method: string,
  params: unknown
): void {
  createExternalCoordinatorInvocation({ runtime, method, params })
}

export function createExternalCoordinatorInvocation(args: {
  runtime: OrcaRuntimeService
  method: string
  params: unknown
  clientKind?: 'mobile' | 'runtime'
  clientCapabilities?: readonly RuntimeCapability[]
  authenticatedCallerFingerprint?: string
  attestedTerminalHandle?: string
}): ExternalCoordinatorAuthority | undefined {
  const params =
    typeof args.params === 'object' && args.params !== null ? (args.params as CandidateParams) : {}
  if (!isExternalCoordinatorCandidate(args.method, params)) {
    const declaredTerminal = declaredCoordinatorTerminal(params)
    if (
      args.clientKind === 'runtime' &&
      args.authenticatedCallerFingerprint &&
      COORDINATOR_TERMINAL_METHODS[args.method] &&
      (!declaredTerminal || args.attestedTerminalHandle !== declaredTerminal)
    ) {
      throw new OrchestrationError(
        'consumer_fenced',
        'A remote runtime client cannot assert coordinator terminal identity without verified attestation for that exact terminal.',
        { effectsApplied: false }
      )
    }
    return undefined
  }

  const clientFingerprint = requireEligibleExternalClient(args)
  if (args.method === 'orchestration.runCreate') {
    return {
      kind: 'create',
      clientFingerprint,
      mutationCallerFingerprint: mutationFingerprint(clientFingerprint)
    }
  }

  const db = args.runtime.getOrchestrationDb()
  const requestedRunId = resolveRequestedRunId(args.runtime, args.method, params)
  const run = requestedRunId
    ? db.getRun(requestedRunId)
    : db.getCurrentRunForExternalCoordinator(clientFingerprint)
  if (!run && args.method === 'orchestration.runCurrent') {
    return {
      kind: 'unbound',
      clientFingerprint,
      mutationCallerFingerprint: mutationFingerprint(clientFingerprint)
    }
  }
  if (
    !run ||
    run.legacy === 1 ||
    run.coordinator_client_fingerprint !== clientFingerprint ||
    run.coordinator_handle !== null ||
    run.coordinator_pane_key !== null
  ) {
    throw new OrchestrationError(
      'consumer_fenced',
      requestedRunId
        ? `This external coordinator is not bound to Run ${requestedRunId}.`
        : 'No Run is bound to this external coordinator.',
      { effectsApplied: false }
    )
  }
  const consumerGeneration = run.consumer_generation
  const revalidate = (): RunRow => {
    const current = db.getRun(run.id)
    if (
      !current ||
      current.consumer_generation !== consumerGeneration ||
      current.coordinator_client_fingerprint !== clientFingerprint ||
      current.coordinator_handle !== null ||
      current.coordinator_pane_key !== null
    ) {
      throw new OrchestrationError(
        'consumer_fenced',
        `This external coordinator is no longer bound to Run ${run.id}.`,
        { effectsApplied: false }
      )
    }
    return current
  }
  return {
    kind: 'bound',
    clientFingerprint,
    run,
    mutationCallerFingerprint: mutationFingerprint(clientFingerprint, run),
    revalidate
  }
}
