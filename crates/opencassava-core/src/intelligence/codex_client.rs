use crate::intelligence::llm_client::Message;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

#[derive(Debug, Clone)]
pub struct CodexCliConfig {
    pub command_path: String,
    pub model: Option<String>,
    pub working_dir: PathBuf,
    pub output_dir: PathBuf,
    pub timeout: Duration,
    pub allow_workspace_search: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexCommandSpec {
    pub program: String,
    pub args: Vec<String>,
    pub working_dir: PathBuf,
    pub output_file: PathBuf,
    pub display_program: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexTokenUsage {
    pub input_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexCompletion {
    pub text: String,
    pub usage: Option<CodexTokenUsage>,
}

pub fn resolve_command_path(command_path: &str) -> Result<String, String> {
    let trimmed = command_path.trim();
    let command = if trimmed.is_empty() { "codex" } else { trimmed };
    let path = Path::new(command);

    if path.components().count() > 1 || path.is_absolute() {
        return validate_explicit_command_path(path);
    }

    find_command_candidate(command)
        .map(|path| path.to_string_lossy().into_owned())
        .ok_or_else(|| {
            format!(
                "Could not find `{command}`. Install Codex CLI, or set the full path to codex.cmd/codex.exe in Settings."
            )
        })
}

fn validate_explicit_command_path(path: &Path) -> Result<String, String> {
    if !path.exists() {
        return Err(format!("Codex CLI path does not exist: {}", path.display()));
    }

    if cfg!(windows) && path.extension().and_then(|ext| ext.to_str()) == Some("ps1") {
        return Err(
            "Use codex.cmd or codex.exe for OpenCassava. PowerShell .ps1 shims are not launched directly by the app."
                .into(),
        );
    }

    Ok(path.to_string_lossy().into_owned())
}

fn find_command_candidate(command: &str) -> Option<PathBuf> {
    let dirs = command_search_dirs();
    command_candidate_names(command)
        .into_iter()
        .flat_map(|name| dirs.iter().map(move |dir| dir.join(&name)))
        .find(|path| path.exists())
}

fn command_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }

    if cfg!(windows) {
        dirs.extend(windows_common_process_dirs());
        dirs.extend(windows_codex_app_resource_dirs());
    }

    dedupe_paths(dirs)
}

fn command_candidate_names(command: &str) -> Vec<String> {
    if Path::new(command).extension().is_some() {
        return vec![command.to_string()];
    }

    if cfg!(windows) {
        vec![
            format!("{command}.exe"),
            format!("{command}.cmd"),
            format!("{command}.bat"),
            command.to_string(),
        ]
    } else {
        vec![command.to_string()]
    }
}

pub fn process_path_env(command_path: &str) -> Option<OsString> {
    std::env::join_paths(process_path_dirs(command_path)).ok()
}

fn resolve_launch_command(command_path: &str) -> (String, Vec<String>, String) {
    let resolved =
        resolve_command_path(command_path).unwrap_or_else(|_| command_path.trim().to_string());
    if let Some((node, script)) = npm_codex_shim_target(&resolved) {
        return (
            node.to_string_lossy().into_owned(),
            vec![script.to_string_lossy().into_owned()],
            resolved,
        );
    }

    (resolved.clone(), Vec::new(), resolved)
}

fn npm_codex_shim_target(command_path: &str) -> Option<(PathBuf, PathBuf)> {
    let path = Path::new(command_path);
    if !cfg!(windows) || path.extension().and_then(|ext| ext.to_str()) != Some("cmd") {
        return None;
    }

    let script = path
        .parent()?
        .join("node_modules")
        .join("@openai")
        .join("codex")
        .join("bin")
        .join("codex.js");
    if !script.exists() {
        return None;
    }

    let node = find_in_dirs("node", &process_path_dirs(command_path))?;
    Some((node, script))
}

pub fn codex_launch_diagnostics(command_path: &str) -> String {
    let path_dirs = process_path_dirs(command_path);
    let node = find_in_dirs("node", &path_dirs)
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| "not found".into());
    let codex = find_in_dirs("codex", &path_dirs)
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| "not found".into());
    let path_preview = path_dirs
        .iter()
        .take(12)
        .map(|path| path.to_string_lossy())
        .collect::<Vec<_>>()
        .join("; ");
    let path_count = path_dirs.len();

    format!(
        "Codex launch diagnostics: command={command_path}; node={node}; codexOnPath={codex}; pathEntries={path_count}; pathPreview={path_preview}"
    )
}

fn process_path_dirs(command_path: &str) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(parent) = Path::new(command_path).parent() {
        dirs.push(parent.to_path_buf());
    }

    if cfg!(windows) {
        dirs.extend(windows_common_process_dirs());
        dirs.extend(windows_codex_app_resource_dirs());
    }

    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }

    dedupe_paths(dirs.into_iter().filter(|dir| dir.exists()))
}

