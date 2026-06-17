# Configuration Setup Guide

This project now uses centralized configuration through environment variables. Follow these steps to set up the configuration:

## 1. Create Environment File

Run the setup script to create your `.env` file:

```bash
node setup-env.js
```

Alternatively, manually copy the `.env.example` file:

```bash
copy .env.example .env
```

## 2. Environment Variables

The following environment variables are available:

### Application Directories
- `ROOT_DIR`: Root directory for the data transfer application
- `EXPORT_DIR`: Directory for exported files

### Database Configuration
- `DB_HOST`: Database host (default: localhost)
- `DB_USER`: Database username (default: postgres)
- `DB_PASSWORD`: Database password (default: postgres)
- `DB_NAME`: Database name (default: tahakom_transfer)

### Redis Configuration
- `REDIS_HOST`: Redis host (default: localhost)
- `REDIS_PORT`: Redis port (default: 6379)

### Application Configuration
- `APP_PORT`: Application port (default: 8454)
- `NODE_ENV`: Node environment (default: development)

## 3. Configuration Files Updated

The following files have been updated to use centralized configuration:

- `DashboardReportingBackend.js`
- `DriveStateServiceRedis.js`
- `ConfigStateServiceRedis.js`
- `FileTransferRedisService.js`
- `utils/configUtils.js`
- `monitorSpecialProcessesMicroservice.js`
- `monitorConnectedExternalDrivesMicroservice.js`
- `test_scripts/testRedis.js`

## 4. Benefits

- **Single source of truth** for all configuration
- **Environment-specific configs** (development, production, test)
- **Security** - sensitive data can be kept in env files (not committed to git)
- **Easy deployment** - just change env file for different environments
- **Consistency** - all files use the same configuration source

## 5. Usage

The centralized configuration is loaded via `utils/envConfig.js`. Import it in your files:

```javascript
const config = require('./utils/envConfig');

// Use configuration
const { ROOT_DIR, EXPORT_DIR, CONFIG_FILE_PATH } = config;
const port = config.app.port;
const dbConfig = config.database;
const redisConfig = config.redis;
```

## 6. Important Notes

- The `.env` file should not be committed to version control
- Always provide fallback values in `utils/envConfig.js`
- Update the `.env.example` file when adding new configuration variables 