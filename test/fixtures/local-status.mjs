/**
 * A janitor-style local status.json with planted private values, for the N7 tests. The values are made up
 * and live only under test/fixtures (privacy-guard-allow.txt exempts this folder); none may reach
 * local-counts.json or a published STATUS.md.
 */
export const PLANTED = {
  clone: 'plantedclone-aaa',
  // Built at run time: the machine-path check refuses a home directory written out, even in a fixture.
  worktreePath: ['', 'Users', 'planted-person', 'Developer', 'plantedclone-aaa', 'worktrees', 'agent-planted'].join('/'),
  sessionTitle: 'Planted session title about a private thing',
  sessionId: 'local_00000000-1111-2222-3333-444444444444',
  branch: 'planted/private-branch-name',
  repo: 'plantedorg/planted-private-repo',
  job: 'bl-planted-job-abc123',
}

export const NOW = '2026-11-15T15:00:00.000Z'

/** A full, readable status: every local row and inventory kind measured, the plan read. */
export function fullStatus() {
  return {
    generatedAt: NOW,
    repos: [
      { slug: 'plantedorg/public-one', branchesAhead: [{ branch: PLANTED.branch, ahead: 2 }, { branch: 'planted/kept-branch', ahead: 1 }, { branch: 'planted/gone', ahead: 1 }], openPrs: [], backlogOpen: [], duplicatePrs: [] },
      { slug: PLANTED.repo, redacted: true, noPrCount: 3 },
    ],
    local: {
      measuredAt: NOW,
      dirtyClones: [{ dir: PLANTED.clone, branch: PLANTED.branch, uncommitted: 2, unpushed: 1 }],
      behindClones: [{ dir: PLANTED.clone, branch: 'main', behind: 4 }, { dir: 'plantedclone-bbb', branch: 'main', behind: 1 }],
      behindFetchFailed: [],
      oldWorktrees: [{ clone: PLANTED.clone, path: PLANTED.worktreePath, ageDays: 9 }],
      idleSessions: [{ id: PLANTED.sessionId, title: PLANTED.sessionTitle, idleHours: 30 }],
      unread: [],
      installedTools: [{ tool: 'planted-tool', source: PLANTED.worktreePath, behind: 3, detail: 'x' }],
      installedToolsUnread: [],
    },
    inventory: {
      measuredAt: NOW,
      planRead: true,
      counts: { pr: { total: 5, orphans: 1 }, session: { total: 7, orphans: 2 }, worktree: { total: 4, orphans: 0 }, job: { total: 1, orphans: 1 }, backlog: { total: 9, orphans: 3 } },
      orphans: [{ kind: 'session', repo: null, ref: PLANTED.sessionId, label: PLANTED.sessionTitle, private: false, lapsed: false }, { kind: 'job', repo: PLANTED.repo, ref: PLANTED.job, label: 'running', private: true, lapsed: false }],
      hiddenPrivate: 0,
      privateReposNotItemised: 0,
    },
  }
}

/** The keep list: one entry still ahead of main, one whose branch is gone. */
export const keepList = () => [
  { repo: 'plantedorg/public-one', branch: 'planted/kept-branch', reason: 'planted reason', reviewBy: '2026-12-01' },
  { repo: 'plantedorg/public-one', branch: 'planted/long-merged', reason: 'planted reason', reviewBy: '2026-12-01' },
]
