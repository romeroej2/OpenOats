use crate::process_control::ManagedChild;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const WORKER_SCRIPT: &str = include_str!("parakeet_worker.py");
const REQUIREMENTS: &str = include_str!("parakeet_requirements.txt");

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ParakeetConfig {
    pub runtime_root: PathBuf,
    pub worker_script_path: PathBuf,
    pub requirements_path: PathBuf,
    pub venv_path: PathBuf,
    pub models_dir: PathBuf,
    pub model: String,
    pub device: String,
    /// BCP-47 language code (e.g. "es", "fr") or empty for auto-detect.
    pub language: String,
    /// Controls whether TitaNet speaker embedding model is downloaded and used.
    pub diarization_enabled: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ParakeetExecutionBackend {
    Cpu,
    ExplicitDevice,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ParakeetExecutionTarget {
    pub requested_device: String,
    pub resolved_device: String,
    pub backend: ParakeetExecutionBackend,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ParakeetTranscribeOptions {
    pub use_lhotse: bool,
    pub batch_size: usize,
    pub verbose: bool,
}

impl ParakeetTranscribeOptions {
    pub fn live() -> Self {
        Self {
            use_lhotse: false,
            batch_size: 1,
            verbose: false,
        }
    }
}

impl ParakeetConfig {
    pub fn python_path(&self) -> PathBuf {
        if cfg!(windows) {
            self.venv_path.join("Scripts").join("python.exe")
        } else {
            self.venv_path.join("bin").join("python3")
        }
    }

    pub fn install_stamp_path(&self) -> PathBuf {
        self.runtime_root.join("install.stamp")
    }

    pub fn model_stamp_path(&self) -> PathBuf {
        let device = self
            .device
            .replace(|c: char| !c.is_ascii_alphanumeric(), "_");
        let model = self
            .model
            .replace(|c: char| !c.is_ascii_alphanumeric(), "_");
        self.runtime_root
            .join(format!("model-{model}-{device}.stamp"))
    }

    pub fn setup_lock_path(&self) -> PathBuf {
        self.runtime_root.join("setup.lock")
    }

    pub fn execution_target(&self) -> ParakeetExecutionTarget {
        let requested_device = self.device.trim().to_string();
        let resolved_device =
            if requested_device.is_empty() || requested_device.eq_ignore_ascii_case("auto") {
                "cpu".to_string()
            } else {
                requested_device.to_ascii_lowercase()
            };
        let backend = if resolved_device == "cpu" {
            ParakeetExecutionBackend::Cpu
        } else {
            ParakeetExecutionBackend::ExplicitDevice
        };
        ParakeetExecutionTarget {
            requested_device,
            resolved_device,
            backend,
        }
    }

    pub fn live_transcribe_options(&self) -> ParakeetTranscribeOptions {
        ParakeetTranscribeOptions::live()
    }

    pub fn runtime_cache_key(&self) -> String {
        let language = self.language.trim().to_ascii_lowercase();
        let normalized_language = if language.is_empty() {
            "auto"
        } else {
            language.as_str()
        };
        format!(
            "{}::{}::{}",
            self.model,
            self.execution_target().resolved_device,
            normalized_language
        )
    }

    pub fn ensure_files(&self) -> Result<(), String> {
        fs::create_dir_all(&self.runtime_root).map_err(|e| e.to_string())?;
        fs::create_dir_all(&self.models_dir).map_err(|e| e.to_string())?;
        fs::write(&self.worker_script_path, WORKER_SCRIPT).map_err(|e| e.to_string())?;
        fs::write(&self.requirements_path, REQUIREMENTS).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn is_installed(&self) -> bool {
        self.python_path().exists()
            && self.install_stamp_path().exists()
            && fs::read_to_string(self.install_stamp_path())
                .map(|contents| contents == REQUIREMENTS)
                .unwrap_or(false)
    }
}

fn normalized_language(language: &str) -> Option<String> {
    let lang = language.trim();
    if lang.is_empty() || lang.eq_ignore_ascii_case("auto") {
        None
    } else {
        Some(lang.split('-').next().unwrap_or(lang).to_ascii_lowercase())
    }
}

fn build_transcribe_request(
    config: &ParakeetConfig,
    samples: &[f32],
    language_override: Option<&str>,
) -> serde_json::Value {
    let execution = config.execution_target();
    let options = config.live_transcribe_options();
    let mut payload = json!({
        "command": "transcribe",
        "model": config.model.clone(),
        "device": config.device.clone(),
        "resolved_device": execution.resolved_device,
        "execution_backend": execution.backend,
        "samples": samples,
        "use_lhotse": options.use_lhotse,
        "batch_size": options.batch_size,
        "verbose": options.verbose,
    });
    let requested_language = language_override.unwrap_or(&config.language);
    if let Some(language) = normalized_language(requested_language) {
        payload["language"] = serde_json::Value::String(language);
    }
    payload
}

pub fn install_runtime<F>(config: &ParakeetConfig, on_line: F) -> Result<(), String>
where
    F: Fn(&str) + Send + Clone + 'static,
{
    config.ensure_files()?;
    let _lock = SetupLock::acquire(config)?;
    if !config.python_path().exists() {
        let python = detect_system_python()?;
        run_command(
            Command::new(&python.command)
                .args(&python.prefix_args)
                .arg("-m")
                .arg("venv")
                .arg(&config.venv_path),
            "create parakeet virtual environment",
            on_line.clone(),
        )?;
    }

    let python_path = config.python_path();
    run_command(
        Command::new(&python_path)
            .arg("-m")
            .arg("pip")
            .arg("install")
            .arg("--upgrade")
            .arg("pip"),
        "upgrade pip for parakeet",
        on_line.clone(),
    )?;

    run_command(
        Command::new(&python_path)
            .arg("-m")
            .arg("pip")
            .arg("install")
            .arg("-r")
            .arg(&config.requirements_path),
        "install parakeet runtime dependencies",
        on_line,
    )?;

    fs::write(config.install_stamp_path(), REQUIREMENTS).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn health_check(config: &ParakeetConfig) -> Result<(), String> {
    if config.setup_lock_path().exists() {
        return Err("parakeet setup is still running.".into());
    }
    if !config.is_installed() {
        return Err("parakeet runtime is not installed.".into());
    }
    let mut worker = ParakeetWorker::spawn(config)?;
    worker.health()?;
    let _ = worker.shutdown();
    Ok(())
}

pub fn ensure_model<F>(config: &ParakeetConfig, on_line: F) -> Result<(), String>
where
    F: Fn(&str) + Send + 'static,
{
    if !config.is_installed() {
        install_runtime(config, |_| {})?;
    }
    let mut worker = ParakeetWorker::spawn_with_log(config, on_line)?;
    worker.ensure_model(config.diarization_enabled)?;
    fs::write(config.model_stamp_path(), &config.model).map_err(|e| e.to_string())?;
    let _ = worker.shutdown();
    Ok(())
}

pub struct ParakeetWorker {
    child: ManagedChild,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    stderr_tail: Arc<Mutex<String>>,
    config: ParakeetConfig,
}

impl ParakeetWorker {
    pub fn spawn(config: &ParakeetConfig) -> Result<Self, String> {
        Self::spawn_with_log(config, |_| {})
    }

    pub fn spawn_with_log<F>(config: &ParakeetConfig, on_line: F) -> Result<Self, String>
    where
        F: Fn(&str) + Send + 'static,
    {
        config.ensure_files()?;
        if !config.is_installed() {
            return Err("parakeet runtime is not installed.".into());
        }

        let mut command = Command::new(config.python_path());
        command
            .arg("-u")
            .arg(&config.worker_script_path)
            .env("HF_HUB_DISABLE_PROGRESS_BARS", "1")
            .env("TQDM_DISABLE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = ManagedChild::spawn(&mut command, "parakeet worker")
            .map_err(|e| format!("Failed to launch parakeet worker: {e}"))?;

        let stdin = child
            .take_stdin()
            .ok_or_else(|| "Failed to open stdin for parakeet worker.".to_string())?;
        let stdout = child
            .take_stdout()
            .ok_or_else(|| "Failed to open stdout for parakeet worker.".to_string())?;
        let stderr = child
            .take_stderr()
            .ok_or_else(|| "Failed to open stderr for parakeet worker.".to_string())?;
        let stderr_tail = Arc::new(Mutex::new(String::new()));
        pump_stderr(stderr, Arc::clone(&stderr_tail), on_line);

        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            stderr_tail,
            config: config.clone(),
        })
    }

    pub fn health(&mut self) -> Result<(), String> {
        self.send_request(json!({ "command": "health" }))?;
        Ok(())
    }

    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    pub fn ensure_model(&mut self, diarization_enabled: bool) -> Result<(), String> {
        let execution = self.config.execution_target();
        self.send_request(json!({
            "command": "ensure_model",
            "model": self.config.model.clone(),
            "device": self.config.device.clone(),
            "resolved_device": execution.resolved_device,
            "execution_backend": execution.backend,
            "diarization_enabled": diarization_enabled,
        }))?;
        Ok(())
    }

    pub fn clear_speakers(&mut self) -> Result<(), String> {
        self.send_request(json!({ "command": "clear_speakers" }))?;
        Ok(())
    }

    /// Returns the stable speaker ID for this audio segment, or None if the segment
    /// was too short to embed reliably. Errors if the worker fails.
    pub fn speaker_id(&mut self, samples: &[f32]) -> Result<Option<String>, String> {
        let execution = self.config.execution_target();
        let response = self.send_request(json!({
            "command": "speaker_id",
            "samples": samples,
            "model": self.config.model.clone(),
            "device": self.config.device.clone(),
            "resolved_device": execution.resolved_device,
            "execution_backend": execution.backend,
        }))?;
        // Python returns {"speaker_id": "speaker_N"} or {"speaker_id": null}
        Ok(response["speaker_id"].as_str().map(|s| s.to_string()))
    }

    pub fn transcribe(&mut self, samples: &[f32]) -> Result<String, String> {
        let execution = self.config.execution_target();
        let options = self.config.live_transcribe_options();
        let mut payload = json!({
            "command": "transcribe",
            "model": self.config.model.clone(),
            "device": self.config.device.clone(),
            "resolved_device": execution.resolved_device,
            "execution_backend": execution.backend,
            "samples": samples,
            "use_lhotse": options.use_lhotse,
            "batch_size": options.batch_size,
            "verbose": options.verbose,
        });
        let lang = self.config.language.trim();
        if !lang.is_empty() && lang != "auto" {
            // Strip region suffix: "es-ES" → "es"
            let lang_code = lang.split('-').next().unwrap_or(lang);
            payload["language"] = serde_json::Value::String(lang_code.to_string());
        }
        let response = self.send_request(payload)?;
        Ok(response["text"].as_str().unwrap_or_default().to_string())
    }

    pub fn transcribe_with_language(
        &mut self,
        samples: &[f32],
        language: Option<&str>,
    ) -> Result<String, String> {
        let response =
            self.send_request(build_transcribe_request(&self.config, samples, language))?;
        Ok(response["text"].as_str().unwrap_or_default().to_string())
    }

    pub fn shutdown(&mut self) -> Result<(), String> {
        let line =
            serde_json::to_string(&json!({ "command": "shutdown" })).map_err(|e| e.to_string())?;
        let _ = self
            .stdin
            .write_all(line.as_bytes())
            .and_then(|_| self.stdin.write_all(b"\n"))
            .and_then(|_| self.stdin.flush());
        match self
            .child
            .wait_with_timeout(Duration::from_secs(2))
            .map_err(|e| format!("Failed waiting for parakeet worker shutdown: {e}"))?
        {
            Some(_) => Ok(()),
            None => self
                .child
                .terminate_tree()
                .map_err(|e| format!("Failed to force-stop parakeet worker: {e}")),
        }?;
        Ok(())
    }

    fn send_request(&mut self, payload: serde_json::Value) -> Result<serde_json::Value, String> {
        let line = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
        self.stdin
            .write_all(line.as_bytes())
            .and_then(|_| self.stdin.write_all(b"\n"))
            .and_then(|_| self.stdin.flush())
            .map_err(|e| format!("Failed to write to parakeet worker: {e}"))?;

        let json = loop {
            let mut response = String::new();
            self.stdout
                .read_line(&mut response)
                .map_err(|e| format!("Failed to read parakeet worker response: {e}"))?;
            if response.trim().is_empty() {
                let stderr = self.stderr_snapshot();
                let status = self.child.try_wait().ok().flatten();
                return Err(format_worker_exit_error(status, &stderr));
            }
            let trimmed = response.trim();
            if trimmed.starts_with('{') {
                break serde_json::from_str::<serde_json::Value>(trimmed)
                    .map_err(|e| format!("Invalid parakeet worker response: {e}"))?;
            }
            if is_benign_worker_stdout(trimmed) {
                log::debug!("[parakeet] suppressed stdout: {trimmed}");
            } else {
                log::warn!("[parakeet][stdout] {trimmed}");
            }
        };
        if json["ok"].as_bool().unwrap_or(false) {
            Ok(json["result"].clone())
        } else {
            Err(json["error"]
                .as_str()
                .unwrap_or("Unknown parakeet worker error.")
                .to_string())
        }
    }

    fn stderr_snapshot(&self) -> String {
        self.stderr_tail
            .lock()
            .map(|value| value.trim().to_string())
            .unwrap_or_default()
    }
}

impl Drop for ParakeetWorker {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

fn pump_stderr<F>(mut stderr: impl Read + Send + 'static, tail: Arc<Mutex<String>>, on_line: F)
where
    F: Fn(&str) + Send + 'static,
{
    thread::spawn(move || {
        let mut line_buf = String::new();
        let mut buf = [0u8; 1024];
        let mut suppress_indented_block = false;
        loop {
            match stderr.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]);
                    for c in text.chars() {
                        if c == '\n' || c == '\r' {
                            let trimmed = line_buf.trim_end().to_string();
                            line_buf.clear();
                            if !trimmed.is_empty() {
                                let (suppress_line, continue_block) =
                                    classify_worker_stderr(&trimmed, suppress_indented_block);
                                suppress_indented_block = continue_block;
                                if suppress_line {
                                    log::debug!("[parakeet] suppressed stderr: {trimmed}");
                                } else {
                                    log::warn!("[parakeet] {trimmed}");
                                    on_line(&trimmed);
                                    append_stderr_tail(&tail, &trimmed);
                                }
                            }
                        } else {
                            line_buf.push(c);
                        }
                    }
                }
                Err(_) => break,
            }
        }
    });
}

fn is_benign_worker_stdout(line: &str) -> bool {
    line.starts_with("[NeMo I ")
        || line.starts_with("Loss tdt_kwargs:")
        || line.starts_with("Restoring model :")
}

fn classify_worker_stderr(line: &str, suppress_indented_block: bool) -> (bool, bool) {
    let trimmed_start = line.trim_start();
    let is_indented = line.chars().next().is_some_and(|c| c.is_whitespace());
    if suppress_indented_block {
        if is_indented {
            return (true, true);
        }
    }

    let suppress_block = trimmed_start.starts_with("Train config :")
        || trimmed_start.starts_with("Validation config :")
        || trimmed_start.starts_with("Test config :")
        || trimmed_start.contains("No conditional node support for Cuda.");

    let suppress_line = suppress_block
        || trimmed_start
            .contains("Megatron num_microbatches_calculator not found, using Apex version.")
        || trimmed_start.contains("Redirects are currently not supported in Windows or MacOs.")
        || trimmed_start.starts_with("OneLogger: Setting error_handling_strategy")
        || trimmed_start.starts_with("No exporters were provided.")
        || trimmed_start.starts_with("Cuda graphs with while loops are disabled")
        || trimmed_start.starts_with("Reason: CUDA is not available")
        || trimmed_start.contains("If you intend to do training or fine-tuning")
        || trimmed_start.contains("If you intend to do validation")
        || trimmed_start
            .contains("The following configuration keys are ignored by Lhotse dataloader")
        || trimmed_start.contains(
            "You are using a non-tarred dataset and requested tokenization during data sampling",
        )
        || trimmed_start.starts_with("Transcribing:");

    (suppress_line, suppress_block)
}

fn append_stderr_tail(tail: &Arc<Mutex<String>>, line: &str) {
    if let Ok(mut tail_buf) = tail.lock() {
        if !tail_buf.is_empty() {
            tail_buf.push('\n');
        }
        tail_buf.push_str(line);
        if tail_buf.len() > 4000 {
            let start = tail_buf.len().saturating_sub(4000);
            *tail_buf = tail_buf[start..].to_string();
        }
    }
}

fn format_worker_exit_error(status: Option<std::process::ExitStatus>, stderr: &str) -> String {
    let mut message = "parakeet worker exited without a response.".to_string();
    if let Some(status) = status {
        message.push_str(&format!(" Exit status: {status}."));
    }
    if !stderr.is_empty() {
        message.push_str(" Worker stderr: ");
        message.push_str(stderr);
    }
    message
}

fn run_command<F>(command: &mut Command, description: &str, on_line: F) -> Result<(), String>
where
    F: Fn(&str) + Send + Clone + 'static,
{
    log::info!("[parakeet] Starting {description}");
    let mut child = ManagedChild::spawn(
        command.stdout(Stdio::piped()).stderr(Stdio::piped()),
        format!("parakeet setup: {description}"),
    )
    .map_err(|e| format!("Failed to {description}: {e}"))?;

    let stdout = child.take_stdout().unwrap();
    let stderr = child.take_stderr().unwrap();

    let on_line_stdout = on_line.clone();
    let stdout_thread = thread::spawn(move || {
        let mut stdout = stdout;
        let mut buf_all = Vec::new();
        let mut line_buf = String::new();
        let mut buf = [0u8; 1024];
        loop {
            match stdout.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    buf_all.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&buf[..n]);
                    for c in text.chars() {
                        if c == '\n' || c == '\r' {
                            if !line_buf.is_empty() {
                                log::info!("[parakeet] {}", line_buf);
                                on_line_stdout(&line_buf);
                                line_buf.clear();
                            }
                        } else {
                            line_buf.push(c);
                        }
                    }
                }
                Err(_) => break,
            }
        }
        buf_all
    });
    let stderr_thread = thread::spawn(move || {
        let mut stderr = stderr;
        let mut buf_all = Vec::new();
        let mut line_buf = String::new();
        let mut buf = [0u8; 1024];
        loop {
            match stderr.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    buf_all.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&buf[..n]);
                    for c in text.chars() {
                        if c == '\n' || c == '\r' {
                            if !line_buf.is_empty() {
                                log::info!("[parakeet] {}", line_buf);
                                on_line(&line_buf);
                                line_buf.clear();
                            }
                        } else {
                            line_buf.push(c);
                        }
                    }
                }
                Err(_) => break,
            }
        }
        buf_all
    });

    let status = child
        .wait()
        .map_err(|e| format!("Failed to wait for {description}: {e}"))?;
    let stdout_buf = stdout_thread.join().unwrap_or_default();
    let stderr_buf = stderr_thread.join().unwrap_or_default();

    if status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&stderr_buf);
    let stdout = String::from_utf8_lossy(&stdout_buf);
    let mut message = format!("Failed to {description}.");
    if !stderr.trim().is_empty() {
        message.push_str(" stderr: ");
        message.push_str(stderr.trim());
    }
    if !stdout.trim().is_empty() {
        message.push_str(" stdout: ");
        message.push_str(stdout.trim());
    }
    Err(message)
}

