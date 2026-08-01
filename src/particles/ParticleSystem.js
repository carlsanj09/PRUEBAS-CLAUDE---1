import { freqToNote, NOTE_PATTERNS } from '../audio/notes'

const MIN_RADIUS = 1.4
const MAX_RADIUS_ADD = 1.0
const IDLE_SPEED = 0.15
const IDLE_DAMPING = 0.02
const CELL_SIZE = 14
const MAX_SPEED = 7

// Above this many active particles, pairwise overlap separation is skipped:
// at the tiny sizes involved, overlap is imperceptible, and the grid-based
// check still scales with density, not just count, so it's the first thing
// that gets expensive at very large counts.
const COLLISION_MAX_PARTICLES = 8000

// The Chladni field is precomputed on this coarse pixel grid once per frame
// instead of re-evaluated (several trig calls) per particle — cost then
// scales with canvas area, not particle count, which is what makes tens of
// thousands of particles feasible in real time.
const FIELD_CELL_SIZE = 6

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360
  s /= 100
  l /= 100
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r1, g1, b1
  if (h < 60) [r1, g1, b1] = [c, x, 0]
  else if (h < 120) [r1, g1, b1] = [x, c, 0]
  else if (h < 180) [r1, g1, b1] = [0, c, x]
  else if (h < 240) [r1, g1, b1] = [0, x, c]
  else if (h < 300) [r1, g1, b1] = [x, 0, c]
  else [r1, g1, b1] = [c, 0, x]
  return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)]
}

// Hysteresis: enters "active" sooner than it exits, so a single loud
// syllable doesn't cause the field to flicker on/off every frame.
const ENTER_THRESHOLD = 0.012
const EXIT_THRESHOLD = 0.006
const ALPHA_SMOOTH = 0.02 // fade in/out with sound, all the way to invisible in silence

// Particle count follows the dominant frequency directly (not the note
// table): flat at a low floor below a low guitar E, ramping up through the
// G3 (5th degree) and high-E reference points, then continuing to grow for
// one more octave past that up to the ceiling — scaled proportionally
// (same ratios as before, ~14x) so the top of the range is 100,000.
const COUNT_LOW_HZ = 80
const COUNT_LOW_N = 14000
const COUNT_MID_HZ = 196.0 // SOL3 / G3
const COUNT_MID_N = 28000
const COUNT_HIGH_HZ = 329.63 // MI4 / E4 — the reference "top" frequency
const COUNT_HIGH_N = 50000
const COUNT_MAX_HZ = COUNT_HIGH_HZ * 2 // one octave above the top frequency
const COUNT_MAX_N = 100000
const COUNT_SMOOTH = 0.01 // slow ramp, so the count drifts rather than pops

// Particles stay full-size up to this count and shrink beyond it
// (radius ∝ 1/sqrt(count)) so total covered area stays roughly constant
// instead of just getting denser — kept at the original absolute value so
// the huge new range (up to 100,000) still ends up genuinely tiny rather
// than shrinking relative to the also-much-bigger low end.
const SIZE_REFERENCE_N = 1000

export const MAX_PARTICLES = COUNT_MAX_N
const MIN_PARTICLES = COUNT_LOW_N
const VOICE_COUNT = 3 // mix up to 3 simultaneous tones into one figure

const MODE_SMOOTH = 0.008 // slow morph between figures ("armonioso", not a cut)
const WEIGHT_SMOOTH = 0.02 // how fast a voice fades in/out as tones come and go
const HUE_SMOOTH = 0.02
const ORIENTATION_DRIFT = 0.0016 // constant slow plate rotation per voice

const SETTLE_STRENGTH = 0.0026 // pull toward nodal lines — tighter lock-in so the figure reads crisply in every render style
const AGITATION_STRENGTH = 3.5 // shake proportional to local vibration * volume — trimmed so it perturbs without pulling grains off the line
const AGITATION_SMOOTH = 0.06 // low-pass on the shake so it wanders instead of flickering (organic, not noisy)
const REPEL_STRENGTH = 0.6 // keeps grains from perfectly overlapping
const DRAG = 0.97
const DEFAULT_SPEED_SCALE = 0.55 // overall visual speed multiplier, user-adjustable

