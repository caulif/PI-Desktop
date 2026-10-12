//! Host-owned file access plans. This is coordination, not an OS sandbox.
use crate::tools::hashline::parse::{parse_ops, ParsedOp};
use crate::{tool_budget::FileResource, workspace};
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FileAccessPlan {
    pub resources: Vec<FileResource>,
    paths: Vec<PathBuf>,
}

fn path_key(path: &Path) -> String {
    let key = path.to_string_lossy().into_owned();
    // Over-coordination on case-sensitive Windows directories is conservative.
    #[cfg(windows)]
    let key = key.to_lowercase();
    format!("path:{key}")
}

fn identity_key(path: &Path) -> Result<Option<String>, String> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.is_file() {
        return Ok(None);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        return Ok(Some(format!("inode:{}:{}", metadata.dev(), metadata.ino())));
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        return Ok(Some(format!(
            "file:{}:{}:{}",
            info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow
        )));
    }
    #[cfg(not(any(unix, windows)))]
    {
        Ok(None)
    }
}

impl FileAccessPlan {
    pub fn same_paths(&self, other: &Self) -> bool {
        self.paths == other.paths
    }

    pub fn for_tool(
        workspace: Option<&Path>,
        scratch: Option<&Path>,
        session_id: &str,
        tool: &str,
        args: &Value,
        external: bool,
    ) -> Result<Self, String> {
        if !matches!(tool, "Read" | "Write" | "Edit") {
            return Ok(Self::default());
        }
        let Some(root) = workspace else {
            return Ok(Self::default());
        };
        let Some(path) = args.get("path").and_then(Value::as_str) else {
            return Ok(Self::default());
        };
        let mut inputs = vec![path];
        let mut registers = false;
        if tool == "Edit" {
            if let Some(ops) = args.get("ops").and_then(Value::as_str) {
                let parsed = match parse_ops(ops) {
                    Ok(parsed) => parsed,
                    Err(_) => {
                        // Invalid syntax cannot mutate. Preserve the runner's
                        // structured Edit error instead of turning it into RPC failure.
                        let mut plan = Self::default();
                        plan.add_path(root, scratch, path, external, true)?;
                        plan.normalize();
                        return Ok(plan);
                    }
                };
                // Keep owned destinations until paths have been resolved.
                let mut plan = Self::default();
                plan.add_path(root, scratch, path, external, true)?;
                for op in parsed.ops {
                    match op {
                        ParsedOp::Mv { dest } => {
                            plan.add_path(root, scratch, &dest, external, true)?
                        }
                        ParsedOp::Put {
                            register: Some(_), ..
                        }
                        | ParsedOp::Cut {
                            register: Some(_), ..
                        } => registers = true,
                        _ => (),
                    }
                }
                if registers {
                    plan.resources.push(FileResource {
                        key: format!("registers:{session_id}"),
                        exclusive: true,
                    });
                }
                plan.normalize();
                return Ok(plan);
            }
        }
        let mut plan = Self::default();
        for input in inputs.drain(..) {
            plan.add_path(root, scratch, input, external, tool != "Read")?;
        }
        plan.normalize();
        Ok(plan)
    }

    pub fn for_paths(paths: &[PathBuf]) -> Result<Self, String> {
        let mut plan = Self::default();
        for path in paths {
            plan.resources.push(FileResource {
                key: path_key(path),
                exclusive: true,
            });
            if let Some(key) = identity_key(path)? {
                plan.resources.push(FileResource {
                    key,
                    exclusive: true,
                });
            }
            plan.paths.push(path.clone());
        }
        plan.normalize();
        Ok(plan)
    }

    fn add_path(
        &mut self,
        root: &Path,
        scratch: Option<&Path>,
        input: &str,
        external: bool,
        exclusive: bool,
    ) -> Result<(), String> {
        let (path, _) = workspace::resolve_tool_path_with_external(root, scratch, input, external)?;
        self.resources.push(FileResource {
            key: path_key(&path),
            exclusive,
        });
        if let Some(key) = identity_key(&path)? {
            self.resources.push(FileResource { key, exclusive });
        }
        self.paths.push(path);
        Ok(())
    }

