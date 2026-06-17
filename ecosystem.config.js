let SCRIPT_PATH = __dirname + "\\";
let NODE_PATH = "C:\\Program Files (x86)\\ISS\\SecurOS\\bin64\\node.js\\bin\\node.exe";

let commonConfig = {
  interpreter: NODE_PATH,
  watch_delay: 1000,
  ignore_watch: [SCRIPT_PATH + "node_modules"],
  env: {
    "NODE_ENV": "production"
  },
  exec_mode: "fork",
  no_daemon: false,
  // detached: true,
  windowsHide: true,

  // Add log file paths
  combine_logs: true,
  log_date_format: "YYYY-MM-DD HH:mm:ss",

  // Prevent infinite restarts
  max_restarts: 5,
  min_uptime: 100,       // in milliseconds
  restart_delay: 3000,     // in milliseconds
  stop_exit_codes: [0],
  exp_backoff_restart_delay: 100,
  interpreter_args: "--require " + SCRIPT_PATH + "startup.js",
};

module.exports = {
  apps: [
    // Microservices
    {
      name: "ConfigStateServiceRedis",
      script: SCRIPT_PATH + "ConfigStateServiceRedis.js",
      watch: [SCRIPT_PATH + "ConfigStateServiceRedis.js"],
      out_file: SCRIPT_PATH + "logs\\ConfigStateServiceRedis-out.log",
      error_file: SCRIPT_PATH + "logs\\ConfigStateServiceRedis-error.log",
      dependencies: [],
      ...commonConfig,
    },
    {
      name: "monitorConnectedExternalDrivesMicroservice",
      script: SCRIPT_PATH + "monitorConnectedExternalDrivesMicroservice.js",
      watch: [SCRIPT_PATH + "monitorConnectedExternalDrivesMicroservice.js"],
      out_file: SCRIPT_PATH + "logs\\monitorConnectedExternalDrivesMicroservice-out.log",
      error_file: SCRIPT_PATH + "logs\\monitorConnectedExternalDrivesMicroservice-error.log",
      ...commonConfig,
      dependencies: [],
    },
    {
      name: "monitorSpecialProcessesMicroservice",
      script: SCRIPT_PATH + "monitorSpecialProcessesMicroservice.js",
      watch: [SCRIPT_PATH + "monitorSpecialProcessesMicroservice.js"],
      out_file: SCRIPT_PATH + "logs\\monitorSpecialProcessesMicroservice-out.log",
      error_file: SCRIPT_PATH + "logs\\monitorSpecialProcessesMicroservice-error.log",
      ...commonConfig,
      dependencies: [],
    },
    {
      name: "monitorISSMediaFilesOptimizedMicroservice",
      script: SCRIPT_PATH + "monitorISSMediaFilesOptimizedMicroservice.js",
      watch: [SCRIPT_PATH + "monitorISSMediaFilesOptimizedMicroservice.js"],
      out_file: SCRIPT_PATH + "logs\\monitorISSMediaFilesOptimizedMicroservice-out.log",
      error_file: SCRIPT_PATH + "logs\\monitorISSMediaFilesOptimizedMicroservice-error.log",
      dependencies: ["ConfigStateServiceRedis", "DriveStateServiceRedis", "monitorConnectedExternalDrivesMicroservice"],
      ...commonConfig,
    },
    {
      name: "autoVideoTransferEDAMicroservice",
      script: SCRIPT_PATH + "refactored_autoVideoTransferEDAMicroservice.js",
      watch: [SCRIPT_PATH + "refactored_autoVideoTransferEDAMicroservice.js"],
      out_file: SCRIPT_PATH + "logs\\refactored_autoVideoTransferEDAMicroservice-out.log",
      error_file: SCRIPT_PATH + "logs\\refactored_autoVideoTransferEDAMicroservice-error.log",
      dependencies: ["ConfigStateServiceRedis", "monitorISSMediaFilesOptimizedMicroservice"],
      ...commonConfig,
    },
    {
      name: "autoFtpVideoTransferService",
      script: SCRIPT_PATH + "autoFtpVideoTransferService.js",
      watch: [SCRIPT_PATH + "autoFtpVideoTransferService.js"],
      out_file: SCRIPT_PATH + "logs\\autoFtpVideoTransferService-out.log",
      error_file: SCRIPT_PATH + "logs\\autoFtpVideoTransferService-error.log",
      dependencies: ["ConfigStateServiceRedis", "monitorISSMediaFilesOptimizedMicroservice"],
      ...commonConfig,
    },
    // {
    //   name: "FileTransferRedisService",
    //   script: SCRIPT_PATH + "FileTransferRedisService.js",
    //   watch: [SCRIPT_PATH + "FileTransferRedisService.js"],
    //   out_file: SCRIPT_PATH + "logs\\FileTransferRedisService-out.log",
    //   error_file: SCRIPT_PATH + "logs\\FileTransferRedisService-error.log",
    //   dependencies: ["autoVideoTransferMicroservice","monitorISSMediaFilesOptimizedMicroservice","ConfigStateServiceRedis", "DriveStateServiceRedis", "monitorConnectedExternalDrivesMicroservice"],
    //   ...commonConfig,
    // },
    {
      name: "autoUSBImageTransferService",
      script: SCRIPT_PATH + "autoUSBImageTransferService.js",
      watch: [SCRIPT_PATH + "autoUSBImageTransferService.js"],
      out_file: SCRIPT_PATH + "logs\\autoUSBImageTransferService-out.log",
      error_file: SCRIPT_PATH + "logs\\autoUSBImageTransferService-error.log",
      dependencies: ["autoVideoTransferMicroservice","monitorISSMediaFilesOptimizedMicroservice","ConfigStateServiceRedis", "DriveStateServiceRedis", "monitorConnectedExternalDrivesMicroservice"],
      ...commonConfig,
    },
    {
      name: "autoFTPImageTransferService",
      script: SCRIPT_PATH + "autoFTPImageTransferService.js",
      watch: [SCRIPT_PATH + "autoFTPImageTransferService.js"],
      out_file: SCRIPT_PATH + "logs\\autoFTPImageTransferService-out.log",
      error_file: SCRIPT_PATH + "logs\\autoFTPImageTransferService-error.log",
      dependencies: ["autoVideoTransferMicroservice","monitorISSMediaFilesOptimizedMicroservice","ConfigStateServiceRedis", "DriveStateServiceRedis", "monitorConnectedExternalDrivesMicroservice"],
      ...commonConfig,
    },

    // Big Services
    
    {
      name: "DashboardReportingBackend",
      script: SCRIPT_PATH + "DashboardReportingBackend.js",
      watch: [SCRIPT_PATH + "DashboardReportingBackend.js", SCRIPT_PATH + "routes/"],
      out_file: SCRIPT_PATH + "logs\\DashboardReportingBackend-out.log",
      error_file: SCRIPT_PATH + "logs\\DashboardReportingBackend-error.log",
      ...commonConfig,
      dependencies: ["monitorConnectedExternalDrivesMicroservice"],
    },
  ]
} 

