const MIN_RADIUS = 2.2
const MAX_RADIUS_ADD = 1.8
const IDLE_SPEED = 0.15
const MAX_ENERGY_MULTIPLIER = 5
const SILENCE_THRESHOLD = 0.05
const MAX_SPEED = 6
const IDLE_DAMPING = 0.02
const CELL_SIZE = 14

function randomVelocity(speed) {
  const angle = Math.random() * Math.PI * 2
  return { vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed }
}

export class ParticleSystem {
  constructor(width, height, count) {
    this.width = width
    this.height = height
    this.particles = Array.from({ length: count }, () => this.#createParticle())
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
      hue: 250 + Math.random() * 70,
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

  step(volume) {
    const soundActive = volume > SILENCE_THRESHOLD
    const energy = soundActive
      ? 1 + ((volume - SILENCE_THRESHOLD) / (1 - SILENCE_THRESHOLD)) * (MAX_ENERGY_MULTIPLIER - 1)
      : 1

    if (soundActive) {
      this.#resolveCollisions()
    } else {
      this.#dampToIdle()
    }

    for (const p of this.particles) {
      p.x += p.vx * energy
      p.y += p.vy * energy

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

    return { soundActive, energy }
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

    for (const p of this.particles) {
      const speed = Math.hypot(p.vx, p.vy)
      if (speed > MAX_SPEED) {
        p.vx = (p.vx / speed) * MAX_SPEED
        p.vy = (p.vy / speed) * MAX_SPEED
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
      ctx.beginPath()
      ctx.fillStyle = soundActive
        ? `hsl(${p.hue}, 85%, 65%)`
        : `hsl(${p.hue}, 25%, 55%)`
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}
