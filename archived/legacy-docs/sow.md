Description of the Operation
The Automatic Number Plate Recognition (ANPR) system is designed to automatically detect and recognize vehicle license plates from camera feeds. It identifies both KSA and foreign plates, captures vehicles from the front or rear, and can detect vehicles even without a license plate if more than 50% of the vehicle is visible. The system is engineered for high performance, with a compliance threshold of a 2% missing vehicle rate, and provides data for each detected vehicle, including multiple images and metadata.
Screenshot Placeholder
 
 
Properties Table
Property	Description
Vehicle Detection	The system reliably detects vehicles, including those without a license plate if over 50% of the vehicle is visible in the camera's Field of View (FoV).
Plate Recognition	Automatically recognizes all currently used KSA plate types. Recognition of foreign plates is included as an advantageous, optional feature.
Capture Capability	Supports both front and rear vehicle capture to ensure comprehensive data collection.
Lane Identification	The system correctly identifies the specific lane in which a vehicle is traveling. Lane naming is configurable within the system.
Performance Benchmark	Designed to achieve a maximum missing vehicle rate of 2% during both day and night operations, assuming correct installation, configuration, and maintenance.
Evidentiary Images	For each detected vehicle, the system provides three high-resolution JPG images: one of the vehicle license plate, one of the driver, and one overview image.
Real-time Processing	The system maintains real-time processing capabilities with minimal latency and can handle data from multiple cameras concurrently.

Notes
•	Recognition of foreign plates is considered an advantageous but optional requirement.
•	The system's ability to identify driver behavior, such as seatbelt use or mobile phone usage, from still images is a specified requirement.
Transfer & Storage – Modes, Way of Operation (images + video)
Description of the Operation
The system provides a robust and flexible data transfer and storage architecture. It supports multiple transfer modes, including automatic, manual, and scheduled transfers to various destinations like USB/SSD devices and FTP/SFTP servers. Storage is highly configurable, with customizable folder structures, automated data retention policies (FIFO), and real-time capacity monitoring. Video is stored in ISSVD format and transcoded to MP4 for external transfer.
Screenshot Placeholder
 
Properties Table
Property	Description
Storage Configuration	The root storage directory is user-definable. The archival path structure is customizable using components like SITE_ID, DATE, and TIME (e.g., SiteID/Date/Time/image.jpg).
Retention Policy	Implements a First-In, First-Out (FIFO) policy, automatically deleting the oldest data when the configured storage limit is reached.
Capacity Monitoring	A real-time storage overview displays used space versus maximum capacity (e.g., "150 GB / 200 GB").
Video Storage	Video is stored locally in a proprietary ISSVD format and is transcoded to MP4 upon transfer to external storage. The length of video clips for transfer is configurable, with a default option of 15 minutes, 10min, 5min.
Manual Transfer	Users can manually initiate a transfer job to a selected USB drive for a specified date and time range. A summary of file count and size is provided before starting the job.
Automatic Transfer	Supports continuous loop transfer to a connected USB/SSD. The system can automatically detect a device and begin the transfer. It can be configured to resume from the last transfer point or from the time the USB was inserted.
Scheduled Transfer	Allows configuration of scheduled transfers to a USB drive at specific times.
FTP/SFTP Transfer	Enables automatic, manual, or scheduled data transfer to a remote server using FTP or SFTP protocols, with configurable rate limiting.
Data Integrity	The system uses lossless algorithms for compression and ensures the integrity of the original image/video is maintained during transfer.

Notes
•	The system includes a TODO item to enable automatic transfer to any connected external drive, not just USB drives.
•	For automatic USB transfers, a TODO exists to create settings for a continuous loop, allowing the transfer to start from the last transferred file or from the beginning.
•	It is assumed that Tahakom will provide the FTP server, which can be connected to the NVR as a network share for data export.
Reports & Live Dashboard Monitoring
Description of the Operation
The system provides comprehensive reporting and live monitoring capabilities through its dashboard and API endpoints. It generates automatic status reports and daily operational logs in XML/JSON formats, detailing working hours and any errors. The system is designed to define and flag any system abnormalities, sending notifications to a central monitoring center to ensure high availability and prompt issue resolution.




 

Properties Table
Property	Description
Automatic Status Reports	The system sends automatic status reports at pre-defined frequencies to a monitoring center. An API endpoint for status reports is available.
Daily Operation Report	An XML/JSON file is auto-generated daily to prove system operation hours. This report includes the number of errors, error codes, start/end times, and the number of violations created[1]. These reports have a 7-day retention period.

