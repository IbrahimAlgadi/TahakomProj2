-- MV-B: Schema additions to support manual USB video transfer
-- Run once against tahakom_transfer database.

-- 1a. Make file_transfer_queue.file_id nullable so video entries (whose source is
--     iss_media_files, not files) can be inserted with file_id = NULL.
ALTER TABLE file_transfer_queue ALTER COLUMN file_id DROP NOT NULL;

-- 1b. Make transfer_job_log.file_id nullable so video-only rows can be inserted
--     without a files(id) FK (video source is iss_media_files).
ALTER TABLE transfer_job_log ALTER COLUMN file_id DROP NOT NULL;

-- 2. Add media_file_id column so video log rows can reference iss_media_files.
ALTER TABLE transfer_job_log
    ADD COLUMN IF NOT EXISTS media_file_id INT REFERENCES iss_media_files(id);

-- 3. Track what data type each manual job transferred.
ALTER TABLE transfer_job
    ADD COLUMN IF NOT EXISTS data_type VARCHAR(10) DEFAULT 'images';

-- 4. New table that tracks the per-camera video group conversion + copy pipeline
--    for manual USB video transfers.  One row = one camera's N-segment batch that
--    will be converted and concatenated into a single .mp4 for the USB drive.
CREATE TABLE IF NOT EXISTS manual_video_group_queue (
    id                   SERIAL       PRIMARY KEY,
    transfer_job_id      INT          NOT NULL REFERENCES transfer_job(id),
    camera_id            INT          NOT NULL,
    group_key            TEXT         NOT NULL,
    source_file_ids      INT[]        NOT NULL,
    segment_count        INT          NOT NULL,
    -- Status lifecycle: pending → converting → converted → copying → transferred | failed
    status               VARCHAR(20)  NOT NULL DEFAULT 'pending',
    converted_video_path TEXT,
    converted_video_name TEXT,
    error_message        TEXT,
    created_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mvgq_job_status
    ON manual_video_group_queue(transfer_job_id, status);
