"""
余烬 Ember · 合成器 + 编曲原语（音乐生成模块内部）
从 ember_composed_v2.py 提炼，去掉曲子定义和环境音。

**核心规则（不可改）：**
- 禁用 vibrato（音高 LFO 调制）——用户反馈"听感像转音器"
- 禁用 tanh 削波类失真——用户反馈"电子感重"
- 保留起音瞬态噪声（增强乐器真实感）
- 音色白名单固定 11 种，未来 LLM prompt 也只能从这里选
"""
import numpy as np
from scipy.io import wavfile
from scipy.signal import lfilter

SAMPLE_RATE = 22050
DURATION = 15.0  # 产品定义：每首 15 秒

# 音色白名单——LLM prompt / 手工作曲都只能用这些
ALLOWED_TIMBRES = (
    "piano", "warm_piano", "cello", "violin", "viola", "flute",
    "clarinet", "harp", "nylon_guitar", "warm_pad", "contrabass",
)

# 固定随机种子——确保同一 MIDI 输入生成同样的音频（起音噪声可复现）
_RNG = np.random.default_rng(20260711)


# ==================== 包络 ====================

def _adsr(n, sr, attack=0.02, decay=0.1, sustain=0.7, release=0.15):
    a = min(int(attack * sr), n // 3)
    d = min(int(decay * sr), (n - a) // 3)
    r = min(int(release * sr), (n - a - d) // 2)
    s_len = max(0, n - a - d - r)
    env = np.zeros(n)
    if a > 0:
        env[:a] = np.linspace(0, 1, a)
    if d > 0:
        env[a:a+d] = np.linspace(1, sustain, d)
    if s_len > 0:
        env[a+d:a+d+s_len] = sustain
    if r > 0:
        env[a+d+s_len:] = np.linspace(sustain, 0, r)
    return env


def _attack_noise(n, sr, dur=0.008, amp=0.08):
    """起音瞬态噪声（模拟锤击/拨弦音头）"""
    an = min(int(dur * sr), n)
    if an < 4:
        return np.zeros(n)
    noise = _RNG.standard_normal(an)
    b = np.array([0.25, 0.5, 0.25])
    noise = lfilter(b, [1.0], noise)
    noise *= np.exp(-np.arange(an) / an * 5.0) * amp
    out = np.zeros(n)
    out[:an] = noise
    return out


# ==================== 合成器 ====================

def synth_note(pitch, duration, velocity, sr, timbre='piano'):
    """
    合成单个音符。
    pitch: MIDI 编号 (21-108)
    duration: 秒
    velocity: 1-127
    sr: 采样率
    timbre: 必须是 ALLOWED_TIMBRES 之一
    """
    freq = 440.0 * (2 ** ((pitch - 69) / 12))
    n = max(1, int(duration * sr))
    t = np.arange(n) / sr
    attack = 0.0
    atn_amp = 0.0

    if timbre == 'piano':
        s = (np.sin(2*np.pi*freq*t) * 1.0
             + np.sin(2*np.pi*freq*2*t) * 0.42
             + np.sin(2*np.pi*freq*3*t) * 0.18
             + np.sin(2*np.pi*freq*4*t) * 0.08
             + np.sin(2*np.pi*freq*5*t) * 0.04)
        env = np.exp(-t * 2.0)
        attack, atn_amp = 0.006, 0.10

    elif timbre == 'warm_piano':
        s = (np.sin(2*np.pi*freq*t) * 1.0
             + np.sin(2*np.pi*freq*2*t) * 0.55
             + np.sin(2*np.pi*freq*3*t) * 0.22
             + np.sin(2*np.pi*freq*4*t) * 0.10)
        env = np.exp(-t * 2.6)
        attack, atn_amp = 0.006, 0.08

    elif timbre == 'cello':
        s = (np.sin(2*np.pi*freq*t) * 1.0
             + np.sin(2*np.pi*freq*2*t) * 0.65
             + np.sin(2*np.pi*freq*3*t) * 0.35
             + np.sin(2*np.pi*freq*4*t) * 0.18
             + np.sin(2*np.pi*freq*5*t) * 0.10
             + np.sin(2*np.pi*freq*6*t) * 0.05)
        env = _adsr(n, sr, attack=0.12, decay=0.15, sustain=0.85, release=0.35)
        attack, atn_amp = 0.02, 0.04

    elif timbre == 'violin':
        s = (np.sin(2*np.pi*freq*t) * 1.0
             + np.sin(2*np.pi*freq*2*t) * 0.55
             + np.sin(2*np.pi*freq*3*t) * 0.32
             + np.sin(2*np.pi*freq*4*t) * 0.20
             + np.sin(2*np.pi*freq*5*t) * 0.12
             + np.sin(2*np.pi*freq*6*t) * 0.06)
        env = _adsr(n, sr, attack=0.08, decay=0.1, sustain=0.85, release=0.28)
        attack, atn_amp = 0.015, 0.04

    elif timbre == 'viola':
        s = (np.sin(2*np.pi*freq*t) * 1.0
             + np.sin(2*np.pi*freq*2*t) * 0.60
             + np.sin(2*np.pi*freq*3*t) * 0.35
             + np.sin(2*np.pi*freq*4*t) * 0.18
             + np.sin(2*np.pi*freq*5*t) * 0.08)
        env = _adsr(n, sr, attack=0.1, decay=0.12, sustain=0.85, release=0.3)
        attack, atn_amp = 0.018, 0.04

    elif timbre == 'flute':
        s = (np.sin(2*np.pi*freq*t) * 1.0
             + np.sin(2*np.pi*freq*3*t) * 0.14
             + np.sin(2*np.pi*freq*5*t) * 0.04)
        breath = _RNG.standard_normal(n) * 0.02
        b = np.array([0.2, 0.4, 0.4])
        breath = lfilter(b, [1.0], breath)
        s = s + breath
        env = _adsr(n, sr, attack=0.06, decay=0.05, sustain=0.9, release=0.15)

    elif timbre == 'clarinet':
        s = (np.sin(2*np.pi*freq*t) * 1.0
             + np.sin(2*np.pi*freq*3*t) * 0.55
             + np.sin(2*np.pi*freq*5*t) * 0.28
             + np.sin(2*np.pi*freq*7*t) * 0.12
             + np.sin(2*np.pi*freq*2*t) * 0.08)
        env = _adsr(n, sr, attack=0.05, decay=0.08, sustain=0.85, release=0.15)

    elif timbre == 'harp':
        s = (np.sin(2*np.pi*freq*t) * 1.0
             + np.sin(2*np.pi*freq*2*t) * 0.5
             + np.sin(2*np.pi*freq*3*t) * 0.28
             + np.sin(2*np.pi*freq*4*t) * 0.14
             + np.sin(2*np.pi*freq*5*t) * 0.06)
        env = np.exp(-t * 1.8)
        attack, atn_amp = 0.004, 0.06

    elif timbre == 'nylon_guitar':
        s = (np.sin(2*np.pi*freq*t) * 1.0
             + np.sin(2*np.pi*freq*2*t) * 0.45
             + np.sin(2*np.pi*freq*3*t) * 0.22
             + np.sin(2*np.pi*freq*4*t) * 0.10
             + np.sin(2*np.pi*freq*5*t) * 0.05)
        env = np.exp(-t * 2.2)
        attack, atn_amp = 0.005, 0.09

    elif timbre == 'warm_pad':
        s = (np.sin(2*np.pi*freq*t) * 1.0
             + np.sin(2*np.pi*freq*2*t) * 0.5
             + np.sin(2*np.pi*freq*3*t) * 0.22
             + np.sin(2*np.pi*freq*4*t) * 0.10)
        env = _adsr(n, sr, attack=0.6, decay=0.2, sustain=0.85, release=0.9)

    elif timbre == 'contrabass':
        s = (np.sin(2*np.pi*freq*t) * 1.0
             + np.sin(2*np.pi*freq*2*t) * 0.6
             + np.sin(2*np.pi*freq*3*t) * 0.22
             + np.sin(2*np.pi*freq*4*t) * 0.08)
        env = np.exp(-t * 1.4)
        attack, atn_amp = 0.01, 0.05

    else:
        raise ValueError(f"非法音色 '{timbre}'，必须是 {ALLOWED_TIMBRES}")

    wave = s * env * (velocity / 127.0)
    if attack > 0 and atn_amp > 0:
        wave = wave + _attack_noise(n, sr, dur=attack, amp=atn_amp * velocity / 127.0)
    return wave


def synth_song(song, sr=SAMPLE_RATE, total_dur=DURATION):
    """
    合成整首歌。
    song: {
        "instruments": [
            {"role": str, "timbre": str, "notes": [
                {"pitch": int, "start": float, "end": float, "velocity": int}
            ]}
        ]
    }
    返回：归一化+淡入淡出后的 numpy float32 audio, shape=(n_samples,)
    """
    n_total = int(total_dur * sr)
    audio = np.zeros(n_total)
    for inst in song['instruments']:
        timbre = inst['timbre']
        for note in inst['notes']:
            start_s = int(note['start'] * sr)
            if start_s >= n_total:
                continue
            dur = min(note['end'], total_dur) - note['start']
            if dur <= 0:
                continue
            wave = synth_note(note['pitch'], dur, note['velocity'], sr, timbre)
            actual = min(len(wave), n_total - start_s)
            audio[start_s:start_s + actual] += wave[:actual]
    peak = np.max(np.abs(audio))
    if peak > 0:
        audio = audio / peak * 0.82
    fade = int(sr * 0.2)
    audio[:fade] *= np.linspace(0, 1, fade)
    audio[-fade:] *= np.linspace(1, 0, fade)
    return audio


def save_wav(audio, path, sr=SAMPLE_RATE):
    """audio: float in [-1, 1]"""
    wavfile.write(path, sr, (audio * 32767).astype(np.int16))


# ==================== 输入校验 ====================

def validate_song(song: dict) -> list:
    """
    LLM 输出的 song dict 校验。返回警告列表；严重错误抛异常。
    """
    if "instruments" not in song or not song["instruments"]:
        raise ValueError("song 缺少 instruments")
    warnings = []
    for inst in song["instruments"]:
        if inst.get("timbre") not in ALLOWED_TIMBRES:
            warnings.append(f"非法音色 {inst.get('timbre')} → piano")
            inst["timbre"] = "piano"
        inst.setdefault("role", "unknown")
        inst.setdefault("notes", [])
        for note in inst["notes"]:
            note["pitch"] = max(21, min(108, int(note.get("pitch", 60))))
            note["start"] = max(0.0, min(DURATION, float(note.get("start", 0))))
            note["end"] = max(note["start"] + 0.05,
                              min(DURATION, float(note.get("end", note["start"] + 0.5))))
            note["velocity"] = max(1, min(127, int(note.get("velocity", 60))))
    return warnings
