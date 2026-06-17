# Index suggested directories with Node.js
_Exported on 6/23/2025 at 15:27:41 GMT+3 from Cursor (1.1.3)_

---

**User**

According to @File transfer Modes.drawio.xml how can I index the suggested directories, how can this process be done using nodejs 

---

**Cursor**

Based on the process outlined in `File transfer Modes.drawio.xml`, here is a breakdown of how you can implement this file indexing process in Node.js.

The diagram describes these core steps:
1.  Recursively scan a root directory (`ISS_MEDIA`).
2.  Go through camera-specific subdirectories (`CAM_ID`).
3.  Go through date-stamped directories.
4.  Apply a retention policy to decide which date directories to scan.
5.  Index metadata of video files (`.issvd`) within those directories.
6.  Store this metadata in a PostgreSQL database.
7.  Continuously monitor the directories for any changes and update the index.

Here is a plan to implement this using Node.js:

### 1. Project Setup & Dependencies

You'll need a few packages to handle directory watching, and database interaction. I'll use `chokidar` for robust file watching and `pg` for PostgreSQL.

First, I'll install these dependencies.

---

**User**

consider only doing the plan and give sample codes for nodejs

---

**Cursor**

I'll create a comprehensive Node.js implementation for the file indexing system based on the diagram. Let me create the necessary files:


Let me create the files using a different approach:


Great! I can see that `chokidar` and `pg` are already installed. Now let me create the storage indexer implementation:

## Storage Indexer Implementation

Here's a complete Node.js implementation for the file indexing system based on your diagram:

### 1. Main Storage Indexer (`storageIndexer.js`)

