import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { FileCredentialStore, loadOrCreateHostId } from "./credentials.js";

test("invalid private JSON never exposes its content through errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-private-json-"));
  try {
    await mkdir(join(root, "pi-host"));
    const marker = "dummy-private-token-marker";
    for (const name of ["identity.json", "credentials.json"]) {
      await writeFile(join(root, "pi-host", name), `${marker} invalid`);
    }
    for (const read of [() => loadOrCreateHostId(root), () => new FileCredentialStore(root).listDevices()]) {
      await expect(read()).rejects.toThrow(/^Private Host credential JSON is invalid$/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing private files still bootstrap", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-private-json-"));
  try {
    expect(await loadOrCreateHostId(root)).toMatch(/^host_/);
    expect(await new FileCredentialStore(root).listDevices()).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
