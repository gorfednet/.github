// Shared helpers for the test files. Not a test file itself.
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const root = path.resolve(import.meta.dirname, '..', '..');

export function readJson(relative) {
  return JSON.parse(readFileSync(path.join(root, relative), 'utf8'));
}

export function readText(relative) {
  return readFileSync(path.join(root, relative), 'utf8');
}

// The values a slot's "required" may take. spec.schema.json lists the same ones, and
// test/spec-schema.test.mjs checks the two agree.
export const REQUIRED_VALUES = new Set(['always', 'recommended', 'at L2 and L3', 'when true', 'at L1 and above']);

// "1.0" -> [1, 0]. Throws on anything that is not dotted integers.
export function parseVersion(version) {
  if (typeof version !== 'string' || !/^\d+(\.\d+)*$/.test(version)) {
    throw new Error(`not a version string: ${JSON.stringify(version)}`);
  }
  return version.split('.').map(Number);
}

// Negative, zero or positive, like a comparator. Missing parts count as 0.
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const length = Math.max(pa.length, pb.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// Splits a machine-form tag into its known tokens, its tool and its version token, following
// the pattern in spec.json: AI-Use: <level> [hand] [door] [flag] [(<tool>)] [v<major>].
// The tool is everything from the first "(" to the last ")", so "(Copilot (IDE))" nests, and
// it is null when the tag has no parentheses, as "AI-Use: L0" has. Whether a level may leave the
// tool out is a rule of the spec, not of the syntax, so checkTag in scripts/check-trailers.mjs
// decides that. Throws on an unknown token, an empty "()" or a malformed string.
export function tokenize(machine, spec) {
  const match = /^AI-Use: ([^(]*?)(?:\s*\((.*)\))?(?: (v\d+))?$/.exec(machine);
  if (!match) throw new Error(`not a machine-form tag: ${JSON.stringify(machine)}`);
  const known = spec.tokens.map((token) => token.id).sort((a, b) => b.length - a.length);
  const tokens = [];
  let rest = match[1].trim();
  while (rest.length > 0) {
    const hit = known.find((id) => rest === id || rest.startsWith(`${id} `));
    if (!hit) throw new Error(`unknown token at ${JSON.stringify(rest)} in ${JSON.stringify(machine)}`);
    tokens.push(hit);
    rest = rest.slice(hit.length).trim();
  }
  let tool = null;
  if (match[2] !== undefined) {
    tool = match[2].trim();
    if (tool.length === 0) throw new Error(`empty tool in ${JSON.stringify(machine)}`);
  }
  return { tokens, tool, version: match[3] ?? null };
}
