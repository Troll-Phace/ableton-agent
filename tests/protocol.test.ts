import { describe, expect, it } from "vitest";

import { PROTOCOL_VERSION } from "../src/shared/index.js";
import {
  isClientMessage,
  isMessageOfType,
  isServerMessage,
  message,
  parseEnvelope,
  serialize,
  type MessageByType,
  type MessageType,
  type ProtocolMessage,
} from "../src/shared/protocol.js";

/**
 * Phase 7 (T7) protocol suite — the pure §13 socket-protocol contract in
 * `src/shared/protocol.ts`. Pure only: no SDK, no Node server, no `ws`.
 *
 * Coverage:
 *  - Round-trip every one of the 12 message types via
 *    `serialize(message(...))` → `parseEnvelope(...)` and assert deep equality.
 *  - Malformed-input rejection: `parseEnvelope` returns `{ ok:false, error }`
 *    and NEVER throws, across envelope- and payload-level violations.
 *  - Type guards: `isClientMessage` / `isServerMessage` / `isMessageOfType`.
 *  - Empty-payload (`ready`/`cancel`) handling.
 *  - Extra-key tolerance (pinned as intentional behavior).
 *
 * Malformed inputs are supplied as raw JSON *strings* (the only input shape
 * `parseEnvelope` accepts), which keeps the tests free of `as any` on the
 * function input while still exercising untrusted wire data.
 */

/** A fixed, deterministic envelope id reused across construction tests. */
const ID = "11111111-2222-3333-4444-555555555555";

/**
 * One canonical, fully-populated payload per message type. Keyed by type so the
 * round-trip loop can iterate every member with a representative payload.
 */
const SAMPLE_PAYLOADS: {
  [T in MessageType]: MessageByType[T]["payload"];
} = {
  ready: {},
  user_message: { text: "make the bass louder" },
  confirm_response: { planId: "plan-7", approved: true },
  cancel: {},
  set_config: { apiKey: "sk-ant-test", model: "claude-sonnet-4-6" },
  config_state: { hasKey: true, model: "claude-sonnet-4-6" },
  assistant_delta: { text: "Sure, " },
  assistant_done: { stopReason: "end_turn" },
  tool_activity: {
    tool: "live_update_track",
    summary: "Rename track 2 → Bass",
    status: "started",
  },
  confirm_request: {
    planId: "plan-9",
    summary: "Delete 1 track",
    actions: ["delete track:2:Bass"],
  },
  refs_updated: { refs: ["track:2:Bass", "track:3:Drums"] },
  error: { message: "loop aborted" },
};

/** Every message type, for table-driven iteration. */
const ALL_TYPES = Object.keys(SAMPLE_PAYLOADS) as MessageType[];

const CLIENT_TYPES: MessageType[] = [
  "ready",
  "user_message",
  "confirm_response",
  "cancel",
  "set_config",
];

const SERVER_TYPES: MessageType[] = [
  "config_state",
  "assistant_delta",
  "assistant_done",
  "tool_activity",
  "confirm_request",
  "refs_updated",
  "error",
];

/* -------------------------------------------------------------------------- */
/* Round-trip: every message type                                             */
/* -------------------------------------------------------------------------- */

