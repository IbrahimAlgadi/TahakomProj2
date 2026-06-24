const { Client } = require('pg');

const CREATE_DB = true;
const DROP_SCHEMA = true;  // Set to true to drop all tables before recreating

class AppDatabase {
  DB_USER = "postgres";
  DB_PASSWORD = "postgres";
  DB_HOST = "localhost";
  DB_POSTGRES = "postgres";
  DB_APP = "tahakom_transfer";

  constructor() { }

  // Function to create database
  async createDatabase() {
    const client = new Client({
      user: this.DB_USER,
      host: this.DB_HOST,
      database: this.DB_POSTGRES, // Connect to default database
      password: this.DB_PASSWORD,
      port: 5432,
    });

    try {
      await client.connect();

      // Create the new database
      await client.query(`CREATE DATABASE ${this.DB_APP};`);
      console.log('Database created.');

    } catch (err) {

      console.error('Error creating database:', err);
    } finally {
      await client.end();
    }
  }

  // Function to grant privileges
  async grantPrivileges() {
    const client = new Client({
      user: this.DB_USER,
      host: this.DB_HOST,
      database: this.DB_APP, // Connect to the new database
      password: this.DB_PASSWORD,
      port: 5432,
    });

    try {
      await client.connect();

      // Grant privileges
      await client.query(`
        GRANT ALL PRIVILEGES ON DATABASE ${this.DB_APP} TO postgres;
        GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO postgres;
        GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO postgres;
        GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO postgres;
      `);
      console.log('   ✅ All privileges granted successfully');

    } catch (err) {
      console.error('❌ Error granting privileges:', err);
      throw err;
    } finally {
      await client.end();
    }
  }

