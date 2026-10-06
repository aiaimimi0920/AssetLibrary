import type {
  OperatorReviewPackage,
  OperatorReviewQueueItem,
  OperatorReviewQueuePage,
  OperatorReviewRecord,
  OperatorSubmissionDetail,
  ProductCompatibility,
  ReviewFinding,
  SubmissionView,
} from "./operator-contracts";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const slugPattern = /^[a-z0-9][a-z0-9-]{0,119}$/;
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function line(value: unknown, maximum: number, empty = false): value is string {
  return typeof value === "string" && (empty || value.length > 0) && value.length <= maximum
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function multiline(value: unknown, maximum: number, empty = false): value is string {
  return typeof value === "string" && (empty || value.length > 0) && value.length <= maximum
    && value.trim() === value && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function dateTime(value: unknown): value is string {
  return line(value, 64) && Number.isFinite(Date.parse(value));
}

function uniqueLines(value: unknown, maximum: number): value is string[] {
  return Array.isArray(value) && value.length <= maximum
    && value.every((item) => line(item, 160)) && new Set(value).size === value.length;
}

function parseSubmission(value: unknown): SubmissionView {
  const keys = ["id", "release_id", "artifact_id", "revision", "status", "required_approvals",
    "approval_count", "scanner_version", "rule_version"];
  if (!exact(value, keys)
    || ![value.id, value.release_id, value.artifact_id].every((id) => typeof id === "string" && uuidPattern.test(id))
    || !Number.isInteger(value.revision) || Number(value.revision) < 1 || Number(value.revision) > 10_000
    || !["in_review", "changes_requested", "approved", "rejected", "withdrawn"].includes(String(value.status))
    || ![1, 2].includes(Number(value.required_approvals))
    || !Number.isInteger(value.approval_count) || Number(value.approval_count) < 0
    || Number(value.approval_count) > Number(value.required_approvals)
    || !line(value.scanner_version, 100) || !line(value.rule_version, 100)) {
    throw new Error("Invalid operator submission contract");
  }
  return value as unknown as SubmissionView;
}

export function parseReviewDecisionView(value: unknown): SubmissionView {
  if (!exact(value, ["review_id", "submission"])
    || typeof value.review_id !== "string" || !uuidPattern.test(value.review_id)) {
    throw new Error("Invalid review decision response");
  }
  return parseSubmission(value.submission);
}

function parsePackage(value: unknown): OperatorReviewPackage {
  if (!exact(value, ["id", "slug", "name", "kind", "summary", "publisher"])
    || typeof value.id !== "string" || !uuidPattern.test(value.id)
    || typeof value.slug !== "string" || !slugPattern.test(value.slug)
    || !line(value.name, 160) || !line(value.summary, 1_000, true)
    || !["art", "capability", "app_update"].includes(String(value.kind))
    || !exact(value.publisher, ["id", "slug", "display_name"])
    || typeof value.publisher.id !== "string" || !uuidPattern.test(value.publisher.id)
    || typeof value.publisher.slug !== "string" || !slugPattern.test(value.publisher.slug)
    || !line(value.publisher.display_name, 160)) {
    throw new Error("Invalid operator package contract");
  }
  return value as unknown as OperatorReviewPackage;
}

function parseItem(value: unknown): OperatorReviewQueueItem {
  if (!exact(value, ["submission", "package", "release_version", "submitted_at", "updated_at"])
    || typeof value.release_version !== "string" || value.release_version.length > 100
    || !semverPattern.test(value.release_version)
    || !dateTime(value.submitted_at) || !dateTime(value.updated_at)) {
    throw new Error("Invalid operator queue item contract");
  }
  return {
    ...value,
    submission: parseSubmission(value.submission),
    package: parsePackage(value.package),
  } as OperatorReviewQueueItem;
}

function parseCompatibility(value: unknown): { products: ProductCompatibility[] } {
  if (!exact(value, ["products"]) || !Array.isArray(value.products) || value.products.length > 8) {
    throw new Error("Invalid operator compatibility contract");
  }
  const names = new Set<string>();
  const products = value.products.map((product) => {
    if (!exact(product, ["name", "version_requirement"])
      || !["loom", "hook"].includes(String(product.name)) || names.has(String(product.name))
      || !line(product.version_requirement, 100)) {
      throw new Error("Invalid operator compatibility contract");
    }
    names.add(String(product.name));
    return product as unknown as ProductCompatibility;
  });
  return { products };
}

function parseFinding(value: unknown): ReviewFinding {
  if (!exact(value, ["code", "severity", "message"]) || !line(value.code, 100)
    || !["info", "warning", "error"].includes(String(value.severity))
    || !multiline(value.message, 2_000)) {
    throw new Error("Invalid operator finding contract");
  }
  return value as unknown as ReviewFinding;
}

function parseReview(value: unknown): OperatorReviewRecord {
  if (!exact(value, ["id", "revision", "decision", "reason", "findings", "decided_at"])
    || typeof value.id !== "string" || !uuidPattern.test(value.id)
    || !Number.isInteger(value.revision) || Number(value.revision) < 1 || Number(value.revision) > 10_000
    || !["approved", "rejected", "needs_changes"].includes(String(value.decision))
    || !multiline(value.reason, 4_000, true) || !Array.isArray(value.findings)
    || value.findings.length > 100 || !dateTime(value.decided_at)) {
    throw new Error("Invalid operator review contract");
  }
  return { ...value, findings: value.findings.map(parseFinding) } as OperatorReviewRecord;
}

export function parseOperatorReviewQueuePage(value: unknown): OperatorReviewQueuePage {
  if (!exact(value, ["schema_version", "items", "next_cursor"]) || value.schema_version !== "1.0"
    || !Array.isArray(value.items) || value.items.length > 100
    || !(value.next_cursor === null || typeof value.next_cursor === "string"
      && value.next_cursor.length > 0 && value.next_cursor.length <= 256)) {
    throw new Error("Invalid operator queue-page contract");
  }
  return { schema_version: "1.0", items: value.items.map(parseItem), next_cursor: value.next_cursor };
}

export function parseOperatorSubmissionDetail(value: unknown): OperatorSubmissionDetail {
  if (!exact(value, ["schema_version", "item", "compatibility", "permissions", "evidence", "reviews", "can_review"])
    || value.schema_version !== "1.0" || !uniqueLines(value.permissions, 64)
    || !exact(value.evidence, ["digest", "size_bytes", "media_type", "policy_version"])
    || typeof value.evidence.digest !== "string" || !digestPattern.test(value.evidence.digest)
    || !Number.isSafeInteger(value.evidence.size_bytes) || Number(value.evidence.size_bytes) < 1
    || Number(value.evidence.size_bytes) > 10_737_418_240
    || !line(value.evidence.media_type, 200) || !line(value.evidence.policy_version, 100)
    || !Array.isArray(value.reviews) || value.reviews.length > 100 || typeof value.can_review !== "boolean") {
    throw new Error("Invalid operator submission-detail contract");
  }
  const item = parseItem(value.item);
  const reviews = value.reviews.map(parseReview);
  if (reviews.some((review) => review.revision !== item.submission.revision)) {
    throw new Error("Operator review does not belong to the current submission revision");
  }
  return {
    schema_version: "1.0",
    item,
    compatibility: parseCompatibility(value.compatibility),
    permissions: value.permissions,
    evidence: value.evidence as OperatorSubmissionDetail["evidence"],
    reviews,
    can_review: value.can_review,
  };
}
