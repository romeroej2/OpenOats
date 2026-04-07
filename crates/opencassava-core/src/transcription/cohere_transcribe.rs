use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

const WORKER_SCRIPT: &str = include_str!("cohere_transcribe_worker.py");
const REQUIREMENTS: &str = include_str!("cohere_transcribe_requirements.txt");
const SUPPORTED_LANGUAGES: &[&str] = &[
    "ar", "de", "el", "en", "es", "fr", "it", "ja", "ko", "nl", "pl", "pt", "vi", "zh",
];

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CohereTranscribeConfig {
    pub runtime_root: PathBuf,
    pub worker_script_path: PathBuf,
    pub requirements_path: PathBuf,
    pub venv_path: PathBuf,
    pub models_dir: PathBuf,
    pub model: String,
    pub device: String,
    pub hugging_face_token: Option<String>,
}

impl CohereTranscribeConfig {
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

pub fn install_runtime<F>(config: &CohereTranscribeConfig, on_line: F) -> Result<(), String>
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
            "create Cohere Transcribe virtual environment",
            on_line.clone(),
        )?;
    }

    let python_path = config.python_path();
    run_command(
        Command::new(&python_path)
            .arg("-m")
            .arg("pip")
            .arg("install")
            .arg("-v")
            .arg("--upgrade")
            .arg("pip"),
        "upgrade pip for Cohere Transcribe",
        on_line.clone(),
    )?;

    run_command(
        Command::new(&python_path)
            .arg("-m")
            .arg("pip")
            .arg("install")
            .arg("-v")
            .arg("-r")
            .arg(&config.requirements_path),
        "install Cohere Transcribe runtime dependencies",
        on_line,
    )?;

    fs::write(config.install_stamp_path(), REQUIREMENTS).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn health_check(config: &CohereTranscribeConfig) -> Result<(), String> {
    if config.setup_lock_path().exists() {
        return Err("cohere-transcribe setup is still running.".into());
    }
    if !config.is_installed() {
        return Err("cohere-transcribe runtime is not installed.".into());
    }
    log::info!("[cohere-transcribe] health_check: spawning worker");
    let mut worker = CohereTranscribeWorker::spawn(config)?;
    log::info!("[cohere-transcribe] health_check: sending health command");
    worker.health()?;
    log::info!("[cohere-transcribe] health_check: worker responded successfully");
    let _ = worker.shutdown();
    Ok(())
}

pub fn ensure_model<F>(config: &CohereTranscribeConfig, on_line: F) -> Result<(), String>
where
    F: Fn(&str) + Send + Clone + 'static,
    {
        if !config.is_installed() {
            install_runtime(config, on_line)?;
        }
        log::info!("[cohere-transcribe] ensure_model: spawning worker");
        let mut worker = CohereTranscribeWorker::spawn(config)?;
        log::info!("[cohere-transcribe] ensure_model: sending ensure_model command");
        worker.ensure_model()?;
        log::info!("[cohere-transcribe] ensure_model: worker reported model ready");
        fs::write(config.model_stamp_path(), &config.model).map_err(|e| e.to_string())?;
        let _ = worker.shutdown();
        Ok(())
    }

pub struct CohereTranscribeWorker {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    stderr_tail: Arc<Mutex<String>>,
    config: CohereTranscribeConfig,
}

impl CohereTranscribeWorker {
    pub fn spawn(config: &CohereTranscribeConfig) -> Result<Self, String> {
        config.ensure_files()?;
        if !config.is_installed() {
            return Err("cohere-transcribe runtime is not installed.".into());
        }
        log::info!(
            "[cohere-transcribe] launching worker with python {}",
            config.python_path().display()
        );

        let mut child = Command::new(config.python_path())
            .arg("-u")
            .arg(&config.worker_script_path)
            .env("HF_HUB_DISABLE_PROGRESS_BARS", "0")
            .env("TQDM_FORCE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to launch cohere-transcribe worker: {e}"))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to open stdin for cohere-transcribe worker.".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to open stdout for cohere-transcribe worker.".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Failed to open stderr for cohere-transcribe worker.".to_string())?;
        let stderr_tail = Arc::new(Mutex::new(String::new()));
        pump_stderr(stderr, Arc::clone(&stderr_tail));

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

    pub fn ensure_model(&mut self) -> Result<(), String> {
        self.send_request(json!({
            "command": "ensure_model",
            "model": self.config.model.clone(),
            "device": self.config.device.clone(),
            "download_root": self.config.models_dir.clone(),
            "hugging_face_token": self.config.hugging_face_token.clone(),
        }))?;
        Ok(())
    }

    pub fn transcribe(&mut self, samples: &[f32], language: &str) -> Result<String, String> {
        let resolved_language = resolve_supported_language(language).ok_or_else(|| {
            format!(
                "Cohere Transcribe requires a supported explicit language code, got {}.",
                language
            )
        })?;
        let response = self.send_request(json!({
            "command": "transcribe",
            "model": self.config.model.clone(),
            "device": self.config.device.clone(),
            "download_root": self.config.models_dir.clone(),
            "hugging_face_token": self.config.hugging_face_token.clone(),
            "language": resolved_language,
            "samples": samples,
        }))?;
        Ok(response["text"].as_str().unwrap_or_default().to_string())
    }

    pub fn shutdown(&mut self) -> Result<(), String> {
        let _ = self.send_request(json!({ "command": "shutdown" }));
        let _ = self.child.wait();
        Ok(())
    }

