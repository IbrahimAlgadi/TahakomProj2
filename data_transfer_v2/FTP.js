const ftp = require("basic-ftp");
const securos = require("securos");
// const SftpClient = require("ssh2-sftp-client");
const fs = require("fs");
const path = require("path");

let CONFIG_FILE_PATH = './tahakom_ftp_config2.json';
let config;
let defaultConfig = {
    "startUploading": true,
    "useSFTP": false,
    "ftpSettings": {
        "host": "ftp.example.com",
        "user": "ftpuser",
        "password": "ftppassword",
        "secure": false
    },
    "sftpSettings": {
        "host": "sftp.example.com",
        "user": "sftpuser",
        "password": "sftppassword",
        "port": 22
    }
}

// // Load configuration
// const config = require("./config.json");

// Function to save configuration to file
function saveConfigToFile(config) {
  fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(config, null, 2), 'utf8');
  console.log("Configuration saved to file.");
}

// Function to load the configuration from file
function loadConfigFromFile() {
  if (fs.existsSync(CONFIG_FILE_PATH)) {
    try {
      const fileContent = fs.readFileSync(CONFIG_FILE_PATH, 'utf8');
      const config = JSON.parse(fileContent);
      return { ...defaultConfig, ...config };  // Merge with default config
    } catch (error) {
      console.error("Error reading or parsing config file:", error);
      return defaultConfig;
    }
  } else {
    // If the file does not exist, return the default config and save it to file
    saveConfigToFile(defaultConfig);
    return defaultConfig;
  }
}

// Upload file to FTP server
async function uploadToFtp(localFilePath) {
  const client = new ftp.Client();
  client.ftp.verbose = true;

  try {
    console.log("Connecting to FTP...");
    await client.access({
      host: config.ftpSettings.host,
      user: config.ftpSettings.user,
      password: config.ftpSettings.password,
      secure: config.ftpSettings.secure,
    });
    console.log("Connected to FTP");

    const remoteFilePath = path.basename(localFilePath);
    await client.uploadFrom(localFilePath, remoteFilePath);
    console.log(`[*] File uploaded successfully to FTP: ${remoteFilePath}`);
  } catch (err) {
    console.error("FTP upload failed:", err);
  } finally {
    client.close();
  }
}

// Upload file to SFTP server
// async function uploadToSftp(localFilePath) {
//   const sftp = new SftpClient();

//   try {
//     console.log("Connecting to SFTP...");
//     await sftp.connect({
//       host: config.sftpSettings.host,
//       username: config.sftpSettings.user,
//       password: config.sftpSettings.password,
//       port: config.sftpSettings.port,
//     });
//     console.log("Connected to SFTP");

//     const remoteFilePath = path.basename(localFilePath);
//     await sftp.put(localFilePath, remoteFilePath);
//     console.log(`File uploaded successfully to SFTP: ${remoteFilePath}`);
//   } catch (err) {
//     console.error("SFTP upload failed:", err);
//   } finally {
//     await sftp.end();
//   }
// }

// Main function to upload based on settings
async function uploadFile() {
    // Go to db and select all files that are not synced to FTP

    // Loop through the file and start uploading

    // 
    console.log(config);

    if (config.startUploading) {
      console.log("[*] Start uploading");
      if (config.useSFTP) {
          console.log("Using SFTP for upload...");
          // await uploadToSftp(localFilePath);
      } else {
          console.log("Using FTP for upload...");
          // await uploadToFtp(localFilePath);
      }
    }

    
}

// Modify the config from the script (Optional)
function updateConfig(newConfig) {
  fs.writeFileSync("./config.json", JSON.stringify(newConfig, null, 2), "utf8");
  console.log("Configuration updated");
}

// Example of updating the config
// const newConfig = { ...config, useSFTP: false };
// updateConfig(newConfig);

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

securos.connect(async (core) => {

    // Load the configuration

    while (true) {
  
      config = loadConfigFromFile();

      await uploadFile();

      await sleep(2000);

    }

})
// uploadFile();