  // Function to grant privileges
  async createTables() {
    const client = new Client({
      user: this.DB_USER,
      host: this.DB_HOST,
      database: this.DB_APP, // Connect to the new database
      password: this.DB_PASSWORD,
      port: 5432,
    });

    try {
      await client.connect();

      // Grant privileges
      await client.query(`

CREATE TABLE IF NOT EXISTS files (
    id SERIAL PRIMARY KEY,
    tid TEXT,
    file_path TEXT UNIQUE,
    file_size INTEGER,
    file_name TEXT,
    site_id TEXT,
    date_folder TEXT,
    time_folder TEXT,
    plate_num VARCHAR(255),
    cam_id INTEGER,
    deleted BOOLEAN DEFAULT FALSE,
    is_auto_transferred BOOLEAN DEFAULT FALSE,
    is_ftp_transferred BOOLEAN DEFAULT FALSE,
    image_export_done_date_time TIMESTAMP DEFAULT NULL,
    export_retry_count INTEGER DEFAULT 0,
    export_retry_log_object JSONB DEFAULT '[]',
    deleted_date_time TIMESTAMP DEFAULT NULL,
    export_params JSONB DEFAULT NULL,
    date DATE,
    time TIME
);

CREATE TABLE IF NOT EXISTS device_connections (
    id SERIAL PRIMARY KEY,
    drive_letter VARCHAR(2) NOT NULL,
    label TEXT,
    total_space DECIMAL(10,2),
    used_space DECIMAL(10,2),
    remaining_space DECIMAL(10,2),
    used_percentage DECIMAL(5,2),
    filesystem_type TEXT,
    is_read_write BOOLEAN,
    connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    disconnected_at TIMESTAMP DEFAULT NULL,
    status TEXT DEFAULT 'connected',
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transfer_job (
    id SERIAL PRIMARY KEY,
    start_date DATE,
    start_time TIME,
    end_date DATE,
    end_time TIME,
    car_plate TEXT,
    usb_path TEXT,
    status TEXT,
    date DATE,
    time TIME
);

CREATE TABLE IF NOT EXISTS transfer_job_log (
    id SERIAL PRIMARY KEY,
    file_id INT NOT NULL,
    transfer_job_id INT NOT NULL,
    transferred BOOLEAN DEFAULT false,
    CONSTRAINT fk_file
      FOREIGN KEY(file_id) 
      REFERENCES files(id),
    CONSTRAINT fk_transfer_job
      FOREIGN KEY(transfer_job_id) 
      REFERENCES transfer_job(id)
);

CREATE TABLE IF NOT EXISTS auto_transfer_device (
    id SERIAL PRIMARY KEY,
    usb_path TEXT NOT NULL,
    status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auto_transfer_job (
    id SERIAL PRIMARY KEY,
    auto_transfer_device_id INT,
    date DATE,
    time TIME,
    status TEXT,
    size_transferred INTEGER, 
    CONSTRAINT fk_auto_transfer_device
      FOREIGN KEY(auto_transfer_device_id) 
      REFERENCES auto_transfer_device(id)
);

-- Add these columns to device_connections table
ALTER TABLE device_connections 
ADD COLUMN IF NOT EXISTS current_uptime_minutes INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_uptime_minutes INTEGER DEFAULT 0;

-- Create an index for better performance on uptime queries
CREATE INDEX IF NOT EXISTS idx_device_connections_status_connected 
ON device_connections(status) WHERE status = 'connected';


-- Improve performance of files
ALTER TABLE public.files 
ADD COLUMN IF NOT EXISTS ts timestamp GENERATED ALWAYS AS ("date" + "time") STORED;

-- Covering partial indexes for dashboard aggregation queries.
-- On a fresh migration the table is empty so regular (non-CONCURRENT) creation is used here.
-- On a live production DB with existing data run these two statements manually with CONCURRENTLY
-- outside of any transaction block instead of re-running the full migration script.
CREATE INDEX IF NOT EXISTS idx_files_dashboard_date
  ON public.files (date)
  INCLUDE (cam_id, plate_num, file_size, image_export_done_date_time, time)
  WHERE deleted = false;

-- Supplemental index for the daily "Per Camera" path (filters + groups on cam_id AND date).
CREATE INDEX IF NOT EXISTS idx_files_dashboard_cam_date
  ON public.files (cam_id, date)
  INCLUDE (plate_num, file_size, image_export_done_date_time)
  WHERE deleted = false;


-- Create a function to get uptime in a readable format
CREATE OR REPLACE FUNCTION get_readable_uptime(minutes INTEGER)
RETURNS TEXT AS $$
BEGIN
    IF minutes IS NULL OR minutes = 0 THEN
        RETURN '0 minutes';
    END IF;
    
    IF minutes < 60 THEN
        RETURN minutes || ' minutes';
    ELSIF minutes < 1440 THEN
        RETURN (minutes / 60) || 'h ' || (minutes % 60) || 'm';
    ELSE
        RETURN (minutes / 1440) || 'd ' || ((minutes % 1440) / 60) || 'h ' || (minutes % 60) || 'm';
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Transfer Queue Job Table for managing transfer jobs
CREATE TABLE IF NOT EXISTS transfer_queue_job (
    id SERIAL PRIMARY KEY,
    batch_id UUID NOT NULL UNIQUE,
    batch_origin VARCHAR(20) NOT NULL CHECK (batch_origin IN ('auto', 'manual')),
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'transferring', 'paused', 'transferred', 'failed')),
    total_files INT DEFAULT 0,
    total_size BIGINT DEFAULT 0,
    transferred_files INT DEFAULT 0,
    transferred_size BIGINT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    error_message TEXT
);

-- Transfer Queue Table for better transfer management
CREATE TABLE IF NOT EXISTS transfer_queue (
    id SERIAL PRIMARY KEY,
    file_id INT NOT NULL,
    file_path TEXT NOT NULL,
    file_size BIGINT NOT NULL,
    destination_path TEXT NOT NULL DEFAULT '',
    usb_path TEXT NOT NULL DEFAULT '',
    file_type VARCHAR(20) NOT NULL CHECK (file_type IN ('image')),
    file_origin VARCHAR(20) NOT NULL CHECK (file_origin IN ('auto', 'manual')),
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'transferred', 'failed')),
    job_id INT NOT NULL,
    retry_count INT DEFAULT 0,
    max_retries INT DEFAULT 3,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    transferred_at TIMESTAMP,
    
    -- Foreign key to existing files table
    CONSTRAINT fk_transfer_queue_file
        FOREIGN KEY(file_id) 
        REFERENCES files(id) ON DELETE CASCADE,
    
    -- Foreign key to transfer queue job
    CONSTRAINT fk_transfer_queue_job
        FOREIGN KEY(job_id) 
        REFERENCES transfer_queue_job(id) ON DELETE CASCADE
);

-- Indexes for better performance on transfer_queue_job
CREATE INDEX IF NOT EXISTS idx_transfer_queue_job_status ON transfer_queue_job(status);
CREATE INDEX IF NOT EXISTS idx_transfer_queue_job_batch_origin ON transfer_queue_job(batch_origin);
CREATE INDEX IF NOT EXISTS idx_transfer_queue_job_created_at ON transfer_queue_job(created_at);

-- Indexes for better performance on transfer_queue
CREATE INDEX IF NOT EXISTS idx_transfer_queue_status ON transfer_queue(status);
CREATE INDEX IF NOT EXISTS idx_transfer_queue_job_id ON transfer_queue(job_id);
CREATE INDEX IF NOT EXISTS idx_transfer_queue_file_origin ON transfer_queue(file_origin);
CREATE INDEX IF NOT EXISTS idx_transfer_queue_created_at ON transfer_queue(created_at);

-- Function to update updated_at timestamp for transfer_queue
CREATE OR REPLACE FUNCTION update_transfer_queue_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Function to update updated_at timestamp for transfer_queue_job
CREATE OR REPLACE FUNCTION update_transfer_queue_job_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers to automatically update updated_at
CREATE TRIGGER trigger_transfer_queue_updated_at
    BEFORE UPDATE ON transfer_queue
    FOR EACH ROW
    EXECUTE FUNCTION update_transfer_queue_updated_at();

CREATE TRIGGER trigger_transfer_queue_job_updated_at
    BEFORE UPDATE ON transfer_queue_job
    FOR EACH ROW
    EXECUTE FUNCTION update_transfer_queue_job_updated_at();

-- ISS Media Files Table for video file indexing
CREATE TABLE IF NOT EXISTS iss_media_files (
    id SERIAL PRIMARY KEY,
    file_path TEXT UNIQUE NOT NULL,
    file_name TEXT NOT NULL,
    file_size BIGINT NOT NULL,
    camera_id INTEGER NOT NULL,
    site_id TEXT,
    recording_date DATE NOT NULL,
    recording_time TIME NOT NULL,
    timezone_offset TEXT,
    precise_time TIME NOT NULL,
    is_auto_transferred BOOLEAN DEFAULT FALSE,
    is_ftp_transferred BOOLEAN DEFAULT FALSE,
    deleted BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


-- Video Transfer Service Database Migrations
-- Required table updates and new indices for the consolidated service

-- Ensure video_transfer_queue_job table exists FIRST (referenced by other tables)
CREATE TABLE IF NOT EXISTS video_transfer_queue_job (
    id SERIAL PRIMARY KEY,
    batch_id TEXT UNIQUE NOT NULL,
    batch_origin TEXT DEFAULT 'auto_video',
    status TEXT DEFAULT 'created',
    expected_cameras TEXT[],
    processed_cameras TEXT[] DEFAULT '{}',
    current_camera_id INTEGER,
    total_videos INTEGER DEFAULT 0,
    total_size BIGINT DEFAULT 0,
    transferred_videos INTEGER DEFAULT 0,
    transferred_size BIGINT DEFAULT 0,
    interval_duration_minutes INTEGER DEFAULT 5,
    site_id TEXT,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP,
    completed_at TIMESTAMP
);

-- Ensure video_converted_buffer table exists with proper structure
CREATE TABLE IF NOT EXISTS video_converted_buffer (
    id SERIAL PRIMARY KEY,
    source_file_id INTEGER NOT NULL,
    converted_file_path TEXT,
    converted_file_name TEXT,
    converted_file_size BIGINT DEFAULT 0,
    camera_id INTEGER NOT NULL,
    site_id TEXT,
    recording_date DATE,
    recording_time TIME,
    precise_time TEXT,
    timezone_offset INTEGER,
    group_key TEXT,
    job_id INTEGER NOT NULL,
    group_interval_start INTEGER,
    group_interval_end INTEGER,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Foreign key to iss_media_files
    CONSTRAINT fk_video_converted_buffer_source
        FOREIGN KEY(source_file_id) 
        REFERENCES iss_media_files(id) ON DELETE CASCADE,
    
    -- Foreign key to video_transfer_queue_job
    CONSTRAINT fk_video_converted_buffer_job
        FOREIGN KEY(job_id) 
        REFERENCES video_transfer_queue_job(id) ON DELETE CASCADE
);

-- Ensure video_transfer_queue table exists with proper structure
CREATE TABLE IF NOT EXISTS video_transfer_queue (
    id SERIAL PRIMARY KEY,
    video_file_path TEXT NOT NULL,
    video_file_name TEXT NOT NULL,
    video_file_size BIGINT NOT NULL,
    camera_id INTEGER NOT NULL,
    site_id TEXT,
    recording_date DATE,
    interval_start_minutes INTEGER,
    interval_end_minutes INTEGER,
    source_files_count INTEGER DEFAULT 0,
    source_files_size BIGINT DEFAULT 0,
    source_file_ids INTEGER[],
    status TEXT DEFAULT 'pending',
    job_id INTEGER REFERENCES video_transfer_queue_job(id),
    transfer_progress INTEGER DEFAULT 0,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    destination_path TEXT,
    usb_path TEXT,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    transferred_at TIMESTAMP
);

-- Add unique constraint for job_id and camera_id combination in video_transfer_queue
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name = 'uk_video_transfer_queue_job_camera' 
        AND table_name = 'video_transfer_queue'
    ) THEN
        ALTER TABLE video_transfer_queue 
        ADD CONSTRAINT uk_video_transfer_queue_job_camera 
        UNIQUE (job_id, camera_id);
    END IF;
END $$;

-- Add unique constraint for camera_id, source_file_id, and job_id combination in video_converted_buffer
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name = 'uk_video_converted_buffer_camera_source_job' 
        AND table_name = 'video_converted_buffer'
    ) THEN
        ALTER TABLE video_converted_buffer 
        ADD CONSTRAINT uk_video_converted_buffer_camera_source_job 
        UNIQUE (camera_id, source_file_id, job_id);
    END IF;
END $$;

-- Add indices for better performance
CREATE INDEX IF NOT EXISTS idx_video_converted_buffer_camera_status ON video_converted_buffer(camera_id, status);
CREATE INDEX IF NOT EXISTS idx_video_converted_buffer_group_key ON video_converted_buffer(group_key);
CREATE INDEX IF NOT EXISTS idx_video_converted_buffer_source_file_id ON video_converted_buffer(source_file_id);
CREATE INDEX IF NOT EXISTS idx_video_converted_buffer_job_id ON video_converted_buffer(job_id);
CREATE INDEX IF NOT EXISTS idx_video_converted_buffer_job_camera ON video_converted_buffer(job_id, camera_id);
CREATE INDEX IF NOT EXISTS idx_video_converted_buffer_job_status ON video_converted_buffer(job_id, status);

CREATE INDEX IF NOT EXISTS idx_video_transfer_queue_job_status ON video_transfer_queue_job(status);
CREATE INDEX IF NOT EXISTS idx_video_transfer_queue_job_batch_origin ON video_transfer_queue_job(batch_origin);

CREATE INDEX IF NOT EXISTS idx_video_transfer_queue_status ON video_transfer_queue(status);
CREATE INDEX IF NOT EXISTS idx_video_transfer_queue_job_id ON video_transfer_queue(job_id);
CREATE INDEX IF NOT EXISTS idx_video_transfer_queue_camera_id ON video_transfer_queue(camera_id);

-- Add indices on iss_media_files if they don't exist
CREATE INDEX IF NOT EXISTS idx_iss_media_files_auto_transferred ON iss_media_files(is_auto_transferred) WHERE is_auto_transferred = false;
CREATE INDEX IF NOT EXISTS idx_iss_media_files_camera_date ON iss_media_files(camera_id, recording_date);
CREATE INDEX IF NOT EXISTS idx_iss_media_files_deleted ON iss_media_files(deleted) WHERE deleted = false;

-- Add updated_at trigger for video_converted_buffer
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_video_converted_buffer_updated_at ON video_converted_buffer;
CREATE TRIGGER update_video_converted_buffer_updated_at 
    BEFORE UPDATE ON video_converted_buffer 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_video_transfer_queue_job_updated_at ON video_transfer_queue_job;
CREATE TRIGGER update_video_transfer_queue_job_updated_at 
    BEFORE UPDATE ON video_transfer_queue_job 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_video_transfer_queue_updated_at ON video_transfer_queue;
CREATE TRIGGER update_video_transfer_queue_updated_at 
    BEFORE UPDATE ON video_transfer_queue 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- FTP Transfer Service Database Tables
-- Separate tables for FTP transfers to keep USB and FTP logic independent

-- FTP Image Transfer Queue Job Table
CREATE TABLE IF NOT EXISTS ftp_image_transfer_queue_job (
    id SERIAL PRIMARY KEY,
    batch_id TEXT UNIQUE NOT NULL,
    batch_origin TEXT DEFAULT 'auto_ftp',
    status TEXT DEFAULT 'created',
    total_files INTEGER DEFAULT 0,
    total_size BIGINT DEFAULT 0,
    transferred_files INTEGER DEFAULT 0,
    transferred_size BIGINT DEFAULT 0,
    ftp_server_config JSONB,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP,
    completed_at TIMESTAMP
);

-- FTP Image Transfer Queue Table
CREATE TABLE IF NOT EXISTS ftp_image_transfer_queue (
    id SERIAL PRIMARY KEY,
    file_id INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    file_size BIGINT NOT NULL,
    file_type VARCHAR(20) NOT NULL CHECK (file_type IN ('image')),
    file_origin VARCHAR(20) NOT NULL CHECK (file_origin IN ('auto', 'manual')),
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'transferred', 'failed')),
    job_id INTEGER NOT NULL,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    
    -- FTP-specific fields
    ftp_remote_path TEXT,
    ftp_server_host TEXT,
    ftp_upload_time TIMESTAMP,
    
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    transferred_at TIMESTAMP,
    
    -- Foreign key to existing files table
    CONSTRAINT fk_ftp_image_transfer_queue_file
        FOREIGN KEY(file_id) 
        REFERENCES files(id) ON DELETE CASCADE,
    
    -- Foreign key to FTP image transfer job
    CONSTRAINT fk_ftp_image_transfer_queue_job
        FOREIGN KEY(job_id) 
        REFERENCES ftp_image_transfer_queue_job(id) ON DELETE CASCADE
);

-- FTP Video Transfer Service Database Tables

-- FTP Video Transfer Queue Job Table
CREATE TABLE IF NOT EXISTS ftp_video_transfer_queue_job (
    id SERIAL PRIMARY KEY,
    batch_id TEXT UNIQUE NOT NULL,
    batch_origin TEXT DEFAULT 'auto_ftp_video',
    status TEXT DEFAULT 'created',
    expected_cameras TEXT[],
    processed_cameras TEXT[] DEFAULT '{}',
    current_camera_id INTEGER,
    total_videos INTEGER DEFAULT 0,
    total_size BIGINT DEFAULT 0,
    transferred_videos INTEGER DEFAULT 0,
    transferred_size BIGINT DEFAULT 0,
    interval_duration_minutes INTEGER DEFAULT 5,
    site_id TEXT,
    ftp_server_config JSONB,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP,
    completed_at TIMESTAMP
);

-- FTP Video Converted Buffer Table (similar to video_converted_buffer but for FTP)
CREATE TABLE IF NOT EXISTS ftp_video_converted_buffer (
    id SERIAL PRIMARY KEY,
    source_file_id INTEGER NOT NULL,
    converted_file_path TEXT,
    converted_file_name TEXT,
    converted_file_size BIGINT DEFAULT 0,
    camera_id INTEGER NOT NULL,
    site_id TEXT,
    recording_date DATE,
    recording_time TIME,
    precise_time TEXT,
    timezone_offset INTEGER,
    group_key TEXT,
    job_id INTEGER NOT NULL,
    group_interval_start INTEGER,
    group_interval_end INTEGER,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Foreign key to iss_media_files
    CONSTRAINT fk_ftp_video_converted_buffer_source
        FOREIGN KEY(source_file_id) 
        REFERENCES iss_media_files(id) ON DELETE CASCADE,
    
    -- Foreign key to ftp_video_transfer_queue_job
    CONSTRAINT fk_ftp_video_converted_buffer_job
        FOREIGN KEY(job_id) 
        REFERENCES ftp_video_transfer_queue_job(id) ON DELETE CASCADE
);

-- FTP Video Transfer Queue Table
CREATE TABLE IF NOT EXISTS ftp_video_transfer_queue (
    id SERIAL PRIMARY KEY,
    video_file_path TEXT NOT NULL,
    video_file_name TEXT NOT NULL,
    video_file_size BIGINT NOT NULL,
    camera_id INTEGER NOT NULL,
    site_id TEXT,
    recording_date DATE,
    interval_start_minutes INTEGER,
    interval_end_minutes INTEGER,
    source_files_count INTEGER DEFAULT 0,
    source_files_size BIGINT DEFAULT 0,
    source_file_ids INTEGER[],
    status TEXT DEFAULT 'pending',
    job_id INTEGER REFERENCES ftp_video_transfer_queue_job(id),
    transfer_progress INTEGER DEFAULT 0,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    
    -- FTP-specific fields
    ftp_remote_path TEXT,
    ftp_server_host TEXT,
    ftp_upload_time TIMESTAMP,
    
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    transferred_at TIMESTAMP
);

-- Add unique constraint for job_id and camera_id combination in ftp_video_transfer_queue
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name = 'uk_ftp_video_transfer_queue_job_camera' 
        AND table_name = 'ftp_video_transfer_queue'
    ) THEN
        ALTER TABLE ftp_video_transfer_queue 
        ADD CONSTRAINT uk_ftp_video_transfer_queue_job_camera 
        UNIQUE (job_id, camera_id);
    END IF;
END $$;

-- Add unique constraint for camera_id, source_file_id, and job_id combination in ftp_video_converted_buffer
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name = 'uk_ftp_video_converted_buffer_camera_source_job' 
        AND table_name = 'ftp_video_converted_buffer'
    ) THEN
        ALTER TABLE ftp_video_converted_buffer 
        ADD CONSTRAINT uk_ftp_video_converted_buffer_camera_source_job 
        UNIQUE (camera_id, source_file_id, job_id);
    END IF;
END $$;

-- Add indices for better performance on FTP image tables
CREATE INDEX IF NOT EXISTS idx_ftp_image_transfer_queue_job_status ON ftp_image_transfer_queue_job(status);
CREATE INDEX IF NOT EXISTS idx_ftp_image_transfer_queue_job_batch_origin ON ftp_image_transfer_queue_job(batch_origin);
CREATE INDEX IF NOT EXISTS idx_ftp_image_transfer_queue_job_created_at ON ftp_image_transfer_queue_job(created_at);

CREATE INDEX IF NOT EXISTS idx_ftp_image_transfer_queue_status ON ftp_image_transfer_queue(status);
CREATE INDEX IF NOT EXISTS idx_ftp_image_transfer_queue_job_id ON ftp_image_transfer_queue(job_id);
CREATE INDEX IF NOT EXISTS idx_ftp_image_transfer_queue_file_id ON ftp_image_transfer_queue(file_id);
CREATE INDEX IF NOT EXISTS idx_ftp_image_transfer_queue_created_at ON ftp_image_transfer_queue(created_at);

-- Add indices for better performance on FTP video tables
CREATE INDEX IF NOT EXISTS idx_ftp_video_converted_buffer_camera_status ON ftp_video_converted_buffer(camera_id, status);
CREATE INDEX IF NOT EXISTS idx_ftp_video_converted_buffer_group_key ON ftp_video_converted_buffer(group_key);
CREATE INDEX IF NOT EXISTS idx_ftp_video_converted_buffer_source_file_id ON ftp_video_converted_buffer(source_file_id);
CREATE INDEX IF NOT EXISTS idx_ftp_video_converted_buffer_job_id ON ftp_video_converted_buffer(job_id);
CREATE INDEX IF NOT EXISTS idx_ftp_video_converted_buffer_job_camera ON ftp_video_converted_buffer(job_id, camera_id);
CREATE INDEX IF NOT EXISTS idx_ftp_video_converted_buffer_job_status ON ftp_video_converted_buffer(job_id, status);

CREATE INDEX IF NOT EXISTS idx_ftp_video_transfer_queue_job_status ON ftp_video_transfer_queue_job(status);
CREATE INDEX IF NOT EXISTS idx_ftp_video_transfer_queue_job_batch_origin ON ftp_video_transfer_queue_job(batch_origin);

CREATE INDEX IF NOT EXISTS idx_ftp_video_transfer_queue_status ON ftp_video_transfer_queue(status);
CREATE INDEX IF NOT EXISTS idx_ftp_video_transfer_queue_job_id ON ftp_video_transfer_queue(job_id);
CREATE INDEX IF NOT EXISTS idx_ftp_video_transfer_queue_camera_id ON ftp_video_transfer_queue(camera_id);

-- Add updated_at triggers for FTP image tables
DROP TRIGGER IF EXISTS update_ftp_image_transfer_queue_job_updated_at ON ftp_image_transfer_queue_job;
CREATE TRIGGER update_ftp_image_transfer_queue_job_updated_at 
    BEFORE UPDATE ON ftp_image_transfer_queue_job 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_ftp_image_transfer_queue_updated_at ON ftp_image_transfer_queue;
CREATE TRIGGER update_ftp_image_transfer_queue_updated_at 
    BEFORE UPDATE ON ftp_image_transfer_queue 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Add updated_at triggers for FTP video tables
DROP TRIGGER IF EXISTS update_ftp_video_converted_buffer_updated_at ON ftp_video_converted_buffer;
CREATE TRIGGER update_ftp_video_converted_buffer_updated_at 
    BEFORE UPDATE ON ftp_video_converted_buffer 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_ftp_video_transfer_queue_job_updated_at ON ftp_video_transfer_queue_job;
CREATE TRIGGER update_ftp_video_transfer_queue_job_updated_at 
    BEFORE UPDATE ON ftp_video_transfer_queue_job 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_ftp_video_transfer_queue_updated_at ON ftp_video_transfer_queue;
CREATE TRIGGER update_ftp_video_transfer_queue_updated_at 
    BEFORE UPDATE ON ftp_video_transfer_queue 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();


-- -----------------------------------------------------------------------
-- Dashboard pre-aggregation rollup materialized views.
-- These allow chart queries to read from small pre-computed summaries
-- instead of scanning the full files table on every request.
-- Refreshed concurrently by DashboardReportingBackend on a timer and on
-- every POST /dashboard/refresh call.
-- -----------------------------------------------------------------------

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_files_daily AS
SELECT
    date,
    cam_id,
    COUNT(DISTINCT plate_num)                                                        AS total_vehicles_count,
    COUNT(*)                                                                         AS total_files_count,
    COUNT(*) FILTER (WHERE image_export_done_date_time IS NOT NULL)                  AS success_produced_count,
    COUNT(*) FILTER (WHERE image_export_done_date_time IS NULL)                      AS failed_produce_count,
    ROUND(
        CASE WHEN COUNT(*) = 0 THEN 0
             ELSE COUNT(*) FILTER (WHERE image_export_done_date_time IS NULL)::numeric / COUNT(*) * 100
        END, 2
    )                                                                                AS failed_produced_percentage,
    ROUND(SUM(COALESCE(file_size, 0)) / 1024.0 / 1024.0 / 1024.0, 3)               AS total_file_size_in_gb
FROM files
WHERE deleted = false
GROUP BY date, cam_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_files_daily_pk ON mv_files_daily (date, cam_id);


CREATE MATERIALIZED VIEW IF NOT EXISTS mv_files_monthly AS
SELECT
    TO_CHAR(date, 'YYYY-MM')                                                         AS period,
    cam_id,
    COUNT(DISTINCT plate_num)                                                        AS total_vehicles_count,
    COUNT(*)                                                                         AS total_files_count,
    COUNT(*) FILTER (WHERE image_export_done_date_time IS NOT NULL)                  AS success_produced_count,
    COUNT(*) FILTER (WHERE image_export_done_date_time IS NULL)                      AS failed_produce_count,
    ROUND(
        CASE WHEN COUNT(*) = 0 THEN 0
             ELSE COUNT(*) FILTER (WHERE image_export_done_date_time IS NULL)::numeric / COUNT(*) * 100
        END, 2
    )                                                                                AS failed_produced_percentage,
    ROUND(SUM(COALESCE(file_size, 0)) / 1024.0 / 1024.0 / 1024.0, 3)               AS total_file_size_in_gb
FROM files
WHERE deleted = false
GROUP BY TO_CHAR(date, 'YYYY-MM'), cam_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_files_monthly_pk ON mv_files_monthly (period, cam_id);


CREATE MATERIALIZED VIEW IF NOT EXISTS mv_files_yearly AS
SELECT
    TO_CHAR(date, 'YYYY')                                                            AS period,
    cam_id,
    COUNT(DISTINCT plate_num)                                                        AS total_vehicles_count,
    COUNT(*)                                                                         AS total_files_count,
    COUNT(*) FILTER (WHERE image_export_done_date_time IS NOT NULL)                  AS success_produced_count,
    COUNT(*) FILTER (WHERE image_export_done_date_time IS NULL)                      AS failed_produce_count,
    ROUND(
        CASE WHEN COUNT(*) = 0 THEN 0
             ELSE COUNT(*) FILTER (WHERE image_export_done_date_time IS NULL)::numeric / COUNT(*) * 100
        END, 2
    )                                                                                AS failed_produced_percentage,
    ROUND(SUM(COALESCE(file_size, 0)) / 1024.0 / 1024.0 / 1024.0, 3)               AS total_file_size_in_gb
FROM files
WHERE deleted = false
GROUP BY TO_CHAR(date, 'YYYY'), cam_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_files_yearly_pk ON mv_files_yearly (period, cam_id);


-- Aggregated (no cam_id) variants — give correct COUNT(DISTINCT plate_num) across all cameras.
-- Used by the dashboard for the default aggregated view (no camera filter selected).

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_files_daily_agg AS
SELECT
    date,
    COUNT(DISTINCT plate_num)                                                        AS total_vehicles_count,
    COUNT(*)                                                                         AS total_files_count,
    COUNT(*) FILTER (WHERE image_export_done_date_time IS NOT NULL)                  AS success_produced_count,
    COUNT(*) FILTER (WHERE image_export_done_date_time IS NULL)                      AS failed_produce_count,
    ROUND(
        CASE WHEN COUNT(*) = 0 THEN 0
             ELSE COUNT(*) FILTER (WHERE image_export_done_date_time IS NULL)::numeric / COUNT(*) * 100
        END, 2
    )                                                                                AS failed_produced_percentage,
    ROUND(SUM(COALESCE(file_size, 0)) / 1024.0 / 1024.0 / 1024.0, 3)               AS total_file_size_in_gb
FROM files
WHERE deleted = false
GROUP BY date;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_files_daily_agg_pk ON mv_files_daily_agg (date);


CREATE MATERIALIZED VIEW IF NOT EXISTS mv_files_monthly_agg AS
SELECT
    TO_CHAR(date, 'YYYY-MM')                                                         AS period,
    COUNT(DISTINCT plate_num)                                                        AS total_vehicles_count,
    COUNT(*)                                                                         AS total_files_count,
    COUNT(*) FILTER (WHERE image_export_done_date_time IS NOT NULL)                  AS success_produced_count,
    COUNT(*) FILTER (WHERE image_export_done_date_time IS NULL)                      AS failed_produce_count,
    ROUND(
        CASE WHEN COUNT(*) = 0 THEN 0
             ELSE COUNT(*) FILTER (WHERE image_export_done_date_time IS NULL)::numeric / COUNT(*) * 100
        END, 2
    )                                                                                AS failed_produced_percentage,
    ROUND(SUM(COALESCE(file_size, 0)) / 1024.0 / 1024.0 / 1024.0, 3)               AS total_file_size_in_gb
FROM files
WHERE deleted = false
GROUP BY TO_CHAR(date, 'YYYY-MM');

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_files_monthly_agg_pk ON mv_files_monthly_agg (period);


CREATE MATERIALIZED VIEW IF NOT EXISTS mv_files_yearly_agg AS
SELECT
    TO_CHAR(date, 'YYYY')                                                            AS period,
    COUNT(DISTINCT plate_num)                                                        AS total_vehicles_count,
    COUNT(*)                                                                         AS total_files_count,
    COUNT(*) FILTER (WHERE image_export_done_date_time IS NOT NULL)                  AS success_produced_count,
    COUNT(*) FILTER (WHERE image_export_done_date_time IS NULL)                      AS failed_produce_count,
    ROUND(
        CASE WHEN COUNT(*) = 0 THEN 0
             ELSE COUNT(*) FILTER (WHERE image_export_done_date_time IS NULL)::numeric / COUNT(*) * 100
        END, 2
    )                                                                                AS failed_produced_percentage,
    ROUND(SUM(COALESCE(file_size, 0)) / 1024.0 / 1024.0 / 1024.0, 3)               AS total_file_size_in_gb
FROM files
WHERE deleted = false
GROUP BY TO_CHAR(date, 'YYYY');

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_files_yearly_agg_pk ON mv_files_yearly_agg (period);


-- MV-B: Manual USB video transfer schema additions

-- Make transfer_job_log.file_id nullable (videos log to iss_media_files, not files)
ALTER TABLE transfer_job_log ALTER COLUMN file_id DROP NOT NULL;
ALTER TABLE transfer_job_log
    ADD COLUMN IF NOT EXISTS media_file_id INT REFERENCES iss_media_files(id);

-- Track data type for each manual transfer job
ALTER TABLE transfer_job
    ADD COLUMN IF NOT EXISTS data_type VARCHAR(10) DEFAULT 'images';

-- Per-camera video group queue: one row per camera batch (N segments → one .mp4)
CREATE TABLE IF NOT EXISTS manual_video_group_queue (
    id                   SERIAL       PRIMARY KEY,
    transfer_job_id      INT          NOT NULL REFERENCES transfer_job(id),
    camera_id            INT          NOT NULL,
    group_key            TEXT         NOT NULL,
    source_file_ids      INT[]        NOT NULL,
    segment_count        INT          NOT NULL,
    status               VARCHAR(20)  NOT NULL DEFAULT 'pending',
    converted_video_path TEXT,
    converted_video_name TEXT,
    error_message        TEXT,
    created_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_mvgq_job_status
    ON manual_video_group_queue(transfer_job_id, status);


    `);
      console.log('   ✅ All tables, indexes, and functions created successfully');

    } catch (err) {
      console.error('❌ Error creating tables:', err);
      throw err;
    } finally {
      await client.end();
    }
  }

