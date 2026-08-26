/** Public API for module authors. */
export { defineModule, BlockedError } from './core/types.js';
export type {
  ShakeoutModule,
  ModuleManifest,
  ModuleRequires,
  ModuleCost,
  SideEffect,
  RunContext,
  RunResult,
  OracleResult,
  Outcome,
} from './core/types.js';
export { expectBeacon, expectNoBeaconBefore } from './observer/oracles.js';
export type { Evidence, NetworkEvent, ConsoleEvent } from './observer/capture.js';
export type { Target, ShakeoutConfig } from './targets/types.js';
