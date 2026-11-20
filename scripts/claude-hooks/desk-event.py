# Claude Code hook (Stop, StopFailure, Notification, PermissionRequest): append one JSON line to ~/.desk/events.jsonl.
# Fields: session (DESK_SESSION_NAME, else the session id), cwd, event ("turn-ended" or
# "waiting-on-prompt"), kind (the Notification type, else null), at (ET, from the system zone database), ts (epoch seconds),
# and background_tasks when a Stop arrives with tasks still running.
# It only writes that line. It prints nothing, never blocks, never changes a tool call, and always exits 0.
# Test override: DESK_EVENTS_FILE.
import json, os, sys, time

WAITING = ('permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input')


def event_for(inp):
    ev = inp.get('hook_event_name')
    if ev in ('Stop', 'StopFailure'):
        return 'turn-ended', ev if ev == 'StopFailure' else None
    # PermissionRequest fires when the dialog opens; Notification permission_prompt follows about 6 s later.
    if ev == 'PermissionRequest':
        return 'waiting-on-prompt', 'permission_request'
    if ev == 'Notification' and inp.get('notification_type') in WAITING:
        return 'waiting-on-prompt', inp['notification_type']
    return None, None


def et_now(now=None):
    # TZ is set only for this process, so the zone database does the conversion, never an offset.
    old = os.environ.get('TZ')
    os.environ['TZ'] = 'America/Toronto'
    time.tzset()
    try:
        return time.strftime('%Y-%m-%dT%H:%M:%S %Z', time.localtime(now))
    finally:
        if old is None:
            os.environ.pop('TZ', None)
        else:
            os.environ['TZ'] = old
        time.tzset()


def line_for(inp, env=os.environ, now=None):
    event, kind = event_for(inp)
    if not event:
        return None
    rec = {
        'session': env.get('DESK_SESSION_NAME') or str(inp.get('session_id') or ''),
        'cwd': inp.get('cwd'),
        'event': event,
        'kind': kind,
        'at': et_now(now),
        'ts': int(now if now is not None else time.time()),
    }
    # A Stop with background tasks still running is a pause, not a finish.
    if event == 'turn-ended' and inp.get('background_tasks'):
        bt = inp['background_tasks']
        rec['background_tasks'] = len(bt) if isinstance(bt, (list, dict)) else bt
    if event == 'waiting-on-prompt' and inp.get('message'):
        rec['message'] = str(inp['message'])[:200]
    return json.dumps(rec, separators=(',', ':')) + '\n'


def main():
    try:
        inp = json.loads(sys.stdin.read() or '{}')
        line = line_for(inp)
        if line:
            path = os.environ.get('DESK_EVENTS_FILE') or os.path.expanduser('~/.desk/events.jsonl')
            os.makedirs(os.path.dirname(path), exist_ok=True)
            fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
            try:
                os.write(fd, line.encode())  # one write call: lines from parallel sessions don't interleave
            finally:
                os.close(fd)
    except Exception:
        pass
    sys.exit(0)


if __name__ == '__main__':
    main()