System Abnormality Notifications	The system is designed to identify any operational abnormality and flag a notification to the operation monitoring center. Toast notifications on the UI alert users to events or errors.
Operational Status Log	A non-depletable log of the system's operational status is maintained at all times.
Live Monitoring	The Process Monitor page provides a live grid of monitored system processes, showing real-time CPU and memory usage via a WebSocket connection.
Statistical Reporting	The dashboard provides statistical reports on traffic flow, including vehicle counts and file generation success/failure rates, aggregated by hour, day, month, or year.

Notes
•	The format for the daily XML operational report must be provided early for testing purposes.
•	While the system reports error codes, these codes do not affect the calculation of total operation hours.
Encryption – Features and Modes of Operation
Description of the Operation
The system implements a robust, configurable encryption framework to secure data both in storage and during transfer. It uses industry-standard AES-256 for file encryption and RSA for key protection. Encryption can be enabled or disabled for various operations, providing flexibility while maintaining data security and integrity.
 
Properties Table
Property	Description
Configurable Encryption	Encryption functionality can be turned on or off for both stored files and data transfers.
File Encryption Standard	The primary algorithm used is AES-256 CBC (256-bit key, 128-bit IV with key rotation) for all file encryption operations. 
Key Protection	AES keys are themselves protected via RSA encryption. The system uses a public key (.pem or .crt format) provided by Tahakom to encrypt a randomly generated AES key.
Encryption Process	1. Three images per transaction are encrypted using a randomly generated AES key. 
2. This AES key is stored in a plain text .dat file. 
3. The .dat file is then encrypted using Tahakom's public RSA key. 
4. The final package consists of the 3 encrypted images + the encrypted .dat file.
Metadata Encryption	The system provides an option to encrypt file metadata in addition to the file content itself.
Key Management	Supports multiple key management methods, including manual key entry, certificate-based (.pem, .crt), and Key Management Service (KMS).
Integrity	All encryption and compression algorithms used are lossless, ensuring data integrity is maintained during transfers.

Notes
•	For decryption, Tahakom uses its private RSA key to decrypt the .dat file, which reveals the AES key. This AES key is then used to decrypt the original image files.
•	The system must be capable of verifying digital signatures and validating certificates as part of its security features.
Remote Monitoring
Description of the Operation
The system is designed to be fully integrated with a remote operations center, allowing for comprehensive monitoring and control. Authorized users can remotely view system status, access camera feeds, modify parameters, and perform administrative tasks like rebooting the system. The platform supports multiple user levels with distinct, adjustable permissions.
Screenshot Placeholder
Mockup of a remote operations center dashboard showing a map with color-coded system statuses
Properties Table
Property	Description
Centralized Dashboard	A monitoring center dashboard displays the operational status of all connected systems, using color-coded indicators on both a map and a list.
Remote Control	Provides remote command and control capabilities, including system reboot, modification of enforcement parameters, and system upgrades via RDP.
Live Camera View	The remote platform allows operators to quickly review a system's live camera feed by clicking on its icon on the map or list.
System Health Monitoring	The Process Monitor page allows for live monitoring of system processes, including CPU and memory consumption, to diagnose performance issues remotely.
User Access Control	The operations center supports multiple user layers with adjustable roles and authorizations (e.g., Inspector-operator, team leader, supervisor-admin).
Activity Logging	The platform keeps a log file of all performed activities, including the addition and removal of systems.

Notes
•	The remote operation center platform must be designed to allow for integration with other unified operation platforms.
•	The bidder is required to share detailed documents or videos demonstrating the functionality of the remote online operations center platform.
VPC Integration
Description of the Operation
The system is built to integrate seamlessly with Tahakom's Violation Processing Centre (VPC) and edge infrastructure. Data transmission is primarily handled via secure file transfer protocols, ensuring that captured images, videos, and metadata are delivered reliably for processing. The system handles data format conversion to ensure compatibility with Tahakom's software systems.
 Properties Table
Property	Description
Primary Transfer Protocol	Data transmission to the VPC is conducted through FTP/SFTP.
Data Synchronization	The system ensures real-time synchronization with the VPC and includes robust error handling and retry mechanisms to manage connectivity issues.
Data Formatting	The software converts the data it generates (images, video) into formats, such as JPEG and MP4, that can be imported into the VPC back-office systems.
Data Pull Mechanism	The system push data via (FTP/SFTP) to the VPC and Tahakom's edge to pull or receive data from the enforcement system, VPC should have an FTP Server.

