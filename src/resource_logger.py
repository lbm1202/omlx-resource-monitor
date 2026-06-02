#!/usr/bin/env python3
"""omlx-resource-monitor logger + SSE server.

Single-process Python sidecar (stdlib only) that:

  1. Samples system resources at 2 Hz:
       - CPU/GPU/RAM/power/temperature via macmon (`http://127.0.0.1:9090/json`)
       - Memory pressure level / swap / compressor via `sysctl` + `vm_stat`
       - macOS Activity Monitor's "free %" via `memory_pressure`
       - oMLX memory breakdown + per-request activity via `/admin/api/stats`

  2. Appends a 1 Hz subsample to a JSON Lines archive (default: ~/resource-logs/).
     Rolls daily at midnight, gzip-compresses the previous day, keeps 30 days.

  3. Holds the most recent 1 hour of samples in memory.

  4. Serves an SSE stream at http://127.0.0.1:9091/stream where:
       - On connect: seed message with the 1-hour buffer.
       - Every tick: tick message with the new sample point.

A companion `/state` endpoint returns the current in-memory state as JSON
for debugging (`curl … | jq`).

The panel (panel.js) connects via EventSource — there are no JSON feed
files. The on-disk log is for archival/analysis only.

Cookie auth: the logger reuses oMLX's admin API key from
`~/.omlx/settings.json` to authenticate stats fetches.
"""

import datetime
import glob
import gzip
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


# ── Paths ────────────────────────────────────────────────────────────────────
LOG_DIR = os.path.expanduser(os.environ.get('OMLX_MONITOR_LOG_DIR', '~/resource-logs'))
ACTIVE_LOG = os.path.join(LOG_DIR, 'resource.log')

OMLX_SETTINGS = os.path.expanduser(os.environ.get('OMLX_SETTINGS_PATH', '~/.omlx/settings.json'))


# ── Endpoints ────────────────────────────────────────────────────────────────
MACMON_URL = os.environ.get('MACMON_URL', 'http://127.0.0.1:9090/json')
OMLX_BASE = os.environ.get('OMLX_BASE', 'http://127.0.0.1:8000')

SSE_BIND = os.environ.get('OMLX_MONITOR_SSE_BIND', '127.0.0.1')
SSE_PORT = int(os.environ.get('OMLX_MONITOR_SSE_PORT', '9091'))


# ── Timing ───────────────────────────────────────────────────────────────────
# 2 Hz collect → live SSE push.   1 Hz on-disk archive (drift-free counter).
# One full cycle ≈ 18 ms × 2 Hz ≈ 3.6 % of one core on M4 Max.
INTERVAL_S = 0.5
DISK_LOG_INTERVAL_S = 1.0
RECENT_WINDOW_S = 3600          # rolling memory buffer = SSE seed window
RETENTION_DAYS = 30


# ── Constants ────────────────────────────────────────────────────────────────
GB = 1024 ** 3
PAGE_SIZE = 16384                                  # Apple Silicon page size
PRESSURE_LABELS = {1: 'normal', 2: 'warning', 4: 'critical'}


# ── Module state ─────────────────────────────────────────────────────────────
_recent = []                    # last RECENT_WINDOW_S worth of panel points (memory)
_omlx_cookie = None             # cached oMLX admin session cookie
_archive_tick = 0               # drift-free counter for 1 Hz archive sampling
_last_activity = {              # current PP/TG snapshot, embedded in every SSE message
    'ts': 0, 'total_active': 0, 'total_waiting': 0, 'models': [],
}
_sse_clients = []               # list of connected client wfile objects
_lock = threading.Lock()        # guards _recent + _sse_clients


# ═════════════════════════════════════════════════════════════════════════════
# Data sources
# ═════════════════════════════════════════════════════════════════════════════

def fetch_macmon():
    """CPU/GPU/RAM/power/temperature snapshot from macmon's HTTP server."""
    try:
        with urllib.request.urlopen(MACMON_URL, timeout=3) as r:
            d = json.load(r)
        return None if d.get('error') else d
    except Exception:
        return None


def sysctl(key):
    return subprocess.check_output(['sysctl', '-n', key], text=True).strip()


