use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

const SAMPLE_RATE: usize = 16_000;
const DEFAULT_REFERENCE_WINDOW_MS: usize = 3_000;
const DEFAULT_MAX_DELAY_MS: usize = 160;
const DEFAULT_FILTER_LEN: usize = 96;
const CORRELATION_STRIDE: usize = 4;
const MIN_RENDER_RMS: f32 = 0.008;
const MIN_CORRELATION: f32 = 0.12;

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let mean_sq = samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32;
    mean_sq.sqrt()
}

#[derive(Clone)]
pub struct EchoReferenceBuffer {
    inner: Arc<Mutex<VecDeque<f32>>>,
    capacity: usize,
}

impl EchoReferenceBuffer {
    pub fn new(window_ms: usize) -> Self {
        let capacity = SAMPLE_RATE * window_ms / 1_000;
        Self {
            inner: Arc::new(Mutex::new(VecDeque::with_capacity(capacity))),
            capacity: capacity.max(SAMPLE_RATE / 2),
        }
    }

    pub fn default_window() -> Self {
        Self::new(DEFAULT_REFERENCE_WINDOW_MS)
    }

    pub fn push_render_chunk(&self, samples: &[f32]) {
        if samples.is_empty() {
            return;
        }
        let mut inner = self.inner.lock().unwrap();
        for &sample in samples {
            if inner.len() == self.capacity {
                inner.pop_front();
            }
            inner.push_back(sample);
        }
    }

    fn best_match(&self, mic: &[f32], max_delay_samples: usize) -> Option<AlignedRender> {
        if mic.is_empty() {
            return None;
        }

        let mut inner = self.inner.lock().unwrap();
        if inner.len() < mic.len() {
            return None;
        }
        let available = inner.make_contiguous();
        let newest_start = available.len().saturating_sub(mic.len());
        let max_delay = max_delay_samples.min(newest_start);

        let mut best_score = f32::MIN;
        let mut best_start = newest_start;

        for delay in (0..=max_delay).step_by(CORRELATION_STRIDE.max(1)) {
            let start = newest_start - delay;
            let end = start + mic.len();
            let slice = &available[start..end];
            let score = normalized_correlation(mic, slice);
            if score > best_score {
                best_score = score;
                best_start = start;
            }
        }

        let samples = available[best_start..best_start + mic.len()].to_vec();
        Some(AlignedRender {
            samples,
            correlation: best_score.max(-1.0),
            render_rms: rms(&available[best_start..best_start + mic.len()]),
        })
    }
}

impl Default for EchoReferenceBuffer {
    fn default() -> Self {
        Self::default_window()
    }
}

struct AlignedRender {
    samples: Vec<f32>,
    correlation: f32,
    render_rms: f32,
}

fn normalized_correlation(a: &[f32], b: &[f32]) -> f32 {
    let mut dot = 0.0;
    let mut aa = 0.0;
    let mut bb = 0.0;

    for (&x, &y) in a.iter().zip(b.iter()).step_by(CORRELATION_STRIDE) {
        dot += x * y;
        aa += x * x;
        bb += y * y;
    }

    if aa <= 1e-6 || bb <= 1e-6 {
        return 0.0;
    }

    dot / (aa.sqrt() * bb.sqrt())
}

struct NlmsEchoCanceller {
    coeffs: Vec<f32>,
    history: Vec<f32>,
    pos: usize,
    mu: f32,
}

impl NlmsEchoCanceller {
    fn new(filter_len: usize, mu: f32) -> Self {
        Self {
            coeffs: vec![0.0; filter_len],
            history: vec![0.0; filter_len],
            pos: 0,
            mu,
        }
    }

    fn process(&mut self, mic: &[f32], render: &[f32]) -> Vec<f32> {
        let mut out = Vec::with_capacity(mic.len());

        for (&mic_sample, &render_sample) in mic.iter().zip(render.iter()) {
            self.history[self.pos] = render_sample;
            self.pos = (self.pos + 1) % self.history.len();

            let mut estimated = 0.0;
            let mut norm = 1e-4;
            for i in 0..self.coeffs.len() {
                let idx = (self.pos + self.history.len() - 1 - i) % self.history.len();
                let x = self.history[idx];
                estimated += self.coeffs[i] * x;
                norm += x * x;
            }

            let error = mic_sample - estimated;
            let step = self.mu * error / norm;
            for i in 0..self.coeffs.len() {
                let idx = (self.pos + self.history.len() - 1 - i) % self.history.len();
                self.coeffs[i] += step * self.history[idx];
            }

            out.push(error.clamp(-1.0, 1.0));
        }

        out
    }
}

