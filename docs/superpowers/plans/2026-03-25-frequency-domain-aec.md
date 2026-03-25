# Frequency-Domain AEC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the NLMS echo canceller with a partitioned block frequency-domain adaptive filter (PBFDAF) for dramatically better acoustic echo suppression.

**Architecture:** Single file replacement — `echo_cancel.rs` is rewritten with `FreqDomainAec` replacing `NlmsEchoCanceller`. Public API (`EchoReferenceBuffer`, `MicEchoProcessor`) unchanged. New dependency on `realfft` crate for FFT.

**Tech Stack:** Rust, `realfft` (pure Rust FFT via `rustfft`), `num-complex`

**Spec:** `docs/superpowers/specs/2026-03-25-frequency-domain-aec-design.md`

---

### Task 1: Add `realfft` and `num-complex` dependencies

**Files:**
- Modify: `crates/opencassava-core/Cargo.toml`

- [ ] **Step 1: Add dependencies**

Add to `[dependencies]` in `crates/opencassava-core/Cargo.toml`:

```toml
realfft = "3"
num-complex = "0.4"
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo check -p opencassava-core`
Expected: compiles without errors

- [ ] **Step 3: Commit**

```bash
git add crates/opencassava-core/Cargo.toml Cargo.lock
git commit -m "chore: add realfft and num-complex dependencies for frequency-domain AEC"
```

---

### Task 2: Write `FreqDomainAec` with pure echo cancellation test (TDD)

**Files:**
- Modify: `crates/opencassava-core/src/audio/echo_cancel.rs`

This task implements the core PBFDAF algorithm and validates it can cancel a pure echo.

- [ ] **Step 1: Write the failing test**

Replace the entire `#[cfg(test)] mod tests` block in `echo_cancel.rs` with the new tests. Keep the `energy` helper. Write only this first test:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn energy(samples: &[f32]) -> f32 {
        samples.iter().map(|s| s * s).sum::<f32>() / samples.len().max(1) as f32
    }

    #[test]
    fn freq_domain_aec_cancels_pure_echo() {
        // 4 seconds of white noise at 16kHz
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let render: Vec<f32> = (0..64_000).map(|i| {
            let mut h = DefaultHasher::new();
            i.hash(&mut h);
            (h.finish() as f32 / u64::MAX as f32) * 2.0 - 1.0
        }).collect();

        let delay = 80; // 5ms delay
        let mut mic = vec![0.0f32; delay];
        mic.extend(render.iter().map(|&s| s * 0.6)); // echo at 60% amplitude
        mic.truncate(render.len());

        let reference = EchoReferenceBuffer::new(1_000);
        let mut processor = MicEchoProcessor::new(reference.clone());

        let chunk_size = 480;
        let mut all_cleaned = Vec::new();

        for (render_chunk, mic_chunk) in render.chunks(chunk_size).zip(mic.chunks(chunk_size)) {
            reference.push_render_chunk(render_chunk);
            let cleaned = processor.process_chunk(mic_chunk);
            assert_eq!(cleaned.len(), mic_chunk.len(), "output length must match input");
            all_cleaned.extend_from_slice(&cleaned);
        }

        // Measure energy over the last 2 seconds (after convergence)
        let tail_start = 32_000;
        let raw_tail_energy = energy(&mic[tail_start..]);
        let cleaned_tail_energy = energy(&all_cleaned[tail_start..]);
        let ratio = cleaned_tail_energy / raw_tail_energy;
        assert!(ratio < 0.15, "cleaned energy should be < 15% of raw, got {:.2}%", ratio * 100.0);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p opencassava-core freq_domain_aec_cancels_pure_echo -- --nocapture`
Expected: FAIL (the old NLMS code won't achieve < 15% on white noise with these parameters, or the test structure won't match the new code)

- [ ] **Step 3: Implement `FreqDomainAec`**

Replace the entire contents of `echo_cancel.rs` with the new implementation. Key structure:

```rust
use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use num_complex::Complex32;
use realfft::{RealFftPlanner, RealToComplex, ComplexToReal};

const SAMPLE_RATE: usize = 16_000;
const DEFAULT_REFERENCE_WINDOW_MS: usize = 1_000;
const MIN_RENDER_RMS: f32 = 0.008;

// PBFDAF parameters
const BLOCK_SIZE: usize = 256;       // N = 256 samples (16ms)
const FFT_SIZE: usize = 512;         // 2N for overlap-save
const NUM_PARTITIONS: usize = 16;    // covers 256ms impulse response
const SPEC_SIZE: usize = FFT_SIZE / 2 + 1; // 257 complex bins
const MU: f32 = 0.3;                 // adaptation step size
const POWER_SMOOTH: f32 = 0.9;       // exponential smoothing for power estimate
const LEAKAGE: f32 = 0.03;           // post-filter residual echo estimate
const POST_ALPHA: f32 = 2.0;         // post-filter oversubtraction
const POST_FLOOR: f32 = 0.1;         // post-filter minimum gain
const SILENCE_DECAY_BLOCKS: usize = 50; // blocks of silence before filter decay
const DTD_FREEZE: f32 = 10.0;        // mic/ref power ratio to freeze adaptation
const DTD_FULL: f32 = 0.1;           // mic/ref power ratio for full adaptation
const DTD_CAUTIOUS_SCALE: f32 = 0.2; // mu multiplier during double-talk
const REF_POWER_EPSILON: f32 = 1e-8; // silence threshold per bin

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() { return 0.0; }
    let mean_sq = samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32;
    mean_sq.sqrt()
}

