// Modal Control Script
$(document).ready(function () {
    // Initialize the modal
    const settingsModal = new bootstrap.Modal($('#settingsModal')[0]);

    // Handle clicks on both the configure button and any elements with settings-btn class
    $('.settings-btn, [data-modal="settingsModal"]').on('click', function (e) {
        e.preventDefault();
        settingsModal.show();
    });

    // Optional: Handle the modal events
    $('#settingsModal')
        .on('show.bs.modal', function () {
            console.log('Modal is about to show');
        })
        .on('shown.bs.modal', function () {
            console.log('Modal is now visible');
        })
        .on('hide.bs.modal', function () {
            console.log('Modal is about to hide');
        })
        .on('hidden.bs.modal', function () {
            console.log('Modal is now hidden');
        });
});