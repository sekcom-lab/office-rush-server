const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const QRCode = require('qrcode');
let cloudflared = null;
try {
  cloudflared = require('cloudflared');
} catch (e) {}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 4000;
const OFFICIAL_URL = 'https://pm.ntplc.site/travel/game';
const SERVER_INFO_FILE = path.join(__dirname, 'server_info.json');

app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

// Path to travel outing registration database
const TRAVEL_DATA_FILE = path.join(__dirname, '..', 'data', 'registrations.json');

function getTravelParticipants() {
  try {
    if (fs.existsSync(TRAVEL_DATA_FILE)) {
      const raw = fs.readFileSync(TRAVEL_DATA_FILE, 'utf-8');
      const list = JSON.parse(raw);
      return list.map(item => ({
        fullName: (item.fullName || '').trim(),
        department: (item.department || 'ทั่วไป').trim()
      })).filter(item => item.fullName.length > 0);
    }
  } catch (err) {
    console.warn('Could not read travel registrations.json:', err.message);
  }
  return [];
}

// API endpoint to get registered participants (without sensitive info)
app.get('/api/travel-participants', (req, res) => {
  const participants = getTravelParticipants();
  const departments = Array.from(new Set(participants.map(p => p.department))).filter(Boolean);
  res.json({
    total: participants.length,
    participants,
    departments
  });
});

// Helper to get local IP address
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

const localIp = getLocalIp();
let publicTunnelUrl = null;

function saveServerInfo() {
  try {
    const info = {
      officialUrl: OFFICIAL_URL,
      socketUrl: publicTunnelUrl,
      localSocketUrl: `http://${localIp}:${PORT}`,
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(SERVER_INFO_FILE, JSON.stringify(info, null, 2), 'utf-8');
  } catch (err) {
    console.warn('Could not write server_info.json:', err.message);
  }
}

// Start Cloudflare Tunnel automatically for instant 4G/5G/Wi-Fi mobile access
function initTunnel() {
  saveServerInfo();
  if (!cloudflared || !cloudflared.bin) {
    console.log('Running in direct public mode (Render / Cloud environment).');
    return;
  }
  try {
    const cf = spawn(cloudflared.bin, ['tunnel', '--url', `http://localhost:${PORT}`]);

    const onData = (chunk) => {
      const text = chunk.toString();
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match && !publicTunnelUrl) {
        publicTunnelUrl = match[0];
        saveServerInfo();
        console.log(`=========================================`);
        console.log(`🌟 Official Web Link: ${OFFICIAL_URL}`);
        console.log(`🌐 Cloudflare Socket: ${publicTunnelUrl}`);
        console.log(`👉 Local Network IP:  http://${localIp}:${PORT}`);
        console.log(`=========================================`);
        io.emit('tunnelReady', {
          officialUrl: OFFICIAL_URL,
          publicUrl: publicTunnelUrl,
          localUrl: `http://${localIp}:${PORT}`
        });
      }
    };

    cf.stdout.on('data', onData);
    cf.stderr.on('data', onData);
    cf.on('error', (err) => {
      console.log('Tunnel warning, using local network IP:', err.message);
    });
  } catch (err) {
    console.log('Cloudflare tunnel not available, using local network IP.');
  }
}

