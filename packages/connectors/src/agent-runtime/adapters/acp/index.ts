/**
 * Barrel for the generic ACP protocol handling subpackage.
 *
 * Exposes the framing, event normalization, transport seam, and session
 * lifecycle. These are provider-neutral (no "cursor"/"grok" references);
 * provider-specific executable discovery lives in `../acp-providers`. The
 * transport seam + FakeAcpTransport are exposed so the desktop wiring and tests
 * can reach them.
 */

export {
  parseAcpLine,
  encodeAcpFrame,
  isAcpRequest,
  isAcpResponse,
  isAcpNotification,
  MAX_ACP_FRAME_CHARACTERS,
  type AcpFrame,
  type AcpRequest,
  type AcpResponse,
  type AcpNotification,
  type AcpError
} from "./protocol";
export {
  ACP_PERMISSION_TOOL,
  buildAcpPermissionToolCall,
  finishReasonForAcpStopReason,
  normalizeAcpNotification
} from "./events";
export {
  type AcpTransport,
  type AcpTransportFactory,
  type AcpTransportProvider,
  type AcpInboundFrame,
  type AcpReply
} from "./transport";
export { runAcpSession, type AcpSessionOptions } from "./session";
