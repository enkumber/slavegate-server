#!/usr/bin/env node
/**
 * Engage Session Executor
 * Executes likes, comments, follows on Instagram via device API
 */

const http = require('http');

const CONFIG = {
  apiBase: 'http://localhost:18791',
  apiKey: '928b9e0ba7caeb3e039dafde99076d2d',
  deviceId: '2cd08058-f4ad-4445-b953-eb9a23d0e1a0',
  taskId: process.argv[2] || '4146f32f-91db-4d36-b5f3-b4fae9b66f0b',
  dbUrl: 'postgresql://node@localhost:5432/phonenetwork'
};

const TARGETS = {
  seed_accounts: ['club_brasov', 'club_braila', 'club_galati'],
  actions: { likes: 35, comments: 7, follows: 3 },
  comment_templates: [
    'Great content! 👏',
    'Love your perspective on this!',
    'Thanks for sharing! 🙌'
  ]
};

const TIMING = {
  delayMin: 45000,
  delayMax: 120000
};

function randomDelay() {
  return Math.floor(Math.random() * (TIMING.delayMax - TIMING.delayMin) + TIMING.delayMin);
}

function randomComment() {
  return TARGETS.comment_templates[Math.floor(Math.random() * TARGETS.comment_templates.length)];
}

async function sendJob(type, params, waitForResult = true) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ deviceId: CONFIG.deviceId, type, params });
    const url = new URL(`${CONFIG.apiBase}/api/jobs`);
    
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': CONFIG.apiKey,
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', async () => {
        try {
          const result = JSON.parse(body);
          if (!result.ok) {
            resolve(result);
            return;
          }
          if (!waitForResult) {
            resolve(result);
            return;
          }
          // Poll for job completion
          const jobId = result.data.jobId;
          for (let i = 0; i < 30; i++) {
            await sleep(1000);
            const status = await getJobStatus(jobId);
            if (status.data?.status === 'completed' || status.data?.status === 'failed') {
              resolve(status);
              return;
            }
          }
          resolve({ ok: false, error: 'Job timeout' });
        } catch (e) {
          resolve({ raw: body });
        }
      });
    });
    
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function getJobStatus(jobId) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${CONFIG.apiBase}/api/jobs/${jobId}`);
    
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'GET',
      headers: {
        'X-API-Key': CONFIG.apiKey
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve({ raw: body });
        }
      });
    });
    
    req.on('error', reject);
    req.end();
  });
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function updateTaskStatus(status) {
  const { Client } = require('pg');
  const c = new Client(CONFIG.dbUrl);
  await c.connect();
  
  const updates = { status };
  if (status === 'running') updates.started_at = new Date().toISOString();
  if (status === 'completed') updates.completed_at = new Date().toISOString();
  
  const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(', ');
  await c.query(`UPDATE tasks SET ${setClauses} WHERE id = $1`, [CONFIG.taskId, ...Object.values(updates)]);
  await c.end();
  console.log(`[DB] Task status: ${status}`);
}

async function main() {
  console.log('=== ENGAGE SESSION START ===');
  console.log('Device:', CONFIG.deviceId);
  console.log('Task:', CONFIG.taskId);
  console.log('Targets:', TARGETS.seed_accounts.join(', '));
  console.log('Actions:', JSON.stringify(TARGETS.actions));
  console.log('');
  
  // Mark task as running
  await updateTaskStatus('running');
  
  // Wake and unlock screen
  console.log('[1/4] Waking screen...');
  await sendJob('screen_wake', {});
  await sleep(2000);
  
  console.log('[2/4] Unlocking...');
  await sendJob('unlock', {});
  await sleep(3000);
  
  // Open Instagram
  console.log('[3/4] Opening Instagram...');
  await sendJob('open_app', { packageName: 'com.instagram.android' });
  await sleep(5000);
  
  console.log('[4/4] Starting engagement...');
  
  let likesLeft = TARGETS.actions.likes;
  let commentsLeft = TARGETS.actions.comments;
  let followsLeft = TARGETS.actions.follows;
  let actionCount = 0;
  
  // Process each seed account
  for (const account of TARGETS.seed_accounts) {
    console.log(`\n--- Processing @${account} ---`);
    
    // Go to search
    await sendJob('tap', { x: 540, y: 2200 }); // Search icon
    await sleep(2000);
    
    // Type account name
    await sendJob('tap', { x: 540, y: 200 }); // Search bar
    await sleep(1000);
    await sendJob('type_text', { text: account });
    await sleep(2000);
    
    // Tap first result
    await sendJob('tap', { x: 540, y: 400 });
    await sleep(3000);
    
    // Engage with posts in feed
    const actionsPerAccount = Math.ceil((likesLeft + commentsLeft + followsLeft) / TARGETS.seed_accounts.length);
    
    for (let i = 0; i < actionsPerAccount && (likesLeft > 0 || commentsLeft > 0 || followsLeft > 0); i++) {
      // Scroll down a bit
      await sendJob('swipe', { startX: 540, startY: 1500, endX: 540, endY: 800, durationMs: 500 });
      await sleep(2000);
      
      // Decide action: prioritize likes, then comments, then follows
      if (likesLeft > 0 && Math.random() > 0.3) {
        console.log(`  [LIKE] ${++actionCount}/${TARGETS.actions.likes + TARGETS.actions.comments + TARGETS.actions.follows}`);
        await sendJob('tap', { x: 150, y: 1200 }); // Heart icon area
        likesLeft--;
        await sleep(randomDelay());
      } else if (commentsLeft > 0 && Math.random() > 0.5) {
        console.log(`  [COMMENT] "${randomComment()}"`);
        await sendJob('tap', { x: 280, y: 1200 }); // Comment icon
        await sleep(2000);
        await sendJob('type_text', { text: randomComment() });
        await sleep(1000);
        await sendJob('tap', { x: 1000, y: 200 }); // Post button
        commentsLeft--;
        await sleep(randomDelay());
      } else if (followsLeft > 0) {
        console.log(`  [FOLLOW]`);
        await sendJob('tap', { x: 900, y: 400 }); // Follow button area
        followsLeft--;
        await sleep(randomDelay());
      } else if (likesLeft > 0) {
        console.log(`  [LIKE] ${++actionCount}/${TARGETS.actions.likes + TARGETS.actions.comments + TARGETS.actions.follows}`);
        await sendJob('tap', { x: 150, y: 1200 });
        likesLeft--;
        await sleep(randomDelay());
      }
      
      // Progress report every 10 actions
      if (actionCount % 10 === 0) {
        console.log(`\n>>> Progress: ${actionCount} actions done, ${likesLeft} likes / ${commentsLeft} comments / ${followsLeft} follows remaining\n`);
      }
    }
    
    // Go back to search for next account
    await sendJob('press_key', { key: 'back' });
    await sleep(1000);
    await sendJob('press_key', { key: 'back' });
    await sleep(1000);
  }
  
  // Mark task complete
  await updateTaskStatus('completed');
  
  console.log('\n=== SESSION COMPLETE ===');
  console.log(`Total actions: ${actionCount}`);
  console.log(`Remaining: ${likesLeft} likes, ${commentsLeft} comments, ${followsLeft} follows`);
}

main().catch(err => {
  console.error('FATAL:', err);
  updateTaskStatus('failed').catch(() => {});
  process.exit(1);
});