def parse_swap(line):
    """Parse 'used = N.NNM' from `sysctl vm.swapusage` output (MB → GB)."""
    m = re.search(r'used\s*=\s*([\d.]+)M', line)
    return float(m.group(1)) if m else 0.0


def parse_vm_stat():
    """Parse `vm_stat` output into { 'Pages X': count } dict."""
    out = subprocess.check_output(['vm_stat'], text=True)
    pages = {}
    for line in out.splitlines():
        m = re.match(r'^(.+?):\s+(\d+)\.', line)
        if m:
            pages[m.group(1).strip()] = int(m.group(2))
    return pages


def memory_free_pct():
    """`memory_pressure` command's 'System-wide memory free percentage'.

    This is the exact value Activity Monitor's memory-pressure graph uses.
    Pressure = 100 - free%.
    """
    try:
        out = subprocess.check_output(['memory_pressure'], text=True, timeout=3)
        m = re.search(r'free percentage:\s*(\d+)\s*%', out)
        return int(m.group(1)) if m else None
    except Exception:
        return None


# ── oMLX admin API ───────────────────────────────────────────────────────────
def _omlx_api_key():
    """Read oMLX's own admin API key from its settings.json (same user)."""
    try:
        with open(OMLX_SETTINGS) as f:
            s = json.load(f)
        auth = s.get('auth', {})
        if auth.get('api_key'):
            return auth['api_key']
        keys = auth.get('keys') or []
        if keys and isinstance(keys[0], dict):
            return keys[0].get('key')
    except Exception:
        pass
    return None


def _omlx_login():
    """POST /admin/api/login → cache session cookie. Returns True on success."""
    global _omlx_cookie
    key = _omlx_api_key()
    if not key:
        return False
    try:
        req = urllib.request.Request(
            OMLX_BASE + '/admin/api/login',
            data=json.dumps({'api_key': key}).encode(),
            headers={'Content-Type': 'application/json'},
            method='POST',
        )
        with urllib.request.urlopen(req, timeout=3) as r:
            cookies = r.headers.get_all('Set-Cookie') or []
        _omlx_cookie = '; '.join(c.split(';', 1)[0] for c in cookies)
        return bool(_omlx_cookie)
    except Exception:
        _omlx_cookie = None
        return False


def fetch_omlx_stats():
    """GET /admin/api/stats with cookie auth; one retry after re-login on 401/403."""
    global _omlx_cookie
    for _ in range(2):
        if not _omlx_cookie and not _omlx_login():
            return None
        try:
            req = urllib.request.Request(
                OMLX_BASE + '/admin/api/stats',
                headers={'Cookie': _omlx_cookie},
            )
            with urllib.request.urlopen(req, timeout=3) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                _omlx_cookie = None
                continue
            return None
        except Exception:
            return None
    return None


# ═════════════════════════════════════════════════════════════════════════════
# Sample collection
# ═════════════════════════════════════════════════════════════════════════════

