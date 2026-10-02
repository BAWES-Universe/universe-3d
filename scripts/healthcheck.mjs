import http from 'node:http';
import { readRuntimeConfig } from '../server/runtime-config.mjs';

try {
  const config = readRuntimeConfig();
  const host = config.allowedHosts?.[0] ?? `127.0.0.1:${config.port}`;
  const hostname = config.host === '::' ? '::1' : config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
  const request = http.get({ hostname, port: config.port, path: '/api/health', headers: { Host: host }, timeout: 3000 }, response => {
    let bytes = 0, data = '';
    response.on('data', chunk => { bytes += chunk.length; if (bytes > 16384) request.destroy(new Error('Oversized health response')); else data += chunk; });
    response.on('end', () => {
      try { if (response.statusCode !== 200 || JSON.parse(data).ok !== true) process.exitCode = 1; }
      catch { process.exitCode = 1; }
    });
    response.on('error', () => { process.exitCode = 1; });
  });
  request.on('timeout', () => request.destroy(new Error('Health check timed out')));
  request.on('error', () => { process.exitCode = 1; });
} catch { process.exitCode = 1; }
