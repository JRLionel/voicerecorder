/**
 * 采音：16k 单声道 PCM。
 *
 * 优先 AudioWorklet（/pcm-worklet.js），Safari 老版本退回 ScriptProcessor。
 * 必须连到 destination 才会被拉取，用 0 增益避免自听回授。
 */

export class PcmCapture {
  /**
   * @param {{onFrame:(buffer:ArrayBuffer)=>void, targetRate?:number}} opts
   */
  constructor({ onFrame, targetRate = 16000 } = {}) {
    this.onFrame = onFrame;
    this.targetRate = targetRate;
    this.ctx = null;
    this.node = null;
    this.scriptNode = null;
    this.stream = null;
  }

  async start(stream) {
    this.stream = stream;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    let ctx;
    try {
      ctx = new Ctx({ sampleRate: this.targetRate });
    } catch {
      ctx = new Ctx();
    }
    this.ctx = ctx;
    if (ctx.state === "suspended") await ctx.resume();

    const source = ctx.createMediaStreamSource(stream);

    try {
      await ctx.audioWorklet.addModule("/pcm-worklet.js");
      const node = new AudioWorkletNode(ctx, "pcm-capture", {
        processorOptions: { targetRate: this.targetRate },
      });
      node.port.onmessage = (ev) => this.onFrame(ev.data);
      source.connect(node);
      const sink = ctx.createGain();
      sink.gain.value = 0;
      node.connect(sink).connect(ctx.destination);
      this.node = node;
    } catch {
      // Safari 老版本没有 AudioWorklet：退回 ScriptProcessor，同样降采样到 16k
      const ratio = ctx.sampleRate / this.targetRate;
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      let acc = 0;
      let count = 0;
      let frame = [];
      proc.onaudioprocess = (ev) => {
        const ch = ev.inputBuffer.getChannelData(0);
        for (let i = 0; i < ch.length; i += 1) {
          acc += ch[i];
          count += 1;
          if (count >= ratio) {
            frame.push(acc / count);
            acc = 0;
            count = 0;
            if (frame.length >= 1600) {
              const pcm = new Int16Array(1600);
              for (let j = 0; j < 1600; j += 1) {
                const v = Math.max(-1, Math.min(1, frame[j]));
                pcm[j] = v < 0 ? v * 0x8000 : v * 0x7fff;
              }
              this.onFrame(pcm.buffer);
              frame = [];
            }
          }
        }
      };
      source.connect(proc);
      const sink = ctx.createGain();
      sink.gain.value = 0;
      proc.connect(sink).connect(ctx.destination);
      this.scriptNode = proc;
    }
  }

  stop() {
    try { this.node && this.node.disconnect(); } catch {}
    try { this.scriptNode && this.scriptNode.disconnect(); } catch {}
    try { this.stream && this.stream.getTracks().forEach((t) => t.stop()); } catch {}
    try { this.ctx && this.ctx.state !== "closed" && this.ctx.close(); } catch {}
    this.node = null;
    this.scriptNode = null;
    this.stream = null;
    this.ctx = null;
  }
}
