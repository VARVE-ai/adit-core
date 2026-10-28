/** All local commit projections use alias c. A second parent identifies a merge,
 * regardless of its subject; root and single-parent commits remain eligible.
 * Keep this read filter for facts collected before --no-merges was introduced.
 */
export const NON_MERGE_COMMIT_SQL = `NOT EXISTS (
  SELECT 1 FROM adit_local_commit_parents merge_parent
  WHERE merge_parent.repository=c.repository AND merge_parent.sha=c.sha
    AND merge_parent.ordinal>0
)`;
