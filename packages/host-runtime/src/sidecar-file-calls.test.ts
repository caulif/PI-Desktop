import { afterEach, expect, it } from "vitest";
import { AgentSidecar, type SidecarHostLink } from "./agent-sidecar.js";

// Exercise the real receiver over stdio, rather than calling Host directly.
const child = `const rl=require('node:readline').createInterface({input:process.stdin});
const pending=new Map(); rl.on('line',line=>{const m=JSON.parse(line);
if(m.method==='probe'){pending.set('r'+m.id,m.id);console.log(JSON.stringify({id:'r'+m.id,method:'host.proxy',params:m.params}));}
else if(pending.has(m.id)){console.log(JSON.stringify({...m,id:pending.get(m.id)}));pending.delete(m.id);}});`;
const sidecars: AgentSidecar[] = [];
afterEach(async () => {
  await Promise.all(sidecars.splice(0).map((sidecar) => sidecar.dispose()));
});

function harness() {
  const forwarded: Array<{ method: string; params: unknown }> = [];
  const sidecar = new AgentSidecar({
    launch: { command: process.execPath, args: ["-e", child] },
    onStderr: () => {},
  });
  sidecars.push(sidecar);
  const host: SidecarHostLink = {
    async call<T>(method: string, params: unknown): Promise<T> {
      forwarded.push({ method, params });
      if (method === "tools.prepareFileCall") return { ticket: "host-ticket" } as T;
      return { ok: true } as T;
    },
    onNotification: () => () => {},
    onExit: () => () => {},
  };
  sidecar.setHost(host);
  return { forwarded, proxy: (method: string, params: unknown) => sidecar.call("probe", { method, params }) };
}

it("forwards file preparation and owner-scoped cancellation without changing arguments", async () => {
  const { forwarded, proxy } = harness();
  const preparation = { sessionId: "s", toolCallId: "read", toolName: "Read", args: { path: "file.txt" } };
  await expect(proxy("tools.prepareFileCall", preparation)).resolves.toEqual({ ticket: "host-ticket" });
  const cancellation = { sessionId: "s", toolCallIds: ["read"] };
  await expect(proxy("tools.cancelPreparedFileCalls", cancellation)).resolves.toEqual({ ok: true });
  expect(forwarded).toEqual([
    { method: "tools.prepareFileCall", params: preparation },
    { method: "tools.cancelPreparedFileCalls", params: cancellation },
  ]);
});

it.each(["secrets.getForRuntime", "providers.getSecret", "settings.set", "tools.prepareFileCall.extra"])(
  "still rejects %s before reaching Host",
  async (method) => {
    const { forwarded, proxy } = harness();
    await expect(proxy(method, {})).rejects.toMatchObject({ code: -32601 });
    expect(forwarded).toEqual([]);
  },
);
