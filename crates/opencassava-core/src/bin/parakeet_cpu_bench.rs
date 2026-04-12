use opencassava_core::transcription::parakeet_benchmark::{
    default_benchmark_models, run_benchmark_suite, ParakeetBenchmarkSuiteConfig,
};
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("{err}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let mut args = env::args().skip(1);
    let mut manifest_path: Option<PathBuf> = None;
    let mut output_path = PathBuf::from("parakeet-cpu-benchmark-report.json");
    let mut runtime_root: Option<PathBuf> = None;
    let mut worker_script_path: Option<PathBuf> = None;
    let mut requirements_path: Option<PathBuf> = None;
    let mut venv_path: Option<PathBuf> = None;
    let mut models_dir: Option<PathBuf> = None;
    let mut models = Vec::<String>::new();
    let mut device = String::from("cpu");
    let mut language = String::from("auto");
    let mut diarization_enabled = false;
    let mut poll_interval = Duration::from_millis(250);

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--manifest" => manifest_path = Some(PathBuf::from(next_arg(&mut args, "--manifest")?)),
            "--output" => output_path = PathBuf::from(next_arg(&mut args, "--output")?),
            "--runtime-root" => {
                runtime_root = Some(PathBuf::from(next_arg(&mut args, "--runtime-root")?))
            }
            "--worker-script-path" => {
                worker_script_path =
                    Some(PathBuf::from(next_arg(&mut args, "--worker-script-path")?))
            }
            "--requirements-path" => {
                requirements_path = Some(PathBuf::from(next_arg(&mut args, "--requirements-path")?))
            }
            "--venv-path" => venv_path = Some(PathBuf::from(next_arg(&mut args, "--venv-path")?)),
            "--models-dir" => {
                models_dir = Some(PathBuf::from(next_arg(&mut args, "--models-dir")?))
            }
            "--model" => models.extend(split_models(&next_arg(&mut args, "--model")?)),
            "--device" => device = next_arg(&mut args, "--device")?,
            "--language" => language = next_arg(&mut args, "--language")?,
            "--poll-interval-ms" => {
                let value = next_arg(&mut args, "--poll-interval-ms")?;
                let millis = value
                    .parse::<u64>()
                    .map_err(|e| format!("Invalid --poll-interval-ms value {value:?}: {e}"))?;
                poll_interval = Duration::from_millis(millis);
            }
            "--diarization-enabled" => diarization_enabled = true,
            "--help" | "-h" => {
                print_usage();
                return Ok(());
            }
            other => return Err(format!("Unknown argument: {other}")),
        }
    }

    let manifest_path =
        manifest_path.ok_or_else(|| "Missing required --manifest path.".to_string())?;
    let runtime_root =
        runtime_root.ok_or_else(|| "Missing required --runtime-root path.".to_string())?;
    if models.is_empty() {
        models = default_benchmark_models();
    }

    let mut suite = ParakeetBenchmarkSuiteConfig::with_defaults(manifest_path, runtime_root);
    suite.models = models;
    suite.device = device;
    suite.language = language;
    suite.diarization_enabled = diarization_enabled;
    suite.poll_interval = poll_interval;
    if let Some(path) = worker_script_path {
        suite.worker_script_path = path;
    }
    if let Some(path) = requirements_path {
        suite.requirements_path = path;
    }
    if let Some(path) = venv_path {
        suite.venv_path = path;
    }
    if let Some(path) = models_dir {
        suite.models_dir = path;
    }

    let report = run_benchmark_suite(&suite)?;
    let json = serde_json::to_string_pretty(&report)
        .map_err(|e| format!("Failed to serialize report: {e}"))?;
    fs::write(&output_path, json)
        .map_err(|e| format!("Failed writing benchmark report {:?}: {e}", output_path))?;
    println!("Wrote CPU benchmark report to {}", output_path.display());
    Ok(())
}

fn next_arg(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, String> {
    args.next()
        .ok_or_else(|| format!("Missing value for {flag}."))
}

fn split_models(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn print_usage() {
    eprintln!(
        "Usage: cargo run -p opencassava-core --bin parakeet_cpu_bench -- \
--manifest <path> --runtime-root <path> [--output <path>] [--model <name>] \
[--device cpu] [--language auto] [--poll-interval-ms 250] [--diarization-enabled]"
    );
}