    fn normalize(&mut self) {
        self.resources.sort_by(|a, b| a.key.cmp(&b.key));
        self.resources.dedup_by(|a, b| {
            if a.key == b.key {
                b.exclusive |= a.exclusive;
                true
            } else {
                false
            }
        });
        self.paths.sort();
        self.paths.dedup();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    fn plan(root: &Path, tool: &str, args: Value) -> FileAccessPlan {
        FileAccessPlan::for_tool(Some(root), None, "session", tool, &args, false).unwrap()
    }

    #[test]
    fn canonical_path_aliases_and_missing_leaf_have_same_identity() {
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("a"), "original").unwrap();
        let relative = plan(dir.path(), "Write", json!({"path":"a"}));
        let absolute = plan(
            dir.path(),
            "Write",
            json!({"path":dir.path().join("sub/../a")}),
        );
        assert_eq!(relative, absolute);
        assert_eq!(
            plan(dir.path(), "Write", json!({"path":"new/deep/file"})),
            plan(dir.path(), "Write", json!({"path":"sub/../new/deep/file"}))
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a")).unwrap(),
            "original"
        );
        assert!(!dir.path().join("new").exists());
    }

    #[test]
    fn hardlinks_share_identity_and_replacement_changes_plan() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("a"), "original").unwrap();
        std::fs::hard_link(dir.path().join("a"), dir.path().join("alias")).unwrap();
        let first = plan(dir.path(), "Write", json!({"path":"a"}));
        let alias = plan(dir.path(), "Read", json!({"path":"alias"}));
        assert!(first.resources.iter().any(|a| alias
            .resources
            .iter()
            .any(|b| a.key == b.key && !a.key.starts_with("path:"))));
        std::fs::remove_file(dir.path().join("a")).unwrap();
        std::fs::write(dir.path().join("a"), "new").unwrap();
        assert_ne!(first, plan(dir.path(), "Write", json!({"path":"a"})));
    }

    #[test]
    fn edit_move_and_registers_include_all_resources_without_mutation() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("a"), "original").unwrap();
        let access = plan(
            dir.path(),
            "Edit",
            json!({"path":"a", "ops":"CUT 1.=1 @saved\nMV b\n"}),
        );
        assert!(access
            .resources
            .iter()
            .any(|r| r.key == "registers:session"));
        assert_eq!(access.paths.len(), 2);
        assert!(access.resources.iter().all(|r| r.exclusive));
        let ordinary = plan(dir.path(), "Edit", json!({"path":"a", "ops":"REM\n"}));
        assert!(!ordinary
            .resources
            .iter()
            .any(|r| r.key.starts_with("registers:")));
        assert!(!dir.path().join("b").exists());
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a")).unwrap(),
            "original"
        );
    }

    #[test]
    fn external_resolution_requires_explicit_permission_and_searches_have_no_tree_lock() {
        let dir = tempdir().unwrap();
        let external = tempdir().unwrap();
        let args = json!({"path": external.path().join("outside")});
        assert!(
            FileAccessPlan::for_tool(Some(dir.path()), None, "s", "Write", &args, false).is_err()
        );
        assert!(
            FileAccessPlan::for_tool(Some(dir.path()), None, "s", "Write", &args, true).is_ok()
        );
        for tool in ["Glob", "Grep", "Bash"] {
            assert!(plan(dir.path(), tool, json!({"path":"."}))
                .resources
                .is_empty());
        }
    }

    #[cfg(unix)]
    #[test]
    fn permission_denied_identity_lookup_fails_closed_instead_of_becoming_missing() {
        use std::os::unix::fs::PermissionsExt;
        // Root bypasses the directory permission fixture. The regression runs
        // on ordinary Unix CI users; Windows needs its own ACL fixture.
        if unsafe { libc::geteuid() } == 0 {
            eprintln!("permission fixture requires a non-root Unix user");
            return;
        }
        let dir = tempdir().unwrap();
        let private = dir.path().join("private");
        std::fs::create_dir(&private).unwrap();
        std::fs::write(private.join("existing"), "original").unwrap();
        std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o000)).unwrap();
        let metadata_result = std::fs::metadata(private.join("existing"));
        let access = FileAccessPlan::for_tool(
            Some(dir.path()),
            None,
            "session",
            "Write",
            &json!({"path":"private/existing"}),
            false,
        );
        std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(
            metadata_result.unwrap_err().kind(),
            std::io::ErrorKind::PermissionDenied
        );
        assert!(
            access.is_err(),
            "metadata denial must not silently omit the identity key"
        );
        assert_eq!(
            std::fs::read_to_string(private.join("existing")).unwrap(),
            "original"
        );
    }
}
