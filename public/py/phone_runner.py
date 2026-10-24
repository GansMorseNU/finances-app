"""Runs the desktop dashboard and pipeline unchanged inside the phone app (Pyodide).

The Finances files live in the current directory (a copy synced from Dropbox).
  run_dashboard(...)  -> JSON string describing what dashboard.py displays
  file_hashes()       -> {path: md5} for change detection before/after a run
"""
import contextlib
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import traceback
import types

import streamlit as st

LOG = []
SKIP_DIRS = {'__pycache__', '.chat_snapshots', '.git', 'archive'}


def _install_fakes():
    # The desktop's "Ask Claude" panel is not part of the phone app.
    m = types.ModuleType('claude_chat')
    m.render = lambda *a, **k: None
    sys.modules['claude_chat'] = m

    # dashboard.py rebuilds by calling subprocess.run(['python3', 'build_master.py']).
    # Phones cannot start processes, so run the script in-process instead.
    def run(cmd, *a, **k):
        if isinstance(cmd, (list, tuple)) and len(cmd) >= 2 and str(cmd[1]).endswith('.py'):
            return run_script(os.path.basename(str(cmd[1])), [str(x) for x in cmd[2:]])
        raise RuntimeError(f"Can't run {cmd!r} on the phone")
    subprocess.run = run


def run_script(script, args=()):
    """Run a Finances script as `python3 script args`, capturing its output."""
    out = io.StringIO()
    old_argv = sys.argv
    sys.argv = [script] + list(args)
    # Pick up edits to helper modules made since the last run.
    for mod in ('bank_reconciliation',):
        sys.modules.pop(mod, None)
    code = 0
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            g = {'__name__': '__main__', '__file__': script}
            exec(compile(_phone_source(open(script, encoding='utf-8').read()), script, 'exec'), g)
    except SystemExit as e:
        code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
    except BaseException:
        traceback.print_exc(file=out)
        code = 1
    finally:
        sys.argv = old_argv
    text = out.getvalue()
    LOG.append(f"$ python3 {script} {' '.join(args)}\n{text}(exit {code})")
    return subprocess.CompletedProcess([script, *args], code, text, text if code else '')


def _phone_source(src):
    # The phone's C library doesn't know strftime's "no leading zero" flag (%-I, %-d):
    # use the plain codes instead ("09:35 PM" rather than "9:35 PM").
    return re.sub(r"%-([dmHIMSj])", r"%\1", src)


def _exec_dashboard():
    g = {'__name__': '__main__', '__file__': 'dashboard.py'}
    err = None
    reran = False
    try:
        src = _phone_source(open('dashboard.py', encoding='utf-8').read())
        exec(compile(src, 'dashboard.py', 'exec'), g)
    except st.RerunSignal:
        reran = True
    except BaseException:
        err = traceback.format_exc()
    return g, err, reran


def _alerts(node):
    out = []
    if node.kind == 'alert' or node.kind == 'code':
        out.append({'level': node.props.get('level', 'error'), 'text': node.props.get('text')})
    for c in node.children:
        out.extend(_alerts(c))
    return out


def _txn_details(g):
    recent = g.get('recent')
    if recent is None or not hasattr(recent, 'iterrows'):
        return []
    rules_fn = g.get('merchant_rules_affecting')
    pattern_fn = g.get('suggest_merchant_pattern')
    out = []
    for _, r in recent.iterrows():
        desc = str(r.get('Description', ''))
        warn = []
        if rules_fn:
            try:
                warn = [list(x) for x in rules_fn(desc, r.get('Card', ''), r.get('Amount'))]
            except Exception:
                warn = []
        note = r.get('Note', '')
        out.append({
            'date': st._clean(r.get('Transaction_Date')),
            'description': desc,
            'amount': st._clean(r.get('Amount')),
            'category': str(r.get('Category', '')),
            'note': '' if note is None or (isinstance(note, float) and note != note) else str(note),
            'source': str(r.get('Source', '')),
            'card': st._clean(r.get('Card')),
            'rules': warn,
            'pattern': pattern_fn(desc) if pattern_fn else '',
        })
    return out


def run_dashboard(month=None, press=(), select_match=None, edits=None):
    """One dashboard run. With `press`, the named buttons are clicked: the dashboard's
    own code then does the work (write overrides, rebuild); the page is then drawn
    again, as Streamlit would after st.rerun()."""
    _install_fakes()
    LOG.clear()
    action_alerts = []
    action_error = None
    if press:
        st.reset()
        st.CONTROL.update(month=month, press=set(press), select={},
                          select_match=dict(select_match or {}), edits=list(edits or []),
                          toggles=False)
        g, err, reran = _exec_dashboard()
        action_alerts = _alerts(st.ROOT) + _alerts(st.SIDEBAR)
        action_error = err
    st.reset()
    st.CONTROL.update(month=month, press=set(), select={}, select_match={}, edits=[],
                      toggles=True)
    g, err, _ = _exec_dashboard()
    # Keep only messages produced by the action itself, not ones the page always shows.
    page_alerts = {a['text'] for a in _alerts(st.ROOT)}
    action_alerts = [a for a in action_alerts if a['text'] not in page_alerts]
    month_widget = st.WIDGETS.get('Month', {})
    sel = g.get('selected_month_str')
    return json.dumps({
        'tree': st.ROOT.to_json(),
        'months': month_widget.get('options', []),
        'month': str(sel) if sel is not None else None,
        'categories': [str(c) for c in g.get('ALL_CATEGORIES', [])],
        'transactions': _txn_details(g),
        'error': err,
        'actionAlerts': action_alerts,
        'actionError': action_error,
        'log': '\n\n'.join(LOG),
    })


def file_hashes(root='.'):
    out = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for f in filenames:
            p = os.path.normpath(os.path.join(dirpath, f))
            try:
                with open(p, 'rb') as fh:
                    out[p] = hashlib.md5(fh.read()).hexdigest()
            except OSError:
                pass
    return json.dumps(out)
