// File System Size
function calculateSizeProgress(exportDirSize, maxExportDirSize) {
    // Helper function to convert size to bytes
    function convertToBytes(size) {
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        const [value, unit] = size.split(' ');
        const unitIndex = units.indexOf(unit.trim().toUpperCase());
        return parseFloat(value) * Math.pow(1024, unitIndex);
    }

    // Convert sizes to bytes
    const exportDirSizeBytes = convertToBytes(exportDirSize);
    const maxExportDirSizeBytes = convertToBytes(maxExportDirSize);

    // Calculate percentage
    const widthPercentage = (exportDirSizeBytes / maxExportDirSizeBytes) * 100;

    // Update the progress bar width
    $('#sizeProgress').css('width', widthPercentage + '%');
}
let fileSizeEndURL = '/files/size';
$.ajax({
    url: fileSizeEndURL, // Replace with your actual URL
    type: 'GET',
    dataType: 'json', // Specify the data type expected from the server
    success: function (response) {
        // Handle successful response
        $('.exportDirSize').html(response['exportDirSize']);
        $('.maxExportDirSize').html(response['maxExportDirSize']);
        calculateSizeProgress(response['exportDirSize'], response['maxExportDirSize']);
        // console.log(response);
    },
    error: function (xhr, status, error) {
        // Handle errors here
        console.error("Error: " + error);
    }
});