-- Migration: Add source_file_ids column to video_transfer_queue table
-- Purpose: Store source file IDs to enable proper marking when transfer succeeds/fails
-- Date: 2025-01-10

-- Add the new column to store array of source file IDs
ALTER TABLE video_transfer_queue 
ADD COLUMN IF NOT EXISTS source_file_ids INTEGER[];

-- Add comment for documentation
COMMENT ON COLUMN video_transfer_queue.source_file_ids IS 'Array of iss_media_files.id that were used to create this video';

-- Create index for better performance when querying by source file IDs
CREATE INDEX IF NOT EXISTS idx_video_transfer_queue_source_file_ids 
ON video_transfer_queue USING gin(source_file_ids);

-- Verify the change
\d video_transfer_queue;
