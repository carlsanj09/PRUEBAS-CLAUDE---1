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

const MAX_PARTICLES = 1000
const MIN_PARTICLES = 500
// Below this, particles thin out to MIN_PARTICLES (an octave below a guitar's
// low E). At/above the guitar's high E they fill back up to MAX_PARTICLES.
const COUNT_FREQ_MIN = 80
const COUNT_FREQ_MAX = 329.63
const COUNT_SMOOTH = 0.01 // slow ramp, so the count drifts rather than pops

// Chladni plate: nodal lines of cos(n*X)*cos(m*Y) - cos(m*X)*cos(n*Y) = 0.
// Higher pitch -> higher mode numbers -> a more intricate figure.
const MODE_FREQ_MIN = 70
const MODE_FREQ_MAX = 2000
const MODE_MIN = 2
const MODE_MAX = 11
const MODE_SMOOTH = 0.008 // slow morph between figures ("armonioso", not a jump cut
const ORIENTATION_DRIFT = 0.0016 // constant slow plate rotation, so a held note doesn't freeze
const HUE_SMOOTH = 0.012

const SETTLE_STRENGTH = 0.0016 // pull toward nodal lines
const AGITATION_STRENGTH = 5 // shake proportional to local vibration * volume
const REPEL_STRENGTH = 0.6 // keeps grains from perfectly overlapping
const DRAG = 0.97

function randomVelocity(speed) {
  const angle = Math.random() * Math.PI * 2
  return { vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed }
}

export class ParticleSystem {
  constructor(width, height, maxCount = MAX_PARTICLES) {
    this.width = width
    this.height = height
    this.particles = Array.from({ length: maxCount }, () => this.#createParticle())
    this.active = false
    this.time = 0

    this.angle = Math.random() * Math.PI * 2
    this.modeM = 3
    this.modeN = 4.5
    this.targetModeM = 3
    this.targetModeN = 4.5
    this.hue = 220
    this.targetHue = 220

    this.activeCount = maxCount
    this.targetCount = maxCount
    this.currentActiveN = maxCount
  }

  #createParticle() {
    const r = MIN_RADIUS + Math.random() * MAX_RADIUS_ADD
    const { vx, vy } = randomVelocity(IDLE_SPEED)
    return { x: r + Math.random() * (this.width - 2 * r), y: r + Math.random() * (this.height - 2 * r), vx, vy, r }
  }

  #respawnParticle(p) {
    p.x = p.r + Math.random() * (this.width - 2 * p.r)
    p.y = p.r + Math.random() * (this.height - 2 * p.r)
    const { vx, vy } = randomVelocity(IDLE_SPEED)
    p.vx = vx
    p.vy = vy
  }

  resize(width, height) {
    this.width = width
    this.height = height
    for (const p of this.particles) {
      p.x = Math.min(Math.max(p.x, p.r), width - p.r)
      p.y = Math.min(Math.max(p.y, p.r), height - p.r)
    }
  }

  // `peaks`: [{ hz, freqRatio: 0-1 (low->high, log-mapped), magnitude: 0-1 }], strongest first.
  step(volume, peaks = []) {
    this.time += 1 / 60

    if (volume > ENTER_THRESHOLD) this.active = true
    else if (volume < EXIT_THRESHOLD) this.active = false
    const soundActive = this.active

    if (peaks[0]) this.#updateTargets(peaks[0])

    // These keep drifting toward their targets even at rest, so the plate is
    // never perfectly static and the next sound continues the morph smoothly.
    this.angle += ORIENTATION_DRIFT
    this.modeM += (this.targetModeM - this.modeM) * MODE_SMOOTH
    this.modeN += (this.targetModeN - this.modeN) * MODE_SMOOTH
    this.hue += (this.targetHue - this.hue) * HUE_SMOOTH
    this.activeCount += (this.targetCount - this.activeCount) * COUNT_SMOOTH

    const activeN = Math.max(MIN_PARTICLES, Math.min(MAX_PARTICLES, Math.round(this.activeCount)))
    this.#syncActiveCount(activeN)

    if (soundActive) {
      this.#applyPlateForces(volume)
      this.#resolveOverlaps()
    } else {
      this.#dampToIdle()
    }

    for (let i = 0; i < this.currentActiveN; i++) {
      const p = this.particles[i]
      p.vx *= DRAG
      p.vy *= DRAG
      p.x += p.vx
      p.y += p.vy

      if (p.x - p.r < 0) {
        p.x = p.r
        p.vx = Math.abs(p.vx)
      } else if (p.x + p.r > this.width) {
        p.x = this.width - p.r
        p.vx = -Math.abs(p.vx)
      }

      if (p.y - p.r < 0) {
        p.y = p.r
        p.vy = Math.abs(p.vy)
      } else if (p.y + p.r > this.height) {
        p.y = this.height - p.r
        p.vy = -Math.abs(p.vy)
      }
    }

    this.#clampSpeeds()

    return { soundActive, volume, activeCount: this.currentActiveN }
  }

  #updateTargets(peak) {
    const hz = peak.hz

    const countT =
      hz <= COUNT_FREQ_MIN
        ? 0
        : Math.min(
            1,
            (Math.log2(Math.max(hz, COUNT_FREQ_MIN)) - Math.log2(COUNT_FREQ_MIN)) /
              (Math.log2(COUNT_FREQ_MAX) - Math.log2(COUNT_FREQ_MIN)),
          )
    this.targetCount = MIN_PARTICLES + countT * (MAX_PARTICLES - MIN_PARTICLES)

    const modeT = Math.min(
      1,
      Math.max(0, (Math.log2(Math.max(hz, MODE_FREQ_MIN)) - Math.log2(MODE_FREQ_MIN)) / (Math.log2(MODE_FREQ_MAX) - Math.log2(MODE_FREQ_MIN))),
    )
    this.targetModeM = MODE_MIN + modeT * (MODE_MAX - MODE_MIN)

    // A slow, deterministic wander (sum of incommensurate sines) so the same
    // pitch doesn't always draw the exact same figure, without ever jumping.
    const wobble = Math.sin(this.time * 0.083) * 1.4 + Math.sin(this.time * 0.031 + 2) * 1.1
    this.targetModeN = this.targetModeM + 1.7 + wobble

    this.targetHue = 20 + peak.freqRatio * 240
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

  #plateZ(nx, ny) {
    const rx = nx * Math.cos(this.angle) - ny * Math.sin(this.angle)
    const ry = nx * Math.sin(this.angle) + ny * Math.cos(this.angle)
    const X = rx * Math.PI
    const Y = ry * Math.PI
    const m = this.modeM
    const n = this.modeN
    return Math.cos(n * X) * Math.cos(m * Y) - Math.cos(m * X) * Math.cos(n * Y)
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

      const z = this.#plateZ(nx, ny)
      const gx = (this.#plateZ(nx + eps, ny) - z) / eps
      const gy = (this.#plateZ(nx, ny + eps) - z) / eps

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
    const dx = b.x - a.x
    const dy = b.y - a.y
    const dist2 = dx * dx + dy * dy
    const minDist = a.r + b.r
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
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}
