/**
 * Per-conversation dev-server runner.
 *
 * See packages/core/src/dev-servers/runner.ts for the public API.
 * IMPLEMENTATION_PLAN_GROUP_CHAT.md (parent dir) has the design rationale.
 */
export { allocateConversationPorts, type AllocatedMemberPorts } from './port-allocator';
export { detectDevCommand, type DevCommandSpec } from './dev-command';
export {
  startDevServers,
  stopDevServers,
  getDevServerStatus,
  getCodebaseLabels,
  type DevServerStartResult,
  type DevServerStartOptions,
} from './runner';
export { startIdleSweeper, stopIdleSweeper, type ServerStatus } from './process-manager';
