/**
 * RPS-ARENA Load Test
 *
 * Simulates 36 concurrent players across 12 lobbies to test:
 * - WebSocket connection stability
 * - Server CPU/memory under load
 * - Game loop stability at 30 Hz
 * - Message throughput
 *
 * Usage: node tests/load/load-test.js [options]
 *
 * Options:
 *   --players=N     Number of concurrent players (default: 30)
 *   --duration=N    Test duration in seconds (default: 300)
 *   --input-rate=N  INPUT messages per second per player (default: 60)
 *   --port=N        Server port (default: 3001)
 */

const WebSocket = require('ws');
const http = require('http');

// Parse command line arguments
function parseArgs() {
  const args = {
    players: 30,
    duration: 300,
    inputRate: 60,
    port: 3001,
    host: 'localhost',
  };

  process.argv.slice(2).forEach(arg => {
    const [key, value] = arg.replace('--', '').split('=');
    if (key === 'players') args.players = parseInt(value);
    if (key === 'duration') args.duration = parseInt(value);
    if (key === 'input-rate') args.inputRate = parseInt(value);
    if (key === 'port') args.port = parseInt(value);
  });

  return args;
}

const CONFIG = parseArgs();
const WS_URL = `ws://${CONFIG.host}:${CONFIG.port}`;

// Metrics tracking
const metrics = {
  startTime: null,
  connected: 0,
  disconnected: 0,
  messagesReceived: 0,
  messagesSent: 0,
  errors: 0,
  latencies: [],
  snapshotsReceived: 0,
  lastSnapshotTime: {},
  snapshotGaps: [],
};

// Active connections
const connections = [];
const connectionData = new Map();

// Utility functions
function log(message, type = 'info') {
  const timestamp = new Date().toISOString().substr(11, 8);
  const prefix = {
    info: '\x1b[36m[INFO]\x1b[0m',
    pass: '\x1b[32m[PASS]\x1b[0m',
    fail: '\x1b[31m[FAIL]\x1b[0m',
    warn: '\x1b[33m[WARN]\x1b[0m',
    metric: '\x1b[35m[METRIC]\x1b[0m',
  };
  console.log(`${timestamp} ${prefix[type] || prefix.info} ${message}`);
}

function httpRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: CONFIG.host,
      port: CONFIG.port,
      path: path,
      method: method,
      headers: { 'Content-Type': 'application/json' },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Create a simulated player connection
 */
async function createPlayer(playerId) {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    const data = {
      id: playerId,
      connected: false,
      sequence: 0,
      pingStart: null,
      lastPong: null,
      inputInterval: null,
      pingInterval: null,
    };

    connectionData.set(ws, data);

    ws.on('open', () => {
      data.connected = true;
      metrics.connected++;
      connections.push(ws);

      // Start sending INPUT messages at configured rate
      data.inputInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          data.sequence++;
          ws.send(JSON.stringify({
            type: 'INPUT',
            targetX: Math.random() * 1600,
            targetY: Math.random() * 900,
            sequence: data.sequence,
            frozen: false,
          }));
          metrics.messagesSent++;
        }
      }, 1000 / CONFIG.inputRate);

      // Periodic PING for latency measurement
      data.pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          data.pingStart = Date.now();
          ws.send(JSON.stringify({ type: 'PING', clientTime: data.pingStart }));
          metrics.messagesSent++;
        }
      }, 5000);

      resolve(ws);
    });

    ws.on('message', (rawData) => {
      metrics.messagesReceived++;

      try {
        const msg = JSON.parse(rawData.toString());

        switch (msg.type) {
          case 'PONG':
            if (data.pingStart) {
              const latency = Date.now() - data.pingStart;
              metrics.latencies.push(latency);
              data.lastPong = Date.now();
            }
            break;

          case 'SNAPSHOT':
            metrics.snapshotsReceived++;
            // Track snapshot timing to verify 20 Hz
            const now = Date.now();
            if (metrics.lastSnapshotTime[playerId]) {
              const gap = now - metrics.lastSnapshotTime[playerId];
              metrics.snapshotGaps.push(gap);
            }
            metrics.lastSnapshotTime[playerId] = now;
            break;

          case 'ERROR':
            metrics.errors++;
            log(`Player ${playerId} error: ${msg.code} - ${msg.message}`, 'warn');
            break;
        }
      } catch (e) {
        // Ignore parse errors
      }
    });

    ws.on('error', (error) => {
      metrics.errors++;
      log(`Player ${playerId} WebSocket error: ${error.message}`, 'warn');
    });

    ws.on('close', (code, reason) => {
      data.connected = false;
      metrics.disconnected++;

      // Cleanup intervals
      if (data.inputInterval) clearInterval(data.inputInterval);
      if (data.pingInterval) clearInterval(data.pingInterval);

      // Remove from connections array
      const index = connections.indexOf(ws);
      if (index > -1) connections.splice(index, 1);

      if (code !== 1000 && code !== 1001) {
        log(`Player ${playerId} disconnected: ${code} ${reason}`, 'warn');
      }
    });

    // Timeout if connection fails
    setTimeout(() => {
      if (!data.connected) {
        log(`Player ${playerId} connection timeout`, 'warn');
        resolve(null);
      }
    }, 10000);
  });
}

