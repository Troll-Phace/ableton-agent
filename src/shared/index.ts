/**
 * Wire-protocol version for the extension ⇄ webview channel.
 *
 * Pure shared layer seed. This module (and its siblings, added in later phases)
 * holds ONLY pure types and pure functions shared across the transport boundary
 * — no SDK, no DOM, no Node APIs. Ref grammar, protocol envelopes, and tool-arg
 * shapes land here.
 */
export const PROTOCOL_VERSION = 1 as const;

export * from "./protocol.js";
