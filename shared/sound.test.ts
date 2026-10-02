import { test } from "node:test";
import assert from "node:assert/strict";
import { CHIME_SOUNDS, encodeWav, renderChime } from "./sound.ts";

test("every chime renders quietly and without clipping", () => {
    for (const { key } of CHIME_SOUNDS) {
        for (const kind of ["focus-done", "break-done"] as const) {
            const s = renderChime(key, kind);
            const peak = s.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
            assert.ok(peak > 0.2 && peak <= 0.33, `${key}/${kind} peak ${peak}`);
            assert.ok(s.length / 44100 < 3, "short");
            assert.ok(Math.abs(s[s.length - 1]) < 1e-3, "ends silent");
        }
    }
});

test("WAV header is valid PCM", () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -0.5]));
    assert.equal(String.fromCharCode(...wav.slice(0, 4)), "RIFF");
    assert.equal(String.fromCharCode(...wav.slice(8, 12)), "WAVE");
    assert.equal(wav.length, 44 + 6);
});