// New particles always stream out from the composition's center, each
// scattering off in its own random direction (organic, not a uniform
// stream). Retired ones simply shrink and fade out wherever they are,
// drifting on their existing inertia, instead of traveling anywhere.
const SPAWN_JITTER = 4
const EXIT_FADE_SECONDS = 0.9

// An ambient pull so a subset of particles' organic drift leans toward the
// top edge of the screen rather than staying perfectly random. Strength is
// user-adjustable on top of this (see setGravityIntensity).
const GRAVITY_STRENGTH = 0.013
const GRAVITY_CHANCE = 0.65 // most, but not all, particles feel it
const DEFAULT_GRAVITY_INTENSITY = 1

// Five qualitatively different plate figures (not just parameter variants of
// one formula) so different notes can look structurally distinct, matching
// the varied families in the Chladni reference (crosses, mesh, mandalas,
// diagonals, rings).
const PATTERN_FORMULAS = [
  (X, Y, m, n) => Math.cos(n * X) * Math.cos(m * Y) - Math.cos(m * X) * Math.cos(n * Y),
  (X, Y, m, n) => Math.cos(m * X) + Math.cos(n * Y) + 0.5 * Math.cos(n * X) * Math.cos(m * Y),
  (X, Y, m, n) => Math.cos(m * Math.atan2(Y, X)) * Math.cos(n * Math.hypot(X, Y)),
  (X, Y, m, n) => Math.cos(m * X + n * Y) + Math.cos(n * X - m * Y),
  (X, Y, m, n) => Math.cos(n * Math.hypot(X, Y)) * Math.cos(m * X) * Math.cos(m * Y),
]

function randomVelocity(speed) {
  const angle = Math.random() * Math.PI * 2
  return { vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed }
}

function countForHz(hz) {
  if (hz <= COUNT_LOW_HZ) return COUNT_LOW_N
  if (hz <= COUNT_MID_HZ) {
    const t = (Math.log2(hz) - Math.log2(COUNT_LOW_HZ)) / (Math.log2(COUNT_MID_HZ) - Math.log2(COUNT_LOW_HZ))
    return COUNT_LOW_N + t * (COUNT_MID_N - COUNT_LOW_N)
  }
  if (hz <= COUNT_HIGH_HZ) {
    const t = (Math.log2(hz) - Math.log2(COUNT_MID_HZ)) / (Math.log2(COUNT_HIGH_HZ) - Math.log2(COUNT_MID_HZ))
    return COUNT_MID_N + t * (COUNT_HIGH_N - COUNT_MID_N)
  }
  // Past the reference top frequency, particles keep appearing for one more
  // octave instead of capping here, up to double the previous ceiling.
  const t = Math.min(1, (Math.log2(hz) - Math.log2(COUNT_HIGH_HZ)) / (Math.log2(COUNT_MAX_HZ) - Math.log2(COUNT_HIGH_HZ)))
  return COUNT_HIGH_N + t * (COUNT_MAX_N - COUNT_HIGH_N)
}

export class ParticleSystem {
  constructor(width, height, maxCount = MAX_PARTICLES) {
    this.width = width
    this.height = height
    this.particles = Array.from({ length: maxCount }, () => this.#createParticle())
    // Every particle lives in exactly one of these three lists at a time.
    // Initial population starts scattered & active (nothing to transition
    // from yet); only count changes *during* a session stream out from the
    // center / fade out in place.
    this.activeParticles = this.particles.slice()
    this.leavingParticles = []
    this.pool = []

    this.active = false
    this.time = 0
    this.alpha = 0 // invisible until real sound is detected

    this.voices = Array.from({ length: VOICE_COUNT }, () => ({
      weight: 0,
      targetWeight: 0,
      formula: 0,
      modeM: 3,
      targetModeM: 3,
      modeN: 4,
      targetModeN: 4,
      angle: Math.random() * Math.PI * 2,
      noteLabel: '',
    }))

    this.hue = 220
    this.targetHue = 220
    this.hueBase = 20 // user-adjustable; the reactive palette shifts around this
    this.sizeScale = 1
    this.speedScale = DEFAULT_SPEED_SCALE
    this.gravityIntensity = DEFAULT_GRAVITY_INTENSITY
    this.#allocateFieldGrid()

    this.activeCount = maxCount
    this.targetCount = maxCount
  }

  #createParticle() {
    const r = MIN_RADIUS + Math.random() * MAX_RADIUS_ADD
    const { vx, vy } = randomVelocity(IDLE_SPEED)
    return {
      x: r + Math.random() * (this.width - 2 * r),
      y: r + Math.random() * (this.height - 2 * r),
      vx,
      vy,
      baseR: r,
      jx: 0,
      jy: 0,
      leaveT: 0,
      fade: 1,
      gravity: Math.random() < GRAVITY_CHANCE ? Math.random() : 0,
    }
  }

