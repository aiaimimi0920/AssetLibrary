import { HttpError, principalRef } from "../http";

export interface ReviewConfig {
  REVIEWER_PRINCIPALS?: string;
}

/** 权限由部署者固定名单授予；客户端角色和 JWT 自报角色均不参与。 */
export function reviewers(config: ReviewConfig): string[] {
  try {
    const encoded = config.REVIEWER_PRINCIPALS;
    if (!encoded || encoded.length > 8192) throw new Error();
    const values: unknown = JSON.parse(encoded);
    if (!Array.isArray(values) || values.length < 1 || values.length > 32) throw new Error();
    const principals = values.map(principalRef);
    if (new Set(principals).size !== principals.length) throw new Error();
    return principals;
  } catch {
    throw new HttpError(503, "REVIEWERS_NOT_CONFIGURED");
  }
}

export function mayReadReview(config: ReviewConfig, principal: string): boolean {
  try {
    return reviewers(config).includes(principal);
  } catch {
    return false;
  }
}

// 必要内容安全策略尚未实现；没有 format-only 或测试配置的发布旁路。
export const missingContentCheck = "REQUIRED_CONTENT_CHECK_UNAVAILABLE";
