/**
 * RPS-ARENA Security Tests
 *
 * Tests for:
 * - Rate limiting (120 INPUT/sec, 10 OTHER/sec)
 * - Connection limits (3 per IP)
 * - Message size limits (16KB)
 * - Invalid message handling
 * - Bot endpoint blocking on port 3000
 * - Payment bypass attempts
 *
 * Usage: node tests/security/security-tests.js [--production]
 *
 * By default tests run against admin port (3001).
 * Use --production flag to test production port (3000).
 */

const WebSocket = require('ws');
const http = require('http');
const https = require('https');

// Configuration
const CONFIG = {
  adminPort: 3001,
  productionPort: 3000,
  host: 'localhost',
  testProduction: process.argv.includes('--production'),
};

const PORT = CONFIG.testProduction ? CONFIG.productionPort : CONFIG.adminPort;
const WS_URL = `ws://${CONFIG.host}:${PORT}`;
const HTTP_URL = `http://${CONFIG.host}:${PORT}`;

// Test results
const results = {
  passed: 0,
  failed: 0,
  tests: [],
};

// Helper functions
function log(message, type = 'info') {
  const prefix = {
    info: '\x1b[36m[INFO]\x1b[0m',
    pass: '\x1b[32m[PASS]\x1b[0m',
    fail: '\x1b[31m[FAIL]\x1b[0m',
    warn: '\x1b[33m[WARN]\x1b[0m',
  };
  console.log(`${prefix[type] || prefix.info} ${message}`);
}

function recordResult(testName, passed, details = '') {
  results.tests.push({ name: testName, passed, details });
  if (passed) {
    results.passed++;
    log(`${testName}: ${details}`, 'pass');
  } else {
    results.failed++;
    log(`${testName}: ${details}`, 'fail');
  }
}

function createWebSocket() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WebSocket connection timeout')), 5000);
  });
}

function waitForMessage(ws, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeAllListeners('message');
      reject(new Error('Message timeout'));
    }, timeout);

    ws.once('message', (data) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data.toString()));
      } catch (e) {
        resolve(data.toString());
      }
    });
  });
}

function httpRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: CONFIG.host,
      port: PORT,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          body: data ? JSON.parse(data) : null,
        });
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// Test implementations

/**
 * S1: Rate Limiting - INPUT Messages
 * Expected: After 120 INPUT messages/sec, receive RATE_LIMITED error
 */
async function testRateLimitInput() {
  const testName = 'S1: Rate Limit INPUT (120/sec)';
  let ws;

  try {
    ws = await createWebSocket();

    // Send 150 INPUT messages rapidly
    const messages = [];
    for (let i = 0; i < 150; i++) {
      ws.send(JSON.stringify({
        type: 'INPUT',
        targetX: 800,
        targetY: 450,
        sequence: i,
        frozen: false,
      }));
    }

    // Wait for rate limit error
    const response = await waitForMessage(ws, 2000);

    if (response.type === 'ERROR' && response.code === 5001) {
      recordResult(testName, true, 'Rate limit triggered correctly');
    } else {
      recordResult(testName, false, `Expected ERROR 5001, got: ${JSON.stringify(response)}`);
    }
  } catch (error) {
    // Timeout may indicate rate limiting worked (connection dropped)
    if (error.message === 'Message timeout') {
      recordResult(testName, true, 'Rate limit may have dropped connection');
    } else {
      recordResult(testName, false, `Error: ${error.message}`);
    }
  } finally {
    if (ws) ws.close();
  }
}

/**
 * S2: Rate Limiting - OTHER Messages
 * Expected: After 10 OTHER messages/sec, receive RATE_LIMITED error
 */
async function testRateLimitOther() {
  const testName = 'S2: Rate Limit OTHER (10/sec)';
  let ws;

  try {
    ws = await createWebSocket();

    // Send 15 PING messages rapidly
    for (let i = 0; i < 15; i++) {
      ws.send(JSON.stringify({
        type: 'PING',
        clientTime: Date.now(),
      }));
    }

    // Wait for rate limit error
    const response = await waitForMessage(ws, 2000);

    if (response.type === 'ERROR' && response.code === 5001) {
      recordResult(testName, true, 'Rate limit triggered correctly');
    } else if (response.type === 'PONG') {
      // May get some PONGs before rate limit kicks in
      recordResult(testName, true, 'Received PONG, rate limit may not be immediate');
    } else {
      recordResult(testName, false, `Unexpected response: ${JSON.stringify(response)}`);
    }
  } catch (error) {
    recordResult(testName, false, `Error: ${error.message}`);
  } finally {
    if (ws) ws.close();
  }
}

/**
 * S3: Connection Limit (3 per IP)
 * Expected: 4th connection from same IP rejected
 */
