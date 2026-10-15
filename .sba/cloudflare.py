"""Cloudflare 应用部署原语；不创建平台已分配的 D1/R2，不操作账号系统。"""
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import time
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from contract import ROOT, Failure, require, load


class Cloud:
    def __init__(self, config):
        self.config = config
        self.base = 'https://api.cloudflare.com/client/v4/accounts/' + config['accountId']
        self.token = os.environ.get('CLOUDFLARE_API_TOKEN', '')
        require(bool(self.token), 'ASSETLIBRARY_CREDENTIAL_REQUIRED')

    def call(self, path, method='GET', body=None, content_type='application/json', missing=False, envelope=False):
        raw = body if isinstance(body, bytes) else None if body is None else json.dumps(body).encode()
        req = Request(self.base + path, data=raw, method=method, headers={
            'Authorization': 'Bearer ' + self.token, 'Content-Type': content_type,
            'User-Agent': 'AssetLibrary-SBA/1.0'})
        try:
            with urlopen(req, timeout=120) as response:
                data = json.load(response)
        except HTTPError as error:
            if missing and error.code == 404:
                return None
            raise Failure('ASSETLIBRARY_CLOUDFLARE_REQUEST_FAILED') from None
        require(data.get('success') is True, 'ASSETLIBRARY_CLOUDFLARE_REQUEST_FAILED')
        return data if envelope else data.get('result')

    def query(self, sql, params=None):
        result = self.call(f"/d1/database/{self.config['database']['id']}/query", 'POST', {'sql': sql, 'params': params or []})
        require(isinstance(result, list) and len(result) == 1 and result[0].get('success') is True,
                'ASSETLIBRARY_DATABASE_QUERY_FAILED')
        return result[0]['results']


def public_json(url):
    with urlopen(Request(url, headers={'User-Agent': 'AssetLibrary-SBA/1.0'}), timeout=30) as response:
        require(response.geturl() == url, 'ASSETLIBRARY_READINESS_REDIRECTED')
        return json.loads(response.read(65537))


def command(args, directory=ROOT, env=None):
    result = subprocess.run(args, cwd=directory, env=env, capture_output=True, timeout=900)
    # CLI 可能打印 binding 值；不转发原输出，不上传到工作流制品。
    require(result.returncode == 0, 'ASSETLIBRARY_BUILD_OR_MIGRATION_FAILED')
    return result.stdout.decode('utf-8')


def build(directory):
    npm = shutil.which('npm.cmd' if os.name == 'nt' else 'npm')
    require(npm is not None, 'ASSETLIBRARY_TOOLCHAIN_MISSING')
    command([npm, 'exec', '--yes', '--package=pnpm@10.33.0', '--', 'pnpm', 'install', '--frozen-lockfile'])
    env = {**os.environ, 'ASSETLIBRARY_ARTIFACT_ROOT': str(directory), 'CI': 'true',
           'WRANGLER_SEND_METRICS': 'false'}
    command(['node', 'scripts/build.mjs'], env=env)
    outputs = list(directory.glob('assetlibrary-p3-*'))
    require(len(outputs) == 1, 'ASSETLIBRARY_BUILD_IDENTITY_INVALID')
    return outputs[0]


