//! hs-teamspeak: lets the Hamsohbat desktop app join TeamSpeak 3 servers.
//! Reads one JSON command per line on stdin and writes one JSON event per line on stdout.
//! Built on tsclientlib (MIT/Apache-2.0, https://github.com/ReSpeak/tsclientlib).
#![windows_subsystem = "windows"]

mod audio;

use std::io::{BufRead, Write};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use futures::prelude::*;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use tsclientlib::events::{Event, PropertyId, PropertyValue};
use tsclientlib::messages::c2s;
use tsclientlib::prelude::*;
use tsclientlib::{data, ChannelId, ChannelType, ClientId, ClientType, Connection, DisconnectOptions, Identity, MaxClients, MessageTarget, Reason, StreamItem};
use tsproto_packets::packets::{AudioData, OutPacket};

pub fn emit(v: Value) {
	let mut out = std::io::stdout().lock();
	let _ = writeln!(out, "{v}");
	let _ = out.flush();
}

fn s(v: &Value, k: &str) -> String { v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string() }
fn b(v: &Value, k: &str) -> bool { v.get(k).and_then(|x| x.as_bool()).unwrap_or(false) }
fn n(v: &Value, k: &str) -> u64 { v.get(k).and_then(|x| x.as_u64()).unwrap_or(0) }

