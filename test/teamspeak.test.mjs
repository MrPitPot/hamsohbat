// Tests the TeamSpeak bridge (desktop/teamspeak) against a local TeamSpeak 3 server.
// Start a TeamSpeak 3 server on this machine first, then:
//   node test/teamspeak.test.mjs <serveradmin query password>
// The bridge runs with synthetic audio, so no microphone or speakers are used.
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';

const BRIDGE = path.resolve('desktop/teamspeak/target/release/hs-teamspeak.exe');
const QUERY_PASSWORD = process.argv[2];
let passed = 0;
const failures = [];
const ok = (cond, name) => {
  if (cond) passed++;
  else failures.push(name);
  console.log((cond ? '  ok   ' : '  FAIL ') + name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs a few ServerQuery commands (the TeamSpeak admin interface on port 10011). */
function query(cmds) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(10011, '127.0.0.1');
    let buf = '';
    const out = [];
    const queue = [...cmds, 'quit'];
    sock.on('data', (d) => {
      buf += d.toString();
      while (buf.includes('\n')) {
        const line = buf.slice(0, buf.indexOf('\n')).trim();
        buf = buf.slice(buf.indexOf('\n') + 1);
        if (line.startsWith('error ')) out.push(line);
        else if (line && !line.startsWith('TS3') && !line.startsWith('Welcome')) out.push(line);
        if (line.startsWith('error ') || line.startsWith('Welcome')) {
          const next = queue.shift();
          if (next) sock.write(next + '\n');
        }
      }
    });
    sock.on('close', () => resolve(out));
    sock.on('error', reject);
  });
}

class Bridge {
  constructor(name) {
    this.name = name;
    this.events = [];
    this.state = null;
    this.proc = spawn(BRIDGE, [], { env: { ...process.env, HS_TS_TEST_AUDIO: '1' }, stdio: ['pipe', 'pipe', 'ignore'] });
    readline.createInterface({ input: this.proc.stdout }).on('line', (l) => {
      try {
        const e = JSON.parse(l);
        if (e.type === 'state') this.state = e;
        this.events.push(e);
      } catch {}
    });
  }
  send(o) {
    this.proc.stdin.write(JSON.stringify(o) + '\n');
  }
  async wait(pred, ms = 15000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const e = this.events.find(pred);
      if (e) return e;
      await sleep(50);
    }
    return null;
  }
  async until(fn, ms = 15000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (fn()) return true;
      await sleep(50);
    }
    return false;
  }
  me() {
    return this.state?.clients.find((c) => c.isMe);
  }
  client(name) {
    return this.state?.clients.find((c) => c.name === name);
  }
}

if (!QUERY_PASSWORD) {
  console.log('usage: node test/teamspeak.test.mjs <serveradmin query password>');
  process.exit(1);
}
const tag = Date.now().toString(36).slice(-4);
const room = 'Room ' + tag;
const ALICE = 'Alice' + tag;
const BOB = 'Bob' + tag;
const created = await query([`login serveradmin ${QUERY_PASSWORD}`, 'use sid=1', `channelcreate channel_name=${room.replace(/ /g, '\\s')} channel_flag_permanent=1`]);
ok(created.some((l) => l.startsWith('cid=')), 'test channel created through ServerQuery');

