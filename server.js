const { serveHTTP } = require('stremio-addon-sdk');
const { builder } = require('./addon');

const PORT = process.env.PORT || 7000;

process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT]', err.message);
});
process.on('unhandledRejection', (reason) => {
    console.error('[UNHANDLED]', String(reason));
});

serveHTTP(builder.getInterface(), { port: PORT, cache: 3600 });

console.log('PlayIMDB Stream Addon running on port ' + PORT);
console.log('Manifest: http://localhost:' + PORT + '/manifest.json');
console.log('Stremio:  stremio://http://localhost:' + PORT + '/manifest.json');
