"""正式站点原配置升级与后续保留；只用假云，不操作真实账号或资源。"""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / '.sba'))
import cloudflare
import contract
from native_client import LOOM_CLIENT_ID, OFFICIAL_TARGET, OFFICIAL_IDENTITY, native_client_id
from reviewers import OFFICIAL_REVIEWER, reviewer_principals

config = {**OFFICIAL_TARGET, 'identity': dict(OFFICIAL_IDENTITY),
          'database': {'id': '00000000-0000-4000-8000-000000000001', 'name': 'assetlibrary-db'},
          'bucket': 'assetlibrary-objects', 'scannerService': '', 'reviewers': []}
original = copy.deepcopy(config)
contract.settings(config)
assert native_client_id(config) == LOOM_CLIENT_ID
assert config == original
assert reviewer_principals(config) == [OFFICIAL_REVIEWER]
explicit_reviewers = {**config, 'reviewers': ['user:another']}
assert reviewer_principals(explicit_reviewers) == ['user:another']
assert reviewer_principals(explicit_reviewers) is not explicit_reviewers['reviewers']
for section, fields in [(None, OFFICIAL_TARGET), ('identity', OFFICIAL_IDENTITY)]:
    for key in fields:
        other = copy.deepcopy(config)
        (other[section] if section else other)[key] += '-other'
        assert native_client_id(other) == ''
        assert reviewer_principals(other) == []
explicit = copy.deepcopy(config)
explicit['identity']['nativeClientId'] = 'explicit-client'
assert native_client_id(explicit) == 'explicit-client'

previous = {'sourceSha': 'a' * 40, 'applicationVersion': '0.4.5'}
request = {'action': 'update', 'sourceSha': 'b' * 40, 'applicationVersion': '0.4.6',
           'previous': previous, 'configuration': config}


class Cloud:
    def __init__(self):
        self.config = copy.deepcopy(config)
        self.calls = []
        self.bindings = [
            {'name': 'DB', 'type': 'd1', 'id': config['database']['id']},
            {'name': 'QUARANTINE', 'type': 'r2_bucket', 'bucket_name': config['bucket']},
            {'name': 'NACCOUNT_SESSION_KEY', 'type': 'secret_text'},
        ] + [{'name': name, 'type': 'plain_text', 'text': value} for name, value in {
            'APP_ORIGIN': config['origin'], 'NACCOUNT_ISSUER': config['identity']['issuer'],
            'NACCOUNT_CLIENT_ID': config['identity']['clientId'],
            'RELEASE_SHA': previous['sourceSha'], 'RELEASE_VERSION': previous['applicationVersion'],
        }.items()]

    def call(self, path, method='GET', body=None, *args, **kwargs):
        self.calls.append((path, method, body))
        if method == 'PUT' and path == '/workers/scripts/assetlibrary':
            metadata = json.loads(body.split(b'\r\n\r\n', 1)[1].split(b'\r\n--', 1)[0])
            assert metadata['keep_bindings'] == ['secret_text']
            assert not any(row['name'] == 'NACCOUNT_SESSION_KEY' for row in metadata['bindings'])
            self.bindings = metadata['bindings'] + [{'name': 'NACCOUNT_SESSION_KEY', 'type': 'secret_text'}]
        if method != 'GET':
            return {}
        if path == '/workers/domains':
            return [{'hostname': 'assetlibrary.aiaimimi.com', 'service': 'assetlibrary'}]
        if path.endswith('/settings'):
            return {'bindings': self.bindings}
        if path.endswith('/domains/managed'):
            return {'enabled': False}
        if path.endswith('/domains/custom'):
            return {'domains': []}
        raise AssertionError(path)


discovery = {'issuer': config['identity']['issuer'], 'code_challenge_methods_supported': ['S256']}
with tempfile.TemporaryDirectory(prefix='sba-native-', dir=contract.ROOT.parent.parent / 'linshi') as temp:
    output = Path(temp)
    raw = b'export default {}'
    (output / 'index.js').write_bytes(raw)
    (output / 'manifest.json').write_text(json.dumps({
        'modules': {}, 'artifacts': {'index.js': hashlib.sha256(raw).hexdigest()}}), encoding='utf-8')
    cloud = Cloud()
    with patch.object(cloudflare, 'public_json', return_value=discovery):
        cloudflare.preflight(cloud, request)
    cloudflare.publish(cloud, request, output)
    bindings = {row['name']: row for row in cloud.bindings}
    assert bindings['NACCOUNT_NATIVE_CLIENT_ID']['text'] == LOOM_CLIENT_ID
    assert bindings['NACCOUNT_CLIENT_ID']['text'] == config['identity']['clientId']
    assert json.loads(bindings['REVIEWER_PRINCIPALS']['text']) == [OFFICIAL_REVIEWER]
    assert bindings['DB']['id'] == config['database']['id']
    assert bindings['QUARANTINE']['bucket_name'] == config['bucket']
    assert 'SCANNER' not in bindings
    with patch.object(cloudflare, 'verify_public', return_value=[]):
        assert cloudflare.verify(cloud, request) == [{'id': 'deployed-bindings', 'passed': True}]
        cloud.bindings = [row for row in cloud.bindings if row['name'] != 'NACCOUNT_NATIVE_CLIENT_ID']
        try:
            cloudflare.verify(cloud, request)
            raise AssertionError('missing native binding accepted')
        except contract.Failure as error:
            assert str(error) == 'ASSETLIBRARY_DEPLOYED_BINDINGS_MISMATCH'
    cloud.bindings.append(bindings['NACCOUNT_NATIVE_CLIENT_ID'])
    with patch.object(cloudflare, 'verify_public', return_value=[]):
        bindings['REVIEWER_PRINCIPALS']['text'] = '[]'
        try:
            cloudflare.verify(cloud, request)
            raise AssertionError('missing reviewer accepted')
        except contract.Failure as error:
            assert str(error) == 'ASSETLIBRARY_DEPLOYED_BINDINGS_MISMATCH'
        bindings['REVIEWER_PRINCIPALS']['text'] = json.dumps([OFFICIAL_REVIEWER])
    next_request = {**request, 'sourceSha': 'c' * 40, 'applicationVersion': '0.4.7',
                    'previous': {'sourceSha': request['sourceSha'], 'applicationVersion': request['applicationVersion']}}
    with patch.object(cloudflare, 'public_json', return_value=discovery):
        cloudflare.preflight(cloud, next_request)
    cloudflare.publish(cloud, next_request, output)
    with patch.object(cloudflare, 'verify_public', return_value=[]):
        cloudflare.verify(cloud, next_request)
    assert cloud.config == original and request['configuration'] == original

# 已有不同客户端必须写前拒绝；显式配置与同一正式站点的隐式配置规则一致。
for configured in [None, 'explicit-client']:
    cloud = Cloud()
    if configured:
        cloud.config['identity']['nativeClientId'] = configured
    cloud.bindings.append({'name': 'NACCOUNT_NATIVE_CLIENT_ID', 'type': 'plain_text', 'text': 'unexpected'})
    with patch.object(cloudflare, 'public_json', return_value=discovery):
        try:
            cloudflare.preflight(cloud, request)
            raise AssertionError('native client replacement accepted')
        except contract.Failure as error:
            assert str(error) == 'ASSETLIBRARY_IDENTITY_REBIND_REJECTED'
    assert all(method == 'GET' for _, method, _ in cloud.calls)
print('SBA_NATIVE_CLIENT_CHECKS_PASSED')
