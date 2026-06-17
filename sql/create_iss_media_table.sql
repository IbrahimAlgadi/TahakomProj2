-- Create ISS Media Files Table
-- Run this script if you need to create the table manually

CREATE TABLE IF NOT EXISTS iss_media_files (
    id SERIAL PRIMARY KEY,
    file_path TEXT UNIQUE NOT NULL,
    file_name TEXT NOT NULL,
    file_size BIGINT NOT NULL,
    camera_id INTEGER NOT NULL,
    site_id TEXT,
    recording_date DATE NOT NULL,
    recording_time TIME NOT NULL,
    timezone_offset TEXT NOT NULL,
    precise_time TIME NOT NULL,
    is_auto_transferred BOOLEAN DEFAULT FALSE,
    is_ftp_transferred BOOLEAN DEFAULT FALSE,
    deleted BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP DEFAULT NULL
);

-- Create indexes for optimal performance
CREATE INDEX IF NOT EXISTS idx_iss_media_camera_date ON iss_media_files(camera_id, recording_date);
CREATE INDEX IF NOT EXISTS idx_iss_media_site_date ON iss_media_files(site_id, recording_date);
CREATE INDEX IF NOT EXISTS idx_iss_media_path ON iss_media_files(file_path);
CREATE INDEX IF NOT EXISTS idx_iss_media_deleted ON iss_media_files(deleted);
CREATE INDEX IF NOT EXISTS idx_iss_media_transfers ON iss_media_files(is_auto_transferred, is_ftp_transferred);
CREATE INDEX IF NOT EXISTS idx_iss_media_precise_time ON iss_media_files(recording_date, precise_time);

-- Add comments for documentation
COMMENT ON TABLE iss_media_files IS 'Stores indexed ISS media files (.issvd) with parsed metadata';
COMMENT ON COLUMN iss_media_files.camera_id IS 'Camera identifier extracted from filename (1, 2, 3, etc.)';
COMMENT ON COLUMN iss_media_files.recording_time IS 'Base recording time from filename (T09+0300 = 09:00:00)';
COMMENT ON COLUMN iss_media_files.timezone_offset IS 'Timezone offset from filename (+0300, +0500, etc.)';
COMMENT ON COLUMN iss_media_files.precise_time IS 'Exact recording time including offset (09:02:02.360)';

-- Verify table creation
SELECT 
    schemaname,
    tablename,
    tableowner
FROM pg_tables 
WHERE tablename = 'iss_media_files';

-- Show table structure
\d iss_media_files 