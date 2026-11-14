# Per-repo count of skills, agents and MCP servers a session really called, from ~/.claude/projects transcripts.
# Run: python3 -I docs/claude-home/plugin-usage.py
# Also counts slash commands the owner typed (<command-name> tags), which are not tool calls.
# Parses every JSONL line (top-level and subagent transcripts), counts Skill, Agent and the older Task tool.
import os, re, json, collections

root = os.path.expanduser('~/.claude/projects')
PREFIXES = ('-Users-gorf-Developer-gorfednet-', '-Users-gorf-Developer-Apps-www-', '-Users-gorf-Developer-Apps-')
KNOWN = {'bindercurve-com': 'bindercurve-com', 'gorfednet-github': 'gorfednet-github', '4thcltr-com': '4thcltr-com',
         'heuristics-4thcltr-com': 'heuristics-4thcltr-com', 'papers-4thcltr-com': 'papers-4thcltr-com',
         'promptboi-com': 'promptboi-com', 'career-portfolio': 'career-portfolio', 'gorfmusic-com': 'gorfmusic-com',
         'gorfed-net': 'gorfed-net', 'moonman': 'MoonMan', 'ssatcy-com': 'ssatcy-com', 'anal0g-org': 'anal0g-org',
         'ops': 'ops', 'subrythm-com': 'subrythm-com', 'denseware-com': 'denseware-com',
         'blackpixelrecords-com': 'blackpixelrecords-com', 'assess': 'assess', 'ai-use-levels': 'ai-use-levels',
         'ask-collector': 'ask-collector', 'hx-': 'heuristics-4thcltr-com', '4c-': '4thcltr-com',
         'gn-': 'gorfed-net', 'dotgithub': 'gorfednet-github'}

SLUG_WORDS = {'4thcltr': '4thcltr-com', '4c-': '4thcltr-com', 'heuristics': 'heuristics-4thcltr-com', 'hx-': 'heuristics-4thcltr-com',
              'papers': 'papers-4thcltr-com', 'gorfed': 'gorfed-net', 'gn-': 'gorfed-net', 'moonman': 'MoonMan',
              'bindercurve': 'bindercurve-com', 'bc-': 'bindercurve-com', 'promptboi': 'promptboi-com', 'career': 'career-portfolio',
              'ops': 'ops', 'assess': 'assess'}


def repo(d):
    for pre in PREFIXES:
        if d.startswith(pre):
            s = re.sub(r'(--|-)claude-worktrees-.*', '', d[len(pre):]).lower()
            if s.startswith('-worktrees-'):  # shared .worktrees folder: task slugs, named by a repo word first
                s = s[len('-worktrees-'):]
                for k, v in SLUG_WORDS.items():
                    if s.startswith(k):
                        return v
                return 'other'
            for k, v in KNOWN.items():
                if s.startswith(k):
                    return v
            return 'other'
    return 'other'


res = collections.defaultdict(lambda: collections.defaultdict(collections.Counter))
files = collections.Counter()
for dp, _, fs in os.walk(root):
    rel = os.path.relpath(dp, root).split(os.sep)[0]
    r = repo(rel)
    for f in fs:
        if not f.endswith('.jsonl'):
            continue
        files[r] += 1
        with open(os.path.join(dp, f), 'rb') as fh:
            for line in fh:
                for m in re.finditer(rb'<command-name>/?([^<]+)</command-name>', line):
                    res[r]['typed'][m.group(1).decode().strip()] += 1
                if b'"tool_use"' not in line:
                    continue
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                content = (obj.get('message') or {}).get('content')
                if not isinstance(content, list):
                    continue
                for b in content:
                    if not isinstance(b, dict) or b.get('type') != 'tool_use':
                        continue
                    name, inp = b.get('name', ''), b.get('input') or {}
                    if name == 'Skill':
                        res[r]['skill'][inp.get('skill', '?')] += 1
                    elif name in ('Agent', 'Task'):
                        res[r]['agent'][inp.get('subagent_type', 'general-purpose')] += 1
                    elif name.startswith('mcp__') and not name.startswith(('mcp__ccd', 'mcp__Claude_Browser', 'mcp__claude-in-chrome')):
                        res[r]['mcp'][name.split('__')[1]] += 1

for r in sorted(files, key=lambda x: -files[x]):
    print('##', r, 'transcripts', files[r])
    for k in ('skill', 'agent', 'typed', 'mcp'):
        items = res[r][k].most_common(14)
        if items:
            print('  ', k, ', '.join(f'{a}={v}' for a, v in items))
