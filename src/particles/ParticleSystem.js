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
const REPEL_STRENGTH = 0.6 // keeps grains from perfectly overlapping
const DRAG = 0.97

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
    this.active = false
    this.time = 0

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
    this.sizeScale = 1

    this.activeCount = maxCount
    this.targetCount = maxCount
    this.currentActiveN = maxCount
  }

  #createParticle() {
    const r = MIN_RADIUS + Math.random() * MAX_RADIUS_ADD
    const { vx, vy } = randomVelocity(IDLE_SPEED)
    return { x: r + Math.random() * (this.width - 2 * r), y: r + Math.random() * (this.height - 2 * r), vx, vy, baseR: r }
  }

  #respawnParticle(p) {
    p.x = p.baseR + Math.random() * (this.width - 2 * p.baseR)
    p.y = p.baseR + Math.random() * (this.height - 2 * p.baseR)
    const { vx, vy } = randomVelocity(IDLE_SPEED)
    p.vx = vx
    p.vy = vy
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

    const activeN = Math.max(MIN_PARTICLES, Math.min(MAX_PARTICLES, Math.round(this.activeCount)))
    this.#syncActiveCount(activeN)
    this.sizeScale = this.activeCount > COUNT_MID_N ? Math.sqrt(COUNT_MID_N / this.activeCount) : 1

    if (soundActive) {
      this.#applyPlateForces(volume)
      this.#resolveOverlaps()
    } else {
      this.#dampToIdle()
    }

    for (let i = 0; i < this.currentActiveN; i++) {
      const p = this.particles[i]
      const r = p.baseR * this.sizeScale
      p.vx *= DRAG
      p.vy *= DRAG
      p.x += p.vx
      p.y += p.vy

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

    const notes = this.voices.filter((v) => v.targetWeight > 0.05).map((v) => v.noteLabel)
    return { soundActive, volume, activeCount: this.currentActiveN, notes }
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
      voice.targetHue = 20 + peak.freqRatio * 240
      voice.noteLabel = note.label
    }
  }

  #syncActiveCount(activeN) {
    if (activeN > this.currentActiveN) {
      for (let i = this.currentActiveN; i < activeN; i++) {
        this.#respawnParticle(this.particles[i])
      }
    }
    this.currentActiveN = activeN
  }

  #dampToIdle() {
    for (let i = 0; i < this.currentActiveN; i++) {
      const p = this.particles[i]
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

    for (let i = 0; i < this.currentActiveN; i++) {
      const p = this.particles[i]
      const nx = (p.x - halfW) / halfW
      const ny = (p.y - halfH) / halfH

      const z = this.#plateFieldAt(nx, ny)
      const gx = (this.#plateFieldAt(nx + eps, ny) - z) / eps
      const gy = (this.#plateFieldAt(nx, ny + eps) - z) / eps

      // Pulls toward decreasing |z| (a nodal line), scaled to pixel space.
      p.vx += -SETTLE_STRENGTH * z * gx * scale
      p.vy += -SETTLE_STRENGTH * z * gy * scale

      // Shakes particles sitting on high-amplitude (antinode) zones, same as
      // real sand won't settle where the plate is still vibrating hard.
      const agitation = Math.abs(z) * AGITATION_STRENGTH * energy
      p.vx += (Math.random() - 0.5) * agitation
      p.vy += (Math.random() - 0.5) * agitation
    }
  }

  #clampSpeeds() {
    for (let i = 0; i < this.currentActiveN; i++) {
      const p = this.particles[i]
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
    const n = this.currentActiveN

    for (let i = 0; i < n; i++) {
      const p = this.particles[i]
      const key = cellKey(Math.floor(p.x / CELL_SIZE), Math.floor(p.y / CELL_SIZE))
      let bucket = grid.get(key)
      if (!bucket) {
        bucket = []
        grid.set(key, bucket)
      }
      bucket.push(i)
    }

    for (let i = 0; i < n; i++) {
      const p = this.particles[i]
      const cx = Math.floor(p.x / CELL_SIZE)
      const cy = Math.floor(p.y / CELL_SIZE)
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const bucket = grid.get(cellKey(cx + dx, cy + dy))
          if (!bucket) continue
          for (const j of bucket) {
            if (j <= i) continue
            this.#separate(p, this.particles[j])
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
    for (let i = 0; i < this.currentActiveN; i++) {
      const p = this.particles[i]
      ctx.beginPath()
      ctx.fillStyle = soundActive ? `hsl(${this.hue}, 80%, 58%)` : `hsl(250, 25%, 55%)`
      ctx.arc(p.x, p.y, p.baseR * this.sizeScale, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}
