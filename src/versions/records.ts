import { decodeFormats, defaultAssetAttributes } from "../assets/taxonomy";
import { HttpError } from "../http";
import { policyKindSql } from "../inspections/policy";
import type { ScannerRelease } from "../scanner/deployment";
import { defaultPolicySpaceSql, effectiveVersionSpace } from "../spaces/catalog";
import { withOptionalSchemas } from "../spaces/optional-schemas";
import { versionSafety } from "./safety";

export interface VersionRow {
  id: string;
  resource_id: string;
  label: string;
  resource_revision: number;
  title: string;
  kind: string;
  upload_id: string;
  upload_revision: number;
  expected_size: number;
  sha256: string;
  etag: string;
  inspection_id: string;
  inspection_revision: number;
  inspection_policy: string;
  inspection_result: string | null;
  profile_space: string | null;
  summary: string | null;
  detail: string | null;
  cover_key: string | null;
  cover_sha256: string | null;
  cover_size: number | null;
  cover_width: number | null;
  cover_height: number | null;
  asset_category: string | null;
  asset_style: string | null;
  asset_formats: string | null;
  asset_license: string | null;
  state: "pending_review" | "approved" | "rejected" | "withdrawn";
  revision: number;
  reviewer: string | null;
  review_decision: string | null;
  review_reason: string | null;
  reviewed_at: number | null;
  created_at: number;
  updated_at: number;
  last_operation: string;
  owner: string;
  binding_current: number;
  publication_id: string | null;
  publication_state: string | null;
  publication_revision: number | null;
}

// 批准事务和查询共用完整快照条件；历史 passed 不能替代当前资源/上传/展示信息身份。
export function currentSnapshotFor(hasShowcase = true, hasAssetMarket = false) {
  const profileGuard = hasShowcase
    ? `AND NOT EXISTS (
    SELECT 1 FROM version_profiles vp LEFT JOIN resource_profiles rp ON rp.resource_id = r.id
    WHERE vp.version_id = versions.id
    AND (
      COALESCE(rp.space, ${defaultPolicySpaceSql("i.policy")}) <> vp.space
      OR COALESCE(rp.summary, '') <> vp.summary
      OR COALESCE(rp.detail, '') <> vp.detail
      OR COALESCE(rp.cover_sha256, '') <> COALESCE(vp.cover_sha256, '')
    )
  )`
    : "";
  const assetGuard = hasAssetMarket
    ? `AND NOT EXISTS (
    SELECT 1 FROM version_asset_attributes va
    LEFT JOIN resource_asset_attributes ra ON ra.resource_id = r.id
    WHERE va.version_id = versions.id
    AND (
      COALESCE(ra.category, 'general') <> va.category
      OR COALESCE(ra.style, 'general') <> va.style
      OR COALESCE(ra.formats, '[]') <> va.formats
      OR COALESCE(ra.license, 'unspecified') <> va.license
    )
  )`
    : "";
  return `EXISTS (SELECT 1 FROM resources r
  JOIN uploads u ON u.resource_id = r.id JOIN inspections i ON i.upload_id = u.id
  WHERE r.id = versions.resource_id AND r.state = 'draft' AND r.kind = versions.kind
  AND r.revision = versions.resource_revision AND r.title = versions.title AND u.owner = r.owner
  AND u.id = versions.upload_id AND u.state = 'quarantined' AND u.revision = versions.upload_revision
  AND u.expected_size = versions.expected_size AND u.sha256 = versions.sha256 AND u.etag = versions.etag
  AND i.id = versions.inspection_id AND i.state = 'passed' AND i.revision = versions.inspection_revision
  AND i.policy = versions.inspection_policy AND i.upload_revision = u.revision
  AND r.kind = ${policyKindSql("i.policy")}
  AND i.expected_size = u.expected_size AND i.sha256 = u.sha256 AND i.etag = u.etag
  AND json_extract(i.result, '$.sha256') = u.sha256
  ${profileGuard}
  ${assetGuard})`;
}

export const currentSnapshot = currentSnapshotFor(true, true);

