# Automatic Video Transfer Page

This document outlines the features available on the Automatic Video Transfer page.

## 1. Drive Configuration

The Drive Configuration section allows you to set up the destination for the video file transfers.

### Features:

-   **Transfer Active Toggle**: A master switch to enable or disable the automatic transfer process. When active, the form controls are disabled to prevent changes during transfer.
-   **Auto Drive Selection**: A dropdown menu to select the target drive (e.g., E:, F:, G:) for file transfers.
-   **File Encryption**:
    -   **Enable/Disable**: You can choose to transfer files with or without encryption.
    -   **Encryption Algorithm**: If encryption is enabled, you can select from `AES-256`, `AES-128`, or `ChaCha20`.
    -   **Key Management**: Choose how encryption keys are managed: `Manual Key Entry`, `Certificate-Based`, or using a `Key Management Service (KMS)`.
    -   **Encrypt Metadata**: An option to encrypt file metadata along with the file content.
-   **Test Connection**: A button to check if the selected drive is accessible and ready for transfer. It also displays drive information upon a successful connection.
-   **Save Configuration**: A button to save the selected drive and encryption settings. This is only enabled after a successful connection test.

## 2. Drive Status

This section provides real-time information about the selected drive's storage.

### Features:

-   **Storage Usage**: Displays the used and total space on the drive (e.g., "X GB / Y GB").
-   **Usage Progress Bar**: A visual representation of the used space on the drive.
-   **Detailed Space Info**: Shows the exact available and used space on the drive.

## 3. Transfer Status

This section monitors the state of the file transfer process.

### Features:

-   **Drive Connectivity Status**: Indicates whether the drive is `connected`, `disconnected`, or if the transfer is `stopped`.
-   **Current Transfer Status**: Shows the status of the ongoing file transfer, such as `Success`, `Error`, `Paused`, `Idle`, or `Stopped`.
-   **Status Messages**: Displays detailed messages about the current transfer operation.
-   **Capacity Warning**: An alert indicating that the transfer will automatically stop if the drive reaches 100% capacity.

## 4. Real-time Updates & Notifications

-   **WebSockets**: The page uses a WebSocket connection to receive real-time updates for drive and transfer statuses without needing to refresh the page.
-   **Toast Notifications**: Provides non-intrusive pop-up notifications for events like saving configuration, successful connections, or errors.

## How to Use:

1.  **Select a Drive**: Choose a drive from the "Auto Drive" dropdown.
2.  **Test Connection**: Click the "Test Connection" button. If successful, the drive status will update, and the "Save Configuration" button will be enabled.
3.  **Configure Encryption (Optional)**: If you need to encrypt the files, enable the "Enable encryption" option and select your desired settings.
4.  **Save Configuration**: Click "Save Configuration" to save your settings.
5.  **Activate Transfer**: Use the "Transfer Active" toggle to start the automatic video transfer process.
6.  **Monitor**: Keep an eye on the "Drive Status" and "Transfer Status" sections for real-time updates. 