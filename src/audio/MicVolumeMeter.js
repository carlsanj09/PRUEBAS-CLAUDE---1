const FFT_SIZE = 2048
const ATTACK = 0.6
const RELEASE = 0.15
const MIN_PEAK_MAGNITUDE = 24 // 0-255 scale; filters out analyser noise floor

// Pitch perception is logarithmic, and most voice/instrument fundamentals sit
// low in the linear spectrum — mapping bin index directly would crush almost
// everything into one end of the color range. Log-mapping between a bass and
// a treble reference spreads real-world tones across the full hue range.
const LOG_FREQ_MIN = 80
const LOG_FREQ_MAX = 8000

export class MicVolumeMeter {
  constructor() {
    this.audioContext = null
    this.analyser = null
    this.timeData = null
    this.freqData = null
    this.stream = null
    this.smoothedVolume = 0
    this.sensitivity = 1
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)()
    const source = this.audioContext.createMediaStreamSource(this.stream)
    this.analyser = this.audioContext.createAnalyser()
    this.analyser.fftSize = FFT_SIZE
    this.analyser.smoothingTimeConstant = 0
    source.connect(this.analyser)
    this.timeData = new Uint8Array(this.analyser.fftSize)
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount)
  }

  setSensitivity(multiplier) {
    this.sensitivity = multiplier
  }

  getVolume() {
    if (!this.analyser) return 0
    this.analyser.getByteTimeDomainData(this.timeData)

    let sumSquares = 0
    for (let i = 0; i < this.timeData.length; i++) {
      const v = (this.timeData[i] - 128) / 128
      sumSquares += v * v
    }
    const rms = Math.sqrt(sumSquares / this.timeData.length) * this.sensitivity

    const smoothing = rms > this.smoothedVolume ? ATTACK : RELEASE
    this.smoothedVolume += (rms - this.smoothedVolume) * smoothing
    return this.smoothedVolume
  }

  // Finds the strongest, well-separated local maxima in the spectrum so
  // distinct tones (voice pitch, instrument harmonics) map to distinct points.
  getSpectralPeaks(maxPeaks = 4, minSeparation = 6) {
    if (!this.analyser) return []
    this.analyser.getByteFrequencyData(this.freqData)
    const data = this.freqData

    const candidates = []
    for (let i = 2; i < data.length - 2; i++) {
      const v = data[i]
      if (v < MIN_PEAK_MAGNITUDE) continue
      if (v >= data[i - 1] && v >= data[i + 1] && v >= data[i - 2] && v >= data[i + 2]) {
        candidates.push({ index: i, magnitude: v })
      }
    }
    candidates.sort((a, b) => b.magnitude - a.magnitude)

    const peaks = []
    for (const c of candidates) {
      if (peaks.length >= maxPeaks) break
      if (peaks.some((p) => Math.abs(p.index - c.index) < minSeparation)) continue
      peaks.push(c)
    }

    const sampleRate = this.audioContext.sampleRate
    const logMin = Math.log2(LOG_FREQ_MIN)
    const logMax = Math.log2(LOG_FREQ_MAX)

    return peaks.map((p) => {
      const hz = (p.index * sampleRate) / this.analyser.fftSize
      const logHz = Math.log2(Math.max(hz, LOG_FREQ_MIN))
      const freqRatio = Math.min(Math.max((logHz - logMin) / (logMax - logMin), 0), 1)
      return { freqRatio, magnitude: p.magnitude / 255 }
    })
  }

  stop() {
    this.stream?.getTracks().forEach((track) => track.stop())
    this.audioContext?.close()
    this.stream = null
    this.audioContext = null
    this.analyser = null
    this.timeData = null
    this.freqData = null
  }
}
