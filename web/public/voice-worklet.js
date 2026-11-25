// Voice capture: cuts the microphone into 20 ms frames (960 samples at 48 kHz) for the
// encoder, and reports how loud each frame was, for the speaking ring.
class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.frame = new Float32Array(960)
    this.filled = 0
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0]
    if (!input) return true
    let offset = 0
    while (offset < input.length) {
      const n = Math.min(input.length - offset, 960 - this.filled)
      this.frame.set(input.subarray(offset, offset + n), this.filled)
      this.filled += n
      offset += n
      if (this.filled === 960) {
        let sum = 0
        for (let i = 0; i < 960; i++) sum += this.frame[i] * this.frame[i]
        const out = this.frame.slice()
        this.port.postMessage({ pcm: out, level: Math.sqrt(sum / 960) }, [out.buffer])
        this.filled = 0
      }
    }
    return true
  }
}

registerProcessor('voice-capture', VoiceCapture)
