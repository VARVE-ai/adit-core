/**
 * @varveai/adit-engine — Git operations and working tree detection.
 */

// Git operations
export {
  runGit,
  runGitOrThrow,
  getHeadSha,
  getCurrentBranch,
  getRemoteUrl,
  isGitRepo,
  branchExists,
  shaExists,
  type GitResult,
  type GitRunOptions,
} from "./git/runner.js";

export {
  resolveCheckpointRef,
  deleteCheckpointRef,
  listCheckpointRefs,
  getParentSha,
} from "./git/refs.js";

// Working tree detection
export {
  getChangedFiles,
  hasUncommittedChanges,
  getNumstat,
  getChangesSummary,
  isDirtyFrom,
  type FileChange,
  type NumstatEntry,
} from "./detector/working-tree.js";
