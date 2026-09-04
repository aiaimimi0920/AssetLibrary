use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityManifest {
    pub schema_version: u32,
    pub kind: String,
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub publisher: Publisher,
    pub host_compatibility: HostCompatibility,
    pub entrypoints: Entrypoints,
    pub activation_events: Vec<String>,
    pub contributes: Contributions,
    pub permissions: Vec<String>,
    pub resources: ResourceLimits,
    pub dependencies: Vec<Dependency>,
    pub signature: Signature,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Publisher {
    pub id: String,
    pub key_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApiRequirement {
    pub minimum: String,
    #[serde(default)]
    pub maximum: Option<String>,
    #[serde(default)]
    pub required_features: Vec<String>,
    #[serde(default)]
    pub optional_features: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostCompatibility {
    pub loom_capability_api: ApiRequirement,
    pub hook_extension_api: ApiRequirement,
    #[serde(default)]
    pub surface_api: Option<ApiRequirement>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entrypoints {
    #[serde(default)]
    pub service: Option<ServiceEntrypoint>,
    #[serde(default)]
    pub hook_ui: Option<SurfaceEntrypoint>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceEntrypoint {
    pub targets: BTreeMap<String, TargetCommand>,
    pub process_model: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TargetCommand {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceEntrypoint {
    pub kind: String,
    pub manifest: String,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Contributions {
    #[serde(default)]
    pub commands: Vec<CommandContribution>,
    #[serde(default)]
    pub shortcuts: Vec<Contribution>,
    #[serde(default)]
    pub menus: Vec<Contribution>,
    #[serde(default)]
    pub settings: Vec<Contribution>,
    #[serde(default)]
    pub data_types: Vec<Contribution>,
    #[serde(default)]
    pub renderers: Vec<Contribution>,
    #[serde(default)]
    pub unit_overlays: Vec<Contribution>,
    #[serde(default)]
    pub background_tasks: Vec<Contribution>,
    #[serde(default)]
    pub resource_providers: Vec<Contribution>,
    #[serde(default)]
    pub diagnostics: Vec<Contribution>,
    #[serde(default)]
    pub event_subscriptions: Vec<Contribution>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandContribution {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub input_schema: Option<String>,
    #[serde(default)]
    pub output_schema: Option<String>,
    #[serde(default)]
    pub when: Option<String>,
    #[serde(default)]
    pub requires_user_gesture: bool,
    #[serde(default = "default_true")]
    pub cancellable: bool,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub permissions: Vec<String>,
}

const fn default_true() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Contribution {
    pub id: String,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub when: Option<String>,
    #[serde(default)]
    pub schema: Option<String>,
    #[serde(default)]
    pub placement: Option<String>,
    #[serde(default)]
    pub order: Option<i32>,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceLimits {
    #[serde(rename = "memoryMiB")]
    pub memory_mib: u64,
    pub max_processes: u32,
    pub timeout_seconds: u64,
    #[serde(default)]
    pub disk_mib: Option<u64>,
    #[serde(default)]
    pub stderr_kib_per_minute: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Dependency {
    pub id: String,
    pub version: String,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub optional: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Signature {
    pub algorithm: String,
    pub key_id: String,
    pub file: String,
}