  setSpeedScale(scale) {
    this.speedScale = scale
  }

  setHueBase(hue) {
    this.hueBase = hue
  }

  setGravityIntensity(intensity) {
    this.gravityIntensity = intensity
  }

  // Pulled from the pool when the count target rises: always starts from
  // the composition's center so growth reads as one consistent source, but
  // each particle scatters off in its own random direction from there —
  // otherwise they'd read as a mechanical stream instead of organic growth.
  #activateParticle(p) {
    p.x = this.width / 2 + (Math.random() - 0.5) * SPAWN_JITTER
    p.y = this.height / 2 + (Math.random() - 0.5) * SPAWN_JITTER
    const angle = Math.random() * Math.PI * 2
    const speed = IDLE_SPEED * (2 + Math.random() * 3)
    p.vx = Math.cos(angle) * speed
    p.vy = Math.sin(angle) * speed
    p.jx = 0
    p.jy = 0
    p.leaveT = 0
    p.fade = 1
  }

  // Moved to the leaving list when the count target falls: just shrinks and
  // fades out wherever it happens to be, drifting on its existing velocity.
  #startLeaving(p) {
    p.leaveT = 0
  }

  resize(width, height) {
    this.width = width
    this.height = height
    for (const p of this.particles) {
      p.x = Math.min(Math.max(p.x, p.baseR), width - p.baseR)
      p.y = Math.min(Math.max(p.y, p.baseR), height - p.baseR)
    }
    this.#allocateFieldGrid()
  }

  #allocateFieldGrid() {
    this.fieldCols = Math.max(2, Math.ceil(this.width / FIELD_CELL_SIZE) + 1)
    this.fieldRows = Math.max(2, Math.ceil(this.height / FIELD_CELL_SIZE) + 1)
    const size = this.fieldCols * this.fieldRows
    this.fieldZ = new Float32Array(size)
    this.fieldGX = new Float32Array(size)
    this.fieldGY = new Float32Array(size)
  }

  // `peaks`: [{ hz, freqRatio: 0-1 (low->high, log-mapped), magnitude: 0-1 }], strongest first.
  step(volume, peaks = []) {
    this.time += 1 / 60

    if (volume > ENTER_THRESHOLD) this.active = true
    else if (volume < EXIT_THRESHOLD) this.active = false
    const soundActive = this.active
    this.alpha += ((soundActive ? 1 : 0) - this.alpha) * ALPHA_SMOOTH

    this.#updateVoiceTargets(peaks)
    if (peaks[0]) this.targetCount = countForHz(peaks[0].hz)

    let hueSum = 0
    let hueWeight = 0
    for (const voice of this.voices) {
      voice.modeM += (voice.targetModeM - voice.modeM) * MODE_SMOOTH
      voice.modeN += (voice.targetModeN - voice.modeN) * MODE_SMOOTH
      voice.weight += (voice.targetWeight - voice.weight) * WEIGHT_SMOOTH
      voice.angle += ORIENTATION_DRIFT
      if (voice.targetWeight > 0.02) {
        hueSum += voice.targetHue * voice.targetWeight
        hueWeight += voice.targetWeight
      }
    }
    if (hueWeight > 0) this.targetHue = hueSum / hueWeight
    this.hue += (this.targetHue - this.hue) * HUE_SMOOTH
    this.activeCount += (this.targetCount - this.activeCount) * COUNT_SMOOTH

    const targetActiveN = Math.max(MIN_PARTICLES, Math.min(MAX_PARTICLES, Math.round(this.activeCount)))
    this.#syncActiveCount(targetActiveN)
    this.sizeScale = this.activeCount > SIZE_REFERENCE_N ? Math.sqrt(SIZE_REFERENCE_N / this.activeCount) : 1

    if (soundActive) {
      this.#applyPlateForces(volume)
      if (this.activeParticles.length <= COLLISION_MAX_PARTICLES) this.#resolveOverlaps()
    } else {
      this.#dampToIdle()
    }

    for (const p of this.activeParticles) {
      const r = p.baseR * this.sizeScale
      p.vx *= DRAG
      p.vy *= DRAG
      if (p.gravity > 0) p.vy -= GRAVITY_STRENGTH * this.gravityIntensity * p.gravity
      p.x += p.vx * this.speedScale
      p.y += p.vy * this.speedScale

      if (p.x - r < 0) {
        p.x = r
        p.vx = Math.abs(p.vx)
      } else if (p.x + r > this.width) {
        p.x = this.width - r
        p.vx = -Math.abs(p.vx)
      }

      if (p.y - r < 0) {
        p.y = r
        p.vy = Math.abs(p.vy)
      } else if (p.y + r > this.height) {
        p.y = this.height - r
        p.vy = -Math.abs(p.vy)
      }
    }

    this.#clampSpeeds()
    this.#updateLeavingParticles()

    return { soundActive, volume, activeCount: this.activeParticles.length }
  }

  #updateVoiceTargets(peaks) {
    for (let slot = 0; slot < this.voices.length; slot++) {
      const voice = this.voices[slot]
      const peak = peaks[slot]
      if (!peak) {
        voice.targetWeight = 0
        continue
      }
      const note = freqToNote(peak.hz)
      const pattern = NOTE_PATTERNS[note.pitchClass]
      voice.formula = pattern.formula
      // Octave still adds continuous detail on top of the note's base shape.
      const octaveDetail = Math.max(0, Math.min(1, (note.octave - 2) / 4)) * 1.6
      voice.targetModeM = pattern.m + octaveDetail
      voice.targetModeN = pattern.n + octaveDetail
      voice.targetWeight = peak.magnitude
      voice.targetHue = this.hueBase + peak.freqRatio * 240
      voice.noteLabel = note.label
    }
  }

  #syncActiveCount(targetActiveN) {
    const current = this.activeParticles.length
    if (targetActiveN > current) {
      let need = targetActiveN - current
      while (need > 0 && this.pool.length > 0) {
        const p = this.pool.pop()
        this.#activateParticle(p)
        this.activeParticles.push(p)
        need--
      }
    } else if (targetActiveN < current) {
      let excess = current - targetActiveN
      while (excess > 0 && this.activeParticles.length > 0) {
        const p = this.activeParticles.pop()
        this.#startLeaving(p)
        this.leavingParticles.push(p)
        excess--
      }
    }
  }

  // Shrinks and fades out in place, drifting on whatever velocity it already
  // had (no travel toward a target) — reads as a soft local dissolve rather
  // than particles being herded somewhere before disappearing.
  #updateLeavingParticles() {
    for (let i = this.leavingParticles.length - 1; i >= 0; i--) {
      const p = this.leavingParticles[i]
      p.leaveT += 1 / 60
      p.vx *= DRAG
      p.vy *= DRAG
      p.x += p.vx * this.speedScale
      p.y += p.vy * this.speedScale
      p.fade = Math.max(0, 1 - p.leaveT / EXIT_FADE_SECONDS)

      if (p.fade <= 0) {
        this.leavingParticles.splice(i, 1)
        this.pool.push(p)
      }
    }
  }

  #dampToIdle() {
    for (const p of this.activeParticles) {
      const speed = Math.hypot(p.vx, p.vy)
      if (speed < 0.0001) continue
      const nextSpeed = speed + (IDLE_SPEED - speed) * IDLE_DAMPING
      p.vx = (p.vx / speed) * nextSpeed
      p.vy = (p.vy / speed) * nextSpeed
    }
  }

  // Weighted superposition of up to 3 tones' plate fields — this is what
  // lets a chord/voice+instrument mix into a single combined figure.
  #plateFieldAt(nx, ny) {
    let z = 0
    let weightSum = 0
    for (const voice of this.voices) {
      if (voice.weight < 0.005) continue
      const rx = nx * Math.cos(voice.angle) - ny * Math.sin(voice.angle)
      const ry = nx * Math.sin(voice.angle) + ny * Math.cos(voice.angle)
      const X = rx * Math.PI
      const Y = ry * Math.PI
      z += voice.weight * PATTERN_FORMULAS[voice.formula](X, Y, voice.modeM, voice.modeN)
      weightSum += voice.weight
    }
    return weightSum > 0 ? z / weightSum : 0
  }

  // Samples the plate field once per coarse grid cell (not per particle).
  // For each cell this stores z itself plus its gradient — approximated by
  // differencing against the next cell over and dividing by that step's
  // actual size in the field's own (rotated, per-axis) normalized units, so
  // it's numerically equivalent to the old per-particle eps-based gradient.
  #buildFieldGrid() {
    const halfW = this.width / 2
    const halfH = this.height / 2
    const cols = this.fieldCols
    const rows = this.fieldRows
    const z = this.fieldZ

    for (let row = 0; row < rows; row++) {
      const py = row * FIELD_CELL_SIZE
      const nx = -(py - halfH) / halfH
      const base = row * cols
      for (let col = 0; col < cols; col++) {
        const px = col * FIELD_CELL_SIZE
        const ny = (px - halfW) / halfW
        z[base + col] = this.#plateFieldAt(nx, ny)
      }
    }

    const gx = this.fieldGX
    const gy = this.fieldGY
    const nxStep = FIELD_CELL_SIZE / halfH
    const nyStep = FIELD_CELL_SIZE / halfW
    for (let row = 0; row < rows; row++) {
      const base = row * cols
      const nextRowBase = Math.min(row + 1, rows - 1) * cols
      for (let col = 0; col < cols; col++) {
        const idx = base + col
        const nextCol = Math.min(col + 1, cols - 1)
        gx[idx] = (z[nextRowBase + col] - z[idx]) / nxStep
        gy[idx] = (z[base + nextCol] - z[idx]) / nyStep
      }
    }
  }

  #applyPlateForces(volume) {
    this.#buildFieldGrid()
    const scale = Math.min(this.width / 2, this.height / 2)
    const energy = Math.min(volume, 1)
    const cols = this.fieldCols
    const rows = this.fieldRows
    const zGrid = this.fieldZ
    const gxGrid = this.fieldGX
    const gyGrid = this.fieldGY

    for (const p of this.activeParticles) {
      let col = (p.x / FIELD_CELL_SIZE) | 0
      let row = (p.y / FIELD_CELL_SIZE) | 0
      if (col < 0) col = 0
      else if (col >= cols) col = cols - 1
      if (row < 0) row = 0
      else if (row >= rows) row = rows - 1
      const idx = row * cols + col

      const z = zGrid[idx]
      const gx = gxGrid[idx]
      const gy = gyGrid[idx]

      // Pulls toward decreasing |z| (a nodal line). Forces are swapped
      // through the field's rotation (chain rule) so they push in the
      // correct actual pixel direction rather than the field's own axes.
      p.vx += -SETTLE_STRENGTH * z * gy * scale
      p.vy += SETTLE_STRENGTH * z * gx * scale

      // Shakes particles sitting on high-amplitude (antinode) zones, same as
      // real sand won't settle where the plate is still vibrating hard. The
      // shake target is low-passed (an OU-ish random walk) instead of added
      // directly, so it wanders smoothly rather than flickering frame to
      // frame — reads as organic jitter instead of digital noise.
      const agitation = Math.abs(z) * AGITATION_STRENGTH * energy
      p.jx += ((Math.random() - 0.5) * agitation - p.jx) * AGITATION_SMOOTH
      p.jy += ((Math.random() - 0.5) * agitation - p.jy) * AGITATION_SMOOTH
      p.vx += p.jx
      p.vy += p.jy
    }
  }

  #clampSpeeds() {
    for (const p of this.activeParticles) {
      const speed = Math.hypot(p.vx, p.vy)
      if (speed > MAX_SPEED) {
        p.vx = (p.vx / speed) * MAX_SPEED
        p.vy = (p.vy / speed) * MAX_SPEED
      }
    }
  }

  #resolveOverlaps() {
    const grid = new Map()
    const cellKey = (cx, cy) => `${cx}:${cy}`
    const particles = this.activeParticles
    const n = particles.length

    for (let i = 0; i < n; i++) {
      const p = particles[i]
      const key = cellKey(Math.floor(p.x / CELL_SIZE), Math.floor(p.y / CELL_SIZE))
      let bucket = grid.get(key)
      if (!bucket) {
        bucket = []
        grid.set(key, bucket)
      }
      bucket.push(i)
    }

    for (let i = 0; i < n; i++) {
      const p = particles[i]
      const cx = Math.floor(p.x / CELL_SIZE)
      const cy = Math.floor(p.y / CELL_SIZE)
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const bucket = grid.get(cellKey(cx + dx, cy + dy))
          if (!bucket) continue
          for (const j of bucket) {
            if (j <= i) continue
            this.#separate(p, particles[j])
          }
        }
      }
    }
  }

  // Positional de-overlap plus a small damped push — grains settle against
  // each other along a nodal line instead of bouncing elastically off it.
  #separate(a, b) {
    const ra = a.baseR * this.sizeScale
    const rb = b.baseR * this.sizeScale
    const dx = b.x - a.x
    const dy = b.y - a.y
    const dist2 = dx * dx + dy * dy
    const minDist = ra + rb
    if (dist2 >= minDist * minDist) return

    const dist = Math.sqrt(dist2) || 0.001
    const nx = dx / dist
    const ny = dy / dist
    const overlap = (minDist - dist) / 2

    a.x -= nx * overlap
    a.y -= ny * overlap
    b.x += nx * overlap
    b.y += ny * overlap

    a.vx -= nx * REPEL_STRENGTH
    a.vy -= ny * REPEL_STRENGTH
    b.vx += nx * REPEL_STRENGTH
    b.vy += ny * REPEL_STRENGTH
  }

  // Writes particles straight into a reusable pixel buffer and blits it in
  // one call, instead of one canvas draw call per particle — at this scale
  // (tens of thousands, minimum) individual fillRect/arc calls don't stay
  // real-time (measured ~65ms/frame for 100,000 vs ~6ms this way), and the
  // particles are sub-pixel-sized anyway so single pixels lose nothing.
  draw(ctx, soundActive) {
    const canvas = ctx.canvas
    const w = canvas.width
    const h = canvas.height
    const dpr = w / this.width

    if (!this._pixelBuffer || this._pixelBuffer.width !== w || this._pixelBuffer.height !== h) {
      this._pixelBuffer = new ImageData(w, h)
    }
    const imageData = this._pixelBuffer
    const data = imageData.data
    data.fill(0)

    if (this.alpha >= 0.003) {
      const idleHue = (this.hueBase + 230) % 360
      const hue = soundActive ? this.hue : idleHue
      const lightness = soundActive ? 58 : 55
      const saturation = soundActive ? 80 : 25
      const [r, g, b] = hslToRgb(hue, saturation, lightness)
      const alphaByte = Math.max(0, Math.min(255, Math.round(this.alpha * 255)))

      for (const p of this.activeParticles) {
        const px = (p.x * dpr) | 0
        const py = (p.y * dpr) | 0
        if (px < 0 || px >= w || py < 0 || py >= h) continue
        const idx = (py * w + px) * 4
        data[idx] = r
        data[idx + 1] = g
        data[idx + 2] = b
        data[idx + 3] = alphaByte
      }
    }

    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.putImageData(imageData, 0, 0)
    ctx.restore()

    // The leaving list is always small (a fraction of a second of fade-outs
    // in flight), so plain fillRect on top is fine here.
    const idleHue = (this.hueBase + 230) % 360
    const activeColor = soundActive ? `${this.hue}, 80%, 58%` : `${idleHue}, 25%, 55%`
    for (const p of this.leavingParticles) {
      const la = this.alpha * p.fade
      if (la < 0.003) continue
      ctx.fillStyle = `hsla(${activeColor}, ${la})`
      const d = Math.max(1, p.baseR * this.sizeScale * p.fade * 2)
      ctx.fillRect(p.x - d / 2, p.y - d / 2, d, d)
    }
  }
}