struct SetupLock {
    path: PathBuf,
}

impl SetupLock {
    fn acquire(config: &ParakeetConfig) -> Result<Self, String> {
        fs::write(config.setup_lock_path(), "installing").map_err(|e| e.to_string())?;
        Ok(Self {
            path: config.setup_lock_path(),
        })
    }
}

impl Drop for SetupLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

struct PythonCandidate {
    command: String,
    prefix_args: Vec<String>,
}

fn detect_system_python() -> Result<PythonCandidate, String> {
    let candidates = if cfg!(windows) {
        vec![
            PythonCandidate {
                command: "py".into(),
                prefix_args: vec!["-3".into()],
            },
            PythonCandidate {
                command: "python".into(),
                prefix_args: vec![],
            },
        ]
    } else {
        vec![
            PythonCandidate {
                command: "python3".into(),
                prefix_args: vec![],
            },
            PythonCandidate {
                command: "python".into(),
                prefix_args: vec![],
            },
        ]
    };

    for candidate in candidates {
        if command_works(&candidate.command, &candidate.prefix_args) {
            return Ok(candidate);
        }
    }

    Err("Python 3 was not found. Install Python 3 to enable parakeet.".into())
}

fn command_works(command: &str, prefix_args: &[String]) -> bool {
    Command::new(command)
        .args(prefix_args)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

pub fn model_storage_exists(config: &ParakeetConfig) -> bool {
    config.model_stamp_path().exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config(language: &str, device: &str) -> ParakeetConfig {
        ParakeetConfig {
            runtime_root: PathBuf::from("runtime"),
            worker_script_path: PathBuf::from("worker.py"),
            requirements_path: PathBuf::from("requirements.txt"),
            venv_path: PathBuf::from("venv"),
            models_dir: PathBuf::from("models"),
            model: "nvidia/parakeet-tdt-0.6b-v3".into(),
            device: device.into(),
            language: language.into(),
            diarization_enabled: false,
        }
    }

    #[test]
    fn speaker_id_method_exists() {
        // Compile-time guard: won't compile until speaker_id is added to ParakeetWorker
        // with the correct signature. The test itself is a no-op at runtime.
        let _: fn(&mut ParakeetWorker, &[f32]) -> Result<Option<String>, String> =
            ParakeetWorker::speaker_id;
    }

    #[test]
    fn transcribe_with_language_method_exists() {
        let _: fn(&mut ParakeetWorker, &[f32], Option<&str>) -> Result<String, String> =
            ParakeetWorker::transcribe_with_language;
    }

    #[test]
    fn auto_device_resolves_to_cpu_backend() {
        let config = test_config("", "auto");
        assert_eq!(
            config.execution_target(),
            ParakeetExecutionTarget {
                requested_device: "auto".into(),
                resolved_device: "cpu".into(),
                backend: ParakeetExecutionBackend::Cpu,
            }
        );
    }

    #[test]
    fn explicit_device_keeps_future_backend_hook() {
        let mut config = test_config("es-ES", "cuda");
        config.diarization_enabled = true;
        assert_eq!(
            config.execution_target(),
            ParakeetExecutionTarget {
                requested_device: "cuda".into(),
                resolved_device: "cuda".into(),
                backend: ParakeetExecutionBackend::ExplicitDevice,
            }
        );
        assert_eq!(
            config.runtime_cache_key(),
            "nvidia/parakeet-tdt-0.6b-v3::cuda::es-es"
        );
    }

    #[test]
    fn live_transcribe_options_are_cpu_friendly() {
        assert_eq!(
            ParakeetTranscribeOptions::live(),
            ParakeetTranscribeOptions {
                use_lhotse: false,
                batch_size: 1,
                verbose: false,
            }
        );
    }

    #[test]
    fn normalized_language_drops_auto_and_region_suffix() {
        assert_eq!(normalized_language(""), None);
        assert_eq!(normalized_language("auto"), None);
        assert_eq!(normalized_language(" ES-es "), Some("es".into()));
    }

    #[test]
    fn in_memory_transcribe_payload_uses_live_cpu_defaults() {
        let config = test_config("fr-CA", "auto");
        let payload = build_transcribe_request(&config, &[0.1, -0.2, 0.3], None);

        assert_eq!(payload["command"], "transcribe");
        assert!(payload.get("samples").is_some());
        assert!(payload.get("audio_path").is_none());
        assert_eq!(payload["use_lhotse"], false);
        assert_eq!(payload["batch_size"], 1);
        assert_eq!(payload["verbose"], false);
        assert_eq!(payload["resolved_device"], "cpu");
        assert_eq!(payload["execution_backend"], serde_json::json!("cpu"));
        assert_eq!(payload["language"], "fr");
    }

    #[test]
    fn language_override_wins_in_transcribe_payload() {
        let config = test_config("fr-CA", "cpu");
        let payload = build_transcribe_request(&config, &[0.1], Some("de-DE"));
        assert_eq!(payload["language"], "de");
    }

    #[test]
    fn speaker_id_parses_none_from_result_object() {
        // send_request returns json["result"] already.
        // Python sends {"speaker_id": null} for short segments.
        let result_obj: serde_json::Value = serde_json::from_str(r#"{"speaker_id":null}"#).unwrap();
        let speaker_id: Option<String> = result_obj["speaker_id"].as_str().map(|s| s.to_string());
        assert!(speaker_id.is_none());
    }

    #[test]
    fn speaker_id_parses_some_from_result_object() {
        // Python sends {"speaker_id": "speaker_0"} on a match.
        let result_obj: serde_json::Value =
            serde_json::from_str(r#"{"speaker_id":"speaker_0"}"#).unwrap();
        let speaker_id: Option<String> = result_obj["speaker_id"].as_str().map(|s| s.to_string());
        assert_eq!(speaker_id, Some("speaker_0".to_string()));
    }

    #[test]
    fn benign_worker_stdout_patterns_are_suppressed() {
        assert!(is_benign_worker_stdout(
            "[NeMo I 2026-04-11 18:56:05 save_restore_connector:285] Model EncDecRNNTBPEModel was successfully restored from C:\\cache\\parakeet.nemo."
        ));
        assert!(is_benign_worker_stdout(
            "Loss tdt_kwargs: {'fastemit_lambda': 0.0, 'clamp': -1.0}"
        ));
    }

    #[test]
    fn benign_worker_stderr_patterns_are_suppressed() {
        assert!(classify_worker_stderr(
            "[NeMo W 2026-04-11 18:49:21 megatron_init:62] Megatron num_microbatches_calculator not found, using Apex version.",
            false
        )
        .0);
        assert!(classify_worker_stderr(
            "W0411 18:49:21.470000 99200 venv\\Lib\\site-packages\\torch\\distributed\\elastic\\multiprocessing\\redirects.py:29] NOTE: Redirects are currently not supported in Windows or MacOs.",
            false
        )
        .0);
        assert!(classify_worker_stderr(
            "OneLogger: Setting error_handling_strategy to DISABLE_QUIETLY_AND_REPORT_METRIC_ERROR for rank (rank=0) with OneLogger disabled. To override: explicitly set error_handling_strategy parameter.",
            false
        )
        .0);
        assert!(
            classify_worker_stderr(
                "No exporters were provided. This means that no telemetry data will be collected.",
                false
            )
            .0
        );
        assert!(classify_worker_stderr("Transcribing: 1it [00:00,  2.32it/s]", false).0);
        assert!(classify_worker_stderr(
            "[NeMo W 2026-04-11 18:56:07 dataloader:826] The following configuration keys are ignored by Lhotse dataloader: use_start_end_token",
            false
        )
        .0);
    }

    #[test]
    fn benign_worker_stderr_block_continues_for_indented_lines() {
        let (_, in_block) = classify_worker_stderr("    Train config :", false);
        assert!(in_block);
        let (suppress_line, still_in_block) =
            classify_worker_stderr("    num_workers: 15", in_block);
        assert!(suppress_line);
        assert!(still_in_block);
        let (suppress_line, still_in_block) =
            classify_worker_stderr("next top-level line", still_in_block);
        assert!(!suppress_line);
        assert!(!still_in_block);
    }

    #[test]
    fn actionable_worker_stderr_patterns_are_not_suppressed() {
        assert!(
            !classify_worker_stderr(
                "[parakeet] Warning: TitaNet pre-load failed: model download failed",
                false
            )
            .0
        );
        assert!(
            !classify_worker_stderr(
                "Traceback (most recent call last): RuntimeError: CUDA out of memory",
                false
            )
            .0
        );
        assert!(!is_benign_worker_stdout("unexpected plain stdout line"));
    }
}
