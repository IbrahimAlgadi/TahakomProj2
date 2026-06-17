# Manual Transfer Page (USB/SSD)

This document describes the features of the "Transfer to USB/SSD" page, which is used to create and monitor a manual transfer of specific data to an external drive.

## 1. Create Transfer Job

The page features a form that allows the user to define the data to be transferred and the destination.

### Features:

-   **Data Filtering**:
    -   **Start Date**: Select the start date for the data range to be transferred.
    -   **End Date**: Select the end date for the data range.
    -   **Car Plate**: Specify a car plate to transfer data only for that vehicle.
-   **Destination Path**:
    -   **USB Path**: A required field to manually enter the full path to the destination drive or folder (e.g., `E:\backups`).
-   **Create Job Button**: A button to submit the form and start the transfer job.

## 2. Transfer Progress Table

-   **Real-time Progress**: The results of the job creation are displayed in a table that shows the files being transferred.
-   **Tabulator Table**: The page uses the Tabulator library to create a rich, interactive table.
-   **Real-time Updates**: The table is updated in real-time via a WebSocket connection, which pushes events (`startStorageTransferProgress`, `startStorageTransferDone`) to the front end, allowing the user to see the transfer progress live without refreshing the page.

## How to Use:

1.  **Define Data Set**: Use the date and car plate filters to specify which data you want to transfer.
2.  **Set Destination**: Enter the full path to your USB/SSD drive in the "USB Path" field.
3.  **Create Job**: Click the "Create Transfer Job" button.
4.  **Monitor Progress**: Observe the table that appears in the "databaseResults" section. It will populate with the files as they are being processed and transferred. 