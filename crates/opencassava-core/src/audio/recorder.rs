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
}
