import { describe, it, expect } from 'bun:test';
import {
  applyGroupSubstitutions,
  applyGroupSubstitutionsToWorkflow,
  sanitizeRepoVarSuffix,
  type GroupSubstitutionContext,
} from './group-substitution';
import type { WorkflowDefinition } from '../schemas/workflow';

const ctx: GroupSubstitutionContext = {
  groupName: 'my-platform',
  groupDir: '/abs/group',
  members: [
    { relativePath: 'service-api', memberDir: '/abs/group/service-api' },
    { relativePath: 'service-web', memberDir: '/abs/group/service-web' },
    { relativePath: 'shared', memberDir: '/abs/group/shared' },
  ],
};

describe('sanitizeRepoVarSuffix', () => {
  it('uppercases and turns hyphens into underscores', () => {
    expect(sanitizeRepoVarSuffix('service-api')).toBe('SERVICE_API');
  });

  it('handles slashes and dots', () => {
    expect(sanitizeRepoVarSuffix('foo.bar/baz')).toBe('FOO_BAR_BAZ');
  });

  it('preserves already-valid identifiers', () => {
    expect(sanitizeRepoVarSuffix('SHARED_CORE_42')).toBe('SHARED_CORE_42');
  });
});

describe('applyGroupSubstitutions', () => {
  it('substitutes $GROUP, $GROUP_DIR, $REPOS', () => {
    const out = applyGroupSubstitutions('echo $GROUP at $GROUP_DIR. all repos:\n$REPOS', ctx);
    expect(out).toBe(
      'echo my-platform at /abs/group. all repos:\n/abs/group/service-api\n/abs/group/service-web\n/abs/group/shared'
    );
  });

  it('substitutes $REPO_<NAME>_DIR for each member', () => {
    const out = applyGroupSubstitutions('cd $REPO_SERVICE_API_DIR && npm test', ctx);
    expect(out).toBe('cd /abs/group/service-api && npm test');
  });

  it('replaces unknown $REPO_*_DIR with empty string', () => {
    const out = applyGroupSubstitutions('cd $REPO_DOES_NOT_EXIST_DIR && noop', ctx);
    expect(out).toBe('cd  && noop');
  });

  it('does not eat $GROUPS (word-boundary on $GROUP)', () => {
    // We don't want $GROUP to greedily consume $GROUPS or $GROUP_THING.
    // $GROUP_DIR is its own pattern; everything else with a different suffix should remain literal.
    const out = applyGroupSubstitutions('begin $GROUP end $GROUPS unchanged', ctx);
    expect(out).toBe('begin my-platform end $GROUPS unchanged');
  });

  it('replaces all four to empty when ctx is undefined', () => {
    const out = applyGroupSubstitutions('$GROUP $GROUP_DIR $REPOS $REPO_FOO_DIR end', undefined);
    // Each variable is replaced with empty string; original spaces between them remain.
    // Input has 4 spaces total between tokens; with all 4 vars deleted, 4 spaces are left.
    expect(out).toBe('    end');
  });

  it('handles members with hyphenated paths', () => {
    const ctx2: GroupSubstitutionContext = {
      groupName: 'g',
      groupDir: '/g',
      members: [{ relativePath: 'svc-very-long-name', memberDir: '/g/svc-very-long-name' }],
    };
    const out = applyGroupSubstitutions('$REPO_SVC_VERY_LONG_NAME_DIR', ctx2);
    expect(out).toBe('/g/svc-very-long-name');
  });

  it('handles repeated occurrences', () => {
    const out = applyGroupSubstitutions('$GROUP_DIR/foo and $GROUP_DIR/bar', ctx);
    expect(out).toBe('/abs/group/foo and /abs/group/bar');
  });
});

describe('applyGroupSubstitutionsToWorkflow', () => {
  function makeWorkflow(overrides: Partial<DagNodeLike>[] = []): WorkflowDefinition {
    return {
      name: 'wf',
      description: 'desc',
      nodes: overrides as never,
    } as WorkflowDefinition;
  }

  // Simplified node shape for tests — Zod schemas have many required fields.
  // We rely on the substitution logic only touching prompt/script/command/args.
  type DagNodeLike = {
    id: string;
    type?: string;
    prompt?: string;
    script?: string;
    command?: string;
    provider?: string;
  };

  it('substitutes prompt fields and leaves other fields alone', () => {
    const wf = makeWorkflow([
      { id: 'a', type: 'prompt', prompt: 'work in $GROUP_DIR', provider: 'claude' },
      { id: 'b', type: 'bash', script: 'cd $REPO_SERVICE_API_DIR && ls' },
    ]);

    const out = applyGroupSubstitutionsToWorkflow(wf, ctx);
    const nodes = out.nodes as unknown as DagNodeLike[];
    expect(nodes[0]?.prompt).toBe('work in /abs/group');
    expect(nodes[0]?.provider).toBe('claude'); // untouched
    expect(nodes[1]?.script).toBe('cd /abs/group/service-api && ls');
  });

  it('returns a new object — does not mutate the input', () => {
    const wf = makeWorkflow([{ id: 'a', prompt: 'in $GROUP_DIR' }]);
    const out = applyGroupSubstitutionsToWorkflow(wf, ctx);
    expect(out).not.toBe(wf);
    expect(out.nodes).not.toBe(wf.nodes);
    const inputNodes = wf.nodes as unknown as DagNodeLike[];
    expect(inputNodes[0]?.prompt).toBe('in $GROUP_DIR'); // input untouched
  });

  it('with no context, removes group vars from nodes', () => {
    const wf = makeWorkflow([{ id: 'a', prompt: 'unrelated $GROUP text' }]);
    const out = applyGroupSubstitutionsToWorkflow(wf);
    const nodes = out.nodes as unknown as DagNodeLike[];
    expect(nodes[0]?.prompt).toBe('unrelated  text');
  });

  it('preserves workflow-level fields', () => {
    const wf: WorkflowDefinition = {
      name: 'wf',
      description: 'desc',
      provider: 'claude',
      nodes: [{ id: 'a', type: 'prompt', prompt: 'x' }] as never,
    } as WorkflowDefinition;
    const out = applyGroupSubstitutionsToWorkflow(wf, ctx);
    expect(out.name).toBe('wf');
    expect(out.description).toBe('desc');
    expect(out.provider).toBe('claude');
  });
});
