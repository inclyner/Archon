/**
 * Group-substitution variables: $GROUP, $GROUP_DIR, $REPOS, $REPO_<NAME>_DIR.
 *
 * These are pre-substituted into the workflow definition before it reaches
 * the DAG executor — bash, script, and prompt nodes all see the resolved
 * strings uniformly. This avoids threading a new context object through
 * every substitution call site.
 *
 * When `applyGroupSubstitutions` is called without a context (or with an
 * undefined context), the variables are replaced with empty strings — same
 * convention as the engine's other optional vars ($LOOP_USER_INPUT etc).
 */

import type { DagNode } from '../schemas/dag-node';
import type { WorkflowDefinition } from '../schemas/workflow';

export interface GroupSubstitutionContext {
  /** Group name (e.g. "my-platform"). */
  groupName: string;
  /** Absolute path to the group worktree on disk. */
  groupDir: string;
  /**
   * Members in stable order. `relativePath` is the subdirectory name under
   * groupDir; `memberDir` is the absolute path to that member's git worktree.
   */
  members: readonly { relativePath: string; memberDir: string }[];
}

/**
 * Sanitize a member's relative path into the SHELL-style suffix used for
 * `$REPO_<NAME>_DIR`. Uppercases, replaces every non-`[A-Z0-9_]` with `_`.
 *
 * Example: `service-api` → `SERVICE_API`; `services/api` → `SERVICES_API`.
 */
export function sanitizeRepoVarSuffix(relativePath: string): string {
  return relativePath.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}

/**
 * Substitute the four group variables in `text`. When `ctx` is undefined,
 * all four expand to empty string.
 *
 * Replacement order matters: `$REPO_*_DIR` is replaced first (most specific),
 * then `$GROUP_DIR` / `$GROUP` / `$REPOS`. Order between `$GROUP_DIR` and
 * `$GROUP` matters because `$GROUP` is a prefix of `$GROUP_DIR`.
 */
export function applyGroupSubstitutions(text: string, ctx?: GroupSubstitutionContext): string {
  if (!ctx) {
    return text
      .replace(/\$REPO_[A-Z0-9_]+_DIR/g, '')
      .replace(/\$GROUP_DIR/g, '')
      .replace(/\$REPOS/g, '')
      .replace(/\$GROUP\b/g, '');
  }

  let result = text;

  // Per-member: $REPO_<NAME>_DIR → absolute member dir
  for (const member of ctx.members) {
    const suffix = sanitizeRepoVarSuffix(member.relativePath);
    const pattern = new RegExp(`\\$REPO_${suffix}_DIR`, 'g');
    result = result.replace(pattern, member.memberDir);
  }
  // Any remaining $REPO_*_DIR references match no member → empty string.
  result = result.replace(/\$REPO_[A-Z0-9_]+_DIR/g, '');

  result = result
    .replace(/\$GROUP_DIR/g, ctx.groupDir)
    .replace(/\$REPOS/g, ctx.members.map(m => m.memberDir).join('\n'))
    .replace(/\$GROUP\b/g, ctx.groupName);

  return result;
}

/**
 * Walk the substitutable string fields of a DAG node and apply group
 * substitutions. We only touch the fields users typically reference group
 * vars in: `prompt`, `script`, `command`, and `args`.
 *
 * Other string fields (e.g. `id`, `provider`, `model`) are left alone — they
 * shouldn't contain group vars and substituting them would invite confusion.
 */
function substituteGroupVarsInNode(node: DagNode, ctx?: GroupSubstitutionContext): DagNode {
  // Shallow clone is fine — we only mutate top-level string fields.
  const next: Record<string, unknown> = { ...node };
  // Bash nodes carry their script in `bash:` (not `script:`); script nodes use `script:`.
  // Both need substitution so $GROUP_DIR etc. land in the actual subprocess command.
  for (const key of ['prompt', 'bash', 'script', 'command'] as const) {
    const value = next[key];
    if (typeof value === 'string') {
      next[key] = applyGroupSubstitutions(value, ctx);
    }
  }
  // `args` may be a string (positional) or undefined. Keep simple.
  if (typeof next.args === 'string') {
    next.args = applyGroupSubstitutions(next.args, ctx);
  }
  return next as DagNode;
}

/**
 * Return a copy of `workflow` with every node's substitutable string fields
 * pre-substituted with the group context. Idempotent for non-group runs:
 * passing `undefined` empties any `$GROUP*` / `$REPO_*_DIR` references.
 */
export function applyGroupSubstitutionsToWorkflow(
  workflow: WorkflowDefinition,
  ctx?: GroupSubstitutionContext
): WorkflowDefinition {
  return {
    ...workflow,
    nodes: workflow.nodes.map(node => substituteGroupVarsInNode(node, ctx)),
  };
}