def preflight(cloud, request):
    c = cloud.config
    host = urlsplit(c['origin']).hostname
    if c['origin'].endswith('.workers.dev'):
        subdomain = cloud.call('/workers/subdomain')['subdomain']
        require(host == f"{c['worker']}.{subdomain}.workers.dev", 'ASSETLIBRARY_DOMAIN_MISMATCH')
    else:
        domains = cloud.call('/workers/domains')
        require(all(d['service'] == c['worker'] for d in domains if d['hostname'] == host), 'ASSETLIBRARY_DOMAIN_OWNED_BY_OTHER_SERVICE')
    current = cloud.call(f"/workers/scripts/{c['worker']}/settings", missing=True)
    if request['action'] == 'deploy':
        require(current is None, 'ASSETLIBRARY_TARGET_EXISTS')
        tables = cloud.query("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")
        require(not tables, 'ASSETLIBRARY_DATABASE_NOT_EMPTY')
    else:
        require(current is not None, 'ASSETLIBRARY_TARGET_MISSING')
        bindings = {b['name']: b for b in current['bindings']}
        require(bindings.get('RELEASE_SHA', {}).get('text') == request['previous']['sourceSha'], 'ASSETLIBRARY_PREVIOUS_RELEASE_MISMATCH')
        require(bindings.get('DB', {}).get('id') == c['database']['id'] and
                bindings.get('QUARANTINE', {}).get('bucket_name') == c['bucket'], 'ASSETLIBRARY_RESOURCE_REBIND_REJECTED')
        require(bindings.get('NACCOUNT_SESSION_KEY', {}).get('type') == 'secret_text', 'ASSETLIBRARY_SESSION_KEY_MISSING')
        require(bindings.get('NACCOUNT_ISSUER', {}).get('text') == c['identity']['issuer'] and
                bindings.get('NACCOUNT_CLIENT_ID', {}).get('text') == c['identity']['clientId'] and
                bindings.get('APP_ORIGIN', {}).get('text') == c['origin'], 'ASSETLIBRARY_IDENTITY_REBIND_REJECTED')
    managed = cloud.call(f"/r2/buckets/{c['bucket']}/domains/managed")
    require(managed.get('enabled') is False, 'ASSETLIBRARY_BUCKET_PUBLIC')
    domains = cloud.call(f"/r2/buckets/{c['bucket']}/domains/custom")
    require(not domains.get('domains'), 'ASSETLIBRARY_BUCKET_PUBLIC')
    if c['scannerService']:
        require(cloud.call(f"/workers/scripts/{c['scannerService']}/settings", missing=True) is not None,
                'ASSETLIBRARY_SCANNER_MISSING')
    discovery = public_json(c['identity']['issuer'] + '/.well-known/openid-configuration')
    require(discovery.get('issuer') == c['identity']['issuer'] and 'S256' in discovery.get('code_challenge_methods_supported', []),
            'ASSETLIBRARY_IDENTITY_CONTRACT_INVALID')


def migrate(cloud, output):
    # 每批须确认所有语句与摘要回执；失败按 unknown 保留现场，不自动重放。
    cloud.query('CREATE TABLE IF NOT EXISTS assetlibrary_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL)')
    applied = {r['name']: r['sha256'] for r in cloud.query('SELECT name,sha256 FROM assetlibrary_migrations')}
    files = sorted((output / 'db').glob('*.sql'))
    require(set(applied) <= {p.name for p in files}, 'ASSETLIBRARY_UNKNOWN_MIGRATION')
    for path in files:
        data = path.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if path.name in applied:
            require(applied[path.name] == digest, 'ASSETLIBRARY_MIGRATION_CHANGED')
            continue
        # 当前迁移均为受审阅的无参数 Schema；名称与摘要由固定源码生成。
        sql = data.decode('utf-8') + f"\nINSERT INTO assetlibrary_migrations(name,sha256) VALUES('{path.name}','{digest}');"
        result = cloud.call(f"/d1/database/{cloud.config['database']['id']}/query", 'POST', {'sql': sql, 'params': []})
        require(isinstance(result, list) and result and all(r.get('success') is True for r in result),
                'ASSETLIBRARY_MIGRATION_UNCONFIRMED')


