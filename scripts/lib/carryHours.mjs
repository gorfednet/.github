/**
 * How long a carried branch read stays fresh, in hours. It sits in a module of its own so that
 * `quotaGuard.mjs` (which loads `fleet-status.mjs` for its repository list) and `fleet-status.mjs` (which
 * needs this number) never import each other: that cycle, with a top-level await in the guard, left the
 * guard waiting on itself and exiting 13 on every real run (review of PR 230, 17 November 2026).
 */
export const CARRY_HOURS = 23