```javascript
const fs = require('fs').promises;
const path = require('path');
const chokidar = require('chokidar');
const { Pool } = require('pg');

class StorageIndexer {
    constructor(config) {
        this.rootPath = config.rootPath || 'ISS_MEDIA';
        this.retentionDays = config.retentionDays || 7;
        this.dbPool = new Pool(config.database);
        this.watcher = null;
        this.isIndexing = false;
    }

    async initialize() {
        await this.createTables();
        await this.initialIndex();
        this.startWatching();
    }

    async createTables() {
        const createTableQuery = `
            CREATE TABLE IF NOT EXISTS video_files (
                id SERIAL PRIMARY KEY,
                file_path VARCHAR(500) UNIQUE NOT NULL,
                file_name VARCHAR(255) NOT NULL,
                camera_id VARCHAR(50) NOT NULL,
                recording_date DATE NOT NULL,
                recording_time TIME NOT NULL,
                file_size BIGINT NOT NULL,
                file_size_kb INTEGER NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE INDEX IF NOT EXISTS idx_camera_date ON video_files(camera_id, recording_date);
            CREATE INDEX IF NOT EXISTS idx_file_path ON video_files(file_path);
        `;
        
        await this.dbPool.query(createTableQuery);
        console.log('Database tables created/verified');
    }

    async initialIndex() {
        console.log('Starting initial index...');
        this.isIndexing = true;
        
        try {
            const cameras = await this.getCameraDirectories();
            
            for (const cameraId of cameras) {
                await this.indexCameraFiles(cameraId);
            }
            
            console.log('Initial indexing completed');
        } catch (error) {
            console.error('Error during initial indexing:', error);
        } finally {
            this.isIndexing = false;
        }
    }

    async getCameraDirectories() {
        try {
            const entries = await fs.readdir(this.rootPath, { withFileTypes: true });
            return entries
                .filter(entry => entry.isDirectory())
                .map(entry => entry.name);
        } catch (error) {
            console.error(`Error reading root directory ${this.rootPath}:`, error);
            return [];
        }
    }

    async indexCameraFiles(cameraId) {
        const cameraPath = path.join(this.rootPath, cameraId);
        
        try {
            const dateDirectories = await fs.readdir(cameraPath, { withFileTypes: true });
            
            for (const entry of dateDirectories) {
                if (!entry.isDirectory()) continue;
                
                const dateStr = entry.name;
                if (this.shouldIndexDate(dateStr)) {
                    await this.indexDateDirectory(cameraId, dateStr);
                }
            }
        } catch (error) {
            console.error(`Error indexing camera ${cameraId}:`, error);
        }
    }

    shouldIndexDate(dateStr) {
        try {
            const fileDate = new Date(dateStr);
            const now = new Date();
            const daysDiff = Math.floor((now - fileDate) / (1000 * 60 * 60 * 24));
            
            return daysDiff <= this.retentionDays;
        } catch (error) {
            console.warn(`Invalid date format: ${dateStr}`);
            return false;
        }
    }

    async indexDateDirectory(cameraId, dateStr) {
        const datePath = path.join(this.rootPath, cameraId, dateStr);
        
        try {
            const files = await fs.readdir(datePath);
            const issvdFiles = files.filter(file => file.endsWith('.issvd'));
            
            for (const fileName of issvdFiles) {
                await this.indexFile(cameraId, dateStr, fileName);
            }
        } catch (error) {
            console.error(`Error indexing date directory ${datePath}:`, error);
        }
    }

    async indexFile(cameraId, dateStr, fileName) {
        const filePath = path.join(this.rootPath, cameraId, dateStr, fileName);
        
        try {
            const stats = await fs.stat(filePath);
            const fileInfo = this.parseFileName(fileName);
            
            if (!fileInfo) {
                console.warn(`Invalid filename format: ${fileName}`);
                return;
            }

            const insertQuery = `
                INSERT INTO video_files 
                (file_path, file_name, camera_id, recording_date, recording_time, file_size, file_size_kb)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (file_path) 
                DO UPDATE SET 
                    updated_at = CURRENT_TIMESTAMP,
                    file_size = $6,
                    file_size_kb = $7
            `;
            
            await this.dbPool.query(insertQuery, [
                filePath,
                fileName,
                cameraId,
                dateStr,
                fileInfo.time,
                stats.size,
                Math.floor(stats.size / 1024)
            ]);
            
            console.log(`Indexed: ${fileName}`);
        } catch (error) {
            console.error(`Error indexing file ${filePath}:`, error);
        }
    }

    parseFileName(fileName) {
        // Expected format: min-sec-mills_CAMID.issvd
        // Example: 26-15-396_1.issvd
        const match = fileName.match(/^(\d+)-(\d+)-(\d+)_(\d+)\.issvd$/);
        
        if (!match) return null;
        
        const [, minutes, seconds, milliseconds, camId] = match;
        const timeStr = `${minutes.padStart(2, '0')}:${seconds.padStart(2, '0')}:${milliseconds.padStart(3, '0')}`;
        
        return {
            time: timeStr,
            cameraId: camId
        };
    }

    startWatching() {
        console.log('Starting file system watcher...');
        
        this.watcher = chokidar.watch(this.rootPath, {
            ignored: /(^|[\/\\])\../, // ignore dotfiles
            persistent: true,
            depth: 3, // Watch 3 levels deep
            awaitWriteFinish: {
                stabilityThreshold: 2000,
                pollInterval: 100
            }
        });

        this.watcher
            .on('add', (filePath) => this.handleFileAdded(filePath))
            .on('change', (filePath) => this.handleFileChanged(filePath))
            .on('unlink', (filePath) => this.handleFileRemoved(filePath))
            .on('addDir', (dirPath) => this.handleDirectoryAdded(dirPath))
            .on('unlinkDir', (dirPath) => this.handleDirectoryRemoved(dirPath))
            .on('error', (error) => console.error('Watcher error:', error));
    }

    async handleFileAdded(filePath) {
        if (!filePath.endsWith('.issvd')) return;
        
        const pathParts = filePath.split(path.sep);
        const fileName = pathParts[pathParts.length - 1];
        const dateStr = pathParts[pathParts.length - 2];
        const cameraId = pathParts[pathParts.length - 3];
        
        if (this.shouldIndexDate(dateStr)) {
            await this.indexFile(cameraId, dateStr, fileName);
        }
    }

    async handleFileChanged(filePath) {
        await this.handleFileAdded(filePath);
    }

    async handleFileRemoved(filePath) {
        const deleteQuery = 'DELETE FROM video_files WHERE file_path = $1';
        await this.dbPool.query(deleteQuery, [filePath]);
        console.log(`Removed from index: ${filePath}`);
    }

    async handleDirectoryAdded(dirPath) {
        // Re-index the new directory if it's a date directory
        const pathParts = dirPath.split(path.sep);
        if (pathParts.length >= 3) {
            const dateStr = pathParts[pathParts.length - 1];
            const cameraId = pathParts[pathParts.length - 2];
            
            if (this.shouldIndexDate(dateStr)) {
                await this.indexDateDirectory(cameraId, dateStr);
            }
        }
    }

    async handleDirectoryRemoved(dirPath) {
        // Remove all files from the database that were in this directory
        const deleteQuery = 'DELETE FROM video_files WHERE file_path LIKE $1';
        await this.dbPool.query(deleteQuery, [`${dirPath}%`]);
        console.log(`Removed directory from index: ${dirPath}`);
    }

    async cleanup() {
        if (this.watcher) {
            await this.watcher.close();
        }
        await this.dbPool.end();
    }

    // Utility methods for querying the index
    async getFilesByCamera(cameraId, date = null) {
        let query = 'SELECT * FROM video_files WHERE camera_id = $1';
        let params = [cameraId];
        
        if (date) {
            query += ' AND recording_date = $2';
            params.push(date);
        }
        
        query += ' ORDER BY recording_date DESC, recording_time DESC';
        
        const result = await this.dbPool.query(query, params);
        return result.rows;
    }

    async getFilesByDate(date) {
        const query = `
            SELECT * FROM video_files 
            WHERE recording_date = $1 
            ORDER BY camera_id, recording_time
        `;
        const result = await this.dbPool.query(query, [date]);
        return result.rows;
    }

    async getIndexStats() {
        const query = `
            SELECT 
                COUNT(*) as total_files,
                COUNT(DISTINCT camera_id) as total_cameras,
                COUNT(DISTINCT recording_date) as total_dates,
                SUM(file_size_kb) as total_size_kb
            FROM video_files
        `;
        const result = await this.dbPool.query(query);
        return result.rows[0];
    }
}

module.exports = StorageIndexer;
```

### 2. Configuration File (`storageIndexerConfig.js`)

```javascript
module.exports = {
    rootPath: 'ISS_MEDIA', // Root directory to monitor
    retentionDays: 7,      // Number of days to keep in index
    
    database: {
        host: 'localhost',
        port: 5432,
        database: 'video_storage',
        user: 'your_username',
        password: 'your_password',
        max: 20, // Maximum number of clients in the pool
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
    }
};
```

### 3. Main Application (`index.js`)

```javascript
const StorageIndexer = require('./storageIndexer');
const config = require('./storageIndexerConfig');

async function main() {
    const indexer = new StorageIndexer(config);
    
    try {
        await indexer.initialize();
        console.log('Storage indexer started successfully');
        
        // Keep the process running
        process.on('SIGINT', async () => {
            console.log('Shutting down...');
            await indexer.cleanup();
            process.exit(0);
        });
        
    } catch (error) {
        console.error('Failed to start storage indexer:', error);
        process.exit(1);
    }
}

main();
```

### 4. API Routes for Querying (`storageIndexerRoutes.js`)

```javascript
const express = require('express');
const router = express.Router();
const StorageIndexer = require('./storageIndexer');
const config = require('./storageIndexerConfig');

const indexer = new StorageIndexer(config);

// Get files by camera
router.get('/files/camera/:cameraId', async (req, res) => {
    try {
        const { cameraId } = req.params;
        const { date } = req.query;
        
        const files = await indexer.getFilesByCamera(cameraId, date);
        res.json({ success: true, data: files });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get files by date
router.get('/files/date/:date', async (req, res) => {
    try {
        const { date } = req.params;
        const files = await indexer.getFilesByDate(date);
        res.json({ success: true, data: files });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get index statistics
router.get('/stats', async (req, res) => {
    try {
        const stats = await indexer.getIndexStats();
        res.json({ success: true, data: stats });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Trigger manual re-index
router.post('/reindex', async (req, res) => {
    try {
        await indexer.initialIndex();
        res.json({ success: true, message: 'Re-indexing completed' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
```

### 5. Usage Example

```javascript
// Start the indexer
const indexer = new StorageIndexer({
    rootPath: 'ISS_MEDIA',
    retentionDays: 7,
    database: {
        host: 'localhost',
        database: 'video_storage',
        user: 'postgres',
        password: 'password'
    }
});

await indexer.initialize();

// Query indexed files
const cameraFiles = await indexer.getFilesByCamera('1', '2025-06-23');
const dateFiles = await indexer.getFilesByDate('2025-06-23');
const stats = await indexer.getIndexStats();
```

This implementation:

1. **Scans directories recursively** following the ISS_MEDIA → CAM_ID → DATE structure
2. **Applies retention policy** (7 days by default) to only index recent files
3. **Parses ISSVD filenames** in the format `min-sec-mills_CAMID.issvd`
4. **Stores metadata in PostgreSQL** with proper indexing
5. **Monitors file system changes** in real-time using chokidar
6. **Provides API endpoints** for querying the indexed data
7. **Handles file additions, changes, and deletions** automatically

The system efficiently monitors directory changes and maintains an up-to-date index of all video files according to your retention policy.

```javascript
const fs = require('fs').promises;
const path = require('path');
const chokidar = require('chokidar');
const { Pool } = require('pg');

class StorageIndexer {
    constructor(config) {
        this.rootPath = config.rootPath || 'ISS_MEDIA';
        this.retentionDays = config.retentionDays || 7;
        this.dbPool = new Pool(config.database);
        this.watcher = null;
        this.isIndexing = false;
    }

    async initialize() {
        await this.createTables();
        await this.initialIndex();
        this.startWatching();
    }

    async createTables() {
        const createTableQuery = `
            CREATE TABLE IF NOT EXISTS video_files (
                id SERIAL PRIMARY KEY,
                file_path VARCHAR(500) UNIQUE NOT NULL,
                file_name VARCHAR(255) NOT NULL,
                camera_id VARCHAR(50) NOT NULL,
                recording_date DATE NOT NULL,
                recording_time TIME NOT NULL,
                file_size BIGINT NOT NULL,
                file_size_kb INTEGER NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE INDEX IF NOT EXISTS idx_camera_date ON video_files(camera_id, recording_date);
            CREATE INDEX IF NOT EXISTS idx_file_path ON video_files(file_path);
        `;
        
        await this.dbPool.query(createTableQuery);
        console.log('Database tables created/verified');
    }

    async initialIndex() {
        console.log('Starting initial index...');
        this.isIndexing = true;
        
        try {
            const cameras = await this.getCameraDirectories();
            
            for (const cameraId of cameras) {
                await this.indexCameraFiles(cameraId);
            }
            
            console.log('Initial indexing completed');
        } catch (error) {
            console.error('Error during initial indexing:', error);
        } finally {
            this.isIndexing = false;
        }
    }

    async getCameraDirectories() {
        try {
            const entries = await fs.readdir(this.rootPath, { withFileTypes: true });
            return entries
                .filter(entry => entry.isDirectory())
                .map(entry => entry.name);
        } catch (error) {
            console.error(`Error reading root directory ${this.rootPath}:`, error);
            return [];
        }
    }

    async indexCameraFiles(cameraId) {
        const cameraPath = path.join(this.rootPath, cameraId);
        
        try {
            const dateDirectories = await fs.readdir(cameraPath, { withFileTypes: true });
            
            for (const entry of dateDirectories) {
                if (!entry.isDirectory()) continue;
                
                const dateStr = entry.name;
                if (this.shouldIndexDate(dateStr)) {
                    await this.indexDateDirectory(cameraId, dateStr);
                }
            }
        } catch (error) {
            console.error(`Error indexing camera ${cameraId}:`, error);
        }
    }

    shouldIndexDate(dateStr) {
        try {
            const fileDate = new Date(dateStr);
            const now = new Date();
            const daysDiff = Math.floor((now - fileDate) / (1000 * 60 * 60 * 24));
            
            return daysDiff <= this.retentionDays;
        } catch (error) {
            console.warn(`Invalid date format: ${dateStr}`);
            return false;
        }
    }

    async indexDateDirectory(cameraId, dateStr) {
        const datePath = path.join(this.rootPath, cameraId, dateStr);
        
        try {
            const files = await fs.readdir(datePath);
            const issvdFiles = files.filter(file => file.endsWith('.issvd'));
            
            for (const fileName of issvdFiles) {
                await this.indexFile(cameraId, dateStr, fileName);
            }
        } catch (error) {
            console.error(`Error indexing date directory ${datePath}:`, error);
        }
    }

    async indexFile(cameraId, dateStr, fileName) {
        const filePath = path.join(this.rootPath, cameraId, dateStr, fileName);
        
        try {
            const stats = await fs.stat(filePath);
            const fileInfo = this.parseFileName(fileName);
            
            if (!fileInfo) {
                console.warn(`Invalid filename format: ${fileName}`);
                return;
            }

            const insertQuery = `
                INSERT INTO video_files 
                (file_path, file_name, camera_id, recording_date, recording_time, file_size, file_size_kb)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (file_path) 
                DO UPDATE SET 
                    updated_at = CURRENT_TIMESTAMP,
                    file_size = $6,
                    file_size_kb = $7
            `;
            
            await this.dbPool.query(insertQuery, [
                filePath,
                fileName,
                cameraId,
                dateStr,
                fileInfo.time,
                stats.size,
                Math.floor(stats.size / 1024)
            ]);
            
            console.log(`Indexed: ${fileName}`);
        } catch (error) {
            console.error(`Error indexing file ${filePath}:`, error);
        }
    }

    parseFileName(fileName) {
        // Expected format: min-sec-mills_CAMID.issvd
        // Example: 26-15-396_1.issvd
        const match = fileName.match(/^(\d+)-(\d+)-(\d+)_(\d+)\.issvd$/);
        
        if (!match) return null;
        
        const [, minutes, seconds, milliseconds, camId] = match;
        const timeStr = `${minutes.padStart(2, '0')}:${seconds.padStart(2, '0')}:${milliseconds.padStart(3, '0')}`;
        
        return {
            time: timeStr,
            cameraId: camId
        };
    }

    startWatching() {
        console.log('Starting file system watcher...');
        
        this.watcher = chokidar.watch(this.rootPath, {
            ignored: /(^|[\/\\])\../, // ignore dotfiles
            persistent: true,
            depth: 3, // Watch 3 levels deep
            awaitWriteFinish: {
                stabilityThreshold: 2000,
                pollInterval: 100
            }
        });

        this.watcher
            .on('add', (filePath) => this.handleFileAdded(filePath))
            .on('change', (filePath) => this.handleFileChanged(filePath))
            .on('unlink', (filePath) => this.handleFileRemoved(filePath))
            .on('addDir', (dirPath) => this.handleDirectoryAdded(dirPath))
            .on('unlinkDir', (dirPath) => this.handleDirectoryRemoved(dirPath))
            .on('error', (error) => console.error('Watcher error:', error));
    }

    async handleFileAdded(filePath) {
        if (!filePath.endsWith('.issvd')) return;
        
        const pathParts = filePath.split(path.sep);
        const fileName = pathParts[pathParts.length - 1];
        const dateStr = pathParts[pathParts.length - 2];
        const cameraId = pathParts[pathParts.length - 3];
        
        if (this.shouldIndexDate(dateStr)) {
            await this.indexFile(cameraId, dateStr, fileName);
        }
    }

    async handleFileChanged(filePath) {
        await this.handleFileAdded(filePath);
    }

    async handleFileRemoved(filePath) {
        const deleteQuery = 'DELETE FROM video_files WHERE file_path = $1';
        await this.dbPool.query(deleteQuery, [filePath]);
        console.log(`Removed from index: ${filePath}`);
    }

    async handleDirectoryAdded(dirPath) {
        // Re-index the new directory if it's a date directory
        const pathParts = dirPath.split(path.sep);
        if (pathParts.length >= 3) {
            const dateStr = pathParts[pathParts.length - 1];
            const cameraId = pathParts[pathParts.length - 2];
            
            if (this.shouldIndexDate(dateStr)) {
                await this.indexDateDirectory(cameraId, dateStr);
            }
        }
    }

    async handleDirectoryRemoved(dirPath) {
        // Remove all files from the database that were in this directory
        const deleteQuery = 'DELETE FROM video_files WHERE file_path LIKE $1';
        await this.dbPool.query(deleteQuery, [`${dirPath}%`]);
        console.log(`Removed directory from index: ${dirPath}`);
    }

    async cleanup() {
        if (this.watcher) {
            await this.watcher.close();
        }
        await this.dbPool.end();
    }

    // Utility methods for querying the index
    async getFilesByCamera(cameraId, date = null) {
        let query = 'SELECT * FROM video_files WHERE camera_id = $1';
        let params = [cameraId];
        
        if (date) {
            query += ' AND recording_date = $2';
            params.push(date);
        }
        
        query += ' ORDER BY recording_date DESC, recording_time DESC';
        
        const result = await this.dbPool.query(query, params);
        return result.rows;
    }

    async getFilesByDate(date) {
        const query = `
            SELECT * FROM video_files 
            WHERE recording_date = $1 
            ORDER BY camera_id, recording_time
        `;
        const result = await this.dbPool.query(query, [date]);
        return result.rows;
    }

    async getIndexStats() {
        const query = `
            SELECT 
                COUNT(*) as total_files,
                COUNT(DISTINCT camera_id) as total_cameras,
                COUNT(DISTINCT recording_date) as total_dates,
                SUM(file_size_kb) as total_size_kb
            FROM video_files
        `;
        const result = await this.dbPool.query(query);
        return result.rows[0];
    }
}

module.exports = StorageIndexer;
```

```javascript
module.exports = {
    rootPath: 'ISS_MEDIA', // Root directory to monitor
    retentionDays: 7,      // Number of days to keep in index
    
    database: {
        host: 'localhost',
        port: 5432,
        database: 'video_storage',
        user: 'your_username',
        password: 'your_password',
        max: 20, // Maximum number of clients in the pool
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
    }
};
```

```javascript
const StorageIndexer = require('./storageIndexer');
const config = require('./storageIndexerConfig');

async function main() {
    const indexer = new StorageIndexer(config);
    
    try {
        await indexer.initialize();
        console.log('Storage indexer started successfully');
        
        // Keep the process running
        process.on('SIGINT', async () => {
            console.log('Shutting down...');
            await indexer.cleanup();
            process.exit(0);
        });
        
    } catch (error) {
        console.error('Failed to start storage indexer:', error);
        process.exit(1);
    }
}

main();
```

```javascript
const express = require('express');
const router = express.Router();
const StorageIndexer = require('./storageIndexer');
const config = require('./storageIndexerConfig');

const indexer = new StorageIndexer(config);

// Get files by camera
router.get('/files/camera/:cameraId', async (req, res) => {
    try {
        const { cameraId } = req.params;
        const { date } = req.query;
        
        const files = await indexer.getFilesByCamera(cameraId, date);
        res.json({ success: true, data: files });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get files by date
router.get('/files/date/:date', async (req, res) => {
    try {
        const { date } = req.params;
        const files = await indexer.getFilesByDate(date);
        res.json({ success: true, data: files });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get index statistics
router.get('/stats', async (req, res) => {
    try {
        const stats = await indexer.getIndexStats();
        res.json({ success: true, data: stats });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Trigger manual re-index
router.post('/reindex', async (req, res) => {
    try {
        await indexer.initialIndex();
        res.json({ success: true, message: 'Re-indexing completed' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
```

```javascript
// Start the indexer
const indexer = new StorageIndexer({
    rootPath: 'ISS_MEDIA',
    retentionDays: 7,
    database: {
        host: 'localhost',
        database: 'video_storage',
        user: 'postgres',
        password: 'password'
    }
});

await indexer.initialize();

// Query indexed files
const cameraFiles = await indexer.getFilesByCamera('1', '2025-06-23');
const dateFiles = await indexer.getFilesByDate('2025-06-23');
const stats = await indexer.getIndexStats();
```

