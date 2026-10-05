import { readFile } from "node:fs/promises";
import { startPiHost, type PiHostApp } from "./app.js";
import type { PiHostConfig } from "./config.js";
import type { TrustedPluginConfig } from "./trusted-plugin.js";
import { RacpClient, wsClientTransport } from "@pi-desktop/racp";
import { APP_VERSION } from "@pi-desktop/shared";
import { validateBotNodeEndpoint } from "./remote-plugin.js";
import { prepareStandaloneOutput, requireStandalonePrivate, writeStandalonePrivate } from "./bot-node-private-files.js";

/** Starts only execution services. It never instantiates a second Bot writer. */
export async function startBotNode(input: {
  host: PiHostConfig;
  plugin: TrustedPluginConfig;
  pairingTicketFile?: string;
}): Promise<PiHostApp> {
  if (input.pairingTicketFile) await prepareStandaloneOutput(input.pairingTicketFile);
  const app = await startPiHost(input.host, { trustedPlugin: input.plugin });
  if (input.pairingTicketFile) {
    try {
      const ticket = await app.issuePairingToken(input.host.pairingLifetimeMs);
      await writeStandalonePrivate(input.pairingTicketFile, ticket.token + "\n");
    } catch (error) {
      await app.stop();
      throw error;
    }
  }
  return app;
}

/** Owner bootstrap over the existing authenticated RACP pairing flow. */
export async function pairRemoteBotNode(input: {
  url: string;
  pairingTicketFile: string;
  deviceTokenFile: string;
  expectedHostId?: string;
  deviceLabel?: string;
}) {
  validateBotNodeEndpoint(input.url);
  await requireStandalonePrivate(input.pairingTicketFile);
  await prepareStandaloneOutput(input.deviceTokenFile);
  const text = (await readFile(input.pairingTicketFile, "utf8")).trim();
  const token = text.startsWith("{") ? String(JSON.parse(text).token) : text;
  const result = await pairBotNode({
    url: input.url,
    pairingToken: token,
    expectedHostId: input.expectedHostId,
    deviceLabel: input.deviceLabel,
  });
  await writeStandalonePrivate(input.deviceTokenFile, result.deviceToken + "\n");
  return { hostId: result.hostId, deviceId: result.deviceId };
}

export async function pairBotNode(input: {
  url: string;
  pairingToken: string;
  expectedHostId?: string;
  deviceLabel?: string;
}) {
  validateBotNodeEndpoint(input.url);
  const token = input.pairingToken;
  const client = new RacpClient({
    transport: wsClientTransport({ url: input.url, token }),
    client: { name: "pi-bot-central-bootstrap", version: APP_VERSION },
    reconnect: { enabled: false },
  });
  try {
    const initialized = await client.connect();
    const hostId = initialized.server.hostId;
    if (!hostId || (input.expectedHostId && hostId !== input.expectedHostId))
      throw Object.assign(new Error("Remote Host identity does not match"), {
        errorCode: "REMOTE_AUTH_FAILED",
      });
    const result = await client.request<{
      deviceId: string;
      deviceToken: string;
    }>("connection/pair", {
      deviceLabel: input.deviceLabel ?? "pi-bot-central",
    });
    return {
      hostId,
      deviceId: result.deviceId,
      deviceToken: result.deviceToken,
    };
  } finally {
    client.close();
  }
}
