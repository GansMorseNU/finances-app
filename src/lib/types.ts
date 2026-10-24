export interface Node {
  type: string;
  children?: Node[];
  text?: string;
  label?: string;
  value?: string | number | null;
  delta?: string | number | null;
  deltaColor?: string;
  help?: string | null;
  level?: string;
  expanded?: boolean;
  key?: string | null;
  selectable?: boolean;
  columns?: string[];
  rows?: (string | number | boolean | null)[][];
  chart?: string;
  index?: (string | number | null)[];
  series?: Record<string, (number | null)[]>;
  weights?: number[];
}

export interface Txn {
  date: string;
  description: string;
  amount: number;
  category: string;
  note: string;
  source: string;
  card: string | number | null;
  rules: [string, string][];
  pattern: string;
}

export interface DashResult {
  tree: Node;
  months: string[];
  month: string | null;
  categories: string[];
  transactions: Txn[];
  error: string | null;
  actionAlerts: { level: string; text: string }[];
  actionError: string | null;
  log: string;
}
