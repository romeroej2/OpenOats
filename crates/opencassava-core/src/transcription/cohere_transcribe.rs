use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

const WORKER_SCRIPT: &str = include_str!("cohere_transcribe_worker.py");
const REQUIREMENTS: &str = include_str!("cohere_transcribe_requirements.txt");
const TORCH_CPU_SPEC: &str = "torch>=2.6.0";
const ROCM_WINDOWS_SDK_CORE: &str =
    "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm_sdk_core-7.2.1-py3-none-win_amd64.whl";
const ROCM_WINDOWS_SDK_DEVEL: &str =
    "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm_sdk_devel-7.2.1-py3-none-win_amd64.whl";
const ROCM_WINDOWS_SDK_LIBS: &str =
    "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm_sdk_libraries_custom-7.2.1-py3-none-win_amd64.whl";
const ROCM_WINDOWS_SDK_ARCHIVE: &str =
    "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm-7.2.1.tar.gz";
const ROCM_WINDOWS_TORCH: &str =
    "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torch-2.9.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl";
const ROCM_WINDOWS_TORCHAUDIO: &str =
    "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torchaudio-2.9.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl";
const ROCM_WINDOWS_TORCHVISION: &str =
    "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torchvision-0.24.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl";
const ROCM_TORCH_WHEEL_UBUNTU_2204_CP310: &str =
    "https://repo.radeon.com/rocm/manylinux/rocm-rel-7.2/torch-2.9.1%2Brocm7.2.0.lw.git7e1940d4-cp310-cp310-linux_x86_64.whl";
const ROCM_TORCHVISION_WHEEL_UBUNTU_2204_CP310: &str =
    "https://repo.radeon.com/rocm/manylinux/rocm-rel-7.2/torchvision-0.24.0%2Brocm7.2.0.gitb919bd0c-cp310-cp310-linux_x86_64.whl";
const ROCM_TORCHAUDIO_WHEEL_UBUNTU_2204_CP310: &str =
    "https://repo.radeon.com/rocm/manylinux/rocm-rel-7.2/torchaudio-2.9.0%2Brocm7.2.0.gite3c6ee2b-cp310-cp310-linux_x86_64.whl";
const ROCM_TRITON_WHEEL_UBUNTU_2204_CP310: &str =
    "https://repo.radeon.com/rocm/manylinux/rocm-rel-7.2/triton-3.5.1%2Brocm7.2.0.gita272dfa8-cp310-cp310-linux_x86_64.whl";
const ROCM_TORCH_WHEEL_UBUNTU_2404_CP312: &str =
    "https://repo.radeon.com/rocm/manylinux/rocm-rel-7.2/torch-2.9.1%2Brocm7.2.0.lw.git7e1940d4-cp312-cp312-linux_x86_64.whl";
const ROCM_TORCHVISION_WHEEL_UBUNTU_2404_CP312: &str =
    "https://repo.radeon.com/rocm/manylinux/rocm-rel-7.2/torchvision-0.24.0%2Brocm7.2.0.gitb919bd0c-cp312-cp312-linux_x86_64.whl";
const ROCM_TORCHAUDIO_WHEEL_UBUNTU_2404_CP312: &str =
    "https://repo.radeon.com/rocm/manylinux/rocm-rel-7.2/torchaudio-2.9.0%2Brocm7.2.0.gite3c6ee2b-cp312-cp312-linux_x86_64.whl";
const ROCM_TRITON_WHEEL_UBUNTU_2404_CP312: &str =
    "https://repo.radeon.com/rocm/manylinux/rocm-rel-7.2/triton-3.5.1%2Brocm7.2.0.gita272dfa8-cp312-cp312-linux_x86_64.whl";
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
    pub use_wsl: bool,
    pub wsl_venv_linux_path: String,
}

impl CohereTranscribeConfig {
    pub fn variant_slug(&self) -> String {
        if self.use_wsl {
            "wsl-rocm".into()
        } else {
            self.device
                .trim()
                .to_ascii_lowercase()
                .replace(|c: char| !c.is_ascii_alphanumeric(), "_")
        }
    }

    pub fn python_path(&self) -> PathBuf {
        if cfg!(windows) {
            self.venv_path.join("Scripts").join("python.exe")
        } else {
            self.venv_path.join("bin").join("python3")
        }
    }

    pub fn install_stamp_contents(&self) -> String {
        let variant = self.variant_slug();
        format!("{REQUIREMENTS}\n# variant={variant}")
    }

