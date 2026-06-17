The diagram describes these core steps:
Recursively scan a root directory (ISS_MEDIA).
Go through camera-specific subdirectories (CAM_ID).
Go through date-stamped directories.
Apply a retention policy to decide which date directories to scan.
Index metadata of video files (.issvd) within those directories.
Store this metadata in a PostgreSQL database.
Continuously monitor the directories for any changes and update the index.

