import { useState, type ReactNode } from 'react';
import type { Node, Txn } from '../lib/types';
import { mdToHtml, safeHtml } from '../lib/md';
import { LineChart } from './Chart';

// Renders what dashboard.py "drew" (recorded by the Streamlit stand-in) in a phone layout.

type Cell = string | number | boolean | null;

const MONEY_COL = /amount|budget|actual|remaining|balance|funds|backed|difference|checking|card balances|reimb|net position|spending|income|off-budget|untracked in|timing/i;

function fmtCell(col: string, v: Cell): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    if (MONEY_COL.test(col)) {
      const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return (v < 0 ? '−$' : '$') + s;
    }
    return Number.isInteger(v) ? String(v) : v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  if (typeof v === 'boolean') return v ? 'Yes' : '';
  return String(v);
}

const HIDE_COLS = new Set(['Source']);
const RENAME: Record<string, string> = {
  Transaction_Date: 'Date', Reimbursed_By: 'Reimbursed by', Days_Outstanding: 'Days',
};

function Table({ node }: { node: Node }) {
  const cols = (node.columns || []).map((c, i) => ({ c, i })).filter(({ c }) => !HIDE_COLS.has(c));
  return (
    <div className="table-wrap">
      <table>
        <thead><tr>{cols.map(({ c }) => <th key={c}>{RENAME[c] || c}</th>)}</tr></thead>
        <tbody>
          {(node.rows || []).map((r, ri) => (
            <tr key={ri}>
              {cols.map(({ c, i }) => (
                <td key={c} className={typeof r[i] === 'number' ? 'num' : undefined}>{fmtCell(c, r[i])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A transaction table inside a budget group: tucked away behind a count. */
function DetailTable({ node }: { node: Node }) {
  const [open, setOpen] = useState(false);
  const n = node.rows?.length || 0;
  return (
    <div className="detail">
      <button className="link" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? 'Hide' : 'Show'} {n} transaction{n === 1 ? '' : 's'}
      </button>
      {open && <Table node={node} />}
    </div>
  );
}

function Metric({ node }: { node: Node }) {
  const [showHelp, setShowHelp] = useState(false);
  const d = node.delta === null || node.delta === undefined ? null : String(node.delta);
  const neg = d?.trim().startsWith('-') || d?.trim().startsWith('−');
  const tone = node.deltaColor === 'off' ? 'off' : neg ? 'neg' : 'pos';
  return (
    <div className="metric">
      <div className="metric-value">{String(node.value ?? '')}</div>
      <div className="metric-label">
        {node.label}
        {node.help && (
          <button className="help" aria-label="Explain" aria-expanded={showHelp} onClick={() => setShowHelp(!showHelp)}>?</button>
        )}
      </div>
      {d && <div className={`metric-delta ${tone}`}>{d}</div>}
      {showHelp && node.help && <div className="metric-help" dangerouslySetInnerHTML={{ __html: mdToHtml(node.help, true) }} />}
    </div>
  );
}

function TxnList({ node, txns, onPick }: { node: Node; txns: Txn[]; onPick: (t: Txn) => void }) {
  const list = txns.length ? txns : [];
  if (!list.length) return <Table node={node} />;
  return (
    <ul className="txns">
      {list.map((t, i) => (
        <li key={i}>
          <button onClick={() => onPick(t)}>
            <span className="txn-main">
              <span className="txn-desc">{t.description}</span>
              <span className="txn-amt">{fmtCell('Amount', t.amount)}</span>
            </span>
            <span className="txn-sub">
              <span>{t.date.slice(5).replace('-', '/')}</span>
              <span className="txn-cat">{t.category}</span>
              {t.note && <span className="txn-note">{t.note}</span>}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

interface Ctx { txns: Txn[]; onPick: (t: Txn) => void; inGroup: boolean }

function isMetricish(n: Node) {
  return n.type === 'metric' || n.type === 'chart';
}

function render(n: Node, ctx: Ctx, key: number | string): ReactNode {
  const kids = (c: Ctx = ctx) => (n.children || []).map((k, i) => render(k, c, i));
  switch (n.type) {
    case 'root':
    case 'container':
    case 'column':
      return <div key={key} className={n.type === 'column' ? 'col' : undefined}>{kids()}</div>;
    case 'title':
    case 'button':
    case 'data_editor':
    case 'chat':
    case 'status':
      return null;
    case 'header':
      return <h2 key={key}>{n.text}</h2>;
    case 'subheader':
      return <h3 key={key}>{n.text}</h3>;
    case 'caption':
      // The desktop's table instructions; the phone list has its own.
      if (/edit them in the table below/.test(n.text || '')) return <p key={key} className="caption">Every transaction this month, newest first. Tap one to change its category, note or reimbursement.</p>;
      return <p key={key} className="caption" dangerouslySetInnerHTML={{ __html: mdToHtml(n.text || '', true) }} />;
    case 'markdown':
      return <div key={key} className="md" dangerouslySetInnerHTML={{ __html: mdToHtml(n.text || '') }} />;
    case 'html':
      return <div key={key} className="rawhtml" dangerouslySetInnerHTML={{ __html: safeHtml(n.text || '') }} />;
    case 'code':
      return <pre key={key} className="code">{n.text}</pre>;
    case 'divider':
      return <hr key={key} />;
    case 'alert':
      return <div key={key} className={`alert ${n.level}`} dangerouslySetInnerHTML={{ __html: mdToHtml(n.text || '') }} />;
    case 'metric':
      return <Metric key={key} node={n} />;
    case 'chart':
      return n.index && n.series ? <LineChart key={key} index={n.index} series={n.series} /> : null;
    case 'dataframe': {
      if ((n.columns || []).join() === '_' || !(n.rows || []).length && !n.selectable) return null;
      if (n.key === 'recent_txns') return <TxnList key={key} node={n} txns={ctx.txns} onPick={ctx.onPick} />;
      return ctx.inGroup ? <DetailTable key={key} node={n} /> : <Table key={key} node={n} />;
    }
    case 'expander':
      return (
        <details key={key} className="group" open={n.expanded}>
          <summary>{n.label}</summary>
          <div className="group-body">{kids({ ...ctx, inGroup: true })}</div>
        </details>
      );
    case 'columns': {
      const cols = n.children || [];
      const allMetric = cols.every((c) => (c.children || []).length > 0 && (c.children || []).every(isMetricish))
        || cols.every((c) => (c.children || []).every(isMetricish));
      if (allMetric) {
        return <div key={key} className={cols.length >= 5 && cols.length % 2 === 1 ? 'metrics three' : 'metrics'}>{cols.map((c, i) => <div key={i} className="metric-cell">{(c.children || []).map((k, j) => render(k, ctx, j))}</div>)}</div>;
      }
      return <div key={key} className="stack">{kids()}</div>;
    }
    default:
      return n.text ? <p key={key}>{n.text}</p> : null;
  }
}

export function Tree({ node, txns, onPick }: { node: Node; txns: Txn[]; onPick: (t: Txn) => void }) {
  return <>{render(node, { txns, onPick, inGroup: false }, 'root')}</>;
}
