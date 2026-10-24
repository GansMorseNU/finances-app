// Dropbox access from the phone: sign-in (OAuth PKCE, no app secret), folder listing,
// download, and upload with a revision check so a newer copy is never overwritten.

export const APP_KEY = 'bkc7x82s2nknxp1';
export const FOLDER = '/Finances';
const PUBLISHED_REDIRECT = 'https://gansmorsenu.github.io/finances-app/';

const LS_REFRESH = 'dbx_refresh_token';
const LS_VERIFIER = 'dbx_pkce_verifier';
const LS_VERIFIER_PASTE = 'dbx_pkce_verifier_paste';

let accessToken: string | null = null;
let accessExpiry = 0;

export function redirectUri(): string {
  if (location.hostname === 'gansmorsenu.github.io') return PUBLISHED_REDIRECT;
  return location.origin + location.pathname;
}

function lsGet(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}
function lsSet(k: string, v: string | null) {
  try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* ignore */ }
}

export function isSignedIn(): boolean {
  return !!lsGet(LS_REFRESH);
}

export function signOut() {
  lsSet(LS_REFRESH, null);
  accessToken = null;
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function pkcePair() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge: b64url(digest) };
}

/** Start sign-in. `paste`: Dropbox shows a code to copy instead of redirecting back
 *  (fallback for when the Home Screen app doesn't receive the redirect). */
export async function authorizeUrl(paste = false): Promise<string> {
  const { verifier, challenge } = await pkcePair();
  lsSet(paste ? LS_VERIFIER_PASTE : LS_VERIFIER, verifier);
  const p = new URLSearchParams({
    client_id: APP_KEY,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    token_access_type: 'offline',
  });
  if (!paste) p.set('redirect_uri', redirectUri());
  return `https://www.dropbox.com/oauth2/authorize?${p}`;
}

async function tokenRequest(body: Record<string, string>) {
  const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: APP_KEY, ...body }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.error || `Dropbox sign-in failed (${r.status})`);
  return j as { access_token: string; expires_in: number; refresh_token?: string };
}

function keep(j: { access_token: string; expires_in: number; refresh_token?: string }) {
  accessToken = j.access_token;
  accessExpiry = Date.now() + (j.expires_in - 60) * 1000;
  if (j.refresh_token) lsSet(LS_REFRESH, j.refresh_token);
}

/** Finish sign-in after the redirect (?code=...). Returns true if a code was handled. */
export async function completeRedirect(): Promise<boolean> {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  if (!code) return false;
  history.replaceState(null, '', location.pathname);
  const verifier = lsGet(LS_VERIFIER);
  if (!verifier) throw new Error('Sign-in expired — please try again.');
  keep(await tokenRequest({
    code, grant_type: 'authorization_code', code_verifier: verifier, redirect_uri: redirectUri(),
  }));
  lsSet(LS_VERIFIER, null);
  return true;
}

export async function completePaste(code: string) {
  const verifier = lsGet(LS_VERIFIER_PASTE);
  if (!verifier) throw new Error('Start the sign-in again, then paste the new code.');
  keep(await tokenRequest({ code: code.trim(), grant_type: 'authorization_code', code_verifier: verifier }));
  lsSet(LS_VERIFIER_PASTE, null);
}

async function token(): Promise<string> {
  if (accessToken && Date.now() < accessExpiry) return accessToken;
  const refresh = lsGet(LS_REFRESH);
  if (!refresh) throw new SignInNeeded();
  try {
    keep(await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh }));
  } catch (e) {
    signOut();
    throw new SignInNeeded();
  }
  return accessToken!;
}

export class SignInNeeded extends Error {
  constructor() { super('Sign in to Dropbox'); }
}
export class Conflict extends Error {
  constructor(public path: string) { super(`${path} changed in Dropbox meanwhile`); }
}

// Dropbox-API-Arg must be ASCII; escape anything else.
function apiArg(o: unknown): string {
  return JSON.stringify(o).replace(/[\u007f-￿]/g, (c) => '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4));
}

async function rpc(endpoint: string, body: unknown) {
  const r = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.status === 401) { accessToken = null; throw new SignInNeeded(); }
  if (!r.ok) throw new Error(`Dropbox ${endpoint}: ${r.status} ${await r.text()}`);
  return r.json();
}

export interface Entry { path: string; rev: string; size: number; modified: string }

/** All files under /Finances, with paths relative to it (e.g. "data/amazon_orders/x.csv"). */
export async function listAll(): Promise<Entry[]> {
  const out: Entry[] = [];
  let j = await rpc('files/list_folder', { path: FOLDER, recursive: true, limit: 2000 });
  for (;;) {
    for (const e of j.entries) {
      if (e['.tag'] !== 'file') continue;
      out.push({
        path: (e.path_display as string).slice(FOLDER.length + 1),
        rev: e.rev, size: e.size, modified: e.server_modified,
      });
    }
    if (!j.has_more) break;
    j = await rpc('files/list_folder/continue', { cursor: j.cursor });
  }
  return out;
}

export async function download(relPath: string): Promise<{ bytes: Uint8Array; rev: string }> {
  const r = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: { Authorization: `Bearer ${await token()}`, 'Dropbox-API-Arg': apiArg({ path: `${FOLDER}/${relPath}` }) },
  });
  if (r.status === 401) { accessToken = null; throw new SignInNeeded(); }
  if (!r.ok) throw new Error(`Download ${relPath}: ${r.status}`);
  const meta = JSON.parse(r.headers.get('Dropbox-API-Result') || '{}');
  return { bytes: new Uint8Array(await r.arrayBuffer()), rev: meta.rev || '' };
}

/** Upload; with `rev`, only replaces that exact version (else throws Conflict). */
export async function upload(relPath: string, bytes: Uint8Array, rev?: string): Promise<string> {
  const mode = rev ? { '.tag': 'update', update: rev } : { '.tag': 'add' };
  const r = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await token()}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': apiArg({ path: `${FOLDER}/${relPath}`, mode, autorename: false, mute: true }),
    },
    body: bytes as BodyInit,
  });
  if (r.status === 401) { accessToken = null; throw new SignInNeeded(); }
  if (r.status === 409) {
    const t = await r.text();
    if (t.includes('conflict')) throw new Conflict(relPath);
    throw new Error(`Upload ${relPath}: ${t}`);
  }
  if (!r.ok) throw new Error(`Upload ${relPath}: ${r.status} ${await r.text()}`);
  return (await r.json()).rev;
}
