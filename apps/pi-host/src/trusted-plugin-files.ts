import { constants } from "node:fs";
import { isDeniedFsPath, matchFsGlob, type ResolvedFsAccess } from "@pi-desktop/shared";
import { open, realpath, mkdir, readdir, stat, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
const fail = (message: string): never => { throw Object.assign(new Error(message), { code: "PERMISSION_DENIED", errorCode: "PERMISSION_DENIED" }); };
const within = (root: string, path: string) => { const rel = relative(root, path); return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep)); };
/** Registered roots and canonical parents prevent symlink and traversal escapes. */
export function createTrustedFiles(roots: readonly string[], getRoot: () => Promise<string>, access?: ResolvedFsAccess) {
    const checkRoot = async (path: string) => { const canonical = await realpath(path); const allowed = await Promise.all(roots.map(r => realpath(r))); if (!allowed.some(root => within(root, canonical)))
        fail("Project is outside the registered roots"); return canonical; };
    const locate = async (path: string, write = false) => {
        if (typeof path !== "string" || isAbsolute(path) || path.split(/[\\/]/).includes(".."))
            fail("Relative workspace path required");
        if(isDeniedFsPath(path))fail("Protected file path");
        if(access){const mode=write?"write":"read";const rule=access.policy[mode];if(!access.permissions.includes("fs."+mode)||rule?.root!=="workspace"||!rule.scope.some(pattern=>matchFsGlob(path,pattern)))fail("File is outside the declared plugin scope");}
        const root = await checkRoot(await getRoot());
        const candidate = resolve(root, path);
        if (!within(root, candidate))
            fail("Path leaves project root");
        let canonical: string;
        try {
            canonical = await realpath(candidate);
        }
        catch (error) {
            if (!write || (error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
            let ancestor=dirname(candidate);
            while(true){try{const real=await realpath(ancestor);if(!within(root,real))fail("Write parent leaves project root");break;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;const parent=dirname(ancestor);if(parent===ancestor)throw error;ancestor=parent;}}
            await mkdir(dirname(candidate),{recursive:true});
            canonical = resolve(await realpath(dirname(candidate)), candidate.split(/[\\/]/).at(-1)!);
        }
        if (!within(root, canonical))
            fail("Symlink leaves project root");
        return canonical;
    };
    const read = async (path: string, offset = 0, length = 524288) => { if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 0 || length > 524288)
        fail("Invalid bounded file range"); const target = await locate(path); const handle = await open(target, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)); try {
        const before = await handle.stat();
        const root=await checkRoot(await getRoot());
        const current=await realpath(target);const currentStat=await stat(current);
        if(!within(root,current)||currentStat.dev!==before.dev||currentStat.ino!==before.ino||before.nlink>1)fail("File identity changed before read");
        if (!before.isFile())
            fail("Not a regular file");
        const bytes = Buffer.alloc(Math.min(length, Math.max(0, before.size - offset)));
        const result = await handle.read(bytes, 0, bytes.length, offset);
        const after = await handle.stat();
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
            fail("File changed during read");
        return { bytes: new Uint8Array(bytes.subarray(0, result.bytesRead)), totalSize: after.size };
    }
    finally {
        await handle.close();
    } };
    return { checkRoot, read, api: { readText: async (path: string) => { const r = await read(path); if (r.totalSize > 524288)
                fail("File exceeds text read limit"); return new TextDecoder("utf-8", { fatal: true }).decode(r.bytes); }, stat: async (path: string) => ({ size: (await stat(await locate(path))).size }), readRange: read, list: async (path: string) => { const target = await locate(path); const entries = await readdir(target, { withFileTypes: true }); if (entries.length > 1000)
                fail("Directory listing exceeds limit"); return entries.filter(e => !e.isSymbolicLink() && !isDeniedFsPath(path?path+"/"+e.name:e.name)).map(e => ({ name: e.name, path: path ? path + "/" + e.name : e.name, isDirectory: e.isDirectory() })); }, writeText: async (path: string, content: string) => { if (Buffer.byteLength(content) > 524288)
                fail("File exceeds write limit"); const target = await locate(path, true); const parent=await open(dirname(target),constants.O_RDONLY | (process.platform==="win32"?0:constants.O_DIRECTORY|constants.O_NOFOLLOW));
        const identity=await parent.stat();const canonicalParent=await realpath(dirname(target));const actualParent=await stat(canonicalParent);const root=await checkRoot(await getRoot());if(!within(root,canonicalParent)||identity.dev!==actualParent.dev||identity.ino!==actualParent.ino){await parent.close();fail("Write parent identity changed");}
        const anchored=process.platform==="linux"?"/proc/self/fd/"+parent.fd:canonicalParent;
        const filename=target.split(/[\\/]/).at(-1)!;const temporary=resolve(anchored,".pi-write-"+randomUUID());const destination=resolve(anchored,filename);
        try {const h=await open(temporary,"wx",0o600);try{const opened=await h.stat();const pathStat=await stat(temporary);const parentNow=await stat(canonicalParent);if(opened.ino!==pathStat.ino||opened.dev!==pathStat.dev||identity.ino!==parentNow.ino||identity.dev!==parentNow.dev)fail("Write path identity changed");await h.writeFile(content,"utf8");await h.sync();}finally{await h.close();}
        if(process.platform!=="linux"){const parentNow=await stat(await realpath(dirname(target)));if(parentNow.ino!==identity.ino||parentNow.dev!==identity.dev)fail("Write parent identity changed");}
        await rename(temporary,destination);
        }finally{await unlink(temporary).catch(error=>{if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;});await parent.close();}
    }, openDefault: async () => fail("Native file opening is unavailable; use the authenticated download route") } };
}