export function versionSelectFor(hasShowcase = true, hasAssetMarket = false) {
  const columns = hasShowcase
    ? `vp.space AS profile_space, vp.summary, vp.detail,
      vp.cover_key, vp.cover_sha256, vp.cover_size, vp.cover_width, vp.cover_height`
    : `NULL AS profile_space, NULL AS summary, NULL AS detail,
      NULL AS cover_key, NULL AS cover_sha256, NULL AS cover_size, NULL AS cover_width, NULL AS cover_height`;
  const assetColumns = hasAssetMarket
    ? `va.category AS asset_category, va.style AS asset_style,
      va.formats AS asset_formats, va.license AS asset_license`
    : `NULL AS asset_category, NULL AS asset_style,
      NULL AS asset_formats, NULL AS asset_license`;
  return `SELECT versions.*, r.owner, checked.result AS inspection_result,
  ${columns},
  ${assetColumns},
  p.id AS publication_id, p.state AS publication_state, p.revision AS publication_revision,
  CASE WHEN ${currentSnapshotFor(hasShowcase, hasAssetMarket)} THEN 1 ELSE 0 END AS binding_current
  FROM versions JOIN resources r ON r.id = versions.resource_id
  JOIN inspections checked ON checked.id = versions.inspection_id
  ${hasShowcase ? "LEFT JOIN version_profiles vp ON vp.version_id = versions.id" : ""}
  ${hasAssetMarket ? "LEFT JOIN version_asset_attributes va ON va.version_id = versions.id" : ""}
  LEFT JOIN publications p ON p.version_id = versions.id`;
}

export const versionSelect = versionSelectFor(true, true);

export async function loadVersion(db: D1Database, id: string): Promise<VersionRow> {
  const row = await withOptionalSchemas(db, (showcase, assetMarket) =>
    db
      .prepare(`${versionSelectFor(showcase, assetMarket)} WHERE versions.id = ?`)
      .bind(id)
      .first<VersionRow>(),
  );
  if (!row) throw new HttpError(404, "NOT_FOUND");
  return row;
}

export function versionView(row: VersionRow, release: ScannerRelease | null = null) {
  const safety = versionSafety(row, release);
  return {
    id: row.id,
    resourceId: row.resource_id,
    label: row.label,
    state: row.state,
    revision: row.revision,
    snapshot: {
      resourceRevision: row.resource_revision,
      title: row.title,
      kind: row.kind,
      space: effectiveVersionSpace(row.profile_space, row.inspection_policy),
      summary: row.summary ?? "",
      detail: row.detail ?? "",
      cover:
        row.cover_key === null
          ? null
          : {
              sha256: row.cover_sha256,
              size: row.cover_size,
              width: row.cover_width,
              height: row.cover_height,
              url: `/v1/versions/${row.id}/cover`,
            },
      assetAttributes: {
        category: row.asset_category ?? defaultAssetAttributes.category,
        style: row.asset_style ?? defaultAssetAttributes.style,
        formats: decodeFormats(row.asset_formats),
        license: row.asset_license ?? defaultAssetAttributes.license,
      },
      uploadId: row.upload_id,
      uploadRevision: row.upload_revision,
      size: row.expected_size,
      sha256: row.sha256,
      etag: row.etag,
      inspection: {
        id: row.inspection_id,
        revision: row.inspection_revision,
        policy: row.inspection_policy,
      },
    },
    review:
      row.reviewer === null
        ? null
        : {
            reviewer: row.reviewer,
            decision: row.review_decision,
            reason: row.review_reason,
            at: row.reviewed_at,
          },
    bindingCurrent: row.binding_current === 1,
    publication:
      row.publication_id === null
        ? null
        : {
            id: row.publication_id,
            state: row.publication_state,
            revision: row.publication_revision,
          },
    publicationEligible:
      row.state === "approved" &&
      row.binding_current === 1 &&
      (safety.cloudValidated || safety.unscanned) &&
      row.publication_id === null,
    contentSafety: {
      scanStatus: safety.unscanned ? "not_scanned" : safety.scanCurrent ? "scanned" : "unavailable",
      scan: safety.scan,
      scanCurrent: safety.scanCurrent,
      cloudValidated: safety.cloudValidated,
    },
    publicationBlockers: [
      ...(row.state === "approved" ? [] : ["VERSION_NOT_APPROVED"]),
      ...(row.binding_current === 1 ? [] : ["VERSION_BINDING_CHANGED"]),
      ...(safety.blocker ? [safety.blocker] : []),
      ...(row.publication_id === null ? [] : ["VERSION_ALREADY_PUBLISHED"]),
    ],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function versionEvent(
  db: D1Database,
  id: string,
  operation: string,
  actor: string,
  action: string,
  reason: string | null,
  now: number,
) {
  return db
    .prepare(`INSERT INTO version_events(operation_id, version_id, actor, action, revision, reason, created_at)
    SELECT ?, id, ?, ?, revision, ?, ? FROM versions WHERE id = ? AND last_operation = ?`)
    .bind(operation, actor, action, reason, now, id, operation);
}
