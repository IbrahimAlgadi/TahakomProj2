// Sleep promise function
module.exports.sleep = async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Disk Space Formatting
module.exports.formatGB = function formatGB(bytes) {
    return (bytes / (1024 * 1024 * 1024)).toFixed(2);
}


