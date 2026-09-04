use assetlibrary_contracts::{
    CreatePackageRequest, CreateReleaseRequest, CreateSubmissionRequest, HostProduct, PackageKind,
    PackageVisibility, ProductCompatibility, PublicCompatibility,
};
use serde_json::{Value, json};

use crate::{
    api::{PublisherApi, idempotency_key},
    cli::{Cli, Command, Kind, Visibility},
    error::CliError,
    manifest, package, upload,
};

pub async fn run(cli: &Cli) -> Result<Value, CliError> {
    match &cli.command {
        Command::Manifest(args) => manifest::create(args),
        Command::Pack(args) => package::pack(args),
        Command::Validate(args) => package::validate(args),
        Command::Digest(args) => package::digest(args),
        Command::Upload(args) => {
            let api = PublisherApi::new(&args.remote)?;
            upload::run(args, &api).await
        }
        Command::Submit(args) => {
            let api = PublisherApi::new(&args.remote)?;
            let key = idempotency_key(&args.idempotency_key)?;
            let request = CreateSubmissionRequest {
                artifact_id: args.artifact_id,
            };
            if args.release_id.is_nil() || args.artifact_id.is_nil() {
                return Err(CliError::Validation(
                    "release and artifact IDs must be non-nil".to_owned(),
                ));
            }
            let submission = api.submit(args.release_id, &key, &request).await?;
            if !submission.validate()
                || submission.release_id != args.release_id
                || submission.artifact_id != args.artifact_id
            {
                return Err(CliError::Validation(
                    "invalid submission response".to_owned(),
                ));
            }
            Ok(json!({
                "command": "submit",
                "idempotency_key": key,
                "submission": submission,
            }))
        }
        Command::Status(args) => {
            if args.release_id.is_nil() {
                return Err(CliError::Validation(
                    "release ID must be non-nil".to_owned(),
                ));
            }
            let api = PublisherApi::new(&args.remote)?;
            let workspace = api.workspace(args.release_id).await?;
            if workspace.release_id != args.release_id {
                return Err(CliError::Validation(
                    "workspace response is bound to another release".to_owned(),
                ));
            }
            Ok(json!({"command": "status", "workspace": workspace}))
        }
        Command::PackageCreate(args) => {
            if args.publisher_id.is_nil() {
                return Err(CliError::Validation(
                    "publisher ID must be non-nil".to_owned(),
                ));
            }
            let request = CreatePackageRequest {
                slug: args.slug.clone(),
                kind: package_kind(args.kind),
                visibility: visibility(args.visibility),
                name: args.name.clone(),
                summary: args.summary.clone(),
                description: args.description.clone(),
                tags: args.tags.clone(),
            };
            if !request.validate() {
                return Err(CliError::Validation(
                    "package fields violate the publisher contract".to_owned(),
                ));
            }
            let api = PublisherApi::new(&args.remote)?;
            let key = idempotency_key(&args.idempotency_key)?;
            let package = api
                .create_package(args.publisher_id, &key, &request)
                .await?;
            if !package.validate()
                || package.publisher_id != args.publisher_id
                || package.slug != request.slug
                || package.kind != request.kind
            {
                return Err(CliError::Validation("invalid package response".to_owned()));
            }
            Ok(json!({
                "command": "package-create",
                "idempotency_key": key,
                "package": package,
            }))
        }
        Command::ReleaseCreate(args) => {
            if args.package_id.is_nil() {
                return Err(CliError::Validation(
                    "package ID must be non-nil".to_owned(),
                ));
            }
            let request = CreateReleaseRequest {
                version: args.version.clone(),
                compatibility: compatibility(args.loom.as_deref(), args.hook.as_deref())?,
                permissions: args.permissions.clone(),
            };
            if !request.validate() {
                return Err(CliError::Validation(
                    "release fields violate the publisher contract".to_owned(),
                ));
            }
            let api = PublisherApi::new(&args.remote)?;
            let key = idempotency_key(&args.idempotency_key)?;
            let release = api.create_release(args.package_id, &key, &request).await?;
            if !release.validate()
                || release.package_id != args.package_id
                || release.version != request.version
            {
                return Err(CliError::Validation("invalid release response".to_owned()));
            }
            Ok(json!({
                "command": "release-create",
                "idempotency_key": key,
                "release": release,
            }))
        }
    }
}

fn package_kind(kind: Kind) -> PackageKind {
    match kind {
        Kind::Art => PackageKind::Art,
        Kind::Capability => PackageKind::Capability,
    }
}

fn visibility(value: Visibility) -> PackageVisibility {
    match value {
        Visibility::Public => PackageVisibility::Public,
        Visibility::Unlisted => PackageVisibility::Unlisted,
        Visibility::Private => PackageVisibility::Private,
    }
}

fn compatibility(loom: Option<&str>, hook: Option<&str>) -> Result<PublicCompatibility, CliError> {
    let mut products = Vec::with_capacity(2);
    if let Some(version_requirement) = loom {
        semver::VersionReq::parse(version_requirement).map_err(|_| {
            CliError::Validation("Loom compatibility must be a SemVer requirement".to_owned())
        })?;
        products.push(ProductCompatibility {
            name: HostProduct::Loom,
            version_requirement: version_requirement.to_owned(),
        });
    }
    if let Some(version_requirement) = hook {
        semver::VersionReq::parse(version_requirement).map_err(|_| {
            CliError::Validation("Hook compatibility must be a SemVer requirement".to_owned())
        })?;
        products.push(ProductCompatibility {
            name: HostProduct::Hook,
            version_requirement: version_requirement.to_owned(),
        });
    }
    Ok(PublicCompatibility { products })
}