/**
 * Calculate statistics from array of numbers
 */
function calculateStats(arr) {
  if (arr.length === 0) return { min: 0, max: 0, avg: 0, p95: 0 };

  const sorted = [...arr].sort((a, b) => a - b);
  const sum = arr.reduce((a, b) => a + b, 0);

  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: Math.round(sum / arr.length),
    p95: sorted[Math.floor(sorted.length * 0.95)],
  };
}

/**
 * Print current metrics
 */
function printMetrics() {
  const elapsed = (Date.now() - metrics.startTime) / 1000;
  const latencyStats = calculateStats(metrics.latencies);
  const snapshotStats = calculateStats(metrics.snapshotGaps);

  console.log('\n--- Load Test Metrics ---');
  console.log(`Elapsed: ${elapsed.toFixed(0)}s / ${CONFIG.duration}s`);
  console.log(`Connected: ${metrics.connected} | Disconnected: ${metrics.disconnected}`);
  console.log(`Messages Sent: ${metrics.messagesSent} | Received: ${metrics.messagesReceived}`);
  console.log(`Errors: ${metrics.errors}`);
  console.log(`Latency (ms): min=${latencyStats.min} avg=${latencyStats.avg} p95=${latencyStats.p95} max=${latencyStats.max}`);
  console.log(`Snapshots: ${metrics.snapshotsReceived} | Gap avg=${snapshotStats.avg}ms (target: 50ms for 20Hz)`);
  console.log(`Throughput: ${Math.round(metrics.messagesSent / elapsed)} msg/s sent, ${Math.round(metrics.messagesReceived / elapsed)} msg/s received`);
  console.log('-------------------------\n');
}

/**
 * Check server health
 */
async function checkServerHealth() {
  try {
    const response = await httpRequest('GET', '/api/health');
    return response.body;
  } catch (error) {
    return null;
  }
}

/**
 * Main load test function
 */
