"""Headless stand-in for Streamlit, used by the phone app.

dashboard.py runs unchanged inside the phone (Pyodide). Instead of drawing a web page,
every st.* call is recorded as a node in a tree, which the phone app then renders in a
phone layout. Widgets return values chosen by the phone:

  CONTROL['month']        value returned by the sidebar "Month" selectbox (None = default)
  CONTROL['press']        set of button labels that should return True this run
  CONTROL['select']       {dataframe key: [row positions]} for selectable tables
  CONTROL['select_match'] {dataframe key: [ {col: value} ]} rows to find by content
  CONTROL['edits']        list of dicts applied, row by row, to the frame passed to
                          st.data_editor (only the keys present are changed)
  CONTROL['toggles']      default value of st.toggle (True: record every detail table)
"""
import contextlib
import datetime as _dt
import math

import pandas as _pd

CONTROL = {'month': None, 'press': set(), 'select': {}, 'select_match': {}, 'edits': [],
           'toggles': True}


class RerunSignal(Exception):
    """Raised by st.rerun()/st.stop(); the runner treats it as a normal end of run."""


# ------------------------------------------------------------------ recording tree
class _Node:
    def __init__(self, kind, **props):
        self.kind = kind
        self.props = props
        self.children = []

    def to_json(self):
        d = {'type': self.kind}
        d.update(self.props)
        if self.children:
            d['children'] = [c.to_json() for c in self.children]
        return d


ROOT = _Node('root')
SIDEBAR = _Node('sidebar')
_stack = [ROOT]
WIDGETS = {}          # recorded widget options (e.g. month list) for the phone UI


def reset():
    global ROOT, SIDEBAR, _stack
    ROOT = _Node('root')
    SIDEBAR = _Node('sidebar')
    _stack = [ROOT]
    WIDGETS.clear()
    session_state.clear()
    sidebar._node = SIDEBAR


def _cur():
    return _stack[-1]


def _clean(v):
    """JSON-safe scalar."""
    if v is None:
        return None
    if isinstance(v, (bool,)):
        return v
    if isinstance(v, (int,)):
        return v
    if isinstance(v, float):
        return None if math.isnan(v) or math.isinf(v) else v
    try:
        import numpy as _np
        if isinstance(v, _np.bool_):
            return bool(v)
        if isinstance(v, _np.integer):
            return int(v)
        if isinstance(v, _np.floating):
            f = float(v)
            return None if math.isnan(f) or math.isinf(f) else f
    except Exception:
        pass
    if v is _pd.NaT:
        return None
    if isinstance(v, _pd.Timestamp):
        return v.strftime('%Y-%m-%d') if (v.hour, v.minute, v.second) == (0, 0, 0) \
            else v.strftime('%Y-%m-%d %H:%M')
    if isinstance(v, (_dt.datetime, _dt.date)):
        return v.isoformat()[:10]
    if isinstance(v, _pd.Period):
        return str(v)
    try:
        if _pd.isna(v):
            return None
    except Exception:
        pass
    return str(v)


def _frame_json(data):
    if data is None:
        return {'columns': [], 'rows': []}
    if isinstance(data, _pd.Series):
        data = data.to_frame()
    if not isinstance(data, _pd.DataFrame):
        data = _pd.DataFrame(data)
    df = data
    return {'columns': [str(c) for c in df.columns],
            'rows': [[_clean(v) for v in row] for row in df.itertuples(index=False, name=None)]}


class _Container:
    """Anything usable as `with x:` and with st-like methods (columns, expanders,
    containers, sidebar)."""

    def __init__(self, node):
        self._node = node

    def __enter__(self):
        _stack.append(self._node)
        return self

    def __exit__(self, *exc):
        _stack.pop()
        return False

    def __getattr__(self, name):
        if name.startswith('__'):
            raise AttributeError(name)
        fn = globals().get(name)
        if fn is None or not callable(fn):
            fn = _unknown(name)

        def call(*a, **k):
            _stack.append(self._node)
            try:
                return fn(*a, **k)
            finally:
                _stack.pop()
        return call


def _add(kind, **props):
    n = _Node(kind, **props)
    _cur().children.append(n)
    return n


# ------------------------------------------------------------------ text and alerts
def set_page_config(*a, **k):
    pass


def title(body, *a, **k):
    _add('title', text=str(body))


def header(body, *a, **k):
    _add('header', text=str(body))


def subheader(body, *a, **k):
    _add('subheader', text=str(body))


def caption(body, *a, **k):
    _add('caption', text=str(body))


def markdown(body, unsafe_allow_html=False, *a, **k):
    _add('html' if unsafe_allow_html else 'markdown', text=str(body))


def write(*args, **k):
    for x in args:
        if isinstance(x, (_pd.DataFrame, _pd.Series)):
            dataframe(x)
        else:
            markdown(str(x))


text = markdown


def code(body, *a, **k):
    _add('code', text=str(body))


def _alert(kind):
    def f(body, *a, **k):
        _add('alert', level=kind, text=str(body))
    return f


info, warning, success, error = (_alert(x) for x in ('info', 'warning', 'success', 'error'))


def exception(e, *a, **k):
    _add('alert', level='error', text=str(e))


def metric(label, value, delta=None, delta_color='normal', help=None, *a, **k):
    _add('metric', label=str(label), value=_clean(value), delta=_clean(delta),
         deltaColor=delta_color, help=help)


def divider(*a, **k):
    _add('divider')


# ------------------------------------------------------------------ data
class _Selection(dict):
    def __getattr__(self, k):
        try:
            return self[k]
        except KeyError:
            raise AttributeError(k)


