-- Migration: Add job_id column to video_converted_buffer table
-- Purpose: Enable proper job isolation and tracking in video conversion buffer
-- Date: 2025-01-14

-- Check if job_id column already exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'video_converted_buffer' 
        AND column_name = 'job_id'
    ) THEN
        -- Add the job_id column with a temporary default value
        ALTER TABLE video_converted_buffer 
        ADD COLUMN job_id INTEGER;
        
        -- Update existing records to reference the most recent job
        -- This is a best-effort migration for existing data
        UPDATE video_converted_buffer 
        SET job_id = (
            SELECT id 
            FROM video_transfer_queue_job 
            WHERE batch_origin = 'auto_video'
            ORDER BY created_at DESC 
            LIMIT 1
        )
        WHERE job_id IS NULL;
        
        -- If no jobs exist, create a migration job for orphaned records
        INSERT INTO video_transfer_queue_job (
            batch_id, batch_origin, status, 
            expected_cameras, processed_cameras,
            interval_duration_minutes, site_id,
            created_at, updated_at
        )
        SELECT 
            gen_random_uuid()::text, 'auto_video', 'transferred',
            ARRAY['1', '2', '3'], ARRAY['1', '2', '3'],
            5, COALESCE(site_id, 'migration'),
            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        FROM (
            SELECT DISTINCT site_id 
            FROM video_converted_buffer 
            WHERE job_id IS NULL
            LIMIT 1
        ) t
        WHERE NOT EXISTS (
            SELECT 1 FROM video_transfer_queue_job 
            WHERE batch_origin = 'auto_video'
        );
        
        -- Update orphaned records with the migration job
        UPDATE video_converted_buffer 
        SET job_id = (
            SELECT id 
            FROM video_transfer_queue_job 
            WHERE batch_origin = 'auto_video'
            ORDER BY created_at DESC 
            LIMIT 1
        )
        WHERE job_id IS NULL;
        
        -- Make the column NOT NULL after data migration
        ALTER TABLE video_converted_buffer 
        ALTER COLUMN job_id SET NOT NULL;
        
        -- Add foreign key constraint
        ALTER TABLE video_converted_buffer 
        ADD CONSTRAINT fk_video_converted_buffer_job
            FOREIGN KEY(job_id) 
            REFERENCES video_transfer_queue_job(id) ON DELETE CASCADE;
        
        -- Add performance indices
        CREATE INDEX IF NOT EXISTS idx_video_converted_buffer_job_id 
        ON video_converted_buffer(job_id);
        
        CREATE INDEX IF NOT EXISTS idx_video_converted_buffer_job_camera 
        ON video_converted_buffer(job_id, camera_id);
        
        CREATE INDEX IF NOT EXISTS idx_video_converted_buffer_job_status 
        ON video_converted_buffer(job_id, status);
        
        RAISE NOTICE 'Successfully added job_id column to video_converted_buffer table';
    ELSE
        RAISE NOTICE 'job_id column already exists in video_converted_buffer table';
    END IF;
END
$$;

-- Verify the changes
SELECT 
    column_name, 
    data_type, 
    is_nullable,
    column_default
FROM information_schema.columns 
WHERE table_name = 'video_converted_buffer' 
AND column_name = 'job_id';
