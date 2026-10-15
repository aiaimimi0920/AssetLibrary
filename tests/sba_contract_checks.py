"""纯本地合同与假云后端测试，不执行 CLI 或云变更。"""
import copy
import hashlib
import json
from pathlib import Path
import sys
from unittest.mock import patch
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / '.sba'))
import contract
import cloudflare
import preservation
import springbok

config = {'accountId': 'a' * 32, 'worker': 'assetlibrary-test', 'origin': 'https://assetlibrary.test',
          'identity': {'issuer': 'https://naccount-auth.aiaimimi.com', 'clientId': 'assetlibrary-client'},
          'database': {'id': '00000000-0000-4000-8000-000000000001', 'name': 'assetlibrary-db'},
          'bucket': 'assetlibrary-objects', 'scannerService': '', 'reviewers': []}
request = {'schemaVersion': 3, 'taskId': 'dc-' + 'b' * 32, 'action': 'deploy',
           'repository': 'aiaimimi0920/AssetLibrary', 'sourceSha': 'c' * 40,
           'applicationId': 'assetlibrary-cloudflare', 'applicationVersion': '0.4.1',
           'environment': 'assetlibrary', 'configuration': config, 'previous': None}
contract.validate(request, check_source=False)
for key, value in [('origin', 'https://evil.test/path'), ('accountId', '../other'),
                   ('scannerService', 'assetlibrary-test'), ('reviewers', ['x', 'x'])]:
    bad = copy.deepcopy(request)
    bad['configuration'][key] = value
    try:
        contract.validate(bad, check_source=False)
        raise AssertionError('invalid configuration accepted')
    except contract.Failure:
        pass


with patch.object(springbok, 'validate', lambda req: req):
    preview = {**request, 'action': 'preview'}
    with patch.object(springbok, 'Cloud', side_effect=AssertionError('cloud called')):
        assert springbok.execute(preview)[0:3:2] == ('failed', 'ASSETLIBRARY_PREVIEW_NOT_IMPLEMENTED')
    verification = {**request, 'action': 'verify'}
    with patch.object(springbok, 'verify_public', return_value=[{'id': 'observed', 'passed': True}]), \
         patch.object(springbok, 'migrate', side_effect=AssertionError('verify wrote data')):
        def no_cloud(_):
            raise AssertionError('independent verification requested a cloud credential')
        assert springbok.execute(verification, cloud_factory=no_cloud)[0] == 'succeeded'
    with patch.dict('os.environ', {'SBA_EXECUTE': '1'}), \
         patch.object(springbok, 'preflight', side_effect=contract.Failure('ASSETLIBRARY_TARGET_EXISTS')):
        assert springbok.execute(request, cloud_factory=lambda _: object())[0] == 'failed'
    with patch.dict('os.environ', {'SBA_EXECUTE': '1'}), \
         patch.object(springbok, 'preflight'), \
         patch.object(springbok, 'migrate', side_effect=RuntimeError('private details')):
        result = springbok.execute(request, cloud_factory=lambda _: object(), output_builder=lambda p: p)
        assert result == ('unknown', [], 'ASSETLIBRARY_EXECUTION_UNCONFIRMED')

raw = b'CREATE TABLE items(id TEXT PRIMARY KEY, value TEXT); INSERT INTO items VALUES("a","preserve");'
proof = preservation.witness(raw)


class Rows:
    def __init__(self, value):
        self.value = value
    def query(self, sql, params=None):
        if sql == 'PRAGMA foreign_key_check':
            return []
        return [{'id': 'a', 'value': self.value}]


preservation.preserved(Rows('preserve'), proof)
try:
    preservation.preserved(Rows('changed'), proof)
    raise AssertionError('changed data accepted')
except contract.Failure:
    pass

class FakeCloud:
    def __init__(self):
        self.config = copy.deepcopy(config)
        self.calls = []
        self.existing = None
        self.tables = []
        self.public = False
        self.domains = []
    def call(self, path, method='GET', body=None, content_type='', missing=False, envelope=False):
        self.calls.append((path, method, body))
        if method != 'GET':
            return {}
        if path == '/workers/domains':
            return self.domains
        if path.endswith('/settings'):
            return self.existing
        if path.endswith('/domains/managed'):
            return {'enabled': self.public}
        if path.endswith('/domains/custom'):
            return {'domains': []}
        raise AssertionError(path)
    def query(self, sql, params=None):
        return self.tables


discovery = {'issuer': config['identity']['issuer'], 'code_challenge_methods_supported': ['S256']}
with patch.object(cloudflare, 'public_json', return_value=discovery):
    cloudflare.preflight(FakeCloud(), request)
    for field, value in [('existing', {}), ('tables', [{'name': 'existing'}]), ('public', True),
                         ('domains', [{'hostname': 'assetlibrary.test', 'service': 'someone-else'}])]:
        fake = FakeCloud()
        setattr(fake, field, value)
        try:
            cloudflare.preflight(fake, request)
            raise AssertionError('unsafe target accepted')
        except contract.Failure:
            assert all(method == 'GET' for _, method, _ in fake.calls)

scratch = contract.ROOT.parent.parent / 'linshi'
with tempfile.TemporaryDirectory(prefix='sba-unit-', dir=scratch) as temp:
    output = Path(temp)
    raw = b'export default {fetch(){return new Response("test")}}'
    (output / 'index.js').write_bytes(raw)
    (output / 'manifest.json').write_text(json.dumps({'modules': {}, 'artifacts': {'index.js': hashlib.sha256(raw).hexdigest()}}), encoding='utf-8')
    for action in ('deploy', 'update'):
        fake = FakeCloud()
        cloudflare.publish(fake, {**request, 'action': action}, output)
        upload = next(body for path, method, body in fake.calls if method == 'PUT' and path.endswith('/assetlibrary-test'))
        assert (b'NACCOUNT_SESSION_KEY' in upload) == (action == 'deploy')
        assert b'"keep_bindings": ["secret_text"]' in upload
        assert b'"SCANNER"' not in upload
        assert not any('containers' in path for path, _, _ in fake.calls)
    (output / 'index.js').write_bytes(b'changed')
    fake = FakeCloud()
    try:
        cloudflare.publish(fake, request, output)
        raise AssertionError('changed artifact accepted')
    except contract.Failure:
        assert not fake.calls
ready = {'status': 'ready', 'checks': {'identity': 'available', 'database': 'available', 'storage': 'available'},
         'distribution': {'status': 'blocked', 'reason': 'SCANNER_CLOUD_NOT_VALIDATED'}}
responses = [{'sourceSha': request['sourceSha'], 'version': request['applicationVersion']}, ready,
             {'enabled': True, 'principal': None}]
with patch.object(cloudflare, 'public_json', side_effect=responses) as get:
    assert len(cloudflare.verify_public(request)) == 4
    assert [args.args[0] for args in get.call_args_list] == [config['origin'] + path for path in ['/healthz', '/readyz', '/auth/session']]
for broken in [{**ready, 'checks': {}}, {**ready, 'distribution': {'status': 'allowed'}}, {**ready, 'status': 'degraded'}]:
    with patch.object(cloudflare, 'public_json', side_effect=[responses[0], broken]):
        try:
            cloudflare.verify_public(request)
            raise AssertionError('invalid readiness accepted')
        except contract.Failure:
            pass
print('SBA_CHECKS_PASSED')