describe("protocol — round-trip every message type", () => {
  for (const type of ALL_TYPES) {
    it(`test_protocol_roundTrip_${type}`, () => {
      const original = message(type, SAMPLE_PAYLOADS[type], ID);
      const result = parseEnvelope(serialize(original));

      expect(result.ok).toBe(true);
      if (!result.ok) return; // narrow for TS; assertion above already failed
      expect(result.message).toEqual(original);
      expect(result.message.v).toBe(PROTOCOL_VERSION);
      expect(result.message.id).toBe(ID);
      expect(result.message.type).toBe(type);
      expect(result.message.payload).toEqual(SAMPLE_PAYLOADS[type]);
    });
  }

  it("test_protocol_roundTrip_message_setsVersionAndId", () => {
    const msg = message("user_message", { text: "hi" }, "abc");
    expect(msg.v).toBe(PROTOCOL_VERSION);
    expect(msg.id).toBe("abc");
    expect(msg.type).toBe("user_message");
    expect(msg.payload).toEqual({ text: "hi" });
  });

  it("test_protocol_roundTrip_serializeProducesJsonString", () => {
    const wire = serialize(message("ready", {}, ID));
    expect(typeof wire).toBe("string");
    expect(JSON.parse(wire)).toEqual({
      v: PROTOCOL_VERSION,
      id: ID,
      type: "ready",
      payload: {},
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Round-trip: representative payload variants                                */
/* -------------------------------------------------------------------------- */

describe("protocol — round-trip representative payload variants", () => {
  for (const status of ["started", "ok", "error"] as const) {
    it(`test_protocol_roundTrip_toolActivity_status_${status}`, () => {
      const original = message(
        "tool_activity",
        { tool: "live_delete", summary: "delete", status },
        ID
      );
      const result = parseEnvelope(serialize(original));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.message).toEqual(original);
    });
  }

  it("test_protocol_roundTrip_refsUpdated_emptyArray", () => {
    const original = message("refs_updated", { refs: [] }, ID);
    const result = parseEnvelope(serialize(original));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message).toEqual(original);
    expect((result.message.payload as { refs: string[] }).refs).toEqual([]);
  });

  it("test_protocol_roundTrip_setConfig_bothFields", () => {
    const original = message(
      "set_config",
      { apiKey: "sk-ant", model: "m" },
      ID
    );
    const result = parseEnvelope(serialize(original));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message).toEqual(original);
  });

  it("test_protocol_roundTrip_setConfig_onlyApiKey", () => {
    const original = message("set_config", { apiKey: "sk-ant" }, ID);
    const result = parseEnvelope(serialize(original));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message).toEqual(original);
  });

  it("test_protocol_roundTrip_setConfig_onlyModel", () => {
    const original = message("set_config", { model: "claude" }, ID);
    const result = parseEnvelope(serialize(original));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message).toEqual(original);
  });

  it("test_protocol_roundTrip_setConfig_emptyPayload", () => {
    const original = message("set_config", {}, ID);
    const result = parseEnvelope(serialize(original));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message).toEqual(original);
  });

  it("test_protocol_roundTrip_confirmRequest_withActions", () => {
    const original = message(
      "confirm_request",
      {
        planId: "p1",
        summary: "Delete 2 tracks",
        actions: ["delete track:2:Bass", "delete track:3:Drums"],
      },
      ID
    );
    const result = parseEnvelope(serialize(original));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message).toEqual(original);
  });

  it("test_protocol_roundTrip_confirmRequest_emptyActions", () => {
    const original = message(
      "confirm_request",
      { planId: "p1", summary: "nothing", actions: [] },
      ID
    );
    const result = parseEnvelope(serialize(original));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message).toEqual(original);
  });

  it("test_protocol_roundTrip_confirmResponse_falseApproved", () => {
    const original = message(
      "confirm_response",
      { planId: "p1", approved: false },
      ID
    );
    const result = parseEnvelope(serialize(original));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message).toEqual(original);
  });

  it("test_protocol_roundTrip_emptyStringPayloadFields_allowed", () => {
    // `assistant_delta` requires a string (not non-empty), so "" is legal.
    const original = message("assistant_delta", { text: "" }, ID);
    const result = parseEnvelope(serialize(original));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message).toEqual(original);
  });
});

/* -------------------------------------------------------------------------- */
/* Empty-payload messages                                                     */
/* -------------------------------------------------------------------------- */

describe("protocol — empty-payload messages", () => {
  for (const type of ["ready", "cancel"] as const) {
    it(`test_protocol_emptyPayload_${type}_validatesAndRoundTrips`, () => {
      const original = message(type, {}, ID);
      const wire = serialize(original);
      const result = parseEnvelope(wire);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.message.payload).toEqual({});
      expect(result.message).toEqual(original);
    });

    it(`test_protocol_emptyPayload_${type}_rejectsNonObjectPayload`, () => {
      const wire = JSON.stringify({
        v: PROTOCOL_VERSION,
        id: ID,
        type,
        payload: "not-an-object",
      });
      const result = parseEnvelope(wire);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.length).toBeGreaterThan(0);
    });
  }
});

