/**
 * Hard size caps for file-mutation capture and sync.
 *
 * Mirrors the limits in agent-file-mutation-capture-plan.md.
 *
 * These are intentionally defined in one place so Claude and Codex extractors
 * stay aligned. Keep changes here, not in extractor files.
 */

/**
 * Source file size above which we skip diff generation entirely.
 * Applies to either the original or new file content when available.
 */
export const MAX_FILE_BYTES = 512 * 1024;

/**
 * Diff body size for a single file above which we drop the diff body but
 * keep path/stat metadata in diff_stat_json.
 */
export const MAX_FILE_DIFF_BYTES = 128 * 1024;

/**
 * Total diff_text size for one event above which subsequent mutations are
 * truncated out of diffs.diff_text (their stats still land in diff_stat_json).
 */
export const MAX_EVENT_DIFF_BYTES = 512 * 1024;

/**
 * Cloud sync payload byte cap. The sync serializer must keep the total
 * diff_text payload under this limit, dropping excess rather than pushing
 * huge payloads to the server.
 */
export const MAX_SYNC_DIFF_BYTES = 2 * 1024 * 1024;
