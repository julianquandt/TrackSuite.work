// Plays the focus-timer chime: a WAV rendered once per sound (shared/sound.ts)
// and played through a plain <audio> element, fresh for every play, so it
// keeps working (Web Audio went silent after the first play in WebKitGTK).

import { encodeWav, renderChime, type ChimeKind, type ChimeSound } from "../sound.ts";

const urls = new Map<string, string>();

function urlFor(sound: ChimeSound, kind: ChimeKind): string {
    const key = `${sound}:${kind}`;
    let url = urls.get(key);
    if (!url) {
        const wav = encodeWav(renderChime(sound, kind));
        url = URL.createObjectURL(new Blob([wav.buffer as ArrayBuffer], { type: "audio/wav" }));
        urls.set(key, url);
    }
    return url;
}

export function playChime(sound: ChimeSound | "off", kind: ChimeKind = "focus-done"): void {
    if (sound === "off") return;
    try {
        const audio = new Audio(urlFor(sound, kind));
        void audio.play().catch(() => { /* blocked or no audio device: stay silent */ });
    } catch {
        /* no audio support */
    }
}
