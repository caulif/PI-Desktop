import { readFile } from "node:fs/promises";
import { startBotNode, pairRemoteBotNode } from "./bot-node-launch.js";
import { requireStandalonePrivate, requireStandalonePosix } from "./bot-node-private-files.js";

const [command, file] = process.argv.slice(2);
if (!file || !["start", "pair"].includes(command ?? "")) {
  process.stderr.write(
    "Usage: node bot-node.mjs start|pair <private-config.json>\n",
  );
  process.exitCode = 2;
} else {
  try {
    requireStandalonePosix();
    await requireStandalonePrivate(file);
    const config = JSON.parse(await readFile(file, "utf8"));
    if (command === "pair") {
      const result = await pairRemoteBotNode(config);
      process.stdout.write(JSON.stringify(result) + "\n");
    } else {
      const app = await startBotNode(config);
      process.stdout.write(
        JSON.stringify({
          hostId: app.hostId,
          address: app.address,
          botNode: true,
        }) + "\n",
      );
      let stopping = false;
      const stop = async () => {
        if (stopping) return;
        stopping = true;
        await app.stop();
      };
      process.once("SIGINT", () => {
        void stop();
      });
      process.once("SIGTERM", () => {
        void stop();
      });
    }
  } catch (error) {
    // Configuration or provider values must never enter launch logs.
    process.stderr.write(
      "Bot node failed: " +
        String(
          (error as { errorCode?: string }).errorCode ?? "BOOTSTRAP_FAILED",
        ) +
        "\n",
    );
    process.exitCode = 1;
  }
}