  async dropTables() {
    const client = new Client({
      user: this.DB_USER,
      host: this.DB_HOST,
      database: this.DB_APP, // Connect to the new database
      password: this.DB_PASSWORD,
      port: 5432,
    });

    try {
      await client.connect();

      console.log('   🔄 Dropping triggers and functions...');
      // Drop triggers first
      await client.query(`
        -- Drop triggers
        DROP TRIGGER IF EXISTS update_video_converted_buffer_updated_at ON video_converted_buffer;
        DROP TRIGGER IF EXISTS update_video_transfer_queue_job_updated_at ON video_transfer_queue_job;
        DROP TRIGGER IF EXISTS update_video_transfer_queue_updated_at ON video_transfer_queue;
        DROP TRIGGER IF EXISTS update_ftp_video_converted_buffer_updated_at ON ftp_video_converted_buffer;
        DROP TRIGGER IF EXISTS update_ftp_video_transfer_queue_job_updated_at ON ftp_video_transfer_queue_job;
        DROP TRIGGER IF EXISTS update_ftp_video_transfer_queue_updated_at ON ftp_video_transfer_queue;
        DROP TRIGGER IF EXISTS update_ftp_image_transfer_queue_job_updated_at ON ftp_image_transfer_queue_job;
        DROP TRIGGER IF EXISTS update_ftp_image_transfer_queue_updated_at ON ftp_image_transfer_queue;
        DROP TRIGGER IF EXISTS trigger_transfer_queue_updated_at ON transfer_queue;
        DROP TRIGGER IF EXISTS trigger_transfer_queue_job_updated_at ON transfer_queue_job;
        
        -- Drop functions
        DROP FUNCTION IF EXISTS get_readable_uptime(INTEGER);
        DROP FUNCTION IF EXISTS update_transfer_queue_updated_at();
        DROP FUNCTION IF EXISTS update_transfer_queue_job_updated_at();
        DROP FUNCTION IF EXISTS update_video_transfer_queue_updated_at();
        DROP FUNCTION IF EXISTS update_video_transfer_queue_job_updated_at();
        DROP FUNCTION IF EXISTS update_iss_media_files_updated_at();
        DROP FUNCTION IF EXISTS update_video_converted_buffer_updated_at();
        DROP FUNCTION IF EXISTS update_updated_at_column();
      `);

      console.log('   🔄 Dropping tables in dependency order...');
      // Drop tables in correct order (child tables first, then parent tables)
      await client.query(`
        -- Drop dashboard rollup materialized views
        DROP MATERIALIZED VIEW IF EXISTS mv_files_yearly_agg CASCADE;
        DROP MATERIALIZED VIEW IF EXISTS mv_files_monthly_agg CASCADE;
        DROP MATERIALIZED VIEW IF EXISTS mv_files_daily_agg CASCADE;
        DROP MATERIALIZED VIEW IF EXISTS mv_files_yearly CASCADE;
        DROP MATERIALIZED VIEW IF EXISTS mv_files_monthly CASCADE;
        DROP MATERIALIZED VIEW IF EXISTS mv_files_daily CASCADE;

        -- Drop child tables first (those with foreign keys)
        DROP TABLE IF EXISTS transfer_queue CASCADE;
        DROP TABLE IF EXISTS video_transfer_queue CASCADE;
        DROP TABLE IF EXISTS video_converted_buffer CASCADE;
        DROP TABLE IF EXISTS ftp_video_transfer_queue CASCADE;
        DROP TABLE IF EXISTS ftp_video_converted_buffer CASCADE;
        DROP TABLE IF EXISTS ftp_image_transfer_queue CASCADE;
        DROP TABLE IF EXISTS manual_video_group_queue CASCADE;
        DROP TABLE IF EXISTS transfer_job_log CASCADE;
        DROP TABLE IF EXISTS auto_transfer_job CASCADE;
        
        -- Drop parent tables
        DROP TABLE IF EXISTS transfer_queue_job CASCADE;
        DROP TABLE IF EXISTS video_transfer_queue_job CASCADE;
        DROP TABLE IF EXISTS ftp_video_transfer_queue_job CASCADE;
        DROP TABLE IF EXISTS ftp_image_transfer_queue_job CASCADE;
        DROP TABLE IF EXISTS transfer_job CASCADE;
        DROP TABLE IF EXISTS auto_transfer_device CASCADE;
        DROP TABLE IF EXISTS device_connections CASCADE;
        DROP TABLE IF EXISTS iss_media_files CASCADE;
        DROP TABLE IF EXISTS files CASCADE;
      `);

      console.log('   ✅ All tables and functions dropped successfully');

    } catch (err) {
      console.error('❌ Error dropping tables:', err);
      throw err;
    } finally {
      await client.end();
    }
  }

