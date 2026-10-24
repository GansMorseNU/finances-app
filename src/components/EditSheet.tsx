import { useState } from 'react';
import type { Txn } from '../lib/types';

export interface Edit {
  Category: string;
  Note: string;
  Reimbursed_By: string;
  Reimbursement_Status: string;
  Remember_Merchant: boolean;
  Merchant_Pattern: string;
}

/** The desktop's "edit selected transactions" table, for one transaction. */
export function EditSheet({ txn, categories, busy, progress, onApply, onClose }: {
  txn: Txn; categories: string[]; busy: boolean; progress?: string | null;
  onApply: (e: Edit) => void; onClose: () => void;
}) {
  const [cat, setCat] = useState(txn.category);
  const [note, setNote] = useState(txn.note);
  const [by, setBy] = useState('');
  const [status, setStatus] = useState('');
  const [remember, setRemember] = useState(false);
  const [pattern, setPattern] = useState(txn.pattern);
  const cats = categories.includes(txn.category) ? categories : [txn.category, ...categories];
  const changed = cat !== txn.category || note !== txn.note || by !== '' || status !== '' || (remember && !!pattern.trim());

  return (
    <div className="sheet-backdrop" onClick={() => !busy && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Edit transaction" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div>
            <div className="sheet-title">{txn.description}</div>
            <div className="sheet-sub">{txn.date} · {txn.source}</div>
          </div>
          <div className="sheet-amt">${txn.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
        </div>

        {txn.rules.length > 0 && (
          <div className="alert warning">
            {txn.rules.map(([name, forced]) => <div key={name}><b>{name}</b> puts this in <b>{forced}</b>.</div>)}
            <div>Your change below still applies to this transaction, but the rule keeps re-tagging
              future charges with the same description.</div>
          </div>
        )}

        <label>Category
          <select value={cat} onChange={(e) => setCat(e.target.value)} disabled={busy}>
            {cats.map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
        <label>Note
          <input value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} placeholder="Optional" />
        </label>
        <div className="two">
          <label>Reimbursed by
            <select value={by} onChange={(e) => setBy(e.target.value)} disabled={busy}>
              <option value="">—</option><option>Work</option><option>Parents</option>
            </select>
          </label>
          <label>Status
            <select value={status} onChange={(e) => setStatus(e.target.value)} disabled={busy}>
              <option value="">{by ? 'Received' : '—'}</option><option>Pending</option><option>Received</option>
            </select>
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} disabled={busy} />
          Always put this merchant in this category
        </label>
        {remember && (
          <label>Match descriptions containing
            <input value={pattern} onChange={(e) => setPattern(e.target.value)} disabled={busy} />
            <span className="hint">Only for merchants that always belong here — not Amazon or Target.</span>
          </label>
        )}

        {busy && progress && <p className="caption" aria-live="polite">{progress}</p>}
        <div className="sheet-actions">
          <button className="secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" disabled={busy || !changed}
            onClick={() => onApply({
              Category: cat, Note: note, Reimbursed_By: by, Reimbursement_Status: status,
              Remember_Merchant: remember, Merchant_Pattern: pattern.trim(),
            })}>
            {busy ? 'Saving…' : 'Save change'}
          </button>
        </div>
      </div>
    </div>
  );
}
