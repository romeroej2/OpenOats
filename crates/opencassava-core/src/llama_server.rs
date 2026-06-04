//! Self-hosted llama-server runtime for Gemma 4 12B with the unified audio mmproj.
//!
//! One managed `llama-server` instance serves both speech-to-text (audio sent as
//! OpenAI-style `input_audio` content parts with a strict transcription prompt) and
//! the agent/LLM features (regular `/v1/chat/completions`). Setup is self-service:
//! the llama.cpp binary is downloaded per-platform from the pinned GitHub release,
//! and the GGUF model + mmproj are reused from an existing LM Studio / Hugging Face
//! cache install when present, otherwise downloaded from Hugging Face.

use crate::process_control::ManagedChild;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

/// Pinned llama.cpp release. LM Studio's bundled engine (2.20.0) crashes on the
/// unified gemma4ua audio projector; this upstream build supports it.
pub const LLAMA_BUILD: &str = "b9496";

pub const MODEL_NAME: &str = "gemma-4-12b";
const MODEL_REPO_BASE: &str =
    "https://huggingface.co/lmstudio-community/gemma-4-12B-it-GGUF/resolve/main";
const MODEL_FILE: &str = "gemma-4-12B-it-Q4_K_M.gguf";
const MMPROJ_FILE: &str = "mmproj-gemma-4-12B-it-BF16.gguf";
/// Approximate download sizes, used for user-facing messaging only.
pub const MODEL_DOWNLOAD_GB: f64 = 7.4;

const SERVER_CTX_SIZE: u32 = 16_384;

/// GBNF grammar for STT requests: bans `<` in the output, which masks Gemma 4's
/// channel control tokens (`<|channel>thought` …). Short or ambiguous audio
/// otherwise reliably sends the model into a thought spiral even with
/// `--reasoning off`; with the grammar it degrades to an empty transcript
/// instead (verified empirically against 0.3 s–18.7 s real recordings).
const STT_GRAMMAR: &str = "root ::= [^<]*";
const SERVER_PARALLEL: u32 = 2;
const HEALTH_TIMEOUT: Duration = Duration::from_secs(240);
const STT_REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

const STT_SYSTEM_PROMPT: &str = "You are a speech-to-text transcription engine. \
Transcribe the user's audio verbatim, in the original spoken language. Never translate. \
Output ONLY the transcribed text with no commentary, labels, or quotes. \
If the audio contains no intelligible speech, output nothing.";

/// Human-readable names for the locale codes the app exposes. The language hint
/// goes into the system prompt using the language *name* — putting a code like
/// `'pt'` in the user message made the model parrot the instruction into
/// transcripts ("The is in language code 'pt'.").
fn language_name(code: &str) -> Option<&'static str> {
    Some(match code {
        "en" => "English",
        "es" => "Spanish",
        "fr" => "French",
        "de" => "German",
        "pt" => "Portuguese",
        "it" => "Italian",
        "bg" => "Bulgarian",
        "hr" => "Croatian",
        "cs" => "Czech",
        "da" => "Danish",
        "nl" => "Dutch",
        "et" => "Estonian",
        "fi" => "Finnish",
        "el" => "Greek",
        "hu" => "Hungarian",
        "lv" => "Latvian",
        "lt" => "Lithuanian",
        "mt" => "Maltese",
        "pl" => "Polish",
        "ro" => "Romanian",
        "ru" => "Russian",
        "sk" => "Slovak",
        "sl" => "Slovenian",
        "sv" => "Swedish",
        "uk" => "Ukrainian",
        _ => return None,
    })
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LlamaServerConfig {
    pub binary: PathBuf,
    pub model: PathBuf,
    pub mmproj: PathBuf,
    pub port: u16,
}

#[derive(Clone, Debug, Default)]
pub struct AssetsStatus {
    pub binary: Option<PathBuf>,
    pub model: Option<PathBuf>,
    pub mmproj: Option<PathBuf>,
    /// Where the model files were found: "managed", "lm-studio", or "hf-cache".
    pub model_source: Option<String>,
}

