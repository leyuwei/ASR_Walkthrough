class PcmRecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs?.[0]?.[0];
    if (input && input.length) {
      this.port.postMessage({ samples: input });
    }
    return true;
  }
}

registerProcessor("pcm-recorder", PcmRecorderProcessor);
