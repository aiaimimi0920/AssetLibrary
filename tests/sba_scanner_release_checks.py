"""模拟版本内验收记录及真实 API 形状；不写入任何云资源或批准真实 scanner。"""
import copy
import hashlib
import sys
import time
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / '.sba'))
import scanner_release as scanner
import cloudflare
from contract import Failure

now = int(time.time() * 1000)
record = {
    'id': '1' * 64, 'accountId': '2' * 32, 'worker': 'test-app',
    'origin': 'https://test.invalid', 'service': 'test-scanner',
    'workerVersionId': '00000000-0000-4000-8000-000000000001',
    'containerApplicationId': '00000000-0000-4000-8000-000000000002', 'namespaceId': '3' * 32,
    'imageDigest': 'sha256:' + '4' * 64, 'imageId': 'sha256:' + '5' * 64,
    'database': {'sha256': 'a' * 64, 'dailyVersion': 1, 'updatedAt': now - 60000},
    'validatedAt': now - 30000, 'expiresAt': now + 3600000,
    'evidence': {'candidate': '6' * 64, 'nativeReview': '7' * 64, 'cloudValidation': '8' * 64},
}
document = {'schemaVersion': 1, 'release': record}
assert scanner.release_record(document, now) == record
assert scanner.release_record({'schemaVersion': 1, 'release': None}, now) is None


def rejected(action, code):
    try:
        action()
        raise AssertionError('invalid release accepted')
    except Failure as error:
        assert str(error) == code, str(error)


for field, value, code in [
        ('id', True, 'INVALID'), ('expiresAt', now, 'EXPIRED'),
        ('validatedAt', now + 1, 'EXPIRED'), ('expiresAt', now + 90000000, 'EXPIRED'),
        ('origin', 'https://test.invalid/', 'INVALID'), ('imageDigest', 'mutable:latest', 'INVALID')]:
    changed = copy.deepcopy(document)
    changed['release'][field] = value
    rejected(lambda: scanner.release_record(changed, now), 'ASSETLIBRARY_SCANNER_RELEASE_' + code)

config = {key: record[key] for key in ('accountId', 'worker', 'origin')}
config['scannerService'] = ''
original = copy.deepcopy(config)


class Cloud:
    def __init__(self):
        self.config = copy.deepcopy(config)
        self.calls = []
        self.settings = {'bindings': [{'name': 'ART_SCANNER', 'type': 'durable_object_namespace',
                                      'class_name': 'ArtScanner', 'namespace_id': record['namespaceId']}]}
        self.deployments = {'deployments': [{'versions': [{'version_id': record['workerVersionId'], 'percentage': 100}]}]}
        self.app = {
            'durable_objects': {'namespace_id': record['namespaceId']}, 'max_instances': 1,
            'scheduling_policy': 'default', 'configuration': {
                'image': 'registry.cloudflare.com/' + record['accountId'] + '/scanner@' + record['imageDigest'],
                'vcpu': 0.5, 'memory_mib': 4096, 'disk': {'size_mb': 8000}},
        }

    def call(self, path, method='GET', **kwargs):
        assert method == 'GET'
        self.calls.append(path)
        if path.endswith('/settings'):
            return self.settings
        if path.endswith('/deployments'):
            return self.deployments
        assert path.endswith(record['containerApplicationId'])
        return self.app


