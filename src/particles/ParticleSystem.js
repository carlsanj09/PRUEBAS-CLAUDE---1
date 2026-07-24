import { freqToNote, NOTE_PATTERNS } from '../audio/notes'

const MIN_RADIUS = 2.2
const MAX_RADIUS_ADD = 1.8
const IDLE_SPEED = 0.15
const IDLE_DAMPING = 0.02
const CELL_SIZE = 14
const MAX_SPEED = 7

// Hysteresis: enters "active" sooner than it exits, so a single loud
// syllable doesn't cause the field to flicker on/off every frame.
const ENTER_THRESHOLD = 0.012
const EXIT_THRESHOLD = 0.006
const ALPHA_SMOOTH = 0.02 // fade in/out with sound, all the way to invisible in silence

// Particle count follows the dominant frequency directly (not the note
// table): flat at half below a low guitar E, ramping to the "1000" reference
// at G3 (the 5th degree, SOL), then continuing to grow — with shrinking
// particle size to compensate — up to a guitar's high E.
const COUNT_LOW_HZ = 80
const COUNT_LOW_N = 500
const COUNT_MID_HZ = 196.0 // SOL3 / G3
const COUNT_MID_N = 1000
const COUNT_HIGH_HZ = 329.63 // MI4 / E4
const COUNT_HIGH_N = 1800
const COUNT_SMOOTH = 0.01 // slow ramp, so the count drifts rather than pops

export const MAX_PARTICLES = COUNT_HIGH_N
const MIN_PARTICLES = COUNT_LOW_N
const VOICE_COUNT = 3 // mix up to 3 simultaneous tones into one figure

const MODE_SMOOTH = 0.008 // slow morph between figures ("armonioso", not a cut)
const WEIGHT_SMOOTH = 0.02 // how fast a voice fades in/out as tones come and go
const HUE_SMOOTH = 0.02
const ORIENTATION_DRIFT = 0.0016 // constant slow plate rotation per voice

const SETTLE_STRENGTH = 0.0016 // pull toward nodal lines
const AGITATION_STRENGTH = 5 // shake proportional to local vibration * volume
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
  const t = Math.min(1, (Math.log2(hz) - Math.log2(COUNT_MID_HZ)) / (Math.log2(COUNT_HIGH_HZ) - Math.log2(COUNT_MID_HZ)))
  return COUNT_MID_N + t * (COUNT_HIGH_N - COUNT_MID_N)
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
    }
  }

  setSpeedScale(scale) {
    this.speedScale = scale
  }

  setHueBase(hue) {
    this.hueBase = hue
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
    this.sizeScale = this.activeCount > COUNT_MID_N ? Math.sqrt(COUNT_MID_N / this.activeCount) : 1

    if (soundActive) {
      this.#applyPlateForces(volume)
      this.#resolveOverlaps()
    } else {
      this.#dampToIdle()
    }

    for (const p of this.activeParticles) {
      const r = p.baseR * this.sizeScale
      p.vx *= DRAG
      p.vy *= DRAG
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

  #applyPlateForces(volume) {
    const halfW = this.width / 2
    const halfH = this.height / 2
    const scale = Math.min(halfW, halfH)
    const energy = Math.min(volume, 1)
    const eps = 0.01

    for (const p of this.activeParticles) {
      // The canvas itself stays landscape, but this is captured for a
      // vertical 9:16 screen and rotated 90° clockwise downstream (OBS) —
      // so the field's own axes are pre-rotated 90° the other way here.
      // What was the canvas's top edge becomes the right edge after that
      // rotation, which is where the composition's weight belongs.
      const nx = -(p.y - halfH) / halfH
      const ny = (p.x - halfW) / halfW

      const z = this.#plateFieldAt(nx, ny)
      const gx = (this.#plateFieldAt(nx + eps, ny) - z) / eps
      const gy = (this.#plateFieldAt(nx, ny + eps) - z) / eps

      // Pulls toward decreasing |z| (a nodal line). Forces are swapped back
      // through the same 90° rotation (chain rule) so they push in the
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

  draw(ctx, soundActive) {
    ctx.clearRect(0, 0, this.width, this.height)
    if (this.alpha < 0.003 && this.leavingParticles.length === 0) return

    const idleHue = (this.hueBase + 230) % 360
    const activeColor = soundActive ? `${this.hue}, 80%, 58%` : `${idleHue}, 25%, 55%`
    for (const p of this.activeParticles) {
      const a = this.alpha
      if (a < 0.003) continue
      ctx.beginPath()
      ctx.fillStyle = `hsla(${activeColor}, ${a})`
      ctx.arc(p.x, p.y, p.baseR * this.sizeScale, 0, Math.PI * 2)
      ctx.fill()
    }

    for (const p of this.leavingParticles) {
      const a = this.alpha * p.fade
      if (a < 0.003) continue
      ctx.beginPath()
      ctx.fillStyle = `hsla(${activeColor}, ${a})`
      ctx.arc(p.x, p.y, p.baseR * this.sizeScale * p.fade, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}
