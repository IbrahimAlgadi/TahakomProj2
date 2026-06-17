const Service = require('node-windows').Service;

// Create a new service object
const svc = new Service({
  name: 'MyNodeApp',
  description: 'Runs my Node.js app as a service.',
  script: require('path').join(__dirname, 'AutoTransferBackend.js'), // path to your app.js
});

// Listen for the "install" event, then start the service
svc.on('install', () => {
  svc.start();
});

// Listen for the "uninstall" event
svc.on('uninstall', () => {
  console.log('Service uninstalled');
});

// Install the service
// svc.install();
svc.uninstall();