/* -------------------------------------------------------------------------- */
/* Malformed input — never throws, always { ok:false, error }                 */
/* -------------------------------------------------------------------------- */

/** Build a raw JSON string for an envelope with arbitrary (possibly bad) parts. */
function rawEnvelope(parts: Record<string, unknown>): string {
  return JSON.stringify(parts);
}

describe("protocol — malformed input never throws", () => {
  it("test_protocol_parse_nonJson_returnsError", () => {
    let result!: ReturnType<typeof parseEnvelope>;
    expect(() => {
      result = parseEnvelope("this is not json");
    }).not.toThrow();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.length).toBeGreaterThan(0);
  });

  it("test_protocol_parse_truncatedJson_returnsError", () => {
    let result!: ReturnType<typeof parseEnvelope>;
    expect(() => {
      result = parseEnvelope('{"v":1,"id":"x","type":"ready","payload":{');
    }).not.toThrow();
    expect(result.ok).toBe(false);
  });

  it("test_protocol_parse_emptyString_returnsError", () => {
    const result = parseEnvelope("");
    expect(result.ok).toBe(false);
  });

  it("test_protocol_parse_jsonNumber_returnsError", () => {
    const result = parseEnvelope("42");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.length).toBeGreaterThan(0);
  });

  it("test_protocol_parse_jsonArray_returnsError", () => {
    const result = parseEnvelope("[1,2,3]");
    expect(result.ok).toBe(false);
  });

  it("test_protocol_parse_jsonNull_returnsError", () => {
    const result = parseEnvelope("null");
    expect(result.ok).toBe(false);
  });

  it("test_protocol_parse_jsonString_returnsError", () => {
    const result = parseEnvelope('"a bare string"');
    expect(result.ok).toBe(false);
  });

  it("test_protocol_parse_jsonBoolean_returnsError", () => {
    const result = parseEnvelope("true");
    expect(result.ok).toBe(false);
  });
});

