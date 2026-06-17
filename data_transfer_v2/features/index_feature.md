# All Files Page (Index)

This document describes the features of the "All Files" page, which serves as the main interface for viewing, filtering, and managing all captured files and storage settings.

## 1. Storage Overview

This section provides a high-level summary of the storage status and access to configuration.

### Features:

-   **Storage Usage**:
    -   A progress bar shows the current storage usage against the maximum capacity.
    -   Text displays the used space and the maximum capacity (e.g., "150 GB / 200 GB").
-   **Storage History Chart**: A chart that visualizes the storage usage over time.
-   **Configure Button**: A button that opens the "Storage Settings" modal.

## 2. Filtering and Searching

A dedicated section for filtering the files displayed in the main table.

### Features:

-   **Date/Time Range**: Select a start and end date and time to narrow down the file list.
-   **License Plate Search**: A search bar to find all files associated with a specific license plate number.
-   **Filter Button**: Applies the selected date range and search criteria.

## 3. Files Table

A comprehensive, paginated table that lists all captured file records.

### Features:

-   **Dynamic Data**: The table is populated with data from the backend.
-   **Table Columns**:
    -   `TID` (Transaction ID)
    -   `Plate Number`
    -   `Site ID`
    -   `Date`
    -   `Time`
    -   `File Paths` — each filename is shown as a truncated clickable link. Clicking any link opens a full-screen Bootstrap 5 image lightbox. If the row has multiple images, left/right arrows let you cycle through all of them. Files with `size = 0` (not yet exported to disk) are shown as grey text with no link.
    -   `File Sizes`
    -   `File Count`
    -   `Download`: A button to download all available files for that record.

## 4. Storage Settings Modal

A detailed modal for configuring all aspects of file storage and management.

### Features:

-   **Site ID**: Set a unique identifier for the site.
-   **Storage Directory**: Define the root directory where all files will be saved.
-   **File Encryption**:
    -   Enable or disable encryption for stored files.
    -   If enabled, you can configure the `Algorithm`, `Key Management` method, and choose whether to `Encrypt file metadata`.
-   **Path Structure**:
    -   A drag-and-drop interface to customize the folder structure for saved files.
    -   Available components include `SITE_ID`, `DATE`, and `TIME`.
    -   You can also select the format for the date and time components (e.g., `YYYY_MM_DD` for the date).
-   **Maximum Storage Capacity**: Set the maximum amount of disk space (in GB) that the application can use.
-   **Retention Policy**:
    -   Configure rules for automatic file deletion.
    -   Currently supports a `FIFO (First-In, First-Out)` policy, which removes the oldest files first when the storage limit is reached.
-   **Save/Cancel**: Buttons to save the new configuration or close the modal without changes.

## How to Use:

1.  **View Files**: On page load, the table displays the most recent files.
2.  **Monitor Storage**: Check the "Storage Overview" card to see how much space is being used.
3.  **Filter Files**: Use the filter section to find specific files by date, time, or license plate.
4.  **View Images**: Click any filename in the "File Paths" column to open it in a full-screen lightbox. Use the arrow buttons (or keyboard ← →) to browse all images for that detection.
5.  **Download Files**: Click the download button in any row to get all available files for that record.
5.  **Configure Settings**:
    -   Click the "Configure" button to open the settings modal.
    -   Adjust the storage directory, encryption, path structure, and retention policies as needed.
    -   Click "Save Changes" to apply the new configuration. 