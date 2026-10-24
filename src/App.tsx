import { useCallback, useEffect, useRef, useState } from 'react';
import * as dbx from './lib/dropbox';
import { Engine, cachedView, cacheView } from './lib/engine';
import type { DashResult, Txn } from './lib/types';
import { Tree } from './components/Tree';
import { EditSheet, type Edit } from './components/EditSheet';
import { mdToHtml } from './lib/md';

const engine = new Engine();
const REFRESH_LABEL = '🔄 Refresh from Tiller';

function monthName(m: string | null) {
  if (!m) return 'Budget';
  const [y, mo] = m.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function ago(t: number) {
  const s = (Date.now() - t) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

function SignIn({ error }: { error: string | null }) {
  const [code, setCode] = useState('');
  const [pasteMode, setPasteMode] = useState(false);
  const [err, setErr] = useState(error);
  return (
    <main className="signin">
      <h1>Finances</h1>
      <p>Your budget, from the Finances folder in Dropbox. Sign in once on this phone;
        the app reads and saves files only in that folder.</p>
      {err && <div className="alert error">{err}</div>}
      <button className="primary" onClick={async () => { location.href = await dbx.authorizeUrl(false); }}>
        Sign in to Dropbox
      </button>
      {!pasteMode ? (
        <button className="link" onClick={async () => { setPasteMode(true); window.open(await dbx.authorizeUrl(true), '_blank'); }}>
          Didn’t come back here after signing in? Use a code instead
        </button>
      ) : (
        <div className="paste">
          <p className="caption">Dropbox opened in a new window. Tap Allow, copy the code it shows, and paste it here.</p>
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste code" autoFocus />
          <button className="primary" disabled={!code.trim()} onClick={async () => {
            try { await dbx.completePaste(code); location.reload(); } catch (e) { setErr((e as Error).message); }
          }}>Continue</button>
        </div>
      )}
    </main>
  );
}

export default function App() {
  const [signedIn, setSignedIn] = useState(dbx.isSignedIn());
  const [authError, setAuthError] = useState<string | null>(null);
  const [result, setResult] = useState<DashResult | null>(null);
  const [computedAt, setComputedAt] = useState<number | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ level: string; text: string }[] | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const [editing, setEditing] = useState<Txn | null>(null);
  const [saving, setSaving] = useState(false);
  const running = useRef(false);

  useEffect(() => { engine.onProgress = (t) => setBusy(t); }, []);

  const accept = useCallback(async (r: DashResult) => {
    setResult(r);
    setComputedAt(Date.now());
    setMonth(r.month);
    if (r.error) { setError('The dashboard code stopped with an error.'); setLog(r.error); }
    await cacheView(r);
  }, []);

  const handle = useCallback((e: unknown) => {
    if (e instanceof dbx.SignInNeeded) { setSignedIn(false); return; }
    setError((e as Error).message || String(e));
  }, []);

  /** Sync with Dropbox and recalculate (if anything changed, or always with `force`). */
  const update = useCallback(async (m: string | null, force: boolean) => {
    if (running.current) return;
    running.current = true;
    try {
      const changed = await engine.sync();
      if (changed || force) await accept(await engine.show(m));
    } catch (e) { handle(e); } finally { running.current = false; setBusy(null); }
  }, [accept, handle]);

  useEffect(() => {
    (async () => {
      try {
        if (await dbx.completeRedirect()) setSignedIn(true);
      } catch (e) { setAuthError((e as Error).message); }
      const c = await cachedView();
      if (c) { setResult(c.result); setComputedAt(c.at); setMonth(c.result.month); }
      if (dbx.isSignedIn()) {
        engine.warmUp();
        // Always recalculate on launch: the dashboard depends on today's date too.
        update(c?.result.month ?? null, true);
      }
    })();
  }, [update]);

  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible' && dbx.isSignedIn()) update(month, false); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [month, update]);

  const chooseMonth = async (m: string) => {
    setMonth(m);
    if (running.current) return;
    running.current = true;
    try { await accept(await engine.show(m)); } catch (e) { handle(e); } finally { running.current = false; setBusy(null); }
  };

  const press = async (labels: string[], selectMatch?: unknown, edits?: unknown) => {
    if (running.current) return false;
    running.current = true;
    setError(null); setNotice(null);
    try {
      const r = await engine.press(month, labels, selectMatch, edits);
      if (r.result.actionError) {
        setError('That didn’t work — nothing was saved to Dropbox.');
        setLog(r.result.actionError + '\n\n' + r.result.log);
        return false;
      }
      await accept(r.result);
      const alerts = r.result.actionAlerts.filter((a) => a.level !== 'error' || a.text);
      const fails = alerts.filter((a) => a.level === 'error');
      if (fails.length) { setError(fails.map((a) => a.text).join('\n')); setLog(r.result.log); }
      setNotice([
        ...alerts.filter((a) => a.level !== 'error'),
        ...(r.note ? [{ level: 'warning', text: r.note }] : []),
        ...(r.saved.length ? [] : [{ level: 'info', text: 'Nothing needed saving.' }]),
      ]);
      return !fails.length;
    } catch (e) { handle(e); return false; } finally { running.current = false; setBusy(null); }
  };

  if (!signedIn) return <SignIn error={authError} />;

  const months = result?.months?.length ? result.months : month ? [month] : [];

  return (
    <div className="app">
      <header className="top">
        <div className="top-row">
          <label className="month">
            <span className="sr">Month</span>
            <select value={month ?? ''} onChange={(e) => chooseMonth(e.target.value)} disabled={!months.length}>
              {months.map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
            </select>
            <h1 aria-hidden>{monthName(month)}<span className="chev">▾</span></h1>
          </label>
          <button className="refresh" onClick={() => press([REFRESH_LABEL])} disabled={!!busy}
            aria-label="Refresh from Tiller" title="Refresh from Tiller">
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden className={busy ? 'spin' : ''}>
              <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
        <div className="status" aria-live="polite">
          {busy ?? (computedAt ? `Calculated ${ago(computedAt)}` : '')}
        </div>
      </header>

      {error && (
        <div className="alert error banner">
          <div>{error}</div>
          {log && <details><summary>Details</summary><pre className="code">{log}</pre></details>}
          <button className="link" onClick={() => { setError(null); setLog(null); }}>Dismiss</button>
        </div>
      )}
      {notice && notice.length > 0 && (
        <div className="notices" onClick={() => setNotice(null)}>
          {notice.map((n, i) => <div key={i} className={`alert ${n.level}`} dangerouslySetInnerHTML={{ __html: mdToHtml(n.text) }} />)}
        </div>
      )}

      <main className={busy && result ? 'content stale' : 'content'}>
        {result ? (
          <Tree node={result.tree} txns={result.transactions} onPick={setEditing} />
        ) : (
          <div className="empty">
            <p>{busy ?? 'Getting your budget…'}</p>
            <p className="caption">The first launch downloads Python (about 25 MB), so it takes a little longer. After that the app opens with your last numbers straight away.</p>
          </div>
        )}
      </main>

      <footer className="foot">
        <button className="link" onClick={() => { if (confirm('Sign out of Dropbox on this phone?')) { dbx.signOut(); setSignedIn(false); } }}>Sign out of Dropbox</button>
      </footer>

      {editing && result && (
        <EditSheet txn={editing} categories={result.categories} busy={saving} progress={busy}
          onClose={() => setEditing(null)}
          onApply={async (e: Edit) => {
            setSaving(true);
            const ok = await press(['Apply'],
              { recent_txns: [{ Transaction_Date: editing.date, Description: editing.description, Amount: editing.amount }] },
              [e]);
            setSaving(false);
            if (ok) setEditing(null);
          }} />
      )}
    </div>
  );
}
