// Alternate ways to draw the exact same simulation (ParticleSystem only
// tracks positions/physics; everything here is purely visual). Each style
// reuses system.activeParticles / leavingParticles / hue / alpha as-is, so
// they all form the same Chladni-driven figures — only the brushwork differs.

const THREAD_TRAIL_POINTS = 60 // positions kept per thread (x,y pairs)
const THREAD_STRIDE = 3 // draw every Nth particle — long threads read better sparse
const SMOKE_STRIDE = 2

function colorFor(system, soundActive) {
  const idleHue = (system.hueBase + 230) % 360
  return soundActive ? `${system.hue}, 80%, 58%` : `${idleHue}, 25%, 55%`
}

function drawLeavingAsDots(ctx, system, color) {
  for (const p of system.leavingParticles) {
    const a = system.alpha * p.fade
    if (a < 0.003) continue
    ctx.beginPath()
    ctx.fillStyle = `hsla(${color}, ${a})`
    ctx.arc(p.x, p.y, p.baseR * system.sizeScale * p.fade, 0, Math.PI * 2)
    ctx.fill()
  }
}

// Long tangled threads: each one is just a trail of recent positions. At
// rest a particle barely moves, so its trail stays short and coiled; once
// sound drives it along the plate field it travels farther per frame and
// the same trail reads as unspooling into a long line.
export function drawThreads(ctx, system, soundActive) {
  ctx.clearRect(0, 0, system.width, system.height)
  if (system.alpha < 0.003 && system.leavingParticles.length === 0) return

  const color = colorFor(system, soundActive)
  const particles = system.activeParticles

  for (let i = 0; i < particles.length; i += THREAD_STRIDE) {
    const p = particles[i]
    if (!p.trail) p.trail = []
    p.trail.push(p.x, p.y)
    if (p.trail.length > THREAD_TRAIL_POINTS * 2) {
      p.trail.splice(0, p.trail.length - THREAD_TRAIL_POINTS * 2)
    }
    const pts = p.trail
    if (pts.length < 4) continue

    const depthScale = 0.5 + p.depth * 1.3
    const a = system.alpha * (0.3 + p.depth * 0.55)

    ctx.beginPath()
    ctx.moveTo(pts[0], pts[1])
    for (let j = 2; j < pts.length; j += 2) ctx.lineTo(pts[j], pts[j + 1])
    ctx.strokeStyle = `hsla(${color}, ${a})`
    ctx.lineWidth = Math.max(0.6, p.baseR * system.sizeScale * depthScale * 0.85)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.stroke()
  }

  drawLeavingAsDots(ctx, system, color)
}

// Soft, additive puffs instead of hard dots — since particles already
// spawn from the center and settle onto the plate's nodal lines, this
// alone reads as smoke gathering into the same figure.
export function drawSmoke(ctx, system, soundActive) {
  ctx.clearRect(0, 0, system.width, system.height)
  if (system.alpha < 0.003 && system.leavingParticles.length === 0) return

  const color = colorFor(system, soundActive)
  const particles = system.activeParticles

  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  for (let i = 0; i < particles.length; i += SMOKE_STRIDE) {
    const p = particles[i]
    const a = system.alpha * (0.05 + p.depth * 0.13)
    if (a < 0.003) continue
    const size = p.baseR * system.sizeScale * (5 + p.depth * 9)
    const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, size)
    grad.addColorStop(0, `hsla(${color}, ${a})`)
    grad.addColorStop(1, `hsla(${color}, 0)`)
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.arc(p.x, p.y, size, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()

  drawLeavingAsDots(ctx, system, color)
}

const WAVE_SAMPLES = 96
const WAVE_LAYERS = 3

// A deformed ring instead of discrete grains: the particle swarm's average
// distance-from-center at each angle becomes the ring's radius at that
// angle, so the same plate-field figure stretches the circle's edge into
// its shape rather than being traced by dots.
export function drawWave(ctx, system, soundActive) {
  ctx.clearRect(0, 0, system.width, system.height)
  if (system.alpha < 0.003 && system.leavingParticles.length === 0) return

  const cx = system.width / 2
  const cy = system.height / 2
  const baseRadius = Math.min(system.width, system.height) * 0.18
  const color = colorFor(system, soundActive)

  const sums = new Array(WAVE_SAMPLES).fill(0)
  const counts = new Array(WAVE_SAMPLES).fill(0)
  for (const p of system.activeParticles) {
    const dx = p.x - cx
    const dy = p.y - cy
    let angle = Math.atan2(dy, dx)
    if (angle < 0) angle += Math.PI * 2
    const bin = Math.min(WAVE_SAMPLES - 1, Math.floor((angle / (Math.PI * 2)) * WAVE_SAMPLES))
    sums[bin] += Math.hypot(dx, dy)
    counts[bin]++
  }

  const radii = sums.map((sum, i) => (counts[i] > 0 ? sum / counts[i] : NaN))
  // circular fill for bins with no particles, then a light smoothing pass
  let lastValid = null
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < WAVE_SAMPLES * 2; k++) {
      const i = k % WAVE_SAMPLES
      if (!Number.isNaN(radii[i])) lastValid = radii[i]
      else if (lastValid !== null) radii[i] = lastValid
    }
  }
  for (let i = 0; i < WAVE_SAMPLES; i++) {
    if (Number.isNaN(radii[i])) radii[i] = baseRadius
  }
  const smoothed = radii.map((_, i) => {
    const prev = radii[(i - 1 + WAVE_SAMPLES) % WAVE_SAMPLES]
    const next = radii[(i + 1) % WAVE_SAMPLES]
    return (prev + radii[i] * 2 + next) / 4
  })

  const squash = 0.82 // flattens the ring slightly for a tilted, perspective feel
  for (let layer = 0; layer < WAVE_LAYERS; layer++) {
    const layerScale = 1 - layer * 0.1
    const layerAlpha = system.alpha * (0.85 - layer * 0.28)
    if (layerAlpha < 0.003) continue

    ctx.beginPath()
    for (let i = 0; i <= WAVE_SAMPLES; i++) {
      const idx = i % WAVE_SAMPLES
      const angle = (idx / WAVE_SAMPLES) * Math.PI * 2
      const r = smoothed[idx] * layerScale
      const x = cx + Math.cos(angle) * r
      const y = cy + Math.sin(angle) * r * squash
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.closePath()
    ctx.strokeStyle = `hsla(${color}, ${layerAlpha})`
    ctx.lineWidth = 2.6 - layer * 0.7
    ctx.stroke()
  }

  drawLeavingAsDots(ctx, system, color)
}

export const RENDER_STYLES = {
  dots: null, // handled directly via system.draw() — no separate renderer needed
  threads: drawThreads,
  smoke: drawSmoke,
  wave: drawWave,
}
