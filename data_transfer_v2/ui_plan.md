# Plan: UI for Automatic Video Transfer

This plan outlines the steps to create a new user interface for managing automatic video file transfers, similar to the existing interface for general file transfers.

## Step 1: Create the Nunjucks View File

*   **Create a new file:** `views/auto_transfer_video.njk`.
*   **Content:** This file will be based on `views/auto_transfer.njk`.
    *   The page title will be changed to "Automatic Video Transfer".
    *   The form and status display elements will be kept similar for consistency.
    *   JavaScript logic within the file will be adapted for video transfer endpoints.

## Step 2: Add Navigation Link

*   **Modify `views/layout/layout.njk`:**
*   **Action:** Add a new link in the sidebar navigation for "Auto Transfer Video".
    *   This will point to the new `/auto_transfer_video` URL.
    *   An appropriate icon, like `<i class="fas fa-video me-2"></i>`, will be used.

## Step 3: Define New Route

*   **Identify routing file:** I will need to locate where the application routes are defined (likely in a file like `BackendFrontendServer.js` or similar).
*   **Action:** Add a new GET route for `/auto_transfer_video`.
*   **Function:** This route will render the `views/auto_transfer_video.njk` template.

## Step 4: Adapt Frontend JavaScript

*   **File:** `views/auto_transfer_video.njk`
*   **Action:** The inline JavaScript will be updated.
    *   It will point to a new set of API endpoints for video transfer (e.g., `http://localhost:PORT/auto-transfer-video/...`).
    *   The WebSocket connection will subscribe to a video-specific event (e.g., `realtimeVideoDashboard`).
    *   The active class for the sidebar will be updated to target the new link (e.g., `$('.auto-transfer-video').addClass('active');`).

After you review this plan, please let me know to proceed, and I will start implementing these changes. 