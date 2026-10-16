"""正式站点经用户授权的审核主体；不把邮箱当作身份，不改变原平台 configuration。"""
from native_client import OFFICIAL_IDENTITY, OFFICIAL_TARGET

# 2026-10-16：用户指定审核账号后，从已登录的正式工作区读取的 NAccount 主体。
OFFICIAL_REVIEWER = 'e7b183d6-a81f-485a-9c89-32750b1346d0'


def reviewer_principals(config):
    configured = config['reviewers']
    if configured:
        return list(configured)
    if all(config.get(key) == value for key, value in OFFICIAL_TARGET.items()) and all(
            config['identity'].get(key) == value for key, value in OFFICIAL_IDENTITY.items()):
        return [OFFICIAL_REVIEWER]
    return []
