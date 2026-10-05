import Type from "typebox";

/** First-party bot-node RPCs. Each wire name has exactly one installed operation. */
export const BOT_NODE_DESKTOP_OPERATIONS = {
  "botNode/sessionCreate": "session/create",
  "botNode/sessionGet": "session/get",
  "botNode/sessionList": "session/list",
  "botNode/sessionConfigure": "session/configure",
  "botNode/promptLookup": "agent/promptLookup",
  "botNode/promptInvalidate": "agent/promptInvalidate",
  "botNode/promptStart": "agent/prompt",
  "botNode/steer": "agent/steer",
  "botNode/status": "agent/getStatus",
  "botNode/stop": "agent/abort",
  "botNode/scheduleUpsert": "scheduled/pluginUpsert",
  "botNode/scheduleGet": "scheduled/pluginGet",
  "botNode/scheduleLookup": "scheduled/pluginLookup",
  "botNode/sessionOwner": "scheduled/pluginSessionOwner",
  "botNode/scheduleDisable": "scheduled/pluginDisable",
  "botNode/scheduleStart": "scheduled/pluginStart",
  "botNode/scheduleSkip": "scheduled/pluginSkip",
  "botNode/scheduleRetry": "scheduled/pluginRetry",
  "botNode/workerSpawn": "session/collaboration/spawn",
  "botNode/workerSend": "session/collaboration/send",
  "botNode/workerStatus": "session/collaboration/status",
  "botNode/workerList": "session/collaboration/list",
  "botNode/workerResult": "session/collaboration/result",
  "botNode/workerLookup": "session/collaboration/lookup",
  "botNode/workerCancel": "session/collaboration/cancel",
  "botNode/checkSnapshot": "verification/snapshot",
  "botNode/checkApprove": "verification/approveCheck",
  "botNode/checkRun": "verification/runApprovedCheck",
  "botNode/checkLookup": "verification/lookupExecution",
  "botNode/checkCancel": "verification/cancelExecution",
  "botNode/checkRevoke": "verification/revokeCheck",
} as const;

const Id = Type.String({ minLength: 1, maxLength: 512 });
const ObjectArg = Type.Record(Type.String(), Type.Unknown());
const objectCall = Type.Tuple([ObjectArg]);
const stringCall = Type.Tuple([Id]);
const emptyCall = Type.Tuple([]);
const optionalContext = {
  invocationId: Type.Optional(Id),
  confirm: Type.Optional(Type.Boolean()),
};
const call = (args: Type.TSchema) =>
  Type.Object({ args, ...optionalContext }, { additionalProperties: false });

/** Shape validation precedes the existing semantic Host validators and durable ledgers. */
export const BOT_NODE_SCHEMAS: Record<string, Type.TSchema> = {};
for (const [wire, operation] of Object.entries(BOT_NODE_DESKTOP_OPERATIONS)) {
  const args =
    operation === "session/list"
      ? Type.Union([emptyCall, objectCall])
      : operation === "session/configure"
        ? Type.Tuple([Id, ObjectArg])
        : ["agent/getStatus"].includes(operation)
          ? stringCall
          : objectCall;
  BOT_NODE_SCHEMAS[wire] = call(args);
}
Object.assign(BOT_NODE_SCHEMAS, {
  "botNode/attach": Type.Object(
    {
      description: Type.String({ maxLength: 32768 }),
      schema: Type.Record(Type.String(), Type.Unknown()),
    },
    { additionalProperties: false },
  ),
  "botNode/models": Type.Object({}, { additionalProperties: false }),
  "botNode/complete": Type.Object(
    {
      modelKey: Id,
      system: Type.String({ maxLength: 24576 }),
      messages: Type.Array(
        Type.Object(
          {
            role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
            content: Type.String({ maxLength: 24576 }),
          },
          { additionalProperties: false },
        ),
        { maxItems: 100 },
      ),
      includeSessionContext: Type.Literal(false),
      invocationId: Type.Optional(Id),
    },
    { additionalProperties: false },
  ),
  "botNode/navigation": Type.Object({}, { additionalProperties: false }),
  "botNode/nativeSession": Type.Object(
    { sessionId: Id },
    { additionalProperties: false },
  ),
  "botNode/scheduleAuthorize": Type.Object(
    { definition: ObjectArg },
    { additionalProperties: false },
  ),
  "botNode/sessionAdopt": Type.Object(
    { sessionId: Id },
    { additionalProperties: false },
  ),
  "botNode/pendingApprovals": Type.Object({}, { additionalProperties: false }),
  "botNode/consents": Type.Object({}, { additionalProperties: false }),
  "botNode/consentRespond": Type.Object(
    {
      id: Id,
      hash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
      decision: Type.Union([Type.Literal("approve"), Type.Literal("deny")]),
    },
    { additionalProperties: false },
  ),
  "botNode/approvals": Type.Object(
    { sessionId: Id },
    { additionalProperties: false },
  ),
  "botNode/approvalRespond": Type.Object(
    {
      id: Id,
      sessionId: Id,
      revision: Type.Integer({ minimum: 0 }),
      decision: Type.Union([
        Type.Literal("allow-once"),
        Type.Literal("deny"),
        Type.Literal("approve"),
        Type.Literal("reject"),
      ]),
      requestId: Id,
    },
    { additionalProperties: false },
  ),
  "botNode/manualAuthorize": Type.Object(
    {
      requestIntentId: Id,
      routineId: Id,
      sessionId: Id,
      contentHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
      title: Type.String({ maxLength: 2048 }),
    },
    { additionalProperties: false },
  ),
  "botNode/fileReadText": Type.Object(
    { path: Type.String({ maxLength: 4096 }), invocationId: Type.Optional(Id) },
    { additionalProperties: false },
  ),
  "botNode/fileReadRange": Type.Object(
    {
      path: Type.String({ maxLength: 4096 }),
      offset: Type.Integer({ minimum: 0 }),
      length: Type.Integer({ minimum: 0, maximum: 524288 }),
      invocationId: Type.Optional(Id),
    },
    { additionalProperties: false },
  ),
  "botNode/fileStat": Type.Object(
    { path: Type.String({ maxLength: 4096 }), invocationId: Type.Optional(Id) },
    { additionalProperties: false },
  ),
  "botNode/fileList": Type.Object(
    { path: Type.String({ maxLength: 4096 }), invocationId: Type.Optional(Id) },
    { additionalProperties: false },
  ),
  "botNode/fileWriteText": Type.Object(
    {
      path: Type.String({ maxLength: 4096 }),
      content: Type.String({ maxLength: 524288 }),
      invocationId: Type.Optional(Id),
    },
    { additionalProperties: false },
  ),
});
export const BOT_NODE_WIRE_OPERATIONS = Object.keys(BOT_NODE_SCHEMAS);