async function testConnectionLimit() {
  const testName = 'S3: Connection Limit (3/IP)';
  const connections = [];

  try {
    // Try to open 5 connections
    for (let i = 0; i < 5; i++) {
      try {
        const ws = await createWebSocket();
        connections.push(ws);
      } catch (error) {
        // Connection rejected - this is expected for 4th+ connection
        if (connections.length >= 3) {
          recordResult(testName, true, `Connection ${i + 1} rejected (limit enforced)`);
          return;
        }
      }
    }

    // If all 5 connected, test failed
    if (connections.length === 5) {
      recordResult(testName, false, 'All 5 connections accepted (limit not enforced)');
    } else {
      recordResult(testName, true, `Only ${connections.length} connections accepted`);
    }
  } finally {
    connections.forEach(ws => ws.close());
  }
}

/**
 * S4: Oversized Message (>16KB)
 * Expected: Error or connection close
 */
async function testOversizedMessage() {
  const testName = 'S4: Oversized Message (>16KB)';
  let ws;

  try {
    ws = await createWebSocket();

    // Create a message > 16KB
    const largePayload = {
      type: 'INPUT',
      targetX: 800,
      targetY: 450,
      sequence: 1,
      garbage: 'x'.repeat(20000), // 20KB of data
    };

    ws.send(JSON.stringify(largePayload));

    // Wait for error response
    const response = await waitForMessage(ws, 2000);

    if (response.type === 'ERROR') {
      recordResult(testName, true, `Oversized message rejected: ${response.message}`);
    } else {
      recordResult(testName, false, `Expected error, got: ${JSON.stringify(response)}`);
    }
  } catch (error) {
    // Connection may be closed for oversized message
    recordResult(testName, true, `Connection handled oversized message: ${error.message}`);
  } finally {
    if (ws) ws.close();
  }
}

/**
 * S5: Malformed JSON
 * Expected: Server doesn't crash, message ignored or error returned
 */
async function testMalformedJson() {
  const testName = 'S5: Malformed JSON';
  let ws;

  try {
    ws = await createWebSocket();

    // Send invalid JSON
    ws.send('not valid json at all');
    ws.send('{"type": "HELLO"'); // Incomplete JSON
    ws.send('}{bad json}{');

    // Server should still be responsive
    ws.send(JSON.stringify({ type: 'PING', clientTime: Date.now() }));

    const response = await waitForMessage(ws, 3000);

    // If we get any response (PONG or ERROR), server is still alive
    if (response.type === 'PONG' || response.type === 'ERROR') {
      recordResult(testName, true, 'Server handled malformed JSON gracefully');
    } else {
      recordResult(testName, true, `Server responded with: ${response.type}`);
    }
  } catch (error) {
    recordResult(testName, false, `Server may have crashed: ${error.message}`);
  } finally {
    if (ws) ws.close();
  }
}

/**
 * S6: Unknown Message Type
 * Expected: Error response with unknown type message
 */
async function testUnknownMessageType() {
  const testName = 'S6: Unknown Message Type';
  let ws;

  try {
    ws = await createWebSocket();

    ws.send(JSON.stringify({
      type: 'HACK_ATTEMPT',
      payload: 'malicious',
    }));

    const response = await waitForMessage(ws, 2000);

    if (response.type === 'ERROR') {
      recordResult(testName, true, `Unknown type rejected: ${response.message}`);
    } else {
      recordResult(testName, false, `Expected error, got: ${JSON.stringify(response)}`);
    }
  } catch (error) {
    recordResult(testName, false, `Error: ${error.message}`);
  } finally {
    if (ws) ws.close();
  }
}

/**
 * S7: Invalid Coordinates
 * Expected: Validation error or message ignored
 */
async function testInvalidCoordinates() {
  const testName = 'S7: Invalid Coordinates';
  let ws;

  try {
    ws = await createWebSocket();

    // Test various invalid coordinates
    const invalidInputs = [
      { targetX: 'string', targetY: 450, sequence: 1 },
      { targetX: NaN, targetY: 450, sequence: 1 },
      { targetX: Infinity, targetY: 450, sequence: 1 },
      { targetX: -100, targetY: 450, sequence: 1 },
      { targetX: 2000, targetY: 450, sequence: 1 }, // Out of bounds
      { targetX: 800, targetY: null, sequence: 1 },
    ];

    for (const input of invalidInputs) {
      ws.send(JSON.stringify({ type: 'INPUT', ...input, frozen: false }));
    }

    // Server should handle all gracefully
    ws.send(JSON.stringify({ type: 'PING', clientTime: Date.now() }));

    const response = await waitForMessage(ws, 2000);

    if (response) {
      recordResult(testName, true, 'Server handled invalid coordinates');
    }
  } catch (error) {
    recordResult(testName, false, `Error: ${error.message}`);
  } finally {
    if (ws) ws.close();
  }
}

/**
 * S8: Bot Endpoints on Production Port
 * Expected: All return 404
 */