impl AssetsStatus {
    pub fn ready(&self) -> bool {
        self.binary.is_some() && self.model.is_some() && self.mmproj.is_some()
    }

    pub fn into_config(self, port: u16) -> Option<LlamaServerConfig> {
        Some(LlamaServerConfig {
            binary: self.binary?,
            model: self.model?,
            mmproj: self.mmproj?,
            port,
        })
    }
}

#[derive(Clone, Debug)]
pub struct SetupProgress {
    pub stage: &'static str,
    pub pct: u32,
    pub message: String,
}

pub fn base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/v1")
}

fn root_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("OpenCassava")
        .join("llama-server")
}

fn binary_dir() -> PathBuf {
    root_dir().join("bin").join(LLAMA_BUILD)
}

fn models_dir() -> PathBuf {
    root_dir().join("models")
}

fn log_path() -> PathBuf {
    root_dir().join("llama-server.log")
}

fn server_binary_name() -> &'static str {
    if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    }
}

/// Pinned release asset for the current platform. Vulkan builds cover AMD/NVIDIA/
/// Intel GPUs on Windows/Linux x64 and fall back to CPU inference automatically;
/// macOS builds use Metal.
fn platform_asset() -> Result<&'static str, String> {
    let asset = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => "bin-win-vulkan-x64.zip",
        ("windows", "aarch64") => "bin-win-cpu-arm64.zip",
        ("macos", "aarch64") => "bin-macos-arm64.tar.gz",
        ("macos", "x86_64") => "bin-macos-x64.tar.gz",
        ("linux", "x86_64") => "bin-ubuntu-vulkan-x64.tar.gz",
        ("linux", "aarch64") => "bin-ubuntu-vulkan-arm64.tar.gz",
        (os, arch) => return Err(format!("Unsupported platform for llama-server: {os}/{arch}")),
    };
    Ok(asset)
}

fn binary_download_url() -> Result<String, String> {
    Ok(format!(
        "https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA_BUILD}/llama-{LLAMA_BUILD}-{}",
        platform_asset()?
    ))
}

fn find_file_recursive(dir: &Path, name: &str, max_depth: usize) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && path.file_name().is_some_and(|f| f == name) {
            return Some(path);
        }
        if path.is_dir() {
            subdirs.push(path);
        }
    }
    if max_depth == 0 {
        return None;
    }
    subdirs
        .into_iter()
        .find_map(|sub| find_file_recursive(&sub, name, max_depth - 1))
}

/// Locate a model file in an existing local install so we never re-download
/// something the user already has (LM Studio models dir, Hugging Face cache).
fn find_existing_model_file(name: &str) -> Option<(PathBuf, &'static str)> {
    let home = dirs::home_dir()?;

    // LM Studio: ~/.lmstudio/models/<publisher>/<repo>/<file>
    let lmstudio_models = home.join(".lmstudio").join("models");
    if let Some(path) = find_file_recursive(&lmstudio_models, name, 2) {
        return Some((path, "lm-studio"));
    }

    // Hugging Face hub cache: ~/.cache/huggingface/hub/models--*/snapshots/*/<file>
    let hf_hub = home.join(".cache").join("huggingface").join("hub");
    if let Some(path) = find_file_recursive(&hf_hub, name, 3) {
        return Some((path, "hf-cache"));
    }

    None
}

fn locate_model_file(name: &str) -> Option<(PathBuf, &'static str)> {
    let managed = models_dir().join(name);
    if managed.is_file() {
        return Some((managed, "managed"));
    }
    find_existing_model_file(name)
}

pub fn assets_status() -> AssetsStatus {
    let binary = {
        let candidate = binary_dir();
        find_file_recursive(&candidate, server_binary_name(), 4)
    };
    let model = locate_model_file(MODEL_FILE);
    let mmproj = locate_model_file(MMPROJ_FILE);
    let model_source = model.as_ref().map(|(_, source)| source.to_string());
    AssetsStatus {
        binary,
        model: model.map(|(path, _)| path),
        mmproj: mmproj.map(|(path, _)| path),
        model_source,
    }
}

