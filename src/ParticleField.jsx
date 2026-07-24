import { useEffect, useRef, useState } from 'react'
import { ParticleSystem, MAX_PARTICLES } from './particles/ParticleSystem'
import { MicVolumeMeter } from './audio/MicVolumeMeter'

const DEFAULT_SENSITIVITY = 3.5
const DEFAULT_SPEED = 0.55
const DEFAULT_GLOW_COLOR = '#aa3bff'

export default function ParticleField() {
  const canvasRef = useRef(null)
  const glowRef = useRef(null)
  const meterFillRef = useRef(null)
  const statusRef = useRef(null)
  const countRef = useRef(null)
  const systemRef = useRef(null)
  const meterRef = useRef(null)
  const rafRef = useRef(null)
  const [micState, setMicState] = useState('idle')
  const [sensitivity, setSensitivity] = useState(DEFAULT_SENSITIVITY)
  const [speed, setSpeed] = useState(DEFAULT_SPEED)
  const [glowColor, setGlowColor] = useState(DEFAULT_GLOW_COLOR)

  useEffect(() => {
    meterRef.current?.setSensitivity(sensitivity)
  }, [sensitivity])

  useEffect(() => {
    systemRef.current?.setSpeedScale(speed)
  }, [speed])

  useEffect(() => {
    const canvas = canvasRef.current
    // The container has a visible border; measuring with clientWidth/Height
    // (content box) instead of getBoundingClientRect (border box) keeps the
    // simulated bounds flush with that border instead of a few px inside it.
    const container = canvas.parentElement
    const ctx = canvas.getContext('2d')

    const resize = () => {
      const width = container.clientWidth
      const height = container.clientHeight
      const dpr = window.devicePixelRatio || 1
      canvas.width = width * dpr
      canvas.height = height * dpr
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      if (!systemRef.current) {
        systemRef.current = new ParticleSystem(width, height, MAX_PARTICLES)
        systemRef.current.setSpeedScale(speed)
      } else {
        systemRef.current.resize(width, height)
      }
    }

    resize()
    window.addEventListener('resize', resize)

    const loop = () => {
      const volume = meterRef.current ? meterRef.current.getVolume() : 0
      const peaks = meterRef.current ? meterRef.current.getSpectralPeaks(3) : []
      const { soundActive, activeCount } = systemRef.current.step(volume, peaks)
      systemRef.current.draw(ctx, soundActive)

      if (meterFillRef.current) {
        meterFillRef.current.style.width = `${Math.min(volume * 220, 100)}%`
      }
      if (countRef.current) {
        countRef.current.textContent = `${activeCount} partículas`
      }
      if (statusRef.current) {
        statusRef.current.classList.toggle('on', soundActive)
        statusRef.current.textContent = soundActive
          ? '\u{1F50A} Colisiones activas'
          : meterRef.current
            ? '\u{1F508} Silencio'
            : ''
      }
      if (glowRef.current) {
        glowRef.current.style.opacity = Math.min(volume * 2.6, 1)
      }

      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(rafRef.current)
      window.removeEventListener('resize', resize)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => () => meterRef.current?.stop(), [])

  const enableMic = async () => {
    setMicState('requesting')
    try {
      const meter = new MicVolumeMeter()
      meter.setSensitivity(sensitivity)
      await meter.start()
      meterRef.current = meter
      setMicState('active')
    } catch (err) {
      meterRef.current = null
      setMicState(err?.name === 'NotAllowedError' ? 'denied' : 'error')
    }
  }

  return (
    <div className="stage">
      <div className="hud">
        <button
          type="button"
          onClick={enableMic}
          disabled={micState === 'active' || micState === 'requesting'}
        >
          {micState === 'active'
            ? 'Micrófono activo'
            : micState === 'requesting'
              ? 'Solicitando permiso…'
              : 'Activar micrófono'}
        </button>

        <div className="meter">
          <div ref={meterFillRef} className="meter-fill" />
        </div>

        <span ref={statusRef} className="status" />
        <span ref={countRef} className="count">1000 partículas</span>

        <label className="sensitivity">
          Sensibilidad
          <input
            type="range"
            min="1"
            max="8"
            step="0.5"
            value={sensitivity}
            onChange={(e) => setSensitivity(Number(e.target.value))}
          />
        </label>

        <label className="sensitivity">
          Velocidad
          <input
            type="range"
            min="0.1"
            max="1.5"
            step="0.05"
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
          />
        </label>

        <label className="sensitivity">
          Color del resplandor
          <input
            type="color"
            value={glowColor}
            onChange={(e) => setGlowColor(e.target.value)}
          />
        </label>

        {micState === 'denied' && (
          <p className="hint">
            Permiso de micrófono denegado. Habilítalo en la configuración del navegador para
            que las partículas reaccionen al sonido.
          </p>
        )}
        {micState === 'error' && (
          <p className="hint">No se pudo acceder al micrófono en este dispositivo.</p>
        )}
        {micState === 'idle' && (
          <p className="hint">
            El audio se procesa localmente en el navegador; nunca se graba ni se envía a ningún
            servidor.
          </p>
        )}
      </div>

      <div className="canvas-wrap">
        <canvas ref={canvasRef} />
        <div ref={glowRef} className="glow" style={{ '--glow-color': glowColor }} />
      </div>
    </div>
  )
}
