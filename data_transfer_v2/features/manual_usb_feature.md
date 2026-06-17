# Manual USB Transfer Page

This document outlines the features of the Manual USB Transfer page, which allows users to create, monitor, and review data transfer jobs to a USB drive.

## 1. Create Transfer Job

This section is for initiating a new data transfer to a connected USB drive.

### Features:

-   **USB Drive Selection**: A dropdown menu to select the destination USB drive from a list of connected devices.
-   **Date & Time Range**: Input fields to specify the start and end date/time for the data to be included in the transfer.
-   **Transfer Summary**:
    -   A button (`Show Transfer Summary`) calculates and displays a preview of the transfer.
    -   The summary includes the total number of files, the total size of the transfer, and the destination path on the USB drive.
-   **Create Job Button**: This button, enabled only after a summary is generated, creates and starts the new transfer job.

## 2. Active Transfer Jobs

This section displays the status of any currently running transfer job.

### Features:

-   **Real-time Monitoring**: The card is updated in real-time via a WebSocket connection to show the current status of an active job.
-   **Job Information**: Displays details of the ongoing transfer, such as progress, files transferred, and speed. If no job is active, it shows a corresponding message.

## 3. Transfer History

This section provides a comprehensive log of all past transfer jobs.

### Features:

-   **Filtering and Searching**:
    -   **Status Filters**: Buttons to filter the history by job status: `All`, `Completed`, `Failed`, or `Cancelled`.
    -   **Search Bar**: A search input to find specific jobs.
-   **Detailed History Table**: The table displays the following information for each job:
    -   `Job ID`
    -   `Date`
    -   `Drive` (Destination USB drive)
    -   `Files` (Number of files)
    -   `Size` (Total size of the transfer)
    -   `Duration`
    -   `Status` (e.g., Completed, Failed)
-   **Pagination**:
    -   Controls to navigate through multiple pages of the transfer history.
    -   An option to select the number of entries to display per page (e.g., 10, 25, 50, 100).

## 4. Real-time Functionality

-   **WebSockets**: The page uses a WebSocket connection to provide real-time updates for the "Active Transfer Jobs" section, ensuring the user always sees the current state without needing to manually refresh.

## How to Use:

1.  **Connect USB Drive**: Ensure a USB drive is connected to the system.
2.  **Select Drive**: Choose the correct drive from the "Select USB Drive" dropdown.
3.  **Set Date Range**: Specify the start and end date/time for the data you want to transfer.
4.  **Get Summary**: Click "Show Transfer Summary" to see how many files and how much data will be transferred.
5.  **Create Job**: If the summary is correct, click "Create Transfer Job" to begin the transfer.
6.  **Monitor Active Job**: The "Active Transfer Jobs" card will show the progress of your transfer.
7.  **Review History**: Use the "Transfer History" section to review details of past jobs. You can filter and search the history to find specific transfers. 