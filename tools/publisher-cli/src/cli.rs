use clap::{Args, Parser, Subcommand, ValueEnum};
use std::path::PathBuf;
use uuid::Uuid;

#[derive(Parser)]
#[command(
    name = "assetlibrary-publisher",
    version,
    about = "AssetLibrary publisher CLI"
)]
pub struct Cli {
    /// Emit one compact JSON document on stdout.
    #[arg(long, global = true)]
    pub json: bool,
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand)]
pub enum Command {
    Manifest(ManifestArgs),
    Pack(PackArgs),
    Validate(ValidateArgs),
    Digest(DigestArgs),
    Upload(UploadArgs),
    Submit(SubmitArgs),
    Status(StatusArgs),
    PackageCreate(PackageCreateArgs),
    ReleaseCreate(ReleaseCreateArgs),
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum Kind {
    Art,
    Capability,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum Visibility {
    Public,
    Unlisted,
    Private,
}

#[derive(Args)]
pub struct IdentityArgs {
    #[arg(long, value_enum)]
    pub kind: Kind,
    #[arg(long)]
    pub publisher: String,
    #[arg(long)]
    pub package: String,
    #[arg(long)]
    pub version: String,
    #[arg(long = "permission")]
    pub permissions: Vec<String>,
}

#[derive(Args)]
pub struct ManifestArgs {
    #[command(flatten)]
    pub identity: IdentityArgs,
    #[arg(long)]
    pub key_id: String,
    #[arg(long)]
    pub output_dir: PathBuf,
    #[arg(long, default_value = "neuro/runtime")]
    pub framework: String,
    #[arg(long, default_value = "^1.0")]
    pub framework_version: String,
    #[arg(long, default_value = "runtime/main.exe")]
    pub command: String,
    #[arg(long, default_value = "windows-x64")]
    pub platform: String,
}

#[derive(Args)]
pub struct PackArgs {
    #[command(flatten)]
    pub identity: IdentityArgs,
    #[arg(long)]
    pub source: PathBuf,
    #[arg(long)]
    pub output: PathBuf,
    #[arg(long)]
    pub private_key: PathBuf,
    #[arg(long)]
    pub key_id: String,
    #[arg(long, default_value = "signature.json")]
    pub signature_file: String,
    /// Archive-relative paths that must retain executable mode on Unix.
    #[arg(long = "executable")]
    pub executables: Vec<String>,
    #[arg(long)]
    pub dry_run: bool,
}

#[derive(Args)]
pub struct ValidateArgs {
    #[command(flatten)]
    pub identity: IdentityArgs,
    #[arg(long)]
    pub archive: PathBuf,
    /// File containing canonical base64 for the trusted 32-byte Ed25519 public key.
    #[arg(long)]
    pub public_key: PathBuf,
    #[arg(long)]
    pub key_id: String,
}

#[derive(Args)]
pub struct DigestArgs {
    #[arg(long)]
    pub archive: PathBuf,
    #[arg(long, default_value = "signature.json")]
    pub signature_file: String,
}

#[derive(Clone, Args)]
pub struct RemoteArgs {
    #[arg(long, env = "ASSETLIBRARY_API_URL")]
    pub api_url: String,
    /// Name of the environment variable holding the opaque Account Service bearer.
    #[arg(long, default_value = "ASSETLIBRARY_TOKEN")]
    pub token_env: String,
    #[arg(long)]
    pub allow_http: bool,
}

#[derive(Args)]
pub struct UploadArgs {
    #[command(flatten)]
    pub remote: RemoteArgs,
    #[arg(long)]
    pub release_id: Uuid,
    #[arg(long)]
    pub archive: PathBuf,
    #[arg(long)]
    pub resume_file: Option<PathBuf>,
    #[arg(long, default_value_t = 8)]
    pub part_size_mib: u64,
    #[arg(
        long,
        env = "ASSETLIBRARY_UPLOAD_ORIGINS",
        value_delimiter = ',',
        required = true
    )]
    pub upload_origins: Vec<String>,
}

#[derive(Args)]
pub struct SubmitArgs {
    #[command(flatten)]
    pub remote: RemoteArgs,
    #[arg(long)]
    pub release_id: Uuid,
    #[arg(long)]
    pub artifact_id: Uuid,
    #[arg(long)]
    pub idempotency_key: Option<String>,
}

#[derive(Args)]
pub struct StatusArgs {
    #[command(flatten)]
    pub remote: RemoteArgs,
    #[arg(long)]
    pub release_id: Uuid,
}

#[derive(Args)]
pub struct PackageCreateArgs {
    #[command(flatten)]
    pub remote: RemoteArgs,
    #[arg(long)]
    pub publisher_id: Uuid,
    #[arg(long, value_enum)]
    pub kind: Kind,
    #[arg(long, value_enum, default_value = "private")]
    pub visibility: Visibility,
    #[arg(long)]
    pub slug: String,
    #[arg(long)]
    pub name: String,
    #[arg(long, default_value = "")]
    pub summary: String,
    #[arg(long, default_value = "")]
    pub description: String,
    #[arg(long = "tag")]
    pub tags: Vec<String>,
    #[arg(long)]
    pub idempotency_key: Option<String>,
}

#[derive(Args)]
pub struct ReleaseCreateArgs {
    #[command(flatten)]
    pub remote: RemoteArgs,
    #[arg(long)]
    pub package_id: Uuid,
    #[arg(long)]
    pub version: String,
    #[arg(long = "permission")]
    pub permissions: Vec<String>,
    #[arg(long)]
    pub loom: Option<String>,
    #[arg(long)]
    pub hook: Option<String>,
    #[arg(long)]
    pub idempotency_key: Option<String>,
}