pub struct MicEchoProcessor {
    reference: EchoReferenceBuffer,
    canceller: NlmsEchoCanceller,
    max_delay_samples: usize,
    enabled: bool,
}

impl MicEchoProcessor {
    pub fn new(reference: EchoReferenceBuffer) -> Self {
        Self {
            reference,
            canceller: NlmsEchoCanceller::new(DEFAULT_FILTER_LEN, 0.18),
            max_delay_samples: SAMPLE_RATE * DEFAULT_MAX_DELAY_MS / 1_000,
            enabled: true,
        }
    }

    #[cfg(test)]
    fn with_max_delay_samples(mut self, max_delay_samples: usize) -> Self {
        self.max_delay_samples = max_delay_samples;
        self
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    pub fn process_chunk(&mut self, mic: &[f32]) -> Vec<f32> {
        if !self.enabled || mic.is_empty() {
            return mic.to_vec();
        }

        let Some(reference) = self.reference.best_match(mic, self.max_delay_samples) else {
            return mic.to_vec();
        };

        if reference.render_rms < MIN_RENDER_RMS || reference.correlation < MIN_CORRELATION {
            return mic.to_vec();
        }

        let mut cleaned = self.canceller.process(mic, &reference.samples);
        let mic_rms = rms(mic);
        let cleaned_rms = rms(&cleaned);

        // Guard against residual speaker bleed when the mic mostly mirrors the render path.
        if reference.correlation > 0.55 && reference.render_rms > MIN_RENDER_RMS {
            if mic_rms <= reference.render_rms * 1.45 && cleaned_rms > reference.render_rms * 0.32 {
                for sample in &mut cleaned {
                    *sample *= 0.18;
                }
            } else if cleaned_rms > mic_rms * 0.92 && reference.render_rms >= mic_rms * 0.65 {
                for sample in &mut cleaned {
                    *sample *= 0.45;
                }
            }
        }

        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn energy(samples: &[f32]) -> f32 {
        samples.iter().map(|s| s * s).sum::<f32>() / samples.len().max(1) as f32
    }

    #[test]
    fn reference_buffer_keeps_only_recent_samples() {
        let reference = EchoReferenceBuffer::new(100);
        reference.push_render_chunk(&vec![1.0; 2_000]);
        let inner = reference.inner.lock().unwrap();
        assert!(inner.len() <= reference.capacity);
        assert_eq!(inner.back().copied(), Some(1.0));
    }

    #[test]
    fn best_match_prefers_delayed_reference() {
        let reference = EchoReferenceBuffer::new(500);
        let lead = vec![0.0; 80];
        let signal: Vec<f32> = (0..320).map(|i| ((i as f32) * 0.07).sin()).collect();
        reference.push_render_chunk(&lead);
        reference.push_render_chunk(&signal);

        let mut mic = vec![0.0; 80];
        mic.extend_from_slice(&signal);
        let mic = &mic[80..];

        let aligned = reference.best_match(mic, 160).unwrap();
        assert!(aligned.correlation > 0.9);
    }

    #[test]
    fn echo_processor_reduces_pure_echo_energy() {
        let reference = EchoReferenceBuffer::new(1_000);
        let mut processor = MicEchoProcessor::new(reference.clone()).with_max_delay_samples(160);

        let render: Vec<f32> = (0..8_000)
            .map(|i| ((i as f32) * 0.03).sin() * 0.35)
            .collect();

        let delay = 64;
        let mut mic = vec![0.0; delay];
        mic.extend(render.iter().copied());
        mic.truncate(render.len());

        let mut raw_energy = 0.0;
        let mut cleaned_energy = 0.0;

        for (render_chunk, mic_chunk) in render.chunks(160).zip(mic.chunks(160)) {
            reference.push_render_chunk(render_chunk);
            let cleaned = processor.process_chunk(mic_chunk);
            raw_energy += energy(mic_chunk);
            cleaned_energy += energy(&cleaned);
        }

        assert!(cleaned_energy < raw_energy * 0.55);
    }

    #[test]
    fn echo_processor_preserves_local_speech_when_not_correlated() {
        let reference = EchoReferenceBuffer::new(1_000);
        let mut processor = MicEchoProcessor::new(reference.clone());
        let render = vec![0.0; 320];
        reference.push_render_chunk(&render);

        let mic: Vec<f32> = (0..320).map(|i| ((i as f32) * 0.11).sin() * 0.3).collect();
        let cleaned = processor.process_chunk(&mic);
        let ratio = energy(&cleaned) / energy(&mic);
        assert!(ratio > 0.8);
    }
}