async fn download_file<F>(url: &str, dest: &Path, mut on_pct: F) -> Result<(), String>
where
    F: FnMut(u32),
{
    use futures::StreamExt;
    use tokio::io::AsyncWriteExt;

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let resp = reqwest::Client::new()
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {} for {url}", resp.status()));
    }

    let total = resp.content_length().unwrap_or(0);
    let tmp = dest.with_extension("tmp");
    let mut file = tokio::fs::File::create(&tmp)
        .await
        .map_err(|e| e.to_string())?;
    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_pct = u32::MAX;
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| e.to_string())?;
        file.write_all(&bytes).await.map_err(|e| e.to_string())?;
        downloaded += bytes.len() as u64;
        if total > 0 {
            let pct = (downloaded * 100 / total) as u32;
            if pct != last_pct {
                last_pct = pct;
                on_pct(pct);
            }
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    std::fs::rename(&tmp, dest).map_err(|e| e.to_string())?;
    Ok(())
}

fn extract_archive(archive: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let name = archive.to_string_lossy();
    if name.ends_with(".zip") {
        let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        zip.extract(dest).map_err(|e| e.to_string())?;
        Ok(())
    } else if name.ends_with(".tar.gz") {
        let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
        let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
        tar.unpack(dest).map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err(format!("Unknown archive format: {name}"))
    }
}

/// Download anything missing (binary, model, mmproj). Reports progress through
/// `on_progress`; existing local copies (LM Studio, HF cache) are reused as-is.
pub async fn ensure_assets<F>(on_progress: F) -> Result<AssetsStatus, String>
where
    F: Fn(SetupProgress) + Send + Sync + 'static,
{
    let status = assets_status();

    if status.binary.is_none() {
        let url = binary_download_url()?;
        let archive_name = format!("llama-{LLAMA_BUILD}-{}", platform_asset()?);
        let archive_path = root_dir().join(&archive_name);
        on_progress(SetupProgress {
            stage: "download-binary",
            pct: 0,
            message: format!("Downloading llama.cpp {LLAMA_BUILD} runtime..."),
        });
        let progress = &on_progress;
        download_file(&url, &archive_path, move |pct| {
            progress(SetupProgress {
                stage: "download-binary",
                pct,
                message: format!("Downloading llama.cpp {LLAMA_BUILD} runtime... {pct}%"),
            });
        })
        .await?;
        on_progress(SetupProgress {
            stage: "extract-binary",
            pct: 100,
            message: "Extracting llama.cpp runtime...".into(),
        });
        let dest = binary_dir();
        let archive_for_blocking = archive_path.clone();
        tokio::task::spawn_blocking(move || extract_archive(&archive_for_blocking, &dest))
            .await
            .map_err(|e| e.to_string())??;
        let _ = std::fs::remove_file(&archive_path);
        if find_file_recursive(&binary_dir(), server_binary_name(), 4).is_none() {
            return Err("llama-server binary not found after extraction".into());
        }
    }

    if status.model.is_none() {
        let dest = models_dir().join(MODEL_FILE);
        on_progress(SetupProgress {
            stage: "download-model",
            pct: 0,
            message: format!("Downloading Gemma 4 12B Q4_K_M (~{MODEL_DOWNLOAD_GB} GB)..."),
        });
        let progress = &on_progress;
        download_file(
            &format!("{MODEL_REPO_BASE}/{MODEL_FILE}"),
            &dest,
            move |pct| {
                progress(SetupProgress {
                    stage: "download-model",
                    pct,
                    message: format!(
                        "Downloading Gemma 4 12B Q4_K_M (~{MODEL_DOWNLOAD_GB} GB)... {pct}%"
                    ),
                });
            },
        )
        .await?;
    }

    if status.mmproj.is_none() {
        let dest = models_dir().join(MMPROJ_FILE);
        on_progress(SetupProgress {
            stage: "download-mmproj",
            pct: 0,
            message: "Downloading audio projector (mmproj, ~175 MB)...".into(),
        });
        let progress = &on_progress;
        download_file(
            &format!("{MODEL_REPO_BASE}/{MMPROJ_FILE}"),
            &dest,
            move |pct| {
                progress(SetupProgress {
                    stage: "download-mmproj",
                    pct,
                    message: format!("Downloading audio projector (mmproj, ~175 MB)... {pct}%"),
                });
            },
        )
        .await?;
    }

    let final_status = assets_status();
    if !final_status.ready() {
        return Err("llama-server assets are still incomplete after setup".into());
    }
    Ok(final_status)
}