fn find_in_dirs(command: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    command_candidate_names(command)
        .into_iter()
        .flat_map(|name| dirs.iter().map(move |dir| dir.join(&name)))
        .find(|path| path.exists())
}

fn windows_common_process_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    if let Some(system_root) = std::env::var_os("SystemRoot") {
        let system_root = PathBuf::from(system_root);
        dirs.push(system_root.join("System32"));
        dirs.push(system_root);
    } else {
        dirs.push(PathBuf::from(r"C:\Windows\System32"));
        dirs.push(PathBuf::from(r"C:\Windows"));
    }

    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        dirs.push(PathBuf::from(program_files).join("nodejs"));
    }
    dirs.push(PathBuf::from(r"C:\Program Files\nodejs"));

    if let Some(program_files_x86) = std::env::var_os("ProgramFiles(x86)") {
        dirs.push(PathBuf::from(program_files_x86).join("nodejs"));
    }
    dirs.push(PathBuf::from(r"C:\Program Files (x86)\nodejs"));

    if let Some(nvm_symlink) = std::env::var_os("NVM_SYMLINK") {
        dirs.push(PathBuf::from(nvm_symlink));
    }
    dirs.push(PathBuf::from(r"C:\nvm4w\nodejs"));

    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("npm"));
    }
    if let Some(home) = dirs::home_dir() {
        dirs.push(
            home.join("AppData")
                .join("Local")
                .join("Programs")
                .join("nodejs"),
        );
        dirs.push(home.join("AppData").join("Roaming").join("npm"));
        dirs.push(
            home.join("AppData")
                .join("Local")
                .join("Microsoft")
                .join("WindowsApps"),
        );
    }

    dirs
}

fn windows_codex_app_resource_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    for root in [
        std::env::var_os("ProgramFiles")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Program Files")),
        PathBuf::from(r"C:\Program Files\WindowsApps"),
    ] {
        let windows_apps = if root.file_name().and_then(|name| name.to_str()) == Some("WindowsApps")
        {
            root
        } else {
            root.join("WindowsApps")
        };

        let Ok(entries) = std::fs::read_dir(windows_apps) else {
            continue;
        };

        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("OpenAI.Codex_") {
                dirs.push(entry.path().join("app").join("resources"));
            }
        }
    }

    dirs
}

fn dedupe_paths(paths: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    let mut unique = Vec::new();
    for path in paths {
        if !unique.iter().any(|existing| existing == &path) {
            unique.push(path);
        }
    }
    unique
}

pub fn build_prompt(messages: &[Message]) -> String {
    build_prompt_with_policy(messages, false)
}

fn build_prompt_with_policy(messages: &[Message], allow_workspace_search: bool) -> String {
    let mut prompt = if allow_workspace_search {
        String::from(
            "You are the LLM backend for OpenCassava meeting intelligence. \
You may inspect files under the current working directory to find relevant Obsidian notes. \
Use read-only commands only. Do not edit files, create files, delete files, or inspect files outside the current working directory.\n\n",
        )
    } else {
        String::from(
            "You are the LLM backend for OpenCassava meeting intelligence. \
Respond to the supplied messages only. Do not inspect files, edit files, or run commands.\n\n",
        )
    };

    for message in messages {
        prompt.push_str("<message role=\"");
        prompt.push_str(&message.role);
        prompt.push_str("\">\n");
        prompt.push_str(&message.content);
        prompt.push_str("\n</message>\n\n");
    }

    prompt
}

pub fn command_spec(config: &CodexCliConfig, output_file: PathBuf) -> CodexCommandSpec {
    let (program, mut args, display_program) = resolve_launch_command(&config.command_path);
    args.extend([
        "exec".to_string(),
        "--skip-git-repo-check".to_string(),
        "--ephemeral".to_string(),
        "--sandbox".to_string(),
        "read-only".to_string(),
        "-c".to_string(),
        "approval_policy=\"never\"".to_string(),
        "--color".to_string(),
        "never".to_string(),
        "--json".to_string(),
        "--output-last-message".to_string(),
        output_file.to_string_lossy().into_owned(),
        "--cd".to_string(),
        config.working_dir.to_string_lossy().into_owned(),
    ]);

    if let Some(model) = config
        .model
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        args.push("--model".to_string());
        args.push(model.to_string());
    }

    args.push("-".to_string());

    CodexCommandSpec {
        program,
        args,
        working_dir: config.working_dir.clone(),
        output_file,
        display_program,
    }
}

