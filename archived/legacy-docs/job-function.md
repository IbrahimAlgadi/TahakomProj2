I want you to do the following in this functions:
---

1. Start the function by:
- Looks for existing jobs that aren't completed
- Orders by creation date (newest first)

2. Handle Existing Active Job
- If an active job exists, it branches based on status:
- ('created', 'pending', 'processing', 'transferring', 'paused').
A- Handle created job:
a- if job is created then it is in the step of collecting media files.
b- in this case for each camera in (ISS_MEDIA_CAMERAS) make sure that it has 38 files added to (video_converted_buffer)

B- Handle 'pending', 'processing':
a- Usually this type has all ISS_MEDIA_CAMERAS with 38 files added in (video_converted_buffer) and they are currently being converted to mp4, once finished they will be groupped into mp4 and stored in (video_transfer_queue).

C- Checks if job is actually complete the completed job will have () 
If complete → updates status to transferred and returns null
If not complete → returns null (waits for completion)

Always Checks completion status
If complete → updates to pending status and returns null
If incomplete → returns the job to continue processing
Other statuses: Returns the job as-is

3. Create New Job (No Active Job Found) then Generated UUID batch ID with status created:
 
- loop through all cameras ISS_MEDIA_CAMERAS
- For each camera check how many files it have in (video_converted_buffer) with status ('pending', 'converted') 
- If for camera it has 20 processed then request 18 to complete 38 files.
- If no files found for camera then check other cameras

Key Behaviors
---

- Prevents concurrent jobs: Only one active job per batch origin
- State progression: created → pending → transferred
- Completion detection: Uses a function to verify all cameras processed
- Resource efficiency: Won't create unnecessary jobs if no files to process
- The function essentially acts as a job scheduler that ensures orderly processing of video transfer batches while preventing race conditions.