const A = new Bridge('Alice');
const B = new Bridge('Bob');
try {
  console.log('• connect');
  ok(!!(await A.wait((e) => e.type === 'ready')), 'bridge starts');
  A.send({ cmd: 'connect', address: '127.0.0.1', nickname: ALICE });
  const id = await A.wait((e) => e.type === 'identity');
  ok(!!id && /^\d+V/.test(id.value), 'a new TeamSpeak identity is created and reported for saving');
  ok(!!(await A.wait((e) => e.type === 'status' && e.state === 'connected', 30000)), 'Alice connects');
  B.send({ cmd: 'connect', address: '127.0.0.1', nickname: BOB });
  ok(!!(await B.wait((e) => e.type === 'status' && e.state === 'connected', 30000)), 'Bob connects');
  ok(await A.until(() => !!A.client(BOB)), 'Alice sees Bob in the channel tree');
  ok(A.state.channels.some((c) => c.name === room) && !!A.state.server.name, 'channels and server info are listed');

  console.log('• server log, ping and user info');
  ok(!!(await A.wait((e) => e.type === 'log' && e.kind === 'connected')), 'log: "connected to server" entry');
  ok(!!(await A.wait((e) => e.type === 'log' && e.kind === 'join' && e.name === BOB)), 'log: Alice sees Bob connect');
  const stats = await A.wait((e) => e.type === 'stats' && e.ping > 0);
  ok(!!stats && typeof stats.loss === 'number' && stats.bytesIn >= 0, 'ping, packet loss and bandwidth are reported: ' + (stats && Math.round(stats.ping) + ' ms'));
  A.send({ cmd: 'info', client: A.client(BOB).id });
  ok(await A.until(() => !!A.client(BOB)?.version && A.client(BOB)?.ping != null), "user info: Bob's version and ping");
  ok(!!A.client(BOB)?.uid && A.state.serverGroups.length > 0, 'unique ids and server groups are listed');
  ok(A.client(BOB)?.connectedFor != null, 'user info: connection time');
  // Make Alice a server admin so she can manage channels.
  const dbid = A.me().dbId;
  await query([`login serveradmin ${QUERY_PASSWORD}`, 'use sid=1', `servergroupaddclient sgid=6 cldbid=${dbid}`]);
  ok(await A.until(() => A.me()?.serverGroups.includes(6)), 'Alice is shown in the Server Admin group');
  ok(!!(await B.wait((e) => e.type === 'log' && e.kind === 'groupAdd' && e.name === ALICE)), 'log: group change is shown to others');

  console.log('• text chat');
  A.send({ cmd: 'message', target: 'channel', text: 'hello from Alice' });
  const msg = await B.wait((e) => e.type === 'message' && e.text === 'hello from Alice');
  ok(msg?.target === 'channel' && msg.from.name === ALICE, 'channel message arrives');
  await sleep(1000);
  ok(A.events.filter((e) => e.type === 'message' && e.text === 'hello from Alice').length === 1, 'the sender sees her own message exactly once');
  A.send({ cmd: 'message', target: 'server', text: 'server-wide hi' });
  ok(!!(await B.wait((e) => e.type === 'message' && e.target === 'server' && e.text === 'server-wide hi')), 'server chat message arrives');
  B.send({ cmd: 'message', target: 'client', client: B.client(ALICE).id, text: 'psst' });
  ok(!!(await A.wait((e) => e.type === 'message' && e.target === 'client' && e.text === 'psst')), 'private message arrives');
  B.send({ cmd: 'poke', client: B.client(ALICE).id, text: 'wake up' });
  ok(!!(await A.wait((e) => e.type === 'poke' && e.text === 'wake up')), 'poke arrives');

  console.log('• voice');
  A.send({ cmd: 'voice', mode: 'vad', threshold: -100 });
  ok(await B.until(() => B.events.some((e) => e.type === 'talking' && e.ids.includes(B.client(ALICE).id))), "Bob hears Alice's voice");
  ok(!!(await A.wait((e) => e.type === 'level' && e.tx)), 'Alice sees her own transmit level');
  A.send({ cmd: 'mute', value: true });
  ok(await B.until(() => B.client(ALICE)?.inputMuted === true), 'Bob sees Alice muted');
  ok(await B.until(() => B.events.filter((e) => e.type === 'talking').pop()?.ids.length === 0), 'muted Alice stops talking');
  A.send({ cmd: 'mute', value: false });
  A.send({ cmd: 'voice', mode: 'ptt', ptt: false, threshold: -100 });
  await sleep(800);
  B.events = B.events.filter((e) => e.type !== 'talking');
  await sleep(800);
  ok(!B.events.some((e) => e.type === 'talking' && e.ids.length), 'push-to-talk: silent while the key is up');
  A.send({ cmd: 'voice', mode: 'ptt', ptt: true, threshold: -100 });
  ok(await B.until(() => B.events.some((e) => e.type === 'talking' && e.ids.includes(B.client(ALICE).id))), 'push-to-talk: heard while the key is down');
  A.send({ cmd: 'deaf', value: true });
  ok(await B.until(() => B.client(ALICE)?.outputMuted === true), 'Bob sees Alice deafened');

  console.log('• nickname and channel management');
  A.send({ cmd: 'nickname', value: ALICE + 'x' });
  ok(!!(await B.wait((e) => e.type === 'log' && e.kind === 'rename' && e.name === ALICE + 'x')), 'nickname change is logged for others');
  A.send({ cmd: 'nickname', value: ALICE });
  await B.until(() => !!B.client(ALICE));
  const temp = 'Temp ' + tag;
  A.send({ cmd: 'channelCreate', name: temp, topic: 'test topic', kind: 'semi' });
  ok(await B.until(() => B.state.channels.some((c) => c.name === temp && c.topic === 'test topic')), 'Alice creates a channel and Bob sees it');
  ok(!!(await B.wait((e) => e.type === 'log' && e.kind === 'channelCreate')), 'log: channel creation');
  const tid = B.state.channels.find((c) => c.name === temp).id;
  A.send({ cmd: 'channelEdit', channel: tid, name: temp + ' 2' });
  ok(await B.until(() => B.state.channels.some((c) => c.id === tid && c.name === temp + ' 2')), 'channel can be renamed');
  A.send({ cmd: 'channelDelete', channel: tid, force: true });
  ok(await B.until(() => !B.state.channels.some((c) => c.id === tid)), 'channel can be deleted');
  B.send({ cmd: 'channelCreate', name: 'nope ' + tag, kind: 'permanent' });
  const denied = await B.wait((e) => e.type === 'error' && /perm/i.test(e.message));
  ok(!!denied && !B.state.channels.some((c) => c.name === 'nope ' + tag), 'missing permissions come back as a clear error: ' + denied?.message);
  A.send({ cmd: 'noise', value: true });
  A.send({ cmd: 'noise', value: false });

  console.log('• channels');
  const target = A.state.channels.find((c) => c.name === room);
  A.send({ cmd: 'join', channel: target.id });
  ok(await B.until(() => B.client(ALICE)?.channel === target.id), 'Alice moves to another channel');
  ok(!!(await B.wait((e) => e.type === 'log' && e.kind === 'move' && e.name === ALICE && e.to === room)), 'log: channel switch is shown');
  A.send({ cmd: 'away', value: true, message: 'brb' });
  ok(await B.until(() => B.client(ALICE)?.away === 'brb'), 'away status is shown');

  console.log('• leave');
  A.send({ cmd: 'disconnect' });
  ok(!!(await A.wait((e) => e.type === 'status' && e.state === 'disconnected')), 'Alice disconnects');
  ok(await B.until(() => !B.client(ALICE)), 'Bob sees Alice leave');
  ok(!!(await B.wait((e) => e.type === 'log' && e.kind === 'leave' && e.name === ALICE)), 'log: disconnect is shown');
  const bad = new Bridge('Nobody');
  bad.send({ cmd: 'connect', address: '127.0.0.1:1', nickname: 'Nobody' });
  ok(!!(await bad.wait((e) => e.type === 'status' && e.state === 'disconnected', 40000)), 'a wrong address ends in a clear "disconnected" status');
  bad.send({ cmd: 'quit' });
} catch (e) {
  failures.push('exception: ' + e.message);
  console.log(e);
} finally {
  A.send({ cmd: 'quit' });
  B.send({ cmd: 'quit' });
  await sleep(500);
  A.proc.kill();
  await query([`login serveradmin ${QUERY_PASSWORD}`, 'use sid=1', 'clientdblist']).then(async (lines) => {
    const db = lines.join('|').split('|').find((x) => x.includes('client_nickname=' + ALICE))?.match(/cldbid=(\d+)/)?.[1];
    if (db) await query([`login serveradmin ${QUERY_PASSWORD}`, 'use sid=1', `servergroupdelclient sgid=6 cldbid=${db}`]);
  });
  B.proc.kill();
  await query([`login serveradmin ${QUERY_PASSWORD}`, 'use sid=1', 'channellist']).then(async (lines) => {
    const cid = lines.join('|').split('|').find((x) => x.includes(`channel_name=${room.replace(/ /g, '\\s')}`))?.match(/cid=(\d+)/)?.[1];
    if (cid) await query([`login serveradmin ${QUERY_PASSWORD}`, 'use sid=1', `channeldelete cid=${cid} force=1`]);
  });
}
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) console.log('Failed:\n - ' + failures.join('\n - '));
process.exit(failures.length ? 1 : 0);
