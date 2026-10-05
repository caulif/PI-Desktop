import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { writePluginTextAtomically } = await import("../electron/main/plugin-atomic-write.ts");

test("failed staged write preserves the prior plugin output", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-plugin-atomic-write-"));
  const target = join(dir, "result.md");
  writeFileSync(target, "previous complete content", "utf8");
  assert.throws(() => writePluginTextAtomically(target, "replacement", (temporary) => {
    writeFileSync(temporary, "partial", "utf8");
    throw new Error("interrupted stage");
  }), /interrupted stage/);
  assert.equal(readFileSync(target, "utf8"), "previous complete content");
  assert.deepEqual(readdirSync(dir), ["result.md"]);
  writePluginTextAtomically(target, "replacement");
  assert.equal(readFileSync(target, "utf8"), "replacement");
  assert.deepEqual(readdirSync(dir), ["result.md"]);
});

test("process termination during staging leaves the published file intact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-plugin-interrupted-write-"));
  const target = join(dir, "result.md");
  writeFileSync(target, "previous complete content", "utf8");
  const script = `
    import { register } from "node:module";
    import { writeFileSync } from "node:fs";
    register(process.argv[2]);
    const { writePluginTextAtomically } = await import(process.argv[3]);
    writePluginTextAtomically(process.argv[1], "replacement", (temporary) => {
      writeFileSync(temporary, "partial", "utf8");
      writeFileSync(1, "STAGED\\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    });
  `;
  const child = spawn(process.execPath, [
    "--input-type=module", "-e", script, target,
    new URL("./helpers/ts-import-hooks.mjs", import.meta.url).href,
    new URL("../electron/main/plugin-atomic-write.ts", import.meta.url).href,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("child did not stage the write")), 5000);
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`child exited before staging: ${code}`)));
      child.stdout.once("data", (data) => {
        clearTimeout(timeout);
        assert.match(data.toString(), /STAGED/);
        resolve();
      });
    });
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(readFileSync(target, "utf8"), "previous complete content");
    assert.equal(readdirSync(dir).filter((name) => name.endsWith(".tmp")).length, 1);
    writePluginTextAtomically(target, "replacement");
    assert.equal(readFileSync(target, "utf8"), "replacement");
  } finally {
    if (child.exitCode === null) child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
