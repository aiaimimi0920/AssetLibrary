import createClient, { type ClientOptions } from "openapi-fetch";
import type { paths as ConsumerPaths } from "./generated/consumer";
import type { paths as OperatorModerationPaths } from "./generated/operator-moderation";
import type { paths as OperatorReviewPaths } from "./generated/operator-review";
import type { paths as PublicPaths } from "./generated/public";
import type { paths as PublisherModerationPaths } from "./generated/publisher-moderation";
import type { paths as PublisherPackagePaths } from "./generated/publisher-packages";
import type { paths as PublisherReleasePaths } from "./generated/publisher-releases";
import type { paths as PublisherSigningPaths } from "./generated/publisher-signing";
import type { paths as PublisherSubmissionPaths } from "./generated/publisher-submissions";
import type { paths as PublisherUploadPaths } from "./generated/publisher-upload";

export type {
  ConsumerPaths,
  OperatorModerationPaths,
  OperatorReviewPaths,
  PublicPaths,
  PublisherModerationPaths,
  PublisherPackagePaths,
  PublisherReleasePaths,
  PublisherSigningPaths,
  PublisherSubmissionPaths,
  PublisherUploadPaths,
};

export const createPublicClient = (options: ClientOptions) => createClient<PublicPaths>(options);
export const createConsumerClient = (options: ClientOptions) => createClient<ConsumerPaths>(options);
export const createPublisherPackageClient = (options: ClientOptions) => createClient<PublisherPackagePaths>(options);
export const createPublisherReleaseClient = (options: ClientOptions) => createClient<PublisherReleasePaths>(options);
export const createPublisherSigningClient = (options: ClientOptions) => createClient<PublisherSigningPaths>(options);
export const createPublisherUploadClient = (options: ClientOptions) => createClient<PublisherUploadPaths>(options);
export const createPublisherSubmissionClient = (options: ClientOptions) => createClient<PublisherSubmissionPaths>(options);
export const createPublisherModerationClient = (options: ClientOptions) => createClient<PublisherModerationPaths>(options);
export const createOperatorReviewClient = (options: ClientOptions) => createClient<OperatorReviewPaths>(options);
export const createOperatorModerationClient = (options: ClientOptions) => createClient<OperatorModerationPaths>(options);