def _find_rows(df, matches):
    pos = []
    for m in matches:
        for i, row in enumerate(df.itertuples(index=False)):
            rd = dict(zip(df.columns, row))
            if all(str(_clean(rd.get(c))) == str(v) for c, v in m.items()):
                pos.append(i)
                break
    return pos


def dataframe(data=None, *a, key=None, on_select='ignore', selection_mode=None, **k):
    fj = _frame_json(data)
    _add('dataframe', key=key, selectable=on_select not in (None, 'ignore'), **fj)
    if on_select not in (None, 'ignore'):
        rows = list(CONTROL['select'].get(key, []))
        if key in CONTROL['select_match'] and isinstance(data, _pd.DataFrame):
            rows = _find_rows(data, CONTROL['select_match'][key])
        return _Selection(selection=_Selection(rows=rows, columns=[]))
    return None


table = dataframe


def data_editor(data, *a, key=None, **k):
    df = data.copy()
    for i, edit in enumerate(CONTROL['edits']):
        if i >= len(df):
            break
        for col, val in edit.items():
            if col in df.columns:
                df.iat[i, df.columns.get_loc(col)] = val
    _add('data_editor', key=key, **_frame_json(df))
    return df


def _chart(kind):
    def f(data=None, *a, height=None, **k):
        if isinstance(data, _pd.Series):
            data = data.to_frame()
        if isinstance(data, _pd.DataFrame):
            idx = [_clean(v) for v in data.index]
            series = {str(c): [_clean(v) for v in data[c].tolist()] for c in data.columns}
        else:
            idx, series = [], {}
        _add('chart', chart=kind, index=idx, series=series, height=height)
    return f


line_chart, bar_chart, area_chart = (_chart(x) for x in ('line', 'bar', 'area'))


class _ColumnConfig:
    def __getattr__(self, name):
        return lambda *a, **k: None


column_config = _ColumnConfig()


# ------------------------------------------------------------------ layout
def columns(spec, *a, **k):
    n = spec if isinstance(spec, int) else len(spec)
    weights = [1] * n if isinstance(spec, int) else list(spec)
    row = _add('columns', weights=weights)
    cols = []
    for _ in range(n):
        c = _Node('column')
        row.children.append(c)
        cols.append(_Container(c))
    return cols


def expander(label, expanded=False, *a, **k):
    return _Container(_add('expander', label=str(label), expanded=bool(expanded)))


def container(*a, height=None, **k):
    return _Container(_add('container', height=height))


def popover(label, *a, **k):
    return _Container(_add('expander', label=str(label), expanded=False))


def tabs(labels, *a, **k):
    return [_Container(_add('expander', label=str(l), expanded=True)) for l in labels]


def empty(*a, **k):
    return _Container(_add('container'))


@contextlib.contextmanager
def spinner(*a, **k):
    yield


class _Status(_Container):
    def update(self, *a, **k):
        pass

    def write(self, *a, **k):
        pass


def status(label='', *a, **k):
    return _Status(_Node('status'))


def chat_message(*a, **k):
    return _Container(_Node('chat'))      # not shown on the phone


def chat_input(*a, **k):
    return None


# ------------------------------------------------------------------ widgets
def button(label, *a, **k):
    pressed = any(str(label).startswith(p) for p in CONTROL['press'])
    _add('button', label=str(label))
    return pressed


def toggle(label, value=False, *a, **k):
    return CONTROL['toggles']


checkbox = toggle


def selectbox(label, options, index=0, *a, **k):
    options = list(options)
    WIDGETS[str(label)] = {'options': [_clean(o) for o in options], 'index': index}
    want = CONTROL['month'] if str(label) == 'Month' else None
    if want is not None and want in [str(o) for o in options]:
        return options[[str(o) for o in options].index(want)]
    return options[index] if options else None


def radio(label, options, index=0, *a, **k):
    return selectbox(label, options, index)


def multiselect(label, options, default=None, *a, **k):
    WIDGETS[str(label)] = {'options': [_clean(o) for o in options], 'default': default}
    return list(default or [])


def text_input(label, value='', *a, **k):
    return value


text_area = text_input


def number_input(label, value=0, *a, **k):
    return value


def slider(label, min_value=None, max_value=None, value=None, *a, **k):
    return value


def date_input(label, value=None, *a, **k):
    return value


def form(*a, **k):
    return _Container(_add('container'))


def form_submit_button(label='Submit', *a, **k):
    return button(label)


def rerun(*a, **k):
    raise RerunSignal()


experimental_rerun = rerun


def stop(*a, **k):
    raise RerunSignal()


def toast(*a, **k):
    pass


def balloons(*a, **k):
    pass


# ------------------------------------------------------------------ caching / state
class _Cache:
    def __call__(self, fn=None, **k):
        if fn is None:
            return lambda f: f
        return fn

    def clear(self):
        pass


class _State(dict):
    def __getattr__(self, k):
        try:
            return self[k]
        except KeyError:
            raise AttributeError(k)

    def __setattr__(self, k, v):
        self[k] = v


cache_data = _Cache()
cache_resource = _Cache()
session_state = _State()

sidebar = _Container(SIDEBAR)



# ------------------------------------------------------------------ anything else
def _unknown(name):
    """Streamlit features this stand-in doesn't know: do nothing, but still work as
    `with st.something(...):` so a new dashboard feature never breaks the phone."""
    def f(*a, **k):
        return _Container(_Node('container'))
    return f


def __getattr__(name):
    if name.startswith('__'):
        raise AttributeError(name)
    return _unknown(name)
