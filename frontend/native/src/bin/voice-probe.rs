use anyhow::{ensure, Context, Result};
use korero_native::{
    media::RoomVoice,
    signaling::{Credentials, Server},
};
use serde_json::{json, Value};
use std::{io::Write, time::Duration};
use tokio::io::{AsyncBufReadExt, BufReader};

#[tokio::main]
async fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let address = args
        .next()
        .context("Usage: voice-probe SERVER CERTIFICATE.pem")?;
    let ca = std::fs::read(
        args.next()
            .context("Pass the server's trusted certificate")?,
    )?;
    let server = Server::new(&address, Some(&ca))?;
    let mut commands = BufReader::new(tokio::io::stdin()).lines();
    let credentials: Credentials =
        serde_json::from_str(&commands.next_line().await?.context("Expected device credentials")?)?;
    for pass in 1..=2 {
        let mut connection = server.authenticate(&credentials).await?;
        let lobby = connection.snapshot["channels"]
            .as_array()
            .context("Channel list missing")?
            .iter()
            .find(|channel| channel["name"] == "Lobby")
            .context("Lobby was not found")?;
        let channel = lobby["id"].as_str().context("Lobby ID missing")?.to_owned();
        let joined = connection
            .wire
            .rpc("channel.join", json!({"channelId": channel}))
            .await?;
        ensure!(
            joined["channelId"] == channel,
            "The server did not join Lobby"
        );
        let mut voice = RoomVoice::start(
            connection.wire.clone(),
            channel,
            connection.ice_servers,
            connection.bitrate,
            true,
            Default::default(),
        )
        .await?;
        voice.set_receiving(true).await?;
        voice.set_sending(true).await?;
        say(json!({"ready": pass, "connectionId": joined["connectionId"]}));
        let mut samples = tokio::time::interval(Duration::from_millis(80));
        let mut reported = false;
        loop {
            tokio::select! {
                line = commands.next_line() => {
                    ensure!(line?.as_deref() == Some("leave"), "Expected a leave command");
                    break;
                }
                event = connection.events.recv() => {
                    let event = event?;
                    let payload = &event["payload"];
                    if event["type"] == "media.producerAvailable" && payload["connectionId"] != joined["connectionId"] {
                        voice.add_producer(payload["producerId"].as_str().context("Invalid media event")?).await?;
                    } else if event["type"] == "media.producerClosed" {
                        voice.remove_producer(payload["producerId"].as_str().context("Invalid media event")?).await?;
                    }
                }
                _ = samples.tick(), if !reported => {
                    let peak = voice.peak().await?;
                    if peak > 0.025 {
                        say(json!({"decoded": pass, "peak": peak}));
                        reported = true;
                    }
                }
            }
        }
        ensure!(reported, "No decoded audio reached the native sink");
        voice.stop().await;
        let reply = connection.wire.rpc("channel.leave", json!({})).await?;
        ensure!(
            reply["channelId"].is_null(),
            "Channel leave did not take effect"
        );
        connection.wire.close().await;
        let _ = connection.wire.closed().await;
        say(json!({"left": pass}));
    }
    Ok(())
}

fn say(message: Value) {
    println!("{message}");
    let _ = std::io::stdout().flush();
}