with patch.object(scanner, 'load', return_value=document):
    expected = [{'name': 'SCANNER', 'type': 'service', 'service': record['service'], 'entrypoint': 'ScannerService'},
                {'name': 'SCANNER_RELEASE_ID', 'type': 'plain_text', 'text': record['id']}]
    assert scanner.scanner_bindings(config) == expected
    assert config == original
    assert scanner.distribution_status(config) == {'status': 'available', 'mode': 'unscanned-packages', 'malwareScanning': 'not_required'}
    scanner.verify_scanner(Cloud(), activating=True)
    for field in ('accountId', 'worker', 'origin', 'scannerService'):
        bad = copy.deepcopy(config)
        bad[field] += '-wrong'
        rejected(lambda: scanner.scanner_bindings(bad), 'ASSETLIBRARY_SCANNER_TARGET_MISMATCH')
    bad = Cloud()
    bad.deployments['deployments'][0]['versions'][0]['percentage'] = 50
    rejected(lambda: scanner.verify_scanner(bad), 'ASSETLIBRARY_SCANNER_VERSION_MISMATCH')
    bad = Cloud()
    bad.settings['bindings'][0]['namespace_id'] = '0' * 32
    rejected(lambda: scanner.verify_scanner(bad), 'ASSETLIBRARY_SCANNER_NAMESPACE_MISMATCH')
    for field, value in [('image', 'registry.cloudflare.com/other/scanner@' + record['imageDigest']),
                         ('image', 'registry.cloudflare.com/' + record['accountId'] + '/scanner:latest'),
                         ('memory_mib', 8192), ('vcpu', 1)]:
        bad = Cloud()
        bad.app['configuration'][field] = value
        rejected(lambda: scanner.verify_scanner(bad), 'ASSETLIBRARY_SCANNER_IMAGE_OR_LIMITS_MISMATCH')
    # 保持记录仍在有效期内，单独验证六小时激活窗口，不被普通过期检查提前截断。
    activation_document = copy.deepcopy(document)
    activation_document['release']['expiresAt'] = record['validatedAt'] + 86400000
    with patch.object(scanner, 'load', return_value=activation_document), \
            patch.object(scanner.time, 'time', return_value=(record['validatedAt'] + 21600000) / 1000):
        scanner.verify_scanner(Cloud(), activating=True)
    with patch.object(scanner, 'load', return_value=activation_document), \
            patch.object(scanner.time, 'time', return_value=(record['validatedAt'] + 21600001) / 1000):
        rejected(lambda: scanner.verify_scanner(Cloud(), activating=True), 'ASSETLIBRARY_SCANNER_ACTIVATION_EXPIRED')
        scanner.verify_scanner(Cloud())

with patch.object(scanner, 'load', return_value={'schemaVersion': 1, 'release': None}):
    assert scanner.scanner_bindings(config) == []
    assert scanner.distribution_status(config)['mode'] == 'unscanned-packages'

# 远端读取和本地包组装均可能跨过窗口；拒绝必须发生在 Worker PUT 之前。
for deadline, code in [(record['expiresAt'], 'RELEASE_EXPIRED'),
                       (record['validatedAt'] + 21600001, 'ACTIVATION_EXPIRED')]:
    delayed_document = copy.deepcopy(document)
    if code == 'ACTIVATION_EXPIRED':
        delayed_document['release']['expiresAt'] = record['validatedAt'] + 86400000
    for stage in ('remote-read', 'artifact-read'):
        clock = [now / 1000]
        cloud = Cloud()
        original_call = cloud.call

        def delayed_call(path, method='GET', **kwargs):
            result = original_call(path, method, **kwargs)
            if stage == 'remote-read' and path.endswith(record['containerApplicationId']):
                clock[0] = deadline / 1000
            return result

        cloud.call = delayed_call
        cloud.config.update({'database': {'id': 'test-database'}, 'bucket': 'test-bucket',
                             'identity': {'issuer': 'https://identity.invalid', 'clientId': 'test'},
                             'reviewers': []})

        class Artifact:
            def __truediv__(self, name):
                return self

            def read_bytes(self):
                clock[0] = deadline / 1000
                return b'export default {};'

        manifest = {'modules': [], 'artifacts': {
            'index.js': hashlib.sha256(b'export default {};').hexdigest()}}
        with patch.object(scanner, 'load', return_value=delayed_document), \
                patch.object(scanner.time, 'time', side_effect=lambda: clock[0]), \
                patch.object(cloudflare, 'load', return_value=manifest), \
                patch.object(cloudflare, 'native_client_id', return_value=''):
            action = (lambda: scanner.verify_scanner(cloud, activating=True)) if stage == 'remote-read' else (
                lambda: cloudflare.publish(cloud, {
                    'action': 'update', 'sourceSha': 'a' * 40, 'applicationVersion': 'test'}, Artifact()))
            rejected(action, 'ASSETLIBRARY_SCANNER_' + code)
        assert len(cloud.calls) == 3
print('SBA_SCANNER_RELEASE_CHECKS_PASSED')
