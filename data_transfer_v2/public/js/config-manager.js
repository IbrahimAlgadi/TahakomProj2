// Configuration Manager
class ConfigManager {
    constructor() {
        this.config = null;
        this.loadConfig();
    }

    // Load configuration from server
    async loadConfig() {
        try {
            const response = await fetch('/api/config');
            this.config = await response.json();
            this.applyConfig();
        } catch (error) {
            console.error('Failed to load configuration:', error);
        }
    }

    // Save configuration to server
    async saveConfig() {
        try {
            const response = await fetch('/api/config', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(this.config)
            });
            const result = await response.json();
            if (!result.success) {
                throw new Error(result.error);
            }
            return true;
        } catch (error) {
            console.error('Failed to save configuration:', error);
            return false;
        }
    }

    // Apply configuration to UI elements
    applyConfig() {
        // Storage Settings
        this.applyStorageSettings();
        // Encryption Settings
        this.applyEncryptionSettings();
        // Path Structure
        this.applyPathStructure();
        // Auto Transfer Settings
        this.applyAutoTransferSettings();
        // FTP Settings
        this.applyFTPSettings();
    }

    // Apply storage settings to UI
    applyStorageSettings() {
        const storage = this.config.storage;
        // Storage directory
        document.querySelector('#settingsModal input[type="text"]').value = storage.directory;
        // Maximum storage
        document.querySelector('#settingsModal input[type="number"]').value = storage.maxCapacity;
        // Retention policy
        document.querySelector('#fifo').checked = storage.retentionPolicy === 'fifo';
    }

    // Apply encryption settings to UI
    applyEncryptionSettings() {
        const encryption = this.config.encryption;
        // Enable/disable encryption
        document.querySelector('#useEncryption').checked = encryption.enabled;
        document.querySelector('#noEncryption').checked = !encryption.enabled;
        // Algorithm
        document.querySelector('#encryptionOptions select:first-child').value = encryption.algorithm;
        // Key management
        document.querySelector('#encryptionOptions select:nth-child(2)').value = encryption.keyManagement;
        // Metadata encryption
        document.querySelector('#encryptMetadata').checked = encryption.encryptMetadata;
    }

    // Apply path structure to UI
    applyPathStructure() {
        const pathStructure = this.config.pathStructure;
        // Update path components order
        const container = document.querySelector('.path-components');
        pathStructure.components.forEach(component => {
            const item = container.querySelector(`[data-value="${component}"]`);
            if (item) {
                container.appendChild(item);
                // Set separator
                item.querySelector('select').value = pathStructure.separators[component];
            }
        });
        // Update formats
        const dateItem = container.querySelector('[data-value="DATE"]');
        if (dateItem) {
            dateItem.querySelector('select').value = pathStructure.formats.DATE;
        }
        const timeItem = container.querySelector('[data-value="TIME"]');
        if (timeItem) {
            timeItem.querySelector('select').value = pathStructure.formats.TIME;
        }
    }

    // Apply auto transfer settings to UI
    applyAutoTransferSettings() {
        const autoTransfer = this.config.autoTransfer;
        // Drive selection
        const driveSelect = document.querySelector('select[disabled]');
        if (driveSelect) {
            driveSelect.value = autoTransfer.drive;
        }
        // Encryption settings
        const encryption = autoTransfer.encryption;
        const container = document.querySelector('#auto-transfer-form');
        if (container) {
            container.querySelector('#useEncryption').checked = encryption.enabled;
            container.querySelector('#noEncryption').checked = !encryption.enabled;
            container.querySelector('select[value="' + encryption.algorithm + '"]').selected = true;
            container.querySelector('select[value="' + encryption.keyManagement + '"]').selected = true;
            container.querySelector('#encryptMetadata').checked = encryption.encryptMetadata;
        }
    }

    // Apply FTP settings to UI
    applyFTPSettings() {
        const ftp = this.config.ftpTransfer;
        if (!ftp) return;
        
        const form = document.querySelector('#ftp-form');
        if (form) {
            // Protocol - handle both current ftps and legacy sftp
            if (ftp.protocol) {
                let protocol = ftp.protocol;
                // Handle legacy sftp configurations by converting to ftps
                if (protocol === 'sftp') protocol = 'ftps';
                
                const protocolSelect = form.querySelector('#protocolSelect');
                if (protocolSelect) protocolSelect.value = protocol;
            }
            // Host
            if (ftp.host) {
                const hostInput = form.querySelector('input[placeholder="Enter server host"]');
                if (hostInput) hostInput.value = ftp.host;
            }
            // Port
            if (ftp.port) {
                const portInput = form.querySelector('input[placeholder="21"]');
                if (portInput) portInput.value = ftp.port;
            }
            // Directory
            if (ftp.remoteDirectory) {
                const dirInput = form.querySelector('input[placeholder="/path/to/directory"]');
                if (dirInput) dirInput.value = ftp.remoteDirectory;
            }
            // Username
            if (ftp.username) {
                const userInput = form.querySelector('input[placeholder="Enter username"]');
                if (userInput) userInput.value = ftp.username;
            }
            // Password
            if (ftp.password) {
                const passInput = form.querySelector('input[type="password"]');
                if (passInput) passInput.value = ftp.password;
            }
        }

        // Apply transfer schedule settings
        if (ftp.transferSchedule) {
            const schedule = ftp.transferSchedule;
            
            // Set schedule type
            if (schedule.scheduleType) {
                const scheduleTypeInput = document.querySelector(`input[name="scheduleType"][value="${schedule.scheduleType}"]`);
                if (scheduleTypeInput) {
                    scheduleTypeInput.checked = true;
                    // Trigger change event to show/hide schedule configuration
                    scheduleTypeInput.dispatchEvent(new Event('change'));
                }
            }
            
            // Set schedule frequency
            if (schedule.scheduleFrequency) {
                const frequencyInput = document.querySelector(`input[name="scheduleFrequency"][value="${schedule.scheduleFrequency}"]`);
                if (frequencyInput) {
                    frequencyInput.checked = true;
                    // Trigger change event to show/hide day selection
                    frequencyInput.dispatchEvent(new Event('change'));
                }
            }
            
            // Set day of week
            if (schedule.dayOfWeek) {
                const daySelect = document.querySelector('#dayOfWeek');
                if (daySelect) daySelect.value = schedule.dayOfWeek;
            }
            
            // Set transfer time
            if (schedule.transferTime) {
                const timeSelect = document.querySelector('#transferTime');
                if (timeSelect) timeSelect.value = schedule.transferTime;
            }
            
            // Set data type
            if (schedule.dataType) {
                const dataTypeInput = document.querySelector(`input[name="dataType"][value="${schedule.dataType}"]`);
                if (dataTypeInput) dataTypeInput.checked = true;
            }
        }
    }

    // Update configuration from UI
    updateFromUI() {
        // Storage Settings
        this.updateStorageSettings();
        // Encryption Settings
        this.updateEncryptionSettings();
        // Path Structure
        this.updatePathStructure();
        // Auto Transfer Settings
        this.updateAutoTransferSettings();
        // FTP Settings
        this.updateFTPSettings();
    }

    // Update storage settings from UI
    updateStorageSettings() {
        this.config.storage = {
            directory: document.querySelector('#settingsModal input[type="text"]').value,
            maxCapacity: parseInt(document.querySelector('#settingsModal input[type="number"]').value),
            retentionPolicy: document.querySelector('#fifo').checked ? 'fifo' : 'custom'
        };
    }

    // Update encryption settings from UI
    updateEncryptionSettings() {
        this.config.encryption = {
            enabled: document.querySelector('#useEncryption').checked,
            algorithm: document.querySelector('#encryptionOptions select:first-child').value,
            keyManagement: document.querySelector('#encryptionOptions select:nth-child(2)').value,
            encryptMetadata: document.querySelector('#encryptMetadata').checked
        };
    }

    // Update path structure from UI
    updatePathStructure() {
        const components = [];
        const separators = {};
        const formats = {};

        document.querySelectorAll('.path-item').forEach(item => {
            const component = item.dataset.value;
            components.push(component);
            separators[component] = item.querySelector('select').value;
            
            if (component === 'DATE' || component === 'TIME') {
                formats[component] = item.querySelector('select').value;
            }
        });

        this.config.pathStructure = {
            components,
            separators,
            formats
        };
    }

    // Update auto transfer settings from UI
    updateAutoTransferSettings() {
        const container = document.querySelector('#auto-transfer-form');
        if (container) {
            this.config.autoTransfer = {
                drive: container.querySelector('select[disabled]').value,
                encryption: {
                    enabled: container.querySelector('#useEncryption').checked,
                    algorithm: container.querySelector('select:first-of-type').value,
                    keyManagement: container.querySelector('select:nth-of-type(2)').value,
                    encryptMetadata: container.querySelector('#encryptMetadata').checked
                }
            };
        }
    }

    // Update FTP settings from UI
    updateFTPSettings() {
        const form = document.querySelector('#ftp-form');
        if (form) {
            this.config.ftpTransfer = {
                protocol: form.querySelector('#protocolSelect').value,
                host: form.querySelector('input[placeholder="Enter server host"]').value,
                port: parseInt(form.querySelector('input[placeholder="21"]').value),
                remoteDirectory: form.querySelector('input[placeholder="/path/to/directory"]').value,
                username: form.querySelector('input[placeholder="Enter username"]').value,
                password: form.querySelector('input[type="password"]').value
            };
        }

        // Update transfer schedule settings
        const transferForm = document.querySelector('#transfer-type-form');
        if (transferForm) {
            if (!this.config.ftpTransfer) {
                this.config.ftpTransfer = {};
            }
            
            this.config.ftpTransfer.transferSchedule = {
                scheduleType: document.querySelector('input[name="scheduleType"]:checked')?.value || 'scheduled',
                scheduleFrequency: document.querySelector('input[name="scheduleFrequency"]:checked')?.value || 'weekly',
                dayOfWeek: document.querySelector('#dayOfWeek')?.value || 'monday',
                transferTime: document.querySelector('#transferTime')?.value || '09:00',
                dataType: document.querySelector('input[name="dataType"]:checked')?.value || 'both'
            };
        }
    }
}

// Initialize configuration manager
const configManager = new ConfigManager();

// Add event listeners for save buttons
document.addEventListener('DOMContentLoaded', () => {
    // Settings modal save button
    const settingsSaveBtn = document.querySelector('#settingsModal .btn-primary');
    if (settingsSaveBtn) {
        settingsSaveBtn.addEventListener('click', async () => {
            configManager.updateFromUI();
            if (await configManager.saveConfig()) {
                // Close modal on success
                const modal = bootstrap.Modal.getInstance(document.querySelector('#settingsModal'));
                modal.hide();
            }
        });
    }

    // Auto transfer save button
    const autoTransferSaveBtn = document.querySelector('#auto-transfer-form .btn-primary');
    if (autoTransferSaveBtn) {
        autoTransferSaveBtn.addEventListener('click', async () => {
            configManager.updateFromUI();
            await configManager.saveConfig();
        });
    }

    // FTP save button
    const ftpSaveBtn = document.querySelector('#ftp-form .btn-primary');
    if (ftpSaveBtn) {
        ftpSaveBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            configManager.updateFromUI();
            await configManager.saveConfig();
        });
    }
});
