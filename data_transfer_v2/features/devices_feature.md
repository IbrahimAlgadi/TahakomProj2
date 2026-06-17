# Connected Devices Page

This document outlines the features of the Connected Devices page, which provides information about currently connected external devices and a history of past connections.

## 1. Header

-   **Refresh Button**: Allows for a manual refresh of the connected devices list to fetch the latest information.

## 2. Connected Devices Grid

This section displays a real-time view of all currently connected external storage devices.

### Features:

-   **Device Cards**: Each connected device is represented by a card. If no devices are connected, a message is displayed.
-   **Information Displayed per Card**:
    -   **Device Label**: The name of the device (e.g., "My USB").
    -   **Connection Status**: A badge indicating if the device is `connected`.
    -   **Storage Usage**:
        -   A progress bar showing the percentage of used space, color-coded for capacity warnings (green, yellow, red).
        -   Text display of used vs. total space (e.g., "15 GB / 64 GB").
    -   **Space Details**: Shows the exact available and used space.
    -   **Technical Details**:
        -   `Drive Letter`
        -   `File System` (e.g., NTFS, FAT32)
        -   `Read/Write` status
        -   `Last Updated` timestamp

## 3. Device Connection History

This section provides a log of all devices that have been connected in the past.

### Features:

-   **History Table**: A detailed table logs every device connection event.
-   **Table Columns**:
    -   `Device` (Drive letter)
    -   `Label`
    -   `Type` (File system)
    -   `Connected At` (Timestamp)
    -   `Disconnected At` (Timestamp)
    -   `Duration` (How long the device was connected)
    -   `Status` (e.g., `Disconnected`)
-   **Pagination**:
    -   Navigate through the history with pagination controls.
    -   Select the number of entries to show per page (10, 25, 50, 100).

## 4. Real-time Updates & Notifications

-   **WebSockets**: The page uses a WebSocket connection to get live updates, so the list of connected devices and their statuses change automatically as devices are plugged in or removed.
-   **Toast Notifications**: The system uses toast notifications to alert the user of significant events, such as a new device being connected.

## How to Use:

1.  **View Connected Devices**: Simply open the page to see a list of all currently connected devices. The information is updated in real-time.
2.  **Refresh Manually**: If needed, click the "Refresh" button to force an update.
3.  **Review History**: Scroll down to the "Device Connection History" table to see a log of past connections.
4.  **Navigate History**: Use the pagination controls to browse through older connection records. 