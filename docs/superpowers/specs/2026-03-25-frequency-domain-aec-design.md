# Frequency-Domain Acoustic Echo Cancellation

## Problem

The current NLMS-based echo canceller fails to suppress acoustic echoes in a setup with external speakers and a separate microphone. The time-domain NLMS filter converges too slowly (~625ms), cannot model room impulse responses beyond its 64ms filter length, and produces consistently poor results throughout calls. Echoes leak through to the transcriber, producing garbled "You" utterances that mirror what the remote speaker said.

The text-level echo suppression (Jaccard similarity + n-gram matching) catches some survivors but cannot handle heavily garbled echoes where ASR produces entirely different words.

## Solution

Replace the time-domain NLMS adaptive filter with a Partitioned Block Frequency-Domain Adaptive Filter (PBFDAF). This is the standard approach used by WebRTC, Speex, and all professional AEC systems.

## Design

### Core Algorithm: PBFDAF

The mic and reference signals are processed in fixed-size blocks. Each block is transformed to the frequency domain via FFT, where per-bin adaptive filtering estimates and subtracts the echo.

**Parameters:**
- Block size (N): 256 samples (16ms at 16kHz)
- Number of partitions (P): 16 (covers 256ms total impulse response)
- FFT size: 512 points (2N, for overlap-save convolution)
- Step size (mu): 0.3 (conservative start; tunable up to 0.5 if stable)
- Regularization: per-bin power estimate with exponential smoothing (alpha = 0.9)
- Spectra: 257 complex bins per 512-point real FFT (DC through Nyquist)

**Per-block processing (overlap-save):**
1. Build a 512-sample input frame: [previous 256 mic samples | new 256 mic samples]. FFT to get mic spectrum (257 complex bins). Similarly, build and FFT the reference frame from the reference block history.
2. For each partition p (0..P), multiply reference spectrum from p blocks ago by partition p's filter coefficients; sum across all partitions to form the echo estimate spectrum.
3. Subtract echo estimate from mic spectrum to get error spectrum.
4. Apply the residual echo suppression post-filter (see below) to the error spectrum.
5. IFFT the post-filtered spectrum to 512 time-domain samples; **keep only the last 256 samples** (the valid overlap-save output; discard the first 256 which contain circular convolution artifacts).
6. **Constrained gradient update** for each partition p:
   a. Compute unconstrained gradient: `G(k) = E(k) * conj(X_p(k)) / P(k)` where E is error spectrum, X_p is reference spectrum from p blocks ago, P(k) is the smoothed power estimate for bin k.
   b. IFFT the gradient to time domain (512 samples).
   c. Zero out the last 256 samples (keep only first 256) — this constraint ensures the filter impulse response stays causal and bounded.
   d. FFT back to frequency domain.
   e. Update: `W_p(k) += mu * G_constrained(k)`

**Why this works better than NLMS:**
- Each frequency bin converges independently (~50-100ms vs 625ms)
- 16 partitions implicitly cover 0-256ms delay without explicit delay search
- Computational cost: ~130K complex ops per 16ms block vs ~1M real ops for equivalent time-domain filter
- Natural spectral selectivity enables per-bin double-talk decisions

### Double-Talk Detection

Per-bin energy comparison between mic and reference, evaluated each block:
- `ref_power < epsilon` (1e-8) in a bin: skip adaptation for that bin (silence, ratio undefined)
- `mic_power / ref_power > 10.0` in a bin: freeze adaptation for that bin (user speaking)
- `mic_power / ref_power < 0.1` in a bin: adapt at full mu (pure echo)
- Otherwise: reduce mu to mu * 0.2 for that bin (possible double-talk)

This is a **per-bin decision**, so adaptation continues at frequencies dominated by echo while freezing at frequencies dominated by the user's voice. No global double-talk state needed.

### Residual Echo Suppression (Post-Filter)

After adaptive filtering, a spectral post-filter suppresses remaining echo residual:

For each frequency bin:
- Estimate residual echo power: `echo_power = leakage * |reference_spectrum|^2` where leakage = 0.03 (fraction of reference power estimated to survive the adaptive filter)
- Compute gain: `gain = max(1.0 - alpha * echo_power / mic_power, floor)`
- alpha = 2.0 (slight oversubtraction to catch residual)
- floor = 0.1 (prevents musical noise artifacts by never fully zeroing a bin)
- Apply gain to the cleaned spectrum before final IFFT

