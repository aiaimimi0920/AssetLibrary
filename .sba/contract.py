"""应用自有 SBA 合同；不接受平台公开配置中的秘密或任意命令。"""
import json
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent


class Failure(Exception):
    pass


def require(ok, code='ASSETLIBRARY_CONFIGURATION_INVALID'):
    if not ok:
        raise Failure(code)


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def version(value):
    require(isinstance(value, str) and re.fullmatch(r'(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})', value))
    return tuple(map(int, value.split('.')))


def settings(value):
    require(isinstance(value, dict) and set(value) == {
        'accountId', 'worker', 'origin', 'identity', 'reviewers', 'scannerService', 'database', 'bucket'})
    require(re.fullmatch(r'[a-f0-9]{32}', str(value['accountId'])))
    require(re.fullmatch(r'[a-z][a-z0-9-]{1,62}', str(value['worker'])))
    require(re.fullmatch(r'[a-z0-9][a-z0-9-]{1,61}[a-z0-9]', str(value['bucket'])))
    require(set(value['database']) == {'id', 'name'})
    require(re.fullmatch(r'[a-f0-9-]{36}', str(value['database']['id'])))
    require(re.fullmatch(r'[a-z][a-z0-9-]{1,62}', str(value['database']['name'])))
    origin = urlsplit(value['origin'])
    require(origin.scheme == 'https' and origin.hostname and not origin.path and not origin.query
            and not origin.fragment and not origin.username and not origin.port)
    require(value['origin'] == f'https://{origin.hostname}')
    require(set(value['identity']) in ({'issuer', 'clientId'}, {'issuer', 'clientId', 'nativeClientId'}))
    require(value['identity']['issuer'] == 'https://naccount-auth.aiaimimi.com')
    require(re.fullmatch(r'[A-Za-z0-9_-]{1,128}', str(value['identity']['clientId'])))
    if 'nativeClientId' in value['identity']:
        require(isinstance(value['identity']['nativeClientId'], str) and
                re.fullmatch(r'[A-Za-z0-9_-]{1,128}', value['identity']['nativeClientId']) and
                value['identity']['nativeClientId'] != value['identity']['clientId'])
    require(isinstance(value['reviewers'], list) and len(value['reviewers']) <= 100)
    require(all(isinstance(p, str) and re.fullmatch(r'[A-Za-z0-9:._@-]{1,200}', p) for p in value['reviewers']))
    require(len(set(value['reviewers'])) == len(value['reviewers']))
    require(value['scannerService'] == '' or re.fullmatch(r'[a-z][a-z0-9-]{1,62}', value['scannerService']))
    require(value['scannerService'] != value['worker'])
    return value


def git(*args):
    result = subprocess.run(['git', *args], cwd=ROOT, capture_output=True, text=True, timeout=30)
    require(result.returncode == 0, 'ASSETLIBRARY_SOURCE_INVALID')
    return result.stdout.strip()


def validate(request, check_source=True):
    manifest = load(ROOT / '.sba/manifest.json')
    fields = {'schemaVersion', 'taskId', 'action', 'repository', 'sourceSha', 'applicationId',
              'applicationVersion', 'environment', 'configuration', 'previous'}
    if request.get('action') in ('preview', 'destroy-preview', 'repair'):
        fields.add('context')
    require(set(request) == fields and request['schemaVersion'] == 3, 'ASSETLIBRARY_REQUEST_INVALID')
    require(request['action'] in manifest['actions'], 'ASSETLIBRARY_REQUEST_INVALID')
    require(request['repository'] == 'aiaimimi0920/AssetLibrary')
    require(request['applicationId'] == manifest['id'] and request['applicationVersion'] == manifest['version'])
    require(re.fullmatch(r'[a-f0-9]{40}', request['sourceSha']))
    for field in ('taskId', 'environment'):
        require(re.fullmatch(r'[a-z][a-z0-9-]{1,62}', request[field]))
    current = version(request['applicationVersion'])
    previous = request['previous']
    if request['action'] == 'deploy':
        require(previous is None)
    else:
        require(isinstance(previous, dict) and set(previous) == {'sourceSha', 'applicationVersion'})
        require(re.fullmatch(r'[a-f0-9]{40}', previous['sourceSha']))
        old = version(previous['applicationVersion'])
        if request['action'] in ('update', 'preview', 'repair'):
            require(current > old and request['sourceSha'] != previous['sourceSha'])
        else:
            require(current == old and request['sourceSha'] == previous['sourceSha'])
    settings(request['configuration'])
    if request['action'] == 'repair':
        from repair import validate_repair
        validate_repair(request)
    if check_source:
        require(not git('status', '--porcelain') and git('rev-parse', 'HEAD') == request['sourceSha'], 'ASSETLIBRARY_SOURCE_INVALID')
        require(git('remote', 'get-url', 'origin').removesuffix('.git') == 'https://github.com/aiaimimi0920/AssetLibrary', 'ASSETLIBRARY_SOURCE_INVALID')
    return request


def atomic_result(path, value):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(target.name + '.pending')
    with temp.open('x', encoding='utf-8', newline='\n') as file:
        json.dump(value, file, ensure_ascii=False, indent=2)
        file.write('\n')
    os.replace(temp, target)
