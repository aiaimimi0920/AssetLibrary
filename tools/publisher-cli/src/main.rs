mod api;
mod cli;
mod commands;
mod error;
mod manifest;
mod output;
mod package;
mod upload;
mod upload_part;

use clap::Parser;
use std::process::ExitCode;

#[tokio::main]
async fn main() -> ExitCode {
    let cli = cli::Cli::parse();
    match commands::run(&cli).await {
        Ok(value) => {
            output::print(&value, cli.json);
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::from(error.exit_code())
        }
    }
}