// API endpoint for QR code
app.get('/api/qr', async (req, res) => {
  try {
    // Default to the requested official URL: https://pm.ntplc.site/travel/game
    const type = req.query.type;
    let targetUrl = OFFICIAL_URL;
    if (type === 'tunnel' && publicTunnelUrl) targetUrl = publicTunnelUrl;
    if (type === 'local') targetUrl = `http://${localIp}:${PORT}`;

    const qrDataUrl = await QRCode.toDataURL(targetUrl, { width: 280, margin: 2 });
    res.json({
      url: targetUrl,
      officialUrl: OFFICIAL_URL,
      publicUrl: publicTunnelUrl,
      localUrl: `http://${localIp}:${PORT}`,
      qrDataUrl,
      ip: localIp,
      port: PORT
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// OFFICE RUSH - RACE ENGINE & ADMIN SYSTEM
// ==========================================
const TRACK_LENGTH = 4000;
const BASE_SPEED = 7.2;
const CEILING_HEIGHT = 475; // จำกัดเพดานกระโดด ป้องกันตัวละครหลุดจอ (ขยับขึ้นอีก 1.5 เท่า = 475px ลอยตัวได้สูงอิสระ)

const GAME_STATES = {
  LOBBY: 'LOBBY',
  COUNTDOWN: 'COUNTDOWN',
  RACING: 'RACING',
  FINISHED: 'FINISHED'
};

class OfficeRaceManager {
  constructor() {
    this.players = new Map();
    this.adminSocketIds = new Set();
    this.gameState = GAME_STATES.LOBBY;
    this.countdown = 3;
    this.raceTimer = 0;
    this.postFinishTimer = 0;
    this.obstacles = [];
    this.powerUps = [];
    this.finishedCount = 0;
    this.activeChaos = null; // { type, name, timer, maxTimer }

    this.generateTrack();
  }

  generateTrack() {
    this.obstacles = [];
    this.powerUps = [];

    let nextX = 380;

    while (nextX < TRACK_LENGTH - 200) {
      nextX += 300 + Math.random() * 200; // ระยะห่างกำลังดี
      if (nextX >= TRACK_LENGTH - 150) break;

      let type;
      let width = 32;
      let height = 36;

      if (nextX >= 3200) {
        // 🏖️ โซนหาดทรายทองหัวหิน
        const beachTypes = ['crab', 'coconut', 'sandcastle'];
        type = beachTypes[Math.floor(Math.random() * beachTypes.length)];
        if (type === 'crab') { width = 34; height = 26; }
        else if (type === 'coconut') { width = 28; height = 24; }
        else if (type === 'sandcastle') { width = 44; height = 36; }
      } else if (nextX >= 2100) {
        // 🌅 โซนถนนเลียบหาด
        const hwyTypes = ['cone', 'tire', 'cone'];
        type = hwyTypes[Math.floor(Math.random() * hwyTypes.length)];
        if (type === 'tire') { width = 32; height = 32; }
      } else {
        // 🏢 โซนออฟฟิศ
        const offTypes = ['box', 'coffee', 'copier'];
        type = offTypes[Math.floor(Math.random() * offTypes.length)];
        if (type === 'copier') { width = 44; height = 48; }
        else if (type === 'coffee') { width = 32; height = 14; }
      }

      this.obstacles.push({
        id: 'obs_' + Math.round(nextX),
        x: nextX,
        type: type,
        width: width,
        height: height
      });

      if (Math.random() < 0.58) {
        const rVal = Math.random();
        const itemType = rVal < 0.28 ? 'espresso' : (rVal < 0.55 ? 'energy' : (rVal < 0.78 ? 'donut' : 'clip'));
        this.powerUps.push({
          id: 'item_' + Math.round(nextX + 60),
          x: nextX + 60 + Math.random() * 30,
          y: Math.random() < 0.5 ? -18 : -75,
          type: itemType,
          collectedBy: new Set()
        });
      }
    }
  }

  addPlayer(socketId, profile, isSpectator = false) {
    if (isSpectator) {
      if (this.players.has(socketId)) {
        this.players.delete(socketId);
        this.broadcastLobbyUpdate();
      }
      return null;
    }

    const player = {
      id: socketId,
      name: profile.name || 'ผู้เล่น',
      org: profile.org || 'บุคคลทั่วไป',
      avatar: profile.avatar || {},
      distance: 0,
      laneOffset: (this.players.size % 4) * 12 - 18,
      speed: BASE_SPEED,
      isJumping: false,
      jumpCount: 0,
      jumpY: 0,
      jumpVy: 0,
      stumbleTimer: 0,
      boostTimer: 0,
      shieldTimer: 0,
      ceilingHitCooldown: 0,
      bonusScore: 0,
      totalScore: 0,
      finishRank: 0,
      finished: false,
      finishTime: 0
    };

    this.players.set(socketId, player);
    this.broadcastLobbyUpdate();
    return player;
  }

  removePlayer(socketId) {
    this.players.delete(socketId);
    this.adminSocketIds.delete(socketId);
    this.broadcastLobbyUpdate();

    if (this.players.size === 0) {
      this.resetToLobby();
    }
  }

  setAdmin(socketId, isAdmin = true) {
    if (isAdmin) {
      this.adminSocketIds.add(socketId);
    } else {
      this.adminSocketIds.delete(socketId);
    }
    this.broadcastLobbyUpdate();
  }

  isAdmin(socketId) {
    return this.adminSocketIds.has(socketId);
  }

  broadcastLobbyUpdate() {
    const playerList = Array.from(this.players.values()).map(p => ({
      id: p.id,
      name: p.name,
      org: p.org,
      avatar: p.avatar
    }));

    const orgCount = {};
    playerList.forEach(p => {
      const org = p.org || 'บุคคลทั่วไป';
      orgCount[org] = (orgCount[org] || 0) + 1;
    });

    io.emit('lobbyUpdate', {
      totalPlayers: playerList.length,
      players: playerList,
      orgCount: orgCount,
      gameState: this.gameState
    });
  }

  startCountdown(socketId) {
    if (!this.isAdmin(socketId)) return false;

    if (this.gameState === GAME_STATES.LOBBY || this.gameState === GAME_STATES.FINISHED) {
      this.gameState = GAME_STATES.COUNTDOWN;
      this.countdown = 3;
      this.generateTrack();
      this.finishedCount = 0;
      this.postFinishTimer = 0;

      for (const player of this.players.values()) {
        player.distance = 0;
        player.jumpY = 0;
        player.jumpVy = 0;
        player.isJumping = false;
        player.stumbleTimer = 0;
        player.boostTimer = 0;
        player.shieldTimer = 0;
        player.ceilingHitCooldown = 0;
        player.bonusScore = 0;
        player.finishRank = 0;
        player.finished = false;
        player.finishTime = 0;
      }

      return true;
    }
    return false;
  }

  handlePlayerJump(socketId) {
    const player = this.players.get(socketId);
    if (!player || player.finished || this.gameState !== GAME_STATES.RACING) return;

    if (player.jumpY <= 0.05 || !player.isJumping) {
      player.isJumping = true;
      player.jumpCount = 1;
      player.jumpVy = 13.5;
      io.emit('playerJumped', { id: player.id });
    } else if (player.jumpCount === 1) {
      player.jumpCount = 2;
      player.jumpVy = 12.0;
      io.emit('playerDoubleJumped', { id: player.id });
    }
  }

  triggerChaos(type) {
    if (this.gameState !== GAME_STATES.RACING) return;
    if (type === 'sandstorm') {
      this.activeChaos = { type: 'sandstorm', name: '🌪️ พายุทรายหัวหินพัดกระหน่ำ! วิ่งต้านลม!', timer: 210, maxTimer: 210 };
      io.emit('chaosEvent', this.activeChaos);
    } else if (type === 'fever') {
      this.activeChaos = { type: 'fever', name: '⚡ FEVER TIME! ชาไทยแจกทั้งสนาม สปีดติดจรวด!', timer: 240, maxTimer: 240 };
      for (const p of this.players.values()) {
        if (!p.finished) {
          p.boostTimer = Math.max(p.boostTimer, 240);
        }
      }
      io.emit('chaosEvent', this.activeChaos);
    } else if (type === 'crab_rain') {
      let leadX = 0;
      for (const p of this.players.values()) {
        if (p.distance > leadX) leadX = p.distance;
      }
      const extraObs = [];
      for (let i = 0; i < 5; i++) {
        const obsX = leadX + 160 + i * 90 + Math.random() * 40;
        if (obsX < TRACK_LENGTH - 100) {
          const o = {
            id: 'chaos_crab_' + Math.round(obsX),
            x: obsX,
            type: Math.random() < 0.65 ? 'crab' : 'cone',
            width: 34,
            height: 26
          };
          this.obstacles.push(o);
          extraObs.push(o);
        }
      }
      this.activeChaos = { type: 'crab_rain', name: '🦀 ฝูงปูทะเลหัวหินบุกขวางทางวิ่ง!', timer: 180, maxTimer: 180 };
      io.emit('chaosEvent', this.activeChaos);
      if (extraObs.length > 0) {
        io.emit('chaosObstacles', extraObs);
      }
    }
  }

  update() {
    if (this.gameState === GAME_STATES.COUNTDOWN) return;

    if (this.gameState === GAME_STATES.RACING) {
      this.raceTimer += 1 / 60;
      let allFinished = true;

      if (this.activeChaos) {
        this.activeChaos.timer--;
        if (this.activeChaos.timer <= 0) {
          this.activeChaos = null;
          io.emit('chaosEnded');
        }
      }

      for (const player of this.players.values()) {
        if (!player.finished) {
          allFinished = false;

          // 1. Jump Physics
          if (player.jumpY > 0 || player.jumpVy !== 0) {
            player.jumpY += player.jumpVy;
            player.jumpVy -= 0.65;

            // ชนเพดาน: จำกัดความสูงไม่ให้หลุดจอ และหัก 5 คะแนน
            if (player.jumpY >= CEILING_HEIGHT) {
              player.jumpY = CEILING_HEIGHT;
              player.jumpVy = -4.2; // เด้งลงมา

              if (!player.ceilingHitCooldown || player.ceilingHitCooldown <= 0) {
                player.ceilingHitCooldown = 50; // คูลดาวน์กันตัดคะแนนซ้ำซ้อนในจังหวะเดียว
                player.bonusScore = (player.bonusScore || 0) - 5;
                io.emit('ceilingHit', {
                  playerId: player.id,
                  name: player.name,
                  org: player.org,
                  penalty: 5,
                  bonusScore: player.bonusScore
                });
              }
            }

            if (player.jumpY <= 0) {
              player.jumpY = 0;
              player.jumpVy = 0;
              player.isJumping = false;
              player.jumpCount = 0;
            }
          }

          if (player.ceilingHitCooldown > 0) {
            player.ceilingHitCooldown--;
          }

          // 2. Speed calculation
          let currentSpeed = player.speed;
          if (this.activeChaos && this.activeChaos.type === 'sandstorm' && player.shieldTimer <= 0) {
            currentSpeed *= 0.6; // ลมพายุทรายหัวหินต้าน
          }
          if (player.boostTimer > 0) {
            player.boostTimer--;
            currentSpeed *= 1.85; // บูสต์ติดสปีดพุ่งเร็วสะใจ
          } else if (player.stumbleTimer > 0) {
            player.stumbleTimer--;
            currentSpeed *= 0.45;
          }

          player.distance += currentSpeed;

          // 3. Obstacle Collision
          if (player.shieldTimer > 0) {
            player.shieldTimer--;
          } else if (player.stumbleTimer <= 0) {
            for (const obs of this.obstacles) {
              const dx = player.distance - obs.x;
              if (dx >= -10 && dx <= obs.width) {
                if (player.jumpY < obs.height - 4) {
                  player.stumbleTimer = 50;
                  io.emit('obstacleHit', {
                    playerId: player.id,
                    name: player.name,
                    org: player.org,
                    obsType: obs.type,
                    x: obs.x
                  });
                  break;
                }
              }
            }
          }

          // 4. Power-up Check
          for (const item of this.powerUps) {
            if (!item.collectedBy.has(player.id)) {
              const dx = Math.abs(player.distance - item.x);
              const dy = Math.abs((-player.jumpY) - item.y);
              if (dx < 28 && dy < 32) {
                item.collectedBy.add(player.id);
                this.applyPowerUp(player, item.type);
              }
            }
          }

          // 5. Finish Line Check
          if (player.distance >= TRACK_LENGTH) {
            player.distance = TRACK_LENGTH;
            player.finished = true;
            this.finishedCount++;
            player.finishRank = this.finishedCount;
            player.finishTime = Math.round(this.raceTimer * 10) / 10;

            const placementPoints = [150, 120, 100, 80, 70, 60, 50, 40];
            const pts = placementPoints[player.finishRank - 1] || 35;
            player.totalScore = pts + player.bonusScore;

            io.emit('playerFinished', {
              id: player.id,
              name: player.name,
              org: player.org,
              rank: player.finishRank,
              finishTime: player.finishTime,
              points: player.totalScore
            });

            if (this.finishedCount === 1) {
              this.postFinishTimer = 15;
              io.emit('firstPlaceFinished', {
                name: player.name,
                org: player.org
              });
            }
          }
        }
      }

      if (this.finishedCount > 0 && !allFinished) {
        this.postFinishTimer -= 1 / 60;
        if (this.postFinishTimer <= 0) {
          for (const player of this.players.values()) {
            if (!player.finished) {
              player.finished = true;
              this.finishedCount++;
              player.finishRank = this.finishedCount;
              player.totalScore = 25 + player.bonusScore;
            }
          }
          allFinished = true;
        }
      }

      if (allFinished && this.players.size > 0) {
        this.endRace();
      }
    }
  }

  applyPowerUp(player, type) {
    if (type === 'espresso') {
      player.boostTimer = 110;
      io.emit('itemCollected', { playerId: player.id, type: 'espresso' });
    } else if (type === 'energy') {
      player.boostTimer = 150;
      player.bonusScore += 25;
      io.emit('itemCollected', { playerId: player.id, type: 'energy', bonus: 25 });
    } else if (type === 'donut') {
      player.shieldTimer = 180;
      io.emit('itemCollected', { playerId: player.id, type: 'donut' });
    } else if (type === 'clip') {
      player.bonusScore += 25;
      io.emit('itemCollected', { playerId: player.id, type: 'clip', bonus: 25 });
    }
  }

  endRace() {
    this.gameState = GAME_STATES.FINISHED;
    const leaderboard = this.getLeaderboardData();
    const orgLeaderboard = this.getOrgLeaderboardData();

    io.emit('raceFinished', {
      leaderboard,
      orgLeaderboard
    });
  }

  resetToLobby() {
    this.gameState = GAME_STATES.LOBBY;
    this.countdown = 3;
    this.finishedCount = 0;
    this.activeChaos = null;
    for (const player of this.players.values()) {
      player.distance = 0;
      player.finished = false;
      player.finishRank = 0;
      player.bonusScore = 0;
      player.totalScore = 0;
      player.jumpCount = 0;
    }
    this.broadcastLobbyUpdate();
    io.emit('returnedToLobby');
  }

  getLeaderboardData() {
    return Array.from(this.players.values())
      .map(p => ({
        id: p.id,
        name: p.name,
        org: p.org,
        avatar: p.avatar,
        rank: p.finishRank,
        finishTime: p.finishTime,
        totalScore: p.totalScore,
        bonusScore: p.bonusScore
      }))
      .sort((a, b) => {
        if (a.rank && b.rank) return a.rank - b.rank;
        return b.totalScore - a.totalScore;
      });
  }

  getOrgLeaderboardData() {
    const orgMap = new Map();
    for (const p of this.players.values()) {
      const orgName = p.org || 'บุคคลทั่วไป';
      if (!orgMap.has(orgName)) {
        orgMap.set(orgName, { org: orgName, totalScore: 0, members: 0 });
      }
      const entry = orgMap.get(orgName);
      entry.totalScore += p.totalScore;
      entry.members += 1;
    }
    return Array.from(orgMap.values()).sort((a, b) => b.totalScore - a.totalScore);
  }

  getSnapshot() {
    return {
      gameState: this.gameState,
      countdown: this.countdown,
      raceTimer: Math.round(this.raceTimer * 10) / 10,
      postFinishTimer: Math.max(0, Math.ceil(this.postFinishTimer)),
      trackLength: TRACK_LENGTH,
      ceilingHeight: CEILING_HEIGHT,
      activeChaos: this.activeChaos,
      obstacles: this.obstacles,
      powerUps: this.powerUps.map(p => ({
        id: p.id,
        x: p.x,
        y: p.y,
        type: p.type
      })),
      players: Array.from(this.players.values()).map(p => ({
        id: p.id,
        name: p.name,
        org: p.org,
        avatar: p.avatar,
        distance: Math.round(p.distance),
        laneOffset: p.laneOffset,
        jumpY: Math.round(p.jumpY),
        stumbled: p.stumbleTimer > 0,
        boosted: p.boostTimer > 0,
        shielded: p.shieldTimer > 0,
        bonusScore: p.bonusScore,
        finished: p.finished,
        finishRank: p.finishRank
      }))
    };
  }
}

const raceGame = new OfficeRaceManager();

setInterval(() => {
  raceGame.update();
  io.emit('gameState', raceGame.getSnapshot());
}, 1000 / 60);

let countdownInterval = null;
function triggerCountdown() {
  raceGame.countdown = 3;
  io.emit('countdownTick', { countdown: 3 });

  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = setInterval(() => {
    raceGame.countdown--;
    if (raceGame.countdown > 0) {
      io.emit('countdownTick', { countdown: raceGame.countdown });
    } else {
      clearInterval(countdownInterval);
      raceGame.gameState = GAME_STATES.RACING;
      raceGame.raceTimer = 0;
      io.emit('raceStarted');
    }
  }, 1000);
}

io.on('connection', (socket) => {
  if (publicTunnelUrl) {
    socket.emit('tunnelReady', {
      officialUrl: OFFICIAL_URL,
      publicUrl: publicTunnelUrl,
      localUrl: `http://${localIp}:${PORT}`
    });
  }

  socket.on('claimAdmin', (data) => {
    let u = '';
    let p = '';
    if (typeof data === 'object' && data !== null) {
      u = (data.user || data.username || '').toString().trim().toLowerCase();
      p = (data.pass || data.password || '').toString().trim();
    } else if (typeof data === 'string') {
      const parts = data.split(':');
      if (parts.length === 2) {
        u = parts[0].trim().toLowerCase();
        p = parts[1].trim();
      } else {
        const val = data.trim();
        if (val === 'adminnt' || val === 'admin') {
          u = 'admin';
          p = 'adminnt';
        }
      }
    }

    if (u === 'admin' && p === 'adminnt') {
      raceGame.setAdmin(socket.id, true);
      socket.emit('adminStatus', { isAdmin: true, success: true });
      socket.emit('announcement', { text: '👑 ยืนยันสิทธิ์แอดมิน (admin) สำเร็จเรียบร้อยแล้ว!' });
    } else {
      raceGame.setAdmin(socket.id, false);
      socket.emit('adminStatus', { isAdmin: false, success: false, message: 'ชื่อผู้ใช้ (User) หรือรหัสผ่าน (Pass) ไม่ถูกต้อง' });
      socket.emit('announcement', { text: '❌ เข้าสู่ระบบแอดมินไม่สำเร็จ: user หรือ pass ไม่ถูกต้อง' });
    }
  });

  socket.on('logoutAdmin', () => {
    raceGame.setAdmin(socket.id, false);
    socket.emit('adminStatus', { isAdmin: false });
    socket.emit('announcement', { text: '🚪 ออกจากระบบแอดมินเรียบร้อยแล้ว' });
  });

  socket.on('joinGame', (profile) => {
    const isSpectator = profile.isSpectator || false;
    const player = raceGame.addPlayer(socket.id, profile, isSpectator);

    socket.emit('joined', {
      selfId: socket.id,
      player,
      trackLength: TRACK_LENGTH,
      ceilingHeight: CEILING_HEIGHT,
      activeChaos: this.activeChaos,
      isAdmin: raceGame.isAdmin(socket.id)
    });

    raceGame.broadcastLobbyUpdate();
  });

  socket.on('jump', () => {
    raceGame.handlePlayerJump(socket.id);
  });

  socket.on('sendEmoji', (data) => {
    const player = raceGame.players.get(socket.id);
    if (!player || !data || !data.emoji) return;
    io.emit('playerEmoji', { id: player.id, name: player.name, emoji: data.emoji });
  });

  socket.on('sendCheer', (data) => {
    const player = raceGame.players.get(socket.id);
    io.emit('playerCheer', {
      id: socket.id,
      name: player ? player.name : 'กองเชียร์',
      type: (data && data.type) ? data.type : 'clap'
    });
  });

  socket.on('adminChaos', (data) => {
    if (!raceGame.isAdmin(socket.id)) {
      socket.emit('announcement', { text: '⚠️ เฉพาะแอดมินเท่านั้นที่มีสิทธิ์กดใช้งานระบบอีเวนต์พิเศษ!' });
      return;
    }
    if (data && data.type) {
      raceGame.triggerChaos(data.type);
    }
  });

  socket.on('startRace', () => {
    const isAdm = raceGame.isAdmin(socket.id);
    console.log(`[START RACE REQUEST] socket: ${socket.id}, isAdmin: ${isAdm}, players: ${raceGame.players.size}`);
    if (!isAdm) {
      socket.emit('announcement', { text: '⚠️ เฉพาะเครื่องแอดมินเท่านั้นที่มีสิทธิ์กดเริ่มการแข่งขัน!' });
      return;
    }

    if (raceGame.players.size === 0) {
      socket.emit('announcement', { text: '⚠️ ยังไม่มีผู้เล่นเข้าร่วม กรุณารอผู้เล่นเข้าห้องก่อน!' });
      return;
    }

    const started = raceGame.startCountdown(socket.id);
    if (started) {
      console.log(`[START RACE SUCCESS] Race countdown started by admin ${socket.id}!`);
      triggerCountdown();
    }
  });

  socket.on('resetLobby', () => {
    if (raceGame.isAdmin(socket.id)) {
      raceGame.resetToLobby();
    }
  });

  socket.on('disconnect', () => {
    raceGame.removePlayer(socket.id);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`=========================================`);
  console.log(`🏃 Office Rush Race Server Running!`);
  console.log(`🌟 Official Web Link: ${OFFICIAL_URL}`);
  console.log(`👉 Local:   http://localhost:${PORT}`);
  console.log(`👉 Network: http://${localIp}:${PORT}`);
  console.log(`📂 Travel Database: ${TRAVEL_DATA_FILE}`);
  console.log(`=========================================`);
  initTunnel();
});
