"""更新前导出 D1 到同实例私有 R2，保留原业务对象并验证旧列行摘要。"""
from collections import Counter
import hashlib
import json
import os
import sqlite3
import time
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen
from contract import ROOT, Failure, require
from cloudflare import command


def name(value):
    import re
    require(re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', value), 'ASSETLIBRARY_SNAPSHOT_INVALID')
    return '"' + value + '"'


def digest(row):
    return hashlib.sha256(json.dumps(list(row), ensure_ascii=False, separators=(',', ':'),
                                    default=lambda b: {'bytes': bytes(b).hex()}).encode()).hexdigest()


def witness(raw):
    db = sqlite3.connect(':memory:')
    try:
        db.set_authorizer(lambda op, *_: sqlite3.SQLITE_DENY if op in (sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH) else sqlite3.SQLITE_OK)
        db.executescript(raw.decode('utf-8'))
        require(not db.execute('PRAGMA foreign_key_check').fetchall(), 'ASSETLIBRARY_SNAPSHOT_INVALID')
        result = {}
        for (table,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").fetchall():
            columns = [r[1] for r in db.execute('PRAGMA table_info(' + name(table) + ')')]
            rows = db.execute('SELECT ' + ','.join(map(name, columns)) + ' FROM ' + name(table) + ' LIMIT 100001').fetchall()
            require(len(rows) <= 100000 and len(result) < 100, 'ASSETLIBRARY_SNAPSHOT_LIMIT')
            result[table] = {'columns': columns, 'rows': Counter(digest(r) for r in rows)}
        return result
    finally:
        db.close()


def backup(cloud, request, directory):
    endpoint = f"/d1/database/{cloud.config['database']['id']}/export"
    body = {'output_format': 'polling'}
    for _ in range(120):
        result = cloud.call(endpoint, 'POST', body)
        if result.get('status') == 'complete':
            url = result['result']['signed_url']
            parsed = urlsplit(url)
            require(parsed.scheme == 'https' and parsed.hostname.endswith('.cloudflarestorage.com') and not parsed.username,
                    'ASSETLIBRARY_SNAPSHOT_URL_INVALID')
            with urlopen(Request(url), timeout=60) as response:
                raw = response.read(64 * 1024 * 1024 + 1)
            require(0 < len(raw) <= 64 * 1024 * 1024, 'ASSETLIBRARY_SNAPSHOT_LIMIT')
            proof = witness(raw)
            path = directory / 'database-snapshot.sql'
            path.write_bytes(raw)
            key = f"{cloud.config['bucket']}/_sba_backups/{request['taskId']}/{hashlib.sha256(raw).hexdigest()}.sql"
            env = {**os.environ, 'CLOUDFLARE_ACCOUNT_ID': cloud.config['accountId'], 'WRANGLER_SEND_METRICS': 'false'}
            command(['node', str(ROOT / 'node_modules/wrangler/bin/wrangler.js'), 'r2', 'object', 'put', key,
                     '--file', str(path), '--remote'], env=env)
            verify_path = directory / 'database-snapshot-readback.sql'
            command(['node', str(ROOT / 'node_modules/wrangler/bin/wrangler.js'), 'r2', 'object', 'get', key,
                     '--file', str(verify_path), '--remote'], env=env)
            require(hashlib.sha256(verify_path.read_bytes()).digest() == hashlib.sha256(raw).digest(), 'ASSETLIBRARY_BACKUP_UNCONFIRMED')
            return proof
        require(result.get('status') == 'active' and isinstance(result.get('at_bookmark'), str), 'ASSETLIBRARY_BACKUP_UNCONFIRMED')
        body['current_bookmark'] = result['at_bookmark']
        time.sleep(1)
    raise Failure('ASSETLIBRARY_BACKUP_TIMEOUT')


def preserved(cloud, proof):
    for table, entry in proof.items():
        actual = Counter()
        for offset in range(0, 100001, 500):
            rows = cloud.query('SELECT ' + ','.join(map(name, entry['columns'])) + ' FROM ' + name(table) +
                               ' ORDER BY rowid LIMIT 500 OFFSET ?', [offset])
            actual.update(digest([row[c] for c in entry['columns']]) for row in rows)
            if len(rows) < 500:
                break
        else:
            raise Failure('ASSETLIBRARY_PRESERVATION_LIMIT')
        require(not (entry['rows'] - actual), 'ASSETLIBRARY_DATA_PRESERVATION_UNCONFIRMED')
    require(not cloud.query('PRAGMA foreign_key_check'), 'ASSETLIBRARY_FOREIGN_KEYS_INVALID')


def objects(cloud):
    cursor = ''
    result = {}
    for _ in range(100):
        query = urlencode({'per_page': 1000, 'cursor': cursor})
        page = cloud.call(f"/r2/buckets/{cloud.config['bucket']}/objects?{query}", envelope=True)
        require(isinstance(page.get('result'), list), 'ASSETLIBRARY_OBJECT_WITNESS_INVALID')
        for item in page['result']:
            key = item['key']
            if key.startswith('_sba_backups/'):
                continue
            require(key not in result, 'ASSETLIBRARY_OBJECT_WITNESS_INVALID')
            result[key] = {k: item[k] for k in ('size', 'etag', 'last_modified')}
        info = page.get('result_info', {})
        if info.get('is_truncated') is False:
            return result
        require(isinstance(info.get('cursor'), str) and info['cursor'] and info['cursor'] != cursor,
                'ASSETLIBRARY_OBJECT_WITNESS_INVALID')
        cursor = info['cursor']
    raise Failure('ASSETLIBRARY_OBJECT_WITNESS_LIMIT')