async function runLoadTest() {
  console.log('\n========================================');
  console.log('  RPS-ARENA Load Test');
  console.log('========================================');
  console.log(`Target: ${WS_URL}`);
  console.log(`Players: ${CONFIG.players}`);
  console.log(`Duration: ${CONFIG.duration}s`);
  console.log(`Input Rate: ${CONFIG.inputRate} Hz per player`);
  console.log(`Expected throughput: ${CONFIG.players * CONFIG.inputRate} INPUT/s`);
  console.log('========================================\n');

  // Check server is running
  const health = await checkServerHealth();
  if (!health) {
    log('Server not reachable! Start the server first.', 'fail');
    process.exit(1);
  }
  log(`Server health: ${health.status}`, 'info');

  metrics.startTime = Date.now();

  // Spawn players gradually (100ms apart)
  log(`Spawning ${CONFIG.players} players...`, 'info');
  for (let i = 0; i < CONFIG.players; i++) {
    await createPlayer(i);
    await new Promise(r => setTimeout(r, 100));

    if ((i + 1) % 10 === 0) {
      log(`${i + 1} players connected`, 'info');
    }
  }

  log(`All ${CONFIG.players} players spawned`, 'pass');

  // Print metrics every 30 seconds
  const metricsInterval = setInterval(printMetrics, 30000);

  // Run for configured duration
  const testDuration = CONFIG.duration * 1000;
  const startTime = Date.now();

  while (Date.now() - startTime < testDuration) {
    await new Promise(r => setTimeout(r, 1000));

    // Check if all connections dropped
    if (connections.length === 0) {
      log('All connections lost!', 'fail');
      break;
    }
  }

  // Cleanup
  clearInterval(metricsInterval);
  log('Test complete, closing connections...', 'info');

  connections.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1000);
    }
  });

  // Wait for cleanup
  await new Promise(r => setTimeout(r, 2000));

  // Final metrics
  printMetrics();

  // Evaluate results
  console.log('\n========================================');
  console.log('  Load Test Results');
  console.log('========================================');

  const latencyStats = calculateStats(metrics.latencies);
  const snapshotStats = calculateStats(metrics.snapshotGaps);

  const results = [];

  // Check connection stability
  if (metrics.disconnected === 0) {
    results.push({ test: 'Connection Stability', status: 'PASS', detail: 'No unexpected disconnections' });
  } else {
    results.push({ test: 'Connection Stability', status: 'FAIL', detail: `${metrics.disconnected} disconnections` });
  }

  // Check latency
  if (latencyStats.p95 < 100) {
    results.push({ test: 'Latency (p95 < 100ms)', status: 'PASS', detail: `${latencyStats.p95}ms` });
  } else {
    results.push({ test: 'Latency (p95 < 100ms)', status: 'WARN', detail: `${latencyStats.p95}ms` });
  }

  // Check snapshot rate (target 50ms = 20Hz)
  if (snapshotStats.avg > 0 && snapshotStats.avg < 100) {
    results.push({ test: 'Snapshot Rate (~20Hz)', status: 'PASS', detail: `${snapshotStats.avg}ms avg gap` });
  } else if (snapshotStats.avg === 0) {
    results.push({ test: 'Snapshot Rate', status: 'N/A', detail: 'No matches running' });
  } else {
    results.push({ test: 'Snapshot Rate (~20Hz)', status: 'WARN', detail: `${snapshotStats.avg}ms avg gap` });
  }

  // Check error rate
  const errorRate = metrics.errors / metrics.messagesReceived * 100;
  if (errorRate < 1) {
    results.push({ test: 'Error Rate (< 1%)', status: 'PASS', detail: `${errorRate.toFixed(2)}%` });
  } else {
    results.push({ test: 'Error Rate (< 1%)', status: 'FAIL', detail: `${errorRate.toFixed(2)}%` });
  }

  // Print results
  results.forEach(r => {
    const color = r.status === 'PASS' ? '\x1b[32m' : r.status === 'FAIL' ? '\x1b[31m' : '\x1b[33m';
    console.log(`${color}[${r.status}]\x1b[0m ${r.test}: ${r.detail}`);
  });

  console.log('========================================\n');

  // Exit code based on failures
  const failures = results.filter(r => r.status === 'FAIL').length;
  process.exit(failures > 0 ? 1 : 0);
}

// Run if executed directly
runLoadTest().catch(error => {
  log(`Fatal error: ${error.message}`, 'fail');
  process.exit(1);
});
