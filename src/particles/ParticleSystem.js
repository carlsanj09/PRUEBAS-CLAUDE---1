import { freqToNote, NOTE_PATTERNS } from '../audio/notes'

// Fixed 100,000 particles at all times — the count no longer varies with
// frequency. Effective per-particle radius stays roughly constant across the
// whole population (uniform grains rather than the earlier size-shrink).
const PARTICLE_COUNT = 100000
export const MAX_PARTICLES = PARTICLE_COUNT

const MIN_RADIUS = 0.9
const MAX_RADIUS_ADD = 0.6
const IDLE_SPEED = 0.15
const MAX_SPEED = 8

// Hysteresis: enters "active" sooner than it exits, so a single loud
// syllable doesn't cause the field to flicker on/off every frame.
const ENTER_THRESHOLD = 0.012
const EXIT_THRESHOLD = 0.006
// Once the mic is on, particles stay visible — silence sends them home to
// the center as a compact cloud instead of fading out.
const ALPHA_SMOOTH = 0.08
const IDLE_ALPHA = 0.85

const VOICE_COUNT = 3 // mix up to 3 simultaneous tones into one figure
// Both smoothings faster than before so the figure crystallises in
// ~0.5-1s instead of ~2-3s: MODE controls how quickly the plate mode
// numbers slide toward the detected pitch, WEIGHT how fast a voice's
// contribution ramps in/out. HUE lags them slightly for a smooth color.
const MODE_SMOOTH = 0.09
const WEIGHT_SMOOTH = 0.14
const HUE_SMOOTH = 0.04

// The plate itself no longer drifts. Only the particles move within it, so
// the figure holds still (per user request) instead of slowly rotating.
const PLATE_ANGLE = 0

// Chladni forces: stronger settle pull + smaller agitation than the old
// tuning, so grains lock onto the nodal lines more decisively rather than
// bouncing around them. AGITATION_SMOOTH slower for organic-feeling shake.
const SETTLE_STRENGTH = 0.0072
const AGITATION_STRENGTH = 2.4
const AGITATION_SMOOTH = 0.06
const DRAG = 0.94

// In silence, apply a mild homing pull toward the composition's center so
// the entire cloud drifts inward and clusters there — replaces the old
// gravity feature. Strength ramped up while sound is inactive.
const HOMING_STRENGTH = 0.008
const HOMING_JITTER = 0.05 // tiny random drift so the compact cloud still breathes

// Density-gradient repulsion: instead of resolving pairs (millions of
// checks at 100k), we build a coarse density grid — count of particles per
// cell — and push each particle away from cells more crowded than itself.
// O(N + grid) total, so it stays real-time even with 100k particles, while
// still producing the "solid grains pushing back on each other" clustering
// the user asked for. Border bounces are still fully elastic.
const DENSITY_CELL = 5
const DENSITY_REPULSION = 0.16

const DEFAULT_SPEED_SCALE = 0.55

// Growth/exit stay for smooth entrance from center when count changes,
// though with fixed count this only fires on the initial population.
const EXIT_FADE_SECONDS = 0.9
const SPAWN_JITTER = 6

// Precomputed plate field grid: cost then scales with canvas area, not
// particle count, which is what makes 100k particles feasible in real time.
const FIELD_CELL_SIZE = 6

// Five qualitatively different plate figures so different notes can look
// structurally distinct (crosses, mesh, mandalas, diagonals, rings).
const PATTERN_FORMULAS = [
  (X, Y, m, n) => Math.cos(n * X) * Math.cos(m * Y) - Math.cos(m * X) * Math.cos(n * Y),
  (X, Y, m, n) => Math.cos(m * X) + Math.cos(n * Y) + 0.5 * Math.cos(n * X) * Math.cos(m * Y),
  (X, Y, m, n) => Math.cos(m * Math.atan2(Y, X)) * Math.cos(n * Math.hypot(X, Y)),
  (X, Y, m, n) => Math.cos(m * X + n * Y) + Math.cos(n * X - m * Y),
  (X, Y, m, n) => Math.cos(n * Math.hypot(X, Y)) * Math.cos(m * X) * Math.cos(m * Y),
]

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

function randomVelocity(speed) {
  const angle = Math.random() * Math.PI * 2
  return { vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed }
}

