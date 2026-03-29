use hound::{SampleFormat, WavSpec, WavWriter};
use std::io::BufWriter;
use std::path::PathBuf;
use std::sync::Mutex;

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
}

// WavWriter is !Send because it holds a raw file handle; we access it only
// through the inner Mutex which ensures exclusive access across tasks.
unsafe impl Send for AudioRecorder {}
unsafe impl Sync for AudioRecorder {}

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
    /// Silently drops the chunk if the writer has been finalized or on error.
    pub fn append_mic(&self, samples: &[f32]) {
        let mut guard = self.mic_writer.lock().unwrap();
        if let Some(ref mut w) = *guard {
            for &s in samples {
                if w.write_sample(s).is_err() {
                    drop(guard);
                    return;
                }
            }
        }
    }

    /// Write a chunk of system audio samples to the temp WAV file.
    pub fn append_sys(&self, samples: &[f32]) {
        let mut guard = self.sys_writer.lock().unwrap();
        if let Some(ref mut w) = *guard {
            for &s in samples {
                if w.write_sample(s).is_err() {
                    drop(guard);
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
}
