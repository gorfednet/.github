#!/usr/bin/env node
// Puts the tools of a tag in the order SPEC.md section 6 gives: models on the ranked list
// (models.json) in list order, then unversioned names of listed models in alphabetical order, then
// every other tool in alphabetical order. The order says nothing about which tool had the biggest hand.
//
//   node scripts/order-tools.mjs "Cursor + Sonnet + Opus 5.5"      prints the ordered list
//   node scripts/order-tools.mjs --check "Cursor + Opus 5.5"       exit 1 when it is out of order
//
// Exit 2 on a missing or empty tool list, or on more than 1 (a list typed without its quotes).
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readJson } from '../test/lib/spec.mjs';

// Splits a tool list on the plus signs that stand outside parentheses, so a reach parenthetical
// stays with its tool. Throws on an empty name, such as "Claude + ".
export function splitTools(list) {
  const tools = [];
  let depth = 0;
  let current = '';
  for (const char of list) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === '+' && depth === 0) {
      tools.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  tools.push(current);
  const names = tools.map((tool) => tool.trim());
  if (names.some((name) => name.length === 0)) throw new Error(`an empty tool name in ${JSON.stringify(list)}`);
  return names;
}

// The name without its reach parenthetical, lower-cased and split into words. A name that is only a
// parenthetical, such as the placeholder "(tool)", keeps it, so it never reads as an empty name.
function wordsOf(tool) {
  const bare = tool.replace(/\s*\([^()]*\)\s*$/, '');
  return (bare.trim().length > 0 ? bare : tool).toLowerCase().split(/\s+/).filter(Boolean);
}

function endsWith(long, short) {
  return short.length <= long.length && short.every((word, i) => word === long[long.length - short.length + i]);
}

function runsInside(long, short) {
  return long.some((_, at) => short.every((word, i) => word === long[at + i]));
}

// 0 for a model on the list, 1 for an unversioned name of a listed model, 2 for anything else (a
// family the list doesn't have, such as an unlisted maker's name, is in 2 until a model of it is added). A name matches a
// listed model when it ends with the model's version and the words before it, with or without the
// maker's name: "Opus 5.5" is "Claude Opus 5.5". The version alone ("5.5") names no model.
export function classify(tool, models) {
  const words = wordsOf(tool);
  const versioned = words.some((word) => /\d/.test(word));
  if (versioned) {
    const rank = models.findIndex((model) => {
      const full = wordsOf(model);
      return endsWith(full, words) && (words.length > 1 || full.length === 1);
    });
    return rank === -1 ? { group: 2, rank: 0 } : { group: 0, rank };
  }
  const family = words.length > 0 && models.some((model) => runsInside(wordsOf(model).slice(0, -1), words));
  return { group: family ? 1 : 2, rank: 0 };
}

function byName(a, b) {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  if (x !== y) return x < y ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function orderTools(tools, models) {
  if (!Array.isArray(models) || models.length === 0) throw new Error('the ranked model list is empty');
  return tools
    .map((tool) => ({ tool, ...classify(tool, models) }))
    .sort((a, b) => a.group - b.group || a.rank - b.rank || byName(a.tool, b.tool))
    .map((entry) => entry.tool);
}

function main(argv) {
  const check = argv.includes('--check');
  const lists = argv.filter((arg) => arg !== '--check');
  if (lists.length > 1) {
    console.error('order-tools: more than 1 tool list. Put the whole list in quotes, such as "Claude Opus 5.5 + Cursor"');
    return 2;
  }
  const [list] = lists;
  if (!list || list.trim().length === 0) {
    console.error('order-tools: a tool list is required, such as "Claude Opus 5.5 + Cursor"');
    return 2;
  }
  let tools;
  try {
    tools = splitTools(list);
  } catch (error) {
    console.error(`order-tools: ${error.message}`);
    return 2;
  }
  const ordered = orderTools(tools, readJson('models.json').models).join(' + ');
  console.log(ordered);
  if (check && ordered !== tools.join(' + ')) {
    console.error(`order-tools: out of order, expected ${ordered}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
