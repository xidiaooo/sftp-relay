// Diagnostic: probe fi11 SFTP via ssh2 to see what it actually returns.
'use strict';
const { Client } = require('ssh2');
const conn = new Client();
conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    if (err) { console.log('SFTP_OPEN_ERR', err.message); conn.end(); return; }
    const done = () => { try { conn.end(); } catch (_) {} };
    sftp.realpath('.', (err, p) => {
      console.log('realpath("."):', err ? 'ERR ' + err.message : JSON.stringify(p));
      sftp.readdir('.', (err, list) => {
        console.log('readdir("."):', err ? 'ERR ' + err.message : 'count=' + list.length + ' ' + JSON.stringify(list.map(e => e.filename)));
        sftp.readdir('/', (err, list2) => {
          console.log('readdir("/"):', err ? 'ERR ' + err.message : 'count=' + list2.length + ' ' + JSON.stringify(list2.map(e => e.filename)));
          sftp.stat('index.js', (err, st) => {
            console.log('stat("index.js"):', err ? 'ERR ' + err.message : 'size=' + st.size + ' mode=' + st.mode.toString(8));
            sftp.stat('./index.js', (err, st2) => {
              console.log('stat("./index.js"):', err ? 'ERR ' + err.message : 'size=' + st2.size + ' mode=' + st2.mode.toString(8));
              sftp.stat('/index.js', (err, st3) => {
                console.log('stat("/index.js"):', err ? 'ERR ' + err.message : 'size=' + st3.size + ' mode=' + st3.mode.toString(8));
                done();
              });
            });
          });
        });
      });
    });
  });
});
conn.on('error', (err) => { console.log('CONN_ERR', err.message); });
conn.connect({
  host: '65.108.39.249', port: 2022,
  username: '1b1c6b49-515d-4a4a-b098-9a93aa8ad2e1.cpy6zyjw',
  password: process.env.DIAG_PASS || '',
  readyTimeout: 15000,
});
