import type { PackageKind } from "./contracts";

export type PublisherRole = "owner" | "maintainer" | "release_manager";
export type PublisherState = "pending" | "active" | "suspended" | "closed";
export type PackageVisibility = "public" | "unlisted" | "private";
export type OwnedPackageStatus =
  | "draft"
  | "submitted"
  | "published"
  | "suspended"
  | "deprecated"
  | "archived";
export type OwnedReleaseStatus =
  | "draft"
  | "uploading"
  | "submitted"
  | "in_review"
  | "approved"
  | "published"
  | "rejected"
  | "yanked";

export interface PrincipalRef {
  issuer: string;
  subject: string;
}

export interface PublisherMembership {
  publisher: { id: string; slug: string; display_name: string };
  publisher_status: PublisherState;
  role: PublisherRole;
}

export interface PublisherMembershipPage {
  schema_version: "1.0";
  items: PublisherMembership[];
  next_cursor: string | null;
}

export interface OwnedPackageSummary {
  id: string;
  publisher_id: string;
  slug: string;
  kind: PackageKind;
  status: OwnedPackageStatus;
  visibility: PackageVisibility;
  name: string;
  summary: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface OwnedPackage extends OwnedPackageSummary {
  description: string;
}

export interface OwnedPackagePage {
  schema_version: "1.0";
  items: OwnedPackageSummary[];
  next_cursor: string | null;
}

export interface CreatePackageRequest {
  slug: string;
  kind: PackageKind;
  visibility: PackageVisibility;
  name: string;
  summary: string;
  description: string;
  tags: string[];
}

export interface UpdatePackageRequest {
  expected_updated_at: string;
  visibility: PackageVisibility;
  name: string;
  summary: string;
  description: string;
  tags: string[];
}

export interface ProductCompatibility {
  name: "loom" | "hook";
  version_requirement: string;
}

export interface PublicCompatibility {
  products: ProductCompatibility[];
}

export interface OwnedRelease {
  id: string;
  package_id: string;
  version: string;
  status: OwnedReleaseStatus;
  compatibility: PublicCompatibility;
  permissions: string[];
  created_by: PrincipalRef;
  published_at: string | null;
  yanked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OwnedReleasePage {
  schema_version: "1.0";
  items: OwnedRelease[];
  next_cursor: string | null;
}

export interface CreateReleaseRequest {
  version: string;
  compatibility: PublicCompatibility;
  permissions: string[];
}

export interface UpdateReleaseRequest {
  expected_updated_at: string;
  compatibility: PublicCompatibility;
  permissions: string[];
}
