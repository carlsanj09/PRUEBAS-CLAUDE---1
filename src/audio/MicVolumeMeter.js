const FFT_SIZE = 512
const SMOOTHING = 0.3

export class MicVolumeMeter {
  constructor() {
    this.audioContext = null
    this.analyser = null
    this.dataArray = null
    this.stream = null
    this.smoothedVolume = 0
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)()
    const source = this.audioContext.createMediaStreamSource(this.stream)
    this.analyser = this.audioContext.createAnalyser()
    this.analyser.fftSize = FFT_SIZE
    source.connect(this.analyser)
    this.dataArray = new Uint8Array(this.analyser.fftSize)
  }

  getVolume() {
    if (!this.analyser) return 0
    this.analyser.getByteTimeDomainData(this.dataArray)

    let sumSquares = 0
    for (let i = 0; i < this.dataArray.length; i++) {
      const v = (this.dataArray[i] - 128) / 128
      sumSquares += v * v
    }
    const rms = Math.sqrt(sumSquares / this.dataArray.length)
    this.smoothedVolume += (rms - this.smoothedVolume) * SMOOTHING
    return this.smoothedVolume
  }

  stop() {
    this.stream?.getTracks().forEach((track) => track.stop())
    this.audioContext?.close()
    this.stream = null
    this.audioContext = null
    this.analyser = null
    this.dataArray = null
  }
}
