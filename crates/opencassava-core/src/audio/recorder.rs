use hound::{SampleFormat, WavSpec, WavWriter};
use std::io::BufWriter;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

const WAV_SPEC: WavSpec = WavSpec {
    channels: 1,
    sample_rate: 16_000,
    bits_per_sample: 32,
    sample_format: SampleFormat::Float,
};

pub struct RecordingFiles {
    pub mic_path: PathBuf,
    pub sys_path: PathBuf,
}

pub struct AudioRecorder {
    mic_writer: Mutex<Option<WavWriter<BufWriter<std::fs::File>>>>,
    sys_writer: Mutex<Option<WavWriter<BufWriter<std::fs::File>>>>,
    pub mic_path: PathBuf,
    pub sys_path: PathBuf,
    disabled: AtomicBool,
}

impl AudioRecorder {
    pub fn new(session_id: &str) -> Result<Self, String> {
        let tmp = std::env::temp_dir();
        let mic_path = tmp.join(format!("{}_mic.wav", session_id));
        let sys_path = tmp.join(format!("{}_sys.wav", session_id));

        let mic_writer = WavWriter::create(&mic_path, WAV_SPEC).map_err(|e| e.to_string())?;
        let sys_writer = WavWriter::create(&sys_path, WAV_SPEC).map_err(|e| e.to_string())?;

        Ok(Self {
            mic_writer: Mutex::new(Some(mic_writer)),
            sys_writer: Mutex::new(Some(sys_writer)),
            mic_path,
            sys_path,
            disabled: AtomicBool::new(false),
        })
    }

    /// Finalizes both WAV headers and returns the temp file paths.
    pub fn finish(&self) -> Result<RecordingFiles, String> {
        let mic = self.mic_writer.lock().unwrap().take();
        if let Some(w) = mic {
            w.finalize().map_err(|e| e.to_string())?;
        }
        let sys = self.sys_writer.lock().unwrap().take();
        if let Some(w) = sys {
            w.finalize().map_err(|e| e.to_string())?;
        }
        Ok(RecordingFiles {
            mic_path: self.mic_path.clone(),
            sys_path: self.sys_path.clone(),
        })
    }

    /// Write a chunk of mic samples to the temp WAV file.
    /// Logs and disables the recorder on write error.
    pub fn append_mic(&self, samples: &[f32]) {
        if self.disabled.load(Ordering::Relaxed) {
            return;
        }
        let mut guard = self.mic_writer.lock().unwrap();
        if let Some(ref mut w) = *guard {
            for &s in samples {
                if w.write_sample(s).is_err() {
                    log::warn!("AudioRecorder: mic write error, disabling recorder");
                    self.disabled.store(true, Ordering::Relaxed);
                    return;
                }
            }
        }
    }

    /// Write a chunk of system audio samples to the temp WAV file.
    /// Logs and disables the recorder on write error.
    pub fn append_sys(&self, samples: &[f32]) {
        if self.disabled.load(Ordering::Relaxed) {
            return;
        }
        let mut guard = self.sys_writer.lock().unwrap();
        if let Some(ref mut w) = *guard {
            for &s in samples {
                if w.write_sample(s).is_err() {
                    log::warn!("AudioRecorder: sys write error, disabling recorder");
                    self.disabled.store(true, Ordering::Relaxed);
                    return;
                }
            }
        }
    }

