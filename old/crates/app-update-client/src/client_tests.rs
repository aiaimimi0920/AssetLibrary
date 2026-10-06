use std::{collections::HashMap, num::NonZeroU64, path::Path};

use aws_lc_rs::{
    rand::SystemRandom,
    signature::{ECDSA_P256_SHA256_ASN1_SIGNING, EcdsaKeyPair, Ed25519KeyPair},
};
use jiff::{SignedDuration, Timestamp};
use serde_json::json;
use tempfile::TempDir;
use tough::{
    TargetName,
    editor::{RepositoryEditor, signed::PathExists},
    key_source::{KeySource, LocalKeySource},
    schema::{Role, RoleKeys, RoleType, Root, Signature, Signed, Target},
    sign::Sign,
};
use url::Url;

use crate::{
    AppUpdateRepository, Channel, InstalledRelease, Platform, Product, RepositoryConfig,
    RepositoryIdentity, UpdateError, UpdateUrgency,
};

mod adversarial;

struct TestRepository {
    directory: TempDir,
    root: Vec<u8>,
    metadata: Url,
    targets: Url,
    release_target: std::path::PathBuf,
}

#[tokio::test]
async fn signed_repository_control_selection_and_atomic_download() {
    let fixture = create_repository(false).await;
    let state = TempDir::new().unwrap();
    let staging = TempDir::new().unwrap();
    let repository = AppUpdateRepository::load(RepositoryConfig::for_test(
        identity(),
        fixture.root,
        fixture.metadata,
        fixture.targets,
        state.path().to_owned(),
    ))
    .await
    .unwrap();

    let installed = installed();
    let control = repository.control(installed.policy_epoch).await.unwrap();
    let candidate = repository
        .candidate("release.windows-x86_64.41.loom.zip", &installed, &control)
        .unwrap();
    assert_eq!(candidate.urgency(), UpdateUrgency::Optional);
    let output = repository
        .download(&candidate, staging.path())
        .await
        .unwrap();
    assert_eq!(
        tokio::fs::read(output).await.unwrap(),
        b"signed Loom update"
    );
}

#[tokio::test]
async fn target_tampering_fails_without_publishing_staged_bytes() {
    let fixture = create_repository(false).await;
    let state = TempDir::new().unwrap();
    let staging = TempDir::new().unwrap();
    let repository = AppUpdateRepository::load(RepositoryConfig::for_test(
        identity(),
        fixture.root,
        fixture.metadata,
        fixture.targets,
        state.path().to_owned(),
    ))
    .await
    .unwrap();
    let installed = installed();
    let control = repository.control(installed.policy_epoch).await.unwrap();
    let candidate = repository
        .candidate("release.windows-x86_64.41.loom.zip", &installed, &control)
        .unwrap();
    tokio::fs::write(&fixture.release_target, b"tampered")
        .await
        .unwrap();
    assert!(
        repository
            .download(&candidate, staging.path())
            .await
            .is_err()
    );
    assert!(
        !staging
            .path()
            .join("release.windows-x86_64.41.loom.zip")
            .exists()
    );
}

#[tokio::test]
async fn expired_timestamp_and_altered_metadata_fail_closed() {
    let expired = create_repository(true).await;
    let state = TempDir::new().unwrap();
    assert!(
        AppUpdateRepository::load(RepositoryConfig::for_test(
            identity(),
            expired.root,
            expired.metadata,
            expired.targets,
            state.path().to_owned(),
        ))
        .await
        .is_err()
    );

    let altered = create_repository(false).await;
    let timestamp = altered
        .metadata
        .to_file_path()
        .unwrap()
        .join("timestamp.json");
    let mut bytes = tokio::fs::read(&timestamp).await.unwrap();
    let index = bytes.len() / 2;
    bytes[index] ^= 1;
    tokio::fs::write(timestamp, bytes).await.unwrap();
    let state = TempDir::new().unwrap();
    assert!(
        AppUpdateRepository::load(RepositoryConfig::for_test(
            identity(),
            altered.root,
            altered.metadata,
            altered.targets,
            state.path().to_owned(),
        ))
        .await
        .is_err()
    );
}

