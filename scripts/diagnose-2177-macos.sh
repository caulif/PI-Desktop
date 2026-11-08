#!/usr/bin/env bash
# Run on a Mac: bash diagnose-2177-macos.sh /path/to/PI-Desktop [commit]
set -euo pipefail
[[ "$(uname -s)" == Darwin ]] || { echo "Requires macOS" >&2; exit 2; }
repo=$(git -C "${1:?supply the local PI-Desktop checkout}" rev-parse --show-toplevel)
rev=$(git -C "$repo" rev-parse --verify "${2:-HEAD}^{commit}")
scratch=$(mktemp -d "${TMPDIR:-/tmp}/pi-2177.XXXXXX")
printf 'Commit %s\nLogs and isolated sources: %s\n' "$rev" "$scratch"
mkdir "$scratch/src"
git -C "$repo" archive "$rev" | tar -xf - -C "$scratch/src"
cd "$scratch/src"
sw_vers
export CARGO_TARGET_DIR="$PWD/target"
export PI_DESKTOP_HOST_BIN="$CARGO_TARGET_DIR/debug/pi-desktop-host-core"
pnpm install --frozen-lockfile
pnpm --filter @pi-desktop/agent-runtime... build
cargo build -p host-core --locked
if node scripts/e2e-session-background-jobs.mjs > "$scratch/original.log" 2>&1; then
  echo "Original E2E passed."
  exit 0
fi
cat "$scratch/original.log"
echo "Original E2E failed. Rebuilding with temporary trace output."
python3 - <<'PY'
from pathlib import Path
def replace_once(path, before, after):
    p = Path(path)
    text = p.read_text()
    if text.count(before) != 1:
        raise SystemExit(f"Unexpected source in {path}: {before}")
    p.write_text(text.replace(before, after))

jobs = "crates/host-core/src/background_tasks.rs"
for anchor, stage in [("exit = Some(waited);", "child-wait-returned"), ("stopping = true;", "stop-received")]:
    replace_once(jobs, anchor, anchor + f'\n                    eprintln!("group-trace {stage} pgid={{}}", runner.pid);')

tools = "crates/host-core/src/tools/mod.rs"
call = "let result = unsafe { libc::killpg(pid as libc::pid_t, libc::SIGKILL) };"
replace_once(tools, call, call + '\n        if result == 0 { eprintln!("group-trace kill pgid={pid} ok"); }')
check = "if error.raw_os_error() == Some(libc::ESRCH)"
replace_once(tools, check, '''eprintln!("group-trace kill pgid={pid} errno={:?}", error.raw_os_error());
        if error.raw_os_error() == Some(libc::EPERM) {
            for delay_ms in [0, 50, 200, 750] {
                std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                let result = unsafe { libc::killpg(pid as libc::pid_t, 0) };
                let errno = if result == 0 { None } else { io::Error::last_os_error().raw_os_error() };
                eprintln!("group-trace probe pgid={pid} result={result} errno={errno:?}");
                match std::process::Command::new("/bin/ps").args(["-axo", "pid=,ppid=,pgid=,uid=,stat="]).output() {
                    Ok(out) if out.status.success() => {
                        for row in String::from_utf8_lossy(&out.stdout).lines() {
                            if row.split_whitespace().nth(2).and_then(|s| s.parse::<u32>().ok()) == Some(pid) {
                                eprintln!("group-trace member(pid ppid pgid uid stat): {row}");
                            }
                        }
                    }
                    _ => eprintln!("group-trace ps unavailable"),
                }
                if errno == Some(libc::ESRCH) { break; }
            }
        }
        ''' + check)
replace_once("scripts/e2e-session-background-jobs.mjs", "quiet: true", "quiet: false")
PY
cargo build -p host-core --locked
trace_rc=0
DEBUG_HOST=1 node scripts/e2e-session-background-jobs.mjs > "$scratch/trace.log" 2>&1 || trace_rc=$?
grep -E 'group-trace|exit cleanup failed|background task stop failed|ERR_ASSERTION' "$scratch/trace.log" || true
printf 'Original E2E failed; instrumented rerun exit=%s. Full logs: %s\n' "$trace_rc" "$scratch"
exit 1
