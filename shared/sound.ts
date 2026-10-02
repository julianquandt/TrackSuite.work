// Chime synthesis without Web Audio: notes are rendered to PCM samples and
// wrapped in a WAV file, which an ordinary <audio> element plays. (Web Audio
// went silent after the first chime in WebKitGTK.) Pure code: runs in the
// apps and in Node (to listen to the sounds while designing them).

export type ChimeSound = "marimba" | "glass" | "wood";
export type ChimeKind = "focus-done" | "break-done";

export const CHIME_SOUNDS: { key: ChimeSound; label: string }[] = [
    { key: "marimba", label: "Marimba" },
    { key: "glass", label: "Glass bell" },
    { key: "wood", label: "Wood" },
];

type Partial = { mult: number; amp: number; decay: number }; // decay: seconds to 1/e
type Note = { freq: number; at: number; gain: number };

const RATE = 44_100;

// Instruments: the overtones decay faster than the fundamental, which keeps
// the tone warm (no lingering metallic ring).
const VOICES: Record<ChimeSound, { partials: Partial[]; attack: number; tail: number }> = {
    // Mallet on a wooden bar: fundamental + the bar's two-octaves-up mode.
    marimba: { partials: [{ mult: 1, amp: 1, decay: 0.5 }, { mult: 4, amp: 0.1, decay: 0.07 }, { mult: 10, amp: 0.02, decay: 0.02 }], attack: 0.004, tail: 1.6 },
    // Soft glass/bell: harmonic partials only, longer and rounder.
    glass: { partials: [{ mult: 1, amp: 1, decay: 1.1 }, { mult: 2, amp: 0.22, decay: 0.55 }, { mult: 3, amp: 0.07, decay: 0.3 }], attack: 0.008, tail: 2.2 },
    // Short, dry, woody pluck (kalimba-like).
    wood: { partials: [{ mult: 1, amp: 1, decay: 0.28 }, { mult: 2, amp: 0.12, decay: 0.12 }, { mult: 5.9, amp: 0.04, decay: 0.03 }], attack: 0.003, tail: 1.1 },
};

const C5 = 523.25, D5 = 587.33, E5 = 659.25, G5 = 783.99, A5 = 880.0, B5 = 987.77;

// End of focus rises (time to rest); end of break falls (back to work).
const MELODIES: Record<ChimeSound, Record<ChimeKind, Note[]>> = {
    marimba: {
        "focus-done": [{ freq: C5, at: 0, gain: 0.9 }, { freq: E5, at: 0.14, gain: 0.8 }, { freq: G5, at: 0.28, gain: 0.85 }],
        "break-done": [{ freq: G5, at: 0, gain: 0.85 }, { freq: E5, at: 0.14, gain: 0.8 }, { freq: C5, at: 0.28, gain: 0.9 }],
    },
    glass: {
        "focus-done": [{ freq: E5, at: 0, gain: 0.8 }, { freq: B5, at: 0.2, gain: 0.6 }],
        "break-done": [{ freq: B5, at: 0, gain: 0.6 }, { freq: E5, at: 0.2, gain: 0.8 }],
    },
    wood: {
        "focus-done": [{ freq: D5, at: 0, gain: 0.9 }, { freq: A5, at: 0.12, gain: 0.75 }],
        "break-done": [{ freq: A5, at: 0, gain: 0.75 }, { freq: D5, at: 0.12, gain: 0.9 }],
    },
};

/** Render a chime to mono float samples in [-1, 1]. */
export function renderChime(sound: ChimeSound, kind: ChimeKind): Float32Array {
    const voice = VOICES[sound];
    const notes = MELODIES[sound][kind];
    const length = Math.ceil((Math.max(...notes.map((n) => n.at)) + voice.tail) * RATE);
    const out = new Float32Array(length);
    for (const n of notes) {
        const start = Math.round(n.at * RATE);
        for (let i = start; i < length; i++) {
            const t = (i - start) / RATE;
            const attack = 1 - Math.exp(-t / voice.attack);
            let v = 0;
            for (const p of voice.partials) v += p.amp * Math.exp(-t / p.decay) * Math.sin(2 * Math.PI * n.freq * p.mult * t);
            out[i] += n.gain * attack * v;
        }
    }
    // A little room: three quiet early reflections, then a gentle low-pass.
    const room = new Float32Array(length);
    for (const [delay, level] of [[0.083, 0.14], [0.137, 0.09], [0.211, 0.05]]) {
        const d = Math.round(delay * RATE);
        for (let i = d; i < length; i++) room[i] += out[i - d] * level;
    }
    let lp = 0;
    const k = 1 - Math.exp((-2 * Math.PI * 4500) / RATE);
    let peak = 0;
    for (let i = 0; i < length; i++) {
        lp += k * (out[i] + room[i] - lp);
        out[i] = lp;
        peak = Math.max(peak, Math.abs(lp));
    }
    // Quiet by design: peak at about -10 dBFS, with a short fade at the end.
    const scale = peak > 0 ? 0.32 / peak : 0;
    const fade = Math.round(0.05 * RATE);
    for (let i = 0; i < length; i++) {
        const f = i > length - fade ? (length - i) / fade : 1;
        out[i] *= scale * f;
    }
    return out;
}

/** 16-bit mono PCM WAV file bytes. */
export function encodeWav(samples: Float32Array, rate = RATE): Uint8Array {
    const bytes = new Uint8Array(44 + samples.length * 2);
    const view = new DataView(bytes.buffer);
    const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i); };
    str(0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    str(8, "WAVE");
    str(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    str(36, "data");
    view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
        view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
    }
    return bytes;
}
