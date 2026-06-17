const fs = require('fs');
const path = require('path');

// Copy .env.example to .env if .env doesn't exist
const projectRoot = path.join(__dirname, '..', '..');
const envExamplePath = path.join(projectRoot, '.env.example');
const envPath = path.join(projectRoot, '.env');

if (!fs.existsSync(envPath)) {
    if (fs.existsSync(envExamplePath)) {
        fs.copyFileSync(envExamplePath, envPath);
        console.log('✅ .env file created from .env.example');
        console.log('📝 Please review and update the configuration values in .env file');
    } else {
        console.log('❌ .env.example file not found');
    }
} else {
    console.log('ℹ️  .env file already exists');
} 