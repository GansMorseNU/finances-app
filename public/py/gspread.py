"""Minimal stand-in for the gspread library, for running build_master.py and
bank_reconciliation.py inside the phone app (Pyodide), where gspread itself cannot run.

Covers exactly what those scripts use:
    gc = gspread.service_account(filename=...)
    sh = gc.open_by_key(SHEET_ID)
    sh.worksheet(title).get_all_values()

The actual fetching is supplied by the host: set `gspread.FETCH = f` where
f(sheet_id, title) returns the sheet's values as a list of rows (or a JSON string of
that). Rows are padded to a rectangle, as real gspread's get_all_values() does.
"""
import json

FETCH = None


class WorksheetNotFound(Exception):
    pass


class _Worksheet:
    def __init__(self, title, values):
        self.title = title
        self._values = values

    def get_all_values(self):
        rows = [list(r) for r in self._values]
        width = max((len(r) for r in rows), default=0)
        return [r + [''] * (width - len(r)) for r in rows]


class _Spreadsheet:
    def __init__(self, key):
        self.id = key

    def worksheet(self, title):
        if FETCH is None:
            raise RuntimeError("gspread shim: no fetch function configured")
        vals = FETCH(self.id, title)
        if hasattr(vals, 'to_py'):          # a JS object handed over by Pyodide
            vals = vals.to_py()
        if isinstance(vals, str):
            vals = json.loads(vals)
        if vals is None:
            raise WorksheetNotFound(title)
        return _Worksheet(title, [['' if c is None else str(c) for c in r] for r in vals])


class _Client:
    def open_by_key(self, key):
        return _Spreadsheet(key)


def service_account(filename=None, **kwargs):
    return _Client()