def collect():
    """Build one sample record. Tolerant to any source failing — returns
    whatever it could gather. Caller (main loop) handles its own errors."""
    rec = {
        # 2 Hz cadence → ms precision so two records in the same wall-clock second are distinct.
        'ts': round(time.time(), 3),
        'iso': datetime.datetime.now().isoformat(timespec='milliseconds'),
    }

    # macmon — CPU/GPU/power/RAM/temperature
    m = fetch_macmon()
    if m:
        gpu = m.get('gpu_usage') or [0, 0]
        ecpu = m.get('ecpu_usage') or [0, 0]
        pcpu = m.get('pcpu_usage') or [0, 0]
        mem = m.get('memory') or {}
        temp = m.get('temp') or {}
        rec['cpu'] = round((m.get('cpu_usage_pct') or 0) * 100, 2)
        rec['gpu'] = round((gpu[1] if len(gpu) > 1 else 0) * 100, 2)
        rec['gpu_mhz'] = gpu[0] if gpu else 0
        rec['pcpu'] = round((pcpu[1] if len(pcpu) > 1 else 0) * 100, 1)
        rec['ecpu'] = round((ecpu[1] if len(ecpu) > 1 else 0) * 100, 1)
        rec['cpu_power'] = round(m.get('cpu_power') or 0, 3)
        rec['gpu_power'] = round(m.get('gpu_power') or 0, 3)
        rec['all_power'] = round(m.get('all_power') or 0, 3)
        rec['ram_used_gb'] = round((mem.get('ram_usage') or 0) / GB, 2)
        rec['ram_total_gb'] = round((mem.get('ram_total') or 0) / GB, 2)
        rec['cpu_temp'] = round(temp.get('cpu_temp_avg') or 0, 1)
        rec['gpu_temp'] = round(temp.get('gpu_temp_avg') or 0, 1)

    # Memory pressure — direct sysctl/vm_stat (independent of macmon)
    try:
        level = int(sysctl('kern.memorystatus_vm_pressure_level'))
        rec['pressure'] = level
        rec['pressure_label'] = PRESSURE_LABELS.get(level, 'unknown')
        rec['swap_gb'] = round(parse_swap(sysctl('vm.swapusage')) / 1024, 3)
        pages = parse_vm_stat()
        gb = lambda k: round(pages.get(k, 0) * PAGE_SIZE / GB, 2)
        rec['compressor_gb'] = gb('Pages occupied by compressor')
        rec['active_gb'] = gb('Pages active')
        rec['wired_gb'] = gb('Pages wired down')
    except Exception as e:
        print(f'pressure collect error: {e}', file=sys.stderr, flush=True)

    # Activity Monitor's "free %" — the source of its color band
    fp = memory_free_pct()
    if fp is not None:
        rec['free_pct'] = fp

    # oMLX memory breakdown + PP/TG activity — single stats call serves both
    try:
        st = fetch_omlx_stats()
        if st:
            am = st.get('active_models') or {}
            rc = st.get('runtime_cache') or {}
            models = am.get('models') or []
            model_bytes = sum((mm.get('actual_size') or 0) for mm in models)
            kv_bytes = rc.get('hot_cache_size_bytes') or 0
            mp = am.get('memory_pressure') or {}
            current_bytes = mp.get('current_bytes') or 0
            rec['model_gb'] = round(model_bytes / GB, 2)
            rec['hot_cache_gb'] = round(kv_bytes / GB, 2)
            rec['omlx_gb'] = round(current_bytes / GB, 2)
            rec['runtime_gb'] = round(max(0, current_bytes - model_bytes - kv_bytes) / GB, 2)
            if 'ram_used_gb' in rec:
                rec['mac_other_gb'] = round(max(0.0, rec['ram_used_gb'] - current_bytes / GB), 2)
            # Loaded model identifiers — only in raw log, used for "what model was loaded at X?" analysis
            rec['loaded_models'] = [
                {
                    'id': mm.get('id'),
                    'size_gb': round((mm.get('actual_size') or 0) / GB, 2),
                    'is_loading': mm.get('is_loading', False),
                }
                for mm in models
            ]
            # Update the activity snapshot embedded in every SSE message
            _update_activity_snapshot(rec['ts'], am, models)
    except Exception as e:
        print(f'omlx stats collect error: {e}', file=sys.stderr, flush=True)

    return rec


def _update_activity_snapshot(ts, am, models):
    """Refresh the current PP/TG snapshot held in memory."""
    global _last_activity
    _last_activity = {
        'ts': ts,
        'total_active': am.get('total_active_requests') or 0,
        'total_waiting': am.get('total_waiting_requests') or 0,
        # oMLX already filters to loaded/loading models — no extra filtering here.
        'models': [
            {
                'id': mm.get('id'),
                'is_loading': mm.get('is_loading', False),
                'loading_elapsed_seconds': mm.get('loading_elapsed_seconds'),
                'waiting_requests': mm.get('waiting_requests', 0),
                'prefilling': mm.get('prefilling') or [],
                'generating': mm.get('generating') or [],
            }
            for mm in models
        ],
    }


# ═════════════════════════════════════════════════════════════════════════════
# Panel point (stripped record for the browser)
# ═════════════════════════════════════════════════════════════════════════════

