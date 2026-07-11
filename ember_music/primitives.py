"""
编曲原语（v2 手工作曲风格）——生成音符 dict，不做合成。
LLM 生成模块和未来的手工/半自动作曲都可复用。
"""
import numpy as np

_RNG = np.random.default_rng(20260711)


def _note(pitch, start, end, velocity):
    return {
        "pitch": int(pitch),
        "start": float(start),
        "end": float(end),
        "velocity": int(max(1, min(127, velocity))),
    }


def make_pad(chord_tones, start, dur, velocity, timbre='warm_pad'):
    """和声垫：多音同时长按（timbre 由调用侧决定合成用哪种）"""
    return [_note(p, start, start + dur, velocity) for p in chord_tones]


def make_arpeggio(chord_tones, start, dur, step, velocity, timbre='harp',
                  pattern='up', vel_jitter=6):
    """
    琶音织体：按 pattern 遍历 chord_tones，每音 step 秒。
    patterns: 'up', 'down', 'updown', 'random_walk', 'broken' (1-3-2-4)
    """
    notes = []
    tones = list(chord_tones)
    if pattern == 'down':
        tones = tones[::-1]
    elif pattern == 'updown':
        tones = tones + tones[-2:0:-1]
    elif pattern == 'broken' and len(tones) >= 4:
        tones = [tones[0], tones[2], tones[1], tones[3]]

    t = start
    idx = 0
    end = start + dur
    while t < end:
        if pattern == 'random_walk':
            p = tones[_RNG.integers(0, len(tones))]
        else:
            p = tones[idx % len(tones)]
        note_end = min(t + step * 0.95, end)
        v = velocity + int(_RNG.integers(-vel_jitter, vel_jitter + 1))
        notes.append(_note(p, t, note_end, v))
        t += step
        idx += 1
    return notes


def make_melody(pitches_rhythms, start, base_vel, vel_curve=None, vel_jitter=4):
    """
    主旋律：pitches_rhythms = [(pitch, duration), ...]
    vel_curve: 每音相对 base_vel 的偏移；vel_jitter 加随机
    """
    notes = []
    t = start
    for i, (p, d) in enumerate(pitches_rhythms):
        v = base_vel + (vel_curve[i] if vel_curve and i < len(vel_curve) else 0)
        v += int(_RNG.integers(-vel_jitter, vel_jitter + 1))
        notes.append(_note(p, t, t + d * 0.98, v))
        t += d
    return notes


def make_bass_line(roots, start, seg_dur, base_vel, walk_up=True):
    """贝斯：每 seg_dur 一个根音，可加走位过渡音"""
    notes = []
    for i, root in enumerate(roots):
        t = start + i * seg_dur
        notes.append(_note(root, t, t + seg_dur * 0.7, base_vel))
        if walk_up and i < len(roots) - 1:
            next_root = roots[i+1]
            diff = next_root - root
            if abs(diff) >= 3:
                walk = root + (diff // 2)
                notes.append(_note(walk, t + seg_dur * 0.75, t + seg_dur * 0.95,
                                   base_vel - 8))
    return notes
