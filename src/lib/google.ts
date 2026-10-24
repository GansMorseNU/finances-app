// Reads the Tiller Google Sheet from the phone, using the same service-account key the
// Mac uses (budget-tracker-*.json in the Finances folder). The key never leaves the phone:
// it signs a short-lived request to Google directly.

function b64url(data: string | Uint8Array): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  let s = '';
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

interface ServiceAccount { client_email: string; private_key: string; token_uri?: string }

async function accessToken(sa: ServiceAccount): Promise<string> {
  const aud = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud, iat: now, exp: now + 3600,
  }));
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToDer(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claims}`)));
  const r = await fetch(aud, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${b64url(sig)}`,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Google sign-in failed: ${j.error_description || j.error || r.status}`);
  return j.access_token;
}

/** Fetch whole worksheets as rows of strings (what gspread's get_all_values returns). */
export async function fetchSheets(keyJson: string, sheetId: string, titles: string[]): Promise<Record<string, string[][]>> {
  const sa = JSON.parse(keyJson) as ServiceAccount;
  const tok = await accessToken(sa);
  const out: Record<string, string[][]> = {};
  await Promise.all(titles.map(async (t) => {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(`'${t.replace(/'/g, "''")}'`)}?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
    if (!r.ok) throw new Error(`Reading "${t}" from Tiller failed (${r.status})`);
    out[t] = ((await r.json()).values || []) as string[][];
  }));
  return out;
}

/** Sheet id and worksheet names the pipeline uses, read from its own source code. */
export function pipelineSheets(sources: string[]): { sheetId: string | null; titles: string[]; keyFile: string | null } {
  let sheetId: string | null = null;
  let keyFile: string | null = null;
  const titles = new Set<string>();
  for (const src of sources) {
    const m = src.match(/SHEET_ID\s*=\s*['"]([\w-]+)['"]/);
    if (m && !sheetId) sheetId = m[1];
    const k = src.match(/CREDENTIALS_FILE\s*=\s*['"]([^'"]+)['"]/);
    if (k && !keyFile) keyFile = k[1];
    for (const w of src.matchAll(/worksheet\(\s*['"]([^'"]+)['"]\s*\)/g)) titles.add(w[1]);
    for (const w of src.matchAll(/_sheet_df\(\s*\w+\s*,\s*['"]([^'"]+)['"]\s*\)/g)) titles.add(w[1]);
  }
  return { sheetId, titles: [...titles], keyFile };
}
