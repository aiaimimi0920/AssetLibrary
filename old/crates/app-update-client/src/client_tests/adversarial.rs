use tempfile::TempDir;

use super::*;

#[tokio::test]
async fn consistent_snapshot_rejects_mixed_targets_metadata() {
    let fixture = create_repository(false).await;
    let metadata = fixture.metadata.to_file_path().unwrap();
    let version_one_targets = tokio::fs::read(metadata.join("1.targets.json"))
        .await
        .unwrap();
    write_repository(fixture.directory.path(), 2, false).await;
    tokio::fs::write(metadata.join("2.targets.json"), version_one_targets)
        .await
        .unwrap();

    let state = TempDir::new().unwrap();
    assert!(
        AppUpdateRepository::load(RepositoryConfig::for_test(
            identity(),
            fixture.root,
            fixture.metadata,
            fixture.targets,
            state.path().to_owned(),
        ))
        .await
        .is_err()
    );
}

#[tokio::test]
async fn policy_epoch_rejects_rollback_after_tuf_datastore_loss() {
    let fixture = create_repository(false).await;
    let metadata = fixture.metadata.to_file_path().unwrap();
    let version_one_timestamp = tokio::fs::read(metadata.join("timestamp.json"))
        .await
        .unwrap();
    let state = TempDir::new().unwrap();
    let config = || {
        RepositoryConfig::for_test(
            identity(),
            fixture.root.clone(),
            fixture.metadata.clone(),
            fixture.targets.clone(),
            state.path().to_owned(),
        )
    };
    let initial = AppUpdateRepository::load(config()).await.unwrap();
    assert_eq!(initial.control(7).await.unwrap().policy_epoch(), 8);

    write_control(fixture.directory.path(), 9).await;
    write_repository(fixture.directory.path(), 2, false).await;
    let updated = AppUpdateRepository::load(config()).await.unwrap();
    assert_eq!(updated.control(8).await.unwrap().policy_epoch(), 9);

    tokio::fs::remove_dir_all(state.path()).await.unwrap();
    tokio::fs::write(metadata.join("timestamp.json"), version_one_timestamp)
        .await
        .unwrap();
    let reset = AppUpdateRepository::load(config()).await.unwrap();
    assert!(matches!(
        reset.control(9).await,
        Err(UpdateError::Policy("control policy epoch rolled back"))
    ));
}

async fn write_control(directory: &Path, policy_epoch: u64) {
    tokio::fs::write(
        directory.join("input/control.windows-x86_64.json"),
        serde_json::to_vec(&json!({
            "schema_version": "1.0", "product": "loom", "channel": "stable",
            "platform": "windows-x86_64", "policy_epoch": policy_epoch,
            "installation_enabled": true, "minimum_release_sequence": 39,
            "revoked_sha256": [], "reason": null
        }))
        .unwrap(),
    )
    .await
    .unwrap();
}
