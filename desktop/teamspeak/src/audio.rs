//! Microphone -> Opus -> TeamSpeak, and TeamSpeak -> mixed playback, using the default Windows devices.
//! Devices are opened in their own format; audio is converted to/from 48 kHz (TeamSpeak's rate).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{format_err, Result};
use audiopus::coder::Encoder;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream};
use tokio::sync::mpsc;
use tsclientlib::ClientId;
use tsproto_packets::packets::{AudioData, CodecType, InAudioBuf, OutAudio, OutPacket};

const RATE: u32 = 48000;
const FRAME: usize = 960; // 20 ms at 48 kHz

pub type Handler = tsclientlib::audio::AudioHandler<ClientId>;

/// Settings shared with the audio callbacks.
#[derive(Default)]
pub struct Shared {
	/// RNNoise noise suppression on the microphone.
	pub noise: AtomicBool,
	/// Automatic sensitivity: the gate follows the room's noise floor.
	pub auto: AtomicBool,
	pub muted: AtomicBool,
	pub deaf: AtomicBool,
	pub ptt_mode: AtomicBool,
	pub ptt_down: AtomicBool,
	/// Voice-activity threshold in dB (f32 bits).
	pub threshold: AtomicU32,
	/// Last microphone level in dB (f32 bits).
	pub level: AtomicU32,
	pub transmitting: AtomicBool,
	/// Estimated noise floor in dB (f32 bits).
	pub floor: AtomicU32,
	pub volumes: Mutex<HashMap<u16, f32>>,
}

pub struct Audio {
	pub shared: Arc<Shared>,
	pub handler: Arc<Mutex<Handler>>,
	_input: Option<Stream>,
	_output: Option<Stream>,
}

fn find_device(input: bool, name: &str) -> Option<cpal::Device> {
	let host = cpal::default_host();
	if !name.is_empty() {
		let list = if input { host.input_devices().ok() } else { host.output_devices().ok() };
		if let Some(list) = list {
			for d in list {
				if d.description().ok().map(|n| n.name().to_string()).as_deref() == Some(name) {
					return Some(d);
				}
			}
		}
	}
	if input { host.default_input_device() } else { host.default_output_device() }
}

pub fn device_names() -> (Vec<String>, Vec<String>) {
	let host = cpal::default_host();
	let names = |it: Option<Vec<cpal::Device>>| -> Vec<String> {
		it.unwrap_or_default().iter().filter_map(|d| d.description().ok().map(|n| n.name().to_string())).collect()
	};
	(
		names(host.input_devices().ok().map(|i| i.collect())),
		names(host.output_devices().ok().map(|i| i.collect())),
	)
}

impl Audio {
	pub fn start(shared: Arc<Shared>, packets: mpsc::Sender<OutPacket>, input_name: &str, output_name: &str) -> Self {
		let handler = Arc::new(Mutex::new(Handler::new()));
		// Automated tests use a synthetic tone and no speakers, so they never touch real devices.
		if std::env::var("HS_TS_TEST_AUDIO").is_ok() {
			let (sh, h) = (shared.clone(), handler.clone());
			std::thread::spawn(move || {
				let mut encoder = Encoder::new(audiopus::SampleRate::Hz48000, audiopus::Channels::Mono, audiopus::Application::Voip).unwrap();
				let (mut open_until, mut was_sending, mut out, mut t) = (0u32, false, [0u8; 1275], 0usize);
				let mut denoise = None;
				let mut sink = vec![0.0f32; FRAME * 2];
				loop {
					let mut frame: Vec<f32> = (0..FRAME).map(|i| ((t + i) as f32 * 440.0 * 6.2831853 / RATE as f32).sin() * 0.3).collect();
					t += FRAME;
					process(&mut frame, &sh, &mut encoder, &packets, &mut open_until, &mut was_sending, &mut out, &mut denoise);
					for x in sink.iter_mut() {
						*x = 0.0;
					}
					h.lock().unwrap().fill_buffer(&mut sink);
					std::thread::sleep(std::time::Duration::from_millis(20));
					if Arc::strong_count(&h) == 1 {
						break;
					}
				}
			});
			return Self { shared, handler, _input: None, _output: None };
		}
		let input = find_device(true, input_name).and_then(|d| match open_capture(&d, shared.clone(), packets) {
			Ok(s) => Some(s),
			Err(e) => {
				crate::emit(serde_json::json!({"type": "error", "message": format!("Microphone: {e}")}));
				None
			}
		});
		let output = find_device(false, output_name).and_then(|d| match open_playback(&d, shared.clone(), handler.clone()) {
			Ok(s) => Some(s),
			Err(e) => {
				crate::emit(serde_json::json!({"type": "error", "message": format!("Speakers: {e}")}));
				None
			}
		});
		Self { shared, handler, _input: input, _output: output }
	}