export class ParticleSystem {
  constructor(width, height, count = PARTICLE_COUNT) {
    this.width = width
    this.height = height
    this.particles = Array.from({ length: count }, () => this.#createParticle())
    this.activeParticles = this.particles.slice()
    this.leavingParticles = []
    this.pool = []

    this.active = false
    this.time = 0
    this.alpha = 0 // 0 until mic is on; then stays at IDLE_ALPHA minimum

    this.voices = Array.from({ length: VOICE_COUNT }, () => ({
      weight: 0,
      targetWeight: 0,
      formula: 0,
      modeM: 3,
      targetModeM: 3,
      modeN: 4,
      targetModeN: 4,
      noteLabel: '',
    }))

    this.hue = 220
    this.targetHue = 220
    this.hueBase = 20
    this.speedScale = DEFAULT_SPEED_SCALE

    // Tracks whether the mic has ever been on this session — before that,
    // the field is a black canvas rather than a cloud of homing particles.
    this.everActive = false

    this.#allocateFieldGrid()
    this.#allocateCollisionGrid()
  }

  #createParticle() {
    const r = MIN_RADIUS + Math.random() * MAX_RADIUS_ADD
    const { vx, vy } = randomVelocity(IDLE_SPEED)
    return {
      x: this.width / 2 + (Math.random() - 0.5) * SPAWN_JITTER,
      y: this.height / 2 + (Math.random() - 0.5) * SPAWN_JITTER,
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

  // Kept as a no-op so ParticleField can still call it without checking —
  // gravity feature was removed per user request.
  setGravityIntensity() {}

  resize(width, height) {
    this.width = width
    this.height = height
    for (const p of this.particles) {
      p.x = Math.min(Math.max(p.x, 0), width)
      p.y = Math.min(Math.max(p.y, 0), height)
    }
    this.#allocateFieldGrid()
    this.#allocateCollisionGrid()
  }

  #allocateFieldGrid() {
    this.fieldCols = Math.max(2, Math.ceil(this.width / FIELD_CELL_SIZE) + 1)
    this.fieldRows = Math.max(2, Math.ceil(this.height / FIELD_CELL_SIZE) + 1)
    const size = this.fieldCols * this.fieldRows
    this.fieldZ = new Float32Array(size)
    this.fieldGX = new Float32Array(size)
    this.fieldGY = new Float32Array(size)
  }

  #allocateCollisionGrid() {
    this.densCols = Math.max(2, Math.ceil(this.width / DENSITY_CELL) + 1)
    this.densRows = Math.max(2, Math.ceil(this.height / DENSITY_CELL) + 1)
    this.densGrid = new Uint16Array(this.densCols * this.densRows)
  }

