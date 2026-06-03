import { describe, expect, it } from "vitest";

import { PROTOCOL_VERSION } from "../src/shared/index.js";

/**
 * Phase 1 smoke test — confirms the Vitest harness runs green over the pure
 * `src/shared` module. Replaced by real suites (refs, protocol, transforms) in
 * later phases.
 */
describe("shared", () => {
  it("shared_exportsProtocolVersion_asOne", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
