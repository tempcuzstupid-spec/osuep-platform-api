import http from 'node:http';
const port = parseInt(process.env.PORT || '10000', 10);
console.log('[minimal] starting on', port, 'cwd=', process.cwd(), 'node=', process.version);
const s = http.createServer((req, res) => {
  console.log('[req]', req.method, req.url);
  res.writeHead(200, {'content-type':'application/json'});
  res.end(JSON.stringify({ok:true, route:req.url, port}));
});
s.listen(port, '0.0.0.0', () => console.log('[minimal] listening'));
s.on('error', (e) => { console.error('[ERR]', e); process.exit(1); });
