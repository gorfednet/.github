S=$TMPDIR/scratchpad; cat > $S/poll2.sh <<'EOF'
#!/bin/zsh
# Every 5 min: review verdict + CI rollup for the 6 PRs still moving; exit when none is not-run/pending (max 2 h).
W=~/Developer/gorfednet/gorfednet.github/.claude/worktrees/epic-chatelet-9e87a3
S=${0:h}
for i in {1..24}; do
  sleep 300; : > $S/poll2.txt; busy=0
  for r in .github:154 ops:73 ssatcy.com:47 heuristics.4thcltr.com:91 anal0g.org:36 subrythm.com:26; do
    repo=gorfednet/${r%:*}; n=${r#*:}
    v=$(node $W/scripts/review-status.mjs --pr $n --repo $repo 2>&1 | head -1 | awk '{print $2}')
    c=$(gh pr view $n --repo $repo --json statusCheckRollup --jq '[.statusCheckRollup[]|(.conclusion // .status)]|join(",")')
    echo "$repo $n review=$v ci=$c" >> $S/poll2.txt
    [[ $v == not-run || $c == *IN_PROGRESS* || $c == *QUEUED* || $c == *PENDING* ]] && busy=1
  done
  (( busy )) || { cat $S/poll2.txt; exit 0; }
done
cat $S/poll2.txt; exit 1
EOF
chmod +x $S/poll2.sh; echo ok