Notes
•	The scope includes the assumption that Tahakom will provide an FTP server that can be connected to the NVR as a network share for data export.
Dashboard – With Screenshots & Key Parameters Overview
Description of the Operation
The dashboard serves as the central user interface for monitoring system performance and traffic statistics. It provides an at-a-glance overview of key performance indicators (KPIs) through statistics cards and offers deeper insights through interactive charts and filterable data tables. The interface is designed for ease of use, with controls for refreshing data, changing time-based views, and exporting reports.
Screenshot Placeholder

  
 
Properties Table
Property	Description
Statistics Cards	Display key KPIs at a glance: Total Vehicles, Total Files, Avg. Speed, Success Rate, and Total Size of processed files.
View Toggle	Allows switching the data aggregation period between Hourly, Daily, Monthly, and Yearly views.
Dynamic Filters	A filter section allows users to refine data shown across the dashboard by parameters like date/time ranges and site-specific controls.
Interactive Charts	Provides multiple visualizations for data analysis:
- Files Processing Overview (Line chart)
- Success Rate (Pie chart)
- File Size Distribution (Bar chart)
- Vehicle Count Trend (Area chart)
Export Options	A dropdown menu allows the user to export the displayed data and reports in various formats, including PDF, JSON, and XML.
Data Refresh	A Refresh Button allows the user to manually reload all dashboard data to get the latest statistics.

Notes
•	The average speed parameter displayed on the dashboard is considered an optional requirement.
•	Daily operation reports are available for export as JSON/XML and are retained for 7 days.
ANPR & NVR Conditions
Description of the Operation
Achieving optimal performance from the ANPR and NVR systems requires adherence to specific installation and environmental conditions. This includes strategic camera positioning to maximize coverage and minimize occlusions, as well as ensuring the NVR hardware operates within its specified thermal limits to prevent performance degradation.
Screenshot Placeholder
 
 
Properties Table
Property	Description
Camera Positioning	Cameras must be positioned strategically for lane-specific monitoring to eliminate blind spots.
Height and Angle	The system requires specific camera height and angle configurations to be optimized for the intended coverage zones.
Overlap Zones	The installation plan must include proper management of overlap zones between cameras to ensure comprehensive area coverage without gaps.
NVR Environment	The NVR unit must be located in a properly cooled cabinet to maintain the CPU temperature within the manufacturer's required operational range.
Maintenance	The stated performance benchmarks assume that correct maintenance, configuration, and setup procedures are followed.

Notes
•	All camera allocation and positioning must adhere to ISS approval standards.
•	The bidder is required to specify the recalibration period for system components and whether it can be done remotely.
Documentation
Description of the Operation
A comprehensive documentation package and set of training materials will be provided to ensure that Tahakom personnel can effectively install, operate, configure, and maintain the system. The documentation will cover all hardware and software components in detail, from high-level diagrams to specific error code lists.

Properties Table
Property	Description
Technical Manuals	Includes Installation, Operation, Configuration, and Maintenance manuals with step-by-step procedures and troubleshooting guides.
System Specifications	Detailed technical specifications for all system components, including datasheets for all major items and circuit/block diagrams.
Procedural Guides	Includes fault-finding procedures, preventive maintenance schedules, and focus/calibration procedures.
Training Materials	Includes user training videos, operation tutorials with practical examples, configuration guides with best practices, and error resolution guides.
Test Plan	The bidder must provide a test plan to demonstrate and prove all system capabilities and features as stated in the scope documents.

