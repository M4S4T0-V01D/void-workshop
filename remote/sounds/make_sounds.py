#!/usr/bin/env python3
"""Synthesizes VOID Portal's notification sounds (stereo, 44.1 kHz) with numpy only.

Notifications have their own dark voice, unlike the bright bells of the rest of the VOID apps: hollow
odd-harmonic tones under a closing low-pass, each opened by a reversed "inhale", mastered quietly (peaks -6 to -8 dBFS,
about 5 dB under the old bright cues).
  void_done.ogg       task finished: an inhale, then a low D-minor chord that settles
  void_summon.ogg     needs you: two hollow heartbeats from the deep
  void_alert.ogg      problems and account switches: a slow falling tritone with an uneasy beat
  void_rise.ogg       PC came online: breath rising into an open fifth
  void_fall.ogg       PC went offline: a tone sinking and darkening into silence
  ambient_drone.ogg   40 s seamless loop played softly while the app is open
  send_zap.ogg        in-app: a message was sent
  queue_plink.ogg     in-app: a message was queued while the agent works
  task_launch.ogg     in-app: a new task started

Usage: python3 make_sounds.py <out dir> [name ...]   (writes .wav, then .ogg via ffmpeg if available)
"""
import os
import subprocess
import sys
import wave

import numpy as np

SR = 44100
rng = np.random.default_rng(7)


def t_axis(sec):
    return np.arange(int(SR * sec)) / SR


def env(n, attack, decay_tau):
    t = np.arange(n) / SR
    a = np.clip(t / max(attack, 1e-4), 0, 1)
    return a * np.exp(-np.maximum(t - attack, 0) / decay_tau)


def bell(freq, sec, decay=0.6, bright=1.0, detune=0.0):
    """FM bell: inharmonic partials that ring and fade, with a little detune for width."""
    t = t_axis(sec)
    f = freq * (1 + detune)
    mod = bright * 2.2 * np.exp(-t / (decay * 0.35)) * np.sin(2 * np.pi * f * 3.5 * t)
    tone = np.sin(2 * np.pi * f * t + mod)
    tone += 0.35 * np.sin(2 * np.pi * f * 2.76 * t) * np.exp(-t / (decay * 0.4))
    tone += 0.18 * np.sin(2 * np.pi * f * 5.4 * t) * np.exp(-t / (decay * 0.2))
    return tone * env(len(t), 0.004, decay)


def sweep(f0, f1, sec, curve=2.0):
    """Exponential glide with a soft tremble."""
    t = t_axis(sec)
    x = (t / sec) ** curve
    f = f0 * (f1 / f0) ** x
    phase = 2 * np.pi * np.cumsum(f) / SR
    vib = 1 + 0.004 * np.sin(2 * np.pi * 6.5 * t)
    return np.sin(phase * vib) + 0.3 * np.sin(2 * phase * vib + 0.5)


def sparkle(sec, density=60, lo=3500, hi=9000, decay=0.05):
    """Twinkling dust: tiny random high pings."""
    n = int(SR * sec)
    out = np.zeros((n, 2))
    for _ in range(int(density * sec)):
        start = int(rng.uniform(0, n - SR * 0.2))
        f = rng.uniform(lo, hi)
        ping = bell(f, 0.2, decay=decay, bright=0.4)
        pan = rng.uniform(0.1, 0.9)
        end = min(n, start + len(ping))
        out[start:end, 0] += ping[: end - start] * (1 - pan)
        out[start:end, 1] += ping[: end - start] * pan
    return out * 0.12


def whoosh(sec, f_start, f_end):
    """Noise through a moving band-pass (an octave below the swept cutoff up to it): air, no rumble."""
    n = int(SR * sec)
    noise = rng.standard_normal((n, 2))
    cut = np.geomspace(f_start, f_end, n)
    hi = 1 - np.exp(-2 * np.pi * cut / SR)
    lo = 1 - np.exp(-2 * np.pi * cut / 4 / SR)
    y = np.zeros_like(noise)
    a = np.zeros(2)
    b = np.zeros(2)
    for i in range(n):
        a += hi[i] * (noise[i] - a)
        b += lo[i] * (noise[i] - b)
        y[i] = a - b
    return y * np.hanning(n)[:, None] * 0.6