	pub fn play_packet(&self, from: ClientId, packet: InAudioBuf) {
		if self.shared.deaf.load(Ordering::Relaxed) {
			return;
		}
		let mut h = self.handler.lock().unwrap();
		let _ = h.handle_packet(from, packet);
		let vols = self.shared.volumes.lock().unwrap();
		if let Some(q) = h.get_mut_queues().get_mut(&from) {
			q.volume = *vols.get(&from.0).unwrap_or(&1.0);
		}
	}

	/// Clients whose voice is currently being played.
	pub fn talking(&self) -> Vec<u16> {
		let mut v: Vec<u16> = self.handler.lock().unwrap().get_queues().keys().map(|c| c.0).collect();
		v.sort();
		v
	}
}

fn open_capture(device: &cpal::Device, shared: Arc<Shared>, packets: mpsc::Sender<OutPacket>) -> Result<Stream> {
	let cfg = device.default_input_config().map_err(|e| format_err!("{e}"))?;
	if cfg.sample_format() != SampleFormat::F32 {
		return Err(format_err!("unsupported sample format {:?}", cfg.sample_format()));
	}
	let channels = cfg.channels() as usize;
	let in_rate = cfg.sample_rate() as f64;
	let mut encoder = Encoder::new(audiopus::SampleRate::Hz48000, audiopus::Channels::Mono, audiopus::Application::Voip)
		.map_err(|e| format_err!("{e}"))?;
	let _ = encoder.set_bitrate(audiopus::Bitrate::BitsPerSecond(48000));
	let mut frame: Vec<f32> = Vec::with_capacity(FRAME);
	let mut pos = 0.0f64; // resampling position
	let step = in_rate / RATE as f64;
	let mut last = 0.0f32;
	let mut open_until = 0u32; // frames the voice gate stays open after speech
	let mut was_sending = false;
	let mut out = [0u8; 1275];
	let mut denoise = None;
	// The audio callback only hands samples over; noise removal and encoding run on their own thread, so a slow
	// frame can no longer make the sound card overrun (that was the "buffer underrun or overrun" error).
	let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<f32>>(64);
	std::thread::spawn(move || {
		while let Ok(data) = rx.recv() {
			// Downmix to mono and resample to 48 kHz with linear interpolation.
			let mono = data.chunks(channels).map(|c| c.iter().sum::<f32>() / channels as f32);
			for s in mono {
				while pos < 1.0 {
					frame.push(last + (s - last) * pos as f32);
					pos += step;
					if frame.len() == FRAME {
						process(&mut frame, &shared, &mut encoder, &packets, &mut open_until, &mut was_sending, &mut out, &mut denoise);
					}
				}
				pos -= 1.0;
				last = s;
			}
		}
	});
	let stream = device
		.build_input_stream(
			cfg.config(),
			move |data: &[f32], _| {
				let _ = tx.try_send(data.to_vec());
			},
			|e| {
				// Underruns/overruns are momentary glitches the stream recovers from: not worth an error message.
				let m = e.to_string();
				if !m.to_lowercase().contains("underrun") {
					crate::emit(serde_json::json!({"type": "error", "message": format!("Microphone: {m}")}));
				}
			},
			None,
		)
		.map_err(|e| format_err!("{e}"))?;
	stream.play().map_err(|e| format_err!("{e}"))?;
	Ok(stream)
}

