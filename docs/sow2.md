Software Scope Document: Tahakom Traffic Enforcement System

Project: Tahakom Traffic Enforcement System
Client: Tahakom
Date: June 10, 2025

1.0	Introduction
This document outlines the software scope for a comprehensive traffic enforcement and monitoring system, developed in accordance with the technical requirements specified by Tahakom. The system will be based on the SecurOS Video Management System (VMS) platform and its integrated modules, particularly the SecurOS Auto module for license plate recognition. This scope details all required functionalities, performance benchmarks, and operational standards.
2.0 Scope Description
The project aims to deliver an advanced, integrated software solution for automated traffic enforcement. Key capabilities include high-accuracy Automatic License Plate Recognition (ALPR), capture of high-resolution evidentiary images and video, generation of detailed statistical reports, and secure, configurable data management and transfer to Tahakom’s Violation Processing Centre (VPC) and edge infrastructure. The scope also covers a customizable user interface, robust remote monitoring and control, stringent security protocols, and comprehensive documentation and training as mandated by Tahakom1.
3.0 System Capabilities
This section details the functional and performance requirements of the software system as mandated by Tahakom1.
3.1 System Design
•	"The system GUI shall be available in English."
•	"The user interface of the system GUI shall be customizable by Tahakom."
•	"The bidder shall specify if the system GUI can also be made available in Arabic if possible."
3.2 System Performance
•	"The system should be able to create statistical reports for the traffic flow passing it based on operation sessions individually, daily, monthly, yearly, vehicle types and average speed for traffic flow. ( Average speed parameter is optional)"
•	"The system images shall have an embedded data bar to display violation metadata, such as site identifier, date, time (start session - End session), lane and vehicle type etc."
•	"The system shall be able to automatically recognize and read all types of currently used KSA plates and foreign plates. ( foreign plates recognisation is advantageous and an optional requirement )"
•	"The system shall identify the lane of the passing vehicle correctly"
•	"The participant shall provide a tool or application to pull or receive the data from the system to the VPC and Tahakom's edge."
•	"All systems must be capable of generating a report that illustrates the traffic statistics and working hours in the attached format and to be transferred automatically along with captured cases whether via online connectivity or manual collection."
•	"The number of lanes needed for enforcement should be configurable in the system."
•	"List and describe the automated activities to maximize the time and performance."
•	"The bidder shall specify the missing vehicle rate (day and night) assuming correct maintenance, configuration, and setup. The threshold is 2%"
•	"Upon Tahakom's request, the bidder must supply samples of the complete solution as one unit for Tahakom to test under field conditions."
•	"The images/videos shall be stored locally during operation in sequence based on the time of the incident."
•	"The system shall be capable of still image enforcement with the following specifications -: - To allow Tahakom to enforce cases using snapshots captured by CCTV System (e.g. seat belt, mobile usage... etc.). The driver’s face and license plates shall be clearly visible. - The image format should be jpg and the folder format and image name should be configurable to Tahakom standards. - Each passing vehicle should be captured with its own image at the specified trigger line/area. - API for controlling basic functions of the system should be provided, these functions include setting up the time, configuring the FPS rate, requesting a specific image from the system etc.."
•	"The system shall be capable of video stream enforcement with the following specifications -: - To allow Tahakom to enforce cases using a video stream obtained from the CCTV camera (e.g. illegal turn, queue jumping… etc.). Vehicle’s license plates shall be clearly visible. - The video stream should support RTSP. - API for controlling basic functions of the system should be provided, these functions include setting up the time, configuring the FPS rate, requesting a specific image from the system etc."
•	"Image format shall be JPG or any standard convertible image (or as agreed upon)."
•	"Images shall be archivable in batch files (SiteID/Date/Time/image.jpg) (e.g. KSA001\20210417\21\images)."
•	"Image names shall be configurable from the system, for example: (SiteID_Date_Time_Lane_Plate_CameraID.jpg - KSA001_20200310_140001166_3_1111AAA_A.jpg)"
•	"Each captured vehicle should include the below-mentioned details & shall be configurable in the system to be included in embedded databar, image name, or accompanying JSON/XML file with the image. · Site ID · Plate Number (optional) · Lane Number · Timestamp · Direction · Vehicle class (optional)"
•	"The bidder must specify its capabilities to include 5s video (configurable time) for each passing vehicle, along with the captured image."
•	"The system should provide events, alerts and notifications with the capability to turn on or off these notifications."
3.3 Usage Details
•	"The system shall capture and transfer the data (XML, Video and image) to be processed at the Violation Processing Centre (VPC)."
•	"The CCTV System shall capture each passing vehicle (with quality rate of more than 96.5%), can be from front or rear, with the following: Front image: complete and clear view of the vehicle, with high quality to identify: - Vehicle make, model and color. - License plate. - Driver’s behaviour (Seatbelt and Mobile violations etc.) and driver’s face."
•	"Video Compression shall be H.264 MP4, the bidder may also include H.265 as an added feature (configurable)."
3.4 Connectivity
•	"The software should be able to convert the data generated by the equipment into data formats that can be imported into all the IECCS software systems (VPC back offices) operated by Tahakom."
•	"The Systems shall report status and other parameters for monitoring and alerting the VPC, maintenance depot or other operational control center."
•	"The system shall maintain the integrity of the original image/video while transferring."
•	"The system shall have the capability to transfer the data (videos, images, and both) as follows: - Manual download through ethernet cable connected to a laptop. - Auto-transfer to a connected external USB/SSD device. - Data transfer to TAHAKOM’s edge:"
•	"Images and/or videos transferred using the above options shall be in sync, with the following capabilities: - Real-time transfer of data as they are being recorded, instantly. - Scheduled period (the operator shall select the starting time and end time of the data being transferred)."
3.5 Storage
•	"For data transfer using external USB/SSD, the bidder must specify the capability to upload the data in a continuous loop, such that when the USB/SSD is removed and then plugged again after some time, the data will start uploading automatically from where it has stopped the last time."
•	"The system shall be capable of overwriting old data once the storage is full."
•	"All packages/files/photos/videos shall use lossless algorithms for compression and encryption."
•	"The packages/files/photos/videos shall be encrypted for storage and transfer and should keep integrity while transferring."
•	"NVR shall be capable to link more than one CCTV and receive data concurrently."
•	"The system shall be able to transfer images with meta-data information to external USB drive automatically."
•	"The bidder must specify the available methods/protocols to transfer captured images from the camera/NVR to TAHAKOM’s edge (e.g. secure FTP, API tools… etc.) & provide TAHAKOM’s edge with a secure real-time stream from the camera (e.g. RTSP, RTMPS)."
•	"The bidder must specify its capabilities to transfer the captured data to a web-based cloud."
3.6 Calibration
•	"The following should be configurable in the system: - Auto test picture to be taken automatically as per a pre-set time, date, and frequency with and without flashing - Manual test picture to be taken manually with and without flashing - Enter and modify enforcement parameters"
•	"The bidder shall specify the recalibration period for the components."
•	"The bidder shall specify whether recalibration can be done remotely and share the recalibration procedure."
4.0 Training, Support, and Security
This section covers the requirements for documentation, remote operation, and system security.
4.1 Documentation
•	"The Bidder shall provide installation and operation manuals and videos for the provided devices and software including operation manuals, installation manuals, maintenance manuals, configuration manuals, commissioning manuals, detailed specifications of the system, detailed SW manual, error code list and description and how to fix it, spare parts list, focus procedure and recommended tools, recommended tools and equipment's for testing, test method, preventive maintenance procedures and schedule, fault finding procedure and recommended tools, sensor accessories list, circuit diagram and block diagram of the system and flash, datasheet of the components, calibration recommendation, FAT protocol, provide all the SW for the product which includes (the operation SW, Test SW, configuration SW and the alignment SW ...etc.)."
•	"The Bidder shall provide data sheets including the full specifications for all major items."
•	"The bidder shall include the documents and a test plan from his side to prove the system response in addition to all capabilities and futures of it as stated in the documents to be combined in the Tahakom test plan for the project."
•	"Bidder shall mention the reporting and documentation responsibilities related to project execution needed during the technical proposal submission."
•	"The Bidder, as part of his reporting and documentation responsibilities, shall update all related Tahakom's project databases and tools including but not limited to: EO Project Management methodology documentation, and Field Acceptance with all needed information as per the nature of the project and with the directions received from Tahakom."
4.2 Remote Online Operation Centre
•	"All systems must be linked and integrated with an operation monitoring center that allows remote commanding and controlling systems (reboot, set-up auto testing, modify enforcement parameters, upgrade, reviewing and inspecting enforcement picture quality, cases count)."
•	"All systems must be displayed on an operation monitoring center dashboard where their operational status is color-indicated on a map and on a list."
•	"Remote operation center platform must allow fast review of systems’ camera view by clicking on a listed or mapped system."
•	"Operation monitoring center should allow addition and removal of systems while keeping a log file of all performed activities."
•	"Operation monitoring center must have multiple user layers with adjustable rolls and authorization (Inspector-operator, team leader, supervisor-admin)."
•	"All systems must send automatic status reports as per pre-defined frequency."
•	"All systems must define any system’s abnormality and flag a notification to the operation monitoring center."
•	"The Bidder shall share details of the remote online operations centre platform including any videos or documents demonstrating functionality."
•	"XML file shall be auto generated to prove operation hours daily. XML file shall state operation hours with the number of errors. Error code shall not affect operation hours. XML file shall report error code, start & end time and number of violations created. XML format should be provided early for testing."
•	"In case the system goes down, a dashboard should send notifications to the listed users to tell the current state of the system in real-time."
•	"The system storage and cameras should be accessible using a web browser, HTTP/HTTPS and FTP/FTPS in real-time."
•	"All systems must keep a log of their operational status and should not be depletable."
•	"Online operation center platform must allow integration with other unified operation platforms."

4.3 Security
•	"The System shall be able to encrypt the videos/images while storing and transferring."
•	"The bidder should detail what cryptography is supported by the system. The cryptography setting should be configurable including key length by authorized personnel."
•	"The access control shall include user access log and password protection, SSL/TLS, Basic and Digest Authentication and access to the system data or setting shall require secure authentication."
•	"The CCTV System shall provide encryption functionality (on\off)."
•	"The Bidder should include details about the logical and physical security features supported by the provided system in the proposal."
•	"The bidder should detail what cryptography is supported by the system. The cryptography setting should be configurable including key length by authorized personnel."
•	"The system should be capable of verifying digital signatures and validating certificates."
•	"The system should be capable of generating key pairs and storing encryption keys."
•	"The system should support multiple authorization levels for user’s login into the system. The bidder should detail different access levels supported by the system."
•	"The system should securely store passwords, device identity, and other authentication data and mask information during the authentication process. The system should be able to disable accounts after a certain period of inactivity and this period should be configurable."
•	"The system must lockout after a specific number of unsuccessful login attempts and these settings must be configurable."
•	"The system must provide login report with the date, time type of access, successful/unsuccessful etc."

