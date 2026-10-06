import { jwtVerify } from "jose";
import { HttpError, principalRef } from "./http";
import { type FixedKeyConfig, fixedVerificationKeys } from "./identity/keys";

export interface IdentityConfig extends FixedKeyConfig {
  AUTH_ISSUER?: string;
  AUTH_AUDIENCE?: string;
}

/** 仅信任部署者固定的外部签名者；不接受客户端主体头、角色或动态 jku。 */
export async function authenticate(request: Request, config: IdentityConfig): Promise<string> {
  const { AUTH_ISSUER: issuer, AUTH_AUDIENCE: audience } = config;
  if (!issuer || !audience) {
    throw new HttpError(503, "IDENTITY_NOT_CONFIGURED");
  }
  let key: Awaited<ReturnType<typeof fixedVerificationKeys>>;
  try {
    key = await fixedVerificationKeys(config);
  } catch {
    throw new HttpError(503, "IDENTITY_NOT_CONFIGURED");
  }
  const authorization = request.headers.get("authorization");
  if (!authorization || authorization.length > 8192 || !authorization.startsWith("Bearer ")) {
    throw new HttpError(401, "UNAUTHENTICATED");
  }
  try {
    const { payload } = await jwtVerify(authorization.slice(7), key, {
      algorithms: ["RS256"],
      issuer,
      audience,
      requiredClaims: ["sub", "iat", "exp"],
      maxTokenAge: "15m",
      clockTolerance: 0,
    });
    if (
      !payload.exp ||
      !payload.iat ||
      payload.exp <= payload.iat ||
      payload.exp - payload.iat > 900
    )
      throw new Error();
    return principalRef(payload.sub);
  } catch {
    throw new HttpError(401, "UNAUTHENTICATED");
  }
}