/// RNNoise plus a gate driven by its own voice-activity estimate: noise between words is removed completely.
pub struct Denoiser {
	ds: Box<nnnoiseless::DenoiseState<'static>>,
	gain: f32,
	hold: u32,
}
impl Denoiser {
	pub fn new() -> Self { Self { ds: nnnoiseless::DenoiseState::new(), gain: 1.0, hold: 0 } }
	pub fn process(&mut self, frame: &mut [f32]) {
		let mut buf_in = [0.0f32; 480];
		let mut buf_out = [0.0f32; 480];
		for chunk in frame.chunks_mut(480) {
			for (d, x) in buf_in.iter_mut().zip(chunk.iter()) {
				*d = x * 32767.0;
			}
			let vad = self.ds.process_frame(&mut buf_out, &buf_in);
			// Keep the gate open for 200 ms after speech so word endings are not cut.
			if vad > 0.6 {
				self.hold = 20;
			} else if self.hold > 0 {
				self.hold -= 1;
			}
			let target = if self.hold > 0 { 1.0 } else { 0.03 };
			for (x, o) in chunk.iter_mut().zip(buf_out.iter()) {
				// Smooth gain changes (about 5 ms) to avoid clicks.
				self.gain += (target - self.gain) * 0.004;
				*x = o / 32767.0 * self.gain;
			}
		}
	}
}

fn process(
	frame: &mut Vec<f32>, shared: &Shared, encoder: &mut Encoder, packets: &mpsc::Sender<OutPacket>, open_until: &mut u32,
	was_sending: &mut bool, out: &mut [u8; 1275], denoise: &mut Option<Denoiser>,
) {
	// RNNoise works on 10 ms frames (480 samples at 48 kHz) in 16-bit range.
	if shared.noise.load(Ordering::Relaxed) {
		denoise.get_or_insert_with(Denoiser::new).process(frame);
	}
	let rms = (frame.iter().map(|x| x * x).sum::<f32>() / frame.len() as f32).sqrt();
	let db = if rms > 0.0 { 20.0 * rms.log10() } else { -100.0 };
	shared.level.store(db.to_bits(), Ordering::Relaxed);
	let mut threshold = f32::from_bits(shared.threshold.load(Ordering::Relaxed));
	if shared.auto.load(Ordering::Relaxed) {
		// The floor falls quickly to quiet moments and creeps up slowly, so speech never raises it.
		let floor = f32::from_bits(shared.floor.load(Ordering::Relaxed));
		let floor = if db < floor { floor + (db - floor) * 0.2 } else { floor + (db - floor) * 0.002 };
		shared.floor.store(floor.clamp(-100.0, -20.0).to_bits(), Ordering::Relaxed);
		threshold = (floor + 10.0).clamp(-70.0, -25.0);
	}
	if db > threshold {
		*open_until = 20; // keep sending 400 ms after the last loud frame
	} else if *open_until > 0 {
		*open_until -= 1;
	}
	let send = !shared.muted.load(Ordering::Relaxed)
		&& !shared.deaf.load(Ordering::Relaxed)
		&& if shared.ptt_mode.load(Ordering::Relaxed) { shared.ptt_down.load(Ordering::Relaxed) } else { *open_until > 0 };
	shared.transmitting.store(send, Ordering::Relaxed);
	if send {
		if let Ok(len) = encoder.encode_float(&frame[..], &mut out[..]) {
			let packet = OutAudio::new(&AudioData::C2S { id: 0, codec: CodecType::OpusVoice, data: &out[..len] });
			let _ = packets.try_send(packet);
		}
	} else if *was_sending {
		// An empty packet tells the others that we stopped talking.
		let packet = OutAudio::new(&AudioData::C2S { id: 0, codec: CodecType::OpusVoice, data: &[] });
		let _ = packets.try_send(packet);
	}
	*was_sending = send;
	frame.clear();
}

