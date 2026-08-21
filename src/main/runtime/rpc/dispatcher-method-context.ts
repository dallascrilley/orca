import type { OrchestrationCompatibilityCallerAuthority } from '../orca-runtime'
import type { RpcContext, RpcRequest } from './core'
import type { RpcDispatchStreamingOptions } from './dispatcher-stream-options'
import type { DurableMutationInvocation } from './orchestration-mutation-executor'
import type { ExternalCoordinatorAuthority } from './external-coordinator-invocation'

type LegacyCoordinatorInvocation = {
  authority: RpcContext['legacyCoordinatorAuthority']
  revalidate: NonNullable<RpcContext['revalidateLegacyCoordinator']>
}

export function createDispatcherMethodContext(args: {
  runtime: RpcContext['runtime']
  request: RpcRequest
  options?: RpcDispatchStreamingOptions
  mutation?: DurableMutationInvocation
  authenticatedCallerFingerprint?: string
  legacyCoordinator?: LegacyCoordinatorInvocation
  compatibilityCallerAuthority?: OrchestrationCompatibilityCallerAuthority
  externalCoordinator?: ExternalCoordinatorAuthority
}): RpcContext {
  return {
    runtime: args.runtime,
    signal: args.options?.signal,
    requestId: args.request.id,
    connectionId: args.options?.connectionId,
    clientId: args.options?.clientId,
    pairedDeviceId: args.options?.pairedDeviceId,
    clientKind: args.options?.clientKind,
    clientCapabilities: args.options?.clientCapabilities,
    orchestrationCapability: args.request.orchestrationCapability,
    authenticatedCallerFingerprint:
      args.mutation?.identity.callerFingerprint ?? args.authenticatedCallerFingerprint,
    recordMutationReceipt: args.mutation?.recordReceipt,
    orchestrationMutation: args.mutation?.identity,
    pairing: args.options?.pairing,
    sendBinary: args.options?.sendBinary,
    registerBinaryStreamHandler: args.options?.registerBinaryStreamHandler,
    legacyCoordinatorRunId: args.legacyCoordinator?.revalidate(),
    legacyCoordinatorAuthority: args.legacyCoordinator?.authority,
    revalidateLegacyCoordinator: args.legacyCoordinator?.revalidate,
    orchestrationCompatibilityCallerAuthority: args.compatibilityCallerAuthority,
    orchestrationCompatibilityEvidence: args.request.orchestrationCompatibilityEvidence,
    externalCoordinatorAuthority: args.externalCoordinator
  }
}
