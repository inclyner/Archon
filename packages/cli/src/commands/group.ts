/**
 * Workspace group commands — register/list/show/remove.
 *
 * A workspace group is a non-git parent directory containing N sibling git
 * repositories (codebases). `archon group register` walks the parent one
 * level deep, registers each git child via the existing registerRepository
 * helper, and stores the group + member junction.
 */
import { existsSync, statSync, readdirSync } from 'fs';
import { resolve, basename, join } from 'path';
import { workspaceGroupDb, registerRepository, type RegisterResult } from '@archon/core';
import type { WorkspaceGroupMember } from '@archon/core';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('cli.group');
  return cachedLog;
}

interface RegisterOutcome {
  relativePath: string;
  result?: RegisterResult;
  error?: string;
}

/**
 * Walk `parentPath` one level deep and return basenames of subdirs that look
 * like git repos (have a `.git` entry — file or directory; covers worktrees).
 */
function discoverGitChildren(parentPath: string): string[] {
  const entries = readdirSync(parentPath, { withFileTypes: true });
  const children: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    const gitEntry = join(parentPath, entry.name, '.git');
    if (existsSync(gitEntry)) {
      children.push(entry.name);
    }
  }
  children.sort();
  return children;
}

/**
 * `archon group register <parent-path> [--name <name>]`
 */
export async function groupRegisterCommand(
  parentPathArg: string,
  options: { name?: string } = {}
): Promise<number> {
  const parentPath = resolve(parentPathArg);

  if (!existsSync(parentPath)) {
    console.error(`Error: parent path does not exist: ${parentPath}`);
    return 1;
  }
  if (!statSync(parentPath).isDirectory()) {
    console.error(`Error: parent path is not a directory: ${parentPath}`);
    return 1;
  }

  const groupName = options.name ?? basename(parentPath);

  const existing = await workspaceGroupDb.getGroupByName(groupName);
  if (existing) {
    console.error(
      `Error: group "${groupName}" already exists at ${existing.parent_path}.\n` +
        '  Use --name to disambiguate, or `archon group remove` first.'
    );
    return 1;
  }

  const children = discoverGitChildren(parentPath);
  if (children.length === 0) {
    console.error(`Error: no git repositories found one level under ${parentPath}.`);
    return 1;
  }

  const outcomes: RegisterOutcome[] = [];
  for (const child of children) {
    const childPath = join(parentPath, child);
    try {
      const result = await registerRepository(childPath);
      outcomes.push({ relativePath: child, result });
    } catch (error) {
      const err = error as Error;
      getLog().warn({ err, childPath }, 'group.register.member_register_failed');
      outcomes.push({ relativePath: child, error: err.message });
    }
  }

  const successes = outcomes.filter(o => o.result);
  if (successes.length === 0) {
    console.error(`Error: failed to register any child repos under ${parentPath}.`);
    for (const o of outcomes) {
      console.error(`  ✗ ${o.relativePath} — ${o.error ?? 'unknown error'}`);
    }
    return 1;
  }

  const group = await workspaceGroupDb.createGroup({
    name: groupName,
    parent_path: parentPath,
  });

  for (const outcome of successes) {
    if (!outcome.result) continue;
    await workspaceGroupDb.addMember({
      group_id: group.id,
      codebase_id: outcome.result.codebaseId,
      relative_path: outcome.relativePath,
    });
  }

  console.log(`Group "${groupName}" registered at ${parentPath}`);
  for (const outcome of outcomes) {
    if (outcome.result) {
      const tag = outcome.result.alreadyExisted ? ' (already registered, linked)' : '';
      console.log(`  ✓ ${outcome.relativePath}${tag}`);
      console.log(`      → codebase ${outcome.result.codebaseId} (${outcome.result.name})`);
    } else {
      console.log(`  ✗ ${outcome.relativePath} — ${outcome.error ?? 'unknown error'}`);
    }
  }
  return 0;
}

/**
 * `archon group list [--json]`
 */
export async function groupListCommand(jsonOutput?: boolean): Promise<number> {
  const groups = await workspaceGroupDb.listGroups();

  if (jsonOutput) {
    console.log(JSON.stringify(groups, null, 2));
    return 0;
  }

  if (groups.length === 0) {
    console.log('No workspace groups registered.');
    console.log('Use `archon group register <parent-path>` to create one.');
    return 0;
  }

  console.log(`${groups.length} workspace group(s):\n`);
  for (const group of groups) {
    console.log(`  ${group.name}`);
    console.log(`    parent: ${group.parent_path}`);
  }
  return 0;
}

/**
 * `archon group show <name> [--json]`
 */
export async function groupShowCommand(name: string, jsonOutput?: boolean): Promise<number> {
  const group = await workspaceGroupDb.getGroupByName(name);
  if (!group) {
    console.error(`Error: no group named "${name}".`);
    return 1;
  }

  const members = await workspaceGroupDb.getMembersForGroup(group.id);

  if (jsonOutput) {
    console.log(JSON.stringify({ group, members }, null, 2));
    return 0;
  }

  console.log(`Group: ${group.name}`);
  console.log(`Parent: ${group.parent_path}`);
  console.log(`Members (${members.length}):`);
  for (const m of members as WorkspaceGroupMember[]) {
    console.log(`  ${m.relative_path}  → codebase ${m.codebase_id}`);
  }
  return 0;
}

/**
 * `archon group remove <name>` — drops group + member junction; codebases preserved.
 */
export async function groupRemoveCommand(name: string): Promise<number> {
  const group = await workspaceGroupDb.getGroupByName(name);
  if (!group) {
    console.error(`Error: no group named "${name}".`);
    return 1;
  }

  await workspaceGroupDb.removeGroup(group.id);
  console.log(`Group "${name}" removed (member codebases preserved).`);
  return 0;
}
