// Asserts which protocol Node's built-in fetch negotiates with the telemetry host.
// Usage: node scripts/check-protocol.mjs <h2|http/1.1>
import dc from 'node:diagnostics_channel';

const want = process.argv[2];
let got;
dc.subscribe('undici:client:connected', ({ socket }) => {
  got = socket.alpnProtocol || 'http/1.1';
});
await fetch('https://storybook.js.org/', { method: 'HEAD' });
console.log(`node ${process.version} (undici ${process.versions.undici}): fetch negotiated ${got}`);
process.exit(got === want ? 0 : 1);
