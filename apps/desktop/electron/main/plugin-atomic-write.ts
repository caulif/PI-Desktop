import { closeSync, existsSync, fsyncSync, openSync, renameSync, statSync,
  unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

type StageWriter = (path: string, content: string, mode: number) => void;

const writeStage: StageWriter = (path, content, mode) => {
  const fd = openSync(path, "wx", mode);
  try {
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

/** Replace a plugin output only after its complete contents reach disk. */
export function writePluginTextAtomically(
  target: string,
  content: string,
  stage: StageWriter = writeStage,
): void {
  const temporary = join(dirname(target), `.pi-desktop-${randomUUID()}.tmp`);
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o666;
  try {
    stage(temporary, content, mode);
    renameSync(temporary, target);
  } catch (error) {
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      // Preserve the write failure; a leftover temporary file never replaces the prior output.
    }
    throw error;
  }
}
