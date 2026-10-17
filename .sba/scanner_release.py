"""版本内 scanner 验收记录；不接受请求中的布尔开关或自动批准未知候选。"""
import re
import time
from urllib.parse import urlsplit
from contract import ROOT, load, require


def exact(value, keys):
    return isinstance(value, dict) and set(value) == set(keys.split())


def match(value, expression):
    return isinstance(value, str) and re.fullmatch(expression, value) is not None


def timestamp(value):
    return type(value) is int and 0 < value <= 9007199254740991


def release_record(document=None, now=None):
    if document is None:
        document = load(ROOT / 'src/scanner/deployment-release.json')
    now = int(time.time() * 1000) if now is None else now
    require(exact(document, 'schemaVersion release') and type(document['schemaVersion']) is int
            and document['schemaVersion'] == 1, 'ASSETLIBRARY_SCANNER_RELEASE_INVALID')
    r = document['release']
    if r is None:
        return None
    require(exact(r, 'id accountId worker origin service workerVersionId containerApplicationId namespaceId '
                  'imageDigest imageId database validatedAt expiresAt evidence'), 'ASSETLIBRARY_SCANNER_RELEASE_INVALID')
    digest, image = r'[0-9a-f]{64}', r'sha256:[0-9a-f]{64}'
    uuid = r'[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}'
    require(match(r['id'], digest) and match(r['accountId'], r'[0-9a-f]{32}') and
            match(r['namespaceId'], r'[0-9a-f]{32}') and match(r['workerVersionId'], uuid) and
            match(r['containerApplicationId'], uuid) and match(r['worker'], r'[a-z0-9][a-z0-9-]{0,62}') and
            match(r['service'], r'[a-z0-9][a-z0-9-]{0,62}') and r['worker'] != r['service'] and
            match(r['imageDigest'], image) and match(r['imageId'], image), 'ASSETLIBRARY_SCANNER_RELEASE_INVALID')
    require(exact(r['database'], 'sha256 dailyVersion updatedAt') and
            match(r['database']['sha256'], digest) and timestamp(r['database']['dailyVersion']) and
            timestamp(r['database']['updatedAt']) and exact(r['evidence'], 'candidate nativeReview cloudValidation') and
            all(match(v, digest) for v in r['evidence'].values()), 'ASSETLIBRARY_SCANNER_RELEASE_INVALID')
    require(timestamp(r['validatedAt']) and timestamp(r['expiresAt']) and
            r['validatedAt'] <= now < r['expiresAt'] <= r['validatedAt'] + 86400000 and
            r['database']['updatedAt'] <= r['validatedAt'] + 300000 and
            r['expiresAt'] <= r['database']['updatedAt'] + 172800000, 'ASSETLIBRARY_SCANNER_RELEASE_EXPIRED')
    require(isinstance(r['origin'], str), 'ASSETLIBRARY_SCANNER_RELEASE_INVALID')
    origin = urlsplit(r['origin'])
    require(origin.scheme == 'https' and origin.hostname and not origin.username and not origin.password and
            not origin.path and not origin.query and not origin.fragment and
            r['origin'] == 'https://' + origin.netloc, 'ASSETLIBRARY_SCANNER_RELEASE_INVALID')
    return r


def scanner_release(config):
    r = release_record()
    if r:
        require(all(config[key] == r[key] for key in ('accountId', 'worker', 'origin')) and
                config['scannerService'] in ('', r['service']), 'ASSETLIBRARY_SCANNER_TARGET_MISMATCH')
    return r


def scanner_bindings(config):
    r = scanner_release(config)
    service = r['service'] if r else config['scannerService']
    result = [{'name': 'SCANNER', 'type': 'service', 'service': service, 'entrypoint': 'ScannerService'}] if service else []
    if r:
        result.append({'name': 'SCANNER_RELEASE_ID', 'type': 'plain_text', 'text': r['id']})
    return result


def verify_release_window(record, activating=False):
    if record is None:
        return
    now = int(time.time() * 1000)
    # 重查同一份已核验身份，不在等待之后换用另一份本地记录。
    release_record({'schemaVersion': 1, 'release': record}, now)
    if activating:
        require(now - record['validatedAt'] <= 21600000, 'ASSETLIBRARY_SCANNER_ACTIVATION_EXPIRED')


def verify_scanner(cloud, activating=False):
    r = scanner_release(cloud.config)
    service = r['service'] if r else cloud.config['scannerService']
    if not service:
        return
    settings = cloud.call(f'/workers/scripts/{service}/settings', missing=True)
    require(settings is not None, 'ASSETLIBRARY_SCANNER_MISSING')
    if not r:
        return
    verify_release_window(r, activating)
    bindings = {b['name']: b for b in settings.get('bindings', [])}
    require(bindings.get('ART_SCANNER', {}).get('namespace_id') == r['namespaceId'], 'ASSETLIBRARY_SCANNER_NAMESPACE_MISMATCH')
    deployments = cloud.call(f'/workers/scripts/{service}/deployments').get('deployments', [])
    require(bool(deployments) and deployments[0].get('versions') == [
        {'version_id': r['workerVersionId'], 'percentage': 100}], 'ASSETLIBRARY_SCANNER_VERSION_MISMATCH')
    app = cloud.call(f"/containers/applications/{r['containerApplicationId']}")
    config = app.get('configuration', {})
    require(app.get('durable_objects', {}).get('namespace_id') == r['namespaceId'] and
            app.get('max_instances') == 1 and app.get('scheduling_policy') == 'default' and
            config.get('image', '').startswith('registry.cloudflare.com/' + r['accountId'] + '/') and
            config.get('image', '').endswith('@' + r['imageDigest']) and config.get('vcpu') == 0.5 and
            config.get('memory_mib') == 4096 and config.get('disk', {}).get('size_mb') == 8000,
            'ASSETLIBRARY_SCANNER_IMAGE_OR_LIMITS_MISMATCH')
    verify_release_window(r, activating)
    return r


def distribution_status(config):
    return {'status': 'available', 'mode': 'unscanned-packages', 'malwareScanning': 'not_required'}
