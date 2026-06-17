-- Create file_transfer_queue table if it doesn't exist
CREATE TABLE IF NOT EXISTS file_transfer_queue (
    id SERIAL PRIMARY KEY,
    service_type VARCHAR(20) NOT NULL,
    file_id INTEGER,
    file_path TEXT NOT NULL,
    file_size BIGINT DEFAULT 0,
    file_name TEXT,
    destination_path TEXT NOT NULL,
    priority INTEGER NOT NULL,
    batch_id VARCHAR(36) NOT NULL,
    transfer_job_id INTEGER,
    metadata JSONB,
    status VARCHAR(20) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    transferred_at TIMESTAMP,
    error_message TEXT,
    retry_count INTEGER DEFAULT 0
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_file_transfer_queue_status ON file_transfer_queue(status);
CREATE INDEX IF NOT EXISTS idx_file_transfer_queue_priority ON file_transfer_queue(priority DESC);
CREATE INDEX IF NOT EXISTS idx_file_transfer_queue_batch_id ON file_transfer_queue(batch_id);
CREATE INDEX IF NOT EXISTS idx_file_transfer_queue_service_type ON file_transfer_queue(service_type);
CREATE INDEX IF NOT EXISTS idx_file_transfer_queue_transfer_job_id ON file_transfer_queue(transfer_job_id);
CREATE INDEX IF NOT EXISTS idx_file_transfer_queue_created_at ON file_transfer_queue(created_at);

-- Fix failed transfer queue records with invalid destination paths
UPDATE file_transfer_queue
SET
    status = 'pending',
    destination_path = REPLACE(destination_path, '::\\', ':\\'),
    retry_count = 0,
    error_message = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE status = 'failed'
AND (error_message LIKE '%invalid characters%' OR error_message LIKE '%Unexpected token o in JSON%');

-- Show the updated records
SELECT id, service_type, destination_path, status, error_message
FROM file_transfer_queue
WHERE status = 'pending'
AND destination_path LIKE '%:\\%'
ORDER BY id; 