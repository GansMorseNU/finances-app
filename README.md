# Finances (phone)

Phone version of a personal budget dashboard. It contains **no financial data**: at run
time the app signs in to the owner's Dropbox, reads the `Finances` folder, and runs that
folder's own Python (`dashboard.py`, `build_master.py`) in the browser with
[Pyodide](https://pyodide.org). The desktop dashboard and this app therefore always show
the same numbers from the same code.

- `public/py/streamlit/` — a headless stand-in for Streamlit: records what `dashboard.py`
  draws so the app can lay it out for a phone, and answers its buttons.
- `public/py/gspread.py` — stand-in for gspread; Tiller sheets are fetched by the app.
- `public/py/phone_runner.py` — runs the dashboard / its buttons and reports changed files.
- `src/worker/py.worker.ts` — Pyodide in a Web Worker.
- `src/lib/engine.ts` — keeps a copy of the folder in step with Dropbox (revision-checked
  uploads, so a newer file is never overwritten).

Published to GitHub Pages by `.github/workflows/deploy-pages.yml` on every push to `main`.