Notes
•	The bidder is required to provide a complete list of error codes, their descriptions, and instructions on how to fix them.
•	The documentation deliverable is extensive, covering everything from software manuals to spare parts lists and recommended testing tools.
QA / Project Timeline/Milestones
Description of the Operation
The quality assurance process involves rigorous testing in real-world conditions to benchmark performance and verify compliance with all specified requirements. A key project milestone is the post-installation fine-tuning period, which is essential for optimizing the system's performance in its final operational environment.
1.	Pre-field test stage where we test the features after we receive the server
a.	Civil work and camera installation.
b.	Camera position as per ISS recommendation.
c.	Server cabinet to be ready.
d.	ISS to install software in server within 5 business days.
e.	Test and validate features 1 week with full access to site without any limitations.
f.	Fine tuning.
g.	Complete internal testing
2.	Tahakom to provide location for field testing. 
3.	Civil work and install camera in field as per ISS recommendation.
4.	ISS to Install software within 5 business days.
5.	Tahakom to start Performance bench marking and QA.
Critical Dependencies
•	Server Reception → Civil work can begin
•	Civil Work Complete → Camera positioning per ISS standards
•	Camera Installation → Server cabinet preparation
•	Cabinet Ready → Software installation (5 business days)
•	Software Installed → Feature validation (1 week with full access)
•	Pre-test Complete → Field location provided by Tahakom
•	Field Installation → Final software deployment (5 business days)
•	System Operational → Performance benchmarking by Tahakom
Tahakom Traffic Enforcement System - Testing Phases and Procedures
Testing Timeline and Milestones Table
Phase	Stage	Activity	Responsibility	Duration	Prerequisites	Deliverables
1	Pre-Test Stage	Server Reception & Setup	Abana	TBD		
1.a	Infrastructure Setup	Civil work and camera installation	ISS + Abana	TBD	Server received	Installed cameras
1.b	Camera Positioning	Camera position as per ISS recommendation	ISS+Abana	TBD	Civil work complete	Optimized camera angles
1.c	Cabinet Preparation	Server cabinet to be ready	Abana	TBD	Infrastructure ready	Cooled server cabinet
1.d	Software Installation	ISS to install software in server	ISS	5 business days	Cabinet ready	Functional software
1.e	Feature Validation	Test and validate features	ISS + Tahakom	1 week	Software installed, full site access	Validated features
1.f	System Optimization	Fine tuning	ISS	TBD	Initial testing complete	Optimized system
1.g	Internal QA	Complete internal testing	ISS	TBD	Fine tuning complete	Test results
2	Field Testing Setup	Location Preparation				
2	Site Preparation	Tahakom to provide location for field testing	Tahakom	TBD	Pre-test complete	Test site ready
3	Field Installation	Civil work and install camera in field as per ISS recommendation	ISS + Abana	TBD	Location provided	Field cameras installed
4	Software Deployment	ISS to Install software	ISS	5 business days	Field installation complete	Operational system
5	Performance Testing	Tahakom to start Performance benchmarking and QA	Tahakom	TBD	Software deployed	Performance metrics
Key Milestones Summary
Milestone	Timeline	Critical Success Factors
Software Installation (Pre-field-test)	2-3 weeks	Server cabinet ready, ISS team available
Feature Validation	1 week	Full site access without limitations
Camera Installation (Field)	-	Field cameras installed and positioned
Software Installation (Field)	5 business days	System setup and configuration completeness
Performance Benchmarking	TBD	System fully operational, Tahakom QA team ready
Quality Assurance Requirements
•	ISS Fine-tuning Period: 5 business days after initial installation
•	Feature Validation: 1 week with unrestricted site access
•	Performance Evaluation: Manual vehicle count (200 daytime + 200 nighttime samples)
•	Compliance Checklist: Manual transfer, scheduled transfer, reports, encryption functionality


Properties Table
Property	Description
Field Testing	The system will undergo field testing with a sample unit provided to Tahakom to test under real-world conditions.
Performance Benchmarking	The QA process includes performance benchmarking and validation under various environmental conditions to ensure reliability.
Fine-Tuning	The ISS team requires 5 business days after the initial installation for system fine-tuning and optimization.
Compliance Verification	Involves verification against Tahakom's technical requirements and may include recalibration procedures to ensure compliance.

Notes
•	The bidder is required to update all related Tahakom project management databases and tools as part of their reporting responsibilities during project execution.
Compliance & Performance Evaluation
Description of the Operation
System compliance and performance will be evaluated using a clearly defined, evidence-based procedure. The accuracy of the ANPR system will be measured by manually comparing a large sample of video footage against the system's automated output. A feature checklist will also be used to confirm that all specified functionalities have been delivered as required.
Screenshot Placeholder
[Image of a sample checklist used for feature compliance evaluation]
Properties Table
Property	Description
Evaluation Procedure	The primary evaluation procedure involves a manual vehicle count based on video footage, which is then compared against the system's exported data report.
Sampling Method	A total of 400 samples will be used for the evaluation: 200 samples from daytime footage and 200 samples from nighttime footage.
Accuracy Target	The system's performance will be evaluated against the compliance threshold of a 2% missing vehicle rate.
Feature Compliance	A checklist will be used to ensure that all key features are included and functional. This includes, but is not limited to, manual transfer, scheduled transfer, reports, and encryption.
Governing Standards	The system must comply with all Tahakom technical requirements and specifications, as well as ISS approval standards for quality assurance.

Notes
•	The evaluation process is designed to be thorough, covering both quantitative performance (accuracy) and qualitative feature completeness.
 
