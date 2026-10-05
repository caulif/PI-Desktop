import { lstat, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

const reject = (message: string): never => {
  throw Object.assign(new Error(message), { errorCode: "PERMISSION_DENIED" });
};

/** This optional standalone bootstrap is POSIX only. The managed pi-bot CLI
 * has a separate verified Windows DACL implementation; modes are not DACLs. */
export function requireStandalonePosix(): void {
  if (process.platform === "win32" || !process.getuid)
    reject("Standalone credential files require POSIX; use the managed pi-bot service CLI on Windows.");
}

export async function requireStandalonePrivate(path: string, directory = false): Promise<void> {
  requireStandalonePosix();
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) ||
      info.uid !== process.getuid!() || (info.mode & 0o077) !== 0)
    reject("Standalone credential paths must be regular, owner-only paths.");
}

/** Validate before network pairing or creating a Host. Existing shared parents
 * are never chmodded. Only one new dedicated parent may be created. */
export async function prepareStandaloneOutput(path: string): Promise<void> {
  requireStandalonePosix();
  const parent = dirname(path);
  try { await requireStandalonePrivate(parent, true); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(parent, { mode: 0o700 });
    await requireStandalonePrivate(parent, true);
  }
  try { await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  reject("Standalone credential output must be a new file.");
}

export async function writeStandalonePrivate(path: string, contents: string): Promise<void> {
  await requireStandalonePrivate(dirname(path), true);
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(contents, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
}
