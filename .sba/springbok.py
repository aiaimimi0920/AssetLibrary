"""SpringBok 固定版本入口；实际分发准入与服务部署成功分别报告。"""
import argparse
import os
from pathlib import Path
import tempfile
import time
from contract import ROOT, Failure, atomic_result, load, require, validate
from cloudflare import Cloud, build, migrate, preflight, publish, verify
from preservation import backup, preserved, objects


def execute(request, cloud_factory=Cloud, output_builder=build):
    checks = []
    mutated = False
    try:
        validate(request)
        if request['action'] in ('preview', 'destroy-preview'):
            # 不将空库或缺 R2 副本的演练冒充完整预升级；绝不按前缀删除资源。
            raise Failure('ASSETLIBRARY_PREVIEW_NOT_IMPLEMENTED')
        cloud = cloud_factory(request['configuration'])
        if request['action'] == 'verify':
            return 'succeeded', verify(cloud, request), None
        require(os.environ.get('SBA_EXECUTE') == '1', 'ASSETLIBRARY_EXECUTION_NOT_AUTHORIZED')
        preflight(cloud, request)
        temp_root = Path(os.environ.get('RUNNER_TEMP', ROOT.parent.parent / 'linshi'))
        temp_root.mkdir(parents=True, exist_ok=True)
        directory = Path(tempfile.mkdtemp(prefix='assetlibrary-sba-', dir=temp_root))
        output = output_builder(directory)
        proof = None
        object_proof = None
        if request['action'] == 'update':
            object_proof = objects(cloud)
            mutated = True
            proof = backup(cloud, request, directory)
            checks.append({'id': 'backup-created', 'passed': True})
        mutated = True
        migrate(cloud, output)
        if proof is not None:
            preserved(cloud, proof)
            current_objects = objects(cloud)
            require(all(current_objects.get(key) == value for key, value in object_proof.items()),
                    'ASSETLIBRARY_OBJECT_PRESERVATION_UNCONFIRMED')
            checks.append({'id': 'data-preserved', 'passed': True})
        publish(cloud, request, output)
        for attempt in range(12):
            try:
                checks.extend(verify(cloud, request))
                break
            except Exception:
                if attempt == 11:
                    raise
                time.sleep(5)
        # 线上身份登录/业务仍须由独立 verify 与用户实际流程验收。
        return 'deployed-unverified', checks, None
    except Exception as error:
        code = str(error) if isinstance(error, Failure) else 'ASSETLIBRARY_EXECUTION_UNCONFIRMED'
        return 'unknown' if mutated else 'failed', checks, code


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--request', required=True)
    parser.add_argument('--result', required=True)
    args = parser.parse_args()
    request = load(args.request)
    status, checks, code = execute(request)
    result = {key: request[key] for key in ('schemaVersion', 'taskId', 'action', 'sourceSha', 'applicationVersion')}
    result.update(status=status, checks=checks)
    if code:
        result['errorCode'] = code
    atomic_result(args.result, result)


if __name__ == '__main__':
    main()
