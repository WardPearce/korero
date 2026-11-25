import { Device } from "mediasoup-client";

export async function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = reject; });
  let nextId = 0;
  function rpc(type: string, args = {}): Promise<any> {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const receive = (message: MessageEvent) => {
        const response = JSON.parse(message.data);
        if (response.id !== id) return;
        ws.removeEventListener("message", receive);
        if (response.error) reject(new Error(response.error));
        else resolve(response.result);
      };
      ws.addEventListener("message", receive);
      ws.send(JSON.stringify({ id, method: type, args }));
    });
  }
  const device = await Device.factory();
  await device.load({ routerRtpCapabilities: await rpc("router") });
  return { device, rpc };
}

export async function send() {
  const { device, rpc } = await connect();
  const transport = device.createSendTransport(await rpc("transport"));
  transport.on("connect", ({ dtlsParameters }, ok, fail) => {
    rpc("connect", { dtlsParameters, transportId: transport.id }).then(ok, fail);
  });
  transport.on("produce", ({ rtpParameters }, ok, fail) => {
    rpc("produce", { rtpParameters, transportId: transport.id }).then(ok, fail);
  });
  const audio = new AudioContext();
  const oscillator = audio.createOscillator();
  const destination = audio.createMediaStreamDestination();
  oscillator.connect(destination);
  oscillator.start();
  await audio.resume();
  return (await transport.produce({ track: destination.stream.getAudioTracks()[0]! })).id;
}

export async function receive(producerId: string) {
  const { device, rpc } = await connect();
  const transport = device.createRecvTransport(await rpc("transport"));
  transport.on("connect", ({ dtlsParameters }, ok, fail) => {
    rpc("connect", { dtlsParameters, transportId: transport.id }).then(ok, fail);
  });
  const consumer = await transport.consume(await rpc("consume", {
    producerId, transportId: transport.id, rtpCapabilities: device.recvRtpCapabilities,
  }));
  const audio = new AudioContext();
  const element = new Audio();
  element.srcObject = new MediaStream([consumer.track]);
  element.muted = true;
  await element.play();
  const source = audio.createMediaStreamSource(new MediaStream([consumer.track]));
  const analyser = audio.createAnalyser();
  source.connect(analyser);
  const silence = audio.createGain();
  silence.gain.value = 0;
  analyser.connect(silence).connect(audio.destination);
  await audio.resume();
  const samples = new Float32Array(analyser.fftSize);
  for (let index = 0; index < 100; index++) {
    analyser.getFloatTimeDomainData(samples);
    for (const value of samples) if (Math.abs(value) > 0.01) return { amplitude: Math.abs(value) };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(JSON.stringify([transport.connectionState, ...Array.from((await consumer.getStats()).values())].filter((row) => typeof row === "string" || row.type === "inbound-rtp")));
}

Object.assign(window, { send, receive });