#[tokio::test]
async fn persistent_datastore_rejects_metadata_version_rollback() {
    let fixture = create_repository(false).await;
    let state = TempDir::new().unwrap();
    let timestamp_path = fixture
        .metadata
        .to_file_path()
        .unwrap()
        .join("timestamp.json");
    let version_one_timestamp = tokio::fs::read(&timestamp_path).await.unwrap();
    let load = |root: Vec<u8>| {
        RepositoryConfig::for_test(
            identity(),
            root,
            fixture.metadata.clone(),
            fixture.targets.clone(),
            state.path().to_owned(),
        )
    };
    AppUpdateRepository::load(load(fixture.root.clone()))
        .await
        .unwrap();
    write_repository(fixture.directory.path(), 2, false).await;
    AppUpdateRepository::load(load(fixture.root.clone()))
        .await
        .unwrap();
    tokio::fs::write(timestamp_path, version_one_timestamp)
        .await
        .unwrap();
    assert!(
        AppUpdateRepository::load(load(fixture.root.clone()))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn root_rotation_requires_old_and_new_thresholds() {
    let valid = create_repository(false).await;
    write_rotated_root(valid.directory.path(), 2, 2).await;
    let state = TempDir::new().unwrap();
    let repository = AppUpdateRepository::load(RepositoryConfig::for_test(
        identity(),
        valid.root,
        valid.metadata,
        valid.targets,
        state.path().to_owned(),
    ))
    .await
    .unwrap();
    assert_eq!(repository.trusted_root_version(), 2);

    for (old_signatures, new_signatures) in [(1, 2), (2, 1)] {
        let invalid = create_repository(false).await;
        write_rotated_root(invalid.directory.path(), old_signatures, new_signatures).await;
        let state = TempDir::new().unwrap();
        assert!(
            AppUpdateRepository::load(RepositoryConfig::for_test(
                identity(),
                invalid.root,
                invalid.metadata,
                invalid.targets,
                state.path().to_owned(),
            ))
            .await
            .is_err()
        );
    }
}

#[tokio::test]
async fn online_roles_reject_ed25519_algorithm_drift() {
    let fixture = create_repository_with_online_algorithm(false, false).await;
    let state = TempDir::new().unwrap();
    let result = AppUpdateRepository::load(RepositoryConfig::for_test(
        identity(),
        fixture.root,
        fixture.metadata,
        fixture.targets,
        state.path().to_owned(),
    ))
    .await;
    assert!(matches!(
        result,
        Err(UpdateError::Policy(
            "root roles must use distinct keys with approved algorithms"
        ))
    ));
}

async fn create_repository(expired: bool) -> TestRepository {
    create_repository_with_online_algorithm(expired, true).await
}

async fn create_repository_with_online_algorithm(
    expired: bool,
    online_ecdsa: bool,
) -> TestRepository {
    let directory = TempDir::new().unwrap();
    create_root(directory.path(), online_ecdsa).await;
    let root_path = directory.path().join("root.json");
    let root = tokio::fs::read(&root_path).await.unwrap();
    let input = directory.path().join("input");
    tokio::fs::create_dir(&input).await.unwrap();
    let control_name = "control.windows-x86_64.json";
    let release_name = "release.windows-x86_64.41.loom.zip";
    tokio::fs::write(
        input.join(control_name),
        serde_json::to_vec(&json!({
            "schema_version": "1.0", "product": "loom", "channel": "stable",
            "platform": "windows-x86_64", "policy_epoch": 8,
            "installation_enabled": true, "minimum_release_sequence": 39,
            "revoked_sha256": [], "reason": null
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    tokio::fs::write(input.join(release_name), b"signed Loom update")
        .await
        .unwrap();

    write_repository(directory.path(), 1, expired).await;
    let metadata_path = directory.path().join("metadata");
    let targets_path = directory.path().join("targets");
    let release_target = find_hashed_target(&targets_path, release_name);
    TestRepository {
        directory,
        root,
        metadata: Url::from_directory_path(metadata_path).unwrap(),
        targets: Url::from_directory_path(targets_path).unwrap(),
        release_target,
    }
}

async fn write_repository(directory: &Path, version: u64, expired: bool) {
    let root_path = directory.join("root.json");
    let input = directory.join("input");
    let control_name = "control.windows-x86_64.json";
    let release_name = "release.windows-x86_64.41.loom.zip";
    let now = Timestamp::now();
    let normal_expiry = now + SignedDuration::from_hours(24);
    let timestamp_expiry = if expired {
        now - SignedDuration::from_hours(1)
    } else {
        normal_expiry
    };
    let mut editor = RepositoryEditor::new(&root_path).await.unwrap();
    editor
        .targets_version(NonZeroU64::new(version).unwrap())
        .unwrap()
        .targets_expires(normal_expiry)
        .unwrap()
        .snapshot_version(NonZeroU64::new(version).unwrap())
        .snapshot_expires(normal_expiry)
        .timestamp_version(NonZeroU64::new(version).unwrap())
        .timestamp_expires(timestamp_expiry);
    editor
        .add_target_path(input.join(control_name))
        .await
        .unwrap();
    let mut release = Target::from_path(input.join(release_name)).await.unwrap();
    release.custom.insert(
        "neuro_app_update".into(),
        json!({
            "schema_version": "1.0", "product": "loom", "channel": "stable",
            "platform": "windows-x86_64", "version": "1.4.0",
            "release_sequence": 41, "updater_protocol": 1
        }),
    );
    editor
        .add_target(TargetName::new(release_name).unwrap(), release)
        .unwrap();
    let signed = editor.sign(&key_sources(directory)).await.unwrap();
    let metadata_path = directory.join("metadata");
    let targets_path = directory.join("targets");
    signed.write(&metadata_path).await.unwrap();
    signed
        .copy_targets(&input, &targets_path, PathExists::Skip)
        .await
        .unwrap();
}

async fn create_root(directory: &Path, online_ecdsa: bool) {
    let random = SystemRandom::new();
    let mut pairs: Vec<Box<dyn Sign>> = Vec::new();
    let mut documents = Vec::new();
    for _ in 0..6 {
        let document = Ed25519KeyPair::generate_pkcs8(&random).unwrap();
        pairs.push(Box::new(
            Ed25519KeyPair::from_pkcs8(document.as_ref()).unwrap(),
        ));
        documents.push(document.as_ref().to_vec());
    }
    for _ in 0..2 {
        if online_ecdsa {
            let document =
                EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &random).unwrap();
            pairs.push(Box::new(
                EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, document.as_ref())
                    .unwrap(),
            ));
            documents.push(document.as_ref().to_vec());
        } else {
            let document = Ed25519KeyPair::generate_pkcs8(&random).unwrap();
            pairs.push(Box::new(
                Ed25519KeyPair::from_pkcs8(document.as_ref()).unwrap(),
            ));
            documents.push(document.as_ref().to_vec());
        }
    }
    let mut public_keys = HashMap::new();
    let ids = pairs
        .iter()
        .map(|pair| {
            let key = pair.tuf_key();
            let id = key.key_id().unwrap();
            public_keys.insert(id.clone(), key);
            id
        })
        .collect::<Vec<_>>();
    let roles = HashMap::from([
        (RoleType::Root, role(&ids[0..3], 2)),
        (RoleType::Targets, role(&ids[3..6], 2)),
        (RoleType::Snapshot, role(&ids[6..7], 1)),
        (RoleType::Timestamp, role(&ids[7..8], 1)),
    ]);
    let root = Root {
        spec_version: "1.0.0".into(),
        consistent_snapshot: true,
        version: NonZeroU64::new(1).unwrap(),
        expires: Timestamp::now() + SignedDuration::from_hours(24),
        keys: public_keys,
        roles,
        _extra: HashMap::new(),
    };
    let canonical = root.canonical_form().unwrap();
    let mut signatures = Vec::new();
    for index in 0..2 {
        signatures.push(Signature {
            keyid: ids[index].clone(),
            sig: pairs[index].sign(&canonical, &random).await.unwrap().into(),
        });
    }
    tokio::fs::write(
        directory.join("root.json"),
        serde_json::to_vec(&Signed {
            signed: root,
            signatures,
        })
        .unwrap(),
    )
    .await
    .unwrap();
    for (index, document) in documents.into_iter().enumerate() {
        let path = directory.join(format!("key-{index}.der"));
        tokio::fs::write(&path, document).await.unwrap();
    }
}

async fn write_rotated_root(directory: &Path, old_count: usize, new_count: usize) {
    let old_bytes = tokio::fs::read(directory.join("root.json")).await.unwrap();
    let old: Signed<Root> = serde_json::from_slice(&old_bytes).unwrap();
    let old_ids = old.signed.roles[&RoleType::Root].keyids.clone();
    let mut root = old.signed;
    for key_id in &old_ids {
        root.keys.remove(key_id);
    }
    let random = SystemRandom::new();
    let mut new_pairs = Vec::new();
    let mut new_ids = Vec::new();
    for _ in 0..3 {
        let document = Ed25519KeyPair::generate_pkcs8(&random).unwrap();
        let pair = Ed25519KeyPair::from_pkcs8(document.as_ref()).unwrap();
        let key = pair.tuf_key();
        let key_id = key.key_id().unwrap();
        root.keys.insert(key_id.clone(), key);
        new_ids.push(key_id);
        new_pairs.push(pair);
    }
    root.roles.get_mut(&RoleType::Root).unwrap().keyids = new_ids.clone();
    root.version = NonZeroU64::new(2).unwrap();
    root.expires = Timestamp::now() + SignedDuration::from_hours(24);
    let canonical = root.canonical_form().unwrap();
    let mut signatures = Vec::new();
    for (index, key_id) in old_ids.iter().take(old_count).enumerate() {
        let document = tokio::fs::read(directory.join(format!("key-{index}.der")))
            .await
            .unwrap();
        let pair = Ed25519KeyPair::from_pkcs8(&document).unwrap();
        signatures.push(signature(key_id.clone(), &pair, &canonical, &random).await);
    }
    for (key_id, pair) in new_ids.iter().zip(&new_pairs).take(new_count) {
        signatures.push(signature(key_id.clone(), pair, &canonical, &random).await);
    }
    tokio::fs::write(
        directory.join("metadata/2.root.json"),
        serde_json::to_vec(&Signed {
            signed: root,
            signatures,
        })
        .unwrap(),
    )
    .await
    .unwrap();
}

async fn signature(
    keyid: tough::schema::decoded::Decoded<tough::schema::decoded::Hex>,
    pair: &Ed25519KeyPair,
    canonical: &[u8],
    random: &SystemRandom,
) -> Signature {
    Signature {
        keyid,
        sig: Sign::sign(pair, canonical, random).await.unwrap().into(),
    }
}

fn key_sources(directory: &Path) -> Vec<Box<dyn KeySource>> {
    (0..8)
        .map(|index| {
            Box::new(LocalKeySource {
                path: directory.join(format!("key-{index}.der")),
            }) as Box<dyn KeySource>
        })
        .collect()
}

fn role(
    ids: &[tough::schema::decoded::Decoded<tough::schema::decoded::Hex>],
    threshold: u64,
) -> RoleKeys {
    RoleKeys {
        keyids: ids.to_vec(),
        threshold: NonZeroU64::new(threshold).unwrap(),
        _extra: HashMap::new(),
    }
}

fn find_hashed_target(directory: &Path, name: &str) -> std::path::PathBuf {
    std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| path.file_name().unwrap().to_string_lossy().ends_with(name))
        .unwrap()
}

fn identity() -> RepositoryIdentity {
    RepositoryIdentity {
        product: Product::Loom,
        channel: Channel::Stable,
        platform: Platform::WindowsX86_64,
    }
}

fn installed() -> InstalledRelease {
    InstalledRelease {
        sequence: 40,
        sha256: "a".repeat(64),
        policy_epoch: 7,
    }
}