def highpass(x, fc=180.0, passes=2):
    """One-pole high-pass, applied twice: phone speakers cannot play lows, so keep them out."""
    alpha = np.exp(-2 * np.pi * fc / SR)
    for _ in range(passes):
        y = np.zeros_like(x)
        prev_x = np.zeros(x.shape[1])
        prev_y = np.zeros(x.shape[1])
        for i in range(len(x)):
            prev_y = alpha * (prev_y + x[i] - prev_x)
            prev_x = x[i]
            y[i] = prev_y
        x = y
    return x


def reverb(x, sec=1.6, mix=0.35, damp=4000):
    """Convolution with decaying, darkened stereo noise: a wide cosmic space."""
    n = int(SR * sec)
    t = np.arange(n) / SR
    ir = rng.standard_normal((n, 2)) * np.exp(-t / (sec / 5))[:, None]
    alpha = 1 - np.exp(-2 * np.pi * damp / SR)
    for ch in range(2):
        acc = 0.0
        col = ir[:, ch]
        for i in range(n):
            acc += alpha * (col[i] - acc)
            col[i] = acc
    ir /= np.sqrt((ir**2).sum(axis=0))
    out_len = len(x) + n - 1
    size = 1 << (out_len - 1).bit_length()
    wet = np.stack([np.fft.irfft(np.fft.rfft(x[:, c], size) * np.fft.rfft(ir[:, c], size), size)[:out_len] for c in range(2)], axis=1)
    dry = np.vstack([x, np.zeros((n - 1, 2))])
    return dry * (1 - mix) + wet * mix * 3.0


def place(buf, sig, at, pan=0.5, gain=1.0):
    """Mix a mono or stereo signal into buf at `at` seconds."""
    i = int(at * SR)
    if sig.ndim == 1:
        sig = np.stack([sig * (1 - pan) * 2 ** 0.5 * 0.7, sig * pan * 2 ** 0.5 * 0.7], axis=1)
    end = min(len(buf), i + len(sig))
    buf[i:end] += sig[: end - i] * gain


def finish(x, fade=0.25, floor_db=-40):
    x = highpass(x)
    x = np.tanh(x * 1.2) / np.tanh(1.2)  # soft saturation glues it together
    x = x / np.max(np.abs(x)) * 0.89  # about -1 dBFS
    # Notifications should be short: cut the tail once it falls below floor_db, then fade.
    blk = int(SR * 0.02)
    level = [np.sqrt(np.mean(x[i : i + blk] ** 2)) for i in range(0, len(x), blk)]
    last = max(i for i, v in enumerate(level) if 20 * np.log10(v + 1e-9) > floor_db)
    x = x[: min(len(x), (last + 1) * blk + int(SR * fade))].copy()
    n = min(len(x), int(SR * fade))
    x[-n:] *= np.linspace(1, 0, n)[:, None] ** 2
    return x


# ---- Notifications: the dark voice ----------------------------------------------------------------


def lowpass(x, fc, passes=2):
    """One-pole low-pass (fc may be an array: a filter that moves), applied `passes` times."""
    fc = np.broadcast_to(np.asarray(fc, dtype=float), (len(x),))
    a = 1 - np.exp(-2 * np.pi * fc / SR)
    for _ in range(passes):
        y = np.zeros_like(x)
        acc = np.zeros(x.shape[1:])
        for i in range(len(x)):
            acc = acc + a[i] * (x[i] - acc)
            y[i] = acc
        x = y
    return x


def hollow(freq, sec, decay=0.5, bright=4.0, attack=0.012, glide=None):
    """A woody, hollow tone: odd harmonics only, whose brightness falls as the note decays.
    glide = (to_freq, seconds) bends the pitch exponentially."""
    t = t_axis(sec)
    f = np.full(len(t), float(freq))
    if glide:
        f = freq * (glide[0] / freq) ** np.clip(t / glide[1], 0, 1)
    phase = 2 * np.pi * np.cumsum(f) / SR
    b = 0.6 + bright * np.exp(-t / (decay * 0.5))
    out = np.zeros(len(t))
    for k in (1, 3, 5, 7, 9, 11):
        out += np.sin(k * phase + 0.3 * k) / k * np.exp(-(k - 1) / b)
    return out * env(len(t), attack, decay)


def stereo_hollow(freq, sec, spread=0.0025, **kw):
    """Two slightly detuned hollow voices, one per side: slow beating gives the width."""
    return np.stack([hollow(freq * (1 - spread), sec, **kw), hollow(freq * (1 + spread), sec, **kw)], axis=1)