describe("protocol — envelope-level violations", () => {
  it("test_protocol_parse_wrongVersion_returnsError", () => {
    const result = parseEnvelope(
      rawEnvelope({ v: 2, id: ID, type: "ready", payload: {} })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("version");
  });

  it("test_protocol_parse_missingVersion_returnsError", () => {
    const result = parseEnvelope(
      rawEnvelope({ id: ID, type: "ready", payload: {} })
    );
    expect(result.ok).toBe(false);
  });

  it("test_protocol_parse_nonNumericVersion_returnsError", () => {
    const result = parseEnvelope(
      rawEnvelope({ v: "1", id: ID, type: "ready", payload: {} })
    );
    expect(result.ok).toBe(false);
  });

  it("test_protocol_parse_missingId_returnsError", () => {
    const result = parseEnvelope(
      rawEnvelope({ v: PROTOCOL_VERSION, type: "ready", payload: {} })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("id");
  });

  it("test_protocol_parse_emptyId_returnsError", () => {
    const result = parseEnvelope(
      rawEnvelope({ v: PROTOCOL_VERSION, id: "", type: "ready", payload: {} })
    );
    expect(result.ok).toBe(false);
  });

  it("test_protocol_parse_nonStringId_returnsError", () => {
    const result = parseEnvelope(
      rawEnvelope({ v: PROTOCOL_VERSION, id: 123, type: "ready", payload: {} })
    );
    expect(result.ok).toBe(false);
  });

  it("test_protocol_parse_unknownType_returnsError", () => {
    const result = parseEnvelope(
      rawEnvelope({
        v: PROTOCOL_VERSION,
        id: ID,
        type: "bogus_type",
        payload: {},
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("type");
  });

  it("test_protocol_parse_missingType_returnsError", () => {
    const result = parseEnvelope(
      rawEnvelope({ v: PROTOCOL_VERSION, id: ID, payload: {} })
    );
    expect(result.ok).toBe(false);
  });

  it("test_protocol_parse_nonStringType_returnsError", () => {
    const result = parseEnvelope(
      rawEnvelope({ v: PROTOCOL_VERSION, id: ID, type: 7, payload: {} })
    );
    expect(result.ok).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Per-type payload violations                                                */
/* -------------------------------------------------------------------------- */

/**
 * Table of bad payloads per type. Each row produces a parse against an
 * otherwise-valid envelope and asserts `{ ok:false }` with a non-empty error.
 */
const BAD_PAYLOAD_CASES: ReadonlyArray<{
  name: string;
  type: MessageType;
  payload: unknown;
}> = [
  { name: "user_message_missingText", type: "user_message", payload: {} },
  {
    name: "user_message_textNotString",
    type: "user_message",
    payload: { text: 123 },
  },
  {
    name: "user_message_textEmpty",
    type: "user_message",
    payload: { text: "" },
  },
  {
    name: "confirm_response_approvedNotBoolean",
    type: "confirm_response",
    payload: { planId: "p", approved: "yes" },
  },
  {
    name: "confirm_response_missingPlanId",
    type: "confirm_response",
    payload: { approved: true },
  },
  {
    name: "confirm_response_planIdEmpty",
    type: "confirm_response",
    payload: { planId: "", approved: true },
  },
  {
    name: "set_config_apiKeyNotString",
    type: "set_config",
    payload: { apiKey: 5 },
  },
  {
    name: "set_config_modelNotString",
    type: "set_config",
    payload: { model: true },
  },
  {
    name: "config_state_hasKeyNotBoolean",
    type: "config_state",
    payload: { hasKey: "true", model: "m" },
  },
  {
    name: "config_state_modelNotString",
    type: "config_state",
    payload: { hasKey: true, model: 3 },
  },
  {
    name: "assistant_delta_textNotString",
    type: "assistant_delta",
    payload: { text: 1 },
  },
  {
    name: "assistant_done_stopReasonNotString",
    type: "assistant_done",
    payload: { stopReason: null },
  },
  {
    name: "tool_activity_statusBogus",
    type: "tool_activity",
    payload: { tool: "t", summary: "s", status: "bogus" },
  },
  {
    name: "tool_activity_toolNotString",
    type: "tool_activity",
    payload: { tool: 1, summary: "s", status: "ok" },
  },
  {
    name: "tool_activity_summaryNotString",
    type: "tool_activity",
    payload: { tool: "t", summary: 2, status: "ok" },
  },
  {
    name: "confirm_request_actionsNotArray",
    type: "confirm_request",
    payload: { planId: "p", summary: "s", actions: "x" },
  },
  {
    name: "confirm_request_actionsNotStringArray",
    type: "confirm_request",
    payload: { planId: "p", summary: "s", actions: [1, 2] },
  },
  {
    name: "confirm_request_missingPlanId",
    type: "confirm_request",
    payload: { summary: "s", actions: [] },
  },
  {
    name: "confirm_request_summaryNotString",
    type: "confirm_request",
    payload: { planId: "p", summary: 0, actions: [] },
  },
  {
    name: "refs_updated_refsNotArray",
    type: "refs_updated",
    payload: { refs: "x" },
  },
  {
    name: "refs_updated_refsNotStringArray",
    type: "refs_updated",
    payload: { refs: [1, 2] },
  },
  { name: "refs_updated_missingRefs", type: "refs_updated", payload: {} },
  {
    name: "error_messageNotString",
    type: "error",
    payload: { message: 42 },
  },
  { name: "error_missingMessage", type: "error", payload: {} },
];

describe("protocol — per-type payload violations", () => {
  for (const { name, type, payload } of BAD_PAYLOAD_CASES) {
    it(`test_protocol_badPayload_${name}`, () => {
      let result!: ReturnType<typeof parseEnvelope>;
      const wire = JSON.stringify({
        v: PROTOCOL_VERSION,
        id: ID,
        type,
        payload,
      });
      expect(() => {
        result = parseEnvelope(wire);
      }).not.toThrow();
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.length).toBeGreaterThan(0);
    });
  }

  it("test_protocol_badPayload_nonObjectPayload_returnsError", () => {
    const wire = JSON.stringify({
      v: PROTOCOL_VERSION,
      id: ID,
      type: "user_message",
      payload: 5,
    });
    const result = parseEnvelope(wire);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("object");
  });

  it("test_protocol_badPayload_arrayPayload_returnsError", () => {
    const wire = JSON.stringify({
      v: PROTOCOL_VERSION,
      id: ID,
      type: "user_message",
      payload: ["text"],
    });
    const result = parseEnvelope(wire);
    expect(result.ok).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Extra-key tolerance (pinned as intentional)                                */
/* -------------------------------------------------------------------------- */

describe("protocol — extra-key tolerance (intentional)", () => {
  it("test_protocol_extraKeys_onEnvelope_tolerated", () => {
    const wire = JSON.stringify({
      v: PROTOCOL_VERSION,
      id: ID,
      type: "user_message",
      payload: { text: "hi" },
      extraEnvelopeKey: "ignored",
    });
    const result = parseEnvelope(wire);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The validator passes; the unknown key is preserved on the parsed object
    // (parseEnvelope returns the parsed value as-is once validated).
    expect(
      (result.message as unknown as Record<string, unknown>).extraEnvelopeKey
    ).toBe("ignored");
  });

  it("test_protocol_extraKeys_onPayload_tolerated", () => {
    const wire = JSON.stringify({
      v: PROTOCOL_VERSION,
      id: ID,
      type: "user_message",
      payload: { text: "hi", surprise: 1 },
    });
    const result = parseEnvelope(wire);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.message.payload as Record<string, unknown>).surprise).toBe(
      1
    );
  });

  it("test_protocol_extraKeys_onEmptyPayloadMessage_tolerated", () => {
    const wire = JSON.stringify({
      v: PROTOCOL_VERSION,
      id: ID,
      type: "ready",
      payload: { unexpected: true },
    });
    const result = parseEnvelope(wire);
    expect(result.ok).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Type guards                                                                */
/* -------------------------------------------------------------------------- */

/** Build a minimal valid message of `type` for guard tests. */
function sample<T extends MessageType>(type: T): MessageByType[T] {
  return message(type, SAMPLE_PAYLOADS[type], ID);
}

describe("protocol — type guards", () => {
  for (const type of CLIENT_TYPES) {
    it(`test_protocol_isClientMessage_true_${type}`, () => {
      const msg: ProtocolMessage = sample(type);
      expect(isClientMessage(msg)).toBe(true);
      expect(isServerMessage(msg)).toBe(false);
    });
  }

  for (const type of SERVER_TYPES) {
    it(`test_protocol_isServerMessage_true_${type}`, () => {
      const msg: ProtocolMessage = sample(type);
      expect(isServerMessage(msg)).toBe(true);
      expect(isClientMessage(msg)).toBe(false);
    });
  }

  it("test_protocol_isMessageOfType_trueForMatch", () => {
    const msg: ProtocolMessage = sample("user_message");
    expect(isMessageOfType(msg, "user_message")).toBe(true);
  });

  it("test_protocol_isMessageOfType_falseForMismatch", () => {
    const msg: ProtocolMessage = sample("user_message");
    expect(isMessageOfType(msg, "assistant_delta")).toBe(false);
    expect(isMessageOfType(msg, "ready")).toBe(false);
  });

  it("test_protocol_isMessageOfType_narrowsPayload", () => {
    const msg: ProtocolMessage = sample("tool_activity");
    if (isMessageOfType(msg, "tool_activity")) {
      // Narrowing makes the payload's typed fields reachable without casts.
      expect(msg.payload.tool).toBe("live_update_track");
      expect(msg.payload.status).toBe("started");
    } else {
      throw new Error("guard should have matched tool_activity");
    }
  });

  it("test_protocol_isMessageOfType_eachTypeMatchesOnlyItself", () => {
    for (const type of ALL_TYPES) {
      const msg: ProtocolMessage = sample(type);
      const matches = ALL_TYPES.filter((t) => isMessageOfType(msg, t));
      expect(matches).toEqual([type]);
    }
  });
});
