#!/usr/bin/env python3
"""Render original, deterministic modal-synthesis kalimba fixtures; no recorded samples."""
from pathlib import Path
import hashlib, json, math, random, re, struct, wave

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public' / 'audio'
OUT.mkdir(parents=True, exist_ok=True)
content = (ROOT / 'src' / 'domain' / 'content.ts').read_text()
MIDIS = json.loads(re.search(r'export const physicalMidi = (\[[^\]]+\])', content).group(1))
RATE = 22050
DURATION = 4
entries = []
for physical_index, midi in enumerate(MIDIS, 1):
    rng = random.Random(2100 + midi)
    freq = 440 * 2 ** ((midi - 69) / 12)
    values = []
    # A long fundamental plus quickly decaying, inharmonic tine modes.
    modes = [(1, .70, 1.25), (2.756, .24, .42), (5.404, .115, .19), (8.933, .055, .10)]
    for n in range(RATE * DURATION):
        t = n / RATE
        y = sum(amp * math.sin(math.tau * freq * ratio * t) * math.exp(-t / decay)
                for ratio, amp, decay in modes if freq * ratio < RATE * .46)
        y += (rng.random() * 2 - 1) * .045 * math.exp(-t / .004)
        attack = min(1, t / .0008)
        tail = min(1, max(0, (DURATION - t) / .06))
        values.append(y * attack * tail)
    mean = sum(values) / len(values)
    peak = max(abs(v - mean) for v in values)
    pcm = b''.join(struct.pack('<h', round((v - mean) / peak * .68 * 32767)) for v in values)
    path = OUT / f'{midi}.wav'
    with wave.open(str(path), 'wb') as f:
        f.setnchannels(1); f.setsampwidth(2); f.setframerate(RATE); f.writeframes(pcm)
    entries.append({'keyId': f'k{physical_index:02}', 'midi': midi, 'url': f'/audio/{midi}.wav', 'frequencyHz': round(freq, 6),
                    'attackOffsetSec': 0, 'durationSec': DURATION, 'sampleRate': RATE,
                    'channels': 1, 'bytes': path.stat().st_size,
                    'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
manifest = {'version': 1, 'kind': 'original-procedural-modal-synthesis', 'recorded': False,
            'description': 'Original deterministic modal-synthesis kalimba sound. Not a real instrument recording.',
            'source': 'scripts/generate-audio.py; generated for this project without third-party samples',
            'license': 'Original project-generated audio, no third-party sample restrictions',
            'releaseGap': 'Real recorded kalimba timbre and physical-device listening remain unverified.',
            'totalTransferBytes': sum(e['bytes'] for e in entries),
            'decodedBytesAt22050': len(MIDIS) * RATE * DURATION * 4,
            'samples': entries}
(OUT / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
print(f'Rendered {len(entries)} original procedural notes: {manifest["totalTransferBytes"]:,} bytes')
