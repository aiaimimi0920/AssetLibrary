"""仅修复 0.4.1 在对象枚举前失败、线上仍为 0.4.0 的已知升级。"""
import hashlib
import json
import re
from contract import require

INSTALLED = {'sourceSha': '778b17eb3ed89ef09cd47d4ea225d8e2022abe75', 'applicationVersion': '0.4.0'}
FAILED = {'sourceSha': 'c8068aa608d20bbb37ebba9b7df9c594f0c20553', 'applicationVersion': '0.4.1'}


def validate_repair(request):
    context = request.get('context')
    require(isinstance(context, dict) and set(context) == {
        'repairId', 'parentTaskId', 'parentRunId', 'requestDigest', 'resultDigest', 'errorCode'},
        'ASSETLIBRARY_REPAIR_INVALID')
    require(context['repairId'] == 'r2-pagination-v041' and request['previous'] == FAILED and
            context['errorCode'] == 'ASSETLIBRARY_CLOUDFLARE_REQUEST_FAILED', 'ASSETLIBRARY_REPAIR_INVALID')
    require(isinstance(context['parentTaskId'], str) and
            re.fullmatch(r'dc-[a-f0-9]{32}', context['parentTaskId']) and
            context['parentTaskId'] != request['taskId'] and
            type(context['parentRunId']) is int and context['parentRunId'] > 0,
            'ASSETLIBRARY_REPAIR_INVALID')
    require(all(isinstance(context[key], str) and re.fullmatch(r'[a-f0-9]{64}', context[key])
                for key in ('requestDigest', 'resultDigest')), 'ASSETLIBRARY_REPAIR_INVALID')
    # SpringBok 已核 GitHub artifact；再核精确 failed/空 checks，拒绝 unknown 或写后失败。
    expected = {'schemaVersion': 3, 'taskId': context['parentTaskId'], 'action': 'update',
                **FAILED, 'status': 'failed', 'checks': [], 'errorCode': context['errorCode']}
    digest = hashlib.sha256(json.dumps(expected, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    require(context['resultDigest'] == digest, 'ASSETLIBRARY_REPAIR_PARENT_MISMATCH')


def preflight_request(request):
    validate_repair(request)
    return {**request, 'action': 'update', 'previous': INSTALLED}