fn open_playback(device: &cpal::Device, shared: Arc<Shared>, handler: Arc<Mutex<Handler>>) -> Result<Stream> {
	let cfg = device.default_output_config().map_err(|e| format_err!("{e}"))?;
	if cfg.sample_format() != SampleFormat::F32 {
		return Err(format_err!("unsupported sample format {:?}", cfg.sample_format()));
	}
	let channels = cfg.channels() as usize;
	let out_rate = cfg.sample_rate() as f64;
	let step = RATE as f64 / out_rate; // 48 kHz frames per output frame
	let mut pending: Vec<f32> = Vec::new(); // decoded stereo audio at 48 kHz, not yet played
	let mut pos = 0.0f64; // read position in `pending`, in frames
	let stream = device
		.build_output_stream(
			cfg.config(),
			move |data: &mut [f32], _| {
				let frames = data.len() / channels;
				let last_needed = pos + frames as f64 * step + 2.0;
				while ((pending.len() / 2) as f64) < last_needed {
					let mut chunk = vec![0.0f32; FRAME * 2];
					if !shared.deaf.load(Ordering::Relaxed) {
						handler.lock().unwrap().fill_buffer(&mut chunk);
					}
					pending.extend_from_slice(&chunk);
				}
				for f in 0..frames {
					let p = pos + f as f64 * step;
					let i = p as usize;
					let t = (p - i as f64) as f32;
					let l = pending[i * 2] + (pending[(i + 1) * 2] - pending[i * 2]) * t;
					let r = pending[i * 2 + 1] + (pending[(i + 1) * 2 + 1] - pending[i * 2 + 1]) * t;
					for c in 0..channels {
						data[f * channels + c] = if channels == 1 { (l + r) * 0.5 } else if c % 2 == 0 { l } else { r };
					}
				}
				pos += frames as f64 * step;
				let used = pos as usize;
				pending.drain(..used * 2);
				pos -= used as f64;
			},
			|e| crate::emit(serde_json::json!({"type": "error", "message": format!("Speakers: {e}")})),
			None,
		)
		.map_err(|e| format_err!("{e}"))?;
	stream.play().map_err(|e| format_err!("{e}"))?;
	Ok(stream)
}

#[cfg(test)]
mod tests {
	#[test]
	fn denoiser_removes_background_noise() {
		let mut ds = super::Denoiser::new();
		let mut seed = 12345u32;
		let mut rnd = || {
			seed = seed.wrapping_mul(1103515245).wrapping_add(12345);
			((seed >> 8) as f32 / (1u32 << 24) as f32) * 2.0 - 1.0
		};
		let (mut e_in, mut e_out) = (0f64, 0f64);
		let mut out = [0f32; 480];
		let mut lp = 0f32;
		for i in 0..400 {
			// Fan-like noise (low-passed) plus 50 Hz mains hum, like a real room.
			let input: Vec<f32> = (0..480)
				.map(|k| {
					lp = lp * 0.97 + rnd() * 0.03;
					let t = (i * 480 + k) as f32 / 48000.0;
					lp * 1.5 + (t * 50.0 * 6.2831853).sin() * 0.01
				})
				.collect();
			out.copy_from_slice(&input);
			ds.process(&mut out);
			if i > 100 {
				e_in += input.iter().map(|x| (*x as f64).powi(2)).sum::<f64>();
				e_out += out.iter().map(|x| (*x as f64).powi(2)).sum::<f64>();
			}
		}
		let ratio = (e_out / e_in).sqrt();
		println!("rnnoise output/input rms ratio: {ratio}");
		assert!(ratio < 0.3, "ratio {ratio}");
	}

	#[test]
	fn denoiser_keeps_speech() {
		// Spoken words from Windows text-to-speech (48 kHz, 16-bit mono WAV).
		let wav = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../test/fixtures/speech.wav")).expect("speech.wav");
		let data = wav.windows(4).position(|w| w == b"data").expect("data chunk") + 8;
		let samples: Vec<f32> = wav[data..].chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0).collect();
		let mut d = super::Denoiser::new();
		let (mut e_in, mut e_out) = (0f64, 0f64);
		for (i, chunk) in samples.chunks_exact(960).enumerate() {
			let mut frame = chunk.to_vec();
			d.process(&mut frame);
			if i > 10 {
				e_in += chunk.iter().map(|x| (*x as f64).powi(2)).sum::<f64>();
				e_out += frame.iter().map(|x| (*x as f64).powi(2)).sum::<f64>();
			}
		}
		let ratio = (e_out / e_in).sqrt();
		println!("speech output/input rms ratio: {ratio}");
		assert!(ratio > 0.6, "speech was cut: {ratio}");
	}
}