def publish(cloud, request, output):
    c = cloud.config
    manifest = load(output / 'manifest.json')
    bindings = [
        {'name': 'DB', 'type': 'd1', 'id': c['database']['id']},
        {'name': 'QUARANTINE', 'type': 'r2_bucket', 'bucket_name': c['bucket']},
    ]
    variables = {'APP_ORIGIN': c['origin'], 'NACCOUNT_ISSUER': c['identity']['issuer'],
                 'NACCOUNT_CLIENT_ID': c['identity']['clientId'], 'REVIEWER_PRINCIPALS': json.dumps(c['reviewers']),
                 'RELEASE_SHA': request['sourceSha'], 'RELEASE_VERSION': request['applicationVersion']}
    bindings += [{'name': k, 'type': 'plain_text', 'text': v} for k, v in variables.items()]
    if c['scannerService']:
        bindings.append({'name': 'SCANNER', 'type': 'service', 'service': c['scannerService'], 'entrypoint': 'ScannerService'})
    if request['action'] == 'deploy':
        bindings.append({'name': 'NACCOUNT_SESSION_KEY', 'type': 'secret_text', 'text': secrets.token_hex(32)})
    metadata = {'main_module': 'index.js', 'compatibility_date': '2026-10-01',
                'compatibility_flags': ['enable_request_signal'], 'bindings': bindings,
                'keep_bindings': ['secret_text'],
                'observability': {'enabled': True, 'head_sampling_rate': 1, 'redact_query_string': True, 'logs': {'invocation_logs': False}}}
    boundary = 'assetlibrary' + secrets.token_hex(16)
    parts = []
    def part(name, data, content_type):
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{name}"\r\nContent-Type: {content_type}\r\n\r\n'.encode() + data + b'\r\n')
    part('metadata', json.dumps(metadata).encode(), 'application/json')
    for name in ['index.js', *manifest['modules']]:
        raw = (output / name).read_bytes()
        require(hashlib.sha256(raw).hexdigest() == manifest['artifacts'][name], 'ASSETLIBRARY_ARTIFACT_CHANGED')
        part(name, raw, 'application/javascript+module' if name == 'index.js' else 'text/plain')
    body = b''.join(parts) + f'--{boundary}--\r\n'.encode()
    cloud.call(f"/workers/scripts/{c['worker']}", 'PUT', body, f'multipart/form-data; boundary={boundary}')
    cloud.call(f"/workers/scripts/{c['worker']}/subdomain", 'POST', {'enabled': c['origin'].endswith('.workers.dev'), 'previews_enabled': False})
    if not c['origin'].endswith('.workers.dev'):
        host = urlsplit(c['origin']).hostname
        require(all(d['service'] == c['worker'] for d in cloud.call('/workers/domains') if d['hostname'] == host),
                'ASSETLIBRARY_DOMAIN_OWNED_BY_OTHER_SERVICE')
        cloud.call('/workers/domains', 'PUT', {'hostname': host, 'service': c['worker'], 'enabled': True, 'previews_enabled': False})
    cloud.call(f"/workers/scripts/{c['worker']}/schedules", 'PUT', [{'cron': '* * * * *'}])


def verify(cloud, request):
    c = cloud.config
    current = cloud.call(f"/workers/scripts/{c['worker']}/settings")
    bindings = {b['name']: b for b in current['bindings']}
    require(bindings.get('RELEASE_SHA', {}).get('text') == request['sourceSha'] and
            bindings.get('DB', {}).get('id') == c['database']['id'] and
            bindings.get('QUARANTINE', {}).get('bucket_name') == c['bucket'] and
            bindings.get('NACCOUNT_SESSION_KEY', {}).get('type') == 'secret_text',
            'ASSETLIBRARY_DEPLOYED_BINDINGS_MISMATCH')
    return [{'id': 'deployed-bindings', 'passed': True}, *verify_public(request)]


def verify_public(request):
    c = request['configuration']
    health = public_json(c['origin'] + '/healthz')
    require(health.get('sourceSha') == request['sourceSha'] and health.get('version') == request['applicationVersion'],
            'ASSETLIBRARY_RELEASE_MISMATCH')
    ready = public_json(c['origin'] + '/readyz')
    require(ready.get('status') == 'ready' and ready.get('checks') == {
                'identity': 'available', 'database': 'available', 'storage': 'available'} and
            ready.get('distribution') == {'status': 'blocked', 'reason': 'SCANNER_CLOUD_NOT_VALIDATED'},
            'ASSETLIBRARY_READINESS_FAILED')
    session = public_json(c['origin'] + '/auth/session')
    require(session == {'enabled': True, 'principal': None}, 'ASSETLIBRARY_AUTH_READINESS_FAILED')
    return [{'id': key, 'passed': True} for key in ['release-identity', 'private-dependencies', 'naccount-login-configured', 'production-gate-preserved']]
