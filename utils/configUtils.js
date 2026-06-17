const fs = require('fs-extra');
const path = require('path');

// Configuration
const config = require('./envConfig');
const { CONFIG_FILE_PATH } = config;

function writeConfig(configData) {
    try {
        fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(configData, null, 2));
        return true;
    } catch (error) {
        console.error('Error writing config:', error);
        return false;
    }
}

module.exports = { writeConfig };