pub async fn complete(
    config: &CodexCliConfig,
    messages: &[Message],
) -> Result<CodexCompletion, String> {
    tokio::fs::create_dir_all(&config.working_dir)
        .await
        .map_err(|e| format!("Failed to create Codex workspace: {e}"))?;
    tokio::fs::create_dir_all(&config.output_dir)
        .await
        .map_err(|e| format!("Failed to create Codex output directory: {e}"))?;

    let output_file = unique_output_file(&config.output_dir);
    let spec = command_spec(config, output_file.clone());
    let prompt = build_prompt_with_policy(messages, config.allow_workspace_search);

    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .current_dir(&spec.working_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    if let Some(path) = process_path_env(&spec.program) {
        command.env("PATH", path.clone());
        #[cfg(windows)]
        command.env("Path", path);
    }

    let diagnostics = codex_launch_diagnostics(&spec.display_program);
    log::info!("{diagnostics}");
    log::info!(
        "Codex command: program={} args={} cwd={} timeout={}s promptChars={}",
        spec.program,
        spec.args.join(" "),
        spec.working_dir.display(),
        config.timeout.as_secs(),
        prompt.chars().count()
    );

    let started = Instant::now();
    let mut child = command.spawn().map_err(|e| {
        format!(
            "Failed to start Codex CLI `{}`: {e}. {diagnostics}",
            spec.program
        )
    })?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(prompt.as_bytes())
            .await
            .map_err(|e| format!("Failed to write prompt to Codex CLI: {e}"))?;
    }

    let output = match tokio::time::timeout(config.timeout, child.wait_with_output()).await {
        Ok(result) => result.map_err(|e| format!("Codex CLI failed: {e}"))?,
        Err(_) => {
            log::warn!(
                "Codex CLI timed out after {}ms. {diagnostics}",
                started.elapsed().as_millis()
            );
            return Err(format!("Codex CLI timed out. {diagnostics}"));
        }
    };

    let elapsed_ms = started.elapsed().as_millis();
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if !stderr.trim().is_empty() {
            stderr.trim()
        } else {
            stdout.trim()
        };
        log::warn!(
            "Codex CLI failed after {elapsed_ms}ms with status {}. stderrSnippet={} stdoutSnippet={}. {diagnostics}",
            output.status,
            log_snippet(&stderr),
            log_snippet(&stdout)
        );
        return Err(format!(
            "Codex CLI exited with status {}{}. {}",
            output.status,
            if detail.is_empty() {
                String::new()
            } else {
                format!(": {detail}")
            },
            diagnostics
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let usage = parse_usage_from_jsonl(&stdout);
    log::info!(
        "Codex CLI completed in {elapsed_ms}ms. usage={:?} stdoutSnippet={}",
        usage,
        log_snippet(&stdout)
    );
    let final_message = tokio::fs::read_to_string(&output_file)
        .await
        .map_err(|e| format!("Codex CLI did not write a final response: {e}"))?;
    let _ = tokio::fs::remove_file(&output_file).await;

    let trimmed = final_message.trim();
    if trimmed.is_empty() {
        Err("Codex CLI returned an empty response".into())
    } else {
        Ok(CodexCompletion {
            text: trimmed.to_string(),
            usage,
        })
    }
}

fn log_snippet(value: &str) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    normalized.chars().take(500).collect()
}

pub fn parse_usage_from_jsonl(output: &str) -> Option<CodexTokenUsage> {
    output
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|value| usage_from_value(&value))
        .last()
}

fn usage_from_value(value: &Value) -> Option<CodexTokenUsage> {
    if let Some(usage) = value.get("usage").and_then(usage_from_object) {
        return Some(usage);
    }

    if let Some(usage) = usage_from_object(value) {
        return Some(usage);
    }

    match value {
        Value::Object(map) => map.values().find_map(usage_from_value),
        Value::Array(items) => items.iter().find_map(usage_from_value),
        _ => None,
    }
}

fn usage_from_object(value: &Value) -> Option<CodexTokenUsage> {
    let input_tokens = first_u64(
        value,
        &[
            "input_tokens",
            "inputTokens",
            "prompt_tokens",
            "promptTokens",
        ],
    );
    let cached_input_tokens = first_u64(
        value,
        &[
            "cached_input_tokens",
            "cachedInputTokens",
            "cached_tokens",
            "cachedTokens",
        ],
    );
    let output_tokens = first_u64(
        value,
        &[
            "output_tokens",
            "outputTokens",
            "completion_tokens",
            "completionTokens",
        ],
    );
    let total_tokens = first_u64(value, &["total_tokens", "totalTokens"]);

    if input_tokens.is_none()
        && cached_input_tokens.is_none()
        && output_tokens.is_none()
        && total_tokens.is_none()
    {
        return None;
    }

    Some(CodexTokenUsage {
        input_tokens,
        cached_input_tokens,
        output_tokens,
        total_tokens,
    })
}