    pub fn install_stamp_path(&self) -> PathBuf {
        self.runtime_root
            .join(format!("install-{}.stamp", self.variant_slug()))
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
        self.runtime_root
            .join(format!("setup-{}.lock", self.variant_slug()))
    }

    pub fn ensure_files(&self) -> Result<(), String> {
        fs::create_dir_all(&self.runtime_root).map_err(|e| e.to_string())?;
        fs::create_dir_all(&self.models_dir).map_err(|e| e.to_string())?;
        fs::write(&self.worker_script_path, WORKER_SCRIPT).map_err(|e| e.to_string())?;
        fs::write(&self.requirements_path, REQUIREMENTS).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn is_installed(&self) -> bool {
        let stamp_contents = self.install_stamp_contents();
        self.python_path().exists()
            && self.install_stamp_path().exists()
            && fs::read_to_string(self.install_stamp_path())
                .map(|contents| contents == stamp_contents)
                .unwrap_or(false)
    }

    pub fn worker_device(&self) -> &str {
        if self.use_wsl || self.device.eq_ignore_ascii_case("rocm-windows") {
            "cuda"
        } else {
            self.device.as_str()
        }
    }
}

pub fn install_runtime<F>(config: &CohereTranscribeConfig, on_line: F) -> Result<(), String>
where
    F: Fn(&str) + Send + Clone + 'static,
{
    config.ensure_files()?;
    let _lock = SetupLock::acquire(config)?;
    if config.use_wsl {
        return install_wsl_runtime(config, on_line);
    }

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
    install_native_torch(config, &python_path, on_line.clone())?;
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

    fs::write(config.install_stamp_path(), config.install_stamp_contents()).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn health_check(config: &CohereTranscribeConfig) -> Result<(), String> {
    if config.setup_lock_path().exists() {
        return Err("cohere-transcribe setup is still running.".into());
    }
    if !config.is_installed() {
        return Err("cohere-transcribe runtime is not installed.".into());
    }
    if config.device.eq_ignore_ascii_case("rocm-windows") {
        validate_rocm_windows_runtime(config)?;
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
            install_runtime(config, on_line.clone())?;
        }
        log::info!("[cohere-transcribe] ensure_model: spawning worker");
        let mut worker = CohereTranscribeWorker::spawn_with_log(config, on_line.clone())?;
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
        Self::spawn_with_log(config, |_| {})
    }

    pub fn spawn_with_log<F>(config: &CohereTranscribeConfig, on_line: F) -> Result<Self, String>
    where
        F: Fn(&str) + Send + 'static,
    {
        config.ensure_files()?;
        if !config.is_installed() {
            return Err("cohere-transcribe runtime is not installed.".into());
        }
        let mut child = if config.use_wsl {
            log::info!(
                "[cohere-transcribe] launching worker through WSL with python {}/bin/python3",
                config.wsl_venv_linux_path
            );
            spawn_wsl_worker(config)?
        } else {
            log::info!(
                "[cohere-transcribe] launching worker with python {}",
                config.python_path().display()
            );
            Command::new(config.python_path())
                .arg("-u")
                .arg(&config.worker_script_path)
                .env("HF_HUB_DISABLE_PROGRESS_BARS", "0")
                .env("TQDM_FORCE", "1")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("Failed to launch cohere-transcribe worker: {e}"))?
        };

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

    pub fn ensure_model(&mut self) -> Result<(), String> {
        self.send_request(json!({
            "command": "ensure_model",
            "model": self.config.model.clone(),
            "device": self.config.worker_device(),
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
            "device": self.config.worker_device(),
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

fn pump_stderr<F>(mut stderr: impl Read + Send + 'static, tail: Arc<Mutex<String>>, on_line: F)
where
    F: Fn(&str) + Send + 'static,
{
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
                                on_line(&line_buf);
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

fn install_native_torch<F>(
    config: &CohereTranscribeConfig,
    python_path: &Path,
    on_line: F,
) -> Result<(), String>
where
    F: Fn(&str) + Send + Clone + 'static,
{
    if config.device.eq_ignore_ascii_case("rocm-windows") {
        ensure_python_312(python_path)?;
        run_command(
            Command::new(python_path)
                .arg("-m")
                .arg("pip")
                .arg("install")
                .arg("--no-cache-dir")
                .arg(ROCM_WINDOWS_SDK_CORE)
                .arg(ROCM_WINDOWS_SDK_DEVEL)
                .arg(ROCM_WINDOWS_SDK_LIBS)
                .arg(ROCM_WINDOWS_SDK_ARCHIVE),
            "install AMD ROCm Windows SDK packages for Cohere Transcribe",
            on_line.clone(),
        )?;
        run_command(
            Command::new(python_path)
                .arg("-m")
                .arg("pip")
                .arg("install")
                .arg("--no-cache-dir")
                .arg(ROCM_WINDOWS_TORCH)
                .arg(ROCM_WINDOWS_TORCHAUDIO)
                .arg(ROCM_WINDOWS_TORCHVISION),
            "install ROCm PyTorch wheels for Cohere Transcribe",
            on_line,
        )?;
        return Ok(());
    }

    run_command(
        Command::new(python_path)
            .arg("-m")
            .arg("pip")
            .arg("install")
            .arg("-v")
            .arg(TORCH_CPU_SPEC),
        "install torch for Cohere Transcribe",
        on_line,
    )
}

fn ensure_python_312(python_path: &Path) -> Result<(), String> {
    let output = Command::new(python_path)
        .arg("-c")
        .arg("import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}', end='')")
        .output()
        .map_err(|e| format!("Failed to inspect Python version for cohere-transcribe: {e}"))?;
    if !output.status.success() {
        return Err("Failed to inspect Python version for cohere-transcribe.".into());
    }
    let version = String::from_utf8(output.stdout)
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    if version == "3.12" {
        Ok(())
    } else {
        Err(format!(
            "ROCm on Windows for Cohere Transcribe currently requires Python 3.12. Found Python {}.",
            version
        ))
    }
}

fn validate_rocm_windows_runtime(config: &CohereTranscribeConfig) -> Result<(), String> {
    let output = Command::new(config.python_path())
        .arg("-c")
        .arg(
            "import json, torch; \
             result = {\
               'torch_version': torch.__version__, \
               'cuda_available': torch.cuda.is_available(), \
               'device_count': torch.cuda.device_count()\
             }; \
             if result['cuda_available'] and result['device_count'] > 0: \
                 result['device_name'] = torch.cuda.get_device_name(0); \
             print(json.dumps(result))",
        )
        .output()
        .map_err(|e| format!("Failed to validate ROCm Windows runtime for cohere-transcribe: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!(
            "ROCm Windows runtime validation failed before loading Cohere Transcribe. {}",
            if stderr.is_empty() {
                "PyTorch exited unsuccessfully while probing AMD GPU support.".to_string()
            } else {
                stderr
            }
        ));
    }

    let stdout = String::from_utf8(output.stdout).map_err(|e| e.to_string())?;
    let json: serde_json::Value =
        serde_json::from_str(stdout.trim()).map_err(|e| format!("Invalid ROCm probe output: {e}"))?;
    let cuda_available = json["cuda_available"].as_bool().unwrap_or(false);
    let device_count = json["device_count"].as_u64().unwrap_or(0);
    if cuda_available && device_count > 0 {
        log::info!(
            "[cohere-transcribe] ROCm Windows probe succeeded with device {}",
            json["device_name"].as_str().unwrap_or("unknown")
        );
        return Ok(());
    }

    Err(format!(
        "ROCm Windows runtime installed, but PyTorch did not detect a usable AMD GPU. Probe result: {}. Try updating AMD drivers, confirming Python 3.12, or switching Cohere to WSL ROCm.",
        stdout.trim()
    ))
}

fn install_wsl_runtime<F>(config: &CohereTranscribeConfig, on_line: F) -> Result<(), String>
where
    F: Fn(&str) + Send + Clone + 'static,
{
    let requirements_wsl = to_wsl_path(&config.requirements_path);
    let stamp_wsl = to_wsl_path(&config.install_stamp_path());
    let wheels = detect_rocm_wheels()?;
    let command = format!(
        "set -euo pipefail\n\
         VENV='{venv}'\n\
         REQUIREMENTS='{requirements}'\n\
         STAMP='{stamp}'\n\
         mkdir -p \"$(dirname \"$STAMP\")\"\n\
         if [ ! -x \"$VENV/bin/python3\" ]; then python3 -m venv \"$VENV\"; fi\n\
         \"$VENV/bin/python3\" -m pip install -v --upgrade pip wheel\n\
         \"$VENV/bin/python3\" -m pip uninstall -y torch torchvision torchaudio triton || true\n\
         \"$VENV/bin/python3\" -m pip install -v \"numpy==1.26.4\"\n\
         \"$VENV/bin/python3\" -m pip install -v '{torch}' '{torchvision}' '{torchaudio}' '{triton}'\n\
         \"$VENV/bin/python3\" -m pip install -v -r \"$REQUIREMENTS\"\n\
         printf '%s' {stamp_contents:?} > \"$STAMP\"\n",
        venv = config.wsl_venv_linux_path,
        requirements = requirements_wsl,
        stamp = stamp_wsl,
        torch = wheels.torch,
        torchvision = wheels.torchvision,
        torchaudio = wheels.torchaudio,
        triton = wheels.triton,
        stamp_contents = config.install_stamp_contents(),
    );

    run_command(
        Command::new("wsl").arg("bash").arg("-lc").arg(command),
        "install Cohere Transcribe WSL ROCm runtime",
        on_line,
    )
}

fn spawn_wsl_worker(config: &CohereTranscribeConfig) -> Result<Child, String> {
    let script_wsl = to_wsl_path(&config.worker_script_path);
    Command::new("wsl")
        .arg("bash")
        .arg("-lc")
        .arg(format!(
            "HF_HUB_DISABLE_PROGRESS_BARS=0 TQDM_FORCE=1 '{venv}/bin/python3' -u '{script}'",
            venv = config.wsl_venv_linux_path,
            script = script_wsl,
        ))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to launch cohere-transcribe WSL worker: {e}"))
}

fn to_wsl_path(path: &Path) -> String {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return to_wsl_path(Path::new(rest));
    }
    if s.len() >= 2 && s.chars().nth(1) == Some(':') {
        let drive = s.chars().next().unwrap().to_ascii_lowercase();
        let rest = s[2..].replace('\\', "/");
        return format!("/mnt/{drive}{rest}");
    }
    s.replace('\\', "/")
}

struct RocmWheels {
    torch: &'static str,
    torchvision: &'static str,
    torchaudio: &'static str,
    triton: &'static str,
}

fn detect_rocm_wheels() -> Result<RocmWheels, String> {
    let ubuntu_version = wsl_stdout("bash", &["-lc", "source /etc/os-release && printf '%s' \"$VERSION_ID\""])?;
    let python_tag = wsl_stdout("python3", &["-c", "import sys; print(f'cp{sys.version_info.major}{sys.version_info.minor}', end='')"])?;
    match (ubuntu_version.trim(), python_tag.trim()) {
        ("22.04", "cp310") => Ok(RocmWheels {
            torch: ROCM_TORCH_WHEEL_UBUNTU_2204_CP310,
            torchvision: ROCM_TORCHVISION_WHEEL_UBUNTU_2204_CP310,
            torchaudio: ROCM_TORCHAUDIO_WHEEL_UBUNTU_2204_CP310,
            triton: ROCM_TRITON_WHEEL_UBUNTU_2204_CP310,
        }),
        ("24.04", "cp312") => Ok(RocmWheels {
            torch: ROCM_TORCH_WHEEL_UBUNTU_2404_CP312,
            torchvision: ROCM_TORCHVISION_WHEEL_UBUNTU_2404_CP312,
            torchaudio: ROCM_TORCHAUDIO_WHEEL_UBUNTU_2404_CP312,
            triton: ROCM_TRITON_WHEEL_UBUNTU_2404_CP312,
        }),
        _ => Err(format!(
            "Cohere WSL ROCm currently supports Ubuntu 22.04 + Python 3.10 or Ubuntu 24.04 + Python 3.12. Found Ubuntu {} with {} inside WSL.",
            ubuntu_version.trim(),
            python_tag.trim()
        )),
    }
}

fn wsl_stdout(command: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("wsl")
        .arg(command)
        .args(args)
        .output()
        .map_err(|e| format!("Failed to query WSL environment: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "WSL command failed while preparing Cohere Transcribe: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    String::from_utf8(output.stdout)
        .map(|value| value.trim().to_string())
        .map_err(|e| e.to_string())
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
            use_wsl: false,
            wsl_venv_linux_path: String::new(),
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
        assert!(!config.use_wsl);
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

    #[test]
    fn worker_device_uses_cuda_for_wsl_rocm() {
        let dir = tempdir().unwrap();
        let mut config = sample_config(dir.path().join("cohere"));
        config.use_wsl = true;
        config.device = "wsl-rocm".into();
        assert_eq!(config.worker_device(), "cuda");
    }

    #[test]
    fn worker_device_uses_cuda_for_rocm_windows() {
        let dir = tempdir().unwrap();
        let mut config = sample_config(dir.path().join("cohere"));
        config.device = "rocm-windows".into();
        assert_eq!(config.worker_device(), "cuda");
    }
}
