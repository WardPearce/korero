use crate::signaling::Wire;
use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use tokio::{
    runtime::Handle,
    sync::{mpsc, oneshot},
};

#[cxx::bridge(namespace = "korero")]
mod ffi {
    extern "Rust" {
        type Rpc;
        fn rpc_call(rpc: &Rpc, method: &str, body: &str) -> Result<String>;
    }

    unsafe extern "C++" {
        include!("cpp/voice.hpp");

        type Voice;
        fn set_audio_profile(settings: &str) -> Result<()>;
        fn set_push_to_talk(pressed: bool);
        fn audio_devices() -> Result<String>;
        fn test_microphone() -> Result<f64>;
        #[cfg(target_os = "android")]
        fn initialize_android(env: usize, context: usize) -> bool;
        fn make_voice(
            rpc: Box<Rpc>,
            capabilities: &str,
            ice_servers: &str,
            synthetic: bool,
        ) -> Result<UniquePtr<Voice>>;
        fn capabilities(self: &Voice) -> Result<String>;
        fn set_send(self: Pin<&mut Voice>, transport: &str) -> Result<()>;
        fn set_receive(self: Pin<&mut Voice>, transport: &str) -> Result<()>;
        fn consume(self: Pin<&mut Voice>, parameters: &str) -> Result<()>;
        fn close_consumer(self: Pin<&mut Voice>, producer_id: &str) -> Result<()>;
        fn peak(self: &Voice) -> f64;
    }
}

#[cfg(target_os = "android")]
pub fn initialize_android(env: usize, context: usize) -> bool {
    ffi::initialize_android(env, context)
}

#[derive(Clone, Default, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioProfile {
    pub input: String,
    pub output: String,
    pub input_level: u8,
    pub output_level: u8,
    pub transmit_mode: TransmitMode,
    pub activity_threshold: u8,
    pub noise_suppression: bool,
    pub automatic_gain: bool,
    pub echo_cancellation: bool,
}

#[derive(Clone, Default, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TransmitMode {
    #[default]
    Open,
    Activity,
    PushToTalk,
}

pub fn set_audio_profile(profile: &AudioProfile) -> Result<()> {
    anyhow::ensure!(profile.input_level <= 100 && profile.output_level <= 100 &&
        (1..=100).contains(&profile.activity_threshold) && profile.input.len() <= 4096 &&
        profile.output.len() <= 4096, "Invalid audio preferences");
    Ok(ffi::set_audio_profile(&serde_json::to_string(profile)?)?)
}

pub fn set_push_to_talk(pressed: bool) {
    ffi::set_push_to_talk(pressed);
}

pub fn audio_devices() -> Result<Value> {
    Ok(serde_json::from_str(&ffi::audio_devices()?)?)
}

pub fn test_microphone() -> Result<f64> {
    Ok(ffi::test_microphone()?)
}

pub struct Rpc {
    runtime: Handle,
    wire: Wire,
}

fn rpc_call(rpc: &Rpc, method: &str, body: &str) -> Result<String> {
    let input = serde_json::from_str(body)?;
    let result = rpc.runtime.block_on(rpc.wire.rpc(method, input))?;
    Ok(result.to_string())
}

type Reply = oneshot::Sender<Result<f64>>;

enum Operation {
    Send(Option<Value>),
    Receive(Option<Value>),
    Consume(Value),
    CloseConsumer(String),
    Peak,
    Stop,
}

struct VoiceThread {
    commands: mpsc::Sender<(Operation, Reply)>,
}

impl VoiceThread {
    async fn start(
        wire: Wire,
        capabilities: Value,
        ice: Value,
        synthetic: bool,
    ) -> Result<(Self, Value)> {
        let rpc = Box::new(Rpc {
            runtime: Handle::current(),
            wire,
        });
        let (commands, mut current) = mpsc::channel::<(Operation, Reply)>(32);
        let (ready, initialized) = oneshot::channel::<Result<Value>>();
        std::thread::Builder::new()
            .name("korero-voice".into())
            .spawn(move || {
                let setup = || -> Result<_> {
                    let voice = ffi::make_voice(
                        rpc,
                        &capabilities.to_string(),
                        &ice.to_string(),
                        synthetic,
                    )?;
                    let rtp = serde_json::from_str(&voice.capabilities()?)?;
                    Ok((voice, rtp))
                };
                let (mut voice, rtp) = match setup() {
                    Ok(result) => result,
                    Err(error) => {
                        let _ = ready.send(Err(error));
                        return;
                    }
                };
                if ready.send(Ok(rtp)).is_err() {
                    return;
                }
                while let Some((operation, reply)) = current.blocking_recv() {
                    let result = match operation {
                        Operation::Send(options) => voice.pin_mut().set_send(&serialize(options)),
                        Operation::Receive(options) => {
                            voice.pin_mut().set_receive(&serialize(options))
                        }
                        Operation::Consume(options) => {
                            voice.pin_mut().consume(&options.to_string())
                        }
                        Operation::CloseConsumer(id) => voice.pin_mut().close_consumer(&id),
                        Operation::Peak => {
                            let _ = reply.send(Ok(voice.peak()));
                            continue;
                        }
                        Operation::Stop => {
                            drop(voice);
                            let _ = reply.send(Ok(0.0));
                            break;
                        }
                    };
                    let _ = reply.send(result.map(|()| 0.0).map_err(anyhow::Error::from));
                }
            })?;
        let rtp = initialized
            .await
            .context("Native audio stopped during initialization")??;
        Ok((Self { commands }, rtp))
    }

