const NOTE_NAMES = ['DO', 'DO#', 'RE', 'RE#', 'MI', 'FA', 'FA#', 'SOL', 'SOL#', 'LA', 'LA#', 'SI']

// Standard equal temperament, A4 = 440Hz. Returns the nearest note, its
// octave, and how many cents the input frequency deviates from it — i.e.
// "what tuning/pitch is this sound in", not just a raw Hz number.
export function freqToNote(hz) {
  if (!hz || hz <= 0) return null
  const midi = 69 + 12 * Math.log2(hz / 440)
  const rounded = Math.round(midi)
  const pitchClass = ((rounded % 12) + 12) % 12
  const octave = Math.floor(rounded / 12) - 1
  return {
    name: NOTE_NAMES[pitchClass],
    pitchClass,
    octave,
    midi: rounded,
    cents: (midi - rounded) * 100,
    label: `${NOTE_NAMES[pitchClass]}${octave}`,
  }
}

// One qualitatively distinct figure per pitch class — a plate formula (see
// PATTERN_FORMULAS in ParticleSystem.js) plus its base mode numbers — so DO
// and RE don't just look like the same shape at a different zoom level.
// Octave still refines detail continuously on top of this recipe.
export const NOTE_PATTERNS = [
  { formula: 0, m: 2, n: 3.2 }, // DO  — simple cross, few loops
  { formula: 1, m: 3, n: 3.6 }, // DO#
  { formula: 0, m: 3, n: 4.4 }, // RE  — denser cross-grid
  { formula: 3, m: 3.3, n: 5 }, // RE#
  { formula: 2, m: 4, n: 2.4 }, // MI  — radial/mandala
  { formula: 1, m: 4, n: 5.2 }, // FA  — woven mesh
  { formula: 3, m: 4.4, n: 6 }, // FA#
  { formula: 0, m: 5, n: 6.3 }, // SOL — reference tone, intricate grid
  { formula: 4, m: 5, n: 3.4 }, // SOL#
  { formula: 2, m: 6, n: 4.2 }, // LA  — dense mandala
  { formula: 1, m: 6, n: 7 }, // LA#
  { formula: 3, m: 7, n: 5.4 }, // SI  — fine diagonal interference
]
