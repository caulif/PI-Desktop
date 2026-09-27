import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HostProcess } from "./host-process";

/** Persist plugin unloads until host-core confirms that their plans are disabled. */
export class PluginScheduleDisableOutbox {
  private readonly path: string;
  private readonly tempPath: string;
  private pending: string[] = [];
  private readonly loaded: Promise<void>;
  private chain: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.path = join(dataDir, "plugin-schedule-disable-outbox.json");
    this.tempPath = `${this.path}.tmp`;
    this.loaded = this.load();
  }

  enqueue(pluginId: string, getHost: () => HostProcess | null): Promise<void> {
    return this.serial(async () => {
      await this.loaded;
      if (!this.pending.includes(pluginId)) {
        this.pending.push(pluginId);
        await this.persist();
      }
      const host = getHost();
      if (host?.isAvailable()) await this.drain(host);
    });
  }

  flush(host: HostProcess): Promise<void> {
    return this.serial(async () => {
      await this.loaded;
      await this.drain(host);
    });
  }

  private serial(work: () => Promise<void>): Promise<void> {
    const result = this.chain.then(work);
    this.chain = result.catch(() => undefined);
    return result;
  }

  private async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== "string" || !id || id.length > 256)) {
        throw new Error("invalid plugin schedule disable outbox");
      }
      this.pending = [...new Set(parsed)];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.tempPath, JSON.stringify(this.pending), "utf8");
    await rename(this.tempPath, this.path);
  }

  private async drain(host: HostProcess): Promise<void> {
    while (this.pending.length) {
      const pluginId = this.pending[0];
      await host.call("scheduled.pluginDisableAll", { pluginId });
      this.pending.shift();
      await this.persist();
    }
  }
}
