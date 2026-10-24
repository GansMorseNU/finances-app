// Keeps a copy of the Finances folder on the phone in step with Dropbox, feeds it to the
// Python worker, and writes back whatever the dashboard's own code changes.
import { get, set, del, keys } from 'idb-keyval';
import * as dbx from './dropbox';
import { fetchSheets, pipelineSheets } from './google';
import type { DashResult } from './types';

// Which Dropbox files the pipeline and dashboard need on the phone.
function wanted(path: string): boolean {
  if (path.startsWith('data/')) return true;
  if (path.includes('/')) return false;
  if (path.startsWith('.')) return false;
  return /\.(py|csv|xlsx|json)$/i.test(path);
}

interface Cached { rev: string; bytes: Uint8Array }
const fileKey = (p: string) => `file:${p}`;

type Listener = (text: string) => void;

export class Engine {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  private revs = new Map<string, string>();        // what the worker currently holds
  private loadedIntoWorker = false;
  private initP: Promise<unknown> | null = null;
  onProgress: Listener = () => {};

  constructor() {
    this.worker = new Worker(new URL('../worker/py.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'progress') { this.onProgress(d.text); return; }
      const p = this.pending.get(d.id);
      if (!p) return;
      this.pending.delete(d.id);
      d.ok ? p.res(d) : p.rej(new Error(d.error));
    };
  }

  private call(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<any> {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.worker.postMessage({ id, ...msg }, transfer);
    });
  }

  /** Start loading Python right away; it is needed for every recalculation. */
  warmUp() {
    if (!this.initP) {
      const base = new URL('./', location.href).href;
      this.initP = this.call({ type: 'init', base });
    }
    return this.initP;
  }

  /** Bring the phone's copy up to date with Dropbox. Returns true if anything changed. */
  async sync(): Promise<boolean> {
    this.onProgress('Checking Dropbox…');
    const listing = (await dbx.listAll()).filter((e) => wanted(e.path));
    const put: { path: string; bytes: Uint8Array }[] = [];
    const seen = new Set<string>();
    let downloaded = 0;
    for (const e of listing) {
      seen.add(e.path);
      let c = (await get(fileKey(e.path))) as Cached | undefined;
      if (!c || c.rev !== e.rev) {
        this.onProgress(`Downloading ${e.path}…`);
        const d = await dbx.download(e.path);
        c = { rev: d.rev || e.rev, bytes: d.bytes };
        await set(fileKey(e.path), c);
        downloaded++;
      }
      if (this.revs.get(e.path) !== c.rev || !this.loadedIntoWorker) {
        put.push({ path: e.path, bytes: c.bytes });
        this.revs.set(e.path, c.rev);
      }
    }
    const remove: string[] = [];
    for (const k of await keys()) {
      const s = String(k);
      if (!s.startsWith('file:')) continue;
      const p = s.slice(5);
      if (!seen.has(p)) { await del(k); remove.push(p); this.revs.delete(p); }
    }
    await this.warmUp();
    if (put.length || remove.length) {
      await this.call({ type: 'files', put, remove });
    }
    this.loadedIntoWorker = true;
    return downloaded > 0 || remove.length > 0;
  }

  /** Calculate the dashboard for a month. */
  async show(month: string | null): Promise<DashResult> {
    await this.warmUp();
    this.onProgress('Calculating…');
    const r = await this.call({ type: 'run', month, press: [] });
    return r.result as DashResult;
  }

  private async tillerData(): Promise<{ sheets: Record<string, string[][]> | null; note: string | null }> {
    const src = async (p: string) => {
      const c = (await get(fileKey(p))) as Cached | undefined;
      return c ? new TextDecoder().decode(c.bytes) : '';
    };
    const { sheetId, titles, keyFile } = pipelineSheets([await src('build_master.py'), await src('bank_reconciliation.py')]);
    try {
      if (!sheetId || !keyFile) throw new Error("couldn't find the sheet id / key in build_master.py");
      const key = await src(keyFile);
      if (!key) throw new Error(`${keyFile} not found in Dropbox`);
      this.onProgress('Reading Tiller…');
      return { sheets: await fetchSheets(key, sheetId, titles), note: null };
    } catch (e) {
      return { sheets: null, note: `Couldn't reach Tiller (${(e as Error).message}); rebuilt from the data saved at the last refresh.` };
    }
  }

  /** Click one of the dashboard's buttons (e.g. "Apply", "🔄 Refresh from Tiller"),
   *  then save every file it changed back to Dropbox. Retries once on a conflict. */
  async press(month: string | null, press: string[], selectMatch?: unknown, edits?: unknown):
    Promise<{ result: DashResult; note: string | null; saved: string[] }> {
    for (let attempt = 0; ; attempt++) {
      await this.sync();
      const { sheets, note } = await this.tillerData();
      this.onProgress(press[0]?.startsWith('Apply') ? 'Saving change and rebuilding…' : 'Rebuilding from Tiller…');
      const r = await this.call({ type: 'run', month, press, selectMatch, edits, sheets });
      if (r.result.actionError) {
        return { result: r.result, note, saved: [] };
      }
      try {
        const saved = await this.save(r.changed, r.removed);
        return { result: r.result, note, saved };
      } catch (e) {
        if (e instanceof dbx.Conflict && attempt === 0) {
          this.onProgress('Dropbox changed meanwhile — redoing with the newest files…');
          this.loadedIntoWorker = false;     // reload everything into the worker
          continue;
        }
        throw e;
      }
    }
  }

  private async save(changed: { path: string; bytes: Uint8Array }[], removed: string[]) {
    // The override/rule files first: they are the record of what was asked for.
    const order = (p: string) => (/^(category_overrides|merchant_rules)\.csv$/.test(p) ? 0 : 1);
    const files = changed.filter((c) => wanted(c.path) && !c.path.startsWith('data/'))
      .sort((a, b) => order(a.path) - order(b.path));
    const saved: string[] = [];
    for (const f of files) {
      this.onProgress(`Saving ${f.path} to Dropbox…`);
      const rev = await dbx.upload(f.path, f.bytes, this.revs.get(f.path));
      await set(fileKey(f.path), { rev, bytes: f.bytes });
      this.revs.set(f.path, rev);
      saved.push(f.path);
    }
    void removed; // the pipeline never deletes inputs; nothing to remove remotely
    return saved;
  }
}

// ---- cached screens, so the app opens instantly with the last numbers
export async function cachedView(): Promise<{ result: DashResult; at: number } | undefined> {
  return get('view:last');
}
export async function cacheView(result: DashResult) {
  await set('view:last', { result, at: Date.now() });
}