fn first_u64(value: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_u64))
}

fn unique_output_file(dir: &Path) -> PathBuf {
    dir.join(format!("codex-output-{}.txt", uuid::Uuid::new_v4()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(model: Option<String>) -> CodexCliConfig {
        CodexCliConfig {
            command_path: "codex".into(),
            model,
            working_dir: PathBuf::from("/tmp/opencassava-codex"),
            output_dir: PathBuf::from("/tmp/opencassava-codex-output"),
            timeout: Duration::from_secs(20),
            allow_workspace_search: false,
        }
    }

    #[test]
    fn command_spec_uses_isolated_workspace_and_safe_flags() {
        let output = PathBuf::from("/tmp/opencassava-codex/final.txt");
        let spec = command_spec(&config(Some("gpt-5.4".into())), output.clone());
        assert!(!spec.program.trim().is_empty());
        assert_eq!(spec.working_dir, PathBuf::from("/tmp/opencassava-codex"));
        assert!(spec.args.contains(&"--ephemeral".into()));
        assert!(spec
            .args
            .windows(2)
            .any(|w| w == ["--sandbox", "read-only"]));
        assert!(spec
            .args
            .windows(2)
            .any(|w| w == ["-c", "approval_policy=\"never\""]));
        assert!(spec
            .args
            .windows(2)
            .any(|w| w == ["--output-last-message", output.to_string_lossy().as_ref()]));
        assert!(spec.args.contains(&"--json".into()));
        assert!(spec.args.windows(2).any(|w| w == ["--model", "gpt-5.4"]));
        assert_eq!(spec.args.last().map(String::as_str), Some("-"));
    }

    #[test]
    fn command_spec_omits_blank_model() {
        let output = PathBuf::from("/tmp/opencassava-codex/final.txt");
        let spec = command_spec(&config(Some("  ".into())), output);
        assert!(!spec.args.iter().any(|arg| arg == "--model"));
    }

    #[cfg(windows)]
    #[test]
    fn command_spec_bypasses_npm_cmd_shim_when_node_is_available() {
        let temp = tempfile::tempdir().unwrap();
        let shim = temp.path().join("codex.cmd");
        let script = temp
            .path()
            .join("node_modules")
            .join("@openai")
            .join("codex")
            .join("bin")
            .join("codex.js");
        std::fs::create_dir_all(script.parent().unwrap()).unwrap();
        std::fs::write(&shim, "@echo off").unwrap();
        std::fs::write(&script, "#!/usr/bin/env node").unwrap();
        if find_in_dirs("node", &process_path_dirs(&shim.to_string_lossy())).is_none() {
            return;
        }

        let output = temp.path().join("final.txt");
        let mut config = config(None);
        config.command_path = shim.to_string_lossy().into_owned();
        let spec = command_spec(&config, output);

        assert!(spec.program.to_ascii_lowercase().ends_with("node.exe"));
        assert_eq!(spec.args.first().map(PathBuf::from), Some(script));
        assert_eq!(spec.display_program, shim.to_string_lossy());
    }

    #[test]
    fn prompt_preserves_roles_and_content() {
        let prompt = build_prompt(&[Message::system("Return JSON only."), Message::user("Hello")]);
        assert!(prompt.contains("role=\"system\""));
        assert!(prompt.contains("Return JSON only."));
        assert!(prompt.contains("role=\"user\""));
        assert!(prompt.contains("Hello"));
    }

    #[test]
    fn parses_usage_from_jsonl_event_shapes() {
        let output = r#"{"type":"session.started"}
{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":25,"output_tokens":40,"total_tokens":140}}"#;
        assert_eq!(
            parse_usage_from_jsonl(output),
            Some(CodexTokenUsage {
                input_tokens: Some(100),
                cached_input_tokens: Some(25),
                output_tokens: Some(40),
                total_tokens: Some(140),
            })
        );
    }

    #[test]
    fn parses_usage_from_nested_camel_case_event_shapes() {
        let output = r#"{"msg":{"usage":{"inputTokens":7,"outputTokens":3}}}"#;
        assert_eq!(
            parse_usage_from_jsonl(output),
            Some(CodexTokenUsage {
                input_tokens: Some(7),
                cached_input_tokens: None,
                output_tokens: Some(3),
                total_tokens: None,
            })
        );
    }

    #[test]
    fn explicit_missing_command_path_errors() {
        let err = resolve_command_path("/definitely/missing/codex").unwrap_err();
        assert!(err.contains("does not exist"));
    }

    #[test]
    fn blank_command_defaults_to_codex_lookup() {
        let resolved = resolve_command_path("");
        if let Ok(path) = resolved {
            assert!(path.to_ascii_lowercase().contains("codex"));
        }
    }
}