/// TeamSpeak shows unique ids in base64.
fn b64(data: &[u8]) -> String {
	const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	let mut out = String::new();
	for c in data.chunks(3) {
		let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
		for i in 0..4 {
			out.push(if i <= c.len() { T[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
		}
	}
	out
}

fn snapshot(state: &data::Connection) -> Value {
	let channels: Vec<Value> = state
		.channels
		.values()
		.map(|c| {
			json!({
				"id": c.id.0,
				"parent": c.parent.0,
				"order": c.order.0,
				"name": c.name,
				"topic": c.topic,
				"maxClients": match c.max_clients { Some(MaxClients::Limited(n)) => n as i64, _ => -1 },
				"hasPassword": c.has_password.unwrap_or(false),
				"isDefault": c.is_default.unwrap_or(false),
				"neededTalkPower": c.needed_talk_power.unwrap_or(0),
				"type": match c.channel_type { ChannelType::Permanent => "permanent", ChannelType::SemiPermanent => "semi", _ => "temporary" },
				"codec": format!("{:?}", c.codec),
				"codecQuality": c.codec_quality.unwrap_or(0),
				"description": c.optional_data.as_ref().map(|o| o.description.clone()).unwrap_or_default(),
				"silenced": c.forced_silence,
			})
		})
		.collect();
	let clients: Vec<Value> = state
		.clients
		.values()
		.filter(|c| matches!(c.client_type, ClientType::Normal))
		.map(|c| {
			json!({
				"id": c.id.0,
				"channel": c.channel.0,
				"name": c.name,
				"inputMuted": c.input_muted,
				"outputMuted": c.output_muted,
				"inputHardware": c.input_hardware_enabled,
				"outputHardware": c.output_hardware_enabled,
				"away": c.away_message,
				"recording": c.is_recording,
				"talkPower": c.talk_power,
				"dbId": c.database_id.0,
				"description": c.description,
				"isMe": c.id == state.own_client,
				"uid": c.uid.as_ref().map(|u| b64(&u.as_ref().0)).unwrap_or_default(),
				"serverGroups": c.server_groups.iter().map(|g| g.0).collect::<Vec<_>>(),
				"channelGroup": c.channel_group.0,
				"country": c.country_code,
				"talker": c.talk_power_granted,
				"prioritySpeaker": c.is_priority_speaker,
				"talkRequest": c.talk_power_request.as_ref().map(|r| r.message.clone()),
				"version": c.optional_data.as_ref().map(|o| o.version.clone()),
				"platform": c.optional_data.as_ref().map(|o| o.platform.clone()),
				"created": c.optional_data.as_ref().map(|o| o.created.unix_timestamp()),
				"connections": c.optional_data.as_ref().map(|o| o.connections_total),
				"ping": c.connection_data.as_ref().and_then(|d| d.ping).map(|p| p.whole_milliseconds() as i64),
				"connectedFor": c.connection_data.as_ref().and_then(|d| d.connected_time).map(|p| p.whole_seconds()),
				"idleFor": c.connection_data.as_ref().map(|d| d.idle_time.whole_seconds()),
				"loss": c.connection_data.as_ref().and_then(|d| d.server_to_client_packetloss_total),
			})
		})
		.collect();
	json!({
		"type": "state",
		"server": {
			"name": state.server.name,
			"welcome": state.server.welcome_message,
			"platform": state.server.platform,
			"version": state.server.version,
			"maxClients": state.server.max_clients,
			"created": state.server.created.unix_timestamp(),
			"hostMessage": state.server.hostmessage,
			"banner": state.server.hostbanner_gfx_url,
			"bannerUrl": state.server.hostbanner_url,
			"buttonUrl": state.server.hostbutton_url,
			"buttonTooltip": state.server.hostbutton_tooltip,
			"uptime": state.server.optional_data.as_ref().map(|o| o.uptime.whole_seconds()),
		},
		"serverGroups": state.server_groups.values().map(|g| json!({"id": g.id.0, "name": g.name, "sort": g.sort_id})).collect::<Vec<_>>(),
		"channelGroups": state.channel_groups.values().map(|g| json!({"id": g.id.0, "name": g.name, "sort": g.sort_id})).collect::<Vec<_>>(),
		"own": state.own_client.0,
		"channels": channels,
		"clients": clients,
	})
}

fn reason_text(r: &Option<Reason>) -> &'static str {
	match r {
		Some(Reason::LostConnection) => "timeout",
		Some(Reason::KickChannel) => "kickChannel",
		Some(Reason::KickServer) => "kickServer",
		Some(Reason::KickServerBan) => "ban",
		Some(Reason::Serverstop) => "serverStop",
		Some(Reason::Moved) => "moved",
		_ => "",
	}
}

/// Turns bookkeeping events into readable log entries.
fn log_events(events: &[Event], state: &data::Connection) {
	let chan = |id: ChannelId| state.channels.get(&id).map(|c| c.name.clone()).unwrap_or_default();
	for e in events {
		let by = e.get_invoker().map(|i| i.name.clone());
		let entry = match e {
			Event::PropertyAdded { id: PropertyId::Client(cid), extra, .. } => {
				if matches!(extra.reason, Some(Reason::Subscription)) {
					continue;
				}
				let Some(c) = state.clients.get(cid) else { continue };
				if !matches!(c.client_type, ClientType::Normal) || *cid == state.own_client {
					continue;
				}
				json!({"kind": "join", "name": c.name, "channel": chan(c.channel)})
			}
			Event::PropertyRemoved { id: PropertyId::Client(_), old: PropertyValue::Client(c), extra, .. } => {
				if matches!(extra.reason, Some(Reason::Subscription)) || !matches!(c.client_type, ClientType::Normal) {
					continue;
				}
				json!({"kind": "leave", "name": c.name, "reason": reason_text(&extra.reason), "by": by})
			}
			Event::PropertyChanged { id: PropertyId::ClientChannel(cid), old: PropertyValue::ChannelId(from), extra, .. } => {
				let Some(c) = state.clients.get(cid) else { continue };
				json!({"kind": "move", "name": c.name, "from": chan(*from), "to": chan(c.channel), "reason": reason_text(&extra.reason), "by": by, "me": *cid == state.own_client})
			}
			Event::PropertyChanged { id: PropertyId::ClientName(cid), old: PropertyValue::String(old), .. } => {
				let Some(c) = state.clients.get(cid) else { continue };
				json!({"kind": "rename", "from": old, "name": c.name})
			}
			Event::PropertyAdded { id: PropertyId::Channel(cid), .. } => json!({"kind": "channelCreate", "name": chan(*cid), "by": by}),
			Event::PropertyRemoved { id: PropertyId::Channel(_), old: PropertyValue::Channel(c), .. } => json!({"kind": "channelDelete", "name": c.name, "by": by}),
			Event::PropertyChanged { id: PropertyId::ChannelName(cid), old: PropertyValue::String(old), .. } => {
				json!({"kind": "channelRename", "from": old, "name": chan(*cid), "by": by})
			}
			Event::PropertyAdded { id: PropertyId::ClientServerGroup(cid, gid), .. } => {
				let Some(c) = state.clients.get(cid) else { continue };
				json!({"kind": "groupAdd", "name": c.name, "group": state.server_groups.get(gid).map(|g| g.name.clone()), "by": by})
			}
			Event::PropertyRemoved { id: PropertyId::ClientServerGroup(cid, gid), .. } => {
				let Some(c) = state.clients.get(cid) else { continue };
				json!({"kind": "groupRemove", "name": c.name, "group": state.server_groups.get(gid).map(|g| g.name.clone()), "by": by})
			}
			_ => continue,
		};
		let mut v = entry;
		v["type"] = json!("log");
		emit(v);
	}
}

enum Action {
	Item(Option<Result<StreamItem, tsclientlib::Error>>),
	Cmd(Option<Value>),
	Audio(Option<OutPacket>),
	Tick,
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
	// Commands arrive on stdin; a thread forwards them so the async loop never blocks.
	let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<Value>();
	std::thread::spawn(move || {
		for line in std::io::stdin().lock().lines() {
			let Ok(line) = line else { break };
			if let Ok(v) = serde_json::from_str::<Value>(&line) {
				if cmd_tx.send(v).is_err() {
					break;
				}
			}
		}
	});

	let shared = Arc::new(audio::Shared::default());
	shared.noise.store(std::env::var("HS_TS_TEST_AUDIO").is_err(), Ordering::Relaxed);
	shared.threshold.store((-50.0f32).to_bits(), Ordering::Relaxed);
	let (pkt_tx, mut pkt_rx) = mpsc::channel::<OutPacket>(16);
	let mut audio: Option<audio::Audio> = None;
	let (mut in_dev, mut out_dev) = (String::new(), String::new());
	let mut con: Option<Connection> = None;
	let mut connected = false;
	let mut last_state = String::new();
	let mut last_talking: Vec<u16> = Vec::new();
	let mut last_level = (-1i32, false);
	// Like the official client: subscribe to every channel so everybody on the server is visible.
	let mut subscribe = false;
	// A connection that is saying goodbye to the server (finished asynchronously).
	let mut leaving: Option<Connection> = None;
	let mut quit = false;
	let mut ticks = 0u32;
	let mut tick = tokio::time::interval(Duration::from_millis(100));
	emit(json!({"type": "ready", "version": env!("CARGO_PKG_VERSION")}));

	loop {
		let action = if let Some(c) = con.as_mut() {
			let mut ev = c.events();
			tokio::select! {
				item = ev.next() => Action::Item(item),
				c = cmd_rx.recv() => Action::Cmd(c),
				p = pkt_rx.recv() => Action::Audio(p),
				_ = tick.tick() => Action::Tick,
			}
		} else {
			tokio::select! {
				c = cmd_rx.recv() => Action::Cmd(c),
				p = pkt_rx.recv() => Action::Audio(p),
				_ = tick.tick() => Action::Tick,
			}
		};

		if let Some(mut c) = leaving.take() {
			// Tell the server we are leaving and wait (briefly) until it acknowledges.
			if c.disconnect(DisconnectOptions::new().message("Leaving")).is_ok() {
				let _ = tokio::time::timeout(Duration::from_secs(3), c.events().for_each(|_| future::ready(()))).await;
			}
		}
		if quit {
			break;
		}
		if subscribe {
			subscribe = false;
			if let Some(c) = con.as_mut() {
				if let Ok(state) = c.get_state() {
					let cmd = state.server.set_subscribed(true);
					let _ = cmd.send(c);
				}
			}
		}
		match action {
			Action::Item(None) => {
				con = None;
				connected = false;
				emit(json!({"type": "status", "state": "disconnected"}));
			}
			Action::Item(Some(Err(e))) => {
				con = None;
				connected = false;
				emit(json!({"type": "status", "state": "disconnected", "reason": e.to_string()}));
			}
			Action::Item(Some(Ok(item))) => match item {
				StreamItem::BookEvents(events) => {
					let own = con.as_ref().and_then(|c| c.get_state().ok()).map(|st| st.own_client);
					if connected {
						if let Some(state) = con.as_ref().and_then(|c| c.get_state().ok()) {
							log_events(&events, state);
						}
					}
					for e in &events {
						if let Event::Message { target, invoker, message } = e {
							if Some(invoker.id) == own && !matches!(target, MessageTarget::Poke(_)) {
								continue; // already shown when it was sent
							}
							let from = json!({"id": invoker.id.0, "name": invoker.name});
							match target {
								MessageTarget::Poke(_) => emit(json!({"type": "poke", "from": from, "text": message})),
								MessageTarget::Server => emit(json!({"type": "message", "target": "server", "from": from, "text": message})),
								MessageTarget::Channel => emit(json!({"type": "message", "target": "channel", "from": from, "text": message})),
								MessageTarget::Client(to) => emit(json!({"type": "message", "target": "client", "client": to.0, "from": from, "text": message})),
							}
						}
					}
					if let Some(state) = con.as_ref().and_then(|c| c.get_state().ok()) {
						if !connected {
							connected = true;
							emit(json!({"type": "status", "state": "connected"}));
							emit(json!({"type": "log", "kind": "connected", "name": state.server.name}));
							subscribe = true;
						}
						let snap = snapshot(state);
						let text = snap.to_string();
						if text != last_state {
							last_state = text;
							emit(snap);
						}
					}
				}
				StreamItem::Audio(packet) => {
					let from = match packet.data().data() {
						AudioData::S2C { from, .. } => Some(*from),
						AudioData::S2CWhisper { from, .. } => Some(*from),
						_ => None,
					};
					if let (Some(from), Some(a)) = (from, audio.as_ref()) {
						a.play_packet(ClientId(from), packet);
					}
				}
				StreamItem::MessageResult(_, Err(e)) => {
					emit(json!({"type": "error", "message": e.to_string()}));
					emit(json!({"type": "log", "kind": "error", "text": e.to_string()}));
				}
				StreamItem::DisconnectedTemporarily(reason) => {
					emit(json!({"type": "status", "state": "reconnecting", "reason": format!("{reason:?}")}));
				}
				StreamItem::IdentityLevelIncreasing(level) => {
					emit(json!({"type": "status", "state": "connecting", "reason": format!("Improving identity security level to {level}")}));
				}
				_ => {}
			},
			Action::Audio(Some(packet)) => {
				if connected {
					if let Some(c) = con.as_mut() {
						let _ = c.send_audio(packet);
					}
				}
			}
			Action::Audio(None) => {}
			Action::Tick => {
				ticks = ticks.wrapping_add(1);
				if ticks % 10 == 0 && connected {
					if let Some(stats) = con.as_ref().and_then(|c| c.get_network_stats().ok()) {
						let last = stats.get_last_second_bytes();
						emit(json!({
							"type": "stats",
							"ping": stats.rtt.as_secs_f64() * 1000.0,
							"pingDev": stats.rtt_dev.as_secs_f64() * 1000.0,
							"loss": stats.get_packetloss_s2c_speech().max(stats.get_packetloss_s2c_keepalive()),
							"bytesIn": last[0] as u64 + last[1] as u64 + last[2] as u64,
							"bytesOut": last[3] as u64 + last[4] as u64 + last[5] as u64,
						}));
					}
				}
				if let Some(a) = audio.as_ref() {
					let talking = a.talking();
					if talking != last_talking {
						last_talking = talking.clone();
						emit(json!({"type": "talking", "ids": talking}));
					}
					let db = f32::from_bits(shared.level.load(Ordering::Relaxed));
					let tx = shared.transmitting.load(Ordering::Relaxed);
					let level = (((db + 55.0) / 7.0).round() as i32).clamp(0, 5);
					if (level, tx) != last_level {
						last_level = (level, tx);
						emit(json!({"type": "level", "db": db, "level": level, "tx": tx}));
					}
				}
			}
			Action::Cmd(None) => break,
			Action::Cmd(Some(cmd)) => {
				let name = s(&cmd, "cmd");
				let result: anyhow::Result<()> = (|| {
					match name.as_str() {
						"connect" => {
							if let Some(mut c) = con.take() {
								let _ = c.disconnect(DisconnectOptions::new());
							}
							connected = false;
							last_state.clear();
							let identity = match Identity::new_from_str(&s(&cmd, "identity")) {
								Ok(id) if !s(&cmd, "identity").is_empty() => id,
								_ => {
									let id = Identity::create();
									emit(json!({"type": "identity", "value": format!("{}V{}", id.counter(), id.key().to_ts())}));
									id
								}
							};
							shared.muted.store(b(&cmd, "muted"), Ordering::Relaxed);
							shared.deaf.store(b(&cmd, "deaf"), Ordering::Relaxed);
							let mut cfg = Connection::build(s(&cmd, "address"))
								.name(s(&cmd, "nickname"))
								.identity(identity)
								.input_muted(b(&cmd, "muted"))
								.output_muted(b(&cmd, "deaf"));
							if !s(&cmd, "password").is_empty() {
								cfg = cfg.password(s(&cmd, "password"));
							}
							if !s(&cmd, "channel").is_empty() {
								cfg = cfg.channel(s(&cmd, "channel"));
							}
							if !s(&cmd, "channelPassword").is_empty() {
								cfg = cfg.channel_password(s(&cmd, "channelPassword"));
							}
							if audio.is_none() {
								audio = Some(audio::Audio::start(shared.clone(), pkt_tx.clone(), &in_dev, &out_dev));
							}
							emit(json!({"type": "status", "state": "connecting"}));
							con = Some(cfg.connect()?);
						}
						"disconnect" => {
							if let Some(c) = con.take() {
								leaving = Some(c);
							}
							connected = false;
							last_state.clear();
							audio = None;
							emit(json!({"type": "status", "state": "disconnected"}));
						}
						"join" => {
							if let Some(c) = con.as_mut() {
								let state = c.get_state()?;
								let me = state.clients.get(&state.own_client).ok_or_else(|| anyhow::anyhow!("not connected"))?;
								let pw = s(&cmd, "password");
								let mut mv = me.client_move(ChannelId(n(&cmd, "channel")));
								if !pw.is_empty() {
									mv = mv.set_password(&pw);
								}
								mv.send_with_result(c)?;
							}
						}
						"message" => {
							if let Some(c) = con.as_mut() {
								let target = match s(&cmd, "target").as_str() {
									"server" => MessageTarget::Server,
									"client" => MessageTarget::Client(ClientId(n(&cmd, "client") as u16)),
									_ => MessageTarget::Channel,
								};
								let text = s(&cmd, "text");
								let state = c.get_state()?;
								let me = state.clients.get(&state.own_client).map(|m| (m.id.0, m.name.clone())).unwrap_or_default();
								state.send_message(target, &text).send(c)?;
								let kind = s(&cmd, "target");
								emit(json!({"type": "message", "target": if kind == "client" || kind == "server" { kind.as_str() } else { "channel" }, "client": n(&cmd, "client"), "from": {"id": me.0, "name": me.1}, "text": text}));
							}
						}
						"info" => {
							// Ask the server for version, platform, ping and connection time of a user.
							if let Some(c) = con.as_mut() {
								let state = c.get_state()?;
								if let Some(target) = state.clients.get(&ClientId(n(&cmd, "client") as u16)) {
									let vars = target.variables();
									let info = target.connection_info();
									vars.send(c)?;
									let _ = info.send(c);
								}
							}
						}
						"nickname" => {
							if let Some(c) = con.as_mut() {
								let name = s(&cmd, "value");
								c.get_state()?.client_update().set_name(&name).send_with_result(c)?;
							}
						}
						"description" => {
							if let Some(c) = con.as_mut() {
								let state = c.get_state()?;
								let text = s(&cmd, "value");
								if let Some(target) = state.clients.get(&ClientId(n(&cmd, "client") as u16)) {
									target.edit().set_description(&text).send_with_result(c)?;
								}
							}
						}
						"talkRequest" => {
							if let Some(c) = con.as_mut() {
								let msg = s(&cmd, "message");
								let value = if b(&cmd, "value") { Some(msg.as_str()) } else { None };
								c.get_state()?.client_update().set_talk_power_request(value).send_with_result(c)?;
							}
						}
						"channelCreate" => {
							if let Some(c) = con.as_mut() {
								let state = c.get_state()?;
								let name = s(&cmd, "name");
								let topic = s(&cmd, "topic");
								let password = s(&cmd, "password");
								let mut opts = tsclientlib::data::ChannelOptions::new(&name).channel_type(match s(&cmd, "kind").as_str() {
									"permanent" => ChannelType::Permanent,
									"semi" => ChannelType::SemiPermanent,
									_ => ChannelType::Temporary,
								});
								if n(&cmd, "parent") > 0 {
									opts = opts.parent_id(ChannelId(n(&cmd, "parent")));
								}
								if !topic.is_empty() {
									opts = opts.topic(&topic);
								}
								if !password.is_empty() {
									opts = opts.password(&password);
								}
								if n(&cmd, "maxClients") > 0 {
									opts = opts.max_clients(MaxClients::Limited(n(&cmd, "maxClients") as u16));
								}
								state.server.add_channel(opts).send_with_result(c)?;
							}
						}
						"channelEdit" => {
							if let Some(c) = con.as_mut() {
								let state = c.get_state()?;
								let ch = state.channels.get(&ChannelId(n(&cmd, "channel"))).ok_or_else(|| anyhow::anyhow!("unknown channel"))?;
								let name = s(&cmd, "name");
								let topic = s(&cmd, "topic");
								let mut e = ch.edit();
								if !name.is_empty() && name != ch.name {
									e = e.set_name(&name);
								}
								if cmd.get("topic").is_some() {
									e = e.set_topic(&topic);
								}
								e.send_with_result(c)?;
							}
						}
						"channelDelete" => {
							if let Some(c) = con.as_mut() {
								c2s::OutChannelDeleteMessage::new(&mut std::iter::once(c2s::OutChannelDeletePart { channel_id: ChannelId(n(&cmd, "channel")), force: b(&cmd, "force") }))
									.send_with_result(c)?;
							}
						}
						"ban" => {
							if let Some(c) = con.as_mut() {
								let reason = s(&cmd, "reason");
								let secs = n(&cmd, "seconds");
								c2s::OutBanClientMessage::new(&mut std::iter::once(c2s::OutBanClientPart {
									client_id: ClientId(n(&cmd, "client") as u16),
									time: if secs > 0 { Some(time::Duration::seconds(secs as i64)) } else { None },
									ban_reason: if reason.is_empty() { None } else { Some(reason.as_str().into()) },
								}))
								.send_with_result(c)?;
							}
						}
						"noise" => {
							shared.noise.store(b(&cmd, "value"), Ordering::Relaxed);
						}
						"poke" => {
							if let Some(c) = con.as_mut() {
								c.get_state()?.send_message(MessageTarget::Poke(ClientId(n(&cmd, "client") as u16)), &s(&cmd, "text")).send(c)?;
							}
						}
						"kick" => {
							if let Some(c) = con.as_mut() {
								let state = c.get_state()?;
								let target = state.clients.get(&ClientId(n(&cmd, "client") as u16)).ok_or_else(|| anyhow::anyhow!("unknown user"))?;
								let reason = if b(&cmd, "server") { tsclientlib::Reason::KickServer } else { tsclientlib::Reason::KickChannel };
								let msg = s(&cmd, "reason");
								target.kick(reason).set_reason_message(&msg).send(c)?;
							}
						}
						"mute" | "deaf" | "away" => {
							let value = b(&cmd, "value");
							if name == "mute" {
								shared.muted.store(value, Ordering::Relaxed);
							}
							if name == "deaf" {
								shared.deaf.store(value, Ordering::Relaxed);
							}
							if let Some(c) = con.as_mut() {
								let state = c.get_state()?;
								let update = state.client_update();
								let away = s(&cmd, "message");
								let update = match name.as_str() {
									"mute" => update.set_input_muted(value),
									"deaf" => update.set_output_muted(value),
									_ => update.set_away(if value { Some(away.as_str()) } else { None }),
								};
								update.send_with_result(c)?;
							}
						}
						"voice" => {
							shared.ptt_mode.store(s(&cmd, "mode") == "ptt", Ordering::Relaxed);
							shared.ptt_down.store(b(&cmd, "ptt"), Ordering::Relaxed);
							if let Some(t) = cmd.get("threshold").and_then(|x| x.as_f64()) {
								shared.threshold.store((t as f32).to_bits(), Ordering::Relaxed);
							}
						}
						"volume" => {
							let v = cmd.get("value").and_then(|x| x.as_f64()).unwrap_or(1.0) as f32;
							shared.volumes.lock().unwrap().insert(n(&cmd, "client") as u16, v);
						}
						"devices" => {
							let (inputs, outputs) = audio::device_names();
							emit(json!({"type": "devices", "inputs": inputs, "outputs": outputs}));
						}
						"setDevices" => {
							in_dev = s(&cmd, "input");
							out_dev = s(&cmd, "output");
							if audio.is_some() {
								audio = Some(audio::Audio::start(shared.clone(), pkt_tx.clone(), &in_dev, &out_dev));
							}
						}
						"quit" => {
							quit = true;
							if let Some(c) = con.take() {
								leaving = Some(c);
							}
						}
						_ => {}
					}
					Ok(())
				})();
				if let Err(e) = result {
					emit(json!({"type": "error", "command": name, "message": e.to_string()}));
				}
			}
		}
	}
	if let Some(mut c) = con.take() {
		let _ = c.disconnect(DisconnectOptions::new());
	}
}
