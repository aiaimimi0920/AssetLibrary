"""Cloudflare Workers Static Assets 完整性校验与上传会话原语。"""
import base64
import hashlib
import json
import secrets
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from contract import Failure, require


def verify_static_bundle(output, static_spec):
    if not static_spec:
        return None
    files = static_spec.get('files')
    config = static_spec.get('config')
    require(isinstance(files, dict) and files and isinstance(config, dict), 'ASSETLIBRARY_STATIC_MANIFEST_INVALID')
    verified = {}
    for route_path, meta in files.items():
        require(isinstance(route_path, str) and route_path.startswith('/'), 'ASSETLIBRARY_STATIC_MANIFEST_INVALID')
        rel = meta.get('file', '')
        asset_hash = meta.get('hash', '')
        expected_sha = meta.get('sha256', '')
        expected_size = meta.get('size', -1)
        content_type = meta.get('contentType', 'application/octet-stream')
        require(rel and len(asset_hash) == 32 and len(expected_sha) == 64, 'ASSETLIBRARY_STATIC_MANIFEST_INVALID')
        raw = (output / rel).read_bytes()
        require(len(raw) == expected_size and hashlib.sha256(raw).hexdigest() == expected_sha,
                'ASSETLIBRARY_ARTIFACT_CHANGED')
        verified[route_path] = {
            'hash': asset_hash,
            'size': expected_size,
            'contentType': content_type,
            'raw': raw,
        }
    return {'files': verified, 'config': config}


def _jwt_claims(token):
    parts = token.split('.')
    require(len(parts) == 3 and parts[1], 'ASSETLIBRARY_STATIC_UPLOAD_TOKEN_INVALID')
    padded = parts[1] + '=' * (-len(parts[1]) % 4)
    try:
        return json.loads(base64.urlsafe_b64decode(padded.encode('ascii')).decode('utf-8'))
    except Exception:
        raise Failure('ASSETLIBRARY_STATIC_UPLOAD_TOKEN_INVALID') from None


def _upload_with_jwt(base_url, jwt_token, path, body, content_type):
    req = Request(base_url + path, data=body, method='POST', headers={
        'Authorization': 'Bearer ' + jwt_token,
        'Content-Type': content_type,
        'User-Agent': 'AssetLibrary-SBA/1.0',
    })
    try:
        with urlopen(req, timeout=120) as response:
            data = json.load(response)
    except HTTPError:
        raise Failure('ASSETLIBRARY_STATIC_UPLOAD_FAILED') from None
    require(data.get('success') is True and isinstance(data.get('result'), dict), 'ASSETLIBRARY_STATIC_UPLOAD_FAILED')
    return data['result']


def upload_static_assets(cloud, worker, prepared):
    if prepared is None:
        return None
    manifest = {path: {'hash': item['hash'], 'size': item['size']} for path, item in prepared['files'].items()}
    by_hash = {item['hash']: item for item in prepared['files'].values()}
    session = cloud.call(f'/workers/scripts/{worker}/assets-upload-session', 'POST', {'manifest': manifest})
    require(isinstance(session, dict) and isinstance(session.get('jwt'), str) and session['jwt'] and
            isinstance(session.get('buckets'), list), 'ASSETLIBRARY_STATIC_SESSION_FAILED')
    upload_jwt = session['jwt']
    buckets = [bucket for bucket in session['buckets'] if bucket]
    if not buckets:
        return {'jwt': upload_jwt, 'config': prepared['config']}

    single_mode = _jwt_claims(upload_jwt).get('wrangler_single_asset_uploads') is True
    completion_jwt = ''
    if single_mode:
        for file_hash in [item for bucket in buckets for item in bucket]:
            entry = by_hash.get(file_hash)
            require(entry is not None, 'ASSETLIBRARY_STATIC_BUCKET_UNKNOWN_HASH')
            res = _upload_with_jwt(
                cloud.base, upload_jwt, f'/workers/assets/upload/{file_hash}', entry['raw'], entry['contentType'])
            if res.get('jwt'):
                completion_jwt = res['jwt']
    else:
        for bucket in buckets:
            boundary = 'assetlibrarystatic' + secrets.token_hex(16)
            parts = []
            for file_hash in bucket:
                entry = by_hash.get(file_hash)
                require(entry is not None, 'ASSETLIBRARY_STATIC_BUCKET_UNKNOWN_HASH')
                encoded = base64.b64encode(entry['raw'])
                parts.append(
                    f'--{boundary}\r\nContent-Disposition: form-data; name="{file_hash}"; filename="{file_hash}"\r\n'
                    f'Content-Type: {entry["contentType"]}\r\n\r\n'.encode() + encoded + b'\r\n')
            body = b''.join(parts) + f'--{boundary}--\r\n'.encode()
            res = _upload_with_jwt(
                cloud.base, upload_jwt, '/workers/assets/upload?base64=true',
                body, f'multipart/form-data; boundary={boundary}')
            if res.get('jwt'):
                completion_jwt = res['jwt']
    require(bool(completion_jwt), 'ASSETLIBRARY_STATIC_COMPLETION_MISSING')
    return {'jwt': completion_jwt, 'config': prepared['config']}
