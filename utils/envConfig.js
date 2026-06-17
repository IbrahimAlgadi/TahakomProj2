const path = require('path');

// Load environment variables from .env file
require('dotenv').config();

const config = {
  // Directories
  ROOT_DIR: process.env.ROOT_DIR || path.join(__dirname, '..', 'data_transfer_v2'),
  EXPORT_DIR: process.env.EXPORT_DIR || 'C:\\export',
  CONFIG_FILE_PATH: path.join(process.env.ROOT_DIR || path.join(__dirname, '..', 'data_transfer_v2'), 'dataTransferConfig.json'),
  
  // ISS Media Configuration
  ISS_MEDIA_DIR: process.env.ISS_MEDIA_DIR || 'D:\\ISS_MEDIA',
  ISS_MEDIA_CAMERAS: process.env.ISS_MEDIA_CAMERAS ? process.env.ISS_MEDIA_CAMERAS.split(',') : ['CAM_1', 'CAM_2', 'CAM_3'],
  ISS_MEDIA_FILE_SIZE: parseInt(process.env.ISS_MEDIA_FILE_SIZE) || 8192, // KB
  ISS_MEDIA_RETENTION: parseInt(process.env.ISS_MEDIA_RETENTION) || 7, // days
  ISS_VIDEO_TRANSFER_SIZE: parseInt(process.env.ISS_VIDEO_TRANSFER_SIZE) || 5, // minutes
  ISS_VIDEO_TRANSFER_CONVERSION_COUNT: parseInt(process.env.ISS_VIDEO_TRANSFER_CONVERSION_COUNT) || 38, // minutes
  
  // Database
  database: {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'tahakom_transfer'
  },
  
  // Redis
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT) || 6379
  },
  
  // Application
  app: {
    port: parseInt(process.env.APP_PORT) || 8454,
    nodeEnv: process.env.NODE_ENV || 'development'
  }
};

module.exports = config; 