def inhale(sec, freq, seed):
    """The signature: a note's reverb played backwards, so the sound breathes in before it speaks."""
    r = np.random.default_rng(seed)
    n = int(SR * sec)
    t = np.arange(n) / SR
    noise = r.standard_normal((n, 2)) * np.exp(-t / (sec / 3))[:, None]
    tone = stereo_hollow(freq, sec, decay=sec / 2.5, bright=2.0, attack=0.002)
    x = lowpass(noise * 0.25 + tone * 0.6, 1800)
    x = x[::-1] * np.linspace(0, 1, n)[:, None] ** 2
    return x


def dark_space(x, sec=1.4, mix=0.4, seed=11):
    """A damped, dark room: short noise tail filtered to ~2.2 kHz."""
    r = np.random.default_rng(seed)
    n = int(SR * sec)
    t = np.arange(n) / SR
    ir = lowpass(r.standard_normal((n, 2)) * np.exp(-t / (sec / 5))[:, None], 2200, passes=1)
    ir /= np.sqrt((ir**2).sum(axis=0))
    out_len = len(x) + n - 1
    size = 1 << (out_len - 1).bit_length()
    wet = np.stack([np.fft.irfft(np.fft.rfft(x[:, c], size) * np.fft.rfft(ir[:, c], size), size)[:out_len] for c in range(2)], axis=1)
    dry = np.vstack([x, np.zeros((n - 1, 2))])
    return dry * (1 - mix) + wet * mix * 2.5


def finish_dark(x, peak=0.4, fade=0.3, floor_db=-46):
    """Quiet mastering: no lows the phone can't play, nothing bright, peak about -9 dBFS."""
    x = highpass(x, 150)
    x = lowpass(x, 3500)
    x = np.tanh(x / np.max(np.abs(x)) * 1.4) / np.tanh(1.4)
    x = x / np.max(np.abs(x)) * peak
    blk = int(SR * 0.02)
    level = [np.sqrt(np.mean(x[i : i + blk] ** 2)) for i in range(0, len(x), blk)]
    last = max(i for i, v in enumerate(level) if 20 * np.log10(v + 1e-9) > floor_db)
    x = x[: min(len(x), (last + 1) * blk + int(SR * fade))].copy()
    n = min(len(x), int(SR * fade))
    x[-n:] *= np.linspace(1, 0, n)[:, None] ** 2
    return x


def void_done():
    """Task finished: breathe in, then a low D-minor chord (A3 D4, F4 a moment later) that settles."""
    buf = np.zeros((int(SR * 1.7), 2))
    place(buf, inhale(0.32, 293.66, seed=21), 0.0, gain=0.7)
    place(buf, stereo_hollow(220.0, 1.4, decay=0.6, bright=3.0), 0.30, gain=0.55)
    place(buf, stereo_hollow(293.66, 1.4, decay=0.55, bright=3.5), 0.30, gain=0.7)
    place(buf, stereo_hollow(349.23, 1.1, decay=0.45, bright=2.5, spread=0.004), 0.47, gain=0.35)
    return finish_dark(dark_space(buf, 1.6, mix=0.45, seed=22), peak=0.5)


def void_summon():
    """Needs you: two hollow heartbeats (E4 over B3), the second softer, after a short breath."""
    buf = np.zeros((int(SR * 1.2), 2))
    place(buf, inhale(0.2, 329.63, seed=31), 0.0, gain=0.55)
    for at, g in ((0.19, 1.0), (0.43, 0.7)):
        place(buf, stereo_hollow(329.63, 0.6, decay=0.16, bright=5.0, attack=0.004), at, gain=0.75 * g)
        place(buf, stereo_hollow(246.94, 0.6, decay=0.18, bright=3.0, attack=0.004), at, gain=0.45 * g)
    return finish_dark(dark_space(buf, 1.0, mix=0.35, seed=32), peak=0.40, fade=0.2)


def void_alert():
    """Something went wrong: Bb4 falling to E4 (a tritone), detuned enough to beat uneasily."""
    buf = np.zeros((int(SR * 1.4), 2))
    place(buf, inhale(0.22, 466.16, seed=41), 0.0, gain=0.5)
    place(buf, stereo_hollow(466.16, 0.5, spread=0.006, decay=0.2, bright=3.5), 0.21, gain=0.6)
    place(buf, stereo_hollow(329.63, 1.0, spread=0.008, decay=0.45, bright=3.0), 0.42, gain=0.7)
    place(buf, stereo_hollow(164.81, 1.0, decay=0.5, bright=2.0), 0.42, gain=0.3)
    return finish_dark(dark_space(buf, 1.2, mix=0.4, seed=42), peak=0.45)


