const MIN_RADIUS = 2.2
const MAX_RADIUS_ADD = 1.8
const IDLE_SPEED = 0.15
const IDLE_DAMPING = 0.02
const CELL_SIZE = 14
const MAX_SPEED = 9

// Hysteresis: enters "active" sooner than it exits, so a single loud
// syllable doesn't cause the field to flicker on/off every frame.
const ENTER_THRESHOLD = 0.012
const EXIT_THRESHOLD = 0.006

const JITTER_STRENGTH = 6 // kinetic energy injected per frame, proportional to volume
const DRAG = 0.985 // friction so injected energy settles instead of accumulating forever

const ATTRACTOR_STRENGTH = 0.06
const ATTRACTOR_MIN_RADIUS_FRAC = 0.1
const ATTRACTOR_MAX_RADIUS_FRAC = 0.42

function randomVelocity(speed) {
  const angle = Math.random() * Math.PI * 2
  return { vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed }
}

export class ParticleSystem {
  constructor(width, height, count) {
    this.width = width
    this.height = height
    this.particles = Array.from({ length: count }, () => this.#createParticle())
    this.attractors = []
    this.active = false
    this.time = 0
  }

  #createParticle() {
    const r = MIN_RADIUS + Math.random() * MAX_RADIUS_ADD
    const { vx, vy } = randomVelocity(IDLE_SPEED)
    return {
      x: r + Math.random() * (this.width - 2 * r),
      y: r + Math.random() * (this.height - 2 * r),
      vx,
      vy,
      r,
      mass: r * r,
      tone: 0.5,
    }
  }

  resize(width, height) {
    this.width = width
    this.height = height
    for (const p of this.particles) {
      p.x = Math.min(Math.max(p.x, p.r), width - p.r)
      p.y = Math.min(Math.max(p.y, p.r), height - p.r)
    }
  }

  // `peaks`: [{ freqRatio: 0-1 (low->high pitch), magnitude: 0-1 }], strongest first.
  step(volume, peaks = []) {
    this.time += 1 / 60

    if (volume > ENTER_THRESHOLD) this.active = true
    else if (volume < EXIT_THRESHOLD) this.active = false
    const soundActive = this.active

    if (soundActive) {
      this.#updateAttractors(peaks)
      this.#injectEnergy(volume)
      this.#applyAttraction(volume)
      this.#resolveCollisions()
    } else {
      this.attractors = []
      this.#dampToIdle()
    }

    for (const p of this.particles) {
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

    return { soundActive, volume }
  }

  #dampToIdle() {
    for (const p of this.particles) {
      const speed = Math.hypot(p.vx, p.vy)
      if (speed < 0.0001) continue
      const nextSpeed = speed + (IDLE_SPEED - speed) * IDLE_DAMPING
      p.vx = (p.vx / speed) * nextSpeed
      p.vy = (p.vy / speed) * nextSpeed
    }
  }

  #injectEnergy(volume) {
    const jitter = Math.min(volume, 1) * JITTER_STRENGTH
    for (const p of this.particles) {
      p.vx += (Math.random() - 0.5) * jitter
      p.vy += (Math.random() - 0.5) * jitter
    }
  }

  #updateAttractors(peaks) {
    const cx = this.width / 2
    const cy = this.height / 2
    const maxR = Math.min(this.width, this.height) / 2

    this.attractors = peaks.map((peak, i) => {
      const angle = peak.freqRatio * Math.PI * 2 + this.time * 0.15 + i * 1.3
      const radius =
        maxR * (ATTRACTOR_MIN_RADIUS_FRAC + peak.magnitude * (ATTRACTOR_MAX_RADIUS_FRAC - ATTRACTOR_MIN_RADIUS_FRAC))
      return {
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
        strength: peak.magnitude,
        freqRatio: peak.freqRatio,
      }
    })
  }

  #applyAttraction(volume) {
    if (!this.attractors.length) return
    const energy = Math.min(volume, 1)

    for (const p of this.particles) {
      let ax = 0
      let ay = 0
      let bestForce = 0
      let bestTone = p.tone

      for (const a of this.attractors) {
        const dx = a.x - p.x
        const dy = a.y - p.y
        const dist = Math.hypot(dx, dy) || 1
        const force = (ATTRACTOR_STRENGTH * a.strength * energy) / dist
        ax += (dx / dist) * force
        ay += (dy / dist) * force
        if (force > bestForce) {
          bestForce = force
          bestTone = a.freqRatio
        }
      }

      p.vx += ax
      p.vy += ay
      p.tone = bestTone
    }
  }

  #clampSpeeds() {
    for (const p of this.particles) {
      const speed = Math.hypot(p.vx, p.vy)
      if (speed > MAX_SPEED) {
        p.vx = (p.vx / speed) * MAX_SPEED
        p.vy = (p.vy / speed) * MAX_SPEED
      }
    }
  }

  #resolveCollisions() {
    const grid = new Map()
    const cellKey = (cx, cy) => `${cx}:${cy}`

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i]
      const key = cellKey(Math.floor(p.x / CELL_SIZE), Math.floor(p.y / CELL_SIZE))
      let bucket = grid.get(key)
      if (!bucket) {
        bucket = []
        grid.set(key, bucket)
      }
      bucket.push(i)
    }

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i]
      const cx = Math.floor(p.x / CELL_SIZE)
      const cy = Math.floor(p.y / CELL_SIZE)
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const bucket = grid.get(cellKey(cx + dx, cy + dy))
          if (!bucket) continue
          for (const j of bucket) {
            if (j <= i) continue
            this.#collide(p, this.particles[j])
          }
        }
      }
    }
  }

  #collide(a, b) {
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

    const rvx = b.vx - a.vx
    const rvy = b.vy - a.vy
    const velAlongNormal = rvx * nx + rvy * ny
    if (velAlongNormal > 0) return

    const invMassA = 1 / a.mass
    const invMassB = 1 / b.mass
    const impulse = (-2 * velAlongNormal) / (invMassA + invMassB)
    const ix = impulse * nx
    const iy = impulse * ny

    a.vx -= ix * invMassA
    a.vy -= iy * invMassA
    b.vx += ix * invMassB
    b.vy += iy * invMassB
  }

  draw(ctx, soundActive) {
    ctx.clearRect(0, 0, this.width, this.height)
    for (const p of this.particles) {
      const speed = Math.hypot(p.vx, p.vy)
      const t = Math.min(speed / MAX_SPEED, 1)

      ctx.beginPath()
      if (soundActive) {
        // low pitch -> warm (hue ~20), high pitch -> cool (hue ~260)
        const hue = 20 + p.tone * 240
        const light = 55 + t * 20
        ctx.fillStyle = `hsl(${hue}, 85%, ${light}%)`
      } else {
        ctx.fillStyle = `hsl(250, 25%, 55%)`
      }
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}
