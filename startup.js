process.on('ready', () => {
  // Signal to PM2 that the service is ready
  if (process.send) {
    process.send('ready');
  }
}); 