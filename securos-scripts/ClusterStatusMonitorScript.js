const { exec } = require('child_process');
const path = require('path');

const APP_DIR = 'D:\\ISS\\SA\\6_Tahakom\\TahakomDataTransfer2026\\VideoTransferApp\\VideoTransferApp\\app';
const CONFIG_FILE = 'ecosystem.config.js';
const PM2_PATH = '"C:\\Program Files (x86)\\ISS\\SecurOS\\bin64\\node.js\\bin\\pm2"';
const CHECK_INTERVAL = 10 * 60 * 1000; // 10 minutes in milliseconds
const EXPECTED_PROCESSES = 9; // Expected number of processes

console.log('\r\n');

// Function to get current timestamp
function getTimestamp() {
  return new Date().toISOString().replace('T', ' ').substr(0, 19);
}

// Check if PM2 has running processes
function checkPM2Status(callback) {
  exec(`${PM2_PATH} jlist`, (error, stdout, stderr) => {
    if (error) {
      console.log(`[${getTimestamp()}] PM2 is not running or not installed`);
      callback(false, 0);
      return;
    }
    
    try {
      const processes = JSON.parse(stdout);
      const runningCount = processes.filter(p => p.pm2_env.status === 'online').length;
      callback(true, runningCount);
    } catch (e) {
      console.log(`[${getTimestamp()}] Error parsing PM2 process list`);
      callback(true, 0);
    }
  });
}

// Start PM2 with ecosystem config
function startPM2(callback) {
  console.log(`[${getTimestamp()}] Changing directory to ${APP_DIR}`);
  process.chdir(APP_DIR);
  
  console.log(`[${getTimestamp()}] Starting PM2 with ${CONFIG_FILE}...`);
  
  exec(`${PM2_PATH} start ${CONFIG_FILE}`, (error, stdout, stderr) => {
    if (error) {
      console.error(`[${getTimestamp()}] Error starting PM2: ${error.message}`);
      if (callback) callback(false);
      return;
    }
    
    console.log(`[${getTimestamp()}] PM2 started successfully!`);
    console.log(stdout);
    
    // Verify status after starting
    setTimeout(() => {
      checkPM2Status((isRunning, count) => {
        console.log(`[${getTimestamp()}] Verification: ${count} processes running`);
        if (callback) callback(true);
      });
    }, 3000);
  });
}

// Restart PM2 processes
function restartPM2(callback) {
  console.log(`[${getTimestamp()}] Restarting PM2 processes...`);
  process.chdir(APP_DIR);
  
  exec(`${PM2_PATH} restart ${CONFIG_FILE}`, (error, stdout, stderr) => {
    if (error) {
      console.log(`[${getTimestamp()}] Restart failed, trying fresh start...`);
      startPM2(callback);
    } else {
      console.log(`[${getTimestamp()}] PM2 restarted successfully!`);
      if (callback) callback(true);
    }
  });
}

// Monitor function that runs every interval
function monitor() {
  console.log(`\n[${getTimestamp()}] ========== PM2 Monitor Check ==========`);
  
  checkPM2Status((isRunning, processCount) => {
    console.log(`[${getTimestamp()}] Current status: ${processCount} process(es) running`);
    
    if (processCount < EXPECTED_PROCESSES) {
      console.log(`[${getTimestamp()}] WARNING: Only ${processCount} processes running (expected ${EXPECTED_PROCESSES})`);
      console.log(`[${getTimestamp()}] Attempting to restart PM2 processes...`);
      
      // Try to restart/start the processes
      if (processCount === 0) {
        startPM2((success) => {
          if (success) {
            console.log(`[${getTimestamp()}] Successfully started PM2 processes`);
          } else {
            console.log(`[${getTimestamp()}] Failed to start PM2 processes`);
          }
        });
      } else {
        restartPM2((success) => {
          if (success) {
            console.log(`[${getTimestamp()}] Successfully restarted PM2 processes`);
          } else {
            console.log(`[${getTimestamp()}] Failed to restart PM2 processes`);
          }
        });
      }
    } else {
      console.log(`[${getTimestamp()}] All ${processCount} processes are running correctly`);
      
      // Optionally show the process list
      exec(`${PM2_PATH} list`, (error, stdout) => {
        if (!error) {
          console.log(`[${getTimestamp()}] Process list:`);
          console.log(stdout);
        }
      });
    }
    
    console.log(`[${getTimestamp()}] Next check in 10 minutes...`);
  });
}

// Main execution
console.log('===========================================');
console.log('PM2 Continuous Monitor & Auto-Restart');
console.log('===========================================');
console.log(`Started at: ${getTimestamp()}`);
console.log(`Checking every: ${CHECK_INTERVAL / 1000 / 60} minutes`);
console.log(`Expected processes: ${EXPECTED_PROCESSES}`);
console.log('===========================================\n');

// Run initial check
monitor();

// Set up interval for continuous monitoring
const intervalId = setInterval(monitor, CHECK_INTERVAL);

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log(`\n[${getTimestamp()}] Received SIGINT, stopping monitor...`);
  clearInterval(intervalId);
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log(`\n[${getTimestamp()}] Received SIGTERM, stopping monitor...`);
  clearInterval(intervalId);
  process.exit(0);
});

console.log('Press Ctrl+C to stop monitoring\n');