#[derive(Clone)]
pub struct EchoReferenceBuffer {
    inner: Arc<Mutex<VecDeque<f32>>>,
    capacity: usize,
    /// Total number of samples pushed since creation (monotonically increasing).
    /// Used by MicEchoProcessor to track consumption offset safely even when
    /// the ring buffer wraps.
    total_pushed: Arc<AtomicUsize>,
}

impl EchoReferenceBuffer {
    pub fn new(window_ms: usize) -> Self {
        let capacity = SAMPLE_RATE * window_ms / 1_000;
        Self {
            inner: Arc::new(Mutex::new(VecDeque::with_capacity(capacity))),
            capacity: capacity.max(SAMPLE_RATE / 2),
            total_pushed: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub fn default_window() -> Self {
        Self::new(DEFAULT_REFERENCE_WINDOW_MS)
    }

    pub fn push_render_chunk(&self, samples: &[f32]) {
        if samples.is_empty() { return; }
        let mut inner = self.inner.lock().unwrap();
        for &sample in samples {
            if inner.len() == self.capacity {
                inner.pop_front();
            }
            inner.push_back(sample);
        }
        self.total_pushed.fetch_add(samples.len(), Ordering::Relaxed);
    }

    /// Total number of samples pushed since creation.
    fn total_pushed(&self) -> usize {
        self.total_pushed.load(Ordering::Relaxed)
    }

    /// Read BLOCK_SIZE samples starting at the given absolute offset.
    /// Returns None if the requested samples have been evicted or are not yet available.
    fn read_block_at(&self, abs_offset: usize) -> Option<Vec<f32>> {
        let inner = self.inner.lock().unwrap();
        let total = self.total_pushed();
        let evicted = total.saturating_sub(inner.len());
        if abs_offset < evicted || abs_offset + BLOCK_SIZE > total {
            return None;
        }
        let local_start = abs_offset - evicted;
        Some(inner.iter().skip(local_start).take(BLOCK_SIZE).copied().collect())
    }
}

impl Default for EchoReferenceBuffer {
    fn default() -> Self { Self::default_window() }
}

struct FreqDomainAec {
    // Filter coefficients: NUM_PARTITIONS x SPEC_SIZE complex weights
    filter: Vec<Vec<Complex32>>,
    // Reference spectrum history (ring buffer of recent reference block spectra)
    ref_spectra: VecDeque<Vec<Complex32>>,
    // Per-bin smoothed power estimate for normalization
    ref_power: Vec<f32>,
    // Previous mic block (for overlap-save framing)
    prev_mic_block: Vec<f32>,
    // Previous reference block (for overlap-save framing)
    prev_ref_block: Vec<f32>,
    // FFT planners (cached)
    fft_forward: Arc<dyn RealToComplex<f32>>,
    fft_inverse: Arc<dyn ComplexToReal<f32>>,
    // Silence counter for filter decay
    silence_blocks: usize,
}

impl FreqDomainAec {
    fn new() -> Self {
        let mut planner = RealFftPlanner::<f32>::new();
        let fft_forward = planner.plan_fft_forward(FFT_SIZE);
        let fft_inverse = planner.plan_fft_inverse(FFT_SIZE);

        let zero_spec = vec![Complex32::new(0.0, 0.0); SPEC_SIZE];

        Self {
            filter: (0..NUM_PARTITIONS).map(|_| zero_spec.clone()).collect(),
            ref_spectra: VecDeque::with_capacity(NUM_PARTITIONS),
            ref_power: vec![1e-4; SPEC_SIZE],
            prev_mic_block: vec![0.0; BLOCK_SIZE],
            prev_ref_block: vec![0.0; BLOCK_SIZE],
            fft_forward,
            fft_inverse,
            silence_blocks: 0,
        }
    }

    /// Process one BLOCK_SIZE block of mic audio given one BLOCK_SIZE block of reference.
    /// Returns BLOCK_SIZE cleaned samples.
    fn process_block(&mut self, mic_block: &[f32], ref_block: &[f32]) -> Vec<f32> {
        debug_assert_eq!(mic_block.len(), BLOCK_SIZE);
        debug_assert_eq!(ref_block.len(), BLOCK_SIZE);

        // Check if reference is silent
        let ref_rms = rms(ref_block);
        if ref_rms < MIN_RENDER_RMS {
            self.silence_blocks += 1;
            if self.silence_blocks > SILENCE_DECAY_BLOCKS {
                // Decay filter coefficients
                for partition in &mut self.filter {
                    for coeff in partition.iter_mut() {
                        *coeff *= 0.9;
                    }
                }
            }
            self.prev_mic_block.copy_from_slice(mic_block);
            self.prev_ref_block.copy_from_slice(ref_block);
            return mic_block.to_vec();
        }
        self.silence_blocks = 0;

        // 1. Build overlap-save frames and FFT
        let mic_spec = self.forward_fft_overlap_save(mic_block, &self.prev_mic_block.clone());
        let ref_spec = self.forward_fft_overlap_save(ref_block, &self.prev_ref_block.clone());

        // Store reference spectrum in history
        self.ref_spectra.push_front(ref_spec.clone());
        if self.ref_spectra.len() > NUM_PARTITIONS {
            self.ref_spectra.pop_back();
        }

        // Update per-bin power estimate (exponential smoothing)
        for k in 0..SPEC_SIZE {
            let power = ref_spec[k].norm_sqr();
            self.ref_power[k] = POWER_SMOOTH * self.ref_power[k] + (1.0 - POWER_SMOOTH) * power;
        }

        // 2. Compute echo estimate: sum over partitions
        let mut echo_est = vec![Complex32::new(0.0, 0.0); SPEC_SIZE];
        let num_active = self.ref_spectra.len().min(NUM_PARTITIONS);
        for p in 0..num_active {
            let x_p = &self.ref_spectra[p];
            let w_p = &self.filter[p];
            for k in 0..SPEC_SIZE {
                echo_est[k] += w_p[k] * x_p[k];
            }
        }

        // 3. Error = mic - echo estimate
        let mut error_spec: Vec<Complex32> = mic_spec.iter()
            .zip(echo_est.iter())
            .map(|(&m, &e)| m - e)
            .collect();

        // 4. Post-filter: residual echo suppression
        for k in 0..SPEC_SIZE {
            let echo_power = LEAKAGE * self.ref_power[k];
            let error_power = error_spec[k].norm_sqr().max(1e-10);
            let gain = (1.0 - POST_ALPHA * echo_power / error_power).max(POST_FLOOR);
            error_spec[k] *= gain;
        }

        // 5. IFFT and extract overlap-save output (last BLOCK_SIZE samples)
        let output = self.inverse_fft_overlap_save(&error_spec);

        // 6. Constrained gradient update
        for p in 0..num_active {
            let x_p = &self.ref_spectra[p];

            // Per-bin double-talk detection and mu scaling
            let mut gradient = vec![Complex32::new(0.0, 0.0); SPEC_SIZE];
            for k in 0..SPEC_SIZE {
                let ref_pow = self.ref_power[k];
                if ref_pow < REF_POWER_EPSILON {
                    continue; // silence in this bin
                }
                let mic_pow = mic_spec[k].norm_sqr();
                let ratio = mic_pow / ref_pow;

                let bin_mu = if ratio > DTD_FREEZE {
                    0.0 // user speaking, freeze
                } else if ratio < DTD_FULL {
                    MU // pure echo, full adaptation
                } else {
                    MU * DTD_CAUTIOUS_SCALE // double-talk, cautious
                };

                if bin_mu > 0.0 {
                    // Unconstrained gradient: E(k) * conj(X_p(k)) / P(k)
                    // Use pre-post-filter error for gradient (not the suppressed error)
                    let err_k = mic_spec[k] - echo_est[k];
                    gradient[k] = err_k * x_p[k].conj() / ref_pow * bin_mu;
                }
            }

            // Constrain: IFFT, zero last half, FFT back
            let constrained = self.constrain_gradient(&gradient);

            // Update filter
            for k in 0..SPEC_SIZE {
                self.filter[p][k] += constrained[k];
            }
        }

        // Save current blocks as previous
        self.prev_mic_block.copy_from_slice(mic_block);
        self.prev_ref_block.copy_from_slice(ref_block);

        output
    }

    fn forward_fft_overlap_save(&self, current: &[f32], previous: &[f32]) -> Vec<Complex32> {
        let mut frame = vec![0.0f32; FFT_SIZE];
        frame[..BLOCK_SIZE].copy_from_slice(previous);
        frame[BLOCK_SIZE..].copy_from_slice(current);
        let mut spectrum = vec![Complex32::new(0.0, 0.0); SPEC_SIZE];
        self.fft_forward.process(&mut frame, &mut spectrum).unwrap();
        spectrum
    }

    fn inverse_fft_overlap_save(&self, spectrum: &[Complex32]) -> Vec<f32> {
        let mut spec = spectrum.to_vec();
        let mut time = vec![0.0f32; FFT_SIZE];
        self.fft_inverse.process(&mut spec, &mut time).unwrap();
        // Normalize (realfft doesn't normalize)
        let norm = 1.0 / FFT_SIZE as f32;
        // Keep last BLOCK_SIZE samples (overlap-save)
        time[BLOCK_SIZE..].iter().map(|&s| (s * norm).clamp(-1.0, 1.0)).collect()
    }

    fn constrain_gradient(&self, gradient: &[Complex32]) -> Vec<Complex32> {
        // IFFT gradient to time domain
        let mut spec = gradient.to_vec();
        let mut time = vec![0.0f32; FFT_SIZE];
        self.fft_inverse.process(&mut spec, &mut time).unwrap();
        let norm = 1.0 / FFT_SIZE as f32;
        for s in time.iter_mut() {
            *s *= norm;
        }
        // Zero out last BLOCK_SIZE samples (keep only first BLOCK_SIZE)
        for s in time[BLOCK_SIZE..].iter_mut() {
            *s = 0.0;
        }
        // FFT back to frequency domain
        let mut constrained_spec = vec![Complex32::new(0.0, 0.0); SPEC_SIZE];
        self.fft_forward.process(&mut time, &mut constrained_spec).unwrap();
        constrained_spec
    }
}

pub struct MicEchoProcessor {
    reference: EchoReferenceBuffer,
    aec: FreqDomainAec,
    enabled: bool,
    // Block accumulation
    mic_accum: Vec<f32>,
    out_accum: VecDeque<f32>,
    // Absolute offset into the reference buffer's total_pushed counter.
    // Tracks which reference samples we've consumed.
    ref_abs_offset: usize,
}

impl MicEchoProcessor {
    pub fn new(reference: EchoReferenceBuffer) -> Self {
        let initial_offset = reference.total_pushed();
        Self {
            reference,
            aec: FreqDomainAec::new(),
            enabled: true,
            mic_accum: Vec::with_capacity(BLOCK_SIZE * 2),
            out_accum: VecDeque::with_capacity(BLOCK_SIZE * 4),
            ref_abs_offset: initial_offset,
        }
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    pub fn process_chunk(&mut self, mic: &[f32]) -> Vec<f32> {
        if !self.enabled || mic.is_empty() {
            return mic.to_vec();
        }

        // Accumulate mic samples
        self.mic_accum.extend_from_slice(mic);

        // Process as many complete blocks as we have
        while self.mic_accum.len() >= BLOCK_SIZE {
            let mic_block: Vec<f32> = self.mic_accum.drain(..BLOCK_SIZE).collect();

            // Read the corresponding reference block using absolute offset
            let ref_block = match self.reference.read_block_at(self.ref_abs_offset) {
                Some(block) => {
                    self.ref_abs_offset += BLOCK_SIZE;
                    block
                }
                None => {
                    // Reference data not available (not yet pushed or evicted).
                    // Pass through unprocessed.
                    self.out_accum.extend(mic_block.iter());
                    // Advance offset to stay in sync
                    self.ref_abs_offset += BLOCK_SIZE;
                    continue;
                }
            };

            let cleaned = self.aec.process_block(&mic_block, &ref_block);
            self.out_accum.extend(cleaned.iter());
        }

        // Drain exactly mic.len() samples from output
        let needed = mic.len();
        if self.out_accum.len() >= needed {
            self.out_accum.drain(..needed).collect()
        } else {
            // Not enough processed output yet; pass through original
            // (happens during initial accumulation before first full block)
            let mut result: Vec<f32> = self.out_accum.drain(..).collect();
            let remaining = needed - result.len();
            // Return the tail of the input as passthrough
            result.extend_from_slice(&mic[mic.len() - remaining..]);
            result
        }
    }
}
```

The above is the complete structure. Write the full file including the `EchoReferenceBuffer` (unchanged public API, with `total_pushed` counter), `FreqDomainAec` (new), and `MicEchoProcessor` (rewritten internals, same public API).

- [ ] **Step 4: Run the pure echo test**

Run: `cargo test -p opencassava-core freq_domain_aec_cancels_pure_echo -- --nocapture`
Expected: PASS — cleaned energy < 15% of raw in the tail

- [ ] **Step 5: Commit**

```bash
git add crates/opencassava-core/src/audio/echo_cancel.rs
git commit -m "feat: replace NLMS with frequency-domain AEC (PBFDAF)"
```

---

### Task 3: Add remaining tests (TDD — tests for existing functionality)

**Files:**
- Modify: `crates/opencassava-core/src/audio/echo_cancel.rs` (test module only)

Add the remaining 6 tests from the spec. Each test validates a specific behavior.

- [ ] **Step 1: Add double-talk preservation test**

```rust
#[test]
fn freq_domain_aec_preserves_speech_during_doubletalk() {
    // Reference: 200Hz sine (simulating remote speaker)
    // Mic: 800Hz sine (simulating local speaker) + attenuated 200Hz echo
    let n = 64_000; // 4 seconds
    let reference = EchoReferenceBuffer::new(1_000);
    let mut processor = MicEchoProcessor::new(reference.clone());

    let render: Vec<f32> = (0..n).map(|i| {
        (2.0 * std::f32::consts::PI * 200.0 * i as f32 / 16_000.0).sin() * 0.5
    }).collect();

    let mic: Vec<f32> = (0..n).map(|i| {
        let local_speech = (2.0 * std::f32::consts::PI * 800.0 * i as f32 / 16_000.0).sin() * 0.4;
        let echo = (2.0 * std::f32::consts::PI * 200.0 * i as f32 / 16_000.0).sin() * 0.3;
        local_speech + echo
    }).collect();

    let chunk_size = 480;
    let mut all_cleaned = Vec::new();

    for (render_chunk, mic_chunk) in render.chunks(chunk_size).zip(mic.chunks(chunk_size)) {
        reference.push_render_chunk(render_chunk);
        let cleaned = processor.process_chunk(mic_chunk);
        all_cleaned.extend_from_slice(&cleaned);
    }

    // Measure 800Hz energy in the cleaned tail (last 2 seconds)
    // The 800Hz component should be mostly preserved
    let tail_start = 32_000;
    let local_only: Vec<f32> = (tail_start..n).map(|i| {
        (2.0 * std::f32::consts::PI * 800.0 * i as f32 / 16_000.0).sin() * 0.4
    }).collect();

    let local_energy = energy(&local_only);
    let cleaned_energy = energy(&all_cleaned[tail_start..]);
    let ratio = cleaned_energy / local_energy;
    assert!(ratio > 0.70, "local speech energy should be > 70% preserved, got {:.2}%", ratio * 100.0);
}
```

- [ ] **Step 2: Add convergence speed test**

```rust
#[test]
fn freq_domain_aec_converges_within_400ms() {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let reference = EchoReferenceBuffer::new(1_000);
    let mut processor = MicEchoProcessor::new(reference.clone());

    // Process blocks and measure when suppression reaches 15dB
    let mut converged_at_block = None;
    let target_ratio = 10.0f32.powf(-15.0 / 10.0); // 15dB = ~0.032

    for block_idx in 0..200 {
        let offset = block_idx * BLOCK_SIZE;
        let render: Vec<f32> = (0..BLOCK_SIZE).map(|i| {
            let mut h = DefaultHasher::new();
            (offset + i).hash(&mut h);
            (h.finish() as f32 / u64::MAX as f32) * 2.0 - 1.0
        }).collect();
        let mic: Vec<f32> = render.iter().map(|&s| s * 0.5).collect();

        reference.push_render_chunk(&render);
        let cleaned = processor.process_chunk(&mic);

        let raw_e = energy(&mic);
        let clean_e = energy(&cleaned);
        if raw_e > 0.0 && clean_e / raw_e < target_ratio && converged_at_block.is_none() {
            converged_at_block = Some(block_idx);
        }
    }

    let block = converged_at_block.expect("filter never converged to 15dB suppression");
    let ms = block * BLOCK_SIZE * 1000 / SAMPLE_RATE;
    assert!(block < 25, "should converge within 25 blocks (400ms), converged at block {} ({}ms)", block, ms);
}
```

- [ ] **Step 3: Add variable chunk size test**

```rust
#[test]
fn freq_domain_aec_handles_variable_chunk_sizes() {
    let reference = EchoReferenceBuffer::new(1_000);
    let mut processor = MicEchoProcessor::new(reference.clone());

    let chunk_sizes = [100, 256, 500, 1000, 37, 480];
    let mut total_in = 0;
    let mut total_out = 0;

    for &size in &chunk_sizes {
        let render = vec![0.1f32; size];
        let mic = vec![0.05f32; size];
        reference.push_render_chunk(&render);
        let cleaned = processor.process_chunk(&mic);
        assert_eq!(cleaned.len(), size, "output length must match input length {}", size);
        total_in += size;
        total_out += cleaned.len();
    }
    assert_eq!(total_in, total_out);
}
```

- [ ] **Step 4: Add delayed echo test**

```rust
#[test]
fn freq_domain_aec_cancels_delayed_echo() {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let reference = EchoReferenceBuffer::new(1_000);
    let mut processor = MicEchoProcessor::new(reference.clone());

    let n = 64_000;
    let delay = 2400; // 150ms at 16kHz

    let render: Vec<f32> = (0..n).map(|i| {
        let mut h = DefaultHasher::new();
        i.hash(&mut h);
        (h.finish() as f32 / u64::MAX as f32) * 2.0 - 1.0
    }).collect();

    let mut mic = vec![0.0f32; delay];
    mic.extend(render.iter().map(|&s| s * 0.5));
    mic.truncate(n);

    let chunk_size = 480;
    let mut all_cleaned = Vec::new();

    for (render_chunk, mic_chunk) in render.chunks(chunk_size).zip(mic.chunks(chunk_size)) {
        reference.push_render_chunk(render_chunk);
        let cleaned = processor.process_chunk(mic_chunk);
        all_cleaned.extend_from_slice(&cleaned);
    }

    // After convergence (last 2 seconds), echo should be suppressed
    let tail_start = 32_000;
    let raw_e = energy(&mic[tail_start..]);
    let clean_e = energy(&all_cleaned[tail_start..]);
    let ratio = clean_e / raw_e;
    assert!(ratio < 0.20, "delayed echo energy should be < 20% after convergence, got {:.2}%", ratio * 100.0);
}
```

- [ ] **Step 5: Add silence preservation test**

```rust
#[test]
fn freq_domain_aec_preserves_mic_when_reference_silent() {
    let reference = EchoReferenceBuffer::new(1_000);
    let mut processor = MicEchoProcessor::new(reference.clone());

    // Push silent reference
    let silence = vec![0.0f32; 4800];
    reference.push_render_chunk(&silence);

    // Mic has actual speech
    let mic: Vec<f32> = (0..4800).map(|i| {
        ((i as f32) * 0.11).sin() * 0.3
    }).collect();

    let mut all_cleaned = Vec::new();
    for chunk in mic.chunks(480) {
        reference.push_render_chunk(&vec![0.0; chunk.len()]);
        let cleaned = processor.process_chunk(chunk);
        all_cleaned.extend_from_slice(&cleaned);
    }

    let ratio = energy(&all_cleaned) / energy(&mic);
    assert!(ratio > 0.95, "mic should pass through when reference silent, got {:.2}%", ratio * 100.0);
}
```

- [ ] **Step 6: Add filter reset after silence test**

```rust
#[test]
fn freq_domain_aec_resets_after_prolonged_silence() {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let reference = EchoReferenceBuffer::new(1_000);
    let mut processor = MicEchoProcessor::new(reference.clone());

    // Phase 1: Train with echo for 2 seconds
    for i in 0..125 {
        let offset = i * 256;
        let render: Vec<f32> = (0..256).map(|j| {
            let mut h = DefaultHasher::new();
            (offset + j).hash(&mut h);
            (h.finish() as f32 / u64::MAX as f32) * 2.0 - 1.0
        }).collect();
        let mic: Vec<f32> = render.iter().map(|&s| s * 0.5).collect();
        reference.push_render_chunk(&render);
        processor.process_chunk(&mic);
    }

    // Phase 2: 1 second of silence (> 50 blocks)
    for _ in 0..63 {
        let silence = vec![0.0f32; 256];
        reference.push_render_chunk(&silence);
        processor.process_chunk(&silence);
    }

    // Phase 3: New signal - should not produce artifacts
    let new_mic: Vec<f32> = (0..4800).map(|i| {
        ((i as f32) * 0.07).sin() * 0.3
    }).collect();
    let mut all_cleaned = Vec::new();
    for chunk in new_mic.chunks(480) {
        reference.push_render_chunk(&vec![0.0; chunk.len()]);
        let cleaned = processor.process_chunk(chunk);
        all_cleaned.extend_from_slice(&cleaned);
    }

    // Output should not be significantly larger than input (no artifacts)
    // and should not be excessively suppressed
    let ratio = energy(&all_cleaned) / energy(&new_mic);
    assert!(ratio < 1.2, "output should not have artifacts after silence reset, energy ratio {:.2}", ratio);
    assert!(ratio > 0.7, "output should not be excessively suppressed, energy ratio {:.2}", ratio);
}
```

- [ ] **Step 7: Run all tests**

Run: `cargo test -p opencassava-core echo_cancel -- --nocapture`
Expected: All 7 tests PASS

- [ ] **Step 8: Commit**

```bash
git add crates/opencassava-core/src/audio/echo_cancel.rs
git commit -m "test: add comprehensive tests for frequency-domain AEC"
```

---

### Task 4: Verify integration with `engine.rs` compiles

**Files:**
- Verify: `opencassava/src-tauri/src/engine.rs` (no changes expected)

The public API is unchanged: `EchoReferenceBuffer::new`, `EchoReferenceBuffer::default`, `EchoReferenceBuffer::push_render_chunk`, `MicEchoProcessor::new`, `MicEchoProcessor::set_enabled`, `MicEchoProcessor::process_chunk`. The `engine.rs` wiring should compile without changes.

**Note:** The `DEFAULT_REFERENCE_WINDOW_MS` changed from 3000 to 1000. Since `engine.rs` uses `EchoReferenceBuffer::default()`, the buffer now holds 1 second instead of 3 seconds. This is sufficient: the AEC needs 256ms of reference history, and 1000ms provides ample margin for async timing between mic and system audio streams.

- [ ] **Step 1: Build the full application**

Run: `cargo check -p app`
Expected: Compiles without errors

If there are compile errors, they will be from the removed `with_max_delay_samples` test helper (only used in `#[cfg(test)]`) or any reference to removed types. Fix as needed.

- [ ] **Step 2: Run all project tests**

Run: `cargo test --workspace`
Expected: All tests pass

- [ ] **Step 3: Commit (if fixes were needed)**

```bash
git add -A
git commit -m "fix: resolve integration issues with frequency-domain AEC"
```

---

### Task 5: Final build and manual test instructions

- [ ] **Step 1: Full release build**

Run: `cargo build --release -p app`
Expected: Builds successfully

- [ ] **Step 2: Document manual test**

To manually validate: start a call with external speakers + separate mic. Check transcript. The "You" channel should no longer show garbled echoes of what the remote speaker said. Specifically compare against the transcript patterns seen before:
- Before: `You: "So then we cut to the optimized tape by that."` (echo of Speaker 3)
- After: These lines should be absent or drastically reduced
