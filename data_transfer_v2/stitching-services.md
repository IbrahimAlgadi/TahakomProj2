# Data Transfer System Architecture Documentation

## Overview
This document outlines the architecture and interactions between various microservices in the Data Transfer system. The system is built using a microservices architecture where each service handles specific responsibilities in the ALPR (Automatic License Plate Recognition) data processing pipeline.

## Core Services

### 1. Backend Frontend Server (`BackendFrontendServer.js`)
- **Primary Role**: Acts as the main server and API gateway
- **Responsibilities**:
  - Handles HTTP requests and serves the web interface
  - Coordinates communication between different microservices
  - Manages the public API endpoints
  - Serves static files from the `public` directory
  - Renders views using the templates in the `views` directory

### 2. ALPR Image Processing Services

#### Image Capture (`ALPRImageCaptureMicroservice.js`)
- **Primary Role**: Handles the capture and initial processing of ALPR images
- **Interactions**:
  - Communicates with the database control service for storing image metadata
  - Coordinates with the export directory control service for image storage

#### Image Export Directory Control (`ALPRImageExportDirectoryControlMicorservice.js`)
- **Primary Role**: Manages the directory structure for exported images
- **Responsibilities**:
  - Creates and maintains directory hierarchies
  - Handles file organization and cleanup
  - Works with the image capture service for proper file placement

#### Image Export Results (`ALPRImageExportResultMicroservice.js`)
- **Primary Role**: Processes and exports ALPR results
- **Interactions**:
  - Receives processed data from the image capture service
  - Coordinates with the database service for result storage
  - Manages the export of final results

### 3. Database Services

#### Database Control (`DatabaseControlMicorservice.js`)
- **Primary Role**: Central database management service
- **Responsibilities**:
  - Handles all database operations
  - Manages data persistence
  - Provides data access to other services
  - Implements database queries and updates

#### Database Migration (`DatabaseMigrationMicoservice.js`)
- **Primary Role**: Handles database schema updates and migrations
- **Responsibilities**:
  - Manages database version control
  - Implements schema changes
  - Ensures data integrity during updates

### 4. File Management Services

#### Auto File Transfer (`AutoFileTransferToSSDMicorservice.js`)
- **Primary Role**: Manages automatic file transfers to SSD storage
- **Interactions**:
  - Works with the export directory control service
  - Coordinates with the database service for transfer logging

#### FTP Service (`FTP.js`)
- **Primary Role**: Handles FTP operations
- **Responsibilities**:
  - Manages file transfers over FTP
  - Provides FTP client functionality to other services

#### File Export Fixer (`FileExportFixer.js`)
- **Primary Role**: Handles file export error recovery and fixes
- **Responsibilities**:
  - Monitors for export issues
  - Implements recovery mechanisms
  - Ensures data integrity in exports

## Service Communication Flow

1. **Image Processing Flow**:
   ```
   ALPRImageCaptureMicroservice
   ↓
   ALPRImageExportDirectoryControlMicorservice
   ↓
   ALPRImageExportResultMicroservice
   ```

2. **Data Storage Flow**:
   ```
   DatabaseControlMicorservice ← → Various Services
   ↑
   DatabaseMigrationMicoservice
   ```

3. **File Management Flow**:
   ```
   AutoFileTransferToSSDMicorservice
   ↓
   FileExportFixer
   ↓
   FTP Service
   ```

## Directory Structure
- `/public`: Contains static assets and client-side resources
- `/views`: Contains view templates for the web interface
- `/v1`: Contains version 1 of the API implementation

## Conclusion
The system follows a microservices architecture where each service is responsible for a specific aspect of the ALPR data processing pipeline. Services communicate through well-defined interfaces, making the system modular and maintainable. The BackendFrontendServer acts as the central coordinator, while specialized services handle specific tasks like image processing, data storage, and file management.