  async alterTable() {
     const client = new Client({
      user: this.DB_USER,
      host: this.DB_HOST,
      database: this.DB_APP, // Connect to the new database
      password: this.DB_PASSWORD,
      port: 5432,
    });
    
    let query = `
ALTER TABLE files
ADD COLUMN image_export_done_date_time TIMESTAMP DEFAULT NULL,
ADD COLUMN export_retry_count INTEGER DEFAULT 0,
ADD COLUMN export_retry_log_object JSONB DEFAULT '[]',
ADD COLUMN deleted_date_time TIMESTAMP DEFAULT NULL,
ADD COLUMN export_params JSONB DEFAULT NULL;
    `;

    try {

      await client.connect();

    
      await client.query(query);
      console.log("[*] Altered successfully");

    }
    catch (e) {
      console.error('Error dropping tables:', e);
    }
    finally {
      await client.end();
    }
  }


}
(async () => {

  if (CREATE_DB) {
    const appDb = new AppDatabase();
    
    try {
      console.log('🚀 Starting database migration...');
      
      // Create database if it doesn't exist (uncomment if needed)
      await appDb.createDatabase();
      
      if (DROP_SCHEMA) {
        console.log('🗑️  Dropping existing schema...');
        await appDb.dropTables();
        console.log('✅ Schema dropped successfully');
      }

      console.log('🏗️  Creating tables...');
      await appDb.createTables();
      console.log('✅ Tables created successfully');

      // Grant privileges after creating tables
      console.log('🔐 Granting privileges...');
      await appDb.grantPrivileges();
      console.log('✅ Privileges granted successfully');

      console.log('🎉 Database migration completed successfully!');
      
    } catch (error) {
      console.error('❌ Database migration failed:', error);
      process.exit(1);
    }
  } else {
    console.log('⏭️  Database migration skipped (CREATE_DB = false)');
  }

})()