def rec_to_point(rec):
    """Project a full log record into the smaller shape the panel needs."""
    if 'cpu' not in rec:
        return None
    ram_total = rec.get('ram_total_gb') or 0
    ram_pct = round(rec['ram_used_gb'] / ram_total * 100, 2) if ram_total else 0
    return {
        't': rec['ts'] * 1000,            # epoch ms — what the browser uses
        'cpu': rec['cpu'],
        'gpu': rec['gpu'],
        'ram': ram_pct,
        'pressure': rec.get('pressure', 1),
        'free_pct': rec.get('free_pct'),
        'comp': rec.get('compressor_gb', 0),
        'swap': rec.get('swap_gb', 0),
        'cpu_power': rec.get('cpu_power', 0),
        'gpu_power': rec.get('gpu_power', 0),
        'pcpu': rec.get('pcpu', 0),
        'ecpu': rec.get('ecpu', 0),
        'gpu_mhz': rec.get('gpu_mhz', 0),
        'ram_used_gb': rec.get('ram_used_gb', 0),
        'ram_total_gb': rec.get('ram_total_gb', 0),
        'cpu_temp': rec.get('cpu_temp', 0),
        'gpu_temp': rec.get('gpu_temp', 0),
        # Memory breakdown — None if oMLX stats unavailable; panel skips those points.
        'model_gb': rec.get('model_gb'),
        'hot_cache_gb': rec.get('hot_cache_gb'),
        'runtime_gb': rec.get('runtime_gb'),
        'omlx_gb': rec.get('omlx_gb'),
        'mac_other_gb': rec.get('mac_other_gb'),
    }


def update_recent(rec):
    """Append point to the in-memory buffer and broadcast to SSE clients."""
    pt = rec_to_point(rec)
    if pt is None:
        return
    with _lock:
        _recent.append(pt)
        cutoff_ms = time.time() * 1000 - RECENT_WINDOW_S * 1000
        while _recent and _recent[0]['t'] < cutoff_ms:
            _recent.pop(0)
    sse_broadcast({'type': 'tick', 'point': pt, 'activity': _last_activity})


def seed_recent_from_log():
    """On startup, replay the tail of resource.log to repopulate the buffer."""
    if not os.path.exists(ACTIVE_LOG):
        return
    try:
        # 1 Hz archive × 3600 s + slack
        with open(ACTIVE_LOG) as f:
            tail = f.readlines()[-(RECENT_WINDOW_S + 50):]
        cutoff_ms = time.time() * 1000 - RECENT_WINDOW_S * 1000
        for line in tail:
            line = line.strip()
            if not line:
                continue
            try:
                pt = rec_to_point(json.loads(line))
            except Exception:
                continue
            if pt and pt['t'] >= cutoff_ms:
                _recent.append(pt)
    except Exception as e:
        print(f'seed_recent error: {e}', file=sys.stderr, flush=True)


# ═════════════════════════════════════════════════════════════════════════════
# SSE server
# ═════════════════════════════════════════════════════════════════════════════
# One handler thread per connected client. The main collect loop calls
# sse_broadcast() to push to every wfile. First message on connect is a
# 'seed' with the full in-memory buffer + last activity. Then 'tick'
# messages every 0.5 s.

def _sse_format(msg):
    return f'data: {json.dumps(msg, ensure_ascii=False, separators=(",", ":"))}\n\n'.encode('utf-8')


def sse_broadcast(msg):
    payload = _sse_format(msg)
    dead = []
    with _lock:
        for c in _sse_clients:
            try:
                c.write(payload)
                c.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                dead.append(c)
        for d in dead:
            _sse_clients.remove(d)


class _SSEHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # silence access logs

    def do_GET(self):
        if self.path == '/state':
            self._handle_state()
        elif self.path == '/stream':
            self._handle_stream()
        else:
            self.send_response(404)
            self.end_headers()

    def _handle_state(self):
        """Debug endpoint — current in-memory snapshot as pretty JSON."""
        with _lock:
            payload = {
                'now_ms': int(time.time() * 1000),
                'recent_count': len(_recent),
                'recent_first_t': _recent[0]['t'] if _recent else None,
                'recent_last': _recent[-1] if _recent else None,
                'activity': _last_activity,
                'sse_clients': len(_sse_clients),
            }
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle_stream(self):
        try:
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Connection', 'keep-alive')
            self.send_header('X-Accel-Buffering', 'no')   # tell nginx not to buffer
            self.end_headers()

            with _lock:
                seed = {'type': 'seed', 'points': list(_recent), 'activity': _last_activity}
            self.wfile.write(_sse_format(seed))
            self.wfile.flush()

            with _lock:
                _sse_clients.append(self.wfile)

            # Stay alive — actual push is from the main thread via sse_broadcast.
            while True:
                time.sleep(30)
                self.wfile.write(b': keep-alive\n\n')
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with _lock:
                if self.wfile in _sse_clients:
                    _sse_clients.remove(self.wfile)