def void_rise():
    """PC came online: a breath of air rising, opening into D4 + A4, a hollow fifth."""
    r = np.random.default_rng(51)
    buf = np.zeros((int(SR * 1.6), 2))
    n = int(SR * 0.6)
    air = lowpass(r.standard_normal((n, 2)) * 0.25, np.geomspace(250, 2400, n)) * np.linspace(0, 1, n)[:, None] ** 2
    place(buf, air, 0.0)
    place(buf, inhale(0.45, 293.66, seed=52), 0.12, gain=0.5)
    place(buf, stereo_hollow(293.66, 1.1, decay=0.5, bright=3.0, attack=0.04), 0.55, gain=0.65)
    place(buf, stereo_hollow(440.0, 1.0, decay=0.45, bright=2.5, attack=0.06), 0.6, gain=0.45)
    return finish_dark(dark_space(buf, 1.4, mix=0.45, seed=53), peak=0.45)


def void_fall():
    """PC went offline: a hollow A4 sinks to D4 while its brightness drains away."""
    buf = np.zeros((int(SR * 1.7), 2))
    place(buf, stereo_hollow(440.0, 1.3, decay=0.55, bright=4.0, attack=0.02, glide=(293.66, 0.9)), 0.0, gain=0.7)
    place(buf, stereo_hollow(220.0, 1.3, decay=0.6, bright=2.0, attack=0.05, glide=(146.83, 0.9)), 0.05, gain=0.4)
    n = len(buf)
    buf = lowpass(buf, np.geomspace(3000, 300, n))
    return finish_dark(dark_space(buf, 1.6, mix=0.5, seed=61), peak=0.5)


def send_zap():
    """Sending a message: a quick upward zap with an airy whoosh, flying off to the right."""
    buf = np.zeros((int(SR * 0.45), 2))
    z = sweep(520, 2100, 0.13, curve=1.4) * env(int(SR * 0.13), 0.004, 0.09)
    place(buf, z, 0.0, pan=0.35, gain=0.5)
    place(buf, sweep(526, 2120, 0.13, curve=1.4) * env(int(SR * 0.13), 0.004, 0.09), 0.006, pan=0.75, gain=0.35)
    place(buf, whoosh(0.22, 900, 5000), 0.0, gain=0.4)
    place(buf, bell(2093.0, 0.25, decay=0.08, bright=0.5), 0.11, pan=0.8, gain=0.25)  # C7 glint at the end
    return finish(reverb(buf, 0.6, mix=0.22), fade=0.08, floor_db=-42)


def queue_plink():
    """Queueing a message: a soft tick, then two crystal plinks that click into place."""
    buf = np.zeros((int(SR * 0.45), 2))
    t = t_axis(0.05)
    thock = np.sin(2 * np.pi * 330 * t) * np.exp(-t / 0.012)
    place(buf, thock, 0.0, gain=0.35)
    place(buf, bell(1318.5, 0.35, decay=0.09, bright=0.6), 0.012, pan=0.42, gain=0.42)  # E6
    place(buf, bell(1975.5, 0.35, decay=0.1, bright=0.6), 0.085, pan=0.58, gain=0.36)  # B6
    return finish(reverb(buf, 0.5, mix=0.2), fade=0.08, floor_db=-42)


def task_launch():
    """Starting a new task: a portal igniting, a swell of air and a rising sparkle of three bells."""
    buf = np.zeros((int(SR * 1.0), 2))
    place(buf, whoosh(0.45, 400, 7000), 0.0, gain=0.6)
    s1 = sweep(220, 880, 0.35, curve=1.8) * env(int(SR * 0.35), 0.08, 0.3)
    place(buf, s1, 0.0, pan=0.45, gain=0.25)
    place(buf, sweep(222, 885, 0.35, curve=1.8) * env(int(SR * 0.35), 0.08, 0.3), 0.0, pan=0.55, gain=0.25)
    for k, f in enumerate([783.99, 1174.66, 1567.98]):  # G5 D6 G6
        place(buf, bell(f, 0.7, decay=0.3, bright=0.9), 0.3 + k * 0.07, pan=0.3 + 0.2 * k, gain=0.4)
    place(buf, sparkle(0.5, density=45, lo=4000, hi=10000), 0.32)
    return finish(reverb(buf, 1.1, mix=0.32), fade=0.2)


