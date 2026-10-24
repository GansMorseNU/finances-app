/// <reference lib="webworker" />
// Runs Python (Pyodide) off the main thread: dashboard.py for the screens, and the
// dashboard's own buttons (apply category changes, refresh from Tiller), which in turn
// run build_master.py exactly as on the Mac.

const PYODIDE_VERSION = '0.27.7';
const CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const WORK = '/work';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let py: any = null;
let ready: Promise<void> | null = null;

type Msg =
  | { id: number; type: 'init'; base: string }
  | { id: number; type: 'files'; put: { path: string; bytes: Uint8Array }[]; remove: string[] }
  | { id: number; type: 'run'; month: string | null; press: string[]; selectMatch?: unknown; edits?: unknown;
      sheets?: Record<string, string[][]> | null };

function post(o: unknown, transfer: Transferable[] = []) {
  (self as unknown as Worker).postMessage(o, transfer);
}

async function init(base: string) {
  const t0 = performance.now();
  post({ type: 'progress', text: 'Loading Python…' });
  const mod = await import(/* @vite-ignore */ `${CDN}pyodide.mjs`);
  py = await mod.loadPyodide({ indexURL: CDN });
  post({ type: 'progress', text: 'Loading pandas…' });
  await py.loadPackage(['numpy', 'pandas', 'python-dateutil', 'pytz', 'six', 'tzdata',
    `${base}wheels/et_xmlfile-2.0.0-py3-none-any.whl`,
    `${base}wheels/openpyxl-3.1.5-py2.py3-none-any.whl`], { messageCallback: () => {} });
  py.FS.mkdirTree('/app/streamlit');
  py.FS.mkdirTree(WORK);
  for (const f of ['phone_runner.py', 'gspread.py', 'streamlit/__init__.py']) {
    const r = await fetch(`${base}py/${f}`, { cache: 'no-cache' });
    py.FS.writeFile(`/app/${f}`, new Uint8Array(await r.arrayBuffer()));
  }
  await py.runPythonAsync(`
import sys, os
sys.path.insert(0, '/app'); sys.path.insert(0, '${WORK}')
os.chdir('${WORK}')
import pandas, numpy, openpyxl, gspread, phone_runner
`);
  post({ type: 'progress', text: `Python ready (${((performance.now() - t0) / 1000).toFixed(1)}s)` });
}

function putFiles(put: { path: string; bytes: Uint8Array }[], remove: string[]) {
  for (const f of put) {
    const full = `${WORK}/${f.path}`;
    py.FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
    py.FS.writeFile(full, f.bytes);
  }
  for (const p of remove) {
    try { py.FS.unlink(`${WORK}/${p}`); } catch { /* already gone */ }
  }
}

function hashes(): Record<string, string> {
  return JSON.parse(py.runPython('phone_runner.file_hashes()'));
}

async function run(m: Extract<Msg, { type: 'run' }>) {
  const before = hashes();
  py.globals.set('ARGS', JSON.stringify({
    month: m.month, press: m.press, select_match: m.selectMatch ?? null, edits: m.edits ?? null,
  }));
  py.globals.set('SHEETS', m.sheets ? JSON.stringify(m.sheets) : null);
  const out: string = await py.runPythonAsync(`
import json, gspread, phone_runner, pandas as pd
_sheets = json.loads(SHEETS) if SHEETS else None
def _fetch(sheet_id, title):
    if _sheets is not None and title in _sheets:
        return _sheets[title]
    # No live Tiller data: rebuild from the copy saved by the last refresh (Mac or phone).
    snap = {'Transactions': 'tiller_transactions_snapshot.csv',
            'Balance History': 'tiller_balance_history.csv'}.get(title)
    if snap is None:
        raise RuntimeError(f"No data for Tiller sheet {title!r}")
    df = pd.read_csv(snap, dtype=str, keep_default_na=False)
    # pandas names a blank header cell "Unnamed: 0"; the sheet has it blank.
    cols = ['' if str(c).startswith('Unnamed: ') else c for c in df.columns]
    return [cols] + df.values.tolist()
gspread.FETCH = _fetch
_a = json.loads(ARGS)
phone_runner.run_dashboard(month=_a['month'], press=_a['press'],
                           select_match=_a['select_match'], edits=_a['edits'])
`);
  const after = hashes();
  const changed: { path: string; bytes: Uint8Array }[] = [];
  for (const [p, h] of Object.entries(after)) {
    if (before[p] !== h) changed.push({ path: p, bytes: py.FS.readFile(`${WORK}/${p}`) });
  }
  const removed = Object.keys(before).filter((p) => !(p in after));
  return { result: JSON.parse(out), changed, removed };
}

self.onmessage = async (e: MessageEvent<Msg>) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      ready = ready || init(m.base);
      await ready;
      post({ id: m.id, ok: true });
    } else if (m.type === 'files') {
      await ready;
      putFiles(m.put, m.remove);
      post({ id: m.id, ok: true });
    } else if (m.type === 'run') {
      await ready;
      const res = await run(m);
      post({ id: m.id, ok: true, ...res }, res.changed.map((c) => c.bytes.buffer));
    }
  } catch (err) {
    post({ id: m.id, ok: false, error: String((err as Error)?.message || err) });
  }
};