    async fn request(&self, operation: Operation) -> Result<f64> {
        let (send, receive) = oneshot::channel();
        self.commands
            .send((operation, send))
            .await
            .context("Native audio has closed")?;
        receive.await.context("Native audio has closed")?
    }
}

fn serialize(value: Option<Value>) -> String {
    value.map(|value| value.to_string()).unwrap_or_default()
}

pub struct RoomVoice {
    wire: Wire,
    worker: VoiceThread,
    rtp: Value,
    send_id: Option<String>,
    receive_id: Option<String>,
    consumers: std::collections::HashMap<String, String>,
    bitrate: u32,
    pub channel: String,
}

impl RoomVoice {
    pub async fn start(
        wire: Wire,
        channel: String,
        ice: Value,
        bitrate: u32,
        synthetic: bool,
    ) -> Result<Self> {
        let router = wire.rpc("media.capabilities", json!({})).await?;
        let (worker, rtp) = VoiceThread::start(wire.clone(), router, ice, synthetic).await?;
        Ok(Self {
            wire,
            worker,
            rtp,
            send_id: None,
            receive_id: None,
            consumers: Default::default(),
            bitrate,
            channel,
        })
    }

    pub async fn set_sending(&mut self, sending: bool) -> Result<()> {
        if !sending {
            if let Some(id) = self.send_id.take() {
                let local = self.worker.request(Operation::Send(None)).await;
                let _ = self
                    .wire
                    .rpc("media.transport.close", json!({"transportId": id}))
                    .await;
                local?;
            }
        } else if self.send_id.is_none() {
            let mut transport = self
                .wire
                .rpc("media.transport.create", json!({"direction": "send"}))
                .await?;
            transport["bitrate"] = json!(self.bitrate);
            let id = field(&transport, "id")?.to_owned();
            if let Err(error) = self.worker.request(Operation::Send(Some(transport))).await {
                let _ = self.worker.request(Operation::Send(None)).await;
                let _ = self
                    .wire
                    .rpc("media.transport.close", json!({"transportId": id}))
                    .await;
                return Err(error);
            }
            self.send_id = Some(id);
        }
        Ok(())
    }

    pub async fn set_receiving(&mut self, receiving: bool) -> Result<()> {
        if !receiving {
            if let Some(id) = self.receive_id.take() {
                self.consumers.clear();
                let local = self.worker.request(Operation::Receive(None)).await;
                let _ = self
                    .wire
                    .rpc("media.transport.close", json!({"transportId": id}))
                    .await;
                local?;
            }
        } else if self.receive_id.is_none() {
            let transport = self
                .wire
                .rpc("media.transport.create", json!({"direction": "receive"}))
                .await?;
            let id = field(&transport, "id")?.to_owned();
            if let Err(error) = self
                .worker
                .request(Operation::Receive(Some(transport)))
                .await
            {
                let _ = self
                    .wire
                    .rpc("media.transport.close", json!({"transportId": id}))
                    .await;
                return Err(error);
            }
            self.receive_id = Some(id);
            self.sync_producers().await?;
        }
        Ok(())
    }

    pub async fn sync_producers(&mut self) -> Result<()> {
        let producers = self.wire.rpc("media.producers", json!({})).await?;
        for producer in producers.as_array().context("Invalid producer list")? {
            self.add_producer(field(producer, "producerId")?).await?;
        }
        Ok(())
    }

    pub async fn add_producer(&mut self, id: &str) -> Result<()> {
        let Some(transport) = &self.receive_id else {
            return Ok(());
        };
        if self.consumers.contains_key(id) {
            return Ok(());
        }
        let parameters = match self
            .wire
            .rpc(
                "media.consumer.create",
                json!({
                    "transportId": transport, "producerId": id, "rtpCapabilities": self.rtp,
                }),
            )
            .await
        {
            Ok(parameters) => parameters,
            Err(error) if error.to_string().starts_with("NOT_FOUND:") => return Ok(()),
            Err(error) => return Err(error),
        };
        let consumer = field(&parameters, "id")?.to_owned();
        let result = async {
            self.worker.request(Operation::Consume(parameters)).await?;
            self.wire
                .rpc("media.consumer.resume", json!({"consumerId": consumer}))
                .await?;
            Ok::<_, anyhow::Error>(())
        }
        .await;
        if let Err(error) = result {
            let _ = self
                .worker
                .request(Operation::CloseConsumer(id.into()))
                .await;
            let _ = self
                .wire
                .rpc("media.consumer.close", json!({"consumerId": consumer}))
                .await;
            if error.to_string().starts_with("NOT_FOUND:") {
                return Ok(());
            }
            return Err(error);
        }
        self.consumers.insert(id.into(), consumer);
        Ok(())
    }

    pub async fn remove_producer(&mut self, id: &str) -> Result<()> {
        if self.consumers.remove(id).is_some() {
            self.worker
                .request(Operation::CloseConsumer(id.into()))
                .await?;
        }
        Ok(())
    }

    pub async fn stop(self) {
        let _ = self.worker.request(Operation::Stop).await;
        for id in [self.send_id, self.receive_id].into_iter().flatten() {
            let _ = self
                .wire
                .rpc("media.transport.close", json!({"transportId": id}))
                .await;
        }
    }

    pub async fn peak(&self) -> Result<f64> {
        self.worker.request(Operation::Peak).await
    }
}

fn field<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .ok_or_else(|| anyhow!("Media response omitted {key}"))
}