    fn send_request(&mut self, payload: serde_json::Value) -> Result<serde_json::Value, String> {
        let command_name = payload["command"].as_str().unwrap_or("unknown");
        log::info!("[cohere-transcribe] -> worker command: {command_name}");
        let line = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
        self.stdin
            .write_all(line.as_bytes())
            .and_then(|_| self.stdin.write_all(b"\n"))
            .and_then(|_| self.stdin.flush())
            .map_err(|e| format!("Failed to write to cohere-transcribe worker: {e}"))?;

        let mut response = String::new();
        self.stdout
            .read_line(&mut response)
            .map_err(|e| format!("Failed to read cohere-transcribe worker response: {e}"))?;
        if response.trim().is_empty() {
            let stderr = self.stderr_snapshot();
            let status = self.child.try_wait().ok().flatten();
            return Err(format_worker_exit_error(status, &stderr));
        }
        log::info!(
            "[cohere-transcribe] <- worker response for {command_name}: {}",
            response.trim()
        );
        let json: serde_json::Value = serde_json::from_str(response.trim())
            .map_err(|e| format!("Invalid cohere-transcribe worker response: {e}"))?;
        if json["ok"].as_bool().unwrap_or(false) {
            Ok(json["result"].clone())
        } else {
            Err(json["error"]
                .as_str()
                .unwrap_or("Unknown cohere-transcribe worker error.")
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

impl Drop for CohereTranscribeWorker {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

fn pump_stderr(mut stderr: impl Read + Send + 'static, tail: Arc<Mutex<String>>) {
    thread::spawn(move || {
        let mut line_buf = String::new();
        let mut buf = [0u8; 1024];
        loop {
            match stderr.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]);
                    for c in text.chars() {
                        if c == '\n' || c == '\r' {
                            if !line_buf.is_empty() {
                                log::warn!("[cohere-transcribe] {}", line_buf);
                                if let Ok(mut tail_buf) = tail.lock() {
                                    if !tail_buf.is_empty() {
                                        tail_buf.push('\n');
                                    }
                                    tail_buf.push_str(&line_buf);
                                    if tail_buf.len() > 4000 {
                                        let start = tail_buf.len().saturating_sub(4000);
                                        *tail_buf = tail_buf[start..].to_string();
                                    }
                                }
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
    });
}

fn format_worker_exit_error(status: Option<std::process::ExitStatus>, stderr: &str) -> String {
    let mut message = "cohere-transcribe worker exited without a response.".to_string();
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
    log::info!("[cohere-transcribe] Starting {description}");
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to {description}: {e}"))?;

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

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
                                log::info!("[cohere-transcribe] {}", line_buf);
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
                                log::info!("[cohere-transcribe] {}", line_buf);
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
    fn acquire(config: &CohereTranscribeConfig) -> Result<Self, String> {
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

    Err("Python 3 was not found. Install Python 3 to enable cohere-transcribe.".into())
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

pub fn model_storage_exists(config: &CohereTranscribeConfig) -> bool {
    config.model_stamp_path().exists()
}

pub fn supports_locale(locale: &str) -> bool {
    resolve_supported_language(locale).is_some()
}

pub fn resolve_supported_language(locale: &str) -> Option<String> {
    let trimmed = locale.trim().to_ascii_lowercase();
    if trimmed.is_empty() || trimmed == "auto" {
        return None;
    }
    let language = trimmed.split('-').next().unwrap_or(trimmed.as_str());
    if SUPPORTED_LANGUAGES.contains(&language) {
        Some(language.to_string())
    } else {
        None
    }
}

pub fn missing_token_message() -> String {
    "Cohere Transcribe requires a Hugging Face access token before setup can start.".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn sample_config(root: PathBuf) -> CohereTranscribeConfig {
        CohereTranscribeConfig {
            worker_script_path: root.join("worker.py"),
            requirements_path: root.join("requirements.txt"),
            venv_path: root.join("venv"),
            models_dir: root.join("models"),
            runtime_root: root,
            model: "CohereLabs/cohere-transcribe-03-2026".into(),
            device: "auto".into(),
            hugging_face_token: None,
        }
    }

    #[test]
    fn config_paths_are_under_runtime_root() {
        let dir = tempdir().unwrap();
        let config = sample_config(dir.path().join("cohere"));
        assert!(config.worker_script_path.starts_with(&config.runtime_root));
        assert!(config.requirements_path.starts_with(&config.runtime_root));
        assert!(config.venv_path.starts_with(&config.runtime_root));
        assert!(config.models_dir.starts_with(&config.runtime_root));
    }

    #[test]
    fn supported_locale_mapping_uses_language_code() {
        assert_eq!(resolve_supported_language("en-US").as_deref(), Some("en"));
        assert_eq!(resolve_supported_language("pt-BR").as_deref(), Some("pt"));
        assert_eq!(resolve_supported_language("zh-CN").as_deref(), Some("zh"));
    }

    #[test]
    fn unsupported_or_auto_locale_returns_none() {
        assert_eq!(resolve_supported_language("auto"), None);
        assert_eq!(resolve_supported_language(""), None);
        assert_eq!(resolve_supported_language("bg-BG"), None);
    }

    #[test]
    fn model_storage_detects_stamp() {
        let dir = tempdir().unwrap();
        let config = sample_config(dir.path().join("cohere"));
        fs::create_dir_all(&config.runtime_root).unwrap();
        assert!(!model_storage_exists(&config));
        fs::write(config.model_stamp_path(), "ok").unwrap();
        assert!(model_storage_exists(&config));
    }

    #[test]
    fn health_check_requires_runtime() {
        let dir = tempdir().unwrap();
        let config = sample_config(dir.path().join("cohere"));
        let err = health_check(&config).unwrap_err();
        assert!(err.contains("runtime is not installed"));
    }

    #[test]
    fn missing_token_message_mentions_hugging_face() {
        assert!(missing_token_message().contains("Hugging Face"));
    }
}
