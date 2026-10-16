"""版本管理的正式站点集成；公开客户端标识不是凭据，不改写平台原始配置。"""

LOOM_CLIENT_ID = 'E2C4ea99CC5Fee924b9023D76986397f7593282D25AF979d727D26eaB09A0c10'
OFFICIAL_TARGET = {
    'accountId': 'bea2e3be0577ee4f7b3ffae4df6f53bb',
    'worker': 'assetlibrary',
    'origin': 'https://assetlibrary.aiaimimi.com',
}
OFFICIAL_IDENTITY = {
    'issuer': 'https://naccount-auth.aiaimimi.com',
    'clientId': '1F55EDc6b445F3E8d0787B227171dea1917bE2E2bb72bf768c16f17655c8cc9f',
}


def native_client_id(config):
    identity = config['identity']
    # 新实例可显式登记自己的独立客户端；既有 binding 的变更仍由 preflight 拒绝。
    if 'nativeClientId' in identity:
        return identity['nativeClientId']
    if all(config.get(key) == value for key, value in OFFICIAL_TARGET.items()) and all(
            identity.get(key) == value for key, value in OFFICIAL_IDENTITY.items()):
        return LOOM_CLIENT_ID
    return ''
