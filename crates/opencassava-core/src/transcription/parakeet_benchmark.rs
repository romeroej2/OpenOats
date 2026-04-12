use super::parakeet::{
    install_runtime, model_storage_exists, ParakeetConfig, ParakeetExecutionBackend, ParakeetWorker,
};
use crate::audio::recorder::read_wav_as_f32_16k;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread;
use std::time::{Duration, Instant};
use sysinfo::{Pid, ProcessRefreshKind, System};

const DEFAULT_POLL_INTERVAL_MS: u64 = 250;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ParakeetBenchmarkSample {
    pub audio_filepath: PathBuf,
    pub reference_text: String,
    pub corpus: String,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub duration_secs: Option<f64>,
    #[serde(default)]
    pub sample_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ParakeetBenchmarkManifest {
    pub samples: Vec<ParakeetBenchmarkSample>,
}

#[derive(Clone, Debug)]
pub struct ParakeetBenchmarkSuiteConfig {
    pub manifest_path: PathBuf,
    pub runtime_root: PathBuf,
    pub worker_script_path: PathBuf,
    pub requirements_path: PathBuf,
    pub venv_path: PathBuf,
    pub models_dir: PathBuf,
    pub models: Vec<String>,
    pub device: String,
    pub language: String,
    pub diarization_enabled: bool,
    pub poll_interval: Duration,
}

impl ParakeetBenchmarkSuiteConfig {
    pub fn with_defaults(manifest_path: PathBuf, runtime_root: PathBuf) -> Self {
        Self {
            manifest_path,
            worker_script_path: runtime_root.join("parakeet_worker.py"),
            requirements_path: runtime_root.join("parakeet_requirements.txt"),
            venv_path: runtime_root.join("venv-cpu"),
            models_dir: runtime_root.join("models"),
            runtime_root,
            models: default_benchmark_models(),
            device: "cpu".into(),
            language: "auto".into(),
            diarization_enabled: false,
            poll_interval: Duration::from_millis(DEFAULT_POLL_INTERVAL_MS),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcceleratorMetrics {
    pub average_gpu_percent: Option<f32>,
    pub peak_vram_bytes: Option<u64>,
}

impl Default for AcceleratorMetrics {
    fn default() -> Self {
        Self {
            average_gpu_percent: None,
            peak_vram_bytes: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CorpusBenchmarkResult {
    pub corpus: String,
    pub samples: usize,
    pub total_audio_seconds: f64,
    pub word_error_rate: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelBenchmarkResult {
    pub model: String,
    pub requested_device: String,
    pub resolved_device: String,
    pub execution_backend: ParakeetExecutionBackend,
    pub samples: usize,
    pub cold_start_ms: u64,
    pub warm_start_ms: u64,
    pub first_transcript_ms: u64,
    pub steady_state_throughput_audio_seconds_per_wall_second: f64,
    pub total_audio_seconds: f64,
    pub total_transcription_wall_ms: u64,
    pub average_cpu_percent: f32,
    pub peak_rss_bytes: u64,
    pub warmed_idle_rss_bytes: u64,
    pub accelerator_metrics: AcceleratorMetrics,
    pub corpus_results: Vec<CorpusBenchmarkResult>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ParakeetBenchmarkReport {
    pub generated_at: DateTime<Utc>,
    pub manifest_path: PathBuf,
    pub requested_models: Vec<String>,
    pub requested_device: String,
    pub resolved_device: String,
    pub gpu_metrics_available: bool,
    pub runs: Vec<ModelBenchmarkResult>,
}

#[derive(Clone, Debug)]
struct PreparedBenchmarkSample {
    reference_text: String,
    corpus: String,
    language: Option<String>,
    duration_secs: f64,
    audio: Vec<f32>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct ProcessMetricSummary {
    average_cpu_percent: f32,
    peak_rss_bytes: u64,
}

#[derive(Default)]
struct CorpusAccumulator {
    samples: usize,
    total_audio_seconds: f64,
    reference_words: usize,
    edit_distance_words: usize,
}

impl CorpusAccumulator {
    fn add(&mut self, reference_text: &str, hypothesis_text: &str, duration_secs: f64) {
        let reference_words = normalized_words(reference_text);
        let hypothesis_words = normalized_words(hypothesis_text);
        self.samples += 1;
        self.total_audio_seconds += duration_secs;
        self.reference_words += reference_words.len();
        self.edit_distance_words += levenshtein_distance(&reference_words, &hypothesis_words);
    }

    fn into_result(self, corpus: String) -> CorpusBenchmarkResult {
        CorpusBenchmarkResult {
            corpus,
            samples: self.samples,
            total_audio_seconds: self.total_audio_seconds,
            word_error_rate: if self.reference_words == 0 {
                0.0
            } else {
                self.edit_distance_words as f64 / self.reference_words as f64
            },
        }
    }
}

pub fn default_benchmark_models() -> Vec<String> {
    vec![
        "nvidia/parakeet-tdt-0.6b-v3".into(),
        "nvidia/parakeet-tdt_ctc-1.1b".into(),
        "nvidia/parakeet-ctc-0.6b".into(),
    ]
}

pub fn load_benchmark_manifest(path: &Path) -> Result<ParakeetBenchmarkManifest, String> {
    let contents =
        fs::read_to_string(path).map_err(|e| format!("Failed reading manifest {path:?}: {e}"))?;
    if path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("jsonl"))
        .unwrap_or(false)
    {
        let samples = contents
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| {
                serde_json::from_str::<ParakeetBenchmarkSample>(line).map_err(|e| e.to_string())
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed parsing manifest JSONL {path:?}: {e}"))?;
        return Ok(ParakeetBenchmarkManifest { samples });
    }

    let trimmed = contents.trim();
    if trimmed.starts_with('[') {
        let samples = serde_json::from_str::<Vec<ParakeetBenchmarkSample>>(trimmed)
            .map_err(|e| format!("Failed parsing manifest JSON array {path:?}: {e}"))?;
        Ok(ParakeetBenchmarkManifest { samples })
    } else {
        serde_json::from_str::<ParakeetBenchmarkManifest>(trimmed)
            .map_err(|e| format!("Failed parsing manifest object {path:?}: {e}"))
    }
}

pub fn run_benchmark_suite(
    suite: &ParakeetBenchmarkSuiteConfig,
) -> Result<ParakeetBenchmarkReport, String> {
    let manifest = load_benchmark_manifest(&suite.manifest_path)?;
    let prepared_samples = prepare_manifest_samples(manifest)?;
    if prepared_samples.is_empty() {
        return Err("Benchmark manifest did not contain any samples.".into());
    }

    let mut runs = Vec::new();
    for model in &suite.models {
        let config = benchmark_worker_config(suite, model.clone());
        prepare_benchmark_model(&config)?;
        runs.push(run_model_benchmark(
            &config,
            &prepared_samples,
            &suite.language,
            suite.poll_interval,
        )?);
    }

    let execution =
        benchmark_worker_config(suite, suite.models.first().cloned().unwrap_or_default())
            .execution_target();
    Ok(ParakeetBenchmarkReport {
        generated_at: Utc::now(),
        manifest_path: suite.manifest_path.clone(),
        requested_models: suite.models.clone(),
        requested_device: suite.device.clone(),
        resolved_device: execution.resolved_device,
        gpu_metrics_available: false,
        runs,
    })
}

fn benchmark_worker_config(suite: &ParakeetBenchmarkSuiteConfig, model: String) -> ParakeetConfig {
    ParakeetConfig {
        runtime_root: suite.runtime_root.clone(),
        worker_script_path: suite.worker_script_path.clone(),
        requirements_path: suite.requirements_path.clone(),
        venv_path: suite.venv_path.clone(),
        models_dir: suite.models_dir.clone(),
        model,
        device: suite.device.clone(),
        language: suite.language.clone(),
        diarization_enabled: suite.diarization_enabled,
    }
}

fn prepare_benchmark_model(config: &ParakeetConfig) -> Result<(), String> {
    config.ensure_files()?;
    if !config.is_installed() {
        install_runtime(config, |_| {})?;
    }
    if !model_storage_exists(config) {
        let mut worker = ParakeetWorker::spawn(config)?;
        worker.ensure_model(config.diarization_enabled)?;
        worker.shutdown()?;
    }
    Ok(())
}

fn run_model_benchmark(
    config: &ParakeetConfig,
    samples: &[PreparedBenchmarkSample],
    default_language: &str,
    poll_interval: Duration,
) -> Result<ModelBenchmarkResult, String> {
    let execution = config.execution_target();

    let cold_start = Instant::now();
    let mut cold_worker = ParakeetWorker::spawn(config)?;
    cold_worker.ensure_model(config.diarization_enabled)?;
    let cold_start_ms = cold_start.elapsed().as_millis() as u64;
    cold_worker.shutdown()?;

    let warm_start = Instant::now();
    let mut warm_worker = ParakeetWorker::spawn(config)?;
    warm_worker.ensure_model(config.diarization_enabled)?;
    let warm_start_ms = warm_start.elapsed().as_millis() as u64;

    let warmed_idle_rss_bytes = measure_process_rss(warm_worker.pid(), poll_interval)?;

    let monitor = ProcessMonitor::spawn(warm_worker.pid(), poll_interval);
    let started_at = Instant::now();
    let mut predictions = Vec::with_capacity(samples.len());
    let mut first_transcript_ms = 0;

    for (index, sample) in samples.iter().enumerate() {
        let language = sample.language.as_deref().unwrap_or(default_language);
        let sample_started_at = Instant::now();
        let text = warm_worker.transcribe_with_language(&sample.audio, Some(language))?;
        if index == 0 {
            first_transcript_ms = sample_started_at.elapsed().as_millis() as u64;
        }
        predictions.push(text);
    }
    let total_transcription_wall_ms = started_at.elapsed().as_millis() as u64;
    let cpu_summary = monitor.stop()?;
    warm_worker.shutdown()?;

    let total_audio_seconds = samples
        .iter()
        .map(|sample| sample.duration_secs)
        .sum::<f64>();
    let corpus_results = aggregate_corpus_results(samples, &predictions);

    Ok(ModelBenchmarkResult {
        model: config.model.clone(),
        requested_device: config.device.clone(),
        resolved_device: execution.resolved_device,
        execution_backend: execution.backend,
        samples: samples.len(),
        cold_start_ms,
        warm_start_ms,
        first_transcript_ms,
        steady_state_throughput_audio_seconds_per_wall_second: if total_transcription_wall_ms == 0 {
            total_audio_seconds
        } else {
            total_audio_seconds / (total_transcription_wall_ms as f64 / 1000.0)
        },
        total_audio_seconds,
        total_transcription_wall_ms,
        average_cpu_percent: cpu_summary.average_cpu_percent,
        peak_rss_bytes: cpu_summary.peak_rss_bytes,
        warmed_idle_rss_bytes,
        accelerator_metrics: AcceleratorMetrics::default(),
        corpus_results,
    })
}

fn prepare_manifest_samples(
    manifest: ParakeetBenchmarkManifest,
) -> Result<Vec<PreparedBenchmarkSample>, String> {
    manifest
        .samples
        .into_iter()
        .map(|sample| {
            let duration_secs = infer_duration_secs(&sample)?;
            let audio = load_audio_samples(&sample.audio_filepath)?;
            Ok(PreparedBenchmarkSample {
                reference_text: sample.reference_text,
                corpus: sample.corpus,
                language: sample.language,
                duration_secs,
                audio,
            })
        })
        .collect()
}

fn infer_duration_secs(sample: &ParakeetBenchmarkSample) -> Result<f64, String> {
    if let Some(duration_secs) = sample.duration_secs {
        return Ok(duration_secs);
    }
    let reader = hound::WavReader::open(&sample.audio_filepath).map_err(|e| {
        format!(
            "Failed opening audio file {:?} to infer duration. Provide duration_secs for non-WAV assets: {e}",
            sample.audio_filepath
        )
    })?;
    let spec = reader.spec();
    if spec.channels == 0 {
        return Err(format!(
            "Audio file {:?} reported zero channels.",
            sample.audio_filepath
        ));
    }
    Ok(reader.duration() as f64 / spec.channels as f64 / spec.sample_rate as f64)
}

fn load_audio_samples(path: &Path) -> Result<Vec<f32>, String> {
    read_wav_as_f32_16k(path).map_err(|e| {
        format!(
            "Failed loading benchmark audio {:?} as 16 kHz mono WAV: {e}",
            path
        )
    })
}

fn aggregate_corpus_results(
    samples: &[PreparedBenchmarkSample],
    predictions: &[String],
) -> Vec<CorpusBenchmarkResult> {
    let mut corpora = BTreeMap::<String, CorpusAccumulator>::new();
    for (sample, prediction) in samples.iter().zip(predictions.iter()) {
        corpora.entry(sample.corpus.clone()).or_default().add(
            &sample.reference_text,
            prediction,
            sample.duration_secs,
        );
    }
    corpora
        .into_iter()
        .map(|(corpus, accumulator)| accumulator.into_result(corpus))
        .collect()
}

fn measure_process_rss(pid: u32, wait: Duration) -> Result<u64, String> {
    thread::sleep(wait);
    let pid = Pid::from_u32(pid);
    let mut system = System::new();
    system.refresh_process_specifics(pid, ProcessRefreshKind::new().with_memory());
    system
        .process(pid)
        .map(|process| process.memory())
        .ok_or_else(|| {
            format!("Benchmark worker process {pid} exited before RSS could be sampled.")
        })
}

struct ProcessMonitor {
    stop_flag: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<Result<ProcessMetricSummary, String>>>,
}

impl ProcessMonitor {
    fn spawn(pid: u32, poll_interval: Duration) -> Self {
        let stop_flag = Arc::new(AtomicBool::new(false));
        let thread_stop_flag = Arc::clone(&stop_flag);
        let handle = thread::spawn(move || {
            let pid = Pid::from_u32(pid);
            let mut system = System::new();
            let interval = poll_interval.max(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);

            system
                .refresh_process_specifics(pid, ProcessRefreshKind::new().with_cpu().with_memory());
            thread::sleep(interval);

            let mut total_cpu = 0.0_f64;
            let mut samples = 0_u64;
            let mut peak_rss_bytes = 0_u64;

            loop {
                system.refresh_process_specifics(
                    pid,
                    ProcessRefreshKind::new().with_cpu().with_memory(),
                );
                match system.process(pid) {
                    Some(process) => {
                        total_cpu += f64::from(process.cpu_usage());
                        peak_rss_bytes = peak_rss_bytes.max(process.memory());
                        samples += 1;
                    }
                    None => break,
                }
                if thread_stop_flag.load(Ordering::Relaxed) {
                    break;
                }
                thread::sleep(interval);
            }

            Ok(ProcessMetricSummary {
                average_cpu_percent: if samples == 0 {
                    0.0
                } else {
                    (total_cpu / samples as f64) as f32
                },
                peak_rss_bytes,
            })
        });
        Self {
            stop_flag,
            handle: Some(handle),
        }
    }

    fn stop(mut self) -> Result<ProcessMetricSummary, String> {
        self.stop_flag.store(true, Ordering::Relaxed);
        self.handle
            .take()
            .ok_or_else(|| "Process monitor handle missing.".to_string())?
            .join()
            .map_err(|_| "Process monitor thread panicked.".to_string())?
    }
}

fn normalized_words(text: &str) -> Vec<String> {
    let mut current = String::new();
    let mut words = Vec::new();
    for ch in text.chars() {
        if ch.is_alphanumeric() || ch == '\'' {
            current.extend(ch.to_lowercase());
        } else if !current.is_empty() {
            words.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        words.push(current);
    }
    words
}

fn levenshtein_distance(reference: &[String], hypothesis: &[String]) -> usize {
    if reference.is_empty() {
        return hypothesis.len();
    }
    if hypothesis.is_empty() {
        return reference.len();
    }

    let mut prev: Vec<usize> = (0..=hypothesis.len()).collect();
    let mut curr = vec![0; hypothesis.len() + 1];

    for (i, reference_word) in reference.iter().enumerate() {
        curr[0] = i + 1;
        for (j, hypothesis_word) in hypothesis.iter().enumerate() {
            let substitution_cost = usize::from(reference_word != hypothesis_word);
            curr[j + 1] = (curr[j] + 1)
                .min(prev[j + 1] + 1)
                .min(prev[j] + substitution_cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }

    prev[hypothesis.len()]
}

#[cfg(test)]
mod tests {
    use super::*;
    use hound::{SampleFormat, WavSpec, WavWriter};
    use tempfile::tempdir;

    #[test]
    fn manifest_loader_supports_json_array() {
        let dir = tempdir().unwrap();
        let manifest_path = dir.path().join("samples.json");
        fs::write(
            &manifest_path,
            r#"[{"audioFilepath":"clip.wav","referenceText":"hello world","corpus":"ami"}]"#,
        )
        .unwrap();

        let manifest = load_benchmark_manifest(&manifest_path).unwrap();
        assert_eq!(manifest.samples.len(), 1);
        assert_eq!(manifest.samples[0].corpus, "ami");
    }

    #[test]
    fn manifest_loader_supports_jsonl() {
        let dir = tempdir().unwrap();
        let manifest_path = dir.path().join("samples.jsonl");
        fs::write(
            &manifest_path,
            "{\"audioFilepath\":\"a.wav\",\"referenceText\":\"one\",\"corpus\":\"ami\"}\n{\"audioFilepath\":\"b.wav\",\"referenceText\":\"two\",\"corpus\":\"tedlium\"}\n",
        )
        .unwrap();

        let manifest = load_benchmark_manifest(&manifest_path).unwrap();
        assert_eq!(manifest.samples.len(), 2);
        assert_eq!(manifest.samples[1].corpus, "tedlium");
    }

    #[test]
    fn levenshtein_word_distance_matches_expected_wer_inputs() {
        let reference = normalized_words("hello brave new world");
        let hypothesis = normalized_words("hello new world");
        assert_eq!(levenshtein_distance(&reference, &hypothesis), 1);
    }

    #[test]
    fn corpus_aggregation_tracks_duration_and_word_error_rate() {
        let samples = vec![
            PreparedBenchmarkSample {
                reference_text: "hello world".into(),
                corpus: "ami".into(),
                language: Some("en".into()),
                duration_secs: 1.0,
                audio: vec![0.0; 16_000],
            },
            PreparedBenchmarkSample {
                reference_text: "general kenobi".into(),
                corpus: "ami".into(),
                language: Some("en".into()),
                duration_secs: 2.0,
                audio: vec![0.0; 32_000],
            },
        ];
        let predictions = vec!["hello world".into(), "general".into()];

        let results = aggregate_corpus_results(&samples, &predictions);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].corpus, "ami");
        assert_eq!(results[0].samples, 2);
        assert!((results[0].total_audio_seconds - 3.0).abs() < f64::EPSILON);
        assert!((results[0].word_error_rate - 0.25).abs() < f64::EPSILON);
    }

    #[test]
    fn default_models_keep_multilingual_baseline_first() {
        assert_eq!(
            default_benchmark_models(),
            vec![
                "nvidia/parakeet-tdt-0.6b-v3",
                "nvidia/parakeet-tdt_ctc-1.1b",
                "nvidia/parakeet-ctc-0.6b",
            ]
        );
    }

    #[test]
    fn benchmark_loader_accepts_non_16khz_wav() {
        let dir = tempdir().unwrap();
        let wav_path = dir.path().join("resample.wav");
        let spec = WavSpec {
            channels: 1,
            sample_rate: 8_000,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };
        let mut writer = WavWriter::create(&wav_path, spec).unwrap();
        for value in [0_i16, 10_000, -10_000, 5_000] {
            writer.write_sample(value).unwrap();
        }
        writer.finalize().unwrap();

        let samples = load_audio_samples(&wav_path).unwrap();
        assert_eq!(samples.len(), 8);
    }
}
