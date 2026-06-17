--- Hourly Report 1
SELECT
    TO_CHAR(date, 'MM/DD/YYYY') AS date,
    TO_CHAR(time, 'HH12 AM') AS hour_am_pm,
    COUNT(DISTINCT plate_num) AS total_vehicles_count,
    COUNT(*) AS total_files_count,
    COUNT(CASE WHEN image_export_done_date_time IS NOT NULL THEN 1 END) AS success_produced_count,
    COUNT(CASE WHEN image_export_done_date_time IS NULL THEN 1 END) AS failed_produce_count,
    ROUND(
        CASE WHEN COUNT(*) = 0 THEN 0
             ELSE COUNT(CASE WHEN image_export_done_date_time IS NULL THEN 1 END)::numeric / COUNT(*) * 100
        END, 2
    ) AS failed_produced_percentage,
    ROUND(SUM(file_size) / 1024.0 / 1024.0 / 1024.0, 3) AS total_file_size_in_gb
FROM files
WHERE deleted = FALSE
GROUP BY date, TO_CHAR(time, 'HH12 AM')
ORDER BY date, MIN(time);


--- Daily Report 1 - Per Cam
SELECT
    TO_CHAR(date, 'MM/DD/YYYY') AS date,
    cam_id,
    COUNT(DISTINCT plate_num) AS total_vehicles_count,
    COUNT(*) AS total_files_count,
    COUNT(CASE WHEN image_export_done_date_time IS NOT NULL THEN 1 END) AS success_produced_count,
    COUNT(CASE WHEN image_export_done_date_time IS NULL THEN 1 END) AS failed_produce_count,
    ROUND(
        CASE WHEN COUNT(*) = 0 THEN 0
             ELSE COUNT(CASE WHEN image_export_done_date_time IS NULL THEN 1 END)::numeric / COUNT(*) * 100
        END, 2
    ) AS failed_produced_percentage,
    ROUND(SUM(file_size) / 1024.0 / 1024.0 / 1024.0, 3) AS total_file_size_in_gb
FROM files
WHERE deleted = FALSE
GROUP BY date, cam_id
ORDER BY date, cam_id;


--- Daily Report 2 - Per Day
SELECT
    TO_CHAR(date, 'MM/DD/YYYY') AS date,
    COUNT(DISTINCT plate_num) AS total_vehicles_count,
    COUNT(*) AS total_files_count,
    COUNT(CASE WHEN image_export_done_date_time IS NOT NULL THEN 1 END) AS success_produced_count,
    COUNT(CASE WHEN image_export_done_date_time IS NULL THEN 1 END) AS failed_produce_count,
    ROUND(
        CASE WHEN COUNT(*) = 0 THEN 0
             ELSE COUNT(CASE WHEN image_export_done_date_time IS NULL THEN 1 END)::numeric / COUNT(*) * 100
        END, 2
    ) AS failed_produced_percentage,
    ROUND(SUM(file_size) / 1024.0 / 1024.0 / 1024.0) AS total_file_size_in_gb
FROM files
WHERE deleted = FALSE
GROUP BY date
ORDER BY date;