    /// Mix two mono 16kHz WAV files by averaging samples.
    /// If one file is shorter it is zero-padded to match the longer one.
    pub fn merge(mic: &std::path::Path, sys: &std::path::Path, out: &std::path::Path) -> Result<(), String> {
        let mut mic_r = hound::WavReader::open(mic).map_err(|e| e.to_string())?;
        let mut sys_r = hound::WavReader::open(sys).map_err(|e| e.to_string())?;

        let mic_samples: Vec<f32> = mic_r.samples::<f32>()
            .map(|s| s.unwrap_or(0.0))
            .collect();
        let sys_samples: Vec<f32> = sys_r.samples::<f32>()
            .map(|s| s.unwrap_or(0.0))
            .collect();

        let len = mic_samples.len().max(sys_samples.len());
        let mut writer = hound::WavWriter::create(out, WAV_SPEC).map_err(|e| e.to_string())?;
        for i in 0..len {
            let m = mic_samples.get(i).copied().unwrap_or(0.0);
            let s = sys_samples.get(i).copied().unwrap_or(0.0);
            let mixed = ((m + s) / 2.0).clamp(-1.0, 1.0);
            writer.write_sample(mixed).map_err(|e| e.to_string())?;
        }
        writer.finalize().map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// Read a WAV file and return its samples normalised to f32 at 16 kHz mono.
///
/// Handles:
/// - 16-bit, 24-bit, and 32-bit integer PCM
/// - 32-bit IEEE float
/// - Any number of channels (mixed down to mono by averaging)
/// - Any sample rate (linearly resampled to 16 kHz)
pub fn read_wav_as_f32_16k(path: &std::path::Path) -> Result<Vec<f32>, String> {
    let mut reader = hound::WavReader::open(path).map_err(|e| e.to_string())?;
    let spec = reader.spec();

    // Decode every sample to f32 in [-1.0, 1.0]
    let raw: Vec<f32> = match (spec.sample_format, spec.bits_per_sample) {
        (hound::SampleFormat::Float, 32) => {
            reader.samples::<f32>().map(|s| s.unwrap_or(0.0)).collect()
        }
        (hound::SampleFormat::Int, 16) => reader
            .samples::<i16>()
            .map(|s| s.unwrap_or(0) as f32 / 32_768.0)
            .collect(),
        (hound::SampleFormat::Int, bits @ (24 | 32)) => {
            let scale = if bits == 24 { 8_388_608.0f32 } else { 2_147_483_648.0f32 };
            reader
                .samples::<i32>()
                .map(|s| s.unwrap_or(0) as f32 / scale)
                .collect()
        }
        (fmt, bits) => {
            return Err(format!("Unsupported WAV format: {fmt:?} {bits}-bit"));
        }
    };

    // Mix down to mono
    let channels = spec.channels as usize;
    let mono: Vec<f32> = if channels == 1 {
        raw
    } else {
        raw.chunks(channels)
            .map(|ch| ch.iter().sum::<f32>() / channels as f32)
            .collect()
    };

    // Resample to 16 kHz
    if spec.sample_rate == 16_000 {
        Ok(mono)
    } else {
        Ok(resample_linear(&mono, spec.sample_rate, 16_000))
    }
}

/// Linear interpolation resampler.
fn resample_linear(samples: &[f32], from_hz: u32, to_hz: u32) -> Vec<f32> {
    if samples.is_empty() || from_hz == to_hz {
        return samples.to_vec();
    }
    let ratio = from_hz as f64 / to_hz as f64;
    let out_len = (samples.len() as f64 / ratio).ceil() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src_pos = i as f64 * ratio;
        let src_i = src_pos as usize;
        let frac = (src_pos - src_i as f64) as f32;
        let a = samples.get(src_i).copied().unwrap_or(0.0);
        let b = samples.get(src_i + 1).copied().unwrap_or(a);
        out.push(a + (b - a) * frac);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_recorder_creates_and_finalizes_wav_files() {
        let session_id = "test_sess_001";
        let rec = AudioRecorder::new(session_id).unwrap();

        let files = rec.finish().unwrap();

        assert!(files.mic_path.exists(), "mic WAV should exist");
        assert!(files.sys_path.exists(), "sys WAV should exist");

        let mic_r = hound::WavReader::open(&files.mic_path).unwrap();
        assert_eq!(mic_r.spec().sample_rate, 16_000);
        assert_eq!(mic_r.spec().channels, 1);
        assert_eq!(mic_r.spec().bits_per_sample, 32);
        assert_eq!(mic_r.len(), 0);

        let _ = std::fs::remove_file(&files.mic_path);
        let _ = std::fs::remove_file(&files.sys_path);
    }

    #[test]
    fn test_append_writes_samples_to_wav() {
        let rec = AudioRecorder::new("test_append_001").unwrap();

        rec.append_mic(&[0.1f32, 0.2, 0.3]);
        rec.append_sys(&[0.4f32, 0.5]);

        let files = rec.finish().unwrap();

        let mut mic_r = hound::WavReader::open(&files.mic_path).unwrap();
        let mic_samples: Vec<f32> = mic_r.samples::<f32>().map(|s| s.unwrap()).collect();
        assert_eq!(mic_samples.len(), 3);
        assert!((mic_samples[0] - 0.1).abs() < 1e-5);

        let mut sys_r = hound::WavReader::open(&files.sys_path).unwrap();
        let sys_samples: Vec<f32> = sys_r.samples::<f32>().map(|s| s.unwrap()).collect();
        assert_eq!(sys_samples.len(), 2);
        assert!((sys_samples[1] - 0.5).abs() < 1e-5);

        let _ = std::fs::remove_file(&files.mic_path);
        let _ = std::fs::remove_file(&files.sys_path);
    }

    #[test]
    fn test_merge_averages_samples() {
        let tmp = std::env::temp_dir();
        let mic_p = tmp.join("merge_avg_mic.wav");
        let sys_p = tmp.join("merge_avg_sys.wav");
        let out_p = tmp.join("merge_avg_out.wav");

        let mut mw = hound::WavWriter::create(&mic_p, WAV_SPEC).unwrap();
        mw.write_sample(0.4f32).unwrap();
        mw.write_sample(0.8f32).unwrap();
        mw.finalize().unwrap();

        let mut sw = hound::WavWriter::create(&sys_p, WAV_SPEC).unwrap();
        sw.write_sample(0.2f32).unwrap();
        sw.write_sample(0.4f32).unwrap();
        sw.finalize().unwrap();

        AudioRecorder::merge(&mic_p, &sys_p, &out_p).unwrap();

        let mut out_r = hound::WavReader::open(&out_p).unwrap();
        let samples: Vec<f32> = out_r.samples::<f32>().map(|s| s.unwrap()).collect();
        assert_eq!(samples.len(), 2);
        assert!((samples[0] - 0.3).abs() < 1e-5, "expected 0.3, got {}", samples[0]);
        assert!((samples[1] - 0.6).abs() < 1e-5, "expected 0.6, got {}", samples[1]);

        let _ = std::fs::remove_file(mic_p);
        let _ = std::fs::remove_file(sys_p);
        let _ = std::fs::remove_file(out_p);
    }

    #[test]
    fn test_merge_zero_pads_shorter_channel() {
        let tmp = std::env::temp_dir();
        let mic_p = tmp.join("merge_pad_mic.wav");
        let sys_p = tmp.join("merge_pad_sys.wav");
        let out_p = tmp.join("merge_pad_out.wav");

        let mut mw = hound::WavWriter::create(&mic_p, WAV_SPEC).unwrap();
        mw.write_sample(0.8f32).unwrap();
        mw.write_sample(0.6f32).unwrap();
        mw.finalize().unwrap();

        let mut sw = hound::WavWriter::create(&sys_p, WAV_SPEC).unwrap();
        sw.write_sample(0.4f32).unwrap();
        // sys is one sample shorter
        sw.finalize().unwrap();

        AudioRecorder::merge(&mic_p, &sys_p, &out_p).unwrap();

        let mut out_r = hound::WavReader::open(&out_p).unwrap();
        let samples: Vec<f32> = out_r.samples::<f32>().map(|s| s.unwrap()).collect();
        assert_eq!(samples.len(), 2);
        assert!((samples[0] - 0.6).abs() < 1e-5); // (0.8 + 0.4) / 2
        assert!((samples[1] - 0.3).abs() < 1e-5); // (0.6 + 0.0) / 2

        let _ = std::fs::remove_file(mic_p);
        let _ = std::fs::remove_file(sys_p);
        let _ = std::fs::remove_file(out_p);
    }

    #[test]
    fn test_read_wav_as_f32_16k_passthrough() {
        // Native 16 kHz mono float32 — no resampling or conversion needed
        let tmp = std::env::temp_dir();
        let p = tmp.join("import_native.wav");
        let mut w = hound::WavWriter::create(&p, WAV_SPEC).unwrap();
        w.write_sample(0.5f32).unwrap();
        w.write_sample(-0.5f32).unwrap();
        w.finalize().unwrap();

        let samples = read_wav_as_f32_16k(&p).unwrap();
        assert_eq!(samples.len(), 2);
        assert!((samples[0] - 0.5).abs() < 1e-5);
        assert!((samples[1] + 0.5).abs() < 1e-5);
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn test_read_wav_as_f32_16k_i16_conversion() {
        let tmp = std::env::temp_dir();
        let p = tmp.join("import_i16.wav");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(&p, spec).unwrap();
        w.write_sample(16_384i16).unwrap(); // 0.5 of i16 range
        w.finalize().unwrap();

        let samples = read_wav_as_f32_16k(&p).unwrap();
        assert_eq!(samples.len(), 1);
        assert!((samples[0] - 0.5).abs() < 1e-3);
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn test_read_wav_as_f32_16k_stereo_mixdown() {
        let tmp = std::env::temp_dir();
        let p = tmp.join("import_stereo.wav");
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 16_000,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let mut w = hound::WavWriter::create(&p, spec).unwrap();
        // Frame 0: L=1.0, R=0.0 → mono average = 0.5
        w.write_sample(1.0f32).unwrap();
        w.write_sample(0.0f32).unwrap();
        w.finalize().unwrap();

        let samples = read_wav_as_f32_16k(&p).unwrap();
        assert_eq!(samples.len(), 1);
        assert!((samples[0] - 0.5).abs() < 1e-5);
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn test_resample_linear_doubles_length() {
        // Resample from 8 kHz to 16 kHz — should approximately double sample count
        let input: Vec<f32> = (0..8).map(|i| i as f32 / 8.0).collect();
        let out = resample_linear(&input, 8_000, 16_000);
        // out_len = ceil(8 / 0.5) = 16
        assert_eq!(out.len(), 16);
        // First and middle values should match input at those positions
        assert!((out[0] - 0.0).abs() < 1e-5);
    }
}