def start_sse_server():
    srv = ThreadingHTTPServer((SSE_BIND, SSE_PORT), _SSEHandler)
    t = threading.Thread(target=srv.serve_forever, daemon=True, name='sse-server')
    t.start()
    print(f'SSE server: {SSE_BIND}:{SSE_PORT}/stream', flush=True)


# ═════════════════════════════════════════════════════════════════════════════
# Log archive (1 Hz append, daily gzip rotation, 30-day retention)
# ═════════════════════════════════════════════════════════════════════════════

def append_line(rec):
    with open(ACTIVE_LOG, 'a') as f:
        f.write(json.dumps(rec, ensure_ascii=False) + '\n')


def maybe_archive(rec):
    """Append every N-th collect tick (N = DISK_LOG_INTERVAL_S / INTERVAL_S).

    Counter-based so scheduling jitter doesn't accumulate drift over time.
    """
    global _archive_tick
    every = max(1, round(DISK_LOG_INTERVAL_S / INTERVAL_S))
    if _archive_tick % every == 0:
        append_line(rec)
    _archive_tick += 1


def cleanup_old():
    """Delete rotated logs older than RETENTION_DAYS. Handles .log and .log.gz."""
    cutoff = datetime.date.today() - datetime.timedelta(days=RETENTION_DAYS)
    for path in glob.glob(os.path.join(LOG_DIR, '*-resource.log*')):
        name = os.path.basename(path)
        if name.endswith('.log.gz'):
            date_part = name[:-len('-resource.log.gz')]
        elif name.endswith('.log'):
            date_part = name[:-len('-resource.log')]
        else:
            continue
        try:
            d = datetime.date.fromisoformat(date_part)
        except ValueError:
            continue
        if d < cutoff:
            try:
                os.remove(path)
                print(f'cleaned old log: {name}', flush=True)
            except OSError:
                pass


def active_log_day():
    if not os.path.exists(ACTIVE_LOG):
        return datetime.date.today()
    return datetime.date.fromtimestamp(os.path.getmtime(ACTIVE_LOG))


def rotate(ended_day):
    """Gzip the active log to <date>-resource.log.gz. JSON Lines compresses ~8x."""
    if not os.path.exists(ACTIVE_LOG):
        return
    dest = os.path.join(LOG_DIR, f'{ended_day.isoformat()}-resource.log.gz')
    # If a same-date archive already exists, append as a concat'd gzip member (gunzip handles it).
    mode = 'ab' if os.path.exists(dest) else 'wb'
    with open(ACTIVE_LOG, 'rb') as src, gzip.open(dest, mode, compresslevel=6) as dst:
        while True:
            chunk = src.read(64 * 1024)
            if not chunk:
                break
            dst.write(chunk)
    os.remove(ACTIVE_LOG)
    print(f'rotated → {os.path.basename(dest)} (gzipped)', flush=True)


# ═════════════════════════════════════════════════════════════════════════════
# Main loop
# ═════════════════════════════════════════════════════════════════════════════

def main():
    os.makedirs(LOG_DIR, exist_ok=True)

    current_day = active_log_day()
    if current_day != datetime.date.today():
        rotate(current_day)
        current_day = datetime.date.today()
    cleanup_old()
    seed_recent_from_log()
    start_sse_server()

    print(
        f'logger started — collect every {INTERVAL_S}s, archive every {DISK_LOG_INTERVAL_S}s, '
        f'log: {ACTIVE_LOG}',
        flush=True,
    )

    next_tick = time.monotonic()
    while True:
        try:
            today = datetime.date.today()
            if today != current_day:
                rotate(current_day)
                cleanup_old()
                current_day = today
            rec = collect()
            maybe_archive(rec)        # 1 Hz on disk
            update_recent(rec)        # 2 Hz in memory + SSE push
        except Exception as e:
            print(f'main loop error: {e}', file=sys.stderr, flush=True)
        next_tick += INTERVAL_S
        delay = next_tick - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        else:
            next_tick = time.monotonic()


if __name__ == '__main__':
    main()