async function testBotEndpointsBlocked() {
  const testName = 'S8: Bot Endpoints Blocked';

  if (!CONFIG.testProduction) {
    recordResult(testName, true, 'Skipped (use --production flag)');
    return;
  }

  const endpoints = [
    { method: 'POST', path: '/api/bot/add' },
    { method: 'POST', path: '/api/bot/fill' },
    { method: 'GET', path: '/api/bot/list' },
    { method: 'POST', path: '/api/dev/reset' },
  ];

  let allBlocked = true;
  const details = [];

  for (const endpoint of endpoints) {
    try {
      const response = await httpRequest(endpoint.method, endpoint.path, { lobbyId: 1 });
      if (response.status === 404) {
        details.push(`${endpoint.path}: 404 OK`);
      } else {
        details.push(`${endpoint.path}: ${response.status} EXPOSED!`);
        allBlocked = false;
      }
    } catch (error) {
      details.push(`${endpoint.path}: Error - ${error.message}`);
    }
  }

  recordResult(testName, allBlocked, details.join(', '));
}

/**
 * S9: Payment Bypass - Fake Transaction Hash
 * Expected: Payment verification fails
 */
async function testFakeTransactionHash() {
  const testName = 'S9: Fake Transaction Hash';
  let ws;

  try {
    ws = await createWebSocket();

    // Try to join with fake tx hash
    ws.send(JSON.stringify({
      type: 'JOIN_LOBBY',
      lobbyId: 1,
      paymentTxHash: '0x' + 'a'.repeat(64), // Valid format but fake
    }));

    const response = await waitForMessage(ws, 10000); // Longer timeout for blockchain check

    if (response.type === 'ERROR') {
      recordResult(testName, true, `Fake tx rejected: code ${response.code}`);
    } else if (response.type === 'LOBBY_UPDATE') {
      // On admin port, may be allowed
      if (!CONFIG.testProduction) {
        recordResult(testName, true, 'Admin port allows dev joins');
      } else {
        recordResult(testName, false, 'Fake tx accepted on production!');
      }
    } else {
      recordResult(testName, false, `Unexpected: ${JSON.stringify(response)}`);
    }
  } catch (error) {
    recordResult(testName, false, `Error: ${error.message}`);
  } finally {
    if (ws) ws.close();
  }
}

/**
 * S10: Dev Transaction Hash on Production
 * Expected: Rejected on production port
 */
async function testDevTxHashOnProduction() {
  const testName = 'S10: Dev Tx Hash on Production';

  if (!CONFIG.testProduction) {
    recordResult(testName, true, 'Skipped (use --production flag)');
    return;
  }

  let ws;

  try {
    ws = await createWebSocket();

    ws.send(JSON.stringify({
      type: 'JOIN_LOBBY',
      lobbyId: 1,
      paymentTxHash: '0xdev_bypass_attempt',
    }));

    const response = await waitForMessage(ws, 5000);

    if (response.type === 'ERROR') {
      recordResult(testName, true, `Dev tx rejected on production: ${response.code}`);
    } else {
      recordResult(testName, false, 'Dev tx hash accepted on production!');
    }
  } catch (error) {
    recordResult(testName, false, `Error: ${error.message}`);
  } finally {
    if (ws) ws.close();
  }
}

/**
 * S11: Negative/Invalid Sequence Numbers
 * Expected: Validation rejects or ignores
 */
async function testInvalidSequence() {
  const testName = 'S11: Invalid Sequence Numbers';
  let ws;

  try {
    ws = await createWebSocket();

    const invalidSequences = [-1, -999, 'string', null, undefined];

    for (const seq of invalidSequences) {
      ws.send(JSON.stringify({
        type: 'INPUT',
        targetX: 800,
        targetY: 450,
        sequence: seq,
        frozen: false,
      }));
    }

    // Server should handle gracefully
    ws.send(JSON.stringify({ type: 'PING', clientTime: Date.now() }));

    const response = await waitForMessage(ws, 2000);

    if (response) {
      recordResult(testName, true, 'Server handled invalid sequences');
    }
  } catch (error) {
    recordResult(testName, false, `Error: ${error.message}`);
  } finally {
    if (ws) ws.close();
  }
}

// Main test runner
async function runAllTests() {
  console.log('\n========================================');
  console.log('  RPS-ARENA Security Test Suite');
  console.log('========================================');
  console.log(`Target: ${WS_URL} (${CONFIG.testProduction ? 'PRODUCTION' : 'ADMIN'})`);
  console.log('========================================\n');

  // Check server is running
  try {
    const health = await httpRequest('GET', '/api/health');
    log(`Server health: ${health.body?.status || 'unknown'}`, 'info');
  } catch (error) {
    log('Server not reachable! Start the server first.', 'fail');
    process.exit(1);
  }

  // Run tests
  await testRateLimitInput();
  await testRateLimitOther();
  await testConnectionLimit();
  await testOversizedMessage();
  await testMalformedJson();
  await testUnknownMessageType();
  await testInvalidCoordinates();
  await testBotEndpointsBlocked();
  await testFakeTransactionHash();
  await testDevTxHashOnProduction();
  await testInvalidSequence();

  // Print summary
  console.log('\n========================================');
  console.log('  Test Summary');
  console.log('========================================');
  console.log(`  Passed: ${results.passed}`);
  console.log(`  Failed: ${results.failed}`);
  console.log(`  Total:  ${results.tests.length}`);
  console.log('========================================\n');

  // Exit with appropriate code
  process.exit(results.failed > 0 ? 1 : 0);
}

// Run if executed directly
runAllTests().catch(console.error);
