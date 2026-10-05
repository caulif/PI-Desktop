import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lstat, mkdir, open } from "node:fs/promises";
import { prepareStandaloneOutput, requireStandalonePrivate, writeStandalonePrivate } from "./bot-node-private-files.js";

vi.mock("node:fs/promises", () => ({ lstat: vi.fn(), mkdir: vi.fn(), open: vi.fn() }));
const originalPlatform = process.platform;
const originalGetuid = process.getuid;
const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
const info = (directory = false, overrides: Record<string, unknown> = {}) => ({
  uid: 123, mode: directory ? 0o700 : 0o600,
  isDirectory: () => directory, isFile: () => !directory, isSymbolicLink: () => false,
  ...overrides,
});
beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  process.getuid = () => 123;
});
afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  process.getuid = originalGetuid;
});
describe("standalone credential boundary", () => {
  it("rejects Windows before reading or creating credential files", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    await expect(requireStandalonePrivate("ticket")).rejects.toMatchObject({ errorCode: "PERMISSION_DENIED" });
    await expect(prepareStandaloneOutput("private/token")).rejects.toMatchObject({ errorCode: "PERMISSION_DENIED" });
    expect(lstat).not.toHaveBeenCalled(); expect(mkdir).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
  });
  it.each([
    ["shared access", { mode: 0o644 }],
    ["another owner", { uid: 456 }],
    ["symlink", { isSymbolicLink: () => true }],
    ["special file", { isFile: () => false }],
  ])("rejects %s input", async (_name, overrides) => {
    vi.mocked(lstat).mockResolvedValue(info(false, overrides) as never);
    await expect(requireStandalonePrivate("ticket")).rejects.toMatchObject({ errorCode: "PERMISSION_DENIED" });
  });
  it("does not alter an existing shared output parent", async () => {
    vi.mocked(lstat).mockResolvedValue(info(true, { mode: 0o755 }) as never);
    await expect(prepareStandaloneOutput("private/token")).rejects.toMatchObject({ errorCode: "PERMISSION_DENIED" });
    expect(mkdir).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
  });
  it("creates only a dedicated new owner-only parent and refuses overwrite", async () => {
    vi.mocked(lstat).mockRejectedValueOnce(missing()).mockResolvedValueOnce(info(true) as never).mockRejectedValueOnce(missing());
    await prepareStandaloneOutput("private/token");
    expect(mkdir).toHaveBeenCalledExactlyOnceWith("private", { mode: 0o700 });
    vi.mocked(lstat).mockResolvedValueOnce(info(true) as never).mockResolvedValueOnce(info() as never);
    await expect(prepareStandaloneOutput("private/token")).rejects.toMatchObject({ errorCode: "PERMISSION_DENIED" });
  });
  it("claims output exclusively with mode 600 and syncs before closing", async () => {
    vi.mocked(lstat).mockResolvedValue(info(true) as never);
    const handle = { writeFile: vi.fn(), sync: vi.fn(), close: vi.fn() };
    vi.mocked(open).mockResolvedValue(handle as never);
    await writeStandalonePrivate("private/token", "test credential");
    expect(open).toHaveBeenCalledExactlyOnceWith("private/token", "wx", 0o600);
    expect(handle.writeFile).toHaveBeenCalledWith("test credential", "utf8");
    expect(handle.sync).toHaveBeenCalledOnce(); expect(handle.close).toHaveBeenCalledOnce();
  });
});
