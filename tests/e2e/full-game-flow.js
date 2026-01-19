/**
 * RPS-ARENA End-to-End Test
 *
 * Tests the complete game flow using bots:
 * 1. Fill lobby with bots
 * 2. Wait for match to start
 * 3. Wait for match to complete
 * 4. Verify lobby resets
 *
 * Usage: node tests/e2e/full-game-flow.js [options]
 *
 * Options:
 *   --lobby=N      Lobby ID to test (default: 1)
 *   --port=N       Server port (default: 3001)
 *   --timeout=N    Max wait time in seconds (default: 120)
 */

const http = require('http');

// Parse command line arguments
function parseArgs() {
  const args = {
    lobby: 1,
    port: 3001,
    timeout: 120,
    host: 'localhost',
  };

  process.argv.slice(2).forEach(arg => {
    const [key, value] = arg.replace('--', '').split('=');
    if (key === 'lobby') args.lobby = parseInt(value);
    if (key === 'port') args.port = parseInt(value);
    if (key === 'timeout') args.timeout = parseInt(value);
  });

  return args;
}

const CONFIG = parseArgs();

// Test state
const state = {
  startTime: null,
  matchStarted: false,
  matchEnded: false,
  winner: null,
  lobbyReset: false,
};

// Utility functions
function log(message, type = 'info') {
  const timestamp = new Date().toISOString().substr(11, 12);
  const prefix = {
    info: '\x1b[36m[INFO]\x1b[0m',
    pass: '\x1b[32m[PASS]\x1b[0m',
    fail: '\x1b[31m[FAIL]\x1b[0m',
    warn: '\x1b[33m[WARN]\x1b[0m',
    step: '\x1b[35m[STEP]\x1b[0m',
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
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check server health
 */
async function checkHealth() {
  try {
    const response = await httpRequest('GET', '/api/health');
    return response.body;
  } catch (error) {
    return null;
  }
}

/**
 * Get lobby status
 */
async function getLobbyStatus(lobbyId) {
  try {
    const response = await httpRequest('GET', '/api/lobbies');
    if (response.body && response.body.lobbies) {
      return response.body.lobbies.find(l => l.id === lobbyId);
    }
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Fill lobby with bots
 */
async function fillLobby(lobbyId) {
  try {
    const response = await httpRequest('POST', '/api/bot/fill', { lobbyId });
    return response;
  } catch (error) {
    return { status: 500, body: { error: error.message } };
  }
}

/**
 * Reset lobby (remove all players)
 */
async function resetLobby(lobbyId) {
  try {
    const response = await httpRequest('POST', '/api/dev/reset', { lobbyId });
    return response;
  } catch (error) {
    return { status: 500, body: { error: error.message } };
  }
}

/**
 * List active bots
 */
async function listBots() {
  try {
    const response = await httpRequest('GET', '/api/bot/list');
    return response.body || [];
  } catch (error) {
    return [];
  }
}

/**
 * Wait for lobby to reach a specific status
 */
async function waitForLobbyStatus(lobbyId, targetStatus, maxWait = 60) {
  const startTime = Date.now();
  const maxMs = maxWait * 1000;

  while (Date.now() - startTime < maxMs) {
    const lobby = await getLobbyStatus(lobbyId);

    if (lobby && lobby.status === targetStatus) {
      return true;
    }

    await sleep(500);
  }

  return false;
}

/**
 * Run the full E2E test
 */
async function runE2ETest() {
  console.log('\n========================================');
  console.log('  RPS-ARENA End-to-End Test');
  console.log('========================================');
  console.log(`Target: http://${CONFIG.host}:${CONFIG.port}`);
  console.log(`Lobby: ${CONFIG.lobby}`);
  console.log(`Timeout: ${CONFIG.timeout}s`);
  console.log('========================================\n');

  state.startTime = Date.now();
  let passed = true;

  try {
    // Step 1: Check server health
    log('Step 1: Checking server health...', 'step');
    const health = await checkHealth();
    if (!health) {
      log('Server not reachable!', 'fail');
      return false;
    }
    log(`Server healthy: ${health.status}`, 'pass');

    // Step 2: Check dev mode
    log('Step 2: Verifying admin port (dev mode)...', 'step');
    const devModeResponse = await httpRequest('GET', '/api/dev-mode');
    if (!devModeResponse.body?.devMode) {
      log('Not running on admin port! Use port 3001.', 'fail');
      return false;
    }
    log('Admin port confirmed', 'pass');

    // Step 3: Reset lobby to clean state
    log(`Step 3: Resetting lobby ${CONFIG.lobby}...`, 'step');
    await resetLobby(CONFIG.lobby);
    await sleep(500);

    const initialLobby = await getLobbyStatus(CONFIG.lobby);
    if (initialLobby && initialLobby.playerCount > 0) {
      log(`Lobby has ${initialLobby.playerCount} players, waiting for cleanup...`, 'warn');
      await waitForLobbyStatus(CONFIG.lobby, 'empty', 30);
    }
    log('Lobby reset complete', 'pass');

    // Step 4: Fill lobby with bots
    log(`Step 4: Filling lobby ${CONFIG.lobby} with bots...`, 'step');
    const fillResponse = await fillLobby(CONFIG.lobby);

    if (fillResponse.status !== 200) {
      log(`Failed to fill lobby: ${JSON.stringify(fillResponse.body)}`, 'fail');
      return false;
    }

    const botsAdded = fillResponse.body.botsAdded || 0;
    log(`Added ${botsAdded} bots to lobby`, botsAdded > 0 ? 'pass' : 'warn');

    // Step 5: Verify lobby is ready
    log('Step 5: Verifying lobby status...', 'step');
    await sleep(500);
    const lobbyAfterFill = await getLobbyStatus(CONFIG.lobby);

    if (!lobbyAfterFill) {
      log('Could not get lobby status', 'fail');
      return false;
    }

    log(`Lobby status: ${lobbyAfterFill.status}, players: ${lobbyAfterFill.playerCount}`, 'info');

    if (lobbyAfterFill.playerCount !== 3) {
      log(`Expected 3 players, got ${lobbyAfterFill.playerCount}`, 'fail');
      return false;
    }
    log('Lobby has 3 players', 'pass');

    // Step 6: Wait for match to start
    log('Step 6: Waiting for match to start...', 'step');
    const matchStarted = await waitForLobbyStatus(CONFIG.lobby, 'in_match', 30);

    if (!matchStarted) {
      // Check if match already completed (fast)
      const currentStatus = await getLobbyStatus(CONFIG.lobby);
      if (currentStatus && currentStatus.status === 'empty') {
        log('Match completed very quickly', 'pass');
        state.matchStarted = true;
        state.matchEnded = true;
      } else {
        log(`Match did not start. Current status: ${currentStatus?.status}`, 'fail');
        return false;
      }
    } else {
      log('Match started!', 'pass');
      state.matchStarted = true;
    }

    // Step 7: Wait for match to complete
    if (!state.matchEnded) {
      log('Step 7: Waiting for match to complete...', 'step');

      // Match duration depends on bot behavior, typically 10-60 seconds
      const matchTimeout = 90;
      const matchCompleted = await waitForLobbyStatus(CONFIG.lobby, 'empty', matchTimeout);

      if (!matchCompleted) {
        const currentStatus = await getLobbyStatus(CONFIG.lobby);
        log(`Match did not complete in ${matchTimeout}s. Status: ${currentStatus?.status}`, 'fail');
        return false;
      }

      state.matchEnded = true;
      log('Match completed!', 'pass');
    }

    // Step 8: Verify lobby reset
    log('Step 8: Verifying lobby reset...', 'step');
    await sleep(500);
    const finalLobby = await getLobbyStatus(CONFIG.lobby);

    if (!finalLobby || finalLobby.status !== 'empty') {
      log(`Lobby did not reset properly. Status: ${finalLobby?.status}`, 'fail');
      return false;
    }

    state.lobbyReset = true;
    log('Lobby reset to empty state', 'pass');

    // Step 9: Check no bots remain
    log('Step 9: Verifying bot cleanup...', 'step');
    const remainingBots = await listBots();
    const lobbyBots = remainingBots.filter(b => b.lobbyId === CONFIG.lobby);

    if (lobbyBots.length > 0) {
      log(`${lobbyBots.length} bots still active in lobby`, 'warn');
    } else {
      log('All bots cleaned up', 'pass');
    }

    return true;

  } catch (error) {
    log(`Test error: ${error.message}`, 'fail');
    console.error(error);
    return false;
  }
}

/**
 * Print test summary
 */
function printSummary(passed) {
  const duration = ((Date.now() - state.startTime) / 1000).toFixed(1);

  console.log('\n========================================');
  console.log('  E2E Test Summary');
  console.log('========================================');

  const checks = [
    { name: 'Match Started', passed: state.matchStarted },
    { name: 'Match Completed', passed: state.matchEnded },
    { name: 'Lobby Reset', passed: state.lobbyReset },
  ];

  checks.forEach(check => {
    const status = check.passed ? '\x1b[32m[PASS]\x1b[0m' : '\x1b[31m[FAIL]\x1b[0m';
    console.log(`${status} ${check.name}`);
  });

  console.log('----------------------------------------');
  console.log(`Duration: ${duration}s`);
  console.log(`Overall: ${passed ? '\x1b[32mPASSED\x1b[0m' : '\x1b[31mFAILED\x1b[0m'}`);
  console.log('========================================\n');
}

/**
 * Main entry point
 */
async function main() {
  const passed = await runE2ETest();
  printSummary(passed);
  process.exit(passed ? 0 : 1);
}

// Run if executed directly
main().catch(error => {
  log(`Fatal error: ${error.message}`, 'fail');
  console.error(error);
  process.exit(1);
});
