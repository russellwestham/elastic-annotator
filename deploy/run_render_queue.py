#!/usr/bin/env python3
import json
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

HOST = 'http://127.0.0.1:8000'
MATCHES = ['J03WN1', 'J03WOH', 'J03WOY', 'J03WPY', 'J03WQQ', 'J03WR9']
DATASET_ROOT = '/home/ubuntu/data/sportec'
ANNOTATOR = 'server-render-queue'
POLL_SEC = 20


def now():
    return datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')


def log(msg):
    print(f'[{now()}] {msg}', flush=True)


def api(method, path, payload=None):
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(HOST + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode('utf-8'))


def api_retry(method, path, payload=None):
    while True:
        try:
            return api(method, path, payload)
        except Exception as e:
            log(f'API retry {method} {path}: {e}')
            time.sleep(5)


def get_processing(match_id):
    mid = urllib.parse.quote(match_id, safe='')
    rows = api_retry('GET', f'/api/sessions?status=processing&match_id={mid}&limit=5')
    return rows[0] if rows else None


def get_reusable_ready(match_id):
    mid = urllib.parse.quote(match_id, safe='')
    rows = api_retry('GET', f'/api/sessions?status=ready&match_id={mid}&limit=20')
    reusable = [row for row in rows if len(row.get('video_urls') or []) > 0]
    if not reusable:
        return None
    reusable.sort(key=lambda row: row.get('updated_at') or '', reverse=True)
    return reusable[0]


def create_or_attach(match_id):
    ready = get_reusable_ready(match_id)
    if ready:
        vc = len(ready.get('video_urls') or [])
        log(f'Reuse ready session {ready["session_id"]} for {match_id} (videos={vc})')
        return ready['session_id']
    ex = get_processing(match_id)
    if ex:
        log(f'Attach existing session {ex["session_id"]} for {match_id}')
        return ex['session_id']
    payload = {
        'annotator_name': ANNOTATOR,
        'match_id': match_id,
        'dataset_root': DATASET_ROOT,
        'generate_video': True,
    }
    out = api_retry('POST', '/api/sessions', payload)
    log(f'Created session {out["session_id"]} for {match_id}')
    return out['session_id']


def wait_terminal(match_id, sid):
    while True:
        info = api_retry('GET', f'/api/sessions/{sid}')
        st = info.get('status')
        pr = info.get('progress')
        vc = len(info.get('video_urls') or [])
        log(f'{match_id} {sid} status={st} progress={pr} videos={vc}')
        if st in ('ready', 'error'):
            return info
        time.sleep(POLL_SEC)


def run_match(match_id):
    sid = create_or_attach(match_id)
    info = wait_terminal(match_id, sid)
    if info.get('status') == 'error':
        log(f'{match_id} failed once; resume {sid}')
        api_retry('POST', f'/api/sessions/{sid}/resume?force=true')
        info = wait_terminal(match_id, sid)
    return {
        'match_id': match_id,
        'session_id': sid,
        'status': info.get('status'),
        'video_count': len(info.get('video_urls') or []),
        'error_message': info.get('error_message'),
    }


def main():
    log('Server render queue started')
    # health wait
    while True:
        try:
            if api('GET', '/api/health').get('status') == 'ok':
                break
        except Exception:
            pass
        time.sleep(3)

    results = []
    for m in MATCHES:
        results.append(run_match(m))

    summary = {
        'finished_at': now(),
        'matches': MATCHES,
        'results': results,
    }
    out_path = '/home/ubuntu/elastic-annotator/backend/storage/render_queue_summary.json'
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    log(f'Queue completed. summary={out_path}')
    print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)


if __name__ == '__main__':
    main()
