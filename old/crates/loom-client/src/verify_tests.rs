use assetlibrary_contracts::PackageKind;
use serde_json::json;

use crate::{ClientError, test_support::host, verify::negotiate_host};

#[test]
fn capability_negotiation_requires_api_features_and_platform() {
    let host = host();
    let mut manifest = json!({
        "hostCompatibility": {
            "loomCapabilityApi": {"minimum":"1.0","maximum":"1.2","requiredFeatures":["surface.basic"]},
            "hookExtensionApi": {"minimum":"1.0","requiredFeatures":[]},
            "surfaceApi": {"minimum":"1.0","requiredFeatures":["surface.basic"]}
        },
        "entrypoints": {"service":{"targets":{"windows-x64":{"command":"runtime.exe"}}}}
    });
    assert!(negotiate_host(&manifest, &PackageKind::Capability, &host).is_ok());

    manifest["hostCompatibility"]["loomCapabilityApi"]["requiredFeatures"] =
        json!(["not-supported"]);
    assert!(matches!(
        negotiate_host(&manifest, &PackageKind::Capability, &host),
        Err(ClientError::HostIncompatible)
    ));
    manifest["hostCompatibility"]["loomCapabilityApi"]["requiredFeatures"] = json!([]);
    manifest["entrypoints"]["service"]["targets"] = json!({"linux-x64":{"command":"runtime"}});
    assert!(matches!(
        negotiate_host(&manifest, &PackageKind::Capability, &host),
        Err(ClientError::HostIncompatible)
    ));
}

#[test]
fn art_negotiation_requires_ready_framework_surface_nodes_and_features() {
    let manifest = json!({
        "execution":{"framework":"neuro/runtime"},
        "metadata":{
            "dependencies":{"frameworkVersion":"^1.0"},
            "capabilities":{"surface":{
                "apiVersion":"1.0",
                "requiredNodes":["panel"],
                "requiredCapabilities":["surface.basic"],
                "variants":[{"requiredCapabilities":["surface.basic"]}]
            }}
        }
    });
    let mut host = host();
    assert!(negotiate_host(&manifest, &PackageKind::Art, &host).is_ok());

    host.frameworks[0].ready = false;
    assert!(matches!(
        negotiate_host(&manifest, &PackageKind::Art, &host),
        Err(ClientError::HostIncompatible)
    ));
    host.frameworks[0].ready = true;
    host.surface_nodes.clear();
    assert!(matches!(
        negotiate_host(&manifest, &PackageKind::Art, &host),
        Err(ClientError::HostIncompatible)
    ));
}
