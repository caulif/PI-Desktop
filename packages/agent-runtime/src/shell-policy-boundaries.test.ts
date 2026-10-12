import { describe, expect, it } from "vitest";
import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, Type, type AssistantMessage } from "@earendil-works/pi-ai";
import { toolExecutionMode } from "./tool-execution-policy.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function message(names: string[]): AssistantMessage {
  return {
    role: "assistant",
    content: names.length > 0
      ? names.map((name, index) => ({ type: "toolCall" as const, id: `call-${index}`, name, arguments: {} }))
      : [{ type: "text", text: "Done" }],
    stopReason: names.length > 0 ? "toolUse" : "stop",
    timestamp: 1, api: "openai-completions", provider: "fixture", model: "fixture",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

function fixture(names: string[], execute: AgentTool["execute"]) {
  let request = 0;
  const events: AgentEvent[] = [];
  const agent = new Agent({
    initialState: { tools: [...new Set(names)].map((name): AgentTool => ({
      name, label: name, description: name, parameters: Type.Object({}),
      executionMode: toolExecutionMode(name), execute,
    })) },
    streamFn: async () => {
      const stream = createAssistantMessageEventStream();
      const reply = message(request++ === 0 ? names : []);
      stream.push({ type: "done", reason: reply.stopReason as "stop" | "toolUse", message: reply });
      return stream;
    },
  });
  agent.subscribe((event) => { events.push(event); });
  return { agent, events };
}

describe("shell policy boundaries through the real Pi loop", () => {
  it.each([
    ["Read", "Bash", "Read"],
    ["Write", "Bash", "Edit"],
  ])("preserves all source-order visibility around Bash: %s → %s → %s", async (...names) => {
    const entered = [deferred(), deferred(), deferred()];
    const release = [deferred(), deferred(), deferred()];
    const observations: string[] = [];
    let value = "before";
    const { agent, events } = fixture(names, async (id, _args, _signal, update) => {
      const index = Number(id.split("-")[1]);
      observations.push(`${id}:${value}`);
      entered[index].resolve();
      await release[index].promise;
      value = `after-${index}`;
      update?.({ content: [{ type: "text", text: `${id}:stream` }], details: { id } });
      return { content: [{ type: "text", text: `${id}:${value}` }], details: { id } };
    });
    const pending = agent.prompt("Run the ordered batch");
    try {
      await entered[0].promise;
      expect(observations).toEqual(["call-0:before"]);
      release[0].resolve();
      await entered[1].promise;
      expect(observations).toEqual(["call-0:before", "call-1:after-0"]);
      release[1].resolve();
      await entered[2].promise;
      expect(observations).toEqual(["call-0:before", "call-1:after-0", "call-2:after-1"]);
      release[2].resolve();
      await pending;
      expect(events.filter((event) => event.type === "tool_execution_update").map((event) => event.toolCallId))
        .toEqual(["call-0", "call-1", "call-2"]);
      expect(agent.state.messages.filter((entry) => entry.role === "toolResult").map((entry) => ({
        id: entry.toolCallId, name: entry.toolName, content: entry.content,
      }))).toEqual(names.map((name, index) => ({ id: `call-${index}`, name,
        content: [{ type: "text", text: `call-${index}:after-${index}` }],
      })));
    } finally {
      release.forEach((gate) => gate.resolve());
      await pending;
    }
  });

  it("waits for an aborted Bash to settle and never starts the following Read", async () => {
    const started = deferred();
    const cancelled = deferred();
    const cleanup = deferred();
    const calls: string[] = [];
    const { agent, events } = fixture(["Read", "Bash", "Read"], async (id, _args, signal) => {
      calls.push(id);
      if (id === "call-1") {
        started.resolve();
        await new Promise<void>((resolve) => {
          const abort = () => { cancelled.resolve(); resolve(); };
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
        // A process owner still has to drain its process after receiving Stop.
        await cleanup.promise;
        throw new Error("Shell stopped after cleanup");
      }
      return { content: [{ type: "text", text: id }], details: {} };
    });
    const pending = agent.prompt("Run a batch then stop");
    try {
      await started.promise;
      agent.abort();
      await cancelled.promise;
      expect(calls).toEqual(["call-0", "call-1"]);
      expect(events.some((event) => event.type === "agent_end")).toBe(false);
      cleanup.resolve();
      await pending;
      expect(calls).toEqual(["call-0", "call-1"]);
      expect(events.filter((event) => event.type === "tool_execution_end").map((event) => event.toolCallId))
        .toEqual(["call-0", "call-1"]);
      expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
    } finally {
      agent.abort();
      cleanup.resolve();
      await pending;
    }
  });
});