// ── Server lifecycle ─────────────────────────────────────────────────────────

struct RunningServer {
    child: ManagedChild,
    config: LlamaServerConfig,
}

static SERVER: Mutex<Option<RunningServer>> = Mutex::const_new(None);

async fn health_ok(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{port}/health");
    matches!(
        reqwest::Client::new()
            .get(&url)
            .timeout(Duration::from_secs(2))
            .send()
            .await,
        Ok(resp) if resp.status().is_success()
    )
}

fn log_tail() -> String {
    std::fs::read_to_string(log_path())
        .map(|content| {
            content
                .lines()
                .rev()
                .take(12)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn spawn_server(config: &LlamaServerConfig) -> Result<ManagedChild, String> {
    let log_file = std::fs::File::create(log_path())
        .map_err(|e| format!("Failed to create llama-server log: {e}"))?;
    let log_err = log_file
        .try_clone()
        .map_err(|e| format!("Failed to clone llama-server log handle: {e}"))?;

    let mut command = Command::new(&config.binary);
    command
        .arg("-m")
        .arg(&config.model)
        .arg("--mmproj")
        .arg(&config.mmproj)
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(config.port.to_string())
        .arg("-c")
        .arg(SERVER_CTX_SIZE.to_string())
        .arg("--parallel")
        .arg(SERVER_PARALLEL.to_string())
        .arg("--no-webui")
        // Gemma 4 is a thinking model; without this it burns the whole
        // max_tokens budget on reasoning_content and returns empty content
        // for suggestion/notes calls. Disabling also keeps STT latency low.
        .arg("--reasoning")
        .arg("off")
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(log_err));
    if let Some(dir) = config.binary.parent() {
        command.current_dir(dir);
    }

    ManagedChild::spawn(&mut command, "llama-server (gemma-4-12b)")
        .map_err(|e| format!("Failed to launch llama-server: {e}"))
}

async fn wait_until_healthy(server: &mut RunningServer) -> Result<(), String> {
    let deadline = Instant::now() + HEALTH_TIMEOUT;
    loop {
        if health_ok(server.config.port).await {
            return Ok(());
        }
        if let Ok(Some(status)) = server.child.try_wait() {
            return Err(format!(
                "llama-server exited during startup ({status}). Last log lines:\n{}",
                log_tail()
            ));
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "llama-server did not become healthy within {}s. Last log lines:\n{}",
                HEALTH_TIMEOUT.as_secs(),
                log_tail()
            ));
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// Ensure a llama-server with this exact config is running and healthy.
/// Reuses the existing process when possible; restarts it when the config changed
/// or the process died. Returns once `/health` reports ready.
pub async fn ensure_running(config: LlamaServerConfig) -> Result<(), String> {
    let mut guard = SERVER.lock().await;

    if let Some(server) = guard.as_mut() {
        let alive = matches!(server.child.try_wait(), Ok(None));
        if alive && server.config == config {
            return wait_until_healthy(server).await;
        }
        // Config changed or process died — drop kills the old tree.
        *guard = None;
    }

    log::info!(
        "[llama-server] starting on port {} with {}",
        config.port,
        config.model.display()
    );
    let child = spawn_server(&config)?;
    let mut server = RunningServer { child, config };
    let result = wait_until_healthy(&mut server).await;
    if result.is_ok() {
        *guard = Some(server);
    }
    result
}

/// True when a managed server process is currently alive.
pub async fn is_running() -> bool {
    let mut guard = SERVER.lock().await;
    match guard.as_mut() {
        Some(server) => matches!(server.child.try_wait(), Ok(None)),
        None => false,
    }
}

/// Stop the managed server if one is running.
pub async fn stop() {
    let mut guard = SERVER.lock().await;
    *guard = None; // Drop terminates the process tree.
}

// ── Speech-to-text ───────────────────────────────────────────────────────────

fn samples_to_wav(samples: &[f32]) -> Result<Vec<u8>, String> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 16_000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut writer = hound::WavWriter::new(&mut cursor, spec).map_err(|e| e.to_string())?;
        for &sample in samples {
            let value = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
            writer.write_sample(value).map_err(|e| e.to_string())?;
        }
        writer.finalize().map_err(|e| e.to_string())?;
    }
    Ok(cursor.into_inner())
}

/// Strip Gemma 4 channel/turn control tokens that can leak into `content` when
/// the model spontaneously opens its thought channel while the server runs with
/// thinking disabled (`--reasoning off`): e.g. `<|channel>thought<channel|>`.
/// If a final-channel marker is present, only the text after the last one is
/// kept; a pure thought-spiral response sanitizes to an empty string.
pub fn sanitize_output(text: &str) -> String {
    let mut s = text;
    // Prefer the explicit final channel when the model emitted one.
    if let Some(idx) = s.rfind("<|channel>final") {
        s = &s[idx + "<|channel>final".len()..];
    }

    const CHANNEL_NAMES: [&str; 4] = ["thought", "final", "analysis", "commentary"];
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    loop {
        // Next control token: `<|...>` (e.g. <|channel>, <|turn>) or `<channel|>`.
        let pipe_open = rest.find("<|");
        let chan_close = rest.find("<channel|>");
        let (start, is_pipe_open) = match (pipe_open, chan_close) {
            (Some(a), Some(b)) if a <= b => (a, true),
            (Some(a), None) => (a, true),
            (_, Some(b)) => (b, false),
            (None, None) => break,
        };
        out.push_str(&rest[..start]);
        rest = &rest[start..];
        if is_pipe_open {
            match rest.find('>') {
                Some(end) => {
                    let token = &rest[..=end];
                    rest = &rest[end + 1..];
                    // `<|channel>` is followed by the channel name as plain text.
                    if token == "<|channel>" {
                        if let Some(name) =
                            CHANNEL_NAMES.iter().find(|name| rest.starts_with(**name))
                        {
                            rest = &rest[name.len()..];
                        }
                    }
                }
                None => {
                    // Truncated token at end of output — drop it.
                    rest = "";
                    break;
                }
            }
        } else {
            rest = &rest["<channel|>".len()..];
        }
    }
    out.push_str(rest);
    out.trim().to_string()
}

/// Blocking STT call for the streaming transcriber's worker thread: wraps the
/// segment in a WAV container, base64-encodes it, and asks Gemma to transcribe it
/// via an OpenAI-style `input_audio` chat completion at temperature 0.
pub fn transcribe_segment_blocking(
    base_url: &str,
    samples: &[f32],
    language: &str,
) -> Result<String, String> {
    use base64::Engine;

    let wav = samples_to_wav(samples)?;
    let audio_b64 = base64::engine::general_purpose::STANDARD.encode(wav);

    // Language hint lives in the system prompt; the user message stays bare.
    // A wrong hint corrupts output (e.g. Portuguese-ifies Spanish speech), so it
    // is only added when the user explicitly picked a locale.
    let system_prompt = match language_name(language) {
        Some(name) => format!("{STT_SYSTEM_PROMPT} The speech is expected to be in {name}."),
        None => STT_SYSTEM_PROMPT.to_string(),
    };
    let instruction = "Transcribe this audio.";

    let payload = serde_json::json!({
        "model": MODEL_NAME,
        "messages": [
            { "role": "system", "content": system_prompt },
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_audio",
                        "input_audio": { "data": audio_b64, "format": "wav" }
                    },
                    { "type": "text", "text": instruction }
                ]
            }
        ],
        "temperature": 0.0,
        "max_tokens": 512,
        "grammar": STT_GRAMMAR,
        // DRY sampler: kills greedy-decode repetition loops ("que se que se …")
        // without biasing silence toward hallucinated text the way a plain
        // repeat_penalty does (verified on real recordings).
        "dry_multiplier": 0.8,
        "dry_base": 1.75,
        "dry_allowed_length": 4
    });

    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let client = reqwest::blocking::Client::builder()
        .timeout(STT_REQUEST_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(&url)
        .json(&payload)
        .send()
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("llama-server STT HTTP {}", resp.status()));
    }
    let parsed: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
    let text = parsed["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .trim();
    Ok(sanitize_output(text))
}