### Filter Reset on Silence

If the reference signal has been below `MIN_RENDER_RMS` for 50+ consecutive blocks (800ms), decay filter coefficients by multiplying all by 0.9 each block. This prevents stale coefficients from producing artifacts when audio resumes after a pause.

### Integration

**Public API unchanged:**
- `EchoReferenceBuffer::push_render_chunk(&self, samples: &[f32])` — unchanged signature
- `MicEchoProcessor::process_chunk(&mut self, mic: &[f32]) -> Vec<f32>` — unchanged signature
- `MicEchoProcessor::set_enabled(&mut self, enabled: bool)` — unchanged

**Internal changes to `echo_cancel.rs`:**
- `NlmsEchoCanceller` replaced by `FreqDomainAec`
- `EchoReferenceBuffer` keeps its raw sample storage (VecDeque<f32>) and `push_render_chunk` API. The AEC pulls aligned 256-sample blocks from it when processing. No block-alignment responsibility on the push side.
- Buffer capacity reduced from 3000ms to 1000ms (16,000 samples). The AEC only needs 256ms of history (16 partitions x 256 samples = 4096 samples); 1000ms provides margin for async timing between mic and system audio streams.
- `best_match()` and correlation-based alignment removed (partitions handle delay implicitly)
- Post-NLMS heuristic suppression (the `correlation > 0.55` block) replaced by spectral post-filter

**Removed:**
- `AlignedRender` struct
- `normalized_correlation()` function
- `CORRELATION_STRIDE`, `MIN_CORRELATION`, `DEFAULT_MAX_DELAY_MS` constants

**Kept unchanged:**
- `rms()` helper function
- `MIN_RENDER_RMS` constant (used to skip processing when reference is silent)
- All text-level echo suppression in `engine.rs`
- All wiring in `engine.rs`

**Block accumulation and output length matching:**
Mic chunks arrive in variable sizes (300-450 samples). The processor maintains:
- An input accumulator: incoming samples are appended; whenever 256+ samples are available, a block is processed.
- An output accumulator: processed blocks are appended to an output ring buffer.
- On each `process_chunk` call, exactly `input.len()` samples are drained from the output buffer and returned.

Until the first full 256-sample block accumulates, incoming mic samples are passed through unprocessed. This introduces up to 16ms of latency (one block) on the first call while the accumulator fills. Subsequent calls with steady input have negligible added latency. For transcription (which has 500ms+ inherent latency), 16ms is immaterial.

**New dependency:**
- `realfft` crate (pure Rust FFT, wraps `rustfft`, no native dependencies). Produces 257 complex bins for a 512-point real FFT. The Nyquist bin must be handled correctly (it is real-valued).

### Testing

1. **Pure echo cancellation** — identical broadband signal (white noise) as reference and mic with 80-sample delay, 4+ seconds. Assert cleaned energy < 15% of original (measured over the last 2 seconds, after convergence).
2. **Double-talk preservation** — 200Hz sine as reference + 800Hz sine as mic simultaneously. Assert 800Hz component preserved above 70% energy in cleaned output.
3. **Convergence speed** — white noise echo, measure blocks until energy suppression reaches 15dB. Assert < 25 blocks (400ms).
4. **Variable chunk sizes** — chunks of 100, 256, 500, 1000 samples. Assert output length matches input exactly, no samples lost or gained.
5. **Delayed echo** — reference signal, then same signal 150ms later as mic. Assert cancellation works across partitions.
6. **Silence preservation** — silent reference, mic signal passes through unmodified (ratio > 0.95).
7. **Filter reset after silence** — train filter, then 1 second of silence, then new signal. Assert no artifacts on resumption.

### Constraints

- User setup: external speakers + separate microphone
- Balance: suppress echoes aggressively but preserve user's speech during double-talk
- Echo is consistently bad throughout calls (not a convergence-only problem)
- Sample rate: 16kHz throughout the pipeline (no resampling needed at AEC boundary)
- Must not increase CPU usage significantly (current pipeline optimized from 84% to 17%)
