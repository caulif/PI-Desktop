export {
  PLUGIN_FS_MODES,
  FS_DENY_DIR_SEGMENTS,
  FS_DENY_FILE_PATTERNS,
  normalizeFsPath,
  isDeniedFsPath,
  fsGlobIgnoresCase,
  matchFsGlob,
  isFsPathInScope,
  isWholeTreePattern,
  parseFsPolicy,
  LEGACY_FS_PERMISSIONS,
  resolveFsAccess,
} from "@pi-desktop/shared";
export type {
  PluginFsRoot,
  PluginFsMode,
  ResolvedPluginFsRule as PluginFsRule,
  ResolvedPluginFsPolicy as PluginFsPolicy,
  MatchFsGlobOptions,
  ResolvedFsAccess,
} from "@pi-desktop/shared";
