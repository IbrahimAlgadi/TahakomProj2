-- Add missing retry_count and max_retries columns to video_transfer_queue table
-- Also add destination_path and usb_path for better transfer tracking

-- Add retry_count column if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'video_transfer_queue' 
        AND column_name = 'retry_count'
    ) THEN
        ALTER TABLE video_transfer_queue ADD COLUMN retry_count INTEGER DEFAULT 0;
        UPDATE video_transfer_queue SET retry_count = 0 WHERE retry_count IS NULL;
        COMMIT;
        RAISE NOTICE 'Added retry_count column to video_transfer_queue table';
    ELSE
        RAISE NOTICE 'retry_count column already exists in video_transfer_queue table';
    END IF;
END
$$;

-- Add max_retries column if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'video_transfer_queue' 
        AND column_name = 'max_retries'
    ) THEN
        ALTER TABLE video_transfer_queue ADD COLUMN max_retries INTEGER DEFAULT 3;
        UPDATE video_transfer_queue SET max_retries = 3 WHERE max_retries IS NULL;
        COMMIT;
        RAISE NOTICE 'Added max_retries column to video_transfer_queue table';
    ELSE
        RAISE NOTICE 'max_retries column already exists in video_transfer_queue table';
    END IF;
END
$$;

-- Add destination_path column if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'video_transfer_queue' 
        AND column_name = 'destination_path'
    ) THEN
        ALTER TABLE video_transfer_queue ADD COLUMN destination_path TEXT;
        COMMIT;
        RAISE NOTICE 'Added destination_path column to video_transfer_queue table';
    ELSE
        RAISE NOTICE 'destination_path column already exists in video_transfer_queue table';
    END IF;
END
$$;

-- Add usb_path column if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'video_transfer_queue' 
        AND column_name = 'usb_path'
    ) THEN
        ALTER TABLE video_transfer_queue ADD COLUMN usb_path TEXT;
        COMMIT;
        RAISE NOTICE 'Added usb_path column to video_transfer_queue table';
    ELSE
        RAISE NOTICE 'usb_path column already exists in video_transfer_queue table';
    END IF;
END
$$;

-- Create an index on retry_count for performance
CREATE INDEX IF NOT EXISTS idx_video_transfer_queue_retry_count ON video_transfer_queue(retry_count);

-- Add a comment to document the changes
COMMENT ON TABLE video_transfer_queue IS 'Video transfer queue with retry mechanism and path tracking for improved error handling';