/// Blocking health probe for use on the transcriber's worker thread: waits until
/// the server answers `/health`, so VAD segments buffered during model load are
/// transcribed instead of failing.
pub fn wait_healthy_blocking(base_url: &str, timeout: Duration) -> Result<(), String> {
    let health_url = format!(
        "{}/health",
        base_url.trim_end_matches('/').trim_end_matches("/v1")
    );
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?;
    let deadline = Instant::now() + timeout;
    loop {
        if matches!(client.get(&health_url).send(), Ok(resp) if resp.status().is_success()) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("llama-server is not reachable for transcription".into());
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_formats_port() {
        assert_eq!(base_url(8765), "http://127.0.0.1:8765/v1");
    }

    #[test]
    fn binary_url_targets_pinned_release() {
        // platform_asset is compile-target dependent; just confirm the URL shape
        // on supported dev platforms.
        if let Ok(url) = binary_download_url() {
            assert!(url.contains("/releases/download/b9496/llama-b9496-"));
        }
    }

    #[test]
    fn assets_status_reports_not_ready_when_empty() {
        // On CI machines without LM Studio or a prior download this is not ready;
        // when assets exist the invariant ready == all-three-present still holds.
        let status = assets_status();
        assert_eq!(
            status.ready(),
            status.binary.is_some() && status.model.is_some() && status.mmproj.is_some()
        );
    }

    #[test]
    fn wav_encoding_produces_riff_header() {
        let samples = vec![0.0f32; 1600];
        let wav = samples_to_wav(&samples).unwrap();
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        // 16-bit mono @ 16 kHz: data section = 2 bytes per sample.
        assert!(wav.len() >= 44 + 1600 * 2);
    }

    #[test]
    fn sanitize_strips_thought_spiral_to_empty() {
        // Exact leak pattern observed with real mic audio.
        let leaked = "<|channel>thought<channel|><channel|><|channel>thought<channel|><|channel>thought<channel|>";
        assert_eq!(sanitize_output(leaked), "");
    }

    #[test]
    fn sanitize_keeps_text_after_final_channel() {
        let leaked = "<|channel>thought some hidden reasoning <channel|><|channel>final Hello world";
        assert_eq!(sanitize_output(leaked), "Hello world");
    }

    #[test]
    fn sanitize_strips_inline_tokens_but_keeps_words() {
        let leaked = "Vamos a <|turn>grabar esta pregunta<channel|>.";
        assert_eq!(sanitize_output(leaked), "Vamos a grabar esta pregunta.");
    }

    #[test]
    fn sanitize_passes_clean_text_through() {
        let clean = "Vamos a grabar esta pregunta para saber que estamos guardando el campo correcto.";
        assert_eq!(sanitize_output(clean), clean);
        let json = "```json\n{\"shouldSurface\": true}\n```";
        assert_eq!(sanitize_output(json), json);
    }

    #[test]
    fn sanitize_handles_truncated_token_at_end() {
        assert_eq!(sanitize_output("Hello <|chan"), "Hello");
    }

    #[test]
    fn config_equality_drives_restart_decisions() {
        let a = LlamaServerConfig {
            binary: "bin".into(),
            model: "model".into(),
            mmproj: "mmproj".into(),
            port: 8765,
        };
        let mut b = a.clone();
        assert_eq!(a, b);
        b.port = 9000;
        assert_ne!(a, b);
    }
}
