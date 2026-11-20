import dgram from 'node:dgram';
import os from 'node:os';

// Small, versioned LAN announcements. No pairing credential or user data is broadcast.
export async function discoverLan(identity) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const devices = new Map();
  let current = identity;
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(5193, '0.0.0.0', resolve); });
  socket.setBroadcast(true);
  socket.on('error', () => {});
  const announce = (address = '255.255.255.255', port = 5193, query = true) => {
    socket.send(Buffer.from(JSON.stringify({ service: 'tipsy-isle-lan', protocol: 1, ...current, port: 5192, query })), port, address);
  };
  socket.on('message', (bytes, remote) => {
    let value; try { value = JSON.parse(bytes.toString()); } catch { return; }
    if (value.service !== 'tipsy-isle-lan' || value.protocol !== 1 || value.deviceId === current.deviceId) return;
    devices.set(value.deviceId, { deviceId: value.deviceId, name: value.name, address: `http://${remote.address}:${value.port}`, seen: Date.now() });
    if (value.query) announce(remote.address, remote.port, false);
  });
  function scan() {
    announce();
    for (const item of Object.values(os.networkInterfaces()).flat()) {
      if (!item || item.family !== 'IPv4' || item.internal) continue;
      const ip = item.address.split('.').map(Number), mask = item.netmask.split('.').map(Number);
      announce(ip.map((part, index) => part | (255 ^ mask[index])).join('.'));
    }
  }
  const timer = setInterval(scan, 4000); scan();
  return { update(value) { current = value; scan(); }, scan,
    list() { return [...devices.values()].filter(item => Date.now() - item.seen < 16000); },
    close() { clearInterval(timer); socket.close(); } };
}
