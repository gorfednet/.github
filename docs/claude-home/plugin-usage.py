# Per-repo count of skills, agents and MCP servers a session really called, from ~/.claude/projects transcripts.
# Run: python3 -I docs/claude-home/plugin-usage.py   (14 November 2026 run: see plugins.md)
import os,re,collections,json
root=os.path.expanduser('~/.claude/projects')
P='-Users-gorf-Developer-'
def repo(d):
    s=d
    for pre in ('-Users-gorf-Developer-gorfednet-','-Users-gorf-Developer-Apps-www-','-Users-gorf-Developer-Apps-'):
        if s.startswith(pre): s=s[len(pre):]; break
    else: return 'other'
    s=re.sub(r'(--|-)claude-worktrees-.*','',s)
    known=['bindercurve-com','gorfednet-github','4thcltr-com','heuristics-4thcltr-com','papers-4thcltr-com','promptboi-com','career-portfolio','gorfmusic-com','gorfed-net','MoonMan','moonman','ssatcy-com','anal0g-org','ops','subrythm-com','denseware-com','blackpixelrecords-com','assess','ai-use-levels','ask-collector','hx-','4c-','gn-','dotgithub','gorfednet.github']
    for k in known:
        if s.lower().startswith(k.lower()): return {'hx-':'heuristics-4thcltr-com','4c-':'4thcltr-com','gn-':'gorfed-net','dotgithub':'gorfednet-github','moonman':'MoonMan'}.get(k,k)
    return 'other:'+s[:20]
skill=re.compile(rb'"type":"tool_use","id":"[^"]+","name":"Skill","input":\{"skill":"([^"]+)"')
agent=re.compile(rb'"name":"Agent","input":\{[^}]*?"subagent_type":"([^"]+)"')
mcp=re.compile(rb'"type":"tool_use","id":"[^"]+","name":"(mcp__[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*?)__')
res=collections.defaultdict(lambda: collections.defaultdict(collections.Counter))
n=collections.Counter()
for d in os.listdir(root):
    r=repo(d); dp=os.path.join(root,d)
    for f in os.listdir(dp):
        if not f.endswith('.jsonl'): continue
        n[r]+=1
        b=open(os.path.join(dp,f),'rb').read()
        for m in skill.finditer(b): res[r]['skill'][m.group(1).decode()]+=1
        for m in agent.finditer(b): res[r]['agent'][m.group(1).decode()]+=1
        for m in mcp.finditer(b): res[r]['mcp'][m.group(1).decode()]+=1
for r in sorted(n,key=lambda x:-n[x]):
    print('##',r,'sessions',n[r])
    for k in ('skill','agent','mcp'):
        c=res[r][k]
        items=[(a,v) for a,v in c.most_common() if k!='mcp' or not a.startswith(('mcp__ccd','mcp__Claude_Browser','mcp__claude-in-chrome'))]
        if items: print('  ',k,', '.join(f'{a}={v}' for a,v in items[:14]))