  // `peaks`: [{ hz, freqRatio, magnitude }, ...]
  step(volume, peaks = []) {
    this.time += 1 / 60

    if (volume > ENTER_THRESHOLD) {
      this.active = true
      this.everActive = true
    } else if (volume < EXIT_THRESHOLD) {
      this.active = false
    }
    const soundActive = this.active

    // Alpha climbs to full while sound is active; when silent (but mic on)
    // it eases down to IDLE_ALPHA so the homing cloud stays visible.
    const alphaTarget = this.everActive ? (soundActive ? 1 : IDLE_ALPHA) : 0
    this.alpha += (alphaTarget - this.alpha) * ALPHA_SMOOTH

    this.#updateVoiceTargets(peaks)

    let hueSum = 0
    let hueWeight = 0
    for (const voice of this.voices) {
      voice.modeM += (voice.targetModeM - voice.modeM) * MODE_SMOOTH
      voice.modeN += (voice.targetModeN - voice.modeN) * MODE_SMOOTH
      voice.weight += (voice.targetWeight - voice.weight) * WEIGHT_SMOOTH
      if (voice.targetWeight > 0.02) {
        hueSum += voice.targetHue * voice.targetWeight
        hueWeight += voice.targetWeight
      }
    }
    if (hueWeight > 0) this.targetHue = hueSum / hueWeight
    this.hue += (this.targetHue - this.hue) * HUE_SMOOTH

    if (soundActive) {
      this.#applyPlateForces(volume)
    } else {
      this.#applyHomingForces()
    }

    // Border bounce + integration.
    const w = this.width
    const h = this.height
    for (const p of this.activeParticles) {
      p.vx *= DRAG
      p.vy *= DRAG
      p.x += p.vx * this.speedScale
      p.y += p.vy * this.speedScale

      if (p.x < 0) {
        p.x = 0
        p.vx = Math.abs(p.vx)
      } else if (p.x > w) {
        p.x = w
        p.vx = -Math.abs(p.vx)
      }
      if (p.y < 0) {
        p.y = 0
        p.vy = Math.abs(p.vy)
      } else if (p.y > h) {
        p.y = h
        p.vy = -Math.abs(p.vy)
      }
    }

    this.#clampSpeeds()
    this.#resolveCollisions()
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
      const octaveDetail = Math.max(0, Math.min(1, (note.octave - 2) / 4)) * 1.6
      voice.targetModeM = pattern.m + octaveDetail
      voice.targetModeN = pattern.n + octaveDetail
      voice.targetWeight = peak.magnitude
      voice.targetHue = this.hueBase + peak.freqRatio * 240
      voice.noteLabel = note.label
    }
  }

  // Silence behaviour: pull every particle toward the composition's center
  // so the swarm converges into a compact cloud. A tiny per-frame jitter
  // keeps that cloud alive-looking instead of freezing.
  #applyHomingForces() {
    const cx = this.width / 2
    const cy = this.height / 2
    for (const p of this.activeParticles) {
      p.vx += (cx - p.x) * HOMING_STRENGTH
      p.vy += (cy - p.y) * HOMING_STRENGTH
      p.vx += (Math.random() - 0.5) * HOMING_JITTER
      p.vy += (Math.random() - 0.5) * HOMING_JITTER
    }
  }

  #plateFieldAt(nx, ny) {
    // Plate no longer rotates over time; PLATE_ANGLE is a constant.
    const cos = 1
    const sin = 0
    let z = 0
    let weightSum = 0
    for (const voice of this.voices) {
      if (voice.weight < 0.005) continue
      const rx = nx * cos - ny * sin
      const ry = nx * sin + ny * cos
      const X = rx * Math.PI
      const Y = ry * Math.PI
      z += voice.weight * PATTERN_FORMULAS[voice.formula](X, Y, voice.modeM, voice.modeN)
      weightSum += voice.weight
    }
    return weightSum > 0 ? z / weightSum : 0
  }

  #buildFieldGrid() {
    const halfW = this.width / 2
    const halfH = this.height / 2
    const cols = this.fieldCols
    const rows = this.fieldRows
    const z = this.fieldZ

    for (let row = 0; row < rows; row++) {
      const py = row * FIELD_CELL_SIZE
      const nxAxis = -(py - halfH) / halfH
      const base = row * cols
      for (let col = 0; col < cols; col++) {
        const px = col * FIELD_CELL_SIZE
        const nyAxis = (px - halfW) / halfW
        z[base + col] = this.#plateFieldAt(nxAxis, nyAxis)
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
    // Settle force scales with volume too so louder input crystallises the
    // figure faster while quiet passages let it breathe.
    const settle = SETTLE_STRENGTH * (0.6 + energy * 0.8)
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

      // Pulls toward decreasing |z| (a nodal line). Force components are
      // swapped through the field's 90° pre-rotation (chain rule) so they
      // push in the correct pixel direction.
      p.vx += -settle * z * gy * scale
      p.vy += settle * z * gx * scale

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

  // Density-gradient repulsion instead of true pairwise elastic collision:
  // the cost of resolving pair collisions between 100k particles is
  // prohibitive (millions of pair checks per frame), so we approximate the
  // "solid grains that resist overlap" behavior by pushing each particle
  // away from denser neighboring cells. Visually indistinguishable at these
  // sub-pixel sizes, and O(N + grid) instead of O(N * avg_neighbors).
  #resolveCollisions() {
    const particles = this.activeParticles
    const n = particles.length
    const cell = DENSITY_CELL
    const cols = this.densCols
    const rows = this.densRows
    const grid = this.densGrid
    grid.fill(0)

    // Bin count particles into the density grid.
    for (let i = 0; i < n; i++) {
      const p = particles[i]
      let cx = (p.x / cell) | 0
      let cy = (p.y / cell) | 0
      if (cx < 0) cx = 0
      else if (cx >= cols) cx = cols - 1
      if (cy < 0) cy = 0
      else if (cy >= rows) cy = rows - 1
      grid[cy * cols + cx]++
    }

    // Push each particle away from crowded neighbors using the central
    // difference of the density field. This produces the "solid grains
    // resisting overlap" behavior at O(N) instead of O(N * avg_neighbors).
    for (const p of particles) {
      let cx = (p.x / cell) | 0
      let cy = (p.y / cell) | 0
      if (cx <= 0 || cx >= cols - 1 || cy <= 0 || cy >= rows - 1) continue
      const base = cy * cols + cx
      const gx = grid[base + 1] - grid[base - 1]
      const gy = grid[base + cols] - grid[base - cols]
      // Move opposite to density gradient — toward less crowded cells.
      p.vx -= gx * DENSITY_REPULSION
      p.vy -= gy * DENSITY_REPULSION
    }
  }

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

    const idleHue = (this.hueBase + 230) % 360
    const activeColor = soundActive ? `${this.hue}, 80%, 58%` : `${idleHue}, 25%, 55%`
    for (const p of this.leavingParticles) {
      const la = this.alpha * p.fade
      if (la < 0.003) continue
      ctx.fillStyle = `hsla(${activeColor}, ${la})`
      const d = Math.max(1, p.baseR * p.fade * 2)
      ctx.fillRect(p.x - d / 2, p.y - d / 2, d, d)
    }
  }
}
