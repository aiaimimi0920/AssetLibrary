import { base64url, importJWK, type JWK, type JWTVerifyGetKey } from "jose";

export interface FixedKeyConfig {
  AUTH_PUBLIC_JWK?: string;
  AUTH_PUBLIC_JWKS?: string;
}

const keyFields = new Set(["kty", "n", "e", "kid", "alg", "use", "key_ops"]);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  return value as Record<string, unknown>;
}

function unsigned(value: unknown, maximum: number): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
  if (value.length > Math.ceil((maximum * 8) / 6)) throw new Error();
  const bytes = base64url.decode(value);
  if (!bytes.length || bytes.length > maximum || bytes[0] === 0) throw new Error();
  if (base64url.encode(bytes) !== value) throw new Error();
  return bytes;
}

function publicKey(value: unknown, requireKid: boolean): JWK {
  const jwk = record(value);
  // 不接受私钥、证书或隐含用途；配置中每把公钥都要有效，不能只检查命中的一把。
  if (Object.keys(jwk).some((field) => !keyFields.has(field)) || jwk.kty !== "RSA")
    throw new Error();
  if (jwk.alg !== undefined && jwk.alg !== "RS256") throw new Error();
  if (jwk.use !== undefined && jwk.use !== "sig") throw new Error();
  if (
    jwk.key_ops !== undefined &&
    (!Array.isArray(jwk.key_ops) || jwk.key_ops.length !== 1 || jwk.key_ops[0] !== "verify")
  )
    throw new Error();
  if (
    (requireKid || jwk.kid !== undefined) &&
    (typeof jwk.kid !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(jwk.kid))
  )
    throw new Error();
  const modulus = unsigned(jwk.n, 512);
  const first = modulus[0];
  const last = modulus.at(-1);
  if (first === undefined || last === undefined) throw new Error();
  const bits = (modulus.length - 1) * 8 + (32 - Math.clz32(first));
  if (bits < 2048 || bits > 4096 || !(last & 1)) throw new Error();
  const exponent = unsigned(jwk.e, 4).reduce((total, byte) => total * 256 + byte, 0);
  if (exponent < 3 || exponent % 2 !== 1) throw new Error();
  return jwk as JWK;
}

/** 只导入部署者固定的有界公钥集；没有远程发现、令牌 jku、缓存或数据库写入。 */
export async function fixedVerificationKeys(config: FixedKeyConfig): Promise<JWTVerifyGetKey> {
  const single = config.AUTH_PUBLIC_JWK;
  const keyset = config.AUTH_PUBLIC_JWKS;
  if ((single === undefined) === (keyset === undefined)) throw new Error();
  const encoded = single ?? keyset;
  if (
    typeof encoded !== "string" ||
    !encoded ||
    encoded.length > (single !== undefined ? 4096 : 16384)
  )
    throw new Error();
  let keys: JWK[];
  if (single !== undefined) {
    keys = [publicKey(JSON.parse(encoded), false)];
  } else {
    const parsed = record(JSON.parse(encoded));
    if (Object.keys(parsed).length !== 1 || !Array.isArray(parsed.keys)) throw new Error();
    if (parsed.keys.length < 1 || parsed.keys.length > 4) throw new Error();
    keys = parsed.keys.map((key) => publicKey(key, true));
    if (new Set(keys.map((key) => key.kid)).size !== keys.length) throw new Error();
    if (new Set(keys.map((key) => `${key.n}:${key.e}`)).size !== keys.length) throw new Error();
  }
  const imported = await Promise.all(keys.map((key) => importJWK(key, "RS256")));
  return async (header) => {
    if (header.alg !== "RS256") throw new Error();
    if (single !== undefined) {
      // 单钥路径允许未标 kid 的存量短期令牌；显式 kid 必须匹配，绝不猜其他密钥。
      if (header.kid !== undefined && header.kid !== keys[0]?.kid) throw new Error();
    } else if (typeof header.kid !== "string") {
      throw new Error();
    }
    const index = single !== undefined ? 0 : keys.findIndex((key) => key.kid === header.kid);
    const selected = imported[index];
    if (!selected) throw new Error();
    return selected;
  };
}
