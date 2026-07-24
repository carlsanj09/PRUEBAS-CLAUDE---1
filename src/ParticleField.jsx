import { useEffect, useRef, useState } from 'react'
import { ParticleSystem } from './particles/ParticleSystem'
import { MicVolumeMeter } from './audio/MicVolumeMeter'

const PARTICLE_COUNT = 1000

export default function ParticleField() {
  const canvasRef = useRef(null)
  const meterFillRef = useRef(null)
  const statusRef = useRef(null)
  const systemRef = useRef(null)
  const meterRef = useRef(null)
  const rafRef = useRef(null)
  const [micState, setMicState] = useState('idle')

  useEffect(() => {
    const canvas = canvasRef.current
    const container = canvas.parentElement
    const ctx = canvas.getContext('2d')

    const resize = () => {
      const { width, height } = container.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      canvas.width = width * dpr
      canvas.height = height * dpr
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      if (!systemRef.current) {
        systemRef.current = new ParticleSystem(width, height, PARTICLE_COUNT)
      } else {
        systemRef.current.resize(width, height)
      }
    }

    resize()
    window.addEventListener('resize', resize)

    const loop = () => {
      const volume = meterRef.current ? meterRef.current.getVolume() : 0
      const { soundActive } = systemRef.current.step(volume)
      systemRef.current.draw(ctx, soundActive)

      if (meterFillRef.current) {
        meterFillRef.current.style.width = `${Math.min(volume * 220, 100)}%`
      }
      if (statusRef.current) {
        statusRef.current.classList.toggle('on', soundActive)
        statusRef.current.textContent = soundActive
          ? '\u{1F50A} Colisiones activas'
          : meterRef.current
            ? '\u{1F508} Silencio'
            : ''
      }

      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(rafRef.current)
      window.removeEventListener('resize', resize)
    }
  }, [])

  useEffect(() => () => meterRef.current?.stop(), [])

  const enableMic = async () => {
    setMicState('requesting')
    try {
      const meter = new MicVolumeMeter()
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
      </div>
    </div>
  )
}