def ambient_drone(L=40.0):
    """A seamless cosmic drone loop. Every frequency is a whole number of cycles per loop and the noise is
    synthesised in the frequency domain (periodic by construction), so the end meets the start exactly."""
    n = int(SR * L)
    t = np.arange(n) / SR
    q = lambda f: round(f * L) / L  # snap to whole cycles per loop
    lfo = lambda cycles, ph=0.0: 0.5 + 0.5 * np.sin(2 * np.pi * cycles * t / L + ph)
    out = np.zeros((n, 2))
    # Suspended D chord (D2 A2 D3 E3 A3): detuned pairs beat slowly; brightness breathes.
    for i, (f, gain, pan) in enumerate([(73.42, 0.9, 0.5), (110.0, 0.7, 0.35), (146.83, 0.55, 0.65), (164.81, 0.35, 0.3), (220.0, 0.3, 0.7)]):
        bright = 2.0 + 3.0 * lfo(1, i * 1.3)
        swell = 0.55 + 0.45 * lfo(2 if i % 2 else 1, i * 2.1)
        for det, side in [(-0.075, 0), (+0.075, 1)]:
            f0 = q(f + det)
            sig = np.zeros(n)
            k = 1
            while f0 * k < 2800:
                sig += np.sin(2 * np.pi * q(f0 * k) * t + i * k) / k * np.exp(-(k - 1) / bright)
                k += 1
            p_side = pan if side == 0 else 1 - pan
            out[:, 0] += sig * swell * gain * (1 - p_side) * 0.5
            out[:, 1] += sig * swell * gain * p_side * 0.5
    # High shimmer: D5 A5 E6, tremolo, slowly panning.
    for i, f in enumerate([587.33, 880.0, 1318.51]):
        sig = np.sin(2 * np.pi * q(f) * t) * (0.25 + 0.75 * lfo(3 + i, i)) ** 2 * 0.05
        pan = lfo(1, i * 2.0)
        out[:, 0] += sig * (1 - pan)
        out[:, 1] += sig * pan
    # Noise wash: band-limited, breathing.
    for ch in range(2):
        spec = np.zeros(n // 2 + 1, dtype=complex)
        freqs = np.fft.rfftfreq(n, 1 / SR)
        band = (freqs > 180) & (freqs < 2600)
        spec[band] = (rng.standard_normal(band.sum()) + 1j * rng.standard_normal(band.sum())) / np.sqrt(freqs[band] / 180)
        noise = np.fft.irfft(spec, n)
        noise /= np.max(np.abs(noise))
        out[:, ch] += noise * 0.06 * (0.3 + 0.7 * lfo(2, ch * 1.7))
    # High-pass in the frequency domain (keeps the loop periodic): phone speakers can't play deep lows.
    for ch in range(2):
        spec = np.fft.rfft(out[:, ch])
        freqs = np.fft.rfftfreq(n, 1 / SR)
        spec *= np.clip((freqs - 40) / 40, 0, 1)
        out[:, ch] = np.fft.irfft(spec, n)
    return out / np.max(np.abs(out)) * 0.5  # about -6 dBFS; the app plays it quietly on top


def write_wav(path, x):
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(out, exist_ok=True)
    sounds = [
        ("void_done", void_done),
        ("void_summon", void_summon),
        ("void_alert", void_alert),
        ("void_rise", void_rise),
        ("void_fall", void_fall),
        ("ambient_drone", ambient_drone),
        ("send_zap", send_zap),
        ("queue_plink", queue_plink),
        ("task_launch", task_launch),
    ]
    only = set(sys.argv[2:])
    for name, fn in sounds:
        if only and name not in only:
            continue
        wav = os.path.join(out, f"{name}.wav")
        write_wav(wav, fn())
        # ANDROID_LOOP lets Android's player loop the Ogg without a gap.
        loop = ["-metadata", "ANDROID_LOOP=true"] if name == "ambient_drone" else []
        try:
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav, "-c:a", "libvorbis", "-q:a", "4" if loop else "6", *loop, os.path.join(out, f"{name}.ogg")], check=True)
        except (OSError, subprocess.CalledProcessError) as e:
            print(f"ogg encode skipped for {name}: {e}")
        print(name, "ok")


if __name__ == "__main__":
    main()
