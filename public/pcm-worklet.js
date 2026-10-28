/**
 * 采集用 AudioWorklet：把麦克风数据降采样成 16k 单声道 Int16，
 * 每 100ms 发一帧给主线程（一帧 1600 样本 = 3200 字节）。
 *
 * 降采样用「分组求平均」而不是抽样，避免混叠把 8k 以上的噪声折回人声频段。
 */
class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetRate || 16000;
    this.frameSamples = Math.round(this.targetRate / 10); // 100ms
    this.ratio = sampleRate / this.targetRate;

    this.acc = 0;
    this.accCount = 0;
    this.frame = new Float32Array(this.frameSamples);
    this.frameLen = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];

    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i];
      this.accCount += 1;
      if (this.accCount >= this.ratio) {
        this.frame[this.frameLen++] = this.acc / this.accCount;
        this.acc = 0;
        this.accCount = 0;

        if (this.frameLen >= this.frameSamples) {
          const pcm = new Int16Array(this.frameSamples);
          for (let j = 0; j < this.frameSamples; j++) {
            const v = Math.max(-1, Math.min(1, this.frame[j]));
            pcm[j] = v < 0 ? v * 0x8000 : v * 0x7fff;
          }
          this.port.postMessage(pcm.buffer, [pcm.buffer]);
          this.frameLen = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);
