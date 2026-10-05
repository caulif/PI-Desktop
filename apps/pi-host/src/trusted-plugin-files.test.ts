import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { ResolvedFsAccess } from "@pi-desktop/shared";
import { createTrustedFiles } from "./trusted-plugin-files.js";

const directoryLink = process.platform === "win32" ? "junction" : "dir";
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-canonical-files-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
function access(scope: string[]): ResolvedFsAccess {
  return {
    permissions: ["fs.read", "fs.write"],
    policy: {
      read: { root: "workspace", scope },
      write: { root: "workspace", scope },
    },
  };
}
test("actual contained directory aliases cannot expose protected files or create protected parents", async () => {
  await fixture(async (root) => {
    await mkdir(join(root, ".ssh"));
    await writeFile(join(root, ".ssh", "secret.txt"), "private");
    await symlink(join(root, ".ssh"), join(root, "public"), directoryLink);
    const files = createTrustedFiles([root], async () => root, access(["**"]));
    for (const read of [
      () => files.api.readText("public/secret.txt"),
      () => files.api.readRange("public/secret.txt", 0, 5),
      () => files.api.stat("public/secret.txt"),
      () => files.api.list("public"),
      () => files.api.readText("public/missing/deep.txt"),
    ]) {
      await expect(read()).rejects.toThrow("Protected file path");
    }
    await expect(
      files.api.writeText("public/new/deep.txt", "leak"),
    ).rejects.toThrow("Protected file path");
    await expect(stat(join(root, ".ssh", "new"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(root, ".ssh", "secret.txt"), "utf8")).toBe(
      "private",
    );
  });
});
test("actual file symlinks cannot alias protected basenames", async (context) => {
  await fixture(async (root) => {
    await writeFile(join(root, ".env"), "private");
    try {
      await symlink(join(root, ".env"), join(root, "report.txt"), "file");
    } catch (error) {
      if (
        process.platform === "win32" &&
        (error as NodeJS.ErrnoException).code === "EPERM"
      ) {
        context.skip(
          true,
          "Windows token cannot create file symlinks; Linux runs the real boundary",
        );
        return;
      }
      throw error;
    }
    const files = createTrustedFiles([root], async () => root, access(["**"]));
    await expect(files.api.readText("report.txt")).rejects.toThrow(
      "Protected file path",
    );
    await expect(
      files.api.writeText("report.txt", "overwrite"),
    ).rejects.toThrow("Protected file path");
    expect(await readFile(join(root, ".env"), "utf8")).toBe("private");
    await mkdir(join(root, "private"));
    await writeFile(join(root, "private", "source.txt"), "scope");
    await symlink(
      join(root, "private", "source.txt"),
      join(root, "allowed.txt"),
      "file",
    );
    const scoped = createTrustedFiles(
      [root],
      async () => root,
      access(["allowed.txt"]),
    );
    await expect(scoped.api.readText("allowed.txt")).rejects.toThrow(
      "declared plugin scope",
    );
    await expect(
      scoped.api.writeText("allowed.txt", "overwrite"),
    ).rejects.toThrow("declared plugin scope");
    expect(await readFile(join(root, "private", "source.txt"), "utf8")).toBe(
      "scope",
    );
  });
});
test("canonical scope rejects existing and missing alias paths before any directory creation", async () => {
  await fixture(async (root) => {
    await mkdir(join(root, "outside-scope"));
    await writeFile(join(root, "outside-scope", "existing.txt"), "original");
    await symlink(
      join(root, "outside-scope"),
      join(root, "allowed"),
      directoryLink,
    );
    const files = createTrustedFiles(
      [root],
      async () => root,
      access(["allowed/**"]),
    );
    await expect(files.api.readText("allowed/existing.txt")).rejects.toThrow(
      "declared plugin scope",
    );
    await expect(
      files.api.readText("allowed/missing/file.txt"),
    ).rejects.toThrow("declared plugin scope");
    await expect(
      files.api.writeText("allowed/new/file.txt", "overwrite"),
    ).rejects.toThrow("declared plugin scope");
    await expect(
      stat(join(root, "outside-scope", "new")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
test("a registered workspace alias cannot hide a protected root", async () => {
  await fixture(async (root) => {
    await mkdir(join(root, ".ssh"));
    await writeFile(join(root, ".ssh", "secret.txt"), "private");
    const alias = join(root, "workspace");
    await symlink(join(root, ".ssh"), alias, directoryLink);
    const files = createTrustedFiles(
      [alias],
      async () => alias,
      access(["**"]),
    );
    await expect(files.api.readText("secret.txt")).rejects.toThrow(
      "Protected file path",
    );
    await expect(files.api.writeText("new/file.txt", "leak")).rejects.toThrow(
      "Protected file path",
    );
  });
});
test("contained aliases allowed by both lexical and canonical scopes retain normal reads and new writes", async () => {
  await fixture(async (root) => {
    await mkdir(join(root, "actual"));
    await symlink(join(root, "actual"), join(root, "alias"), directoryLink);
    const files = createTrustedFiles(
      [root],
      async () => root,
      access(["actual/**", "alias/**"]),
    );
    await files.api.writeText("alias/new/report.txt", "allowed");
    expect(await files.api.readText("alias/new/report.txt")).toBe("allowed");
    expect(
      await readFile(join(root, "actual", "new", "report.txt"), "utf8"),
    ).toBe("allowed");
    await expect(files.api.readText("alias/missing.txt")).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });
});
