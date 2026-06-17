$(document).ready(function () {
    const $sidebar = $('.sidebar');
    const $overlay = $('.sidebar-overlay');
    const $toggleBtn = $('.mobile-toggle');
    const $body = $('body');

    // Toggle sidebar
    $toggleBtn.on('click', function (e) {
        e.preventDefault();
        $sidebar.toggleClass('active');
        $overlay.toggleClass('active');
        $body.toggleClass('sidebar-open');

        // Toggle icon
        const $icon = $(this).find('i');
        if ($sidebar.hasClass('active')) {
            $icon
                .removeClass('fa-bars')
                .addClass('fa-times');
        } else {
            $icon
                .removeClass('fa-times')
                .addClass('fa-bars');
        }
    });

    // Close sidebar when clicking overlay
    $overlay.on('click', function () {
        $sidebar.removeClass('active');
        $overlay.removeClass('active');
        $body.removeClass('sidebar-open');
        $toggleBtn
            .find('i')
            .removeClass('fa-times')
            .addClass('fa-bars');
    });

    // Close sidebar on ESC key
    $(document).on('keydown', function (e) {
        if (e.key === 'Escape' && $sidebar.hasClass('active')) {
            $sidebar.removeClass('active');
            $overlay.removeClass('active');
            $body.removeClass('sidebar-open');
            $toggleBtn
                .find('i')
                .removeClass('fa-times')
                .addClass('fa-bars');
        }
